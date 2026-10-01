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
  async function attachment(path, context = {}) {
    const res = { headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; }, end(value) { this.body = value; } };
    await handleInterest({ method: 'GET', headers: {} }, res, path, { me: async () => ({ role: 'admin' }), ...context });
    return res;
  }
  const pdfBytes = Buffer.from('%PDF-1.4\n%%EOF');
  await putFile({ id: 'int-previewpdf', name: 'Resume.pdf', type: 'application/pdf', size: pdfBytes.length, data: pdfBytes });
  const pdf = await attachment('/interest/file/int-previewpdf');
  assert.equal(pdf.statusCode, 200);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.match(pdf.headers['content-disposition'], /^inline;/);
  assert.equal(pdf.headers['x-content-type-options'], 'nosniff');
  assert.equal(pdf.headers['cache-control'], 'private, max-age=3600');
  assert.deepEqual(pdf.body, pdfBytes, 'the browser receives the original PDF');
  const receipt = 'jr-1789600000000-' + 'a'.repeat(24);
  const queue = { journal: {
    getEntry: async () => ({ id: receipt, fileName: 'Resume.pdf', fileType: 'application/pdf', fileSize: pdfBytes.length }),
    getFile: async () => pdfBytes,
  } };
  const queued = await attachment(`/interest/queue/${receipt}/file`, queue);
  assert.equal(queued.statusCode, 200);
  assert.equal(queued.headers['content-type'], 'application/pdf');
  assert.match(queued.headers['content-disposition'], /^inline;/, 'held submissions preview too');
  assert.equal(queued.headers['cache-control'], 'private, no-store');
  assert.equal(queued.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(queued.body, pdfBytes);
  for (const [me, status] of [[null, 401], [{ role: 'member' }, 403]]) {
    assert.equal((await attachment('/interest/file/int-previewpdf', { me: async () => me })).statusCode, status);
    assert.equal((await attachment(`/interest/queue/${receipt}/file`, { ...queue, me: async () => me })).statusCode, status);
  }
  const unsafe = Buffer.from('<script>alert(1)</script>');
  await putFile({ id: 'int-previewhtml', name: 'Resume.pdf', type: 'text/html', size: unsafe.length, data: unsafe });
  const html = await attachment('/interest/file/int-previewhtml');
  assert.equal(html.headers['content-type'], 'application/octet-stream');
  assert.match(html.headers['content-disposition'], /^attachment;/, 'active content remains a download even with a PDF filename');
  assert.equal(html.headers['content-security-policy'], 'sandbox');
  console.log('PASS: legacy and queued PDFs preview inline with original bytes, private access, and safe attachment headers');
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
