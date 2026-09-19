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
  const reviewer = { role: 'admin', email: 'lead@example.com', name: 'Team Lead' };
  const secondReviewer = { role: 'admin', email: 'other@example.com', name: 'Other Lead' };
  const reviewPath = `/interest/${old.id}/review`;
  const commentPath = `/interest/${old.id}/comments`;
  for (const me of [null, { role: 'member', email: 'member@example.com' }]) {
    for (const [method, path, body] of [['PATCH', reviewPath, { flagged: true }], ['POST', commentPath, { id: 'ic-test0001', text: 'A comment' }], ['DELETE', commentPath + '/ic-test0001', {}]]) {
      assert.equal((await request(method, path, body, me)).status, me ? 403 : 401);
    }
  }
  assert.equal((await request('PATCH', reviewPath, { flagged: 'yes' }, reviewer)).status, 400);
  assert.equal((await request('PATCH', '/interest/in-missing/review', { flagged: true }, reviewer)).status, 404);
  for (const body of [{ text: '' }, { text: 'x'.repeat(4001) }, { text: 'Valid', id: '../bad' }]) {
    assert.equal((await request('POST', commentPath, body, reviewer)).status, 400);
  }
  const firstComment = { id: 'ic-test0001', text: '<script>alert("test")</script>\nStrong project', by: 'forged@example.com' };
  const concurrent = await Promise.all([
    request('POST', commentPath, firstComment, reviewer),
    request('POST', commentPath, { id: 'ic-test0002', text: 'Follow up about sensors' }, secondReviewer),
    request('PATCH', reviewPath, { flagged: true }, reviewer),
  ]);
  assert.ok(concurrent.every((r) => r.status === 200));
  let reviewed = (await rows()).find((r) => r.id === old.id);
  assert.equal(reviewed.review.comments.length, 2, 'concurrent comments are both retained');
  assert.equal(reviewed.review.comments[0].by, reviewer.email, 'the server supplies authorship');
  assert.equal(reviewed.review.flagged, true);
  assert.equal(reviewed.updated, legacyUpdated.updated, 'review changes do not change the applicant update timestamp');
  const retry = await request('POST', commentPath, firstComment, reviewer);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.row.review.comments.length, 2, 'lost-response retries do not duplicate comments');
  assert.equal((await request('POST', commentPath, { ...firstComment, text: 'Different' }, reviewer)).status, 409);
  assert.equal((await request('POST', commentPath, firstComment, secondReviewer)).status, 409);
  assert.equal((await request('POST', '/interest', { name: old.name, email: old.email, confirmUpdate: true, project: 'A revised answer', review: { comments: [] } })).status, 200);
  reviewed = (await rows()).find((r) => r.id === old.id);
  assert.equal(reviewed.review.comments.length, 2, 'applicant edits cannot erase admin comments');
  assert.equal(reviewed.review.flagged, true);
  assert.equal((await request('PATCH', reviewPath, { flagged: false }, secondReviewer)).data.row.review.comments.length, 2);
  const disk = JSON.parse(await readFile(join(process.env.INTEREST_TEST_ROOT, '.devinterest.json'), 'utf8'));
  assert.equal(disk.rows.find((r) => r.id === old.id).review.comments.length, 2, 'reviews persist to storage');
  const deletedWithConcurrentReview = await Promise.all([
    request('DELETE', commentPath + '/ic-test0001', {}, secondReviewer),
    request('POST', commentPath, { id: 'ic-test0003', text: 'Keep this concurrent comment' }, reviewer),
    request('PATCH', reviewPath, { flagged: true }, reviewer),
  ]);
  assert.ok(deletedWithConcurrentReview.every((r) => r.status === 200));
  reviewed = (await rows()).find((r) => r.id === old.id);
  assert.deepEqual(reviewed.review.comments.map((c) => c.id), ['ic-test0002', 'ic-test0003'], 'deleting one comment preserves simultaneous comments');
  assert.equal(reviewed.review.flagged, true, 'deleting a comment preserves a concurrent flag');
  assert.deepEqual(reviewed.review.deletedCommentIds, ['ic-test0001']);
  const deletedRetry = await request('DELETE', commentPath + '/ic-test0001', {}, reviewer);
  assert.equal(deletedRetry.status, 200, 'a lost deletion response can safely be retried');
  assert.equal(deletedRetry.data.row.reviewVersion, reviewed.reviewVersion, 'delete retries do not invent extra mutations');
  assert.equal((await request('POST', commentPath, firstComment, reviewer)).status, 409, 'a late post retry cannot resurrect a deleted comment');
  assert.equal((await request('DELETE', commentPath + '/ic-notfound1', {}, reviewer)).status, 404);
  assert.equal((await request('DELETE', '/interest/in-missing/comments/ic-test0001', {}, reviewer)).status, 404);
  const deletionDisk = JSON.parse(await readFile(join(process.env.INTEREST_TEST_ROOT, '.devinterest.json'), 'utf8'));
  assert.deepEqual(deletionDisk.rows.find((r) => r.id === old.id).review.deletedCommentIds, ['ic-test0001'], 'deletion tombstones survive persistence');
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
  assert.equal((await request('POST', commentPath, firstComment, reviewer)).status, 404, 'archived reviews cannot be changed through live routes');
  assert.equal((await request('DELETE', commentPath + '/ic-test0002', {}, reviewer)).status, 404, 'archived comments cannot be deleted through live routes');
  assert.deepEqual((await request('GET', `/interest/archives/${archive.data.archive.id}`)).data.archive.rows, beforeArchive, 'deletion attempts leave archives unchanged');
  console.log('PASS: review authorization, validation, concurrency, retry deduplication, durable notes, archive snapshots');
  console.log('PASS: years, legacy records, old-client updates, validation, CSV/archive round trips, admin access');

  const serverSource = await readFile(new URL('../lib/interest.js', import.meta.url), 'utf8');
  const update = serverSource.slice(serverSource.indexOf('async function updateReview'), serverSource.indexOf('async function clearRows'));
  const historyRow = { id: 'in-history', reviewVersion: 1, review: { flagged: true, comments: [{ id: 'ic-last0001', by: reviewer.email, text: 'Last live comment' }],
    deletedCommentIds: Array.from({ length: 999 }, (_, i) => `ic-deleted${String(i).padStart(4, '0')}`) } };
  const reviewContext = vm.createContext({ storageMode: () => 'memory', memLoad() {}, memSave() {}, mem: { rows: [historyRow] } });
  vm.runInContext(update, reviewContext);
  assert.equal((await vm.runInContext("updateReview('in-history', {comment:{id:'ic-new00001',by:'lead@example.com',text:'Over the bound'}})", reviewContext)).status, 409);
  assert.equal((await vm.runInContext("updateReview('in-history', {deleteComment:'ic-last0001'})", reviewContext)).row.review.comments.length, 0, 'deletion remains available at the history bound');
  assert.equal(historyRow.review.deletedCommentIds.length, 1000);
  assert.equal((await vm.runInContext("updateReview('in-history', {comment:{id:'ic-deleted0000',by:'lead@example.com',text:'Late retry'}})", reviewContext)).status, 409, 'oldest tombstones are never evicted');
  console.log('PASS: comment deletion authorization, concurrent reviews, retry safety, bounded tombstones and archive immutability');

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
  run("UI.interest.rows[0].review = { flagged: true, comments: [{ text: 'Review' }] }; UI.interestFilter = 'flagged'");
  assert.equal(run('interestVisible().length'), 1);
  run("UI.interestFilter = 'comments'");
  assert.equal(run('interestVisible().length'), 1);
  run("UI.interestQuery = 'no match'");
  assert.equal(run('interestVisible().length'), 0, 'search and review filters combine');
  run("UI.interestArchiveView = { id: 'ar-test', archive: { rows: [] } }");
  assert.equal(run('interestSelection().size'), 0, 'archive has a separate selection');
  assert.equal(run('interestEmailsCsv([\'a,"b@example.com\'])'), '"a,""b@example.com"');
  console.log('PASS: selection persistence, year sorting, deduplication, CSV escaping, stale records and archive isolation');
}
