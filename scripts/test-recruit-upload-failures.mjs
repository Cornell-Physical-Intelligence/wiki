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
assert.match(honeypot.response.body.receipt, /^jr-\d{13}-[a-f0-9]{24}$/, 'a filled spam trap is saved like any submission');
assert.deepEqual(honeypot.calls.slice(0, 2), ['append', 'commit']);
assert.equal(honeypot.records.get(honeypot.response.body.receipt).trap, 'autofilled.example', 'its journal entry says the trap was filled');
console.log('PASS: durable receipts, attachment-write outages, complete-marker outages, superseded submissions, unknown outcomes, and filled spam traps');

/* ---- no single failing store loses a submission ---- */
const siteGet = site.routes.find(r => r.method === 'GET').handler;
const { LIMIT } = await import('../lib/recruit/modules/site.js');
const never = () => new Promise(() => {});
const quietErrors = [];
const realError = console.error;
console.error = (...args) => { quietErrors.push(args.map(String).join(' ')); };
async function harden({ journalFails = false, dbFails = false, emailFails = false, offline = false, saved = null, intake = undefined, appendLimits = [], dbHangs = false, readHangs = false, outcome = 'saved', existing = null, answers = {} } = {}) {
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
      intakeTarget: async () => { if (offline) throw new Error('Synthetic Neon outage'); if (readHangs) return never(); return { cycleId: live.id }; },
      get: async () => live,
    },
    intake: { journal: async () => journal },
    email: {
      settings: async () => ({ key: 're_test' }),
      send: async (msg) => { mails.push(msg); return emailFails ? { sent: false, reason: 'Synthetic Resend outage' } : { sent: true, id: 'em_1' }; },
    },
    apps: {
      async commitIntake() { calls.push('commit'); if (dbFails) throw new Error('Synthetic Neon outage'); if (dbHangs) return never(); return { outcome, existing }; },
      async count() { return 0; },
    },
  };
  const rq = { params: { section: 'round' }, body: async () => ({ ...body, answers: { ...body.answers, ...answers } }) };
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
  assert.equal(noJournal.mails[0].attachments[0].filename, 'photo-1.png', 'attachments are named by the form, never by the applicant');
  assert.equal(noJournal.mails[0].attachments[0].content_type, 'image/png');
  assert.match(noJournal.mails[0].html, /test\.png \(attached as photo-1\.png\)/);
  assert.match(noJournal.mails[0].html, /second copy/);
  assert.equal(Buffer.from(noJournal.mails[0].attachments[0].content, 'base64').length, png.length, 'with the file bytes');
  assert.ok(noJournal.mails[0].to.includes('cuphysint@cornell.edu'));
  assert.match(noJournal.mails[0].html, /test@example\.test/);

  const noDb = await harden({ dbFails: true });
  assert.equal(noDb.response.status, 202, 'a journaled submission is accepted while the database fails');
  assert.equal(noDb.response.body.queued, true);
  assert.equal(noDb.mails.length, 1, 'and the team hears about it with a copy');
  assert.match(noDb.mails[0].html, /Database<\/b>: no answer/);
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
  assert.equal(offlineFeed.body.offline, true, 'saying it came from the saved copy, for the monitor');
  assert.equal(offlineFeed.body.sections[0].available, true);
  const closedOffline = await harden({ offline: true, saved: { cycle: null } });
  assert.equal(closedOffline.error.status, 409, 'a saved "nothing receives the website" stays closed');
  const blind = await harden({ offline: true, saved: null });
  assert.equal(blind.response.status, 202, 'with no saved cycle either, the team still gets the submission by email');
  assert.equal(blind.mails.length, 1);
  assert.match(blind.mails[0].subject, /^Backup copy: round from /);
  assert.equal(blind.mails[0].attachments[0].content_type, 'image/png', 'with the files whose bytes are an image or a PDF');
  const lost = await harden({ offline: true, saved: null, emailFails: true });
  assert.equal(lost.error.status, 503, 'and when the email fails too, the applicant is told to try again');

  const limits = [];
  await harden({ intake: { perIpHour: 5, perDay: 2000 }, appendLimits: limits });
  assert.deepEqual(limits[0], { perIpHour: 600 }, 'an old low limit stored on a cycle is raised');

  const once = await harden();
  await submit({ params: { section: 'round' }, body: async () => ({ ...body }) }, once.kit);
  assert.equal(once.sites.length, 1, 'the cycle is saved once per version, not per request');
  let attempts = 0;
  const failing = await harden();
  failing.kit.store.cache.clear();
  (await failing.kit.intake.journal()).saveSite = async () => { attempts += 1; throw new Error('Synthetic Blob outage'); };
  for (let i = 0; i < 3; i++) await submit({ params: { section: 'round' }, body: async () => ({ ...body }) }, failing.kit);
  assert.equal(attempts, 1, 'a failing save is not retried on every request');

  // A database that hangs is treated like one that fails.
  const saveLimits = { ...LIMIT };
  Object.assign(LIMIT, { read: 30, write: 30 });
  const hungRead = await harden({ readHangs: true, saved: savedCycle });
  assert.equal(hungRead.response.status, 202, 'a hung read falls back to the saved cycle and journals');
  assert.deepEqual(hungRead.calls, ['append']);
  const hungWrite = await harden({ dbHangs: true });
  assert.equal(hungWrite.response.status, 202, 'a hung write still answers, from the journal');
  assert.equal(hungWrite.mails.length, 1);
  Object.assign(LIMIT, saveLimits);

  // Email holds the only copy: the log keeps a trace too.
  quietErrors.length = 0;
  await harden({ dbFails: true, journalFails: true });
  assert.ok(quietErrors.some((line) => line.includes('EMAIL ONLY') && line.includes('test@example.test')));

  // The database refusing a journal-less submission says so in the email.
  const refused = await harden({ journalFails: true, outcome: 'review', existing: { ts: 1, answers: {}, files: [] } });
  assert.equal(refused.response.status, 409);
  assert.match(refused.mails[0].html, /NOT in the wiki/);

  // A resend of exactly what is saved never waits in the queue as a duplicate.
  const resend = await harden({ outcome: 'review', existing: { ts: 1, name: 'Test', answers: {}, files: [{ question: 'photo', size: png.length }] } });
  assert.ok(resend.calls.includes('review'), 'the duplicate receipt is marked done');
  const changed = await harden({ outcome: 'review', existing: { ts: 1, name: 'Test', answers: { note: 'old' }, files: [{ question: 'photo', size: png.length }] } });
  assert.ok(!changed.calls.includes('review'), 'a real correction stays in the queue for the team');
}
console.error = realError;
console.log('PASS: journal outage emails a second copy, database outage journals and emails, email-only fallback, last-resort log, outage feed and submissions from the saved cycle, raised spam limits');

