// Exercise the real API/database modules with synthetic state and a recording
// Postgres adapter. No production credentials, database, or email calls are used.
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (!process.env.TRANSFER_TEST_ROOT) {
  const dir = await mkdtemp(join(tmpdir(), 'cupi-transfer-test-'));
  try {
    await cp(new URL('../lib', import.meta.url), join(dir, 'lib'), { recursive: true });
    await cp(new URL('../api', import.meta.url), join(dir, 'api'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    const adapter = join(dir, 'node_modules/@vercel/postgres');
    await mkdir(adapter, { recursive: true });
    await writeFile(join(adapter, 'package.json'), '{"type":"module","exports":"./index.js"}');
    await writeFile(join(adapter, 'index.js'), `export function createPool() {
      globalThis.quotaFixture.pools++;
      return { sql: (strings, ...values) => globalThis.quotaFixture.query(strings.join('?'), values) };
    }`);
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, TRANSFER_TEST_ROOT: dir, POSTGRES_URL: 'postgres://synthetic', SESSION_SECRET: 'synthetic-test-secret' },
      stdio: 'inherit',
    });
    process.exitCode = result.status || (result.error ? 1 : 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
} else {
  globalThis.fetch = async () => { throw new Error('Network disabled in transfer tests'); };
  const root = process.env.TRANSFER_TEST_ROOT;
  const { seedState } = await import(pathToFileURL(join(root, 'lib/seed.js')));
  const { decodeSnapshot } = await import(pathToFileURL(join(root, 'lib/snapshot.js')));
  const admin = 'ab3233@cornell.edu';
  const member = 'member@cornell.edu';
  const state = seedState();
  state.users.push({ email: member, name: 'Member', role: 'member', status: 'active' });
  state.pages[1].body = 'Synthetic long page.\n'.repeat(60000);
  state.prefs = { [admin]: { starred: ['welcome'] }, [member]: { starred: ['onboarding'] } };
  const db = globalThis.quotaFixture = {
    state, version: 7, snapshot: null, snapshotVersion: null, pools: 0, ready: false, calls: [], bytes: 0,
    afterMember: null, conflict: null,
    async query(text, values) {
      this.calls.push(text);
      if (this.failQuota) throw new Error('Server error (HTTP status 402): {"message":"Your project has exceeded the data transfer quota. Upgrade your plan to increase limits.","neon:retryable":true}');
      const reply = (rows = [], rowCount = rows.length) => {
        this.bytes += Buffer.byteLength(JSON.stringify(rows));
        return { rows: structuredClone(rows), rowCount };
      };
      if (text.startsWith('CREATE TABLE')) {
        // Force concurrent cold requests to overlap during initialization.
        await new Promise((resolve) => setImmediate(resolve));
        return reply();
      }
      if (text.startsWith('ALTER TABLE')) return reply();
      if (text === 'SELECT 1 FROM wiki_state WHERE id = 1') { this.ready = true; return reply([{ '?column?': 1 }]); }
      assert.ok(this.ready, 'queries must wait until initialization finishes');
      if (text.startsWith('SELECT version,') && text.includes('AS snapshot64')) {
        assert.equal((text.match(/CASE WHEN snapshot_version = version AND snapshot IS NOT NULL/g) || []).length, 2);
        assert.match(text, /THEN NULL ELSE state END AS state/);
        const current = this.snapshotVersion === this.version && this.snapshot !== null;
        return reply([{ version: this.version, snapshot64: current ? this.snapshot : null, state: current ? null : this.state }]);
      }
      if (text.startsWith('SELECT version,')) {
        assert.match(text, /jsonb_array_elements\(COALESCE\(state->'users', '\[\]'::jsonb\)\)/);
        assert.match(text, /WHERE value->>'email' = \? LIMIT 1/);
        const out = reply([{ version: this.version, member: this.state.users.find((u) => u.email === values[0]) || null }]);
        const callback = this.afterMember; this.afterMember = null; callback?.();
        return out;
      }
      if (text.startsWith("SELECT state #> '{settings,email}'")) return reply([{ email: this.state.settings?.email || null }]);
      if (text === 'SELECT state, version FROM wiki_state WHERE id = 1') return reply([{ state: this.state, version: this.version }]);
      if (text.startsWith('UPDATE wiki_state SET state =')) {
        assert.match(text, /snapshot_version = version \+ 1, version = version \+ 1/);
        const callback = this.conflict; this.conflict = null;
        if (callback) { callback(); this.version++; return reply([], 0); }
        if (values[2] !== this.version) return reply([], 0);
        this.state = JSON.parse(values[0]); this.snapshot = values[1]; this.version++; this.snapshotVersion = this.version;
        assert.deepEqual(await decodeSnapshot(this.snapshot), this.state, 'JSONB and compressed state must match in every atomic write');
        return reply([], 1);
      }
      if (text.startsWith('UPDATE wiki_state SET snapshot =')) {
        assert.match(text, /WHERE id = 1 AND version = \?/);
        if (this.backfillFail) throw new Error('Synthetic optional cache failure');
        const callback = this.backfillRace; this.backfillRace = null; callback?.();
        if (values[2] !== this.version) return reply([], 0);
        this.snapshot = values[0]; this.snapshotVersion = values[1];
        return reply([], 1);
      }
      if (text.startsWith('SELECT id, name, type, size, by, ts FROM wiki_files')) return reply([]);
      if (text.startsWith("SELECT id, name, type, size, by, ts, encode(data, 'base64')")) {
        return reply([{ id: values[0], name: 'sample.txt', type: 'text/plain', size: 2, by: admin, ts: 1, data64: 'b2s=' }]);
      }
      if (text === 'SELECT * FROM interest_submissions ORDER BY ts DESC') return reply([]);
      throw new Error(`Unexpected test query: ${text}`);
    },
  };
  const { makeSession } = await import(pathToFileURL(join(root, 'lib/auth.js')));
  const { default: handler } = await import(pathToFileURL(join(root, 'api/index.js')));
  const { getState, getEmailSettings } = await import(pathToFileURL(join(root, 'lib/db.js')));
  const reset = () => { db.calls = []; db.bytes = 0; };
  const fullReads = () => db.calls.filter((q) => q === 'SELECT state, version FROM wiki_state WHERE id = 1' || q.includes('AS snapshot64')).length;
  const writes = () => db.calls.filter((q) => q.startsWith('UPDATE wiki_state SET state =')).length;
  const backfills = () => db.calls.filter((q) => q.startsWith('UPDATE wiki_state SET snapshot =')).length;
  async function request(path, email = admin, body) {
    const headers = { host: 'wiki.cornellphysicalintelligence.com' };
    if (email) headers.cookie = `cupi_session=${makeSession(email)}`;
    const req = { url: '/api' + path, method: body ? 'POST' : 'GET', headers, body };
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(value) { this.body = value; } };
    await handler(req, res);
    return { status: res.statusCode, headers: res.headers, data: res.headers['content-type'] === 'application/json' ? JSON.parse(res.body) : res.body };
  }

  for (const path of ['/me', '/state', '/att/att-sample']) assert.equal((await request(path, null)).status, 401);
  assert.equal(db.calls.length, 0, 'signed-out requests must not contact Postgres');
  const cold = await Promise.all([request('/me'), request('/state?since=7')]);
  assert.deepEqual(cold.map((r) => r.status), [200, 200]);
  assert.equal(db.pools, 1);
  assert.equal(db.calls.filter((q) => q.startsWith('CREATE TABLE')).length, 3);
  assert.equal(fullReads(), 0, '/me and unchanged cold polls must not read full wiki state');
  assert.ok(db.bytes < 2000, 'auth and unchanged polls transfer only small records');
  assert.deepEqual(cold[1].data, { version: 7, unchanged: true });

  reset();
  const initial = await request('/state');
  assert.equal(initial.status, 200);
  assert.equal(fullReads(), 1, 'initial load reads one full state, including on a cold instance');
  assert.deepEqual(Object.keys(initial.data.state.prefs), [admin]);
  assert.equal(initial.data.state.pages[1].body, state.pages[1].body);
  assert.ok(db.bytes > 1000000, 'fixture must be large enough to expose full-state amplification');
  assert.equal(backfills(), 1);
  assert.equal(db.version, 7, 'backfill does not change the canonical state version');
  assert.equal(db.snapshotVersion, 7);
  assert.deepEqual(await decodeSnapshot(db.snapshot), db.state);

  reset();
  const cached = await request('/state');
  assert.deepEqual(cached.data, initial.data, 'compression preserves the complete state API response');
  assert.equal(fullReads(), 1);
  assert.equal(backfills(), 0, 'later full loads reuse the stored compressed snapshot');
  assert.ok(db.bytes < 15000, 'stored compression reduces this synthetic full-state transfer by over 98%');

  reset();
  assert.equal((await request('/state?since=7')).data.unchanged, true);
  assert.equal(db.calls.length, 1);
  assert.equal(fullReads(), 0);
  assert.ok(db.bytes < 1000);
  assert.equal((await request('/me', 'removed@cornell.edu')).status, 401);
  assert.equal((await request('/state?since=7', 'removed@cornell.edu')).status, 401);
  const attachment = await request('/att/att-sample');
  assert.equal(attachment.status, 200);
  assert.equal(attachment.data.toString(), 'ok');
  assert.equal((await request('/interest')).status, 200);
  assert.equal((await request('/interest', member)).status, 403);
  assert.equal((await request('/resend/domains')).status, 200);
  assert.equal(fullReads(), 0, 'attachments, interest access, and email settings must not load wiki history');
  db.state.settings = { email: { key: 'synthetic-secret' } };
  db.version++; // Emulate an older deployment writing JSONB without a snapshot.
  assert.deepEqual(await getEmailSettings(), { key: 'synthetic-secret' });
  const withSettings = await request('/state');
  assert.equal(withSettings.data.state.settings.email.key, undefined, 'full state must still redact email secrets');
  assert.equal(withSettings.data.state.settings.email.keySet, true, 'legacy writes invalidate a stale compressed copy');

  reset();
  const saved = await request('/mutate', member, { op: 'setPrefs', args: { prefs: { watched: ['welcome'] } } });
  assert.equal(saved.status, 200);
  assert.equal(fullReads(), 1, 'normal mutations read one state, without a redundant auth read');
  assert.equal(writes(), 1);
  assert.deepEqual(db.state.prefs[member].watched, ['welcome']);
  assert.equal(db.snapshotVersion, db.version);
  assert.deepEqual(await decodeSnapshot(db.snapshot), db.state);

  reset();
  db.conflict = () => db.state.activity.unshift({ kind: 'concurrent-test' });
  const retried = await request('/mutate', member, { op: 'setPrefs', args: { prefs: { starred: ['welcome'] } } });
  assert.equal(retried.status, 200);
  assert.equal(fullReads(), 2);
  assert.equal(writes(), 2);
  assert.equal(db.state.activity[0].kind, 'concurrent-test', 'conflict retry preserves another writer');

  reset();
  db.afterMember = () => { db.state.users = db.state.users.filter((u) => u.email !== member); db.version++; };
  assert.equal((await request('/mutate', member, { op: 'setPrefs', args: { prefs: {} } })).status, 401);
  assert.equal(writes(), 0, 'a member revoked between auth and a write cannot mutate');

  reset();
  db.conflict = () => { db.state.users.find((u) => u.email === admin).role = 'member'; };
  const demoted = await request('/mutate', admin, { op: 'setEmailSettings', args: { from: 'synthetic@example.com' } });
  assert.equal(demoted.status, 400);
  assert.equal(demoted.data.error, 'Admins only');
  assert.equal(writes(), 1, 'an admin demoted during a conflict cannot use the earlier role on retry');

  reset();
  db.snapshot = 'corrupted gzip bytes'; db.snapshotVersion = db.version;
  const repaired = await getState();
  assert.deepEqual(repaired.state, db.state, 'a damaged snapshot falls back to canonical JSONB');
  assert.equal(fullReads(), 2);
  assert.equal(backfills(), 1);
  assert.deepEqual(await decodeSnapshot(db.snapshot), db.state, 'fallback repairs damaged bytes for the next load');
  reset();
  await getState();
  assert.equal(fullReads(), 1);
  assert.equal(backfills(), 0);

  reset();
  db.snapshot = null;
  const beforeRace = { state: structuredClone(db.state), version: db.version };
  db.backfillRace = () => { db.state.activity.unshift({ kind: 'backfill-race' }); db.version++; };
  assert.deepEqual(await getState(), beforeRace, 'a read keeps its original state/version pair if a writer races backfill');
  assert.equal(db.snapshot, null, 'CAS rejects a backfill for an older canonical version');
  const afterRace = await getState();
  assert.equal(afterRace.state.activity[0].kind, 'backfill-race');
  assert.equal(db.snapshotVersion, db.version);
  assert.deepEqual(await decodeSnapshot(db.snapshot), db.state);

  db.snapshot = null; db.backfillFail = true;
  assert.deepEqual((await getState()).state, db.state, 'optional cache failure must not block readable wiki state');
  db.backfillFail = false;
  await getState();
  assert.deepEqual(await decodeSnapshot(db.snapshot), db.state);

  db.failQuota = true;
  for (const path of ['/me', '/state', '/interest']) {
    const unavailable = await request(path);
    assert.equal(unavailable.status, 503, 'quota failures have a retryable service-unavailable response');
    assert.equal(unavailable.data.code, 'DATABASE_QUOTA_EXCEEDED');
    assert.equal(unavailable.headers['retry-after'], '300');
    assert.doesNotMatch(unavailable.data.error, /HTTP status 402|neon:retryable/, 'driver internals are not shown');
  }

  console.log('PASS: small auth/poll queries, compressed reads, versioned backfill, legacy writes, damaged cache fallback, optimistic retries, authorization, and quota errors');
}
