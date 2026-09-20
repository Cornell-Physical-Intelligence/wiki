// Synthetic fixtures only: an in-memory kit and a fake registry drive the real
// review module; a recording SQL tag checks statement shape. No storage,
// network, credentials or repo .dev*.json files.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

globalThis.fetch = async () => { throw new Error('Network disabled in tests'); };
const review = (await import('../lib/recruit/modules/review.js')).default;
const { planAssignments, computeTotal, aggregateOf, normalizeRubric, DEFAULT_RUBRIC } = await import('../lib/recruit/modules/review.js');

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

const STAGES = [{ key: 'applied', name: 'Applied', kind: 'open' }, { key: 'screening', name: 'Screening', kind: 'open' }, { key: 'accepted', name: 'Accepted', kind: 'closed', outcome: 'accepted' }, { key: 'rejected', name: 'Rejected', kind: 'closed', outcome: 'rejected' }];
const cycleRow = (over = {}) => ({
  id: 'cy-fall', version: 3, status: 'open', name: 'Fall 2026', term: 'Fall 2026', formVersion: 0,
  doc: { subteams: [{ key: 'software', name: 'Software' }, { key: 'electrical', name: 'Electrical' }], modules: { review: true }, pipeline: { stages: STAGES }, review: { blind: 'until-submitted', visibility: 'assigned', perApplication: 2, rubric: DEFAULT_RUBRIC },
    interviews: { rounds: [{ key: 'r1', name: 'Interview', minutes: 20, rubric: { version: 2, scale: 4, criteria: [{ key: 'depth', name: 'Depth', weight: 1 }] } }] } },
  ...over,
});
const app = (id, over = {}) => ({ id, cycleId: 'cy-fall', email: `${id.slice(3)}@example.com`, ts: Number(id.slice(3).charCodeAt(0)), updated: 1, name: 'Person ' + id.slice(3).toUpperCase(), subteam: 'Software', year: 'Junior', stage: 'applied', tags: [], editVersion: 0, ...over });

function makeKit(modules, seed = {}) {
  const mem = { settings: { version: 1, doc: {} }, cycles: [], applications: [], requests: {}, audit: [], roles: [], ...seed };
  for (const m of modules) for (const [k, v] of Object.entries(m.memory || {})) mem[k] ||= structuredClone(v);
  let n = 0, clock = 1_700_000_000_000;
  const kit = {
    mode: 'memory', mem, saves: 0, events: [],
    memSave() { this.saves++; },
    id: (p) => `${p}-${(++n).toString(36).padStart(4, '0')}`,
    now: () => (clock += 1000),
    async once(requestId, actor, run) {
      const hit = mem.requests[requestId];
      if (hit) return { ...hit.result, replayed: true };
      const result = await run();
      mem.requests[requestId] = { ts: kit.now(), actor, result };
      return result;
    },
    async audit(row) { mem.audit.push({ id: kit.id('au'), ts: kit.now(), ...row }); },
    async emit(event, payload) { kit.events.push({ event, payload }); for (const m of modules) if (m.hooks?.[event]) await m.hooks[event](payload, kit); },
    async collect(event, payload) {
      const outs = [];
      for (const m of modules) if (m.collect?.[event]) outs.push(await m.collect[event](payload, kit));
      if (event === 'scope.applications') { const s = new Set(); for (const o of outs) for (const id of o) s.add(id); return s; }
      if (event === 'application.extras') { const merged = {}; for (const o of outs) for (const [id, x] of Object.entries(o)) merged[id] = { ...(merged[id] || {}), ...x }; return merged; }
      return outs.flat();
    },
    cycles: { get: async (id) => mem.cycles.find((c) => c.id === id) || null, intakeTarget: async () => null, enabled: () => true },
    apps: { get: async (cycle, id) => { const a = mem.applications.find((x) => x.id === id && x.cycleId === cycle.id); return a ? { ...a } : null; } },
    roles: {
      grantFor: async (cycleId, email) => mem.roles.find((r) => r.cycleId === cycleId && r.member === email) || null,
      roleOf: () => null,
      roster: async () => [{ email: 'ann@example.com', name: 'Ann Reviewer', role: 'member', subteam: 'Software' }, { email: 'bob@example.com', name: 'Bob Reviewer', role: 'member', subteam: 'Electrical' }, { email: 'lead@example.com', name: 'Lead Person', role: 'admin', subteam: '' }],
    },
    json: (status, body, headers) => ({ status, body, headers }),
  };
  return kit;
}

const LEAD = { email: 'lead@example.com', name: 'Lead Person' };
const ANN = { email: 'ann@example.com', name: 'Ann Reviewer' };
const BOB = { email: 'bob@example.com', name: 'Bob Reviewer' };
const CAM = { email: 'cam@example.com', name: 'Cam Reviewer' };

async function call(kit, method, path, { me = LEAD, role = 'lead', body = {}, query = {} } = {}) {
  for (const route of review.routes) {
    if (route.method !== method) continue;
    const { re, names } = compile(route.path);
    const m = path.match(re);
    if (!m) continue;
    const params = Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(m[i + 1])]));
    if (params.member) params.member = params.member.toLowerCase();
    if (!allowed(route.access, role)) return { status: 403, body: { error: role ? 'Not allowed in this cycle' : 'Admins only' } };
    const cycle = params.cycle ? await kit.cycles.get(params.cycle) : null;
    if (params.cycle && !cycle) return { status: 404, body: { error: 'No such cycle' } };
    if (route.mutates && cycle?.status === 'archived') return { status: 409, body: { error: 'This cycle is archived' } };
    const scope = route.scoped && (role === 'reviewer' || role === 'interviewer') ? await kit.collect('scope.applications', { cycle, me, role }) : null;
    const rq = { method, path, params, query, me, role, grant: null, cycle, body: async () => body, req: {}, res: {}, scope };
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
const asAnn = { me: ANN, role: 'reviewer' };
const asBob = { me: BOB, role: 'reviewer' };
const asCam = { me: CAM, role: 'reviewer' };

/* ------------------------------ contract shape --------------------------- */

assert.equal(review.name, 'review');
assert.equal(review.kernel, false);
assert.deepEqual(Object.keys(review.memory), ['assignments', 'scores']);
assert.equal(review.schema.filter((s) => s.startsWith('CREATE TABLE IF NOT EXISTS recruit_assignments')).length, 1);
assert.equal(review.schema.filter((s) => s.startsWith('CREATE TABLE IF NOT EXISTS recruit_scores')).length, 1);
assert.ok(review.schema.every((s) => /^CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS /.test(s)), 'additive DDL only');
for (const r of review.routes) { compile(r.path); assert.ok(r.access, r.path + ' declares access'); }
assert.deepEqual(review.auditKinds, ['assign', 'unassign', 'score', 'coi']);
assert.deepEqual(Object.keys(review.collect), ['scope.applications', 'application.extras', 'csv.columns', 'purge']);
assert.deepEqual(Object.keys(review.hooks), ['stage.moved', 'booking.created']);

/* ------------------------------ pure planning --------------------------- */

{
  const applications = ['in-f', 'in-b', 'in-d', 'in-a', 'in-e', 'in-c'].map((id) => app(id));
  const members = ['cam@example.com', 'ann@example.com', 'bob@example.com'];
  const plan = planAssignments({ applications, members, perApplication: 2 });
  assert.equal(plan.length, 12);
  const count = (email) => plan.filter((p) => p.member === email).length;
  assert.deepEqual(members.map(count), [4, 4, 4], 'round-robin balances the load');
  assert.deepEqual(plan.slice(0, 2), [{ applicationId: 'in-a', member: 'ann@example.com' }, { applicationId: 'in-a', member: 'bob@example.com' }], 'applications by ts, members by load then email');
  assert.deepEqual(planAssignments({ applications: [...applications].reverse(), members: [...members].reverse(), perApplication: 2 }), plan, 'input order never changes the plan');
  assert.equal(new Set(plan.map((p) => p.applicationId + '|' + p.member)).size, 12, 'no member reviews the same application twice');
  const loaded = planAssignments({ applications, members, perApplication: 1, load: { 'ann@example.com': 10, 'bob@example.com': 10 } });
  assert.deepEqual(loaded.map((p) => p.member), Array(6).fill('cam@example.com'), 'existing load is balanced against, not just this batch');
  const coi = new Set(['in-a|ann@example.com']);
  const skipped = planAssignments({ applications, members: ['ann@example.com'], perApplication: 1, coi });
  assert.equal(skipped.some((p) => p.applicationId === 'in-a'), false, 'a conflict of interest blocks the pair');
  assert.equal(skipped.length, 5);
  const self = planAssignments({ applications: [app('in-x', { email: 'ann@example.com' })], members: ['ann@example.com', 'bob@example.com'], perApplication: 2 });
  assert.deepEqual(self, [{ applicationId: 'in-x', member: 'bob@example.com' }], 'nobody reviews their own application');
  const pooled = planAssignments({ applications: [app('in-a', { subteam: 'software' }), app('in-b', { subteam: 'electrical' })], members: [{ email: 'ann@example.com', subteams: ['software'] }, { email: 'bob@example.com', subteams: [] }], perApplication: 1, bySubteam: true });
  assert.deepEqual(pooled, [{ applicationId: 'in-a', member: 'ann@example.com' }, { applicationId: 'in-b', member: 'bob@example.com' }], 'subteam pools narrow eligibility; [] means every subteam');
  assert.deepEqual(planAssignments({ applications, members: [], perApplication: 2 }), []);
}