/* ---- answers the database can always store ---- */
{
  const { validateAnswers } = await import('../lib/recruit/fixed-form.js');
  const form = { questions: [
    { key: 'name', type: 'short', required: true, max: 100 }, { key: 'email', type: 'email', required: true },
    { key: 'why', type: 'long', max: 5 }, { key: 'bio', type: 'short', max: 3 }, { key: 'photo', type: 'file' },
  ] };
  const v = validateAnswers(form, { answers: { name: 'Ann\u0000a', email: 'a@cornell.edu\u0000', why: 'abcd😀xyz', bio: 'ab\uD83D' }, files: { photo: { name: 'pic\u0000\uD83D.png', type: 'image/png', data: png.toString('base64') } } });
  assert.equal(v.error, undefined, v.error);
  assert.equal(v.columns.name, 'Anna', 'a NUL character is dropped, not refused');
  assert.equal(v.columns.email, 'a@cornell.edu');
  assert.equal(v.answers.why, 'abcd', 'an emoji cut at the length limit is dropped whole');
  assert.equal(v.answers.bio, 'ab\uFFFD', 'a stray half emoji in the input becomes a replacement character');
  assert.ok(!/\\u0000|\\ud8[0-9a-f]{2}(?!\\\\udc)/i.test(JSON.stringify(v.answers) + JSON.stringify(v.files.map((f) => f.name))), 'nothing Postgres would refuse');
  console.log('PASS: NUL characters and half emoji never reach the database');
}

