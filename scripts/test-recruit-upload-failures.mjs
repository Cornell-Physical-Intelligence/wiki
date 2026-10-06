// Route-level failures: no real DB, Blob store, applicant, or email.
import assert from 'node:assert/strict';
import site from '../lib/recruit/modules/site.js';

const submit = site.routes.find(r => r.method === 'POST').handler;
const cycle = { id: 'cy-test', status: 'open', doc: { site: { sections: { round: {
  title: 'Upload test', open: true, notify: false, form: { questions: [
    { key: 'name', type: 'short', required: true }, { key: 'email', type: 'email', required: true },
    { key: 'photo', type: 'file' },
  ] },
} } } } };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const body = { answers: { name: 'Test', email: 'test@example.test' }, files: { photo: { name: 'test.png', type: 'image/png', data: png.toString('base64') } } };
async function run({ journalFails = false, dbFails = false, outcome = 'saved', website = '', completeFails = false } = {}) {
  const calls = [], records = new Map();
  const journal = {
    async append(entry, files) {
      calls.push('append');
      if (journalFails) throw new Error('Synthetic Blob outage');
      assert.deepEqual(files[0].data, png);
      records.set(entry.id, structuredClone(entry));
      return true;
    },
    async complete(id, result) { calls.push(result); if (completeFails) throw new Error('Synthetic completion outage'); assert.ok(records.has(id)); },
  };
  const kit = {
    now: () => 1790000000000,
    cycles: { intakeTarget: async () => ({ cycleId: cycle.id }), get: async () => cycle },
    intake: { journal: async () => journal },
    apps: { async commitIntake(_cycle, entry, _journal, files) {
      calls.push('commit');
      assert.deepEqual(files[0].data, png);
      assert.equal(entry.files[0].size, png.length);
      if (dbFails) throw new Error('Synthetic attachment write failure');
      return { outcome };
    } },
  };
  try { return { response: await submit({ params: { section: 'round' }, body: async () => ({ ...body, website }) }, kit), calls, records }; }
  catch (error) { return { error, calls, records }; }
}
for (const options of [{}, { journalFails: true }, { completeFails: true }]) {
  const { response } = await run(options);
  assert.equal(response.status, 200);
  assert.match(response.body.receipt, /^jr-\d{13}-[a-f0-9]{24}$/);
}
const queued = await run({ dbFails: true });
assert.equal(queued.response.status, 202);
assert.equal(queued.response.body.queued, true);
assert.ok(queued.records.has(queued.response.body.receipt), 'queued success has a durable backup');
assert.deepEqual(queued.calls, ['append', 'commit'], 'failed attachment writes stay pending for recovery');
assert.equal((await run({ dbFails: true, journalFails: true })).error.status, 503);
const superseded = await run({ outcome: 'superseded' });
assert.equal(superseded.error.status, 409);
assert.equal(superseded.error.code, 'SUBMISSION_SUPERSEDED');
assert.deepEqual(superseded.calls, ['append', 'commit', 'superseded']);
assert.equal((await run({ outcome: 'unknown' })).error.status, 503);
assert.equal((await run({ outcome: 'held' })).error.status, 409);
assert.equal((await run({ outcome: 'review' })).response.status, 409);
const honeypot = await run({ website: 'autofilled.example' });
assert.equal(honeypot.response.body.receipt, undefined, 'honeypot suppression never supplies a saved receipt');
assert.deepEqual(honeypot.calls, []);
console.log('PASS: durable receipts, attachment-write outages, complete-marker outages, superseded submissions, unknown outcomes, and honeypot responses');

