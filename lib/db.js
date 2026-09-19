// Storage. Production: Postgres — the Vercel/Neon integration injects
// POSTGRES_URL or (newer setups) DATABASE_URL; both are accepted.
// Local dev / CI: an in-memory + JSON-file store so `npm run dev` needs nothing.
// The memory driver is DEV-ONLY (gated on DEV_FAKE_AUTH): production without a
// database must fail loudly, never serve state that evaporates on the next
// cold start.
// The whole wiki state is one versioned JSONB row — trivially consistent, and
// at club scale (a few MB of text) far simpler and safer than a table-per-entity
// schema. Personal preferences have their own small rows/version so browsing
// does not rewrite shared content or invalidate every other member's cache.
// Attachments are rows of bytea.

import { seedState } from './seed.js';
import { encodeSnapshot, decodeSnapshot } from './snapshot.js';
import { createHash } from 'node:crypto';

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

const mem = { state: null, version: 0, prefs: {}, files: new Map() };

function memLoad() {
  if (mem.state) return;
  if (existsSync(DEV_FILE)) {
    try {
      const d = JSON.parse(readFileSync(DEV_FILE, 'utf8'));
      mem.state = d.state; mem.version = d.version; mem.prefs = d.prefs || {};
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
      state: mem.state, version: mem.version, prefs: mem.prefs,
      files: [...mem.files.values()].map((f) => ({ ...f, data: f.data.toString('base64') })),
    }));
  } catch (e) { /* dev only */ }
}

/* ------------------------------- postgres driver ------------------------- */

let sql = null;
let pgReady = null;
async function pg() {
  if (!CONN) throw new StorageNotConfigured();
  if (!pgReady) pgReady = (async () => {
    const { createPool } = await import('@vercel/postgres');
    const pool = createPool({ connectionString: CONN });
    const query = (strings, ...vals) => pool.sql(strings, ...vals);
    await query`CREATE TABLE IF NOT EXISTS wiki_state (id int PRIMARY KEY, version bigint NOT NULL, state jsonb NOT NULL)`;
    // Additive cache columns: JSONB stays canonical and old deployments can
    // continue writing it. A version mismatch makes readers ignore this cache.
    await query`ALTER TABLE wiki_state ADD COLUMN IF NOT EXISTS snapshot bytea,
                ADD COLUMN IF NOT EXISTS snapshot_version bigint`;
    await query`CREATE TABLE IF NOT EXISTS wiki_user_prefs (
      email text PRIMARY KEY, version bigint NOT NULL, prefs jsonb NOT NULL)`;
    await query`CREATE TABLE IF NOT EXISTS wiki_upload_parts (
      upload_id text NOT NULL, seq int NOT NULL, data text NOT NULL,
      ts bigint NOT NULL, PRIMARY KEY (upload_id, seq))`;
    await query`CREATE TABLE IF NOT EXISTS wiki_files (
      id text PRIMARY KEY, name text NOT NULL, type text NOT NULL, size int NOT NULL,
      by text NOT NULL, ts bigint NOT NULL, data bytea NOT NULL)`;
    const r = await query`SELECT 1 FROM wiki_state WHERE id = 1`;
    if (!r.rows.length) {
      const state = seedState();
      const snapshot = await encodeSnapshot(state);
      await query`INSERT INTO wiki_state (id, version, state, snapshot, snapshot_version)
                  VALUES (1, 1, ${JSON.stringify(state)}, decode(${snapshot}, 'base64'), 1) ON CONFLICT DO NOTHING`;
    }
    sql = query;
  })().catch((error) => { pgReady = null; throw error; });
  await pgReady;
  return sql;
}

/* ------------------------------- api -------------------------------------- */

// Escape hatch for self-contained modules that manage their own tables
// (lib/interest.js): the raw tagged-template runner and which driver is live.
export function storageMode() {
  return useMemory ? 'memory' : 'postgres';
}
export async function rawSql() {
  return pg();
}

export async function getState() {
  if (useMemory) { memLoad(); return { state: mem.state, version: mem.version }; }
  const s = await pg();
  const out = await readState(s);
  if (out.needsSnapshot) {
    // The first full load after rollout (or a legacy writer) fills the cache.
    // CAS prevents a slow compression from caching an older state as current.
    // This is optional: a failed cache write must not hide a readable wiki.
    try {
      const snapshot = await encodeSnapshot(out.state);
      await s`UPDATE wiki_state SET snapshot = decode(${snapshot}, 'base64'), snapshot_version = ${out.version}
              WHERE id = 1 AND version = ${out.version}`;
    } catch (e) { /* the next full load can repair the cache */ }
  }
  return { state: out.state, version: Number(out.version) };
}