/* ---- queued submissions replay on their own; a filled spam trap is kept and flagged ---- */
{
  const realErr = console.error; console.error = () => {};
  const marks = new Set(), done = [], committed = [], reviews = [];
  const entry = { id: 'jr-1790000000000-0123456789abcdef01234567', ts: 1790000000000, cycleId: cycle.id, section: 'round', email: 'q@example.test', name: 'Queued', answers: {}, version: 2, files: [], trap: 'https://autofill.example' };
  const journal = {
    async append() { return true; },
    async complete(id, outcome) { done.push([id, outcome]); },
    async saveSite() { return true; }, async loadSite() { return null; },
    async markRetry(id) { marks.add(id); return true; },
    async listRetry() { return [...marks]; },
    async clearRetry(id) { marks.delete(id); },
    async getEntry(id) { return id === entry.id ? entry : null; },
  };
  let dbDown = true;
  const kit = {
    now: () => 1790000000000, store: { cache: new Map() },
    cycles: { intakeTarget: async () => ({ cycleId: cycle.id }), get: async () => cycle },
    intake: { journal: async () => journal, commit: async (e) => { committed.push(e.id); return { outcome: 'saved', inserted: true, row: { id: 'in-1', email: e.email, name: e.name, answers: {} } }; } },
    email: { settings: async () => null, send: async () => ({ sent: true }) },
    apps: { async commitIntake(_c, e) { if (dbDown) throw new Error('Synthetic Neon outage'); return { outcome: 'saved', inserted: true, row: { id: 'in-2', email: e.email, name: e.name, answers: e.answers } }; }, async count() { return 0; } },
    people: { async updateReview(_cycle, email, _name, change) { reviews.push([email, change]); return { row: {} }; } },
    audit: async () => ({}), esc: (v) => String(v ?? ''),
  };
  const queued = await submit({ params: { section: 'round' }, body: async () => ({ ...body }) }, kit);
  assert.equal(queued.status, 202);
  assert.equal(marks.size, 1, 'a submission journaled during an outage is marked for replay');
  marks.clear(); marks.add(entry.id);
  dbDown = false;
  await siteGet({}, kit);
  assert.deepEqual(committed, [entry.id], 'the next feed load puts it into the database');
  assert.deepEqual(done.at(-1), [entry.id, 'saved']);
  assert.equal(marks.size, 0, 'and stops retrying it');
  assert.deepEqual(reviews.map(([email, change]) => [email, Boolean(change.flag?.flagged), /spam-trap/.test(change.comment?.text || '')]), [['q@example.test', true, false], ['q@example.test', false, true]], 'a replayed spam-trap submission flags the person too');
  reviews.length = 0;
  marks.add(entry.id);
  await siteGet({}, kit);
  assert.equal(committed.length, 1, 'at most once a minute per instance');
  marks.clear();

  const trapped = await submit({ params: { section: 'round' }, body: async () => ({ ...body, answers: { ...body.answers }, hp_8c1f: 'https://autofill.example' }) }, kit);
  assert.equal(trapped.status, 200);
  assert.match(trapped.body.receipt, /^jr-\d{13}-[a-f0-9]{24}$/, 'a filled trap gets a receipt like any submission');
  assert.equal(reviews.length, 2, 'and flags the person with a comment');
  assert.equal(reviews[0][0], 'test@example.test');
  console.error = realErr;
  console.log('PASS: queued submissions replay from the feed once the database answers; spam-trap submissions are kept and flagged');
}

/* ---- a replay that keeps failing waits, and the ones behind it still go in ---- */
{
  const realErr = console.error; console.error = () => {};
  const stuck = 'jr-1790000000001-0123456789abcdef01234567', fine = 'jr-1790000000002-0123456789abcdef01234567';
  const marks = new Set([stuck, fine]), tried = [];
  const entryOf = (id) => ({ id, ts: 1790000000000, cycleId: cycle.id, section: 'round', email: `${id.slice(-4)}@example.test`, name: 'Queued', answers: {}, version: 2, files: [] });
  const journal = {
    async saveSite() { return true; }, async loadSite() { return null; },
    async listRetry() { return [...marks]; }, async clearRetry(id) { marks.delete(id); },
    async getEntry(id) { return entryOf(id); }, async complete() {},
  };
  const cache = new Map();
  const kit = {
    now: () => 1790000000000, store: { cache },
    cycles: { intakeTarget: async () => ({ cycleId: cycle.id }), get: async () => cycle },
    intake: { journal: async () => journal, commit: async (e) => { tried.push(e.id); if (e.id === stuck) throw new Error('Synthetic attachment not ready'); return { outcome: 'saved' }; } },
    apps: { async count() { return 0; } },
  };
  await siteGet({}, kit);
  assert.deepEqual(tried, [stuck, fine], 'a failing entry does not stop the one behind it');
  assert.deepEqual([...marks], [stuck], 'only the failing one waits');
  cache.delete('site.retry');
  await siteGet({}, kit);
  assert.deepEqual(tried, [stuck, fine], 'and it waits a while before the next try');
  console.error = realErr;
  console.log('PASS: a replay that keeps failing backs off without holding back the queue');
}

