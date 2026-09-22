// The website module: what the club site reads and where it posts. Memory
// mode in a temp copy of lib/, an in-memory journal, no network, no keys.
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

function fakeJournal() {
  const records = new Map(), files = new Map(), done = new Map();
  return {
    records, files, done, appendOptions: null,
    enabled: () => true,
    async check() { return { ok: true }; },
    async append(entry, file, options) { this.appendOptions = options || null; records.set(entry.id, structuredClone(entry)); if (Array.isArray(file)) file.forEach((f, i) => files.set(entry.id + ':' + i, Buffer.from(f.data))); else if (file) files.set(entry.id, Buffer.from(file.data)); return true; },
    async listPending() { return [...records.values()].filter((e) => !done.has(e.id)).sort((a, b) => a.ts - b.ts); },
    async getEntry(id) { return records.get(id) ? structuredClone(records.get(id)) : null; },
    async getFile(id, index = null) { return files.get(index === null ? id : id + ':' + index) || null; },
    async complete(id, outcome) { done.set(id, outcome); },
    async forget(id) { records.delete(id); files.delete(id); },
  };
}

if (!process.env.RECRUIT_SITE_TEST_ROOT) {
  const dir = await mkdtemp(join(tmpdir(), 'cupi-recruit-site-'));
  try {
    await cp(new URL('../lib', import.meta.url), join(dir, 'lib'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { PATH: process.env.PATH, DEV_FAKE_AUTH: 'admin@example.com', RECRUIT_SITE_TEST_ROOT: dir }, stdio: 'inherit' });
    process.exitCode = result.status || (result.error ? 1 : 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
} else {
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ id: 'em-1' }), text: async () => '' }; };
  const root = process.env.RECRUIT_SITE_TEST_ROOT;
  const lib = (p) => import(pathToFileURL(join(root, 'lib', p)));
  let clock = 1789600000000;
  Date.now = () => clock;
  const users = [{ email: 'admin@example.com', name: 'Ada Admin', role: 'admin', status: 'active' }, { email: 'plain@example.com', name: 'Pat Plain', role: 'member', status: 'active' }];
  await writeFile(join(root, '.devdata.json'), JSON.stringify({ state: { users, pages: [], trash: [], activity: [], settings: {} }, version: 1, prefs: {}, files: [] }));
  await writeFile(join(root, '.devinterest.json'), JSON.stringify({ rows: [
    { id: 'in-legacy', ts: 1000, updated: 1000, name: 'Legacy Applicant', email: 'legacy@example.com', subteam: 'Software', project: 'Existing answer', cornell: false, year: null, ipHash: 'h1', fileId: null, fileName: null, fileType: null, fileSize: null },
  ], events: [], archives: [], receipts: {} }));

  const { handleInterest } = await lib('interest.js');
  const { createRecruit } = await lib('recruit/registry.js');
  const { SECTION_KEYS, defaultSections, validateSite } = await lib('recruit/sections.js');
  const mods = await Promise.all(['cycles', 'applications', 'people', 'roles', 'site'].map(async (m) => (await lib(`recruit/modules/${m}.js`)).default));
  const R = createRecruit(mods);
  const journal = fakeJournal();
  const admin = users[0], plain = users[1];
  const emailSettings = async () => ({ key: 're_test', from: 'wiki@example.com', name: 'Wiki' });
  let n = 0;
  const ctxFor = (me) => ({ readJson: null, me: async () => me, journal, host: 'wiki.test', clientId: null, saveOauth: async () => {}, session: () => ({}), emailSettings });
  async function call(handler, method, path, body, me, origin = 'https://cornellphysicalintelligence.com') {
    clock += 10;
    const req = { method, url: path, headers: { origin, 'content-type': 'application/json', 'x-real-ip': `site-${++n}` } };
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(v) { this.body = v; } };
    await handler(req, res, path.split('?')[0], { ...ctxFor(me), readJson: async () => body });
    return { status: res.statusCode, headers: res.headers, text: res.body, data: res.headers['content-type'] === 'application/json' ? JSON.parse(res.body) : null };
  }
  const recruit = (method, path, body = {}, me = admin) => call(R.handleRecruit, method, path, body, me);
  const anon = (method, path, body = {}, origin) => call(R.handleRecruit, method, path, body, null, origin);
  const interest = (method, path, body = {}, me = admin) => call((req, res, p, ctx) => handleInterest(req, res, p, { ...ctx, intake: R.intakeBridge }), method, path, body, me);
  let rq = 0;
  const requestId = () => `rq-site-${String(++rq).padStart(6, '0')}`;

  /* ---- pure helpers ---- */
  const d = defaultSections();
  assert.deepEqual(Object.keys(d), SECTION_KEYS);
  assert.equal(d.interest.open, true); assert.equal(d.coffee.open, false); assert.equal(d.application.open, false);
  assert.deepEqual(d.interest.form.questions.map((q) => q.key), ['name', 'email', 'subteam', 'year', 'project', 'file'], 'the interest form is the fixed form');
  assert.throws(() => validateSite({ sections: { interest: { form: { questions: [{ key: 'name', type: 'short', label: 'Name' }] } } } }), /email question cannot be removed/, 'the interest form keeps the website questions');
  assert.throws(() => validateSite({ sections: { coffee: { form: { questions: [{ key: 'name', type: 'short', label: 'Name' }] } } } }), /email question cannot be removed/, 'every section needs name and email');
  const merged = validateSite({ sections: { coffee: { open: true, title: '  Coffee  chats ', form: { questions: [{ key: 'name', type: 'short', label: 'Name', required: true }, { key: 'email', type: 'email', label: 'Email', required: true }, { key: 'when', type: 'long', label: 'When?', required: true, max: 500 }] } } } });
  assert.equal(merged.sections.coffee.open, true); assert.equal(merged.sections.coffee.title, 'Coffee chats');
  assert.deepEqual(merged.sections.coffee.form.questions.map((q) => q.key), ['name', 'email', 'when']);
  assert.equal(merged.sections.application.open, false, 'untouched sections keep their defaults');
  console.log('PASS: sections helper — three sections, fixed interest questions, per-section validation and merge');

  /* ---- before a cycle receives the website: the site sees nothing open ---- */
  const before = await anon('GET', '/recruit/site');
  assert.equal(before.status, 200); assert.equal(before.data.cycle, null); assert.equal(before.data.landing, null);
  assert.deepEqual(before.data.sections, [], 'with no receiving cycle the website shows applications closed');
  assert.equal(before.headers['cache-control'], 'no-store');
  assert.equal(before.headers['access-control-allow-origin'], 'https://cornellphysicalintelligence.com');
  assert.equal((await anon('GET', '/recruit/site', {}, 'https://evil.example')).status, 403, 'other origins are refused');
  assert.equal((await anon('POST', '/recruit/site/coffee', { answers: { name: 'X', email: 'x@cornell.edu' } })).status, 409, 'no cycle receives the site yet');
  assert.equal((await anon('POST', '/recruit/site/bogus', {})).status, 409, 'before a cycle receives the website, every form answers not open');
  console.log('PASS: before a cycle receives the website, the site sees nothing open and every form answers not open');

  /* ---- import, then the live cycle publishes its sections ---- */
  assert.equal((await recruit('POST', '/recruit/migrate', { requestId: requestId(), step: 'live' })).status, 200);
  const cycles = (await recruit('GET', '/recruit/cycles')).data;
  const live = cycles.cycles.find((c) => c.id === 'cy-interest');
  assert.ok(live, 'the current list became a cycle'); assert.equal(cycles.intakeCycleId, 'cy-interest');
  assert.match(live.name, /^(Fall|Spring) \d{4}$/, 'named for the term, not "Interest list"');
  assert.equal(live.counts.bySection.interest, 1, 'the imported rows are interest submissions');
  const detail = (await recruit('GET', '/recruit/cycles/cy-interest')).data;
  assert.deepEqual(Object.keys(detail.sections), SECTION_KEYS, 'the cycle carries its sections');
  const site1 = (await anon('GET', '/recruit/site')).data;
  assert.equal(site1.cycle.id, 'cy-interest');
  assert.deepEqual(site1.sections.map((s) => [s.key, s.open]), [['interest', true], ['coffee', false], ['application', false]]);
  assert.ok(site1.sections.every((s) => !('settings' in s) && s.form.questions.every((q) => !('system' in q))), 'the public shape carries no settings');
  assert.deepEqual(site1.sections[0].form.questions.find((q) => q.key === 'subteam').options, ['Mechanical', 'Electrical', 'Software', 'Creative', 'Business & Marketing']);
  assert.equal((await anon('POST', '/recruit/site/coffee', { answers: { name: 'X', email: 'x@cornell.edu', availability: 'Tue' } })).status, 409, 'a closed section refuses submissions');

  /* ---- open coffee chats with an extra question, from Settings ---- */
  const version = detail.cycle.version;
  const put = await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version, settings: { sections: { coffee: { open: true, notifyTo: ['team@cornell.edu'], form: { questions: [
    { key: 'name', type: 'short', label: 'Name', required: true }, { key: 'email', type: 'email', label: 'Email', required: true },
    { key: 'subteam', type: 'single', label: 'Subteam', options: ['Mechanical', 'Software'] }, { key: 'availability', type: 'long', label: 'When are you free?', required: true, max: 400 },
    { key: 'snack', type: 'single', label: 'Snack', options: ['Coffee', 'Tea'] },
  ] } } } } });
  assert.equal(put.status, 200, put.text);
  assert.equal((await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: put.data.cycle.version, settings: { sections: { coffee: { form: { questions: [{ key: 'email', type: 'email', label: 'E' }] } } } } })).status, 400, 'a form without a name question is refused');
  assert.equal((await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: put.data.cycle.version, settings: { sections: { coffee: { open: false } } } }, plain)).status, 403, 'members cannot edit sections');
  const site2 = (await anon('GET', '/recruit/site')).data;
  const coffee = site2.sections.find((s) => s.key === 'coffee');
  assert.equal(coffee.open, true);
  assert.deepEqual(coffee.form.questions.map((q) => q.key), ['name', 'email', 'subteam', 'availability', 'snack']);
  assert.equal(site2.landing, 'interest', 'with no choice, /apply shows the first open form');
  assert.equal((await anon('POST', '/recruit/site/bogus', { answers: { name: 'X', email: 'x@cornell.edu' } })).status, 404, 'a form the cycle does not have is not a route');
  const v1b = (await recruit('GET', '/recruit/cycles/cy-interest')).data.cycle.version;
  assert.equal((await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: v1b, settings: { sections: {}, landing: 'nope' } })).status, 400, 'the /apply form must be one of the three');
  const chose = await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: v1b, settings: { sections: {}, landing: 'coffee' } });
  assert.equal(chose.status, 200, chose.text);
  assert.equal(chose.data.cycle.doc.site.landing, 'coffee');
  assert.equal((await anon('GET', '/recruit/site')).data.landing, 'coffee', 'the chosen form is what /apply shows');
  assert.deepEqual((await anon('GET', '/recruit/site')).data.sections.find((s) => s.key === 'coffee').form.questions.map((q) => q.key), ['name', 'email', 'subteam', 'availability', 'snack'], 'choosing the /apply form leaves the sections alone');
  assert.deepEqual(coffee.form.questions.find((q) => q.key === 'subteam').options, ['Mechanical', 'Software'], 'saved subteam options belong to the form');
  console.log('PASS: the live cycle publishes its sections; Settings opens a section and shapes its form; members are refused');

  /* ---- submissions from the site ---- */
  assert.equal((await anon('POST', '/recruit/site/coffee', { answers: { name: 'Bot', email: 'b@cornell.edu' }, website: 'http://spam' })).status, 200, 'honeypot answers 200 and stores nothing');
  const missing = await anon('POST', '/recruit/site/coffee', { answers: { name: 'Cam Chat', email: 'cam@cornell.edu' } });
  assert.equal(missing.status, 400); assert.match(missing.data.error, /When are you free/);
  const bad = await anon('POST', '/recruit/site/coffee', { answers: { name: 'Cam Chat', email: 'not-an-email', availability: 'Tue' } });
  assert.equal(bad.status, 400);
  const ok = await anon('POST', '/recruit/site/coffee', { answers: { name: '  Cam   Chat ', email: 'Cam@Cornell.edu', subteam: 'Software', availability: 'Tue 3pm', snack: 'Tea', extra: 'ignored' } });
  assert.equal(ok.status, 200, ok.text); assert.equal(ok.data.ok, true); assert.match(ok.data.receipt, /^jr-\d{13}-[a-f0-9]{24}$/);
  assert.equal(journal.records.get(ok.data.receipt).section, 'coffee', 'the journal entry carries its section');
  assert.equal(journal.done.get(ok.data.receipt), 'saved');
  assert.deepEqual(journal.appendOptions, { perDay: 2000, perIpHour: 5 }, 'thresholds come from the cycle');
  const list = (await recruit('GET', '/recruit/cycles/cy-interest/applications?section=coffee')).data;
  assert.equal(list.rows.length, 1); assert.equal(list.rows[0].name, 'Cam Chat'); assert.equal(list.rows[0].email, 'cam@cornell.edu'); assert.equal(list.rows[0].section, 'coffee');
  assert.deepEqual(list.counts.bySection, { interest: 1, coffee: 1 });
  const row = (await recruit('GET', `/recruit/cycles/cy-interest/applications/${list.rows[0].id}`)).data;
  assert.deepEqual(row.application.answers, { subteam: 'Software', availability: 'Tue 3pm', snack: 'Tea' }, 'unknown keys are dropped, answers kept');
  assert.equal(row.application.subteam, 'Software');
  assert.deepEqual(row.form.questions.map((q) => q.key), ['name', 'email', 'subteam', 'availability', 'snack'], 'the detail carries the section form');
  assert.equal((await recruit('GET', '/recruit/cycles/cy-interest/applications?section=interest')).data.rows.length, 1, 'sections do not mix');
  assert.equal(sent.length, 1, 'the team is emailed once per new submission'); assert.match(sent[0].body.subject, /^Coffee chats: Cam Chat$/);
  assert.deepEqual([].concat(sent[0].body.to), ['team@cornell.edu'], 'to the addresses the form names');
  assert.match(sent[0].body.html, /When are you free\?<\/b><br>Tue 3pm/); assert.doesNotMatch(sent[0].body.html, /extra/);
  // Same email, same section: refused until confirmed; another section is separate.
  const dup = await anon('POST', '/recruit/site/coffee', { answers: { name: 'Cam Chat', email: 'cam@cornell.edu', availability: 'Wed' } });
  assert.equal(dup.status, 409); assert.equal(dup.data.exists, true); assert.equal(dup.data.submitted, list.rows[0].ts);
  const replaced = await anon('POST', '/recruit/site/coffee', { answers: { name: 'Cam Chat', email: 'cam@cornell.edu', subteam: 'Software', availability: 'Wed' }, confirmUpdate: true });
  assert.equal(replaced.status, 200);
  const after = (await recruit('GET', '/recruit/cycles/cy-interest/applications?section=coffee')).data;
  assert.equal(after.rows.length, 1); assert.equal(after.rows[0].id, list.rows[0].id, 'a confirmed update keeps the row');
  assert.equal(sent.length, 1, 'updates do not re-notify');
  const fixed = await interest('POST', '/interest', { name: 'Cam Chat', email: 'cam@cornell.edu', year: 'Junior', project: 'Interest too' });
  assert.equal(fixed.status, 200, 'the same person can also join the interest list');
  assert.deepEqual((await recruit('GET', '/recruit/cycles/cy-interest/applications')).data.counts.bySection, { interest: 2, coffee: 1 });
  console.log('PASS: site submissions validate against the section form, land in the right section, dedupe per section, and email the team once');

  /* ---- csv per section, closing the interest form, capacity ---- */
  const csv = await recruit('GET', '/recruit/cycles/cy-interest/applications.csv?section=coffee');
  assert.equal(csv.status, 200); assert.match(csv.headers['content-type'], /text\/csv/);
  const lines = csv.text.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines[0], '"Name","Email","Cornell","Year","Subteam","Received","Updated","When are you free?","Snack","Files"', 'a section CSV is answers only; flags and comments belong to people');
  assert.match(lines[1], /^"Cam Chat","cam@cornell.edu","yes","","Software",/);
  assert.equal((await recruit('GET', '/recruit/cycles/cy-interest/applications.csv?section=coffee', {}, plain)).status, 403);
  /* ---- each form owns its cap, its email, and whether repeats replace ---- */
  const v1c = (await recruit('GET', '/recruit/cycles/cy-interest')).data.cycle.version;
  assert.equal((await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: v1c, settings: { sections: { coffee: { capacity: 'lots' } } } })).status, 400, 'a cap is a whole number');
  const tuned = await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: v1c, settings: { sections: { coffee: { notify: false, replace: false } } } });
  assert.equal(tuned.status, 200, tuned.text);
  const secsNow = (await recruit('GET', '/recruit/cycles/cy-interest')).data.sections;
  const coffeeNow = secsNow.coffee;
  assert.deepEqual([coffeeNow.capacity, coffeeNow.notify, coffeeNow.replace], [0, false, false]);
  assert.deepEqual(secsNow.interest.required, ['name', 'email'], 'every form keeps only identity questions');
  assert.deepEqual(coffeeNow.required, ['name', 'email'], 'every other form keeps only a name and an email');
  /* ---- what applicants read after sending is the form's own line ---- */
  assert.equal(coffeeNow.thanks, 'A member will email you to find a time.', 'a default form starts with its stock line');
  assert.equal((await anon('GET', '/recruit/site')).data.sections.find((s) => s.key === 'coffee').thanks, 'A member will email you to find a time.', 'the website reads it');
  const thanked = await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: tuned.data.cycle.version, settings: { sections: { coffee: { thanks: '  We will write back within a week.  ' } } } });
  assert.equal(thanked.status, 200, thanked.text);
  assert.equal((await anon('GET', '/recruit/site')).data.sections.find((s) => s.key === 'coffee').thanks, 'We will write back within a week.', 'trimmed, and live on the website');
  assert.equal((await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: thanked.data.cycle.version, settings: { sections: { coffee: { thanks: '' } } } })).status, 200);
  assert.equal((await recruit('GET', '/recruit/cycles/cy-interest')).data.sections.coffee.thanks, '', 'cleared, the site falls back to its plain line');
  assert.equal((await anon('GET', '/recruit/site')).data.sections.find((s) => s.key === 'coffee').notify, undefined, 'the website never sees these');
  /* ---- a reviewer with no module narrowing the list reads the whole cycle ---- */
  const reviewerGrant = await recruit('PUT', '/recruit/cycles/cy-interest/roles/plain%40example.com', { requestId: 'rq-site-reviewer-0001', roles: ['reviewer'] });
  assert.equal(reviewerGrant.status, 200, reviewerGrant.text);
  const asReviewer = await recruit('GET', '/recruit/cycles/cy-interest/applications?section=coffee', {}, plain);
  assert.equal(asReviewer.status, 200, asReviewer.text);
  assert.ok(asReviewer.data.rows.length >= 1, 'a reviewer sees the responses; no module scopes them to nothing');
  assert.equal((await recruit('DELETE', '/recruit/cycles/cy-interest/roles/plain%40example.com', { requestId: 'rq-site-reviewer-0002' }, admin)).status, 200);
  const emailsBefore = sent.length;
  const repeat = await anon('POST', '/recruit/site/coffee', { answers: { name: 'Cam Chat', email: 'cam@cornell.edu', subteam: 'Software', availability: 'Thu', snack: 'Tea' }, confirmUpdate: true });
  assert.equal(repeat.status, 409, repeat.text); assert.equal(repeat.data.exists, true); assert.equal(repeat.data.replaceable, false, 'with replacing off a repeat is refused even when confirmed');
  const capped = await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: (await recruit('GET', '/recruit/cycles/cy-interest')).data.cycle.version, settings: { sections: { coffee: { capacity: 1 } } } });
  assert.equal(capped.status, 200, capped.text);
  const third = await anon('POST', '/recruit/site/coffee', { answers: { name: 'Third', email: 'third@cornell.edu', availability: 'Fri', snack: 'Tea' } });
  assert.equal(third.status, 409, third.text); assert.match(third.data.error, /full/, 'the form\'s own cap applies');
  assert.equal(sent.length, emailsBefore, 'nothing was emailed for refused submissions');
  const v1d = (await recruit('GET', '/recruit/cycles/cy-interest')).data.cycle.version;
  assert.equal((await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: v1d, settings: { sections: { coffee: { capacity: 0, notify: true, replace: true } } } })).status, 200);
  /* ---- each form can name who gets its emails ---- */
  const v1e = (await recruit('GET', '/recruit/cycles/cy-interest')).data.cycle.version;
  const badTo = await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: v1e, settings: { sections: { coffee: { notifyTo: ['lead@cornell.edu', 'not an address'] } } } });
  assert.equal(badTo.status, 400, badTo.text); assert.match(badTo.data.error, /"not an address" is not an email address/);
  assert.equal((await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: v1e, settings: { sections: { coffee: { notifyTo: 'lead@cornell.edu' } } } })).status, 400, 'recipients are a list');
  const routed = await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: v1e, settings: { sections: { coffee: { notifyTo: ['Lead@Cornell.edu', 'lead@cornell.edu', ' second@cornell.edu '] } } } });
  assert.equal(routed.status, 200, routed.text);
  assert.deepEqual((await recruit('GET', '/recruit/cycles/cy-interest')).data.sections.coffee.notifyTo, ['lead@cornell.edu', 'second@cornell.edu'], 'recipients are trimmed, lowercased and deduplicated');
  assert.equal((await anon('GET', '/recruit/site')).data.sections.find((s) => s.key === 'coffee').notifyTo, undefined, 'the website never sees recipients');
  const fourth = await anon('POST', '/recruit/site/coffee', { answers: { name: 'Fourth Person', email: 'fourth@cornell.edu', availability: 'Sat', snack: 'Tea' } });
  assert.equal(fourth.status, 200, fourth.text);
  assert.deepEqual([].concat(sent.at(-1).body.to), ['lead@cornell.edu', 'second@cornell.edu'], "the form's own recipients get its emails");
  assert.equal((await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: routed.data.cycle.version, settings: { sections: { coffee: { notifyTo: [] } } } })).status, 200);
  const beforeFifth = sent.length;
  const fifth = await anon('POST', '/recruit/site/coffee', { answers: { name: 'Fifth Person', email: 'fifth@cornell.edu', availability: 'Sun', snack: 'Tea' } });
  assert.equal(fifth.status, 200, fifth.text);
  assert.equal(sent.length, beforeFifth, 'with no addresses of its own a form emails nobody');
  /* ---- a cycle adds forms of its own, orders them, and drops them when empty ---- */
  const vA = (await recruit('GET', '/recruit/cycles/cy-interest')).data.cycle.version;
  assert.equal((await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: vA, settings: { sections: { 'coffee-2': { open: true } } } })).status, 400, 'a new form needs a title');
  assert.equal((await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: vA, settings: { sections: { 'Bad Key': { title: 'x' } } } })).status, 400, 'keys are plain');
  const added = await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: vA, settings: { sections: { 'coffee-2': { title: 'Coffee chats, round 2', open: true, form: { questions: [{ key: 'name', type: 'short', label: 'Name', required: true }, { key: 'email', type: 'email', label: 'Email', required: true }, { key: 'slot', type: 'single', label: 'Slot', options: ['Mon', 'Tue'], required: true }] } } } } });
  assert.equal(added.status, 200, added.text);
  const withNew = await recruit('GET', '/recruit/cycles/cy-interest');
  assert.deepEqual(Object.keys(withNew.data.sections), ['interest', 'coffee', 'application', 'coffee-2'], 'a new form joins the end of the list');
  assert.deepEqual((await anon('GET', '/recruit/site')).data.sections.map((x) => x.key), ['interest', 'coffee', 'application', 'coffee-2'], 'the website sees it in order');
  const r2 = await anon('POST', '/recruit/site/coffee-2', { answers: { name: 'Rounder', email: 'round@cornell.edu', slot: 'Tue' } });
  assert.equal(r2.status, 200, r2.text);
  assert.equal((await recruit('GET', '/recruit/cycles/cy-interest/applications?section=coffee-2')).data.rows.length, 1, 'its responses list under its own key');
  assert.ok((await recruit('GET', '/recruit/cycles/cy-interest/people')).data.rows.find((p) => p.email === 'round@cornell.edu')?.sections['coffee-2'], 'People shows the new column');
  const vB = withNew.data.cycle.version;
  const reordered = await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: vB, settings: { order: ['interest', 'coffee-2', 'coffee', 'application'] } });
  assert.equal(reordered.status, 200, reordered.text);
  assert.deepEqual(Object.keys((await recruit('GET', '/recruit/cycles/cy-interest')).data.sections), ['interest', 'coffee-2', 'coffee', 'application'], 'the order is the cycle\'s to set');
  const vC = reordered.data.cycle.version;
  const keepInterest = await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: vC, settings: { remove: ['interest'] } });
  assert.equal(keepInterest.status, 409, 'the interest form goes like any other: not while it has responses');
  const busy = await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: vC, settings: { remove: ['coffee-2'] } });
  assert.equal(busy.status, 409, 'a form with responses is closed, not removed'); assert.match(busy.data.error, /1 response/);
  const dropped = await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: vC, settings: { remove: ['application'] } });
  assert.equal(dropped.status, 200, dropped.text);
  assert.deepEqual(Object.keys((await recruit('GET', '/recruit/cycles/cy-interest')).data.sections), ['interest', 'coffee-2', 'coffee'], 'an empty default form can go');
  assert.equal((await anon('POST', '/recruit/site/application', { answers: { name: 'Late', email: 'late2@cornell.edu' } })).status, 404, 'a dropped form is no longer a route');
  const vD = dropped.data.cycle.version;
  const revived = await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: vD, settings: { sections: { application: { title: 'Application' } } } });
  assert.equal(revived.status, 200, revived.text);
  /* ---- a long answer with a file in one question ---- */
  const vLF = revived.data.cycle.version;
  const withPortfolio = await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: vLF, settings: { sections: { application: { open: true, form: { questions: [{ key: 'name', type: 'short', label: 'Name', required: true }, { key: 'email', type: 'email', label: 'Email', required: true }, { key: 'portfolio', type: 'longfile', label: 'Portfolio', required: true }] } } } } });
  assert.equal(withPortfolio.status, 200, withPortfolio.text);
  const pub = (await anon('GET', '/recruit/site')).data.sections.find((s) => s.key === 'application');
  assert.deepEqual(pub.form.questions.map((qq) => qq.type), ['short', 'email', 'longfile'], 'the website sees the combined type');
  assert.equal((await anon('POST', '/recruit/site/application', { answers: { name: 'Neither', email: 'neither@cornell.edu' } })).status, 400, 'required means text or a file');
  const textOnly = await anon('POST', '/recruit/site/application', { answers: { name: 'Text Only', email: 'textonly@cornell.edu', portfolio: 'Built a rover' } });
  assert.equal(textOnly.status, 200, textOnly.text);
  const fileOnly = await anon('POST', '/recruit/site/application', { answers: { name: 'File Only', email: 'fileonly@cornell.edu' }, files: { portfolio: { name: 'rover.pdf', type: 'application/pdf', data: 'JVBERi0xLjQK' } } });
  assert.equal(fileOnly.status, 200, fileOnly.text);
  const both = await anon('POST', '/recruit/site/application', { answers: { name: 'Both', email: 'both@cornell.edu', portfolio: 'See attached' }, files: { portfolio: { name: 'rover.pdf', type: 'application/pdf', data: 'JVBERi0xLjQK' } } });
  assert.equal(both.status, 200, both.text);
  const appRows = (await recruit('GET', '/recruit/cycles/cy-interest/applications?section=application')).data.rows;
  const bothRow = (await recruit('GET', `/recruit/cycles/cy-interest/applications/${appRows.find((r) => r.email === 'both@cornell.edu').id}`)).data.application;
  assert.equal(bothRow.answers.portfolio, 'See attached'); assert.equal(bothRow.files.length, 1, 'the text and the file land on one row');
  const fileRow = (await recruit('GET', `/recruit/cycles/cy-interest/applications/${appRows.find((r) => r.email === 'fileonly@cornell.edu').id}`)).data.application;
  assert.equal(fileRow.files[0].name, 'rover.pdf'); assert.equal(fileRow.answers.portfolio || '', '', 'a file alone leaves the text empty');
  assert.equal((await anon('POST', '/recruit/site/application', { answers: { name: 'Bad File', email: 'badfile@cornell.edu' }, files: { portfolio: { name: 'x.txt', type: 'text/plain', data: 'aGk=' } } })).status, 400, 'images or PDF only');
  const csvLF = await recruit('GET', '/recruit/cycles/cy-interest/applications.csv?section=application');
  assert.match(csvLF.text, /"Portfolio"/); assert.match(csvLF.text, /"See attached"/); assert.match(csvLF.text, /rover\.pdf/);
  assert.equal((await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: withPortfolio.data.cycle.version, settings: { sections: { application: { open: false } } } })).status, 200);
  assert.deepEqual(Object.keys((await recruit('GET', '/recruit/cycles/cy-interest')).data.sections), ['interest', 'coffee-2', 'coffee', 'application'], 'a dropped default comes back on request');
  const v2 = (await recruit('GET', '/recruit/cycles/cy-interest')).data.cycle.version;
  assert.equal((await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: v2, settings: { sections: { interest: { open: false } } } })).status, 200);
  const closed = await interest('POST', '/interest', { name: 'Late', email: 'late@cornell.edu', year: 'Senior' });
  assert.equal(closed.status, 409, 'a closed interest section refuses the fixed POST too'); assert.match(closed.data.error, /closed/);
  assert.equal((await anon('GET', '/recruit/site')).data.sections.find((s) => s.key === 'interest').open, false);
  assert.equal((await anon('GET', '/recruit/site')).data.landing, 'coffee', 'closing another form leaves the /apply choice');
  const vAll = (await recruit('GET', '/recruit/cycles/cy-interest')).data.cycle.version;
  assert.equal((await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: vAll, settings: { sections: { coffee: { open: false }, 'coffee-2': { open: false }, application: { open: false } } } })).status, 200);
  assert.equal((await anon('GET', '/recruit/site')).data.landing, null, 'with every form closed, /apply has nothing to show and the site draws its closed page');
  const vBack = (await recruit('GET', '/recruit/cycles/cy-interest')).data.cycle.version;
  assert.equal((await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: vBack, settings: { sections: { coffee: { open: true } } } })).status, 200);
  const v3 = (await recruit('GET', '/recruit/cycles/cy-interest')).data.cycle.version;
  assert.equal((await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: v3, settings: { sections: { coffee: { capacity: 1 } } } })).status, 200);
  const full = await anon('POST', '/recruit/site/coffee', { answers: { name: 'Second', email: 'second@cornell.edu', availability: 'Thu' } });
  assert.equal(full.status, 409); assert.match(full.data.error, /full/);
  assert.equal((await recruit('PATCH', '/recruit/cycles/cy-interest', { version: v3 + 1, capacity: 0 })).status, 200, 'a cycle-level capacity is ignored, not refused');
  assert.equal((await anon('POST', '/recruit/site/coffee', { answers: { name: 'Third Try', email: 'third-try@cornell.edu', availability: 'Thu' } })).status, 409, 'the form\'s own cap still holds');
  /* ---- people: one row per email across the forms ---- */
  const people = await recruit('GET', '/recruit/cycles/cy-interest/people');
  assert.equal(people.status, 200, people.text);
  const cam = people.data.rows.find((p) => p.email === 'cam@cornell.edu');
  assert.ok(cam?.sections.coffee && cam?.sections.interest, 'a person groups the forms they sent');
  assert.equal(cam.sections.coffee.section, 'coffee'); assert.ok(cam.latest, 'the latest submission is named');
  assert.equal(people.data.counts.people, people.data.rows.length);
  assert.ok(people.data.counts.bySection.coffee >= 1 && people.data.counts.bySection.interest >= 1, 'counts cover every form');
  assert.deepEqual(people.data.rows.map((p) => p.last), [...people.data.rows.map((p) => p.last)].sort((a, b) => b - a), 'newest activity first');
  assert.equal((await recruit('GET', '/recruit/cycles/cy-interest/people?q=cam')).data.rows.length, 1, 'search by name or email');
  assert.equal((await recruit('GET', '/recruit/cycles/cy-interest/people', {}, plain)).status, 403, 'members without a role cannot list people');
  /* ---- flags and comments belong to the person ---- */
  const camPath = `/recruit/cycles/cy-interest/people/${encodeURIComponent('cam@cornell.edu')}`;
  const camDetail = await recruit('GET', camPath);
  assert.equal(camDetail.status, 200, camDetail.text);
  assert.deepEqual(camDetail.data.submissions.map((x) => x.application.section).sort(), ['coffee', 'interest'], 'the person carries every form they sent');
  assert.ok(camDetail.data.submissions.every((x) => x.application.review === undefined), 'submissions have no review of their own');
  assert.equal(camDetail.data.person.flagged, false);
  const flagged = await recruit('PATCH', `${camPath}/review`, { flagged: true });
  assert.equal(flagged.status, 200, flagged.text); assert.equal(flagged.data.person.flagged, true);
  const posted = await recruit('POST', `${camPath}/comments`, { id: 'ic-cam00001', text: 'Great chat' });
  assert.equal(posted.status, 200, posted.text); assert.equal(posted.data.person.review.comments.length, 1);
  assert.equal((await recruit('POST', `${camPath}/comments`, { id: 'ic-cam00001', text: 'Great chat' })).data.person.review.comments.length, 1, 'a retry never posts twice');
  const listed = (await recruit('GET', '/recruit/cycles/cy-interest/people')).data.rows.find((p) => p.email === 'cam@cornell.edu');
  assert.equal(listed.flagged, true); assert.equal(listed.comments, 1, "the list carries the person's flag and thread size");
  assert.equal((await recruit('GET', '/recruit/cycles/cy-interest/people?flagged=1')).data.rows.length, 1);
  assert.equal((await recruit('DELETE', `${camPath}/comments/ic-cam00001`)).data.person.review.comments.length, 0);
  assert.equal((await recruit('PATCH', `${camPath}/review`, { flagged: true }, plain)).status, 403, 'members without a role cannot flag');
  assert.equal((await recruit('GET', `/recruit/cycles/cy-interest/people/${encodeURIComponent('nobody@cornell.edu')}`)).status, 404);
  const peopleCsv = await recruit('GET', '/recruit/cycles/cy-interest/people.csv');
  assert.equal(peopleCsv.status, 200);
  assert.equal(String(peopleCsv.text).replace(/^\uFEFF/, '').split('\n')[0].trim(), '"Name","Email","Cornell","Subteam","Year","Interest form","Coffee chats, round 2","Coffee chats","Application","Flagged","Comments","Last activity"', 'the people CSV has a column per form, in the cycle\'s order');
  const auditKinds = (await recruit('GET', '/recruit/cycles/cy-interest/audit')).data.rows.map((a) => a.kind);
  for (const kind of ['person.flag', 'comment.post', 'comment.delete']) assert.ok(auditKinds.includes(kind), `people routes write ${kind} audit`);
  console.log('PASS: per-section CSV with formula-safe cells, a closed interest form refuses the website, capacity applies per section, people group across forms, and the flag and the thread belong to the person');
  const { recruitmentRegressions } = await import('./recruit-regression-cases.mjs');
  await recruitmentRegressions({ lib, recruit, anon, R, ctxFor, admin, plain, journal, now: () => clock });
  console.log('PASS: site module — public read, per-section submit, settings, csv');
}
