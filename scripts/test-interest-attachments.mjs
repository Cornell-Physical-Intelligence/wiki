// Actual handlers and storage, isolated synthetic fixtures; no network or keys.
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (!process.env.INTEREST_ATTACHMENT_TEST_ROOT) {
  const dir = await mkdtemp(join(tmpdir(), 'cupi-interest-attachments-'));
  try {
    await cp(new URL('../lib', import.meta.url), join(dir, 'lib'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, DEV_FAKE_AUTH: 'test@example.com', INTEREST_ATTACHMENT_TEST_ROOT: dir }, stdio: 'inherit',
    });
    process.exitCode = result.status || (result.error ? 1 : 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
} else {
  globalThis.fetch = async () => { throw new Error('Network disabled'); };
  const root = process.env.INTEREST_ATTACHMENT_TEST_ROOT;
  const row = (id) => ({ id: 'in-' + id, ts: 1, updated: 1, name: id, email: `${id}@example.com`, fileId: 'int-' + id });
  const a = row('concurrent'), b = row('archived'), c = row('live');
  const archive = (r) => ({ id: 'ar-' + r.name, ts: 1, name: r.name, count: 1, rows: [r] });
  await writeFile(join(root, '.devinterest.json'), JSON.stringify({ rows: [a, b, c], archives: [archive(b), archive(c)], events: [] }));
  const { handleInterest } = await import(pathToFileURL(join(root, 'lib/interest.js')));
  const { putFile, getFile } = await import(pathToFileURL(join(root, 'lib/db.js')));
  for (const r of [a, b, c]) await putFile({ id: r.fileId, name: 'fixture.txt', type: 'text/plain', size: 7, data: Buffer.from('fixture') });
  async function request(method, path, body = {}) {
    const req = { method, headers: {} }, res = { setHeader() {}, end(value) { this.body = value; } };
    await handleInterest(req, res, path, { readJson: async () => body, me: async () => ({ role: 'admin' }) });
    assert.equal(res.statusCode, 200);
    return JSON.parse(res.body);
  }
  await request('DELETE', '/interest/' + b.id);
  assert.ok(await getFile(b.fileId), 'deleting a live row preserves its archived attachment');
  await request('DELETE', '/interest/archives/ar-live');
  assert.ok(await getFile(c.fileId), 'deleting an archive preserves a live attachment');
  const snapshots = await Promise.all([
    request('POST', '/interest/archive', { name: 'First' }),
    request('POST', '/interest/archive', { name: 'Second' }),
  ]);
  await request('DELETE', '/interest/archives/' + snapshots[0].archive.id);
  for (const r of [a, c]) assert.ok(await getFile(r.fileId), 'deleting one concurrent archive preserves the other');
  await request('DELETE', '/interest/archives/' + snapshots[1].archive.id);
  for (const r of [a, c]) assert.equal(await getFile(r.fileId), null, 'the last reference removal cleans up the file');
  await request('DELETE', '/interest/archives/ar-archived');
  assert.equal(await getFile(b.fileId), null);
  console.log('PASS: live/archive attachment references survive deletion and concurrent archives; unreferenced files are removed');
}