/* ---- real-world files and forms edited while applicants fill them ---- */
{
  const { validateAnswers } = await import('../lib/recruit/fixed-form.js');
  const form = { questions: [{ key: 'name', type: 'short', required: true }, { key: 'email', type: 'email', required: true }, { key: 'added', type: 'long', required: true }, { key: 'pick', type: 'single', required: true, options: ['A'] }, { key: 'photo', type: 'file' }] };
  const base = { name: 'N', email: 'n@cornell.edu', pick: 'A' };
  assert.equal(validateAnswers(form, { answers: base }).error, undefined, 'a required question the page never showed does not refuse the applicant');
  assert.equal(validateAnswers(form, { answers: { ...base, added: '' } }).error, 'added is required', 'one the page showed is still required');
  const fileForm = { questions: [...form.questions.slice(0, 2), { key: 'resume', type: 'file', required: true }] };
  assert.equal(validateAnswers(fileForm, { answers: base, shown: ['name', 'email'] }).error, undefined, 'a required file question the page never showed does not refuse the applicant');
  assert.equal(validateAnswers(fileForm, { answers: base, shown: ['name', 'email', 'resume'] }).error, 'Attach a file for resume', 'one the page showed is still required');
  assert.equal(validateAnswers(fileForm, { answers: base }).error, 'Attach a file for resume', 'without the list of shown questions, a file question is checked');
  const pickForm = { questions: [...form.questions.slice(0, 2), { key: 'year', type: 'single', required: true, options: ['First-year'] }, { key: 'site', type: 'link' }, { key: 'essay', type: 'long' }] };
  const picked = validateAnswers(pickForm, { answers: { ...base, email: 'n\u200b@cornell.edu', year: 'Freshman', site: 'github.com/me', essay: 'e'.repeat(1500) }, shown: ['name', 'email', 'year', 'site', 'essay'] });
  assert.equal(picked.error, undefined, 'an option renamed while the page was open is kept as the applicant picked it');
  assert.deepEqual([picked.columns.email, picked.answers.year, picked.answers.site, picked.answers.essay.length], ['n@cornell.edu', 'Freshman', 'https://github.com/me', 1500], 'invisible characters leave the email, a bare domain gets https://, a long answer keeps 1,500 characters');
  assert.equal(validateAnswers(pickForm, { answers: { ...base, year: 'Freshman' } }).error, 'Choose one of the options for year', 'a client that does not say what it showed is held to the current options');
  assert.equal(validateAnswers(pickForm, { answers: { ...base, year: 'First-year', site: 'https://a.com https://b.com' }, shown: ['name', 'email', 'year', 'site'] }).error, 'Give one link for site');
  const linkRequired = { questions: [...form.questions.slice(0, 2), { key: 'site', type: 'link', required: true }] };
  for (const none of ['N/A', 'n/a', 'none', 'NA']) assert.equal(validateAnswers(linkRequired, { answers: { ...base, site: none } }).answers?.site, none, `"${none}" answers a required link question`);
  const withFile = (bytes, type, name = 'f') => validateAnswers(form, { answers: { ...base, added: 'x' }, files: { photo: { name, type, data: Buffer.from(bytes).toString('base64') } } });
  const phoneJpeg = Buffer.concat([Buffer.from([255, 216, 255, 225]), Buffer.alloc(64), Buffer.from([255, 217]), Buffer.from('MotionPhoto_Data trailer')]);
  assert.equal(withFile(phoneJpeg, 'image/jpeg').files[0].type, 'image/jpeg', 'a phone photo with data after its end marker is accepted');
  const paddedPdf = Buffer.concat([Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF\n'), Buffer.alloc(3000)]);
  assert.equal(withFile(paddedPdf, 'application/pdf').files[0].type, 'application/pdf', 'a PDF padded after %%EOF is accepted');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(24)]);
  assert.equal(withFile(webp, 'image/jpeg').files[0].type, 'image/webp', 'an image named for the wrong type is taken as what it is');
  assert.match(withFile('<html><script>alert(1)</script>', 'image/png').error, /does not match/, 'a page posing as an image is still refused');
  console.log('PASS: phone photos, padded PDFs and mislabelled images are accepted; questions added after the page loaded never refuse');
}