/* --------------------------- totals and aggregates ---------------------- */

{
  const rubric = normalizeRubric(DEFAULT_RUBRIC);
  assert.deepEqual(computeTotal(rubric, { motivation: 5, skills: 3, teamwork: 1 }), { scores: { motivation: 5, skills: 3, teamwork: 1 }, total: 3 }, '(5·1 + 3·2 + 1·1) / 4');
  assert.deepEqual(computeTotal(rubric, { motivation: 4, skills: 5 }), { scores: { motivation: 4, skills: 5 }, total: 4.67 }, 'partial drafts weight only what was scored');
  assert.deepEqual(computeTotal(rubric, { mystery: 5 }), { scores: {}, total: null }, 'unknown criteria are dropped');
  assert.throws(() => computeTotal(rubric, { motivation: 6 }), (e) => e.status === 400 && /1 to 5/.test(e.error));
  assert.throws(() => computeTotal(rubric, { motivation: 2.5 }), (e) => e.status === 400);
  assert.throws(() => computeTotal(rubric, 'no'), (e) => e.status === 400);
  const rows = [
    { submitted: 1, doc: { total: 4, scores: { a: 4 }, recommendation: 'yes' } },
    { submitted: 2, doc: { total: 2, scores: { a: 2 }, recommendation: 'no' } },
    { submitted: null, doc: { total: 5, scores: { a: 5 } } },
    { submitted: 3, doc: { total: null, scores: {}, conflict: true } },
  ];
  assert.deepEqual(aggregateOf(rows), { n: 2, mean: 3, spread: 2, byCriterion: { a: 3 }, recommendations: { yes: 1, no: 1 } }, 'drafts and conflicts never count');
  assert.equal(aggregateOf([]), null);
  assert.throws(() => review.validateSettings({ blind: 'sometimes' }), (e) => e.status === 400);
  assert.throws(() => review.validateSettings({ perApplication: 0 }), (e) => e.status === 400);
  assert.throws(() => review.validateSettings({ rubric: { criteria: [{ key: 'a', name: 'A', weight: 0 }] } }), (e) => e.status === 400);
  assert.throws(() => review.validateSettings({ rubric: { criteria: [{ key: 'a', name: 'A' }, { key: 'a', name: 'B' }] } }), (e) => /used twice/.test(e.error));
  const normalized = review.validateSettings({ blind: 'off', rubric: { scale: 7, criteria: [{ key: 'fit', name: ' Fit ', weight: '2' }] } });
  assert.deepEqual(normalized, { blind: 'off', visibility: 'assigned', perApplication: 2, editAfterSubmit: false, rubric: { version: 1, scale: 7, criteria: [{ key: 'fit', name: 'Fit', weight: 2, help: '' }] } });
}

/* --------------------------- assignments (memory) ----------------------- */

const seed = () => ({ cycles: [cycleRow()], applications: ['in-a', 'in-b', 'in-c', 'in-d'].map((id) => app(id)), roles: [{ cycleId: 'cy-fall', member: 'ann@example.com', roles: ['reviewer'], subteams: ['software'] }, { cycleId: 'cy-fall', member: 'bob@example.com', roles: ['reviewer'], subteams: [] }] });

{
  const kit = makeKit([review], seed());
  const body = { requestId: 'rq-11111111-aaaa', ids: ['in-a', 'in-b', 'in-c', 'in-d', 'in-zz'], kind: 'reviewer', members: ['Ann@example.com', 'bob@example.com'], mode: 'round-robin', perApplication: 1 };
  const dry = await call(kit, 'POST', '/cycles/cy-fall/assignments', { body: { ...body, dryRun: true } });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.deepEqual(dry.body, { created: 0, existing: 0, plan: [{ applicationId: 'in-a', member: 'ann@example.com' }, { applicationId: 'in-b', member: 'bob@example.com' }, { applicationId: 'in-c', member: 'ann@example.com' }, { applicationId: 'in-d', member: 'bob@example.com' }], skipped: [], unknown: 1 });
  assert.equal(kit.mem.assignments.length, 0, 'a dry run writes nothing');
  const out = await call(kit, 'POST', '/cycles/cy-fall/assignments', { body });
  assert.equal(out.status, 200);
  assert.equal(out.body.created, 4);
  assert.equal(out.body.existing, 0);
  assert.equal(kit.mem.assignments.length, 4);
  assert.deepEqual(kit.mem.assignments.map((a) => [a.applicationId, a.member, a.kind, a.round, a.status]), [['in-a', 'ann@example.com', 'reviewer', '', 'open'], ['in-b', 'bob@example.com', 'reviewer', '', 'open'], ['in-c', 'ann@example.com', 'reviewer', '', 'open'], ['in-d', 'bob@example.com', 'reviewer', '', 'open']]);
  assert.deepEqual(kit.mem.audit.map((a) => [a.kind, a.detail.created, a.detail.planned]), [['assign', 4, 4]]);
  const replay = await call(kit, 'POST', '/cycles/cy-fall/assignments', { body });
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.created, 4, 'the stored result comes back');
  assert.equal(kit.mem.assignments.length, 4);
  assert.equal(kit.mem.audit.length, 1);
  const again = await call(kit, 'POST', '/cycles/cy-fall/assignments', { body: { ...body, requestId: 'rq-22222222-bbbb', perApplication: 2 } });
  assert.equal(again.body.created, 4, 'second reviewer added to each');
  assert.equal(again.body.existing, 4, 'pairs already on file are counted, not duplicated');
  assert.equal(kit.mem.assignments.length, 8);
  const manual = await call(kit, 'POST', '/cycles/cy-fall/assignments', { body: { requestId: 'rq-33333333-cccc', ids: ['in-a'], kind: 'review', members: ['ann@example.com'], mode: 'manual' } });
  assert.deepEqual([manual.body.created, manual.body.existing], [0, 1], 'ON CONFLICT DO NOTHING keeps the natural key unique');

  const bad = async (body, re) => { const o = await call(kit, 'POST', '/cycles/cy-fall/assignments', { body }); assert.equal(o.status, 400, JSON.stringify(o.body)); assert.match(o.body.error, re); };
  await bad({ ids: ['in-a'], members: ['ann@example.com'] }, /request id/);
  await bad({ requestId: 'rq-44444444-dddd', ids: ['in-a'] }, /at least one reviewer/);
  await bad({ requestId: 'rq-44444444-dddd', ids: ['in-a'], members: ['not an email'] }, /by email/);
  await bad({ requestId: 'rq-44444444-dddd', ids: ['in-a'], members: ['ann@example.com'], kind: 'judge' }, /reviewers or interviewers/);
  await bad({ requestId: 'rq-44444444-dddd', ids: ['in-a'], members: ['ann@example.com'], perApplication: 11 }, /1 to 10/);
  await bad({ requestId: 'rq-44444444-dddd', ids: ['in-a'], members: ['ann@example.com'], round: 'Round One' }, /Unknown round/);
  assert.equal((await call(kit, 'POST', '/cycles/cy-fall/assignments', { ...asAnn, body })).status, 403, 'reviewers cannot assign');

  // Listing: reviewers see their own rows only, in SQL terms member = me.
  const mine = await call(kit, 'GET', '/cycles/cy-fall/assignments', asAnn);
  assert.deepEqual(mine.body.assignments.map((a) => a.applicationId + '/' + a.member), ['in-a/ann@example.com', 'in-c/ann@example.com', 'in-b/ann@example.com', 'in-d/ann@example.com']);
  assert.deepEqual(mine.body.load, []);
  const all = await call(kit, 'GET', '/cycles/cy-fall/assignments');
  assert.equal(all.body.assignments.length, 8);
  assert.deepEqual(all.body.load, [{ member: 'ann@example.com', name: 'Ann Reviewer', assigned: 4, done: 0, coi: 0, mean: null }, { member: 'bob@example.com', name: 'Bob Reviewer', assigned: 4, done: 0, coi: 0, mean: null }]);
  const one = await call(kit, 'GET', '/cycles/cy-fall/assignments', { query: { member: 'BOB@example.com' } });
  assert.equal(one.body.assignments.length, 4);

  // Unassign by natural key, including an empty round segment.
  const gone = await call(kit, 'DELETE', '/cycles/cy-fall/assignments/in-d/bob%40example.com/review/');
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.equal(kit.mem.assignments.length, 7);
  assert.equal(kit.mem.audit.at(-1).kind, 'unassign');
  assert.equal(kit.mem.audit.at(-1).applicationId, 'in-d');
  assert.equal((await call(kit, 'DELETE', '/cycles/cy-fall/assignments/in-d/bob%40example.com/review/')).status, 404);

  // Subteam pools read grants: Ann only takes software, Bob takes anything.
  kit.mem.applications.push(app('in-e', { subteam: 'Electrical' }), app('in-f', { subteam: 'Electrical' }));
  const pooled = await call(kit, 'POST', '/cycles/cy-fall/assignments', { body: { requestId: 'rq-55555555-eeee', ids: ['in-e', 'in-f'], members: ['ann@example.com', 'bob@example.com'], perApplication: 1, bySubteam: true } });
  assert.deepEqual(pooled.body.plan.map((p) => p.member), ['bob@example.com', 'bob@example.com'], 'bySubteam honours each reviewer\'s grant');
}

