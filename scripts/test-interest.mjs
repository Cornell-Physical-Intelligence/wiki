// Synthetic fixtures only: isolate storage and disable email/network credentials.
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

if (!process.env.INTEREST_TEST_ROOT) {
  const dir = await mkdtemp(join(tmpdir(), 'cupi-interest-test-'));
  try {
    await cp(new URL('../lib', import.meta.url), join(dir, 'lib'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, DEV_FAKE_AUTH: 'test@example.com', INTEREST_TEST_ROOT: dir },
      stdio: 'inherit',
    });
    process.exitCode = result.status || (result.error ? 1 : 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
} else {
  const old = { id: 'in-legacy', ts: 1, updated: 1, name: 'Legacy Applicant', email: 'legacy@example.com', subteam: '', project: 'Existing answer', fileId: null, fileName: null, fileType: null, fileSize: null, cornell: false };
  await writeFile(join(process.env.INTEREST_TEST_ROOT, '.devinterest.json'), JSON.stringify({ rows: [old], events: [], archives: [] }));
  const { handleInterest } = await import(pathToFileURL(join(process.env.INTEREST_TEST_ROOT, 'lib/interest.js')));
  let requestId = 0;
  async function request(method, path, body = {}, me = { role: 'admin' }) {
    const req = { method, headers: { origin: 'https://cornellphysicalintelligence.com', 'content-type': 'application/json', 'x-real-ip': `test-${++requestId}` } };
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(value) { this.body = value; } };
    await handleInterest(req, res, path, {
      readJson: async () => body, me: async () => me,
      // Throw before the notifier can run; never send an email from tests.
      emailSettings: async () => { throw new Error('Email disabled in tests'); },
    });
    return { status: res.statusCode, headers: res.headers, text: res.body, data: res.headers['content-type'] === 'application/json' ? JSON.parse(res.body) : null };
  }
  const rows = async () => (await request('GET', '/interest')).data.rows;
  assert.deepEqual((await rows())[0], old, 'legacy reads must not rewrite data');
  for (const year of ['Freshman', 'Sophomore', 'Junior', 'Senior', 'Grad']) {
    assert.equal((await request('POST', '/interest', { name: year, email: `${year.toLowerCase()}@example.com`, year })).status, 200);
  }
  assert.equal((await request('POST', '/interest', { name: 'No Year', email: 'blank@example.com' })).status, 200);
  assert.equal((await rows()).find((r) => r.email === 'blank@example.com').year, null);
  for (const year of ['Unknown', 2026, ['Grad'], {}]) {
    assert.equal((await request('POST', '/interest', { name: 'Invalid', email: 'invalid@example.com', year })).status, 400);
  }
  assert.equal((await request('POST', '/interest', { name: 'Freshman', email: 'freshman@example.com' })).status, 409);
  assert.equal((await request('POST', '/interest', { name: 'Updated', email: 'freshman@example.com', confirmUpdate: true })).status, 200);
  assert.equal((await rows()).find((r) => r.email === 'freshman@example.com').year, 'Freshman', 'old clients preserve a saved year');
  assert.equal((await request('POST', '/interest', { name: 'Updated', email: 'freshman@example.com', confirmUpdate: true, year: null })).status, 200);
  assert.equal((await rows()).find((r) => r.email === 'freshman@example.com').year, null, 'explicit blank can clear year');
  assert.equal((await request('POST', '/interest', { name: 'Legacy Applicant', email: old.email, confirmUpdate: true, year: 'Grad', project: old.project })).status, 200);
  const legacyUpdated = (await rows()).find((r) => r.email === old.email);
  assert.equal(legacyUpdated.id, old.id);
  assert.equal(legacyUpdated.ts, old.ts);
  assert.equal(legacyUpdated.project, old.project);
  assert.equal(legacyUpdated.year, 'Grad');
  const csv = await request('GET', '/interest.csv');
  assert.equal(csv.text.split('\r\n')[0], '\uFEFFSubmitted,Updated,Name,Email,Subteam,Coolest project,Cornell address,File,Year');
  assert.match(csv.text, /"Grad"/);
  for (const path of ['/interest', '/interest.csv', '/interest/archives']) {
    assert.equal((await request('GET', path, {}, null)).status, 401);
    assert.equal((await request('GET', path, {}, { role: 'member' })).status, 403);
  }
  const beforeArchive = await rows();
  const archive = await request('POST', '/interest/archive', { name: 'Test cycle' });
  assert.equal(archive.status, 200);
  assert.deepEqual(await rows(), []);
  assert.deepEqual((await request('GET', `/interest/archives/${archive.data.archive.id}`)).data.archive.rows, beforeArchive);
  assert.equal((await request('GET', `/interest/archives/${archive.data.archive.id}.csv`)).text, csv.text);
  console.log('PASS: years, legacy records, old-client updates, validation, CSV/archive round trips, admin access');

  const source = await readFile(new URL('../src/client/ui2.js', import.meta.url), 'utf8');
  const context = vm.createContext({ UI: { interest: { rows: [old, { ...old, id: 'in-new', name: 'New Applicant', email: 'new@example.com', year: 'Grad', ts: 2 }] } } });
  vm.runInContext(source.slice(source.indexOf('const INTEREST_ICONS'), source.indexOf('function viewAdmin()')), context);
  const run = (code) => vm.runInContext(code, context);
  assert.equal(run('interestSelection().size'), 0);
  run("interestSelection().add('in-legacy'); UI.interestQuery = 'Grad'");
  assert.equal(run('interestVisible().length'), 1);
  assert.equal(run('interestSelection().size'), 1, 'hidden selection is preserved');
  run("interestSelection().add('in-new'); UI.interestSort = { key: 'year', dir: 'asc' }; UI.interestQuery = ''");
  assert.equal(run('interestVisible()[0].year'), 'Grad');
  assert.equal(run('interestEmailsCsv(interestSelectedEmails())'), 'legacy@example.com,new@example.com');
  run("UI.interest.rows.push({...UI.interest.rows[1], id: 'in-dupe'}); interestSelection().add('in-dupe')");
  assert.equal(run('interestSelectedEmails().length'), 2, 'emails are deduplicated');
  run("UI.interest.rows = UI.interest.rows.filter(r => r.id !== 'in-legacy')");
  assert.equal(run("interestSelection().has('in-legacy')"), false, 'deleted records are pruned');
  run("UI.interestArchiveView = { id: 'ar-test', archive: { rows: [] } }");
  assert.equal(run('interestSelection().size'), 0, 'archive has a separate selection');
  assert.equal(run('interestEmailsCsv([\'a,"b@example.com\'])'), '"a,""b@example.com"');
  console.log('PASS: selection persistence, year sorting, deduplication, CSV escaping, stale records and archive isolation');
}