async function readState(s) {
  // The CASE expressions are evaluated in Postgres: only compressed bytes OR
  // canonical JSONB cross the wire, never both copies of the wiki history.
  const r = await s`SELECT version,
    CASE WHEN snapshot_version = version AND snapshot IS NOT NULL
      THEN encode(snapshot, 'base64') ELSE NULL END AS snapshot64,
    CASE WHEN snapshot_version = version AND snapshot IS NOT NULL
      THEN NULL ELSE state END AS state
    FROM wiki_state WHERE id = 1`;
  const row = r.rows[0];
  if (row.snapshot64 !== null) {
    try { return { state: await decodeSnapshot(row.snapshot64), version: row.version, needsSnapshot: false }; }
    catch (e) {
      // JSONB is the source of truth if cached bytes are damaged. Read version
      // with it again so a concurrent canonical write remains self-consistent.
      const fallback = await s`SELECT state, version FROM wiki_state WHERE id = 1`;
      return { ...fallback.rows[0], needsSnapshot: true };
    }
  }
  return { state: row.state, version: row.version, needsSnapshot: true };
}

// Authentication and unchanged polls only need one member and the version.
// Project these inside Postgres so page bodies and revision history never
// cross the database connection just to check access or discover no changes.
export async function getMember(email, sync = null) {
  if (useMemory) {
    memLoad();
    const out = { member: mem.state.users.find((u) => u.email === email) || null, version: mem.version };
    if (sync) {
      const own = mem.prefs[email] || { version: 0, prefs: mem.state.prefs?.[email] || {} };
      out.prefsVersion = own.version;
      out.prefs = own.version !== sync.prefsSince || mem.version !== sync.since ? own.prefs : null;
    }
    return out;
  }
  const s = await pg();
  if (sync) {
    const r = await s`SELECT w.version, (
      SELECT value FROM jsonb_array_elements(COALESCE(w.state->'users', '[]'::jsonb))
      WHERE value->>'email' = ${email} LIMIT 1
    ) AS member, COALESCE(p.version, 0) AS prefs_version,
      CASE WHEN COALESCE(p.version, 0) <> ${sync.prefsSince} OR w.version <> ${sync.since}
      THEN COALESCE(p.prefs, w.state->'prefs'->${email}, '{}'::jsonb) ELSE NULL END AS prefs
      FROM wiki_state w LEFT JOIN wiki_user_prefs p ON p.email = ${email} WHERE w.id = 1`;
    const row = r.rows[0];
    return { member: row.member, version: Number(row.version), prefsVersion: Number(row.prefs_version), prefs: row.prefs };
  }
  const r = await s`SELECT version, (
    SELECT value FROM jsonb_array_elements(COALESCE(state->'users', '[]'::jsonb))
    WHERE value->>'email' = ${email} LIMIT 1
  ) AS member FROM wiki_state WHERE id = 1`;
  return { member: r.rows[0].member, version: Number(r.rows[0].version) };
}

// The first save copies this member's legacy values; no bulk migration or
// destructive cleanup is needed. The share lock serializes authorization with
// roster changes. The conflict update merges against the latest preferences,
// so overlapping partial writes cannot drop unrelated settings.
export async function savePreferences(email, patch) {
  if (useMemory) {
    memLoad();
    if (!mem.state.users.some((u) => u.email === email && u.status === 'active')) return null;
    const own = mem.prefs[email] || { version: 0, prefs: mem.state.prefs?.[email] || {} };
    const next = { ...own.prefs, ...patch };
    const equal = Object.keys(next).length === Object.keys(own.prefs).length &&
      Object.keys(next).every((key) => JSON.stringify(next[key]) === JSON.stringify(own.prefs[key]));
    mem.prefs[email] = { prefs: next, version: own.version + (equal ? 0 : 1) };
    memSave();
    return { version: mem.version, prefsVersion: mem.prefs[email].version, prefs: next };
  }
  const s = await pg();
  const clean = JSON.stringify(patch);
  const r = await s`WITH authorized AS MATERIALIZED (
    SELECT version, COALESCE(state->'prefs'->${email}, '{}'::jsonb) AS legacy
    FROM wiki_state WHERE id = 1 AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(state->'users', '[]'::jsonb)) u
      WHERE u->>'email' = ${email} AND u->>'status' = 'active'
    ) FOR SHARE
  ), saved AS (
    INSERT INTO wiki_user_prefs (email, version, prefs)
    SELECT ${email}, CASE WHEN legacy = legacy || ${clean}::jsonb THEN 0 ELSE 1 END,
      legacy || ${clean}::jsonb FROM authorized WHERE true
    ON CONFLICT (email) DO UPDATE SET
      prefs = wiki_user_prefs.prefs || ${clean}::jsonb,
      version = wiki_user_prefs.version + CASE
        WHEN wiki_user_prefs.prefs = wiki_user_prefs.prefs || ${clean}::jsonb THEN 0 ELSE 1 END
    RETURNING version, prefs
  ) SELECT authorized.version, saved.version AS prefs_version, saved.prefs FROM authorized CROSS JOIN saved`;
  const row = r.rows[0];
  return row ? { version: Number(row.version), prefsVersion: Number(row.prefs_version), prefs: row.prefs } : null;
}