/* ---------------------- scoping, blind scoring, locks ------------------- */

{
  const kit = makeKit([review], seed());
  await call(kit, 'POST', '/cycles/cy-fall/assignments', { body: { requestId: 'rq-11111111-aaaa', ids: ['in-a', 'in-b'], members: ['ann@example.com', 'bob@example.com'], perApplication: 2 } });
  const scope = await kit.collect('scope.applications', { cycle: kit.mem.cycles[0], me: ANN, role: 'reviewer' });
  assert.deepEqual([...scope].sort(), ['in-a', 'in-b'], 'the scope collector returns assigned ids');
  assert.deepEqual([...await kit.collect('scope.applications', { cycle: kit.mem.cycles[0], me: CAM, role: 'reviewer' })], [], 'an unassigned reviewer sees nothing');

  const hidden = await call(kit, 'GET', '/cycles/cy-fall/applications/in-c/scores', asAnn);
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.error, 'No such application', 'outside the scope an application does not exist');
  assert.equal((await call(kit, 'PUT', '/cycles/cy-fall/applications/in-c/scores/review', { ...asAnn, body: { scores: { motivation: 5 } } })).status, 404);
  assert.equal((await call(kit, 'GET', '/cycles/cy-fall/applications/in-a/scores', asCam)).status, 404);
  assert.equal((await call(kit, 'GET', '/cycles/cy-fall/applications/in-a/scores', { me: LEAD, role: null })).status, 403);

  const empty = await call(kit, 'GET', '/cycles/cy-fall/applications/in-a/scores', asAnn);
  assert.equal(empty.status, 200);
  assert.deepEqual({ mine: empty.body.mine, others: empty.body.others, aggregate: empty.body.aggregate, blind: empty.body.blind }, { mine: null, others: null, aggregate: null, blind: 'until-submitted' });
  assert.equal(empty.body.rubric.version, 1);

  const draft = await call(kit, 'PUT', '/cycles/cy-fall/applications/in-a/scores/review', { ...asAnn, body: { rubricVersion: 1, scores: { motivation: 4, skills: 5 }, notes: '  keen  ', recommendation: 'yes' } });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  assert.equal(draft.body.score.submitted, null);
  assert.deepEqual(draft.body.score.doc, { scores: { motivation: 4, skills: 5 }, total: 4.67, notes: 'keen', recommendation: 'yes', conflict: false });
  assert.equal(draft.body.aggregate, null, 'blind until submitted');
  assert.equal(kit.mem.assignments.find((a) => a.member === 'ann@example.com' && a.applicationId === 'in-a').status, 'open', 'a draft does not finish the assignment');
  assert.equal(kit.mem.audit.at(-1).kind, 'score');
  assert.deepEqual(kit.mem.audit.at(-1).detail, { kind: 'review', round: '', submitted: false, conflict: false });

  const partial = await call(kit, 'PUT', '/cycles/cy-fall/applications/in-a/scores/review', { ...asAnn, body: { scores: { motivation: 4, skills: 5 }, submit: true } });
  assert.equal(partial.status, 400);
  assert.match(partial.body.error, /every criterion/);
  assert.equal((await call(kit, 'PUT', '/cycles/cy-fall/applications/in-a/scores/review', { ...asAnn, body: { rubricVersion: 9, scores: {} } })).status, 409, 'a stale rubric version is refused');
  assert.equal((await call(kit, 'PUT', '/cycles/cy-fall/applications/in-a/scores/review', { ...asAnn, body: { scores: { motivation: 5 }, recommendation: 'meh' } })).status, 400);

  const bobs = await call(kit, 'PUT', '/cycles/cy-fall/applications/in-a/scores/review', { ...asBob, body: { scores: { motivation: 2, skills: 2, teamwork: 2 }, recommendation: 'no', submit: true } });
  assert.equal(bobs.status, 200);
  assert.ok(bobs.body.score.submitted);
  assert.deepEqual(bobs.body.aggregate, { n: 1, mean: 2, spread: 0, byCriterion: { motivation: 2, skills: 2, teamwork: 2 }, recommendations: { no: 1 } }, 'once submitted the aggregate opens up');
  assert.equal(kit.mem.assignments.find((a) => a.member === 'bob@example.com' && a.applicationId === 'in-a').status, 'done');

  const still = await call(kit, 'GET', '/cycles/cy-fall/applications/in-a/scores', asAnn);
  assert.equal(still.body.mine.doc.total, 4.67);
  assert.equal(still.body.others, null, 'Ann has not submitted, so Bob stays hidden');
  assert.equal(still.body.aggregate, null);
  const bobView = await call(kit, 'GET', '/cycles/cy-fall/applications/in-a/scores', asBob);
  assert.deepEqual(bobView.body.others, [], 'Bob sees no drafts, only submitted scorecards');
  assert.equal(bobView.body.aggregate.n, 1);
  const leadView = await call(kit, 'GET', '/cycles/cy-fall/applications/in-a/scores');
  assert.equal(leadView.body.mine, null);
  assert.deepEqual(leadView.body.others.map((o) => o.member), ['bob@example.com'], 'leads always see submitted scorecards');

  const submitted = await call(kit, 'PUT', '/cycles/cy-fall/applications/in-a/scores/review', { ...asAnn, body: { scores: { motivation: 4, skills: 5, teamwork: 3 }, notes: 'keen', recommendation: 'strong_yes', submit: true } });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.score.doc.total, 4.25);
  assert.deepEqual(submitted.body.aggregate, { n: 2, mean: 3.13, spread: 2.25, byCriterion: { motivation: 3, skills: 3.5, teamwork: 2.5 }, recommendations: { strong_yes: 1, no: 1 } }, 'weights apply per criterion, mean over totals');
  const opened = await call(kit, 'GET', '/cycles/cy-fall/applications/in-a/scores', asAnn);
  assert.deepEqual(opened.body.others.map((o) => [o.member, o.doc.total]), [['bob@example.com', 2]], 'after submitting, the other scorecards appear');

  const locked = await call(kit, 'PUT', '/cycles/cy-fall/applications/in-a/scores/review', { ...asAnn, body: { scores: { motivation: 1, skills: 1, teamwork: 1 }, submit: true } });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.error, 'This scorecard was submitted and is locked');
  assert.equal(kit.mem.scores.find((s) => s.member === 'ann@example.com').doc.total, 4.25, 'the locked row is untouched');
  kit.mem.cycles[0].doc.review.editAfterSubmit = true;
  const edited = await call(kit, 'PUT', '/cycles/cy-fall/applications/in-a/scores/review', { ...asAnn, body: { scores: { motivation: 5, skills: 5, teamwork: 5 }, submit: true } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.score.doc.total, 5);
  assert.equal(edited.body.score.submitted, submitted.body.score.submitted, 'the first submission time stays');
  kit.mem.cycles[0].doc.review.editAfterSubmit = false;

  kit.mem.cycles[0].doc.review.blind = 'off';
  const off = await call(kit, 'GET', '/cycles/cy-fall/applications/in-b/scores', asAnn);
  assert.deepEqual(off.body, { mine: null, others: [], aggregate: null, rubric: off.body.rubric, blind: 'off' }, 'with blind off, others are visible before scoring');
  kit.mem.cycles[0].doc.review.blind = 'until-submitted';

  // visibility:'all' opens every application in the cycle to reviewers.
  kit.mem.cycles[0].doc.review.visibility = 'all';
  assert.deepEqual([...await kit.collect('scope.applications', { cycle: kit.mem.cycles[0], me: CAM, role: 'reviewer' })].sort(), ['in-a', 'in-b', 'in-c', 'in-d']);
  const cams = await call(kit, 'PUT', '/cycles/cy-fall/applications/in-c/scores/review', { ...asCam, body: { scores: { motivation: 3, skills: 3, teamwork: 3 }, submit: true } });
  assert.equal(cams.status, 200, 'unassigned reviewers may score when visibility is all');
  kit.mem.cycles[0].doc.review.visibility = 'assigned';
  assert.equal((await call(kit, 'PUT', '/cycles/cy-fall/applications/in-c/scores/review', { me: LEAD, role: 'lead', body: { scores: { motivation: 3 } } })).status, 200, 'leads score without an assignment');

  // Interview scorecards use the round's rubric.
  kit.mem.assignments.push({ applicationId: 'in-b', member: 'ann@example.com', kind: 'interviewer', round: 'r1', status: 'open', created: 1, createdBy: 'x' });
  const iv = await call(kit, 'PUT', '/cycles/cy-fall/applications/in-b/scores/interview', { ...asAnn, query: { round: 'r1' }, body: { scores: { depth: 4 }, submit: true } });
  assert.equal(iv.status, 200, JSON.stringify(iv.body));
  assert.equal(iv.body.score.rubricVersion, 2);
  assert.equal(iv.body.score.doc.total, 4);
  assert.equal((await call(kit, 'PUT', '/cycles/cy-fall/applications/in-b/scores/interview', { ...asAnn, query: { round: 'r1' }, body: { scores: { depth: 5 } } })).status, 400, 'the round scale is 4');
  assert.equal((await call(kit, 'PUT', '/cycles/cy-fall/applications/in-b/scores/interview', { ...asAnn, query: { round: 'r2' }, body: { scores: {} } })).status, 403, 'not assigned to that round');

  // Closed cycles lock every scorecard.
  kit.mem.cycles[0].status = 'closed';
  const closed = await call(kit, 'PUT', '/cycles/cy-fall/applications/in-b/scores/review', { ...asAnn, body: { scores: { motivation: 1 } } });
  assert.equal(closed.status, 409);
  assert.equal(closed.body.error, 'This cycle is closed');
  kit.mem.cycles[0].status = 'open';
}

