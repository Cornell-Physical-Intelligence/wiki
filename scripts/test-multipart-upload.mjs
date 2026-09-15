// Synthetic storage failures only. No live database, uploads, or network calls.
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (!process.env.MULTIPART_TEST_ROOT) {
  const root = await mkdtemp(join(tmpdir(), 'cupi-multipart-test-'));
  try {
    await cp(new URL('../lib', import.meta.url), join(root, 'lib'), { recursive: true });
    await cp(new URL('../api', import.meta.url), join(root, 'api'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    const adapter = join(root, 'node_modules/@vercel/postgres');
    await mkdir(adapter, { recursive: true });
    await writeFile(join(adapter, 'package.json'), '{"type":"module","exports":"./index.js"}');
    await writeFile(join(adapter, 'index.js'), 'export const createPool = () => ({ sql: (...args) => globalThis.multipartDb.query(...args) });');
    for (const driver of ['postgres', 'memory']) {
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        env: { PATH: process.env.PATH, MULTIPART_TEST_ROOT: root, MULTIPART_DRIVER: driver,
          ...(driver === 'postgres' ? { POSTGRES_URL: 'postgres://synthetic' } : { DEV_FAKE_AUTH: 'synthetic@example.com' }),
        }, stdio: 'inherit',
      });
      if (result.status || result.error) { process.exitCode = result.status || 1; break; }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
} else if (process.env.MULTIPART_DRIVER === 'memory') {
  const { putPart, finishUpload, getFile } = await import(pathToFileURL(join(process.env.MULTIPART_TEST_ROOT, 'lib/db.js')));
  const expected = Buffer.from('Synthetic multipart file');
  const encoded = expected.toString('base64');
  await putPart('up-memory', 0, 'wrong data');
  await putPart('up-memory', 0, encoded.slice(0, 8));
  await putPart('up-memory', 1, encoded.slice(8));
  const first = await finishUpload('up-memory', { name: 'memory.txt', type: 'text/plain', by: 'synthetic@example.com' });
  assert.deepEqual((await getFile(first.id)).data, expected, 'dev part retries replace the same sequence');
  assert.deepEqual(await finishUpload('up-memory', { name: 'ignored.txt', type: 'text/plain', by: 'synthetic@example.com' }), first);
  console.log('PASS: dev multipart upserts and completed-upload retries');
} else {
  globalThis.fetch = async () => { throw new Error('Network disabled in multipart tests'); };
  const db = globalThis.multipartDb = {
    parts: new Map(), files: new Map(), calls: [], failSave: null, failCleanup: false, failVerification: false,
    async query(strings, ...v) {
      const text = strings.join('?').replace(/\s+/g, ' ').trim();
      this.calls.push(text);
      const rows = (list = []) => ({ rows: structuredClone(list), rowCount: list.length });
      if (text.startsWith('CREATE TABLE') || text.startsWith('ALTER TABLE')) return rows();
      if (text === 'SELECT 1 FROM wiki_state WHERE id = 1') return rows([{ value: 1 }]);
      if (text.startsWith('SELECT version,')) return rows([{ version: 1, member: { email: v[0], name: 'Synthetic member', status: 'active', role: 'member' } }]);
      if (text.startsWith('INSERT INTO wiki_upload_parts')) {
        const parts = this.parts.get(v[0]) || new Map(); parts.set(v[1], v[2]); this.parts.set(v[0], parts); return rows();
      }
      if (text.startsWith('SELECT seq, data FROM wiki_upload_parts')) {
        return rows([...(this.parts.get(v[0]) || new Map())].sort((a, b) => a[0] - b[0]).map(([seq, data]) => ({ seq, data })));
      }
      if (text.startsWith('DELETE FROM wiki_upload_parts')) {
        if (this.failCleanup) throw new Error('Synthetic cleanup failure');
        this.parts.delete(v[0]); return rows();
      }
      if (text.startsWith('SELECT id, name, type, size, by, ts FROM wiki_files WHERE id')) {
        const file = this.files.get(v[0]);
        if (file && this.failVerification) { this.failVerification = false; throw new Error('Synthetic verification response loss'); }
        if (!file) return rows();
        const { data, ...meta } = file; return rows([meta]);
      }
      if (text.startsWith('INSERT INTO wiki_files')) {
        assert.match(text, /ON CONFLICT \(id\) DO NOTHING/);
        if (this.failSave === 'before') throw new Error('Synthetic final write failure');
        if (!this.files.has(v[0])) this.files.set(v[0], { id: v[0], name: v[1], type: v[2], size: v[3], by: v[4], ts: v[5], data: Buffer.from(v[6], 'base64') });
        if (this.failSave === 'after') throw new Error('Synthetic lost commit response');
        return rows();
      }
      throw new Error('Unexpected synthetic query: ' + text);
    },
  };
  const root = process.env.MULTIPART_TEST_ROOT;
  const { default: handler } = await import(pathToFileURL(join(root, 'api/index.js')));
  const { makeSession } = await import(pathToFileURL(join(root, 'lib/auth.js')));
  const expected = Buffer.from('Synthetic multipart file with multiple parts');
  const encoded = expected.toString('base64');
  async function request(path, body, authenticated = true) {
    const req = { url: '/api' + path, method: 'POST', body, headers: {
      ...(authenticated ? { cookie: `cupi_session=${makeSession('synthetic@example.com')}` } : {}),
    } };
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(v) { this.body = v; } };
    await handler(req, res);
    return { status: res.statusCode, data: JSON.parse(res.body) };
  }
  const finish = (uploadId) => request('/att/finish', { uploadId, name: 'synthetic.txt', type: 'text/plain' });
  async function upload(uploadId) {
    assert.equal((await request('/att/part', { uploadId, seq: 0, data: encoded.slice(0, 8) })).status, 200);
    assert.equal((await request('/att/part', { uploadId, seq: 1, data: encoded.slice(8) })).status, 200);
  }
  const writes = () => db.calls.filter((q) => q.startsWith('INSERT INTO wiki_files')).length;

  assert.equal((await request('/att/finish', { uploadId: 'up-noauth' }, false)).status, 401);
  assert.equal(db.calls.length, 0, 'signed-out finish requests do not access storage');
  await upload('up-writefails');
  db.failSave = 'before';
  assert.equal((await finish('up-writefails')).status, 500);
  assert.equal(db.parts.get('up-writefails').size, 2, 'failed final writes preserve all parts');
  assert.equal(db.files.size, 0);
  db.failSave = null;
  const retried = await finish('up-writefails');
  assert.equal(retried.status, 200); assert.deepEqual(db.files.get(retried.data.id).data, expected);
  assert.equal(db.parts.has('up-writefails'), false);

  for (const failure of ['after', 'verification']) {
    const id = 'up-' + failure;
    await upload(id);
    if (failure === 'after') db.failSave = 'after'; else db.failVerification = true;
    assert.equal((await finish(id)).status, 500);
    assert.equal(db.parts.get(id).size, 2, 'uncertain commit/verification responses keep parts');
    const before = writes(); db.failSave = null;
    const recovered = await finish(id);
    assert.equal(recovered.status, 200);
    assert.deepEqual(db.files.get(recovered.data.id).data, expected);
    assert.equal(writes(), before, 'retry reuses the durable file without inserting it again');
    assert.equal(db.parts.has(id), false);
  }

  await upload('up-cleanup'); db.failCleanup = true;
  const cleanedLater = await finish('up-cleanup');
  assert.equal(cleanedLater.status, 200, 'cleanup errors must not turn a saved upload into a failure');
  assert.equal(db.parts.get('up-cleanup').size, 2);
  db.failCleanup = false;
  assert.deepEqual(await finish('up-cleanup'), cleanedLater);
  assert.equal(db.parts.has('up-cleanup'), false);

  await upload('up-overlap');
  const beforeFiles = db.files.size;
  const overlap = await Promise.all([finish('up-overlap'), finish('up-overlap')]);
  assert.deepEqual(overlap[0], overlap[1]); assert.equal(overlap[0].status, 200);
  assert.equal(db.files.size, beforeFiles + 1, 'overlapping finish requests create one file');

  await request('/att/part', { uploadId: 'up-gap', seq: 0, data: encoded.slice(0, 4) });
  await request('/att/part', { uploadId: 'up-gap', seq: 2, data: encoded.slice(8) });
  assert.equal((await finish('up-gap')).status, 400);
  assert.equal(db.parts.get('up-gap').size, 2, 'incomplete uploads stay recoverable');
  await request('/att/part', { uploadId: 'up-gap', seq: 1, data: encoded.slice(4, 8) });
  const repaired = await finish('up-gap');
  assert.equal(repaired.status, 200); assert.deepEqual(db.files.get(repaired.data.id).data, expected);
  for (const seq of [-1, 0.5, 'invalid']) assert.equal((await request('/att/part', { uploadId: 'up-invalid', seq, data: encoded })).status, 400);
  assert.equal(db.parts.has('up-invalid'), false);
  assert.equal((await finish('up-unknown')).status, 400);
  console.log('PASS: multipart write/response/cleanup failures, safe retries, concurrent finish, missing parts, and authentication');
}