export async function getEmailSettings() {
  if (useMemory) { memLoad(); return mem.state.settings?.email; }
  const s = await pg();
  const r = await s`SELECT state #> '{settings,email}' AS email FROM wiki_state WHERE id = 1`;
  return r.rows[0].email;
}

export async function getAiSettings() {
  if (useMemory) { memLoad(); return mem.state.settings?.ai || {}; }
  const s = await pg();
  const r = await s`SELECT state #> '{settings,ai}' AS ai FROM wiki_state WHERE id = 1`;
  return r.rows[0].ai || {};
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
    const { state, version } = await readState(s);
    const next = apply(state);
    if (next === false) return { state, version: Number(version), rejected: true };
    const snapshot = await encodeSnapshot(next);
    const w = await s`UPDATE wiki_state SET state = ${JSON.stringify(next)}, snapshot = decode(${snapshot}, 'base64'),
                      snapshot_version = version + 1, version = version + 1
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
    const existing = list.find((part) => part.seq === seq);
    if (existing) existing.data = data; else list.push({ seq, data });
    memParts.set(uploadId, list);
    return;
  }
  const s = await pg();
  await s`INSERT INTO wiki_upload_parts (upload_id, seq, data, ts) VALUES (${uploadId}, ${seq}, ${data}, ${Date.now()})
          ON CONFLICT (upload_id, seq) DO UPDATE SET data = EXCLUDED.data`;
}

async function readParts(uploadId) {
  if (useMemory) {
    return [...(memParts.get(uploadId) || [])].sort((a, b) => a.seq - b.seq);
  }
  const s = await pg();
  const r = await s`SELECT seq, data FROM wiki_upload_parts WHERE upload_id = ${uploadId} ORDER BY seq`;
  return r.rows.map((part) => ({ seq: Number(part.seq), data: part.data }));
}

async function completedUpload(id) {
  if (useMemory) {
    memLoad();
    const file = mem.files.get(id);
    if (!file) return null;
    const { data, ...meta } = file;
    return meta;
  }
  const s = await pg();
  const r = await s`SELECT id, name, type, size, by, ts FROM wiki_files WHERE id = ${id}`;
  const file = r.rows[0];
  return file ? { ...file, size: Number(file.size), ts: Number(file.ts) } : null;
}

async function clearParts(uploadId) {
  if (useMemory) { memParts.delete(uploadId); return; }
  const s = await pg();
  await s`DELETE FROM wiki_upload_parts WHERE upload_id = ${uploadId}`;
}

export async function finishUpload(uploadId, { name, type, by }) {
  // A stable ID makes retrying a lost response or overlapping finish requests
  // resolve to the same saved file, even after its parts have been cleaned up.
  const id = 'att-' + createHash('sha256').update(uploadId).digest('hex').slice(0, 32);
  let file = await completedUpload(id);
  if (!file) {
    const parts = await readParts(uploadId);
    if (!parts.length) {
      // Another finish may have saved and cleaned up after our first lookup.
      file = await completedUpload(id);
      if (!file) return { status: 400, error: 'No uploaded parts found' };
    } else {
      if (parts.some((part, index) => part.seq !== index)) return { status: 400, error: 'Upload is missing a part. Retry the missing upload parts.' };
      const data = Buffer.from(parts.map((part) => part.data).join(''), 'base64');
      if (!data.length) return { status: 400, error: 'Empty file' };
      if (data.length > 25 * 1048576) return { status: 413, error: 'File is over the 25 MB cap' };
      const next = { id, name, type, by, size: data.length, ts: Date.now(), data };
      if (useMemory) {
        if (!mem.files.has(id)) { mem.files.set(id, next); memSave(); }
      } else {
        const s = await pg();
        await s`INSERT INTO wiki_files (id, name, type, size, by, ts, data)
          VALUES (${id}, ${name}, ${type}, ${next.size}, ${by}, ${next.ts}, decode(${data.toString('base64')}, 'base64'))
          ON CONFLICT (id) DO NOTHING`;
      }
      file = await completedUpload(id);
      if (!file) throw new Error('The completed upload could not be verified. Retry finishing the upload.');
    }
  }
  // Cleanup can fail independently. The saved file is already durable, so a
  // cleanup outage must neither discard the upload nor turn success into error.
  try { await clearParts(uploadId); } catch (e) { /* a finish retry can clean up */ }
  return file;
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
