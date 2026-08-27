// Storage. Production: Postgres — the Vercel/Neon integration injects
// POSTGRES_URL or (newer setups) DATABASE_URL; both are accepted.
// Local dev / CI: an in-memory + JSON-file store so `npm run dev` needs nothing.
// The memory driver is DEV-ONLY (gated on DEV_FAKE_AUTH): production without a
// database must fail loudly, never serve state that evaporates on the next
// cold start.
// The whole wiki state is one versioned JSONB row — trivially consistent, and
// at club scale (a few MB of text) far simpler and safer than a table-per-entity
// schema. Attachments are rows of bytea.

import { seedState } from './seed.js';

const CONN = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';
const useMemory = !CONN && !!process.env.DEV_FAKE_AUTH;

export class StorageNotConfigured extends Error {
  constructor() {
    super('Storage is not configured: no POSTGRES_URL or DATABASE_URL. In Vercel: Storage → Create Database → Postgres (Neon), connect it to this project, then redeploy.');
    this.status = 503;
  }
}

/* ------------------------------- memory driver --------------------------- */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const DEV_FILE = new URL('../.devdata.json', import.meta.url);

const mem = { state: null, version: 0, files: new Map() };

function memLoad() {
  if (mem.state) return;
  if (existsSync(DEV_FILE)) {
    try {
      const d = JSON.parse(readFileSync(DEV_FILE, 'utf8'));
      mem.state = d.state; mem.version = d.version;
      for (const f of d.files || []) mem.files.set(f.id, { ...f, data: Buffer.from(f.data, 'base64') });
      return;
    } catch (e) { /* reseed */ }
  }
  mem.state = seedState();
  mem.version = 1;
}

function memSave() {
  try {
    writeFileSync(DEV_FILE, JSON.stringify({
      state: mem.state, version: mem.version,
      files: [...mem.files.values()].map((f) => ({ ...f, data: f.data.toString('base64') })),
    }));
  } catch (e) { /* dev only */ }
}

/* ------------------------------- postgres driver ------------------------- */

let sql = null;
async function pg() {
  if (!CONN) throw new StorageNotConfigured();
  if (!sql) {
    const { createPool } = await import('@vercel/postgres');
    const pool = createPool({ connectionString: CONN });
    sql = (strings, ...vals) => pool.sql(strings, ...vals);
    await sql`CREATE TABLE IF NOT EXISTS wiki_state (id int PRIMARY KEY, version bigint NOT NULL, state jsonb NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS wiki_upload_parts (
      upload_id text NOT NULL, seq int NOT NULL, data text NOT NULL,
      ts bigint NOT NULL, PRIMARY KEY (upload_id, seq))`;
    await sql`CREATE TABLE IF NOT EXISTS wiki_files (
      id text PRIMARY KEY, name text NOT NULL, type text NOT NULL, size int NOT NULL,
      by text NOT NULL, ts bigint NOT NULL, data bytea NOT NULL)`;
    const r = await sql`SELECT 1 FROM wiki_state WHERE id = 1`;
    if (!r.rows.length) {
      await sql`INSERT INTO wiki_state (id, version, state) VALUES (1, 1, ${JSON.stringify(seedState())}) ON CONFLICT DO NOTHING`;
    }
  }
  return sql;
}

/* ------------------------------- api -------------------------------------- */

export async function getState() {
  if (useMemory) { memLoad(); return { state: mem.state, version: mem.version }; }
  const s = await pg();
  const r = await s`SELECT state, version FROM wiki_state WHERE id = 1`;
  return { state: r.rows[0].state, version: Number(r.rows[0].version) };
}

// Optimistic write: apply(state) mutates and returns the new state; retried on
// concurrent-writer conflicts so serverless overlap can't lose an edit.
export async function updateState(apply) {
  if (useMemory) {
    memLoad();
    const next = apply(mem.state);
    if (next === false) return { state: mem.state, version: mem.version, rejected: true };
    mem.state = next; mem.version++;
    memSave();
    return { state: mem.state, version: mem.version };
  }
  const s = await pg();
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await s`SELECT state, version FROM wiki_state WHERE id = 1`;
    const { state, version } = r.rows[0];
    const next = apply(state);
    if (next === false) return { state, version: Number(version), rejected: true };
    const w = await s`UPDATE wiki_state SET state = ${JSON.stringify(next)}, version = version + 1
                      WHERE id = 1 AND version = ${version}`;
    if (w.rowCount === 1) return { state: next, version: Number(version) + 1 };
  }
  throw new Error('Write conflict persisted after retries');
}

// Binary columns never ride the driver's parameter serialization: the
// serverless HTTP driver mangles Buffers in both directions (JSON-ish on
// write, hex text on read). Base64 crosses the wire; encode/decode happen
// inside Postgres itself.
export async function putFile(f) {
  if (useMemory) { memLoad(); mem.files.set(f.id, f); memSave(); return; }
  const s = await pg();
  const b64 = Buffer.from(f.data).toString('base64');
  await s`INSERT INTO wiki_files (id, name, type, size, by, ts, data)
          VALUES (${f.id}, ${f.name}, ${f.type}, ${f.size}, ${f.by}, ${f.ts}, decode(${b64}, 'base64'))`;
}

export async function getFile(id) {
  if (useMemory) { memLoad(); return mem.files.get(id) || null; }
  const s = await pg();
  const r = await s`SELECT id, name, type, size, by, ts, encode(data, 'base64') AS data64 FROM wiki_files WHERE id = ${id}`;
  if (!r.rows[0]) return null;
  const { data64, ...meta } = r.rows[0];
  return { ...meta, size: Number(meta.size), ts: Number(meta.ts), data: Buffer.from(data64, 'base64') };
}

export async function deleteFile(id) {
  if (useMemory) { memLoad(); mem.files.delete(id); memSave(); return; }
  const s = await pg();
  await s`DELETE FROM wiki_files WHERE id = ${id}`;
}

const memParts = new Map(); // dev driver: uploadId -> [{seq, data}]

export async function putPart(uploadId, seq, data) {
  if (useMemory) {
    const list = memParts.get(uploadId) || [];
    list.push({ seq, data });
    memParts.set(uploadId, list);
    return;
  }
  const s = await pg();
  await s`INSERT INTO wiki_upload_parts (upload_id, seq, data, ts) VALUES (${uploadId}, ${seq}, ${data}, ${Date.now()})
          ON CONFLICT (upload_id, seq) DO UPDATE SET data = EXCLUDED.data`;
}

export async function takeParts(uploadId) {
  if (useMemory) {
    const list = (memParts.get(uploadId) || []).sort((a, b) => a.seq - b.seq);
    memParts.delete(uploadId);
    return list.map((p) => p.data);
  }
  const s = await pg();
  const r = await s`SELECT seq, data FROM wiki_upload_parts WHERE upload_id = ${uploadId} ORDER BY seq`;
  await s`DELETE FROM wiki_upload_parts WHERE upload_id = ${uploadId}`;
  return r.rows.map((x) => x.data);
}

// Only page attachments (att-) are listable. Interest-form uploads (int-) share
// the table but must stay out of member-visible listings AND out of the orphan
// sweep, which deletes any listed file no page references.
export async function listFiles() {
  if (useMemory) { memLoad(); return [...mem.files.values()].filter((f) => f.id.startsWith('att-')).map(({ data, ...m }) => m); }
  const s = await pg();
  const r = await s`SELECT id, name, type, size, by, ts FROM wiki_files WHERE id LIKE 'att-%' ORDER BY ts DESC`;
  return r.rows.map((x) => ({ ...x, size: Number(x.size), ts: Number(x.ts) }));
}
