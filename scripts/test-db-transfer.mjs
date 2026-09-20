// Exercise the real API/database modules with synthetic state and a recording
// Postgres adapter. No production credentials, database, or email calls are used.
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

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
  state.prefs = {
    [admin]: { starred: ['welcome'] },
    [member]: { starred: ['onboarding'], collapsed: ['software'], navHidden: false, spellcheck: true, 'open-projects': true },
  };
  const db = globalThis.quotaFixture = {
    state, version: 7, snapshot: null, snapshotVersion: null, pools: 0, ready: false, calls: [], bytes: 0,
    prefs: new Map(), afterMember: null, beforePrefsWrite: null, conflict: null,
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
      if (text.startsWith('CREATE INDEX') || text.startsWith('CREATE UNIQUE INDEX')) return reply();
      if (text.startsWith('INSERT INTO recruit_settings')) return reply();
      if (text.startsWith("SELECT s.doc->'migration'") || text.startsWith('SELECT version, doc FROM recruit_settings')) return reply([]);
      if (text === 'SELECT 1 FROM wiki_state WHERE id = 1') { this.ready = true; return reply([{ '?column?': 1 }]); }
      assert.ok(this.ready, 'queries must wait until initialization finishes');
      if (text.startsWith('INSERT INTO wiki_ai_usage')) {
        this.aiUsage ||= { version: 1, state: JSON.parse(values[0]) }; return reply();
      }
      if (text.startsWith('SELECT version, ledger AS state FROM wiki_ai_usage')) return reply([this.aiUsage]);
      if (text.startsWith('UPDATE wiki_ai_usage')) {
        assert.match(text, /WHERE id = 1 AND version = \? RETURNING version/);
        if (this.failAiUsage) throw new Error('AI ledger unavailable');
        if (values[1] !== this.aiUsage.version) return reply();
        this.aiUsage = { version: this.aiUsage.version + 1, state: JSON.parse(values[0]) };
        return reply([{ version: this.aiUsage.version }]);
      }
      if (text.startsWith('SELECT version,') && text.includes('AS snapshot64')) {
        assert.equal((text.match(/CASE WHEN snapshot_version = version AND snapshot IS NOT NULL/g) || []).length, 2);
        assert.match(text, /THEN NULL ELSE state END AS state/);
        const current = this.snapshotVersion === this.version && this.snapshot !== null;
        return reply([{ version: this.version, snapshot64: current ? this.snapshot : null, state: current ? null : this.state }]);
      }
      if (text.startsWith('SELECT w.version,')) {
        assert.match(text, /LEFT JOIN wiki_user_prefs p ON p.email = \? WHERE w.id = 1/);
        assert.match(text, /CASE WHEN COALESCE\(p.version, 0\) <> \? OR w.version <> \?/);
        assert.match(text, /THEN COALESCE\(p.prefs, w.state->'prefs'->\?, '\{\}'::jsonb\) ELSE NULL END AS prefs/);
        assert.match(text, /WHERE value->>'email' = \? LIMIT 1/);
        assert.equal(values[0], values[3]); assert.equal(values[0], values[4], 'preference projection only joins the authenticated member');
        const own = this.prefs.get(values[0]) || { version: 0, prefs: this.state.prefs?.[values[0]] || {} };
        const out = reply([{
          version: this.version, member: this.state.users.find((u) => u.email === values[0]) || null,
          prefs_version: own.version, prefs: own.version !== values[1] || this.version !== values[2] ? own.prefs : null,
        }]);
        const callback = this.afterMember; this.afterMember = null; callback?.();
        return out;
      }
      if (text.startsWith('WITH authorized AS MATERIALIZED')) {
        assert.match(text, /FOR SHARE/);
        assert.match(text, /u->>'email' = \? AND u->>'status' = 'active'/);
        assert.match(text, /ON CONFLICT \(email\) DO UPDATE SET\s+prefs = wiki_user_prefs.prefs \|\| \?::jsonb/);
        assert.match(text, /WHEN wiki_user_prefs.prefs = wiki_user_prefs.prefs \|\| \?::jsonb THEN 0 ELSE 1 END/);
        assert.equal(values[0], values[1]); assert.equal(values[0], values[2]);
        for (const value of values.slice(3)) assert.equal(value, values[3], 'the same sanitized patch is used for merge and change detection');
        const callback = this.beforePrefsWrite; this.beforePrefsWrite = null; callback?.();
        if (!this.state.users.some((u) => u.email === values[0] && u.status === 'active')) return reply();
        const own = this.prefs.get(values[0]) || { version: 0, prefs: this.state.prefs?.[values[0]] || {} };
        const next = { ...own.prefs, ...JSON.parse(values[3]) };
        const version = own.version + (isDeepStrictEqual(own.prefs, next) ? 0 : 1);
        this.prefs.set(values[0], { prefs: next, version });
        return reply([{ version: this.version, prefs_version: version, prefs: next }]);
      }
      if (text.startsWith('SELECT version,')) {
        assert.match(text, /jsonb_array_elements\(COALESCE\(state->'users', '\[\]'::jsonb\)\)/);
        assert.match(text, /WHERE value->>'email' = \? LIMIT 1/);
        const out = reply([{ version: this.version, member: this.state.users.find((u) => u.email === values[0]) || null }]);
        const callback = this.afterMember; this.afterMember = null; callback?.();
        return out;
      }
      if (text.startsWith("SELECT state #> '{settings,ai}'")) return reply([{ ai: this.state.settings?.ai || {} }]);
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
  const preferenceWrites = () => db.calls.filter((q) => q.startsWith('WITH authorized AS MATERIALIZED')).length;
  const backfills = () => db.calls.filter((q) => q.startsWith('UPDATE wiki_state SET snapshot =')).length;
  async function request(path, email = admin, body, method) {
    const headers = { host: 'wiki.cornellphysicalintelligence.com' };
    if (email) headers.cookie = `cupi_session=${makeSession(email)}`;
    const req = { url: '/api' + path, method: method || (body ? 'POST' : 'GET'), headers, body };
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(value) { this.body = value; } };
    await handler(req, res);
    return { status: res.statusCode, headers: res.headers, data: res.headers['content-type'] === 'application/json' ? JSON.parse(res.body) : res.body };
  }

  for (const path of ['/me', '/state', '/att/att-sample']) assert.equal((await request(path, null)).status, 401);
  assert.equal(db.calls.length, 0, 'signed-out requests must not contact Postgres');
  const cold = await Promise.all([request('/me'), request('/state?since=7&prefsSince=0')]);
  assert.deepEqual(cold.map((r) => r.status), [200, 200]);
  assert.equal(db.pools, 1);
  assert.equal(db.calls.filter((q) => q.startsWith('CREATE TABLE')).length, 4);
  assert.equal(fullReads(), 0, '/me and unchanged cold polls must not read full wiki state');
  assert.ok(db.bytes < 2000, 'auth and unchanged polls transfer only small records');
  assert.deepEqual(cold[1].data, { version: 7, unchanged: true, prefsVersion: 0 });

  // Assistance uses server credentials only after membership checks, and never
  // fetches the entire wiki or changes the saved state to generate a preview.
  reset();
  for (const [path, body] of [
    ['/change-summary', { title: 'Wiring', beforeTitle: 'Wiring', section: 'Electrical', beforeSection: 'Electrical', diff: '- 5V\n+ 3.3V', isNew: false, truncated: false }],
    ['/page-review', { title: 'Wiring', body: 'Use 3.3V', section: 'electrical', truncated: false }],
    ['/meaning-search', { query: 'power reset', candidates: [{ id: 'power', title: 'Power', excerpt: 'Scope regulator voltage.' }] }],
  ]) {
    for (const who of [null, 'unknown@cornell.edu']) assert.equal((await request(path, who, body)).status, 401);
    assert.equal((await request(path, member, {})).status, 400);
    const assistance = await request(path, member, body);
    assert.equal(assistance.status, 200); assert.equal(assistance.data.available, false, 'missing provider keys degrade gracefully');
    assert.equal(assistance.headers['cache-control'], 'private, no-store');
  }
  assert.equal(fullReads(), 0); assert.equal(writes(), 0);

  reset();
  const initial = await request('/state');
  assert.equal(initial.status, 200);
  assert.equal(fullReads(), 1, 'initial load reads one full state, including on a cold instance');
  assert.deepEqual(Object.keys(initial.data.state.prefs), [admin]);
  assert.deepEqual(initial.data.state.prefs[admin], state.prefs[admin], 'members retain legacy preferences before any separate preference row exists');
  assert.equal(initial.data.prefsVersion, 0);
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
  assert.deepEqual((await request('/state?since=7&prefsSince=0')).data, { version: 7, unchanged: true, prefsVersion: 0 });
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
  const sharedBeforePrefs = { version: db.version, state: structuredClone(db.state), snapshot: db.snapshot };
  const saved = await request('/mutate', member, {
    op: 'setPrefs', args: { email: admin, prefs: { watched: ['welcome'], navHidden: true, spellcheck: false, 'open-projects': 0 } },
  });
  assert.equal(saved.status, 200);
  assert.equal(fullReads(), 0, 'preference saves never fetch wiki bodies or history');
  assert.equal(writes(), 0, 'preference saves never rewrite shared wiki state');
  assert.equal(preferenceWrites(), 1);
  assert.equal(db.version, sharedBeforePrefs.version, 'personal settings do not change the shared content version');
  assert.deepEqual(db.state, sharedBeforePrefs.state, 'legacy preferences and every other member remain unchanged in canonical JSONB');
  assert.equal(db.snapshot, sharedBeforePrefs.snapshot);
  assert.deepEqual(db.prefs.get(member), {
    version: 1,
    prefs: { starred: ['onboarding'], collapsed: ['software'], watched: ['welcome'], navHidden: true, spellcheck: false, 'open-projects': false },
  }, 'first separate save preserves all legacy settings and sanitizes new values');
  assert.equal(db.prefs.has(admin), false, 'a submitted email cannot redirect another member’s preference write');
  assert.deepEqual(saved.data, { ok: true, version: db.version, prefsVersion: 1, prefs: db.prefs.get(member).prefs });
  assert.ok(Buffer.byteLength(JSON.stringify(saved.data)) < 1000, 'canonical preference acknowledgment stays small with a megabyte of history');
  assert.ok(db.bytes < 2000, 'the database returns only member/preference records for a preference save');

  reset();
  const ownBeforeNoop = structuredClone(db.prefs.get(member));
  const unchangedPrefs = await request('/mutate', member, {
    op: 'setPrefs', args: { prefs: { watched: ['welcome'], unknown: 'ignored', recents: 'not an array', editorMode: 123, navHidden: 'false', spellcheck: 'true' } },
  });
  assert.deepEqual(unchangedPrefs.data, { ok: true, version: db.version, prefsVersion: ownBeforeNoop.version, prefs: ownBeforeNoop.prefs });
  assert.equal(fullReads(), 0); assert.equal(writes(), 0);
  assert.deepEqual(db.prefs.get(member), ownBeforeNoop, 'equivalent sanitized preferences keep their own version stable');
  assert.deepEqual(db.state, sharedBeforePrefs.state); assert.equal(db.snapshot, sharedBeforePrefs.snapshot);
  assert.equal(db.version, sharedBeforePrefs.version);

  reset();
  const legacyNoop = await request('/mutate', admin, { op: 'setPrefs', args: { prefs: { starred: ['welcome'] } } });
  assert.deepEqual(legacyNoop.data, { ok: true, version: db.version, prefsVersion: 0, prefs: state.prefs[admin] });
  assert.deepEqual(db.prefs.get(admin), { version: 0, prefs: state.prefs[admin] }, 'a legacy no-op creates no spurious preference version');
  assert.equal(fullReads(), 0); assert.equal(writes(), 0); assert.equal(db.version, sharedBeforePrefs.version);

  reset();
  const prefsOnly = await request('/state?since=' + db.version + '&prefsSince=0', member);
  assert.deepEqual(prefsOnly.data, { version: db.version, unchanged: true, prefsVersion: 1, prefs: db.prefs.get(member).prefs });
  assert.equal(db.calls.length, 1); assert.equal(fullReads(), 0);
  assert.equal(prefsOnly.data.state, undefined); assert.equal(prefsOnly.data.files, undefined);
  assert.ok(db.bytes < 1000, 'a preference-only poll does not transfer the shared state or attachment list');
  const otherMember = await request('/state?since=' + db.version + '&prefsSince=0', admin);
  assert.deepEqual(otherMember.data, { version: db.version, unchanged: true, prefsVersion: 0 }, 'one member’s settings do not invalidate another member’s poll');
  const caughtUp = await request('/state?since=' + db.version + '&prefsSince=1', member);
  assert.deepEqual(caughtUp.data, { version: db.version, unchanged: true, prefsVersion: 1 });
  const legacyClientPoll = await request('/state?since=' + db.version, member);
  assert.deepEqual(legacyClientPoll.data.prefs, db.prefs.get(member).prefs, 'clients without a preference cursor still receive their own preferences');
  assert.equal(fullReads(), 0);

  reset();
  const privateOverlay = await request('/state', member);
  assert.deepEqual(privateOverlay.data.state.prefs, { [member]: db.prefs.get(member).prefs }, 'full loads overlay only the authenticated member’s separate preferences');
  assert.deepEqual(db.state.prefs, sharedBeforePrefs.state.prefs, 'private overlay never mutates stored legacy state');
  assert.equal(privateOverlay.data.prefsVersion, 1);

  reset();
  const beforePartialVersion = db.prefs.get(member).version;
  const partial = await Promise.all([
    request('/mutate', member, { op: 'setPrefs', args: { prefs: { starred: ['welcome'] } } }),
    request('/mutate', member, { op: 'setPrefs', args: { prefs: { collapsed: ['projects'] } } }),
  ]);
  assert.deepEqual(partial.map((r) => r.status), [200, 200]);
  assert.deepEqual(partial.map((r) => r.data.prefsVersion).sort(), [beforePartialVersion + 1, beforePartialVersion + 2]);
  assert.deepEqual(db.prefs.get(member).prefs.starred, ['welcome']);
  assert.deepEqual(db.prefs.get(member).prefs.collapsed, ['projects']);
  assert.deepEqual(db.prefs.get(member).prefs.watched, ['welcome'], 'overlapping partial saves preserve unrelated fields');
  assert.equal(fullReads(), 0); assert.equal(writes(), 0); assert.equal(db.version, sharedBeforePrefs.version);
  assert.equal(preferenceWrites(), 2);

  reset();
  const beforeIdenticalVersion = db.prefs.get(member).version;
  const identical = await Promise.all([0, 1].map(() => request('/mutate', member, {
    op: 'setPrefs', args: { prefs: { watched: ['onboarding'] } },
  })));
  assert.deepEqual(identical.map((r) => r.data.prefsVersion), [beforeIdenticalVersion + 1, beforeIdenticalVersion + 1]);
  assert.equal(db.prefs.get(member).version, beforeIdenticalVersion + 1, 'concurrent identical patches advance the personal version only once');
  assert.equal(fullReads(), 0); assert.equal(writes(), 0); assert.equal(db.version, sharedBeforePrefs.version);

  reset();
  const sanitized = await request('/mutate', member, { op: 'setPrefs', args: { prefs: {
    recents: Array.from({ length: 101 }, (_, i) => i), inboxReadAt: 123, navHidden: false, spellcheck: true,
  } } });
  assert.deepEqual(sanitized.data.prefs.recents, Array.from({ length: 100 }, (_, i) => String(i)), 'the acknowledgment returns the canonical truncated values');
  assert.equal(sanitized.data.prefs.navHidden, false); assert.equal(sanitized.data.prefs.spellcheck, true);
  assert.equal(sanitized.data.prefs.inboxReadAt, 123);
  assert.deepEqual(sanitized.data.prefs, db.prefs.get(member).prefs);
  assert.equal(sanitized.data.state, undefined); assert.equal(sanitized.data.files, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(sanitized.data)) < 1000);
  assert.equal(fullReads(), 0); assert.equal(writes(), 0); assert.equal(db.version, sharedBeforePrefs.version);

  reset();
  const beforeContentVersion = db.version;
  const personalBeforeContent = structuredClone(db.prefs.get(member));
  const profile = await request('/mutate', member, { op: 'setProfile', args: { name: 'Updated Member', subteam: 'Robotics' } });
  assert.equal(profile.status, 200); assert.equal(fullReads(), 1); assert.equal(writes(), 1);
  assert.equal(profile.data.state.users.find((u) => u.email === member).name, 'Updated Member');
  assert.equal(profile.data.state.pages[1].body, state.pages[1].body, 'content mutations still return the complete current wiki');
  assert.deepEqual(profile.data.state.prefs, { [member]: personalBeforeContent.prefs }, 'content responses overlay private preferences');
  assert.equal(profile.data.state.settings.email.key, undefined);
  assert.equal(db.version, beforeContentVersion + 1); assert.equal(db.snapshotVersion, db.version);
  assert.deepEqual(db.prefs.get(member), personalBeforeContent, 'content writes cannot reset the independent preference row');
  const contentRefresh = await request('/state?since=' + beforeContentVersion + '&prefsSince=' + personalBeforeContent.version, member);
  assert.deepEqual(contentRefresh.data.state.prefs, { [member]: personalBeforeContent.prefs }, 'content changes include correct preferences even when the personal version is unchanged');

  reset();
  const beforeMixedRace = db.version;
  db.beforePrefsWrite = () => { db.state.activity.unshift({ kind: 'content-during-preferences' }); db.version++; };
  const mixedRace = await request('/mutate', member, { op: 'setPrefs', args: { prefs: { 'open-operations': true } } });
  assert.equal(mixedRace.status, 200);
  assert.equal(mixedRace.data.version, beforeMixedRace + 1, 'preference acknowledgment uses the content version current at its authorized write');
  assert.equal(db.version, beforeMixedRace + 1, 'only the concurrent content writer advances the shared version');
  assert.ok(db.state.activity.some((a) => a.kind === 'content-during-preferences'));
  assert.equal(db.prefs.get(member).prefs['open-operations'], true);
  assert.equal(fullReads(), 0); assert.equal(writes(), 0);

  reset();
  db.conflict = () => db.state.activity.unshift({ kind: 'concurrent-test' });
  const retried = await request('/mutate', member, { op: 'setProfile', args: { name: 'Retry Member', subteam: 'Robotics' } });
  assert.equal(retried.status, 200); assert.equal(fullReads(), 2); assert.equal(writes(), 2);
  assert.ok(db.state.activity.some((a) => a.kind === 'concurrent-test'), 'content conflict retries preserve another writer’s activity');
  assert.equal(db.state.users.find((u) => u.email === member).name, 'Retry Member');

  reset();
  const beforeContentRace = db.version;
  db.conflict = () => {
    db.state.users.find((u) => u.email === admin).subteam = 'Concurrent admin change';
    db.state.activity.unshift({ kind: 'other-member-concurrent-test' });
  };
  const overlappingContent = await request('/mutate', member, { op: 'setProfile', args: { name: 'Current Member', subteam: 'Robotics' } });
  assert.equal(overlappingContent.status, 200); assert.equal(fullReads(), 2); assert.equal(writes(), 2);
  assert.equal(db.version, beforeContentRace + 2, 'the concurrent content write and successful retry each advance content version');
  assert.equal(db.state.users.find((u) => u.email === admin).subteam, 'Concurrent admin change');
  assert.ok(db.state.activity.some((a) => a.kind === 'other-member-concurrent-test'));

  reset();
  db.conflict = () => { db.state.users = db.state.users.filter((u) => u.email !== member); };
  const revokedOnRetry = await request('/mutate', member, { op: 'setProfile', args: { name: 'Revoked attempt', subteam: 'Robotics' } });
  assert.equal(revokedOnRetry.status, 401, 'content retries reauthorize against the new roster');
  assert.equal(writes(), 1, 'a revoked member cannot retry its failed content write');
  db.state.users.push({ email: member, name: 'Member', role: 'member', status: 'active' }); db.version++;

  reset();
  const ownBeforeRevocation = structuredClone(db.prefs.get(member));
  db.afterMember = () => { db.state.users = db.state.users.filter((u) => u.email !== member); db.version++; };
  const revokedPrefs = await request('/mutate', member, { op: 'setPrefs', args: { prefs: ownBeforeRevocation.prefs } });
  assert.equal(revokedPrefs.status, 401, 'even a no-op preference save rechecks current membership atomically');
  assert.equal(fullReads(), 0); assert.equal(writes(), 0); assert.equal(preferenceWrites(), 1);
  assert.deepEqual(db.prefs.get(member), ownBeforeRevocation, 'denied preference writes do not alter the member’s saved row');
  db.state.users.push({ email: member, name: 'Member', role: 'member', status: 'active' }); db.version++;

  reset();
  db.beforePrefsWrite = () => { db.state.users.find((u) => u.email === member).status = 'invited'; db.version++; };
  const inactivePrefs = await request('/mutate', member, { op: 'setPrefs', args: { prefs: { watched: ['welcome'] } } });
  assert.equal(inactivePrefs.status, 401, 'preference write authorization requires active status, not just a matching email');
  assert.deepEqual(db.prefs.get(member), ownBeforeRevocation);
  db.state.users.find((u) => u.email === member).status = 'active'; db.version++;

  reset();
  db.afterMember = () => { db.state.users = db.state.users.filter((u) => u.email !== member); db.version++; };
  assert.equal((await request('/mutate', member, { op: 'setProfile', args: { name: 'Denied content', subteam: '' } })).status, 401);
  assert.equal(writes(), 0, 'a member revoked between preauth and reading content cannot mutate');

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

  // Owner configuration must be private, durable and reauthorized on a CAS retry.
  db.state.users.find((u) => u.email === admin).role = 'admin'; db.version++;
  if (!db.state.users.some((u) => u.email === member)) db.state.users.push({ email: member, name: 'Member', role: 'member', status: 'active' });
  const key = 'sk-synthetic-no-real-credential-123456789';
  const aiInput = { model: 'gpt-5.6-luna', effort: 'none', key };
  for (const path of ['/ai/settings', '/ai/test']) {
    assert.equal((await request(path, null)).status, 401);
    assert.equal((await request(path, member, aiInput, path.endsWith('test') ? 'POST' : 'PUT')).status, 403);
  }
  assert.equal((await request('/ai/settings', admin, { ...aiInput, effort: 'ultra' }, 'PUT')).status, 400);
  assert.equal((await request('/ai/settings', admin, aiInput, 'POST')).status, 405);
  const savedAi = await request('/ai/settings', admin, aiInput, 'PUT');
  assert.equal(savedAi.status, 200);
  assert.equal(savedAi.data.settings.connected, true);
  assert.equal(savedAi.data.settings.keyTail, key.slice(-4));
  assert.ok(db.state.settings.ai.credential.data);
  assert.ok(!JSON.stringify(db.state.settings.ai).includes(key), 'stored credential is authenticated ciphertext');
  const ciphertext = db.state.settings.ai.credential.data;
  for (const who of [admin, member]) {
    const out = await request('/state', who);
    assert.equal(out.status, 200);
    const wire = JSON.stringify(out.data);
    assert.ok(!wire.includes(key) && !wire.includes(ciphertext), 'neither raw nor sealed credentials leave the server');
    if (who === member) assert.equal(out.data.state.settings.ai.keyTail, undefined);
  }
  const { resolveAiConnection } = await import(pathToFileURL(join(root, 'lib/ai-settings.js')));
  assert.equal(resolveAiConnection(db.state.settings.ai).apiKey, key);
  const sealedBeforeSettings = structuredClone(db.state.settings.ai.credential);
  assert.equal((await request('/ai/settings', admin, { model: 'gpt-6-astra', effort: 'low', key: '' }, 'PUT')).status, 200);
  assert.deepEqual(db.state.settings.ai.credential, sealedBeforeSettings, 'model changes keep the saved key');
  const refusedTest = await request('/ai/test', admin, { model: 'gpt-6-astra', effort: 'max' });
  assert.equal(refusedTest.status, 422); assert.match(refusedTest.data.error, /5¢ limit/);
  assert.equal((await request('/ai/settings', admin, { model: 'gpt-5.6-sol', effort: 'none', key: '' }, 'PUT')).status, 200);
  let providerCalls = 0;
  globalThis.fetch = async (url, init) => {
    providerCalls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init.headers.authorization, 'Bearer ' + key);
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gpt-5.6-sol'); assert.equal(body.reasoning.effort, 'none');
    assert.equal(body.store, false); assert.equal(body.max_output_tokens, 160); assert.equal(body.service_tier, 'default');
    return { ok: true, json: async () => ({ status: 'completed', service_tier: 'default', usage: { input_tokens: 1000, output_tokens: 50 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Updated the test connection' }] }] }) };
  };
  assert.equal((await request('/ai/test', admin, { model: 'gpt-5.6-sol', effort: 'none' })).status, 200);
  const summaryInput = { title: 'Fixture', beforeTitle: 'Fixture', section: 'Software', beforeSection: 'Software', diff: '- old\n+ new', isNew: false, truncated: false };
  assert.equal((await request('/change-summary', member, summaryInput)).data.available, true);
  assert.equal(providerCalls, 2, 'ordinary members use the owner-selected account, model and effort');
  assert.equal((await request('/ai/usage', null)).status, 401);
  assert.equal((await request('/ai/usage', member)).status, 403);
  const tracked = await request('/ai/usage', admin);
  assert.equal(tracked.status, 200); assert.equal(tracked.headers['cache-control'], 'private, no-store');
  assert.equal(tracked.data.usage.current.requests, 2);
  assert.equal(tracked.data.usage.current.costMicros, 10000, 'connection tests and summaries both count');
  assert.equal(tracked.data.usage.limits.monthMicros, 5000000);
  assert.equal(tracked.data.usage.limits.dayMicros, 1000000);
  assert.ok(!JSON.stringify(tracked.data).includes(key));
  assert.ok(!JSON.stringify(tracked.data).includes(member), 'usage does not disclose member identifiers');
  const tooBig = await request('/change-summary', member, { ...summaryInput, ignored: 'x'.repeat(80001) });
  assert.equal(tooBig.status, 413, 'pre-parsed bodies obey the same byte limit');
  assert.equal(providerCalls, 2);
  db.failAiUsage = true;
  const protectedCall = await request('/change-summary', member, { ...summaryInput, diff: '+ another change' });
  assert.equal(protectedCall.data.reason, 'accounting_unavailable'); assert.equal(providerCalls, 2);
  db.failAiUsage = false;
  reset();
  assert.equal((await request('/ai/settings')).status, 200);
  assert.equal(fullReads(), 0, 'settings reads do not fetch the wiki documents');
  db.conflict = () => { db.state.users.find((u) => u.email === admin).role = 'member'; };
  assert.equal((await request('/ai/settings', admin, aiInput, 'PUT')).status, 403);
  assert.equal(db.state.settings.ai.model, 'gpt-5.6-sol', 'a demoted admin cannot retry the settings write');
  db.state.users.find((u) => u.email === admin).role = 'admin'; db.version++;
  assert.equal((await request('/ai/settings', admin, { disconnect: true }, 'PUT')).status, 200);
  assert.equal(db.state.settings.ai.credential, null);
  assert.equal(resolveAiConnection(db.state.settings.ai).apiKey, '');
  assert.equal((await request('/change-summary', member, summaryInput)).data.available, false);
  assert.equal(providerCalls, 2, 'disconnect prevents inference, including cached summaries');
  globalThis.fetch = async () => { throw new Error('Network disabled in transfer tests'); };

  db.failQuota = true;
  for (const path of ['/me', '/state', '/interest']) {
    const unavailable = await request(path);
    assert.equal(unavailable.status, 503, 'quota failures have a retryable service-unavailable response');
    assert.equal(unavailable.data.code, 'DATABASE_QUOTA_EXCEEDED');
    assert.equal(unavailable.headers['retry-after'], '300');
    assert.doesNotMatch(unavailable.data.error, /HTTP status 402|neon:retryable/, 'driver internals are not shown');
  }

  console.log('PASS: isolated preference storage/sync, canonical sanitized acknowledgments, legacy/private overlays, no-op and concurrent saves, content CAS/auth races, compressed snapshots, and quota errors');
}