/* ------------------------- conflicts of interest ------------------------ */

{
  const kit = makeKit([review], seed());
  await call(kit, 'POST', '/cycles/cy-fall/assignments', { body: { requestId: 'rq-11111111-aaaa', ids: ['in-a'], members: ['ann@example.com', 'bob@example.com'], perApplication: 2 } });
  await call(kit, 'PUT', '/cycles/cy-fall/applications/in-a/scores/review', { ...asBob, body: { scores: { motivation: 4, skills: 4, teamwork: 4 }, submit: true } });
  const coi = await call(kit, 'POST', '/cycles/cy-fall/applications/in-a/coi', { ...asAnn, body: { note: 'We share a lab' } });
  assert.equal(coi.status, 200, JSON.stringify(coi.body));
  assert.deepEqual(coi.body.score.doc, { scores: {}, total: null, notes: 'We share a lab', recommendation: null, conflict: true }, 'a conflict stores no scores');
  assert.equal(kit.mem.assignments.find((a) => a.member === 'ann@example.com').status, 'coi');
  assert.equal(kit.mem.audit.at(-1).kind, 'coi');
  assert.deepEqual(kit.mem.audit.at(-1).detail, {}, 'the note never reaches the audit trail');
  const agg = await call(kit, 'GET', '/cycles/cy-fall/applications/in-a/scores');
  assert.equal(agg.body.aggregate.n, 1, 'conflicted reviewers are excluded from aggregates');
  assert.deepEqual(agg.body.others.map((o) => o.member), ['bob@example.com']);
  assert.deepEqual([...await kit.collect('scope.applications', { cycle: kit.mem.cycles[0], me: ANN, role: 'reviewer' })], [], 'a conflicted application leaves the reviewer\'s scope');
  const plan = await call(kit, 'POST', '/cycles/cy-fall/assignments', { body: { requestId: 'rq-22222222-bbbb', ids: ['in-a'], members: ['ann@example.com', 'cam@example.com'], perApplication: 2, dryRun: true } });
  assert.deepEqual(plan.body.plan, [{ applicationId: 'in-a', member: 'cam@example.com' }], 'COI blocks assignment in the planner');
  const manual = await call(kit, 'POST', '/cycles/cy-fall/assignments', { body: { requestId: 'rq-33333333-cccc', ids: ['in-a'], members: ['ann@example.com'], mode: 'manual' } });
  assert.deepEqual(manual.body.skipped, [{ applicationId: 'in-a', member: 'ann@example.com', reason: 'Conflict of interest' }]);
  assert.equal(manual.body.created, 0);
  assert.equal(kit.mem.assignments.find((a) => a.member === 'ann@example.com').status, 'coi', 'a manual retry cannot reopen a conflicted pair');
  const viaScore = await call(kit, 'PUT', '/cycles/cy-fall/applications/in-a/scores/review', { ...asBob, body: { conflict: true, notes: 'Cousin' } });
  assert.equal(viaScore.status, 409, 'a submitted scorecard stays locked even for a conflict flag');
  const load = await call(kit, 'GET', '/cycles/cy-fall/assignments');
  assert.deepEqual(load.body.load, [{ member: 'ann@example.com', name: 'Ann Reviewer', assigned: 0, done: 0, coi: 1, mean: null }, { member: 'bob@example.com', name: 'Bob Reviewer', assigned: 1, done: 1, coi: 0, mean: 4 }]);
}

/* -------------------------- calibration and extras ---------------------- */

{
  const kit = makeKit([review], seed());
  await call(kit, 'POST', '/cycles/cy-fall/assignments', { body: { requestId: 'rq-11111111-aaaa', ids: ['in-a', 'in-b', 'in-c'], members: ['ann@example.com', 'bob@example.com'], perApplication: 2 } });
  const score = (who, id, n, extra = {}) => call(kit, 'PUT', `/cycles/cy-fall/applications/${id}/scores/review`, { me: who, role: 'reviewer', body: { scores: { motivation: n, skills: n, teamwork: n }, submit: true, ...extra } });
  await score(ANN, 'in-a', 5); await score(BOB, 'in-a', 3);
  await score(ANN, 'in-b', 2); await score(BOB, 'in-b', 2);
  await call(kit, 'PUT', '/cycles/cy-fall/applications/in-c/scores/review', { ...asAnn, body: { scores: { motivation: 1 } } });
  kit.mem.applications[2].stage = 'screening';
  const summary = await call(kit, 'GET', '/cycles/cy-fall/scores/summary');
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.body.rows.map((r) => [r.id, r.name, r.n, r.mean, r.spread, r.byMember]), [
    ['in-a', 'Person A', 2, 4, 2, { 'ann@example.com': 5, 'bob@example.com': 3 }],
    ['in-b', 'Person B', 2, 2, 0, { 'ann@example.com': 2, 'bob@example.com': 2 }],
    ['in-c', 'Person C', 0, null, null, {}],
    ['in-d', 'Person D', 0, null, null, {}],
  ]);
  assert.deepEqual(summary.body.members, [{ email: 'ann@example.com', n: 2, mean: 3.5, sd: 1.5 }, { email: 'bob@example.com', n: 2, mean: 2.5, sd: 0.5 }]);
  assert.deepEqual((await call(kit, 'GET', '/cycles/cy-fall/scores/summary', { query: { stage: 'screening' } })).body.rows.map((r) => r.id), ['in-c']);
  assert.equal((await call(kit, 'GET', '/cycles/cy-fall/scores/summary', asAnn)).status, 403);

  const cycle = kit.mem.cycles[0];
  const leadExtras = await kit.collect('application.extras', { cycle, ids: ['in-a', 'in-c', 'in-d'], me: LEAD, role: 'lead' });
  assert.deepEqual(leadExtras, { 'in-a': { score: { mine: null, n: 2, mean: 4 }, assigned: ['ann@example.com', 'bob@example.com'] }, 'in-c': { score: { mine: null, n: 0, mean: null }, assigned: ['ann@example.com', 'bob@example.com'] }, 'in-d': { score: { mine: null, n: 0, mean: null }, assigned: [] } });
  const annExtras = await kit.collect('application.extras', { cycle, ids: ['in-a', 'in-c'], me: ANN, role: 'reviewer' });
  assert.deepEqual(annExtras, { 'in-a': { score: { mine: 5, n: 2, mean: 4 } }, 'in-c': { score: { mine: 1, n: 0, mean: null } } }, 'means show only where the reviewer has submitted');
  const bobExtras = await kit.collect('application.extras', { cycle, ids: ['in-c'], me: BOB, role: 'reviewer' });
  assert.deepEqual(bobExtras['in-c'].score, { mine: null, n: 0, mean: null });
  const columns = await review.collect['csv.columns'](cycle, kit);
  assert.deepEqual(columns.map((c) => c.header), ['Score mean', 'Scores', 'Reviewers']);
  assert.deepEqual(columns.map((c) => c.cell({ id: 'in-a' }, leadExtras['in-a'])), [4, 2, 'ann@example.com; bob@example.com']);
  assert.deepEqual(columns.map((c) => c.cell({ id: 'in-d' }, leadExtras['in-d'])), ['', 0, '']);

  // Hooks: a closed stage finishes open assignments; a booking assigns interviewers.
  await kit.emit('stage.moved', { cycle, application: 'in-c', from: 'screening', to: 'rejected', by: 'lead@example.com' });
  assert.deepEqual(kit.mem.assignments.filter((a) => a.applicationId === 'in-c').map((a) => a.status), ['done', 'done']);
  await kit.emit('stage.moved', { cycle, application: 'in-d', from: 'applied', to: 'screening', by: 'lead@example.com' });
  await kit.emit('booking.created', { cycle, booking: { id: 'bk-1', applicationId: 'in-d', round: 'r1' }, slot: { id: 'sl-1', interviewers: ['Bob@example.com'] } });
  assert.deepEqual(kit.mem.assignments.filter((a) => a.applicationId === 'in-d').map((a) => [a.member, a.kind, a.round, a.status, a.createdBy]), [['bob@example.com', 'interviewer', 'r1', 'open', 'system']]);
  await kit.emit('booking.created', { cycle, booking: { id: 'bk-1', applicationId: 'in-d', round: 'r1' }, slot: { id: 'sl-1', interviewers: ['bob@example.com'] } });
  assert.equal(kit.mem.assignments.filter((a) => a.applicationId === 'in-d').length, 1, 'repeat bookings are no-ops');

  // Purge keeps numbers and drops notes.
  await call(kit, 'PUT', '/cycles/cy-fall/applications/in-b/scores/review', { ...asAnn, body: { scores: {}, notes: 'private' } }).catch(() => {});
  await review.collect.purge({ cycle, ids: ['in-b'] }, kit);
  for (const s of kit.mem.scores.filter((x) => x.applicationId === 'in-b')) assert.equal(s.doc.notes, '');
  assert.equal(kit.mem.scores.find((x) => x.applicationId === 'in-b' && x.member === 'bob@example.com').doc.total, 2, 'numbers survive a purge');
}

