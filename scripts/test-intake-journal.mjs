// Synthetic outage/recovery fixtures. Real credentials and networks are never used.
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (!process.env.INTAKE_TEST_ROOT) {
  const dir = await mkdtemp(join(tmpdir(), 'cupi-intake-test-'));
  try {
    await cp(new URL('../lib', import.meta.url), join(dir, 'lib'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await writeFile(join(dir, 'lib/db.js'), `
      export const storageMode = () => 'postgres';
      export const rawSql = async () => globalThis.intakeDb.sql;
      export const putFile = async () => { throw new Error('Unexpected file writer'); };
      export const getFile = async (id) => globalThis.intakeDb.files.get(id) || null;
      export const deleteFile = async (id) => globalThis.intakeDb.files.delete(id);
    `);
    const out = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, INTAKE_TEST_ROOT: dir }, stdio: 'inherit',
    });
    process.exitCode = out.status || (out.error ? 1 : 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
} else {
  globalThis.fetch = async () => { throw new Error('Network disabled in intake tests'); };
  const root = process.env.INTAKE_TEST_ROOT;
  const { createIntakeJournal } = await import(pathToFileURL(join(root, 'lib/intake-journal.js')));
  const trace = [];
  let clock = 1789500000000;
  Date.now = () => clock;
  const stored = new Map();
  const blob = {
    failed: false, failComplete: false,
    async put(path, body, opts) {
      trace.push('blob:put:' + path);
      assert.equal(opts.access, 'private');
      assert.equal(opts.addRandomSuffix, false);
      if (this.failed || (this.failComplete && path.includes('/done/'))) throw new Error('Synthetic Blob outage');
      if (stored.has(path)) assert.equal(opts.allowOverwrite, true, 'raw recovery records must never overwrite');
      stored.set(path, Buffer.from(body));
      return { pathname: path, url: `https://synthetic.private.blob.vercel-storage.com/${path}` };
    },
    async list({ prefix, cursor }) {
      trace.push('blob:list:' + prefix);
      if (this.failed) throw new Error('Synthetic Blob outage');
      const items = [...stored.keys()].filter((p) => p.startsWith(prefix)).sort();
      const start = Number(cursor || 0);
      const page = items.slice(start, start + 2); // Always exercise pagination.
      return { blobs: page.map((pathname) => ({ pathname })), hasMore: start + 2 < items.length, cursor: String(start + 2) };
    },
    async get(path, opts) {
      trace.push('blob:get:' + path);
      assert.equal(opts.access, 'private'); assert.equal(opts.useCache, false);
      if (this.failed) throw new Error('Synthetic Blob outage');
      if (this.corruptDiagnostic && path.startsWith('diagnostics/')) return { statusCode: 200, stream: new Response('wrong bytes').body };
      return stored.has(path) ? { statusCode: 200, stream: new Response(stored.get(path)).body } : null;
    },
    async del(path) {
      trace.push('blob:del:' + path);
      assert.match(path, /^diagnostics\/intake-storage-\d+-[a-f0-9]{32}\.json$/, 'storage checks can only delete their generated diagnostics');
      stored.delete(path);
    },
  };
  const journal = createIntakeJournal({ enabled: () => true, loadBlob: async () => blob });
  const db = globalThis.intakeDb = {
    rows: [], receipts: new Map(), files: new Map(), archives: [], down: false,
    failRejectedRead: false, failCommit: false, archiveRace: null,
    async sql(strings, ...v) {
      const text = strings.join('?').replace(/\s+/g, ' ').trim();
      trace.push('sql:' + text.split(' ').slice(0, 3).join(' '));
      const result = (rows = [], rowCount = rows.length) => ({ rows: structuredClone(rows), rowCount });
      if (db.down) throw new Error('Synthetic Neon outage');
      if (text.startsWith('CREATE TABLE') || text.startsWith('ALTER TABLE')) return result();
      if (text.startsWith('SELECT count(*) AS n FROM interest_events')) return result([{ n: db.rateBlocked ? 5 : 0 }]);
      if (text.startsWith('DELETE FROM interest_events') || text.startsWith('INSERT INTO interest_events')) return result();
      if (text.startsWith('SELECT count(*) AS n FROM interest_submissions')) return result([{ n: db.rows.length }]);
      if (text.startsWith('SELECT * FROM interest_submissions WHERE email')) return result(db.rows.filter((r) => r.email === v[0]));
      if (text === 'SELECT * FROM interest_submissions ORDER BY ts DESC') return result([...db.rows].sort((a, b) => b.ts - a.ts));
      if (text.startsWith('SELECT outcome FROM interest_receipts')) {
        if (db.failRejectedRead && db.receipts.get(v[0]) === 'rejected') throw new Error('Receipt response lost after commit');
        return result(db.receipts.has(v[0]) ? [{ outcome: db.receipts.get(v[0]) }] : []);
      }
      if (text.startsWith('INSERT INTO interest_receipts')) { if (!db.receipts.has(v[0])) db.receipts.set(v[0], v[1]); return result(); }
      if (text.startsWith('INSERT INTO wiki_files')) {
        if (!db.files.has(v[0])) db.files.set(v[0], { id: v[0], name: v[1], type: v[2], size: v[3], by: v[4], ts: v[5], data: Buffer.from(v[6], 'base64') });
        return result();
      }
      if (text.startsWith('WITH prior AS')) {
        assert.match(text, /WHERE NOT EXISTS \(SELECT 1 FROM prior\)/);
        assert.match(text, /WHERE \? AND interest_submissions.updated <= EXCLUDED.updated/);
        if (db.failCommit) throw new Error('Synthetic row write failure');
        const id = v[0];
        if (db.receipts.has(id)) return result([{ outcome: db.receipts.get(id) }]);
        const incoming = { id: v[1], ts: v[2], updated: v[3], name: v[4], email: v[5], subteam: v[6], project: v[7], cornell: v[8], file_id: v[9], file_name: v[10], file_type: v[11], file_size: v[12], ip_hash: v[13], year: v[14] };
        const current = db.rows.find((r) => r.email === incoming.email);
        let outcome;
        if (current && !v[16]) outcome = 'review';
        else if (current && current.updated > incoming.updated) outcome = 'superseded';
        else {
          if (current) {
            const updated = { ...incoming, id: current.id, ts: current.ts, year: v[15] ? incoming.year : current.year };
            for (const k of ['file_id', 'file_name', 'file_type', 'file_size']) updated[k] ||= current[k];
            db.rows[db.rows.indexOf(current)] = updated;
          } else db.rows.push(incoming);
          outcome = 'saved';
        }
        db.receipts.set(id, outcome);
        return result([{ outcome }]);
      }
      if (text.startsWith('INSERT INTO interest_archives')) {
        db.archives.push({ id: v[0], ts: v[1], name: v[2], count: v[3], rows: JSON.parse(v[4]) });
        db.archiveRace?.(); db.archiveRace = null;
        return result();
      }
      if (text.startsWith('DELETE FROM interest_submissions AS live')) {
        assert.match(text, /live.id = archived.id AND live.updated = archived.updated/);
        assert.match(text, /live.review_version = archived.review_version/);
        const versions = new Map(JSON.parse(v[0]).map((r) => [r.id, `${r.updated}/${r.review_version || 0}`]));
        const included = (r) => versions.get(r.id) === `${r.updated}/${r.review_version || 0}`;
        const removed = db.rows.filter(included);
        db.rows = db.rows.filter((r) => !included(r));
        return result(removed);
      }
      if (text.startsWith('DELETE FROM interest_submissions WHERE id')) {
        const removed = db.rows.filter((r) => r.id === v[0]);
        db.rows = db.rows.filter((r) => r.id !== v[0]);
        return result(removed);
      }
      if (text.startsWith('DELETE FROM interest_archives WHERE id')) {
        const removed = db.archives.filter((a) => a.id === v[0]);
        db.archives = db.archives.filter((a) => a.id !== v[0]);
        return result(removed);
      }
      if (text.startsWith('DELETE FROM wiki_files WHERE id')) {
        assert.match(text, /NOT EXISTS \(SELECT 1 FROM interest_submissions WHERE file_id/);
        assert.match(text, /NOT EXISTS \(SELECT 1 FROM interest_archives/);
        assert.match(text, /jsonb_array_elements\(a.rows\)/);
        assert.deepEqual(v, [v[0], v[0], v[0]]);
        if (!db.rows.some((r) => r.file_id === v[0]) && !db.archives.some((a) => a.rows.some((r) => r.fileId === v[0]))) db.files.delete(v[0]);
        return result();
      }
      throw new Error('Unexpected synthetic SQL: ' + text);
    },
  };
  const { handleInterest } = await import(pathToFileURL(join(root, 'lib/interest.js')));
  let requestNo = 0;
  async function request(method, path, body = {}, me = { role: 'admin' }) {
    clock += 10;
    const req = { method, headers: { origin: 'https://cornellphysicalintelligence.com', 'content-type': 'application/json', 'x-real-ip': `synthetic-${++requestNo}` } };
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(v) { this.body = v; } };
    await handleInterest(req, res, path, {
      readJson: async () => body, me: async () => me, journal,
      emailSettings: async () => { throw new Error('Test notifications disabled'); },
    });
    return { status: res.statusCode, data: res.headers['content-type'] === 'application/json' ? JSON.parse(res.body) : res.body, headers: res.headers };
  }
  const form = (email, extra = {}) => ({ name: 'Synthetic Applicant', email, project: 'Synthetic project answer', ...extra });
  const originals = () => [...stored.keys()].filter((p) => p.includes('/records/')).length;

  for (const [me, code] of [[null, 401], [{ role: 'member' }, 403]]) {
    const before = trace.length;
    assert.equal((await request('POST', '/interest/storage-check', {}, me)).status, code);
    assert.equal(trace.length, before, 'unauthorized checks never contact storage');
  }
  const storageCheck = await request('POST', '/interest/storage-check');
  assert.equal(storageCheck.status, 200); assert.deepEqual(storageCheck.data, { ok: true });
  assert.equal(stored.size, 0, 'successful check removes its diagnostic');
  blob.corruptDiagnostic = true;
  assert.equal((await request('POST', '/interest/storage-check')).status, 503, 'storage check compares actual bytes');
  assert.equal(stored.size, 0, 'failed comparison also removes only its diagnostic');
  blob.corruptDiagnostic = false; blob.failed = true;
  const failedCheck = await request('POST', '/interest/storage-check');
  assert.equal(failedCheck.status, 503); assert.doesNotMatch(failedCheck.data.error, /Synthetic|token|credential/i);
  blob.failed = false; trace.length = 0;

  db.down = true;
  const outage = await request('POST', '/interest', form('outage@example.com', { year: 'Grad', file: { name: 'synthetic.pdf', type: 'application/pdf', data: Buffer.from('synthetic PDF bytes').toString('base64') } }));
  assert.equal(outage.status, 202); assert.equal(outage.data.queued, true);
  assert.match(outage.data.receipt, /^jr-/);
  assert.equal(originals(), 1);
  assert.ok(trace.findIndex((s) => s.includes('blob:put:') && s.includes('/records/')) < trace.findIndex((s) => s.startsWith('sql:')), 'durable intake must precede any Neon access');
  const raw = await journal.getEntry(outage.data.receipt);
  assert.equal(raw.project, 'Synthetic project answer'); assert.equal(raw.fileSize, 19);
  assert.equal(raw.file, undefined, 'metadata does not duplicate attachment bytes');

  db.down = false;
  const recovered = await request('GET', '/interest');
  assert.equal(recovered.data.rows.length, 1); assert.deepEqual(recovered.data.pendingReview, []);
  assert.equal(db.files.size, 1); assert.equal(db.receipts.get(raw.id), 'saved');
  await request('GET', '/interest');
  assert.equal(db.rows.length, 1); assert.equal(db.files.size, 1); assert.equal(originals(), 1, 'recovery originals are retained');

  const filePath = `/interest/queue/${raw.id}/file`;
  for (const [me, code] of [[null, 401], [{ role: 'member' }, 403]]) {
    const before = trace.length;
    assert.equal((await request('GET', filePath, {}, me)).status, code);
    assert.equal(trace.length, before, 'unauthorized downloads must not read private Blob');
  }
  const downloaded = await request('GET', filePath);
  assert.equal(downloaded.data.toString(), 'synthetic PDF bytes');
  assert.equal(downloaded.headers['cache-control'], 'private, no-store');
  const preservedFile = db.rows[0].file_id;
  await request('POST', '/interest', form('outage@example.com', { confirmUpdate: true, project: 'Confirmed text edit' }));
  assert.equal(db.rows[0].file_id, preservedFile, 'confirmed edits without files preserve the existing attachment');
  assert.equal(db.rows[0].year, 'Grad');

  db.failCommit = true;
  const afterFileFailure = await request('POST', '/interest', form('writefail@example.com', {
    file: { name: 'retry.pdf', type: 'application/pdf', data: Buffer.from('retry attachment').toString('base64') },
  }));
  assert.equal(afterFileFailure.status, 202, 'a failed DB row write after attachment storage remains recoverable');
  const filesBeforeReplay = db.files.size;
  db.failCommit = false;
  await request('GET', '/interest');
  assert.ok(db.rows.some((r) => r.email === 'writefail@example.com'));
  assert.equal(db.files.size, filesBeforeReplay, 'replaying after a partial file write is idempotent');

  blob.failComplete = true;
  const saved = await request('POST', '/interest', form('saved@example.com'));
  assert.equal(saved.status, 200); assert.ok(saved.data.receipt);
  await request('POST', '/interest/archive', { name: 'Synthetic archive' });
  assert.equal(db.rows.length, 0);
  await request('GET', '/interest');
  assert.equal(db.rows.length, 0, 'unfinished Blob markers cannot resurrect archived applications');
  blob.failComplete = false;
  await request('GET', '/interest');

  await request('POST', '/interest', form('duplicate@example.com', { year: 'Grad' }));
  db.down = true;
  const duplicate = await request('POST', '/interest', form('duplicate@example.com', { project: 'Unconfirmed replacement' }));
  assert.equal(duplicate.status, 202);
  db.down = false;
  const reviewed = await request('GET', '/interest');
  assert.equal(reviewed.data.pendingReview[0].reason, 'duplicate');
  assert.equal(reviewed.data.pendingReview[0].project, 'Unconfirmed replacement');
  assert.equal(db.rows[0].project, 'Synthetic project answer', 'unconfirmed queued duplicates never overwrite');

  db.failRejectedRead = true;
  const rejected = await request('POST', '/interest', form('duplicate@example.com'));
  assert.equal(rejected.status, 409, 'known duplicate stays rejected if the receipt response fails after committing');
  assert.equal(rejected.data.ok, undefined);
  db.rateBlocked = true;
  const rateRejected = await request('POST', '/interest', form('ratelimit@example.com'));
  assert.equal(rateRejected.status, 429, 'known rate rejection stays rejected if its receipt response is lost');
  assert.equal(rateRejected.data.ok, undefined);
  db.rateBlocked = false;
  db.failRejectedRead = false;

  db.down = true;
  await request('POST', '/interest', form('duplicate@example.com', { confirmUpdate: true, project: 'First confirmed change' }));
  await request('POST', '/interest', form('duplicate@example.com', { confirmUpdate: true, project: 'Latest confirmed change' }));
  db.down = false;
  await request('GET', '/interest');
  assert.equal(db.rows[0].project, 'Latest confirmed change'); assert.equal(db.rows[0].year, 'Grad', 'old clients preserve a saved year');
  await request('POST', '/interest', form('duplicate@example.com', { confirmUpdate: true, year: null }));
  assert.equal(db.rows[0].year, null, 'explicit blank can still clear year');

  db.archiveRace = () => {
    db.rows[0].updated += 1; db.rows[0].project = 'Changed during archive';
    db.rows.push({ ...db.rows[0], id: 'in-race', email: 'race@example.com' });
  };
  await request('POST', '/interest/archive', { name: 'Concurrent archive' });
  assert.equal(db.rows.length, 2, 'new and edited versions absent from the archive snapshot remain live');
  assert.notEqual(db.archives.at(-1).rows[0].project, 'Changed during archive');

  const reviewedId = db.rows[0].id;
  db.archiveRace = () => {
    db.rows[0].review_version = 1;
    db.rows[0].review = { comments: [{ id: 'ic-concurrent', text: 'Review posted during archive', by: 'lead@cornell.edu', ts: clock }] };
  };
  await request('POST', '/interest/archive', { name: 'Concurrent review archive' });
  assert.deepEqual(db.rows.map((r) => r.id), [reviewedId], 'review updates absent from the snapshot remain on the live list');
  assert.equal(db.archives.at(-1).rows.find((r) => r.id === reviewedId).review, undefined);

  const sharedFile = 'int-sharedreview';
  db.rows[0].file_id = sharedFile;
  db.files.set(sharedFile, { id: sharedFile });
  db.archives.push({ id: 'ar-referenceguard', ts: clock, name: 'Shared file', rows: [{ id: reviewedId, fileId: sharedFile }] });
  assert.equal((await request('DELETE', `/interest/${reviewedId}`)).status, 200);
  assert.ok(db.files.has(sharedFile), 'Postgres cleanup preserves archived files when deleting live rows');
  assert.equal((await request('DELETE', '/interest/archives/ar-referenceguard')).status, 200);
  assert.equal(db.files.has(sharedFile), false, 'Postgres cleans up only after the last reference is removed');

  blob.failed = true;
  const availableDb = await request('POST', '/interest', form('blobdown@example.com'));
  assert.equal(availableDb.status, 200, 'Neon can accept while Blob is unavailable');
  assert.ok(availableDb.data.receipt);
  const queueUnavailable = await request('GET', '/interest');
  assert.equal(queueUnavailable.data.queueUnavailable, true); assert.ok(queueUnavailable.data.rows.length);
  db.down = true;
  const neither = await request('POST', '/interest', form('bothdown@example.com'));
  assert.equal(neither.status, 503); assert.equal(neither.data.ok, undefined);
  assert.equal(neither.data.code, 'INTAKE_UNAVAILABLE');

  const beforeInvalid = originals();
  assert.equal((await request('POST', '/interest', form('invalid'))).status, 400);
  assert.equal((await request('POST', '/interest', form('bot@example.com', { website: 'bot trap' }))).status, 200);
  assert.equal(originals(), beforeInvalid);
  blob.failed = false;
  const originalCount = originals();
  assert.equal((await request('POST', '/interest/storage-check')).status, 200);
  assert.equal(originals(), originalCount, 'diagnostics preserve every recovery record');
  console.log('PASS: private journal before Neon, outage receipt/replay, duplicate confirmation, archive ledger/races, attachment authorization, and independent storage failures');
}
