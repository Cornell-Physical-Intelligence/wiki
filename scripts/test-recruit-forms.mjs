// Synthetic fixtures only: the real forms module runs from a temp copy beside
// a synthetic fixed-form.js, over an in-memory kit and a fake registry, plus
// a recording SQL tag for statement shape. No storage, network, credentials
// or repo .dev*.json files.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

globalThis.fetch = async () => { throw new Error('Network disabled in tests'); };

const SUBTEAMS = ['Mechanical', 'Electrical', 'Software', 'Creative', 'Business & Marketing'];
const YEARS = ['Freshman', 'Sophomore', 'Junior', 'Senior', 'Grad'];
const FILE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'];
const FIXED = {
  sections: [],
  questions: [
    { key: 'name', type: 'short', label: 'Name', help: '', required: true, system: true, options: [], max: 100, accept: [], maxBytes: null, section: null, subteamOnly: null },
    { key: 'email', type: 'email', label: 'Email', help: '', required: true, system: true, options: [], max: 200, accept: [], maxBytes: null, section: null, subteamOnly: null },
    { key: 'subteam', type: 'single', label: 'Subteam', help: '', required: false, system: true, options: SUBTEAMS, max: null, accept: [], maxBytes: null, section: null, subteamOnly: null },
    { key: 'year', type: 'single', label: 'Year', help: '', required: false, system: true, options: YEARS, max: null, accept: [], maxBytes: null, section: null, subteamOnly: null },
    { key: 'project', type: 'long', label: 'Coolest project', help: '', required: false, system: true, options: [], max: 1000, accept: [], maxBytes: null, section: null, subteamOnly: null },
    { key: 'file', type: 'file', label: 'Attachment', help: '', required: false, system: true, options: [], max: null, accept: FILE_TYPES, maxBytes: 2621440, section: null, subteamOnly: null },
  ],
};

const dir = await mkdtemp(join(tmpdir(), 'cupi-recruit-forms-'));
let forms, helpers;
try {
  await mkdir(join(dir, 'lib/recruit/modules'), { recursive: true });
  await cp(new URL('../lib/recruit/modules/forms.js', import.meta.url), join(dir, 'lib/recruit/modules/forms.js'));
  await writeFile(join(dir, 'lib/recruit/fixed-form.js'), `export const FIXED_FORM_V1 = ${JSON.stringify(FIXED)};\n`);
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  helpers = await import(pathToFileURL(join(dir, 'lib/recruit/modules/forms.js')));
  forms = helpers.default;
} finally {
  await rm(dir, { recursive: true, force: true });
}
const { validateFormDoc, validateAnswers, fixedForm, publicForm } = helpers;

/* ------------------------- fake kit and registry ------------------------ */

const PARAMS = { cycle: 'cy-[a-z0-9-]+', app: 'in-[a-z0-9]+', file: 'int-[a-z0-9]+', form: 'fm-[a-z0-9]+', slot: 'sl-[a-z0-9]+', booking: 'bk-[a-z0-9]+', mail: 'ml-[a-z0-9]+', comment: 'ic-[a-z0-9-]{8,80}', email: '[^/]{3,200}', token: '[a-f0-9]{32}', kind: 'review|interview', round: '[a-z0-9_-]{0,40}', receipt: 'jr-\\d{13}-[a-f0-9]{24}', member: '[^/]{3,200}', module: '[a-z]+', version: '\\d+' };
function compile(path) {
  const names = [];
  const re = path.replace(/:([a-z]+)/g, (_, n) => { if (!PARAMS[n]) throw new Error('Unknown route param ' + n); names.push(n); return '(' + PARAMS[n] + ')'; });
  return { re: new RegExp('^' + re + '$'), names };
}
function allowed(access, role) {
  if (access === 'public' || access === 'member') return true;
  if (!role) return false;
  if (access === 'role') return true;
  if (access === 'reviewer') return ['admin', 'lead', 'reviewer'].includes(role);
  if (access === 'interviewer') return ['admin', 'lead', 'interviewer'].includes(role);
  if (access === 'lead') return role === 'admin' || role === 'lead';
  return role === 'admin';
}
const cycleRow = (over = {}) => ({
  id: 'cy-fall', version: 3, status: 'open', name: 'Fall 2026', term: 'Fall 2026', closesAt: 1_800_000_000_000, formVersion: 0, created: 1, updated: 1,
  doc: { subteams: [{ key: 'software', name: 'Software' }, { key: 'electrical', name: 'Electrical' }], modules: { forms: true }, capacity: 0 },
  ...over,
});
function makeKit(seed = {}) {
  const mem = { settings: { version: 1, doc: {} }, cycles: [], applications: [], requests: {}, audit: [], forms: [], ...seed };
  let n = 0, clock = 1_700_000_000_000;
  const kit = {
    mode: 'memory', mem, saves: 0, memSave() { this.saves++; },
    id: (p) => `${p}-${(++n).toString(36).padStart(4, '0')}`,
    now: () => (clock += 1000),
    async once(id, actor, run) { return run(); },
    async audit(row) { mem.audit.push({ id: kit.id('au'), ts: kit.now(), ...row }); },
    async emit() {}, async collect() { return []; },
    cycles: {
      get: async (id) => mem.cycles.find((c) => c.id === id) || null,
      intakeTarget: async () => { const id = mem.settings.doc.intakeCycleId; const c = id && mem.cycles.find((x) => x.id === id && x.status === 'open'); return c ? { cycleId: c.id, formVersion: c.formVersion || 0, perIpHour: 5, perDay: 2000, capacity: c.doc?.capacity || 0 } : null; },
      enabled: () => true,
    },
    apps: {}, roles: { grantFor: async () => null, roster: async () => [] },
    json: (status, body, headers) => ({ status, body, headers }),
  };
  return kit;
}
let meCalls = 0;
async function call(kit, method, path, { me = { email: 'lead@example.com', name: 'Lead' }, role = 'lead', body = {}, query = {}, anonymous = false } = {}) {
  for (const route of forms.routes) {
    if (route.method !== method) continue;
    const { re, names } = compile(route.path);
    const m = path.match(re);
    if (!m) continue;
    const params = Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(m[i + 1])]));
    if (anonymous && !route.public) return { status: 401, body: { error: 'Not signed in' } };
    if (!route.public && !allowed(route.access, role)) return { status: 403, body: { error: role ? 'Not allowed in this cycle' : 'Admins only' } };
    if (!route.public) meCalls++;
    const cycle = params.cycle ? await kit.cycles.get(params.cycle) : null;
    if (params.cycle && !cycle) return { status: 404, body: { error: 'No such cycle' } };
    if (route.mutates && cycle?.status === 'archived') return { status: 409, body: { error: 'This cycle is archived' } };
    const rq = { method, path, params, query, me: route.public ? null : me, role: route.public ? null : role, grant: null, cycle, body: async () => body, req: {}, res: {}, scope: null };
    try {
      const out = await route.handler(rq, kit);
      if (out?.audit && out.status < 300) await kit.audit({ cycleId: cycle?.id || '', applicationId: out.audit.target || null, actor: me.email, kind: out.audit.kind, detail: out.audit.detail || {} });
      return out;
    } catch (e) {
      if (e && e.status) return { status: e.status, body: { error: e.error || e.message } };
      throw e;
    }
  }
  return { status: 404, body: { error: 'No such endpoint' } };
}