/* ------------------------------ postgres shape -------------------------- */

{
  const statements = [];
  let conflictRow = null;
  const sql = (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    statements.push({ text, values });
    if (text.startsWith('SELECT a.application_id FROM recruit_assignments a JOIN recruit_applications p')) return { rows: [{ application_id: 'in-a' }] };
    if (text.startsWith('SELECT 1 FROM recruit_assignments WHERE')) return { rows: [{ '?column?': 1 }] };
    if (text.startsWith('WITH up AS ( INSERT INTO recruit_scores')) return { rows: conflictRow ? [] : [{ application_id: values[0], member: values[1], kind: values[2], round: values[3], rubric_version: 1, created: '5', updated: '5', submitted: values[7] == null ? null : '5', doc: JSON.parse(values[8]) }] };
    if (text.startsWith('SELECT s.application_id, s.member, s.kind')) return { rows: [] };
    if (text.startsWith('INSERT INTO recruit_assignments (application_id, member, kind, round, status, created, created_by) SELECT')) return { rows: [{ application_id: 'in-a' }], rowCount: 1 };
    if (text.startsWith('SELECT id, ts, subteam, email, name FROM recruit_applications')) return { rows: [{ id: 'in-a', ts: '1', subteam: 'Software', email: 'a@example.com', name: 'A' }] };
    if (text.startsWith('SELECT a.application_id, a.member, a.kind, a.round, a.status, a.created, a.created_by')) return { rows: [] };
    if (text.startsWith('WITH a AS ( INSERT INTO recruit_assignments')) return { rows: [{ application_id: 'in-a', member: values[1], kind: 'review', round: '', rubric_version: 1, created: '5', updated: '5', submitted: '5', doc: JSON.parse(values[values.length - 1]) }] };
    if (text.startsWith('UPDATE recruit_assignments SET status = \'done\'')) return { rows: [] };
    if (text.startsWith('UPDATE recruit_scores SET doc = jsonb_set')) return { rows: [] };
    throw new Error('Unexpected synthetic SQL: ' + text);
  };
  const mem = { requests: {}, audit: [] };
  const kit = {
    mode: 'postgres', sql: async () => sql, mem, memSave() { throw new Error('memory writer in postgres mode'); }, now: () => 5, id: (p) => p + '-1',
    async once(id, actor, run) { return run(); }, async audit(row) { mem.audit.push(row); }, async emit() {}, async collect() {},
    apps: { get: async (cycle, id) => ({ id, cycleId: cycle.id }) }, cycles: { get: async () => cycleRow() },
    roles: { grantFor: async () => null, roster: async () => [] },
  };
  const cycle = cycleRow();
  const scope = await review.collect['scope.applications']({ cycle, me: ANN, role: 'reviewer' }, kit);
  assert.deepEqual([...scope], ['in-a']);
  assert.match(statements.at(-1).text, /WHERE p\.cycle_id = \? AND a\.member = \? AND a\.status <> 'coi'/, 'reviewer scoping is an id intersection in SQL');
  assert.deepEqual(statements.at(-1).values, ['cy-fall', 'ann@example.com']);

  const put = review.routes.find((r) => r.method === 'PUT');
  const rq = { cycle, me: ANN, role: 'reviewer', params: { cycle: 'cy-fall', app: 'in-a', kind: 'review' }, query: {}, scope, body: async () => ({ scores: { motivation: 5, skills: 4, teamwork: 3 }, submit: true }) };
  const out = await put.handler(rq, kit);
  assert.equal(out.status, 200);
  const upsert = statements.find((s) => s.text.startsWith('WITH up AS ( INSERT INTO recruit_scores'));
  assert.ok(upsert, 'the scorecard write is one statement');
  assert.match(upsert.text, /ON CONFLICT \(application_id, member, kind, round\) DO UPDATE SET doc = EXCLUDED\.doc/);
  assert.match(upsert.text, /submitted = COALESCE\(recruit_scores\.submitted, EXCLUDED\.submitted\) WHERE recruit_scores\.submitted IS NULL OR \?/);
  assert.match(upsert.text, /marked AS \( UPDATE recruit_assignments SET status = CASE WHEN \? THEN 'coi' ELSE 'done' END/, 'the assignment status rides in the same CTE');
  assert.match(upsert.text, /RETURNING \*\), marked AS/);
  assert.equal(upsert.values[7], 5, 'submit stamps the time');
  assert.equal(JSON.parse(upsert.values[8]).total, 4, '(5·1 + 4·2 + 3·1) / 4');
  assert.equal(statements.filter((s) => /^(INSERT|UPDATE|DELETE|WITH)/.test(s.text)).length, 1, 'exactly one write for a scorecard');
  conflictRow = true;
  await assert.rejects(put.handler(rq, kit), (e) => e.status === 409);
  conflictRow = null;

  statements.length = 0;
  const post = review.routes.find((r) => r.method === 'POST' && r.path === '/cycles/:cycle/assignments');
  const assign = await post.handler({ cycle, me: LEAD, role: 'lead', params: { cycle: 'cy-fall' }, query: {}, body: async () => ({ requestId: 'rq-11111111-aaaa', ids: ['in-a'], members: ['ann@example.com'], perApplication: 1 }) }, kit);
  assert.equal(assign.body.created, 1);
  const insert = statements.find((s) => s.text.startsWith('INSERT INTO recruit_assignments'));
  assert.match(insert.text, /FROM jsonb_to_recordset\(\?::jsonb\) AS r\(application_id text, member text\)/);
  assert.match(insert.text, /ON CONFLICT DO NOTHING RETURNING application_id/);
  assert.deepEqual(JSON.parse(insert.values[4]), [{ application_id: 'in-a', member: 'ann@example.com' }]);
  assert.equal(statements.filter((s) => /^(INSERT|UPDATE|DELETE|WITH)/.test(s.text)).length, 1, 'the whole batch is one insert');

  statements.length = 0;
  const coiRoute = review.routes.find((r) => r.path.endsWith('/coi'));
  await coiRoute.handler({ cycle, me: ANN, role: 'reviewer', params: { cycle: 'cy-fall', app: 'in-a' }, query: {}, scope, body: async () => ({ note: 'x' }) }, kit);
  const marked = statements.find((s) => s.text.startsWith('WITH a AS ( INSERT INTO recruit_assignments'));
  assert.match(marked.text, /DO UPDATE SET status = 'coi' RETURNING application_id\) INSERT INTO recruit_scores/, 'assignment and score change in one statement');
  assert.equal(statements.filter((s) => /^(INSERT|UPDATE|DELETE|WITH)/.test(s.text)).length, 1);

  statements.length = 0;
  await review.hooks['stage.moved']({ cycle, application: 'in-a', from: 'screening', to: 'accepted' }, kit);
  assert.equal(statements[0].text, "UPDATE recruit_assignments SET status = 'done' WHERE application_id = ? AND status = 'open'");
  await review.hooks['stage.moved']({ cycle, application: 'in-a', from: 'applied', to: 'screening' }, kit);
  assert.equal(statements.length, 1, 'moving between open stages touches nothing');
  await review.collect.purge({ cycle, ids: ['in-a'] }, kit);
  assert.match(statements.at(-1).text, /jsonb_set\(doc, '\{notes\}', '""'::jsonb\) WHERE application_id = ANY\(\?::text\[\]\)/);
}

