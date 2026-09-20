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
    async append(entry, file, options) { this.appendOptions = options || null; records.set(entry.id, structuredClone(entry)); if (file) files.set(entry.id, Buffer.from(file.data)); return true; },
    async listPending() { return [...records.values()].filter((e) => !done.has(e.id)).sort((a, b) => a.ts - b.ts); },
    async getEntry(id) { return records.get(id) ? structuredClone(records.get(id)) : null; },
    async getFile(id) { return files.get(id) || null; },
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
  const mods = await Promise.all(['cycles', 'applications', 'roles', 'site'].map(async (m) => (await lib(`recruit/modules/${m}.js`)).default));
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

  /* ---- before migration: the site sees the interest form, nothing else ---- */
  const before = await anon('GET', '/recruit/site');
  assert.equal(before.status, 200); assert.equal(before.data.cycle, null);
  assert.deepEqual(before.data.sections.map((s) => [s.key, s.open]), [['interest', true]]);
  assert.equal(before.headers['cache-control'], 'no-store');
  assert.equal(before.headers['access-control-allow-origin'], 'https://cornellphysicalintelligence.com');
  assert.equal((await anon('GET', '/recruit/site', {}, 'https://evil.example')).status, 403, 'other origins are refused');
  assert.equal((await anon('POST', '/recruit/site/coffee', { answers: { name: 'X', email: 'x@cornell.edu' } })).status, 409, 'no cycle receives the site yet');
  assert.equal((await anon('POST', '/recruit/site/bogus', {})).status, 404, 'unknown sections are not routes');
  console.log('PASS: before a cycle receives the website, the site gets the fixed interest form and the fixed POST still works');

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
  const put = await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version, settings: { sections: { coffee: { open: true, form: { questions: [
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
  const v1b = (await recruit('GET', '/recruit/cycles/cy-interest')).data.cycle.version;
  assert.equal((await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: v1b, settings: { sections: {}, landing: 'nope' } })).status, 400, 'the /apply form must be one of the three');
  const chose = await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: v1b, settings: { sections: {}, landing: 'coffee' } });
  assert.equal(chose.status, 200, chose.text);
  assert.equal(chose.data.cycle.doc.site.landing, 'coffee');
  assert.equal((await anon('GET', '/recruit/site')).data.landing, 'coffee', 'the chosen form is what /apply shows');
  assert.deepEqual((await anon('GET', '/recruit/site')).data.sections.find((s) => s.key === 'coffee').form.questions.map((q) => q.key), ['name', 'email', 'subteam', 'availability', 'snack'], 'choosing the /apply form leaves the sections alone');
  assert.deepEqual(coffee.form.questions.find((q) => q.key === 'subteam').options, ['Mechanical', 'Electrical', 'Software', 'Creative', 'Business & Marketing'], 'subteam options follow the cycle');
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
  assert.deepEqual(row.application.answers, { availability: 'Tue 3pm', snack: 'Tea' }, 'unknown keys are dropped, answers kept');
  assert.equal(row.application.subteam, 'Software');
  assert.deepEqual(row.form.questions.map((q) => q.key), ['name', 'email', 'subteam', 'availability', 'snack'], 'the detail carries the section form');
  assert.equal((await recruit('GET', '/recruit/cycles/cy-interest/applications?section=interest')).data.rows.length, 1, 'sections do not mix');
  assert.equal(sent.length, 1, 'the team is emailed once per new submission'); assert.match(sent[0].body.subject, /^Coffee chats: Cam Chat$/);
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
  assert.equal(lines[0], '"Name","Email","Cornell","Year","Subteam","Received","Updated","When are you free?","Snack","Files","Flagged","Comments"');
  assert.match(lines[1], /^"Cam Chat","cam@cornell.edu","yes","","Software",/);
  assert.equal((await recruit('GET', '/recruit/cycles/cy-interest/applications.csv?section=coffee', {}, plain)).status, 403);
  const v2 = (await recruit('GET', '/recruit/cycles/cy-interest')).data.cycle.version;
  assert.equal((await recruit('PUT', '/recruit/cycles/cy-interest/settings/site', { version: v2, settings: { sections: { interest: { open: false } } } })).status, 200);
  const closed = await interest('POST', '/interest', { name: 'Late', email: 'late@cornell.edu', year: 'Senior' });
  assert.equal(closed.status, 409, 'a closed interest section refuses the fixed POST too'); assert.match(closed.data.error, /closed/);
  assert.equal((await anon('GET', '/recruit/site')).data.sections.find((s) => s.key === 'interest').open, false);
  assert.equal((await anon('GET', '/recruit/site')).data.landing, 'coffee', 'closing another form leaves the /apply choice');
  const v3 = (await recruit('GET', '/recruit/cycles/cy-interest')).data.cycle.version;
  assert.equal((await recruit('PATCH', '/recruit/cycles/cy-interest', { version: v3, capacity: 1 })).status, 200);
  const full = await anon('POST', '/recruit/site/coffee', { answers: { name: 'Second', email: 'second@cornell.edu', availability: 'Thu' } });
  assert.equal(full.status, 409); assert.match(full.data.error, /full/);
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
  console.log('PASS: per-section CSV with formula-safe cells, a closed interest form refuses the website, capacity applies per section, people group across forms');
  console.log('PASS: site module — public read, per-section submit, settings, csv');
}