/* ------------------------------ contract shape --------------------------- */

assert.equal(forms.name, 'forms');
assert.equal(forms.kernel, false);
assert.deepEqual(forms.memory, { forms: [] });
assert.equal(forms.schema.length, 1);
assert.match(forms.schema[0], /^CREATE TABLE IF NOT EXISTS recruit_forms .*UNIQUE \(cycle_id, version\)\)$/);
for (const r of forms.routes) { compile(r.path); assert.ok(r.access, r.path + ' declares access'); }
const publicRoutes = forms.routes.filter((r) => r.public);
assert.deepEqual(publicRoutes.map((r) => r.method + ' ' + r.path), ['GET /form'], 'exactly one anonymous route');
assert.deepEqual(forms.auditKinds, ['form.publish']);
assert.deepEqual(forms.defaults({}), {});
assert.deepEqual(forms.validateSettings(undefined), {});
assert.throws(() => forms.validateSettings('x'), (e) => e.status === 400);

/* ------------------------------- version 0 ------------------------------ */

{
  const plain = fixedForm({ id: 'cy-x', doc: {} });
  assert.deepEqual(plain.doc, FIXED, 'version 0 is the fixed form');
  assert.equal(plain.version, 0);
  assert.equal(plain.status, 'published');
  const cycle = cycleRow();
  const themed = fixedForm(cycle);
  assert.deepEqual(themed.doc.questions.find((q) => q.key === 'subteam').options, ['Software', 'Electrical'], 'the cycle\'s subteams replace the website vocabulary');
  assert.deepEqual(themed.doc.questions.map((q) => q.key), FIXED.questions.map((q) => q.key));
  assert.notEqual(plain.doc, FIXED, 'callers get a copy, never the constant');
  const kit = makeKit({ cycles: [cycle] });
  const out = await call(kit, 'GET', '/cycles/cy-fall/forms/0', { role: 'reviewer', me: { email: 'r@example.com' } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.form.doc, themed.doc);
  assert.equal(out.body.form.version, 0);
  assert.equal((await call(kit, 'GET', '/cycles/cy-fall/forms/7')).status, 404);
  assert.equal((await call(kit, 'GET', '/cycles/cy-fall/forms', { role: 'reviewer', me: { email: 'r@example.com' } })).status, 403, 'the version list is for leads');
  assert.equal((await call(kit, 'GET', '/cycles/cy-fall/forms/0', { role: null })).status, 403);
}

/* --------------------------- form doc validation ------------------------ */

{
  const cycle = cycleRow();
  const base = () => JSON.parse(JSON.stringify(FIXED));
  const bad = (mutate, re) => { const doc = base(); mutate(doc); assert.throws(() => validateFormDoc(doc, cycle), (e) => e.status === 400 && re.test(e.error), re); };
  bad((d) => { d.questions = d.questions.filter((q) => q.key !== 'name'); }, /"name" question cannot be removed/);
  bad((d) => { d.questions = d.questions.filter((q) => q.key !== 'year'); }, /"year" question cannot be removed/);
  bad((d) => { d.questions.find((q) => q.key === 'email').type = 'short'; }, /system question and stays a email field/);
  bad((d) => { d.questions.find((q) => q.key === 'project').type = 'short'; }, /stays a long field/);
  bad((d) => { d.questions.push({ key: 'Fav', type: 'short', label: 'x' }); }, /lowercase/);
  bad((d) => { d.questions.push({ key: 'name', type: 'short', label: 'x' }); }, /used twice/);
  bad((d) => { d.questions.push({ key: 'lang', type: 'single', label: 'Language' }); }, /needs choices/);
  bad((d) => { d.questions.push({ key: 'lang', type: 'single', label: 'Language', options: ['', ' '] }); }, /at least one choice/);
  bad((d) => { d.questions.push({ key: 'lang', type: 'radio', label: 'Language' }); }, /unknown type/);
  bad((d) => { d.questions.push({ key: 'lang', type: 'short', label: '' }); }, /Give question/);
  bad((d) => { d.questions.push({ key: 'lang', type: 'short', label: 'L', section: 'ghost' }); }, /unknown section/);
  bad((d) => { d.questions.push({ key: 'lang', type: 'short', label: 'L', subteamOnly: 'plumbing' }); }, /unknown subteam/);
  bad((d) => { d.questions.push({ key: 'cv', type: 'file', label: 'CV', accept: ['application/zip'] }); }, /unsupported file type/);
  bad((d) => { d.questions.push({ key: 'cv', type: 'file', label: 'CV', maxBytes: 9_000_000 }); }, /at most 2621440 bytes/);
  bad((d) => { d.questions.push({ key: 'essay', type: 'long', label: 'Essay', max: 5000 }); }, /1 to 4000/);
  bad((d) => { d.sections = [{ key: 'sw', title: 'Software', subteam: 'plumbing' }]; }, /unknown subteam/);
  bad((d) => { d.sections = [{ key: 'sw', title: 'S' }, { key: 'sw', title: 'T' }]; }, /used twice/);
  bad((d) => { d.questions = Array.from({ length: 61 }, (_, i) => ({ key: 'q' + i, type: 'short', label: 'Q' })); }, /60 questions/);
  assert.throws(() => validateFormDoc(null, cycle), (e) => e.status === 400);
  assert.throws(() => validateFormDoc({ sections: [], questions: [] }, cycle), (e) => /at least one question/.test(e.error));

  const doc = base();
  doc.sections = [{ key: 'sw', title: '  Software   questions ', subteam: 'software' }];
  doc.questions.find((q) => q.key === 'name').required = false;
  doc.questions = doc.questions.filter((q) => q.key !== 'file');
  doc.questions.push(
    { key: 'lang', type: 'multi', label: ' Languages ', options: ['Python', 'Rust', 'Python'], section: 'sw', required: true, help: 'Pick any' },
    { key: 'repo', type: 'link', label: 'Repository', subteamOnly: 'software' },
    { key: 'agree', type: 'checkbox', label: 'I can attend', required: true },
    { key: 'cv', type: 'file', label: 'CV', accept: ['application/pdf'] },
    { key: 'essay', type: 'long', label: 'Essay' },
  );
  const ok = validateFormDoc(doc, cycle);
  assert.deepEqual(ok.sections, [{ key: 'sw', title: 'Software questions', subteam: 'software' }]);
  assert.equal(ok.questions.find((q) => q.key === 'name').required, true, 'name and email stay required');
  assert.equal(ok.questions.some((q) => q.key === 'file'), false, 'the attachment question may be dropped');
  assert.deepEqual(ok.questions.find((q) => q.key === 'lang'), { key: 'lang', type: 'multi', label: 'Languages', help: 'Pick any', required: true, system: false, options: ['Python', 'Rust'], max: null, accept: [], maxBytes: null, section: 'sw', subteamOnly: null });
  assert.deepEqual(ok.questions.find((q) => q.key === 'cv'), { key: 'cv', type: 'file', label: 'CV', help: '', required: false, system: false, options: [], max: null, accept: ['application/pdf'], maxBytes: 2621440, section: null, subteamOnly: null });
  assert.equal(ok.questions.find((q) => q.key === 'essay').max, 1000);
  assert.equal(ok.questions.find((q) => q.key === 'repo').max, 500);
  assert.equal(ok.questions.find((q) => q.key === 'project').system, true);
  assert.deepEqual(validateFormDoc(ok, cycle), ok, 'normalisation is idempotent');
}

/* --------------------------- drafts and publishing ---------------------- */

{
  const kit = makeKit({ cycles: [cycleRow()] });
  const doc = JSON.parse(JSON.stringify(FIXED));
  doc.questions.push({ key: 'why', type: 'long', label: 'Why CUPI?', required: true });
  const created = await call(kit, 'POST', '/cycles/cy-fall/forms', { body: { doc } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual([created.body.form.version, created.body.form.status, created.body.form.createdBy, created.body.form.published], [1, 'draft', 'lead@example.com', null]);
  assert.match(created.body.form.id, /^fm-/);
  assert.equal(created.body.form.doc.questions.at(-1).max, 1000, 'stored docs are normalised');
  const v1 = created.body.form.id;
  const copied = await call(kit, 'POST', '/cycles/cy-fall/forms', { body: { from: 0 } });
  assert.equal(copied.status, 201);
  assert.equal(copied.body.form.version, 2, 'versions count up');
  assert.deepEqual(copied.body.form.doc.questions.map((q) => q.key), FIXED.questions.map((q) => q.key));
  const v2 = copied.body.form.id;
  assert.equal((await call(kit, 'POST', '/cycles/cy-fall/forms', { body: { from: 9 } })).status, 404);
  assert.equal((await call(kit, 'POST', '/cycles/cy-fall/forms', { body: { doc: { questions: [] } } })).status, 400);

  const edited = await call(kit, 'PATCH', `/cycles/cy-fall/forms/${v2}`, { body: { doc: { ...copied.body.form.doc, questions: [...copied.body.form.doc.questions, { key: 'github', type: 'link', label: 'GitHub' }] } } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.form.doc.questions.at(-1).key, 'github');
  assert.equal((await call(kit, 'PATCH', '/cycles/cy-fall/forms/fm-nope', { body: { doc } })).status, 404);

  const list0 = await call(kit, 'GET', '/cycles/cy-fall/forms');
  assert.deepEqual(list0.body.forms.map((f) => [f.version, f.status]), [[0, 'published'], [1, 'draft'], [2, 'draft']]);
  assert.equal(list0.body.current, 0);

  const published = await call(kit, 'POST', `/cycles/cy-fall/forms/${v1}/publish`);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.form.status, 'published');
  assert.ok(published.body.form.published);
  assert.equal(published.body.current, 1);
  assert.equal(kit.mem.cycles[0].formVersion, 1, 'the cycle points at the published version');
  assert.deepEqual(kit.mem.audit.map((a) => [a.kind, a.detail]), [['form.publish', { formId: v1, version: 1 }]]);
  const frozen = await call(kit, 'PATCH', `/cycles/cy-fall/forms/${v1}`, { body: { doc } });
  assert.equal(frozen.status, 409);
  assert.equal(frozen.body.error, 'Only drafts can be edited', 'a published version is immutable');
  assert.equal((await call(kit, 'POST', `/cycles/cy-fall/forms/${v1}/publish`)).status, 200, 'publishing twice is a no-op');
  assert.equal(kit.mem.audit.length, 1);

  const swapped = await call(kit, 'POST', `/cycles/cy-fall/forms/${v2}/publish`);
  assert.equal(swapped.status, 200);
  assert.equal(kit.mem.cycles[0].formVersion, 2);
  const list = await call(kit, 'GET', '/cycles/cy-fall/forms');
  assert.deepEqual(list.body.forms.map((f) => [f.version, f.status]), [[0, 'published'], [1, 'superseded'], [2, 'published']], 'one published version at a time');
  assert.equal(list.body.current, 2);
  const stale = await call(kit, 'POST', `/cycles/cy-fall/forms/${v1}/publish`);
  assert.equal(stale.status, 409, 'a superseded version cannot come back without a new draft');
  assert.equal((await call(kit, 'POST', '/cycles/cy-fall/forms/fm-nope/publish')).status, 404);
  assert.equal((await call(kit, 'GET', `/cycles/cy-fall/forms/2`, { role: 'reviewer', me: { email: 'r@example.com' } })).body.form.status, 'published');
  assert.equal((await call(kit, 'POST', '/cycles/cy-fall/forms', { role: 'reviewer', me: { email: 'r@example.com' }, body: { doc } })).status, 403);
  kit.mem.cycles[0].status = 'archived';
  assert.equal((await call(kit, 'POST', '/cycles/cy-fall/forms', { body: { doc } })).status, 409);
  kit.mem.cycles[0].status = 'open';

  /* ------------------------------ public read ----------------------------- */

  meCalls = 0;
  const closedShop = await call(kit, 'GET', '/form', { anonymous: true });
  assert.equal(closedShop.status, 200);
  assert.deepEqual(closedShop.body, { open: false });
  assert.deepEqual(closedShop.headers, { 'cache-control': 'public, max-age=60' });
  kit.mem.settings.doc.intakeCycleId = 'cy-fall';
  const open = await call(kit, 'GET', '/form', { anonymous: true });
  assert.equal(open.status, 200);
  assert.equal(open.headers['cache-control'], 'public, max-age=60');
  assert.deepEqual(open.body.cycle, { id: 'cy-fall', name: 'Fall 2026', term: 'Fall 2026', closesAt: 1_800_000_000_000, subteams: [{ key: 'software', name: 'Software' }, { key: 'electrical', name: 'Electrical' }] });
  assert.equal(open.body.form.version, 2, 'the published version is served');
  assert.deepEqual(open.body.form.questions.map((q) => q.key), [...FIXED.questions.map((q) => q.key), 'github']);
  assert.deepEqual(Object.keys(open.body), ['open', 'cycle', 'form']);
  assert.deepEqual(Object.keys(open.body.form), ['version', 'sections', 'questions']);
  const keys = new Set();
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
  walk(open.body);
  for (const banned of ['count', 'counts', 'total', 'applications', 'capacity', 'ipHash', 'ip_hash', 'created', 'createdBy', 'perIpHour', 'perDay', 'email', 'intake']) assert.equal(keys.has(banned), false, 'public read leaks ' + banned);
  assert.equal(JSON.stringify(open.body).includes('@'), false, 'no addresses in the public read');
  assert.equal(meCalls, 0, 'the public read never resolves a session');

  kit.mem.applications.push({ id: 'in-x', cycleId: 'cy-fall', email: 'secret@example.com', name: 'Secret' });
  assert.equal(JSON.stringify((await call(kit, 'GET', '/form', { anonymous: true })).body).includes('secret'), false);

  kit.mem.cycles[0].formVersion = 1;
  assert.equal((await call(kit, 'GET', '/form', { anonymous: true })).body.form.version, 0, 'a version that is not published falls back to the fixed form');
  kit.mem.cycles[0].formVersion = 2;
  kit.mem.cycles[0].status = 'closed';
  assert.deepEqual((await call(kit, 'GET', '/form', { anonymous: true })).body, { open: false }, 'closed cycles publish nothing');
  kit.mem.cycles[0].status = 'open';
  kit.cycles.intakeTarget = async () => { throw new Error('tables unreachable'); };
  assert.deepEqual((await call(kit, 'GET', '/form', { anonymous: true })).body, { open: false }, 'a failing lookup reads as closed, never as an error');
}

/* ------------------------------ answer validation ----------------------- */

{
  const cycle = cycleRow();
  const doc = validateFormDoc({
    sections: [{ key: 'sw', title: 'Software', subteam: 'software' }],
    questions: [
      ...FIXED.questions.filter((q) => q.key !== 'file'),
      { key: 'lang', type: 'multi', label: 'Languages', options: ['Python', 'Rust'], section: 'sw', required: true },
      { key: 'repo', type: 'link', label: 'Repository', subteamOnly: 'electrical' },
      { key: 'agree', type: 'checkbox', label: 'I can attend', required: true },
      { key: 'cv', type: 'file', label: 'CV', accept: ['application/pdf'], maxBytes: 16 },
      { key: 'pick', type: 'single', label: 'Track', options: ['A', 'B'] },
      { key: 'nick', type: 'short', label: 'Nickname', max: 5 },
    ],
  }, cycle);
  const good = { answers: { name: '  Ada   Lovelace ', email: ' ADA@Cornell.EDU ', subteam: 'software', year: 'Junior', project: ' Built a thing ', lang: ['Rust', 'Rust'], agree: true, pick: 'B', nick: 'Adalovelace', extra: 'dropped' }, files: {} };
  const out = validateAnswers(doc, good, cycle);
  assert.deepEqual(out, {
    columns: { name: 'Ada Lovelace', email: 'ada@cornell.edu', subteam: 'Software', year: 'Junior', cornell: true },
    answers: { project: 'Built a thing', lang: ['Rust'], agree: true, pick: 'B', nick: 'Adalo' },
    files: [],
  }, 'system keys mirror to columns, unknown keys drop, values coerce and clip');
  const byName = validateAnswers(doc, { answers: { ...good.answers, subteam: 'Electrical', repo: 'https://example.com/x', lang: undefined } }, cycle);
  assert.equal(byName.columns.subteam, 'Electrical', 'subteams accept the display name');
  assert.equal(byName.answers.repo, 'https://example.com/x', 'subteamOnly questions open for that subteam');
  assert.equal('lang' in byName.answers, false, 'a section for another subteam is invisible, so its required question is skipped');
  const noTeam = validateAnswers(doc, { answers: { ...good.answers, subteam: '', repo: 'https://example.com/x', lang: undefined } }, cycle);
  assert.equal(noTeam.columns.subteam, '');
  assert.equal('repo' in noTeam.answers, false, 'hidden questions are dropped even when answered');

  const err = (answers, re, files = {}) => { const r = validateAnswers(doc, { answers: { ...good.answers, ...answers }, files }, cycle); assert.ok(r.error, 'expected an error for ' + JSON.stringify(answers)); assert.match(r.error, re); };
  err({ name: '  ' }, /Name is required/);
  err({ email: 'nope' }, /valid email/);
  err({ subteam: 'Plumbing' }, /subteam from the list/);
  err({ year: 'Sixth' }, /Choose Year/);
  err({ lang: ['Go'] }, /Choose Languages/);
  err({ lang: [] }, /Languages is required/);
  err({ agree: false }, /I can attend is required/);
  err({ agree: undefined }, /I can attend is required/);
  err({ pick: 'C' }, /Choose Track/);
  err({ repo: 'ftp://x', subteam: 'electrical', lang: undefined }, /http:\/\//);
  err({}, /did not decode/, { cv: { name: 'cv.pdf', type: 'application/pdf', data: '!!!' } });
  err({}, /CV accepts application\/pdf/, { cv: { name: 'cv.png', type: 'image/png', data: Buffer.from('12345').toString('base64') } });
  err({}, /CV is capped/, { cv: { name: 'cv.pdf', type: 'application/pdf', data: Buffer.from('this is more than sixteen bytes').toString('base64') } });
  const withFile = validateAnswers(doc, { answers: good.answers, files: { cv: { name: 'cv.pdf', type: 'application/pdf', data: Buffer.from('tiny').toString('base64') } } }, cycle);
  assert.deepEqual(withFile.files, [{ question: 'cv', name: 'cv.pdf', type: 'application/pdf', size: 4, data: Buffer.from('tiny').toString('base64') }]);
  assert.equal('cv' in withFile.answers, false, 'files never land in answers');
  const emptyFile = validateAnswers(doc, { answers: good.answers, files: { cv: { name: 'cv.pdf', type: 'application/pdf', data: '' } } }, cycle);
  assert.deepEqual(emptyFile.files, []);
  assert.equal(validateAnswers(doc, null, cycle).error, 'Name is required');
  assert.equal(validateAnswers(doc, { answers: { name: 'X' } }, cycle).error, 'Email is required');
  const fixed = validateAnswers(fixedForm(cycle), { answers: { name: 'Bo', email: 'bo@example.com', subteam: 'Electrical', project: 'p' } }, cycle);
  assert.deepEqual(fixed, { columns: { name: 'Bo', email: 'bo@example.com', subteam: 'Electrical', year: null, cornell: false }, answers: { project: 'p' }, files: [] }, 'the fixed form yields the legacy answer shape');
  assert.equal(publicForm(cycle, fixedForm(cycle)).questions.length, 6);
}

/* ------------------------------ postgres shape -------------------------- */

{
  const statements = [];
  let clash = 0;
  const row = (over) => ({ id: 'fm-1', cycle_id: 'cy-fall', version: 1, status: 'draft', created: '5', created_by: 'lead@example.com', published: null, doc: FIXED, ...over });
  const sql = (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    statements.push({ text, values });
    if (text.startsWith('INSERT INTO recruit_forms')) { if (clash-- > 0) throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }); return { rows: [row({ id: values[0] })] }; }
    if (text.startsWith('UPDATE recruit_forms SET status = CASE WHEN id = ?')) return { rows: [{ id: 'fm-0', status: 'superseded', version: 1 }, { id: values[0], status: 'published', version: 2 }] };
    if (text.startsWith('UPDATE recruit_cycles SET form_version')) return { rows: [] };
    if (text.startsWith('SELECT * FROM recruit_forms WHERE cycle_id = ? AND (?::text IS NULL OR id = ?)')) return { rows: [row({ id: values[1] || 'fm-1', version: 2, status: values[1] === 'fm-2' && statements.some((s) => s.text.startsWith('UPDATE recruit_forms SET status')) ? 'published' : 'draft' })] };
    if (text.startsWith('UPDATE recruit_forms SET doc = ?::jsonb WHERE id = ? AND cycle_id = ? AND status = \'draft\'')) return { rows: [] };
    throw new Error('Unexpected synthetic SQL: ' + text);
  };
  const audit = [];
  const kit = { mode: 'postgres', sql: async () => sql, mem: null, memSave() { throw new Error('memory writer in postgres mode'); }, now: () => 5, id: (p) => p + '-' + (statements.length + 1), async audit(r) { audit.push(r); }, cycles: { get: async () => cycleRow(), intakeTarget: async () => null } };
  const cycle = cycleRow();
  const route = (method, path) => forms.routes.find((r) => r.method === method && r.path === path);
  clash = 1;
  const created = await route('POST', '/cycles/:cycle/forms').handler({ cycle, me: { email: 'lead@example.com' }, params: { cycle: 'cy-fall' }, query: {}, body: async () => ({ doc: FIXED }) }, kit);
  assert.equal(created.status, 201);
  const inserts = statements.filter((s) => s.text.startsWith('INSERT INTO recruit_forms'));
  assert.equal(inserts.length, 2, 'one retry on the unique (cycle_id, version) clash');
  assert.match(inserts[0].text, /SELECT \?, \?, COALESCE\(MAX\(version\), 0\) \+ 1, 'draft', \?, \?, \?::jsonb FROM recruit_forms WHERE cycle_id = \? RETURNING \*/);
  assert.notEqual(inserts[0].values[0], inserts[1].values[0], 'the retry takes a fresh id');
  clash = 2;
  await assert.rejects(route('POST', '/cycles/:cycle/forms').handler({ cycle, me: { email: 'lead@example.com' }, params: { cycle: 'cy-fall' }, query: {}, body: async () => ({ doc: FIXED }) }, kit), /duplicate key/, 'a second clash surfaces');

  statements.length = 0;
  const published = await route('POST', '/cycles/:cycle/forms/:form/publish').handler({ cycle, me: { email: 'lead@example.com' }, params: { cycle: 'cy-fall', form: 'fm-2' }, query: {}, body: async () => ({}) }, kit);
  assert.equal(published.status, 200);
  const swap = statements.find((s) => s.text.startsWith('UPDATE recruit_forms SET status = CASE'));
  assert.equal(swap.text, "UPDATE recruit_forms SET status = CASE WHEN id = ? THEN 'published' WHEN status = 'published' THEN 'superseded' ELSE status END, published = CASE WHEN id = ? THEN ? ELSE published END WHERE cycle_id = ? AND (id = ? OR status = 'published') RETURNING id, status, version", 'the swap is the single statement from the spec');
  const pointer = statements.find((s) => s.text.startsWith('UPDATE recruit_cycles'));
  assert.equal(pointer.text, 'UPDATE recruit_cycles SET form_version = ? WHERE id = ? AND form_version < ?');
  assert.deepEqual(pointer.values, [2, 'cy-fall', 2]);
  assert.equal(statements.filter((s) => /^(INSERT|UPDATE|DELETE|WITH)/.test(s.text)).length, 2, 'swap plus pointer, nothing else');
  assert.deepEqual(published.audit, { kind: 'form.publish', target: null, detail: { formId: 'fm-2', version: 2 } });

  statements.length = 0;
  await assert.rejects(route('PATCH', '/cycles/:cycle/forms/:form').handler({ cycle, me: { email: 'lead@example.com' }, params: { cycle: 'cy-fall', form: 'fm-2' }, query: {}, body: async () => ({ doc: FIXED }) }, kit), (e) => e.status === 409);
  assert.match(statements[0].text, /WHERE id = \? AND cycle_id = \? AND status = 'draft' RETURNING \*/, 'draft-only edits are guarded in the WHERE');
}

const source = await readFile(new URL('../lib/recruit/modules/forms.js', import.meta.url), 'utf8');
assert.equal(/from\s+['"]\.\.?\/modules\//.test(source), false, 'no sibling imports');
assert.deepEqual([...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]), ['../fixed-form.js'], 'the only import is the pure fixed-form helper');
assert.equal(/\bBEGIN\b|\bCOMMIT\b/.test(source), false, 'no transactions');

/* ------------------------------ client (vm) ----------------------------- */

// A small DOM stand-in: nested parse of the module's own markup, selector
// matching for the subset the module uses, live focus tracking.
function makeDom() {
  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const VOID = new Set(['input', 'br', 'hr', 'img', 'path', 'circle', 'line', 'polyline', 'rect']);
  const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  let document;
  const attrOf = (node, name) => {
    if (name === 'disabled' || name === 'checked' || name === 'hidden') return node[name] ? '' : undefined;
    if (name === 'readonly') return node.readOnly ? '' : undefined;
    if (name.startsWith('data-')) return node.dataset[camel(name.slice(5))];
    return node.attrs[name];
  };
  function matchesSimple(node, simple) {
    if (!node || node === document) return false;
    let rest = simple;
    const tag = rest.match(/^[a-z0-9]+/i);
    if (tag) { if (node.tagName !== tag[0].toUpperCase()) return false; rest = rest.slice(tag[0].length); }
    for (const part of rest.matchAll(/\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|:not\(([^)]+)\)|:(checked|disabled)/g)) {
      if (part[1]) { if (!(node.attrs.class || '').split(/\s+/).includes(part[1])) return false; }
      else if (part[2]) { const v = attrOf(node, part[2]); if (v === undefined) return false; if (part[3] !== undefined && v !== part[3]) return false; }
      else if (part[4]) { if (matchesSimple(node, part[4])) return false; }
      else if (part[5]) { if (!node[part[5]]) return false; }
    }
    return true;
  }
  function matches(node, selector) {
    return selector.split(',').some((alt) => {
      const parts = alt.trim().split(/\s+(?![^[]*\])/).filter(Boolean);
      let cur = node;
      if (!matchesSimple(cur, parts[parts.length - 1])) return false;
      for (let i = parts.length - 2; i >= 0; i--) {
        cur = cur.parent;
        while (cur && cur !== document && !matchesSimple(cur, parts[i])) cur = cur.parent;
        if (!cur || cur === document) return false;
      }
      return true;
    });
  }
  function find(root, selector) { const out = []; (function walk(n) { for (const c of n.children) { if (matches(c, selector)) out.push(c); walk(c); } })(root); return out; }
  function detach(node) { for (const c of node.children) { c.isConnected = false; if (document.activeElement === c) document.activeElement = document.body; detach(c); } }
  function parse(html, root) {
    root.children = [];
    const stack = [root];
    for (const m of html.matchAll(/<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/gi)) {
      const top = stack[stack.length - 1];
      if (m[1]) { const name = m[1].toUpperCase(); for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === name) { stack.length = i; break; } }
      else if (m[2]) {
        const attrs = {};
        for (const a of m[3].matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? '' : a[2];
        const node = makeNode(m[2], attrs, top);
        top.children.push(node);
        if (!VOID.has(m[2].toLowerCase()) && !m[4]) stack.push(node);
      } else if (m[5]) {
        const text = unesc(m[5]);
        for (const n of stack) n.textContent += text;
        if (top.tagName === 'TEXTAREA') top.value += text;
      }
    }
    return root.children;
  }
  function makeNode(tagName, attrs = {}, parent = null) {
    const node = {
      tagName: tagName.toUpperCase(), attrs, dataset: {}, children: [], parent, isConnected: true, _html: '',
      value: attrs.value !== undefined ? unesc(attrs.value) : '', textContent: '', hidden: 'hidden' in attrs, disabled: 'disabled' in attrs, checked: 'checked' in attrs, readOnly: 'readonly' in attrs,
      get className() { return attrs.class || ''; }, get id() { return attrs.id || ''; }, get parentElement() { return parent; },
      getAttribute(n) { const v = attrOf(node, n); return v === undefined ? null : v; },
      setAttribute(n, v) { if (n.startsWith('data-')) node.dataset[camel(n.slice(5))] = String(v); else attrs[n] = String(v); },
      focus() { document.activeElement = node; },
      contains(x) { for (let p = x; p; p = p.parent) if (p === node) return true; return false; },
      closest(sel) { for (let p = node; p && p !== document; p = p.parent) if (matches(p, sel)) return p; return null; },
      querySelector(sel) { return find(node, sel)[0] || null; },
      querySelectorAll(sel) { return find(node, sel); },
      get innerHTML() { return node._html; },
      set innerHTML(html) { detach(node); node._html = html; node.textContent = ''; parse(html, node); },
      remove() { if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node); detach(node); node.isConnected = false; if (document.activeElement === node) document.activeElement = document.body; },
    };
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) node.dataset[camel(k.slice(5))] = unesc(v);
    return node;
  }
  document = makeNode('#document');
  document.body = makeNode('body', {}, document);
  document.children.push(document.body);
  document.activeElement = document.body;
  return { document, makeNode };
}