/* ---- no single failing store loses a submission ---- */
const siteGet = site.routes.find(r => r.method === 'GET').handler;
const quietErrors = [];
const realError = console.error;
console.error = (...args) => { quietErrors.push(args.map(String).join(' ')); };
async function harden({ journalFails = false, dbFails = false, emailFails = false, offline = false, saved = null, intake = undefined, appendLimits = [] } = {}) {
  const calls = [], mails = [], sites = [];
  const live = intake ? { ...cycle, version: 7, doc: { ...cycle.doc, intake } } : { ...cycle, version: 7 };
  const journal = {
    async append(entry, files, limits) { calls.push('append'); appendLimits.push(limits); if (journalFails) throw new Error('Synthetic Blob outage'); return true; },
    async complete(id, result) { calls.push(result); },
    async saveSite(snapshot) { sites.push(snapshot); return true; },
    async loadSite() { return saved; },
  };
  const kit = {
    now: () => 1790000000000,
    store: { cache: new Map() },
    cycles: {
      intakeTarget: async () => { if (offline) throw new Error('Synthetic Neon outage'); return { cycleId: live.id }; },
      get: async () => live,
    },
    intake: { journal: async () => journal },
    email: {
      settings: async () => ({ key: 're_test' }),
      send: async (msg) => { mails.push(msg); return emailFails ? { sent: false, reason: 'Synthetic Resend outage' } : { sent: true, id: 'em_1' }; },
    },
    apps: {
      async commitIntake() { calls.push('commit'); if (dbFails) throw new Error('Synthetic Neon outage'); return { outcome: 'saved' }; },
      async count() { return 0; },
    },
  };
  const rq = { params: { section: 'round' }, body: async () => ({ ...body }) };
  try { return { response: await submit(rq, kit), calls, mails, sites, kit }; }
  catch (error) { return { error, calls, mails, sites, kit }; }
}
{
  const clean = await harden();
  assert.equal(clean.response.status, 200);
  assert.equal(clean.mails.length, 0, 'two copies need no email');
  assert.equal(clean.sites.length, 1, 'the cycle is kept for an outage');
  assert.deepEqual(clean.sites[0].cycle.doc.site, cycle.doc.site);

  const noJournal = await harden({ journalFails: true });
  assert.equal(noJournal.response.status, 200, 'the database alone still saves it');
  assert.equal(noJournal.mails.length, 1, 'and the email is its second copy');
  assert.equal(noJournal.mails[0].attachments[0].filename, 'test.png');
  assert.equal(Buffer.from(noJournal.mails[0].attachments[0].content, 'base64').length, png.length, 'with the file bytes');
  assert.ok(noJournal.mails[0].to.includes('cuphysint@cornell.edu'));
  assert.match(noJournal.mails[0].html, /test@example\.test/);

  const noDb = await harden({ dbFails: true });
  assert.equal(noDb.response.status, 202, 'a journaled submission is accepted while the database fails');
  assert.equal(noDb.response.body.queued, true);
  assert.equal(noDb.mails.length, 1, 'and the team hears about it with a copy');
  assert.match(noDb.mails[0].html, /Database<\/b>: not saved/);
  assert.equal(noDb.mails[0].clientId, null, 'never refreshes a stored OAuth token while the database is down');
  assert.equal(noDb.mails[0].settings, null);

  const emailOnly = await harden({ dbFails: true, journalFails: true });
  assert.equal(emailOnly.response.status, 202, 'the email alone still keeps it');
  assert.match(emailOnly.response.body.receipt, /^jr-\d{13}-[a-f0-9]{24}$/);

  quietErrors.length = 0;
  const nothing = await harden({ dbFails: true, journalFails: true, emailFails: true });
  assert.equal(nothing.error.status, 503, 'with no copy anywhere the applicant is told, and keeps their draft');
  assert.ok(quietErrors.some((line) => line.includes('NOT SAVED') && line.includes('test@example.test')), 'and the answers reach the server log');

  const savedCycle = { cycle: { ...cycle, version: 7 }, savedAt: 1 };
  const offline = await harden({ offline: true, saved: savedCycle });
  assert.equal(offline.response.status, 202, 'a database outage before the write still journals the submission');
  assert.deepEqual(offline.calls, ['append'], 'without touching the database');
  assert.equal(offline.mails.length, 1);
  const offlineFeed = await siteGet({}, offline.kit);
  assert.equal(offlineFeed.status, 200, 'and the form still loads');
  assert.equal(offlineFeed.body.sections[0].available, true);
  const closedOffline = await harden({ offline: true, saved: { cycle: null } });
  assert.equal(closedOffline.error.status, 409, 'a saved "nothing receives the website" stays closed');
  const blind = await harden({ offline: true, saved: null });
  assert.match(blind.error.message, /Neon/, 'with no saved cycle the outage surfaces');

  const limits = [];
  await harden({ intake: { perIpHour: 5, perDay: 2000 }, appendLimits: limits });
  assert.deepEqual(limits[0], { perIpHour: 120, perDay: 10000 }, 'old low limits stored on a cycle are raised');

  const once = await harden();
  await submit({ params: { section: 'round' }, body: async () => ({ ...body }) }, once.kit);
  assert.equal(once.sites.length, 1, 'the cycle is saved once per version, not per request');
  let attempts = 0;
  const failing = await harden();
  failing.kit.store.cache.clear();
  (await failing.kit.intake.journal()).saveSite = async () => { attempts += 1; throw new Error('Synthetic Blob outage'); };
  for (let i = 0; i < 3; i++) await submit({ params: { section: 'round' }, body: async () => ({ ...body }) }, failing.kit);
  assert.equal(attempts, 1, 'a failing save is not retried on every request');
}
console.error = realError;
console.log('PASS: journal outage emails a second copy, database outage journals and emails, email-only fallback, last-resort log, outage feed and submissions from the saved cycle, raised spam limits');