const source = await readFile(new URL('../lib/recruit/modules/review.js', import.meta.url), 'utf8');
assert.equal(/from\s+['"]\.\.?\/modules\//.test(source), false, 'no sibling imports');
assert.equal(/\bBEGIN\b|\bCOMMIT\b/.test(source), false, 'no transactions');
for (const kind of source.matchAll(/kind: '([a-z.]+)', target/g)) assert.ok(review.auditKinds.includes(kind[1]), 'auditKinds covers ' + kind[1]);

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
  const source = await readFile(new URL('../src/client/recruit-review.js', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/client/main.js', import.meta.url), 'utf8');
  const focusHelpers = main.slice(main.indexOf('function focusReference'), main.indexOf('function modalFocusables'));
  assert.equal((source.match(/RECRUIT\.register\(/g) || []).length, 1, 'exactly one registration');
  assert.ok(source.startsWith('// recruit:review:start') && source.trimEnd().endsWith('// recruit:review:end'), 'slice markers');
  assert.equal(/<select|<datalist/i.test(source), false, 'no native selects');
  const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const { document } = makeDom();
  const requests = [], toasts = [], backgrounds = [], menus = [], registered = [];
  let renders = 0, closes = 0, asyncPhase = false;
  const cycle = { id: 'cy-fall', version: 3, name: 'Fall 2026', status: 'open', doc: { subteams: [{ key: 'software', name: 'Software' }], modules: { review: true }, pipeline: { stages: STAGES }, review: { blind: 'until-submitted', visibility: 'assigned', perApplication: 2, rubric: DEFAULT_RUBRIC } } };
  const ctx = vm.createContext({
    UI: { modal: null, recruit: { cycleId: 'cy-fall', cycle: { data: cycle, role: 'reviewer' }, apps: { key: 'cy-fall', rows: [], byId: {} }, filters: {}, selected: new Set(), detail: {}, mod: {} } },
    MD: { esc }, I: new Proxy({}, { get: () => '' }), Store: { me: () => ({ email: 'ann@example.com' }) }, recruitDate: () => 'today', REMOTE: {},
    dd: (name, options, value) => { const cur = options.find((o) => o.value === value) || options[0]; return `<button type="button" class="dd" data-action="dd" data-m="${name}" data-value="${esc(cur.value)}" data-opts="${esc(JSON.stringify(options))}" aria-haspopup="menu"><span class="dd__label">${esc(cur.label)}</span></button>`; },
    openMenu: (items, anchor) => menus.push({ items, anchor }),
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
  assert.equal(mod.name, 'review');
  assert.equal(typeof mod.order, 'number');
  for (const key of [...Object.keys(mod.actions), ...Object.keys(mod.modals), ...Object.keys(mod.dd), ...Object.keys(mod.inputs)]) assert.ok(key.startsWith('recruit-'), key);
  assert.equal(mod.panel.when(cycle, 'reviewer'), true);
  assert.equal(mod.panel.when(cycle, null), false);
  assert.equal(mod.panel.when({ doc: { modules: { review: false } } }, 'lead'), false);
  assert.equal(mod.panel.when(cycle, 'interviewer'), false);

  // Mount as a reviewer: two loads with signals; a second mount does not refetch.
  mod.mount(cycle);
  assert.deepEqual(requests.map((r) => r.path), ['/recruit/cycles/cy-fall/assignments', '/recruit/cycles/cy-fall/applications?assigned=me&limit=200']);
  assert.ok(requests.every((r) => r.signal instanceof AbortSignal), 'every fetch carries an AbortSignal');
  assert.ok(mod.view(cycle, 'reviewer').includes('Loading…'));
  mod.mount(cycle);
  assert.equal(requests.length, 2);
  asyncPhase = true;
  requests[0].resolve({ assignments: [{ applicationId: 'in-a', member: 'ann@example.com', kind: 'reviewer', round: '', status: 'open' }], load: [] });
  requests[1].resolve({ rows: [
    { id: 'in-a', name: 'Ada', email: 'ada@example.com', subteam: 'Software', stage: 'applied', ts: 2, extras: { score: { mine: null } } },
    { id: 'in-b', name: 'Bo', email: 'bo@example.com', subteam: 'Software', stage: 'applied', ts: 1, extras: { score: { mine: 3.5 } } },
    { id: 'in-c', name: 'Cy <b>', email: 'cy@example.com', subteam: '', stage: 'screening', ts: 3, extras: { score: { mine: null } } },
  ] });
  await settle();
  assert.deepEqual(backgrounds, ['recruit', 'recruit'], 'loads repaint through renderBackground');
  assert.equal(renders, 0);
  const queue = mod.view(cycle, 'reviewer');
  assert.equal(/<select/i.test(queue), false);
  assert.deepEqual([...queue.matchAll(/<tr data-id="(in-[a-z])"/g)].map((m) => m[1]), ['in-a', 'in-c', 'in-b'], 'unscored first, then by ts');
  assert.ok(queue.includes('1 of 3 scored'));
  assert.ok(queue.includes('Cy &lt;b&gt;'), 'names are escaped');

  // A late answer for the previous cycle is dropped after a switch.
  const spring = { ...cycle, id: 'cy-spring' };
  ctx.UI.recruit.cycleId = 'cy-spring';
  ctx.UI.recruit.cycle = { data: spring, role: 'reviewer' };
  mod.mount(spring);
  assert.equal(requests.length, 4);
  ctx.UI.recruit.cycleId = 'cy-fall';
  ctx.UI.recruit.cycle = { data: cycle, role: 'reviewer' };
  mod.mount(cycle);
  assert.equal(requests.length, 6);
  requests[2].resolve({ assignments: [{ applicationId: 'in-zzz', member: 'ann@example.com', kind: 'reviewer', round: '', status: 'open' }], load: [] });
  await settle();
  assert.equal(backgrounds.length, 2, 'the stale answer paints nothing');
  assert.equal(ctx.UI.recruit.mod.review.data.loading, true, 'the stale answer never lands in the new cycle');
  requests[4].resolve({ assignments: [{ applicationId: 'in-a', member: 'ann@example.com', kind: 'reviewer', round: '', status: 'open' }, { applicationId: 'in-c', member: 'ann@example.com', kind: 'reviewer', round: '', status: 'open' }], load: [] });
  requests[5].resolve({ rows: [
    { id: 'in-a', name: 'Ada', email: 'ada@example.com', subteam: 'Software', stage: 'applied', ts: 2, extras: { score: { mine: null } } },
    { id: 'in-b', name: 'Bo', email: 'bo@example.com', subteam: 'Software', stage: 'applied', ts: 1, extras: { score: { mine: null } } },
    { id: 'in-c', name: 'Cy', email: 'cy@example.com', subteam: '', stage: 'screening', ts: 3, extras: { score: { mine: null } } },
  ] });
  await settle();
  assert.equal(backgrounds.length, 4);
  asyncPhase = false;

  // Open a scorecard: the dialog opens at once and fills in place.
  mod.actions['recruit-scorecard-open']({ dataset: { id: 'in-a' } });
  assert.equal(ctx.UI.modal.kind, 'recruit-scorecard');
  assert.equal(ctx.UI.modal.id, 'in-a');
  const scoreReq = requests.find((r) => r.path === '/recruit/cycles/cy-fall/applications/in-a/scores?kind=review');
  const appReq = requests.find((r) => r.path === '/recruit/cycles/cy-fall/applications/in-a');
  assert.ok(scoreReq && appReq, 'the scorecard and the application load together');
  assert.ok(scoreReq.signal instanceof AbortSignal && appReq.signal instanceof AbortSignal);
  assert.ok(document.body.innerHTML.includes('Loading…'));
  assert.equal(/<select/i.test(document.body.innerHTML), false);
  assert.ok(document.body.querySelector('[data-m="recruit-score-rec"]'), 'the recommendation is a dd');
  const bgBefore = backgrounds.length;
  asyncPhase = true;
  scoreReq.resolve({ mine: null, others: null, aggregate: null, rubric: DEFAULT_RUBRIC, blind: 'until-submitted' });
  await settle();
  assert.equal(document.body.querySelectorAll('[data-action="recruit-score-pick"]').length, 15, '3 criteria × scale 5 as .btn toggles');
  assert.equal(document.activeElement.dataset.action, 'recruit-score-pick', 'focus lands on the first toggle once the rubric arrives');
  assert.ok(document.body.querySelector('[data-rc-others]').textContent.includes('after you submit'));
  appReq.resolve({ application: { id: 'in-a', name: 'Ada', subteam: 'Software', year: 'Junior', answers: { project: 'A <robot>' }, files: [{ id: 'int-1', name: 'cv.pdf' }] }, form: { questions: [{ key: 'project', label: 'Coolest project' }] } });
  await settle();
  const answers = document.body.querySelector('[data-rc-answers]');
  assert.ok(answers.innerHTML.includes('A &lt;robot&gt;'), 'answers are escaped');
  assert.ok(answers.innerHTML.includes('Coolest project'));
  assert.ok(answers.innerHTML.includes('/api/recruit/files/int-1'));
  assert.equal(document.body.querySelector('[data-rc-title]').textContent, 'Ada');
  assert.equal(renders, 0);
  assert.equal(backgrounds.length, bgBefore, 'the open dialog repaints in place, not through render');
  assert.equal(document.activeElement.dataset.action, 'recruit-score-pick', 'focus survives the answers arriving');

  const pick = (key, n) => mod.actions['recruit-score-pick'](document.body.querySelector(`[data-action="recruit-score-pick"][data-key="${key}"][data-n="${n}"]`));
  pick('motivation', 4); pick('skills', 5); pick('teamwork', 3);
  const draft = ctx.UI.recruit.mod.review.drafts['in-a'];
  assert.deepEqual(plain(draft.scores), { motivation: 4, skills: 5, teamwork: 3 });
  assert.equal(document.body.querySelector('[data-key="motivation"][data-n="4"]').getAttribute('aria-pressed'), 'true');
  assert.equal(document.body.querySelector('[data-key="motivation"][data-n="3"]').getAttribute('aria-pressed'), 'false');
  pick('teamwork', 3);
  assert.equal(draft.scores.teamwork, undefined, 'pressing the chosen value again clears it');
  pick('teamwork', 3);
  mod.inputs['recruit-score-notes']({ value: 'keen' });
  assert.equal(draft.notes, 'keen');
  mod.dd['recruit-score-rec']({}, 'yes');
  assert.equal(draft.recommendation, 'yes');

  // Arrow keys walk the scale.
  const first = document.body.querySelector('[data-key="motivation"][data-n="1"]');
  first.focus();
  let prevented = 0;
  assert.equal(mod.keydown({ key: 'ArrowRight', target: first, preventDefault: () => prevented++ }), true);
  assert.equal(document.activeElement.dataset.n, '2');
  assert.equal(mod.keydown({ key: 'End', target: document.activeElement, preventDefault: () => prevented++ }), true);
  assert.equal(document.activeElement.dataset.n, '5');
  assert.equal(prevented, 2);
  assert.equal(mod.keydown({ key: 'Enter', target: first, preventDefault: () => prevented++ }), false, 'Enter stays the button\'s own');
  assert.equal(mod.keydown({ key: 'ArrowRight', target: { dataset: {} }, preventDefault: () => prevented++ }), false);

  // Submit: focus stays on the button through the in-place repaints, the
  // retry after a timeout sends the same scorecard, and nothing renders.
  const submitButton = document.body.querySelector('[data-action="recruit-score-submit"]');
  submitButton.focus();
  const before = requests.length;
  mod.actions['recruit-score-submit']();
  assert.equal(requests.length, before + 1);
  const put = requests.at(-1);
  assert.equal(put.method, 'PUT');
  assert.equal(put.path, '/recruit/cycles/cy-fall/applications/in-a/scores/review');
  assert.ok(put.signal instanceof AbortSignal);
  assert.deepEqual(put.body, { rubricVersion: 1, scores: { motivation: 4, skills: 5, teamwork: 3 }, notes: 'keen', recommendation: 'yes', conflict: false, submit: true });
  assert.equal(document.activeElement.dataset.action, 'recruit-score-submit', 'focus stays on the submit button while it repaints');
  assert.equal(document.activeElement.textContent, 'Submitting…');
  assert.equal(document.activeElement.disabled, true);
  mod.actions['recruit-score-submit']();
  assert.equal(requests.length, before + 1, 'no duplicate submit while pending');
  put.reject(timeout());
  await settle();
  assert.equal(document.body.querySelector('[data-rc-error]').textContent, 'The request timed out. Try again.');
  assert.equal(document.body.querySelector('[data-rc-error]').hidden, false);
  assert.equal(document.activeElement.dataset.action, 'recruit-score-submit');
  assert.equal(document.activeElement.disabled, false);
  mod.actions['recruit-score-submit']();
  const retry = requests.at(-1);
  assert.deepEqual(retry.body, put.body, 'the retry sends the same scorecard');
  retry.resolve({ score: { applicationId: 'in-a', member: 'ann@example.com', kind: 'review', round: '', rubricVersion: 1, submitted: 5, doc: { scores: put.body.scores, total: 4.25, notes: 'keen', recommendation: 'yes', conflict: false } }, aggregate: { n: 2, mean: 3.5, spread: 1.5 } });
  await settle();
  assert.equal(toasts.at(-1), 'Scorecard submitted');
  assert.equal(renders, 0, 'no render() from the async completion');
  assert.equal(closes, 0, 'the dialog stays open');
  assert.equal(backgrounds.length, bgBefore);
  const reload = requests.at(-1);
  assert.equal(reload.path, '/recruit/cycles/cy-fall/applications/in-a/scores?kind=review', 'after submitting, the other scorecards are fetched');
  assert.equal(document.activeElement.dataset.action, 'modal-close', 'focus moves to a live control once the submit button is gone');
  reload.resolve({ mine: retry.body && { submitted: 5, doc: { total: 4.25, scores: put.body.scores, notes: 'keen', recommendation: 'yes', conflict: false } }, others: [{ member: 'bob@example.com', submitted: 4, doc: { total: 2.75, recommendation: 'no' } }], aggregate: { n: 2, mean: 3.5, spread: 1.5 }, rubric: DEFAULT_RUBRIC, blind: 'until-submitted' });
  await settle();
  assert.ok(document.body.querySelector('[data-rc-foot]').textContent.includes('Submitted'), 'the card locks after submitting');
  assert.equal(document.body.querySelector('[data-action="recruit-score-submit"]'), null);
  assert.ok(document.body.querySelector('[data-rc-others]').textContent.includes('bob'), 'other scorecards appear after submitting');
  assert.ok(document.body.querySelector('[data-key="motivation"][data-n="4"]').disabled, 'locked toggles');
  assert.equal(document.activeElement.dataset.action, 'modal-close');
  assert.equal(ctx.UI.recruit.mod.review.queue.rows.find((r) => r.id === 'in-a').extras.score.mine, 4.25, 'the queue row learns the score');
  assert.equal(ctx.UI.recruit.mod.review.data.assignments.find((a) => a.applicationId === 'in-a').status, 'done');

  // Submit and next moves the dialog on without closing or rendering.
  ctx.UI.modal = null; document.body.innerHTML = '';
  mod.actions['recruit-scorecard-open']({ dataset: { id: 'in-c' } });
  const cReq = requests.find((r) => r.path === '/recruit/cycles/cy-fall/applications/in-c/scores?kind=review');
  cReq.resolve({ mine: null, others: null, aggregate: null, rubric: DEFAULT_RUBRIC, blind: 'until-submitted' });
  requests.find((r) => r.path === '/recruit/cycles/cy-fall/applications/in-c').resolve({ application: { id: 'in-c', name: 'Cy', answers: {} }, form: { questions: [] } });
  await settle();
  assert.ok(document.body.querySelector('[data-action="recruit-score-next"]'), 'another unscored person is queued');
  pick('motivation', 2); pick('skills', 2); pick('teamwork', 2);
  document.body.querySelector('[data-action="recruit-score-next"]').focus();
  mod.actions['recruit-score-next']();
  const nextPut = requests.at(-1);
  assert.equal(nextPut.path, '/recruit/cycles/cy-fall/applications/in-c/scores/review');
  nextPut.resolve({ score: { submitted: 6, doc: { scores: nextPut.body.scores, total: 2, notes: '', recommendation: null, conflict: false } }, aggregate: null });
  await settle();
  assert.equal(ctx.UI.modal.id, 'in-b', 'the dialog moves to the next unscored person');
  assert.ok(requests.some((r) => r.path === '/recruit/cycles/cy-fall/applications/in-b/scores?kind=review'));
  assert.equal(document.body.querySelector('[data-rc-title]').textContent, 'Bo');
  assert.equal(renders, 0);
  assert.equal(closes, 0);
  asyncPhase = false;

  // Conflict of interest: the checkbox keeps its default, the card follows.
  ctx.UI.modal = null; document.body.innerHTML = '';
  mod.actions['recruit-scorecard-open']({ dataset: { id: 'in-b' } });
  await settle();
  mod.actions['recruit-score-coi']({ checked: true }, { stopPropagation() {} });
  assert.equal(ctx.UI.recruit.mod.review.drafts['in-b'].conflict, true);

  // Leads: the Assign dialog reads the roster and posts one request id.
  ctx.UI.modal = null; document.body.innerHTML = '';
  ctx.UI.recruit.cycle.role = 'lead';
  ctx.UI.recruit.selected = new Set(['in-a', 'in-b']);
  assert.deepEqual(plain(mod.selectionActions(['in-a', 'in-b'], cycle, 'lead').map((a) => a.action)), ['recruit-assign-open']);
  assert.deepEqual(plain(mod.selectionActions(['in-a'], cycle, 'reviewer')), []);
  mod.actions['recruit-assign-open']({ dataset: {} });
  assert.equal(ctx.UI.modal.kind, 'recruit-assign');
  const rosterReq = requests.at(-1);
  assert.equal(rosterReq.path, '/recruit/cycles/cy-fall/roles');
  assert.ok(rosterReq.signal instanceof AbortSignal);
  assert.equal(/<select/i.test(document.body.innerHTML), false);
  asyncPhase = true;
  rosterReq.resolve({ roles: [{ member: 'ann@example.com', roles: ['reviewer'], subteams: ['software'] }, { member: 'bob@example.com', roles: ['reviewer', 'lead'], subteams: [] }, { member: 'cam@example.com', roles: ['interviewer'], subteams: [] }], members: [{ email: 'ann@example.com', name: 'Ann Reviewer' }, { email: 'bob@example.com', name: 'Bob Reviewer' }] });
  await settle();
  const boxes = document.body.querySelectorAll('[data-rc-member]');
  assert.deepEqual(boxes.map((b) => b.dataset.rcMember), ['ann@example.com', 'bob@example.com'], 'only reviewers are offered');
  boxes[1].checked = false;
  mod.dd['recruit-assign-per']({}, '3');
  assert.equal(document.body.querySelector('[data-rc-preview]').textContent, '≈ 6 each');
  document.body.querySelector('[data-m="recruit-assign-per"]').dataset.value = '3';
  mod.actions['recruit-assign-go']();
  const post = requests.at(-1);
  assert.equal(post.method, 'POST');
  assert.equal(post.path, '/recruit/cycles/cy-fall/assignments');
  assert.ok(post.signal instanceof AbortSignal);
  assert.match(post.body.requestId, /^rq-[0-9a-f-]{36}$/);
  assert.deepEqual(post.body, { requestId: post.body.requestId, ids: ['in-a', 'in-b'], kind: 'reviewer', mode: 'round-robin', perApplication: 3, members: ['ann@example.com'], bySubteam: false });
  mod.actions['recruit-assign-go']();
  assert.equal(requests.at(-1), post, 'no duplicate while pending');
  post.reject(timeout());
  await settle();
  assert.equal(document.body.querySelector('[data-rc-error]').textContent, 'The request timed out. Try again.');
  mod.actions['recruit-assign-go']();
  assert.equal(requests.at(-1).body.requestId, post.body.requestId, 'the retry replays the same request id');
  requests.at(-1).resolve({ created: 2, existing: 1, plan: [] });
  await settle();
  assert.equal(closes, 1);
  assert.equal(backgrounds.at(-1), 'recruit');
  assert.equal(toasts.at(-1), 'Assigned 2 · 1 already assigned');
  assert.equal(ctx.UI.recruit.mod.review.data, undefined, 'the load table refetches on the next mount');
  assert.equal(renders, 0);
  asyncPhase = false;

  // Lead panel and the list column render from cached data, escaped.
  ctx.UI.recruit.mod.review.data = { assignments: [{ applicationId: 'in-a', member: 'ann@example.com', kind: 'reviewer', status: 'done' }, { applicationId: 'in-b', member: 'ann@example.com', kind: 'reviewer', status: 'open' }, { applicationId: 'in-b', member: 'bob@example.com', kind: 'reviewer', status: 'coi' }], load: [{ member: 'ann@example.com', name: 'Ann Reviewer', assigned: 2, done: 1, coi: 0, mean: 4 }] };
  ctx.UI.recruit.mod.review.summary = { rows: [{ id: 'in-a', name: 'Ada <b>', subteam: 'Software', n: 2, mean: 3.5, spread: 1.5, byMember: { 'ann@example.com': 4.25, 'bob@example.com': 2.75 } }, { id: 'in-b', name: 'Bo', subteam: '', n: 0, mean: null, spread: null, byMember: {} }], members: [{ email: 'ann@example.com', n: 1, mean: 4.25, sd: 0 }, { email: 'bob@example.com', n: 1, mean: 2.75, sd: 0 }] };
  const lead = mod.view(cycle, 'lead');
  assert.equal(/<select/i.test(lead), false);
  assert.ok(lead.includes('1 of 2 screened · 1 conflict'));
  assert.ok(lead.includes('Ann Reviewer'));
  assert.ok(lead.includes('data-action="recruit-assign-open"'));
  assert.ok(lead.includes('Ada &lt;b&gt;'), 'names are escaped');
  assert.ok(lead.includes('4.25') && lead.includes('2.75'));
  assert.ok(mod.columns[0].cell({ extras: { score: { mean: 3.5, n: 2 } } }).includes('3.5'));
  assert.ok(mod.columns[0].cell({}).includes('—'));
  assert.ok(mod.detailSections({ id: 'in-a', extras: { score: { mine: 4, mean: 3.5, n: 2 }, assigned: ['ann@example.com'] } }, cycle, 'reviewer')[0].html.includes('data-action="recruit-scorecard-open" data-id="in-a"'));
  assert.equal(mod.detailSections({ id: 'in-a', extras: { score: { mine: null, n: 0 }, assigned: [] } }, cycle, 'reviewer')[0].html.includes('recruit-scorecard-open'), false, 'no scorecard button without an assignment');
  assert.deepEqual(plain(mod.filters(cycle, 'reviewer').map((f) => [f.group, f.value, f.label, f.query])), [['review', 'unscored', 'Unscored', { unscored: '1' }], ['review', 'assigned', 'Assigned to me', { assigned: 'me' }]], 'filter entries carry the server query the Applications panel merges');

  // Review settings: the rubric editor keeps edits across in-place repaints.
  const sv = mod.settings.view(cycle);
  assert.equal(/<select/i.test(sv), false);
  assert.ok(sv.startsWith('<form data-action="recruit-settings-review"'), 'the cycles panel supplies the section and heading');
  ctx.UI.modal = null;
  document.body.innerHTML = sv;
  const form = document.body.querySelector('form');
  document.body.querySelector('[data-m="recruit-rubric-new"]').value = 'Curiosity';
  mod.actions['recruit-rubric-add'](document.body.querySelector('[data-action="recruit-rubric-add"]'));
  assert.deepEqual([...document.body.querySelectorAll('[data-rc-criterion]')].map((r) => r.dataset.rcCriterion), ['motivation', 'skills', 'teamwork', 'curiosity']);
  assert.equal(document.activeElement.dataset.key, 'curiosity');
  document.body.querySelector('[name="crit-weight-skills"]').value = '3';
  mod.actions['recruit-rubric-remove'](document.body.querySelector('[data-action="recruit-rubric-remove"][data-key="teamwork"]'));
  assert.equal(document.body.querySelector('[name="crit-weight-skills"]').value, '3', 'edits survive the repaint');
  document.body.querySelector('[data-m="recruit-review-blind"]').dataset.value = 'off';
  form.elements = { editAfterSubmit: { checked: true } };
  asyncPhase = true;
  const saving = mod.settings.submit(form, cycle);
  const putSettings = requests.at(-1);
  assert.equal(putSettings.path, '/recruit/cycles/cy-fall/settings/review');
  assert.equal(putSettings.method, 'PUT');
  assert.ok(putSettings.signal instanceof AbortSignal);
  assert.deepEqual(putSettings.body, { version: 3, settings: { blind: 'off', visibility: 'assigned', perApplication: 2, editAfterSubmit: true, rubric: { version: 2, scale: 5, criteria: [{ key: 'motivation', name: 'Motivation', weight: 1, help: '' }, { key: 'skills', name: 'Relevant skills', weight: 3, help: '' }, { key: 'curiosity', name: 'Curiosity', weight: 1, help: '' }] } } });
  putSettings.resolve({ cycle: { ...cycle, version: 4 } });
  await saving;
  assert.equal(ctx.UI.recruit.cycle.data.version, 4);
  assert.equal(ctx.UI.recruit.mod.review.rubricDraft, null);
  assert.equal(renders, 0);
  asyncPhase = false;

  // Preview build: no REMOTE, no requests, an .empty explanation.
  delete ctx.REMOTE;
  const preview = mod.view(cycle, 'reviewer');
  assert.ok(preview.includes('class="empty"'));
  const count = requests.length;
  mod.mount(cycle);
  assert.equal(requests.length, count, 'no fetch without REMOTE');
  ctx.REMOTE = {};
}

console.log('PASS: round-robin balance and determinism, blind scoring until submitted, weighted aggregates, SQL-scoped reviewers with 404 outside scope, conflicts stored without scores and excluded, COI blocks assignment, single-statement writes; client scorecard submit keeps focus and its retry, submit-and-next moves in place, no render() from completions');