{
  const source = await readFile(new URL('../src/client/recruit-forms.js', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/client/main.js', import.meta.url), 'utf8');
  const focusHelpers = main.slice(main.indexOf('function focusReference'), main.indexOf('function modalFocusables'));
  assert.equal((source.match(/RECRUIT\.register\(/g) || []).length, 1, 'exactly one registration');
  assert.ok(source.startsWith('// recruit:forms:start') && source.trimEnd().endsWith('// recruit:forms:end'), 'slice markers');
  assert.equal(/<select|<datalist/i.test(source), false, 'no native selects');
  const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const { document } = makeDom();
  const requests = [], toasts = [], backgrounds = [], registered = [];
  let renders = 0, closes = 0, asyncPhase = false;
  const cycle = { id: 'cy-fall', version: 3, name: 'Fall 2026', status: 'open', formVersion: 0, doc: { subteams: [{ key: 'software', name: 'Software' }, { key: 'electrical', name: 'Electrical' }], modules: { forms: true } } };
  const ctx = vm.createContext({
    UI: { modal: null, recruit: { cycleId: 'cy-fall', cycle: { data: cycle, role: 'lead' }, apps: { key: 'cy-fall', rows: [], byId: {} }, filters: {}, selected: new Set(), detail: {}, mod: {} } },
    MD: { esc }, I: new Proxy({}, { get: () => '' }), Store: { me: () => ({ email: 'lead@example.com' }) }, recruitDate: () => 'today', REMOTE: {},
    dd: (name, options, value) => { const cur = options.find((o) => o.value === value) || options[0]; return `<button type="button" class="dd" data-action="dd" data-m="${name}" data-value="${esc(cur.value)}" data-opts="${esc(JSON.stringify(options))}" aria-haspopup="menu"><span class="dd__label">${esc(cur.label)}</span></button>`; },
    openMenu: () => {},
    toast: (t) => toasts.push(t),
    showModal(m) { ctx.UI.modal = m; document.body.innerHTML = registered[0].modals[m.kind]?.(m) || ''; },
    closeModal(after) { closes++; ctx.UI.modal = null; document.body.innerHTML = ''; if (after) after(); },
    render() { renders++; if (asyncPhase) throw new Error('render() from an async completion'); },
    renderBackground: (route) => backgrounds.push(route),
    $: (sel, root = document) => root.querySelector(sel), $$: (sel, root = document) => [...root.querySelectorAll(sel)],
    document, crypto: { randomUUID }, AbortSignal, Date, JSON,
    RECRUIT: { register: (m) => registered.push(m), api: (path, opts = {}) => new Promise((resolve, reject) => requests.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, signal: opts.signal, resolve, reject })) },
  });
  vm.runInContext(focusHelpers + source, ctx);
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const settle = () => new Promise((r) => setImmediate(r));
  const timeout = () => Object.assign(new Error('Timed out'), { name: 'TimeoutError' });
  const mod = registered[0];
  assert.equal(mod.name, 'forms');
  assert.equal(typeof mod.order, 'number');
  for (const key of [...Object.keys(mod.actions), ...Object.keys(mod.modals), ...Object.keys(mod.dd), ...Object.keys(mod.inputs)]) assert.ok(key.startsWith('recruit-'), key);

  // The settings section loads the version list once, from mount or view.
  mod.settings.mount(cycle);
  let html = mod.settings.view(cycle);
  assert.ok(html.includes('Loading…'));
  assert.equal(requests.length, 1, 'mount and view share one load');
  assert.equal(html.includes('<section'), false, 'the cycles panel supplies the section and heading');
  assert.equal(requests[0].path, '/recruit/cycles/cy-fall/forms');
  assert.ok(requests[0].signal instanceof AbortSignal, 'every fetch carries an AbortSignal');
  asyncPhase = true;
  requests[0].resolve({ forms: [{ id: null, version: 0, status: 'published', created: null, createdBy: '', published: null }, { id: 'fm-1', version: 1, status: 'draft', created: 1, createdBy: 'lead@example.com', published: null }], current: 0 });
  await settle();
  assert.deepEqual(backgrounds, ['recruit']);
  assert.equal(renders, 0);
  asyncPhase = false;
  html = mod.settings.view(cycle);
  assert.equal(/<select/i.test(html), false);
  assert.ok(html.includes('data-action="recruit-form-edit" data-id="fm-1"'));
  assert.ok(html.includes('data-action="recruit-form-publish" data-id="fm-1"'));
  assert.ok(html.includes('fixed website form'));
  assert.equal(requests.length, 1, 'the list is fetched once');

  // Editing opens the dialog at once and fills it in place when the draft arrives.
  mod.actions['recruit-form-edit']({ dataset: { id: 'fm-1', version: '1' } });
  assert.equal(ctx.UI.modal.kind, 'recruit-form-edit');
  assert.ok(document.body.innerHTML.includes('Loading…'));
  const load = requests.at(-1);
  assert.equal(load.path, '/recruit/cycles/cy-fall/forms/1');
  assert.ok(load.signal instanceof AbortSignal);
  const base = [
    { key: 'name', type: 'short', label: 'Name', required: true, system: true, options: [], max: 100, accept: [], maxBytes: null, section: null, subteamOnly: null, help: '' },
    { key: 'email', type: 'email', label: 'Email', required: true, system: true, options: [], max: 200, accept: [], maxBytes: null, section: null, subteamOnly: null, help: '' },
    { key: 'subteam', type: 'single', label: 'Subteam', required: false, system: true, options: ['Software', 'Electrical'], max: null, accept: [], maxBytes: null, section: null, subteamOnly: null, help: '' },
    { key: 'year', type: 'single', label: 'Year', required: false, system: true, options: YEARS, max: null, accept: [], maxBytes: null, section: null, subteamOnly: null, help: '' },
    { key: 'project', type: 'long', label: 'Coolest project', required: false, system: true, options: [], max: 1000, accept: [], maxBytes: null, section: null, subteamOnly: null, help: '' },
  ];
  asyncPhase = true;
  load.resolve({ form: { id: 'fm-1', version: 1, status: 'draft', doc: { sections: [], questions: base } } });
  await settle();
  const list = () => [...document.body.querySelectorAll('[data-rc-form-list] [data-key]')].map((n) => n.dataset.key);
  assert.deepEqual(list(), ['name', 'email', 'subteam', 'year', 'project']);
  assert.equal(/<select/i.test(document.body.innerHTML), false, 'no native selects in the builder');
  assert.ok(document.body.querySelector('[data-m="recruit-qtype"]'), 'the question type is a dd');
  assert.equal(renders, 0);
  assert.equal(backgrounds.length, 1, 'the open dialog repaints in place');
  assert.equal(document.body.querySelector('[data-action="recruit-form-remove"][data-q="0"]').disabled, true, 'system questions cannot be removed');
  assert.equal(document.body.querySelector('[data-action="recruit-form-required"][data-q="0"]').disabled, true, 'name stays required');
  assert.equal(document.activeElement.dataset.m, 'recruit-form-newlabel', 'focus lands on the new-question field');

  // Adding a question reads the dd value and the label; keys are derived and unique.
  const typeHost = document.body.querySelector('[data-m="recruit-qtype"]');
  mod.dd['recruit-qtype'](typeHost, 'single');
  typeHost.dataset.value = 'single';
  document.body.querySelector('[data-m="recruit-form-newlabel"]').value = 'Favourite language';
  mod.actions['recruit-form-add'](document.body.querySelector('[data-action="recruit-form-add"]'));
  assert.deepEqual(list(), ['name', 'email', 'subteam', 'year', 'project', 'favourite_language']);
  const draft = ctx.UI.recruit.mod.forms.draft;
  assert.deepEqual(plain(draft.doc.questions[5]), { key: 'favourite_language', type: 'single', label: 'Favourite language', help: '', required: false, system: false, options: [], max: null, accept: [], maxBytes: null, section: null, subteamOnly: null });
  assert.equal(document.activeElement.dataset.action, 'recruit-form-up');
  assert.equal(document.activeElement.dataset.q, '5', 'focus lands on the new row');
  assert.equal(document.body.querySelector('[data-m="recruit-form-newlabel"]').value, '');
  assert.equal(document.body.querySelector('[data-rc-qcount]').textContent, '6');
  assert.equal(draft.dirty, true);
  document.body.querySelector('[data-m="recruit-form-newlabel"]').value = 'Favourite language';
  mod.actions['recruit-form-add'](document.body.querySelector('[data-action="recruit-form-add"]'));
  assert.equal(list().at(-1), 'favourite_language_2', 'duplicate labels get a numbered key');
  mod.inputs['recruit-form-field']({ dataset: { q: '5', f: 'options' }, value: 'Python\nRust\n\n' });
  assert.deepEqual(plain(draft.doc.questions[5].options), ['Python', 'Rust']);
  mod.inputs['recruit-form-field']({ dataset: { q: '5', f: 'label' }, value: 'Language' });
  assert.equal(draft.doc.questions[5].label, 'Language');

  // Reordering keeps focus on the moved question; locked rows stay put.
  mod.actions['recruit-form-up']({ dataset: { q: '5' } });
  assert.deepEqual(list(), ['name', 'email', 'subteam', 'year', 'favourite_language', 'project', 'favourite_language_2']);
  assert.equal(document.activeElement.dataset.action, 'recruit-form-up');
  assert.equal(document.activeElement.dataset.q, '4', 'focus follows the moved question');
  mod.actions['recruit-form-down']({ dataset: { q: '4' } });
  assert.equal(list()[5], 'favourite_language');
  assert.equal(document.activeElement.dataset.action, 'recruit-form-down');
  assert.equal(document.activeElement.dataset.q, '5');
  mod.actions['recruit-form-up']({ dataset: { q: '0' } });
  assert.equal(list()[0], 'name');
  mod.actions['recruit-form-remove']({ dataset: { q: '0' } });
  assert.equal(list()[0], 'name', 'system questions cannot be removed');
  mod.actions['recruit-form-remove']({ dataset: { q: '6' } });
  assert.deepEqual(list(), ['name', 'email', 'subteam', 'year', 'project', 'favourite_language']);
  mod.actions['recruit-form-required']({ dataset: { q: '5' }, checked: true }, { stopPropagation() {} });
  assert.equal(draft.doc.questions[5].required, true);

  // Sections per subteam through dd choices.
  document.body.querySelector('[data-m="recruit-form-newsection"]').value = 'Software questions';
  mod.actions['recruit-form-section-add'](document.body.querySelector('[data-action="recruit-form-section-add"]'));
  assert.deepEqual(plain(draft.doc.sections), [{ key: 'software_questions', title: 'Software questions', subteam: null }]);
  assert.equal(document.activeElement.dataset.action, 'recruit-form-section-remove');
  const steam = document.body.querySelector('[data-rc-sections] [data-m="recruit-form-steam"]');
  assert.ok(steam.dataset.opts.includes('Electrical'), 'subteams are dd choices');
  mod.dd['recruit-form-steam'](steam, 'software');
  assert.equal(draft.doc.sections[0].subteam, 'software');
  const qsection = document.body.querySelector('[data-q="5"] [data-m="recruit-form-qsection"]');
  assert.ok(qsection.dataset.opts.includes('Software questions'), 'sections are dd choices');
  mod.dd['recruit-form-qsection'](qsection, 'software_questions');
  assert.equal(draft.doc.questions[5].section, 'software_questions');
  mod.dd['recruit-form-qteam'](document.body.querySelector('[data-q="5"] [data-m="recruit-form-qteam"]'), 'electrical');
  assert.equal(draft.doc.questions[5].subteamOnly, 'electrical');
  mod.actions['recruit-form-section-remove']({ dataset: { s: '0' } });
  assert.deepEqual(plain(draft.doc.sections), []);
  assert.equal(draft.doc.questions[5].section, null, 'questions in a removed section drop the pointer');

  // Save: focus stays on the button, a timeout retries the same body, no render.
  const saveButton = document.body.querySelector('[data-action="recruit-form-save"]');
  saveButton.focus();
  mod.actions['recruit-form-save']();
  const patch = requests.at(-1);
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.path, '/recruit/cycles/cy-fall/forms/fm-1');
  assert.ok(patch.signal instanceof AbortSignal);
  assert.equal(patch.body.doc.questions.length, 6);
  assert.equal(patch.body.doc.questions[5].key, 'favourite_language');
  assert.equal(document.activeElement.dataset.action, 'recruit-form-save', 'focus stays on the save button while it repaints');
  assert.equal(document.activeElement.textContent, 'Saving…');
  mod.actions['recruit-form-save']();
  assert.equal(requests.at(-1), patch, 'no duplicate save while pending');
  patch.reject(timeout());
  await settle();
  assert.equal(document.body.querySelector('[data-rc-error]').textContent, 'The request timed out. Try again.');
  assert.equal(document.activeElement.dataset.action, 'recruit-form-save');
  assert.equal(document.activeElement.disabled, false);
  mod.actions['recruit-form-save']();
  const retry = requests.at(-1);
  assert.deepEqual(retry.body, patch.body, 'the retry sends the same draft');
  retry.resolve({ form: { id: 'fm-1', version: 1, status: 'draft', created: 1, createdBy: 'lead@example.com', published: null, doc: retry.body.doc } });
  await settle();
  assert.equal(toasts.at(-1), 'Draft saved');
  assert.equal(renders, 0, 'no render() from the async completion');
  assert.equal(closes, 0);
  assert.equal(backgrounds.length, 1);
  assert.equal(draft.dirty, false);
  assert.equal(document.activeElement.dataset.action, 'recruit-form-save');

  // Save and publish closes the dialog and repaints through renderBackground.
  mod.actions['recruit-form-publish-draft']();
  const patch2 = requests.at(-1);
  assert.equal(patch2.method, 'PATCH');
  patch2.resolve({ form: { id: 'fm-1', version: 1, status: 'draft', created: 1, createdBy: 'lead@example.com', published: null, doc: patch2.body.doc } });
  await settle();
  const publish = requests.at(-1);
  assert.equal(publish.method, 'POST');
  assert.equal(publish.path, '/recruit/cycles/cy-fall/forms/fm-1/publish');
  assert.ok(publish.signal instanceof AbortSignal);
  publish.resolve({ form: { id: 'fm-1', version: 1, status: 'published', published: 9, created: 1, createdBy: 'lead@example.com' }, current: 1 });
  await settle();
  assert.equal(closes, 1);
  assert.deepEqual(backgrounds, ['recruit', 'recruit']);
  assert.equal(toasts.at(-1), 'Form version 1 published');
  assert.equal(ctx.UI.recruit.cycle.data.formVersion, 1, 'the cached cycle points at the new version');
  assert.equal(ctx.UI.recruit.mod.forms.list.current, 1);
  assert.equal(ctx.UI.recruit.mod.forms.list.forms.find((f) => f.id === 'fm-1').status, 'published');
  assert.equal(ctx.UI.recruit.mod.forms.draft, null);
  assert.equal(renders, 0);

  // Copying makes a fresh draft: POST rather than PATCH.
  mod.actions['recruit-form-copy']({ dataset: { version: '1' } });
  const get = requests.at(-1);
  assert.equal(get.path, '/recruit/cycles/cy-fall/forms/1');
  get.resolve({ form: { id: 'fm-1', version: 1, status: 'published', doc: patch2.body.doc } });
  await settle();
  assert.equal(ctx.UI.recruit.mod.forms.draft.id, null);
  assert.equal(ctx.UI.recruit.mod.forms.draft.isNew, true);
  assert.ok(document.body.querySelector('[data-rc-title]').textContent.includes('New form draft'));
  assert.deepEqual(list(), ['name', 'email', 'subteam', 'year', 'project', 'favourite_language']);
  mod.actions['recruit-form-save']();
  const post = requests.at(-1);
  assert.equal(post.method, 'POST');
  assert.equal(post.path, '/recruit/cycles/cy-fall/forms');
  post.resolve({ form: { id: 'fm-2', version: 2, status: 'draft', created: 2, createdBy: 'lead@example.com', published: null, doc: post.body.doc } });
  await settle();
  assert.equal(ctx.UI.recruit.mod.forms.draft.id, 'fm-2');
  assert.ok(document.body.querySelector('[data-rc-title]').textContent.includes('version 2'));
  assert.equal(ctx.UI.recruit.mod.forms.list.forms.at(-1).id, 'fm-2');

  // Publishing from the list confirms first, then repaints through renderBackground.
  ctx.UI.modal = null;
  document.body.innerHTML = mod.settings.view(cycle);
  mod.actions['recruit-form-publish']({ dataset: { id: 'fm-2', version: '2' } });
  assert.equal(ctx.UI.modal.kind, 'confirm');
  assert.equal(ctx.UI.modal.confirm, 'Publish');
  document.body.innerHTML = mod.settings.view(cycle);
  ctx.UI.modal.onGo();
  const publish2 = requests.at(-1);
  assert.equal(publish2.path, '/recruit/cycles/cy-fall/forms/fm-2/publish');
  assert.equal(document.body.querySelector('[data-action="recruit-form-publish"][data-id="fm-2"]').textContent, 'Publishing…');
  publish2.resolve({ form: { id: 'fm-2', version: 2, status: 'published', published: 10 }, current: 2 });
  await settle();
  assert.equal(ctx.UI.recruit.cycle.data.formVersion, 2);
  assert.equal(backgrounds.at(-1), 'recruit');
  assert.equal(toasts.at(-1), 'Form version 2 published');
  assert.equal(ctx.UI.recruit.mod.forms.list.forms.find((f) => f.id === 'fm-1').status, 'superseded');
  assert.equal(ctx.UI.recruit.mod.forms.list.forms.find((f) => f.version === 0).status, 'published', 'version 0 is never superseded');
  assert.equal(renders, 0);

  // A late answer for another cycle is dropped after a switch.
  ctx.UI.recruit.cycleId = 'cy-spring';
  ctx.UI.recruit.cycle = { data: { ...cycle, id: 'cy-spring' }, role: 'lead' };
  mod.settings.view(ctx.UI.recruit.cycle.data);
  const springList = requests.at(-1);
  assert.equal(springList.path, '/recruit/cycles/cy-spring/forms');
  ctx.UI.recruit.cycleId = 'cy-fall';
  ctx.UI.recruit.cycle = { data: cycle, role: 'lead' };
  mod.settings.view(cycle);
  const bg = backgrounds.length;
  springList.resolve({ forms: [], current: 0 });
  await settle();
  assert.equal(backgrounds.length, bg, 'a late answer for another cycle is ignored');
  asyncPhase = false;

  // Preview build: no REMOTE, no requests.
  delete ctx.REMOTE;
  const count = requests.length;
  assert.ok(mod.settings.view(cycle).includes('need the live wiki'));
  assert.equal(requests.length, count);
  ctx.REMOTE = {};
}

console.log('PASS: version 0 equals the fixed form, one-statement publish creates an immutable version, per-type answer validation, public read serves only published forms of the open intake cycle with no PII, unique-version retry; client builder adds and reorders questions through dd() with focus kept, saves and publishes without render()');
