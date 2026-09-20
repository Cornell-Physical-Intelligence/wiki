// Synthetic fixtures only: an in-memory kit and a fake registry drive the real
// pipeline module; no storage, network, credentials or repo .dev*.json files.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

globalThis.fetch = async () => { throw new Error('Network disabled in tests'); };
const pipeline = (await import('../lib/recruit/modules/pipeline.js')).default;
const { outcomeOf, stageFor, normalizeQuery, settingsOf, DEFAULT_STAGES } = await import('../lib/recruit/modules/pipeline.js');

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

function makeKit(modules, seed = {}) {
  const mem = { settings: { version: 1, doc: {} }, cycles: [], applicants: [], applications: [], requests: {}, audit: [], roles: [], ...seed };
  for (const m of modules) for (const [k, v] of Object.entries(m.memory || {})) mem[k] ||= structuredClone(v);
  let n = 0, clock = 1_700_000_000_000;
  const find = (cycle, id) => mem.applications.find((a) => a.id === id && a.cycleId === cycle.id);
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
      return outs;
    },
    cycles: { get: async (id) => mem.cycles.find((c) => c.id === id) || null, intakeTarget: async () => null, enabled: (cycle, name) => cycle.doc?.modules?.[name] !== false },
    apps: {
      calls: [],
      get: async (cycle, id) => { const a = find(cycle, id); return a ? { ...a } : null; },
      // Mirrors the spec's move CTE: guarded update, history, audit in the same write.
      move: async (cycle, { id, to, from, outcome, by, requestId, now }) => {
        kit.apps.calls.push(['move', id]);
        const a = find(cycle, id);
        if (!a || a.stage === to || (from && a.stage !== from)) return null;
        const prior = a.stage;
        a.stage = to; a.stageAt = now; a.outcome = outcome;
        a.stageHistory = [...(a.stageHistory || []), { stage: to, at: now, by, requestId }].slice(-200);
        a.editVersion = (a.editVersion || 0) + 1;
        mem.audit.push({ id: kit.id('au'), ts: now, cycleId: cycle.id, applicationId: id, actor: by, kind: 'stage', detail: { from: prior, to, requestId } });
        kit.memSave();
        return { id, from: prior, editVersion: a.editVersion };
      },
      setDecision: async (cycle, { id, outcome, reason, subteam, stage, by, now }) => {
        kit.apps.calls.push(['decide', id]);
        const a = find(cycle, id);
        if (!a) return null;
        const prior = a.stage;
        a.decision = { outcome, reason, by, at: now, subteam }; a.outcome = outcome;
        if (a.stage !== stage) { a.stage = stage; a.stageAt = now; }
        a.editVersion = (a.editVersion || 0) + 1;
        kit.memSave();
        return { id, from: prior, editVersion: a.editVersion };
      },
      patch: async (cycle, { id, tags }) => {
        kit.apps.calls.push(['patch', id]);
        const a = find(cycle, id);
        if (!a) return null;
        a.tags = [...new Set([...(a.tags || []).filter((t) => !tags.remove.includes(t)), ...tags.add])].slice(0, 20);
        a.editVersion = (a.editVersion || 0) + 1;
        kit.memSave();
        return { id, editVersion: a.editVersion, tags: a.tags };
      },
    },
    roles: { grantFor: async (cycleId, email) => mem.roles.find((r) => r.cycleId === cycleId && r.member === email) || null, roleOf: () => null, roster: async () => [] },
    json: (status, body, headers) => ({ status, body, headers }),
  };
  return kit;
}

async function call(kit, module, method, path, { me = { email: 'lead@example.com', role: 'member', name: 'Lead' }, role = 'lead', body = {}, query = {} } = {}) {
  for (const route of module.routes) {
    if (route.method !== method) continue;
    const { re, names } = compile(route.path);
    const m = path.match(re);
    if (!m) continue;
    const params = Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(m[i + 1])]));
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

const cycleRow = (over = {}) => ({
  id: 'cy-fall', version: 3, status: 'open', name: 'Fall 2026', term: 'Fall 2026', formVersion: 0, created: 1, updated: 1,
  doc: { subteams: [{ key: 'software', name: 'Software' }, { key: 'electrical', name: 'Electrical' }], modules: { pipeline: true }, pipeline: { stages: DEFAULT_STAGES.map((s) => ({ ...s })), views: [], reviewersMayMove: false } },
  ...over,
});
const app = (id, over = {}) => ({ id, cycleId: 'cy-fall', email: `${id.slice(3)}@example.com`, ts: 100, updated: 100, name: 'Person ' + id, cornell: false, subteam: 'Software', year: 'Junior', source: 'form', formVersion: 0, answers: {}, files: [], stage: 'applied', stageAt: 100, stageHistory: [], outcome: null, decision: {}, tags: [], review: {}, reviewVersion: 0, editVersion: 0, ...over });

/* ------------------------------ contract shape --------------------------- */

assert.equal(pipeline.name, 'pipeline');
assert.equal(pipeline.kernel, false);
assert.equal(typeof pipeline.order, 'number');
assert.deepEqual(pipeline.schema, [], 'the transition trail lives in stage_history and the stage audit row, not a table of its own');
for (const r of pipeline.routes) { compile(r.path); assert.ok(r.access, r.path + ' declares access'); }
assert.deepEqual(pipeline.auditKinds, ['stage', 'decision', 'tag']);
const routeFor = (method, path) => pipeline.routes.find((r) => r.method === method && r.path === path);
assert.ok(routeFor('POST', '/cycles/:cycle/moves').mutates && routeFor('POST', '/cycles/:cycle/moves').scoped && routeFor('POST', '/cycles/:cycle/moves').cap === 262144);
assert.equal(routeFor('POST', '/cycles/:cycle/decisions').access, 'lead');
assert.equal(routeFor('POST', '/cycles/:cycle/tags').access, 'lead');
assert.equal(routeFor('GET', '/cycles/:cycle/pipeline').access, 'role');

/* ------------------------------ pure helpers ---------------------------- */

assert.equal(outcomeOf(DEFAULT_STAGES, 'accepted'), 'accepted');
assert.equal(outcomeOf(DEFAULT_STAGES, 'screening'), null, 'open stages clear the outcome');
assert.equal(outcomeOf(DEFAULT_STAGES, 'nope'), null);
assert.equal(stageFor(DEFAULT_STAGES, 'waitlisted').key, 'waitlisted');
assert.equal(stageFor(DEFAULT_STAGES, 'hired'), null);
assert.deepEqual(normalizeQuery({ q: ' ada ', stage: 'applied', flagged: true, dir: '', sort: 'name', nope: 1 }), { q: 'ada', stage: 'applied', flagged: '1', sort: 'name' });
assert.throws(() => normalizeQuery({ sort: 'shoe' }), /Unknown sort/);
assert.throws(() => normalizeQuery({ dir: 'up' }), /asc or desc/);
assert.throws(() => normalizeQuery({ flagged: 'yes' }), /switch/);

/* ---------------------------- settings validation ------------------------ */

{
  const cycle = cycleRow();
  const ok = pipeline.validateSettings({ stages: DEFAULT_STAGES, views: [{ key: 'ee', name: ' Electrical  flagged ', query: { subteam: 'Electrical', flagged: true } }], reviewersMayMove: 'yes' }, cycle);
  assert.equal(ok.reviewersMayMove, false, 'only a real true switches reviewersMayMove on');
  assert.deepEqual(ok.views, [{ key: 'ee', name: 'Electrical flagged', query: { subteam: 'Electrical', flagged: '1' } }]);
  assert.equal(ok.stages.length, DEFAULT_STAGES.length);
  const bad = (next, re) => assert.throws(() => pipeline.validateSettings(next, cycle), (e) => e.status === 400 && re.test(e.error));
  bad({ stages: DEFAULT_STAGES.filter((s) => s.key !== 'applied') }, /"applied" stage cannot be removed/);
  bad({ stages: [{ key: 'applied', name: 'Applied', kind: 'open', outcome: 'accepted' }] }, /cannot record an outcome/);
  bad({ stages: [{ key: 'applied', name: 'Applied', kind: 'open' }, { key: 'done', name: 'Done', kind: 'closed' }] }, /needs an outcome/);
  bad({ stages: [{ key: 'applied', name: 'Applied', kind: 'open' }, { key: 'applied', name: 'Again', kind: 'open' }] }, /used twice/);
  bad({ stages: [{ key: 'Applied', name: 'Applied', kind: 'open' }] }, /lowercase/);
  bad({ stages: [{ key: 'applied', name: '', kind: 'open' }] }, /Give stage/);
  bad({ stages: DEFAULT_STAGES, views: [{ key: 'v', name: 'V', query: { sort: 'shoe' } }] }, /Unknown sort/);
  bad({ stages: DEFAULT_STAGES, views: [{ key: 'v', name: 'V' }, { key: 'v', name: 'W' }] }, /listed twice/);
  bad('nope', /must be an object/);
  assert.equal(typeof pipeline.validateSettings({ stages: DEFAULT_STAGES }, cycle).then, 'undefined', 'without a kit the validator is synchronous');
}

/* ------------------------- stage removal guard (memory) ------------------ */

{
  const kit = makeKit([pipeline], { cycles: [cycleRow()], applications: [app('in-a', { stage: 'screening' }), app('in-b', { stage: 'screening' }), app('in-c')] });
  const cycle = kit.mem.cycles[0];
  const without = (key) => ({ stages: DEFAULT_STAGES.filter((s) => s.key !== key) });
  await assert.rejects(pipeline.validateSettings(without('screening'), cycle, kit), (e) => e.status === 409 && e.error === 'Screening still has 2 applications. Move them first.');
  const kept = await pipeline.validateSettings(without('offer'), cycle, kit);
  assert.equal(kept.stages.some((s) => s.key === 'offer'), false, 'an empty stage can go');
  const same = await pipeline.validateSettings({ stages: DEFAULT_STAGES }, cycle, kit);
  assert.equal(same.stages.length, DEFAULT_STAGES.length);
}

/* ------------------------------ GET pipeline ---------------------------- */

{
  const kit = makeKit([pipeline], { cycles: [cycleRow()], applications: [app('in-a', { stage: 'screening' }), app('in-b'), app('in-c')] });
  const out = await call(kit, pipeline, 'GET', '/cycles/cy-fall/pipeline', { role: 'reviewer', me: { email: 'r@example.com' } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.counts, { total: 3, byStage: { screening: 1, applied: 2 } });
  assert.equal(out.body.stages.find((s) => s.key === 'applied').count, 2);
  assert.equal(out.body.stages.find((s) => s.key === 'offer').count, 0);
  assert.equal((await call(kit, pipeline, 'GET', '/cycles/cy-fall/pipeline', { role: null })).status, 403);
  assert.equal((await call(kit, pipeline, 'GET', '/cycles/cy-nope/pipeline')).status, 404);
}

/* ----------------------------- moves (lead) ----------------------------- */

const hookLog = [];
const spy = { name: 'spy', order: 99, routes: [], hooks: { 'stage.moved': async (ev) => hookLog.push(['moved', ev.application, ev.from, ev.to]), 'decision.set': async (ev) => hookLog.push(['decided', ev.application, ev.outcome]) }, collect: { 'scope.applications': async () => new Set(['in-a']) } };

{
  const kit = makeKit([pipeline, spy], { cycles: [cycleRow()], applications: [app('in-a'), app('in-b'), app('in-c')] });
  const body = { requestId: 'rq-11111111-aaaa', ids: ['in-a', 'in-b', 'in-c', 'in-b'], to: 'screening', note: 'batch one' };
  const first = await call(kit, pipeline, 'POST', '/cycles/cy-fall/moves', { body });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.moved.map((m) => m.id), ['in-a', 'in-b', 'in-c'], 'duplicate ids collapse');
  assert.deepEqual(first.body.moved.map((m) => m.from), ['applied', 'applied', 'applied']);
  assert.deepEqual(first.body.moved.map((m) => m.editVersion), [1, 1, 1]);
  assert.deepEqual(first.body.skipped, []);
  assert.equal(kit.apps.calls.filter((c) => c[0] === 'move').length, 3, 'one write per row');
  assert.equal(kit.mem.audit.filter((a) => a.kind === 'stage').length, 3, 'one stage audit row per moved application');
  assert.deepEqual(kit.mem.audit.filter((a) => a.kind === 'stage').map((a) => a.detail), [{ from: 'applied', to: 'screening', requestId: body.requestId }, { from: 'applied', to: 'screening', requestId: body.requestId }, { from: 'applied', to: 'screening', requestId: body.requestId }]);
  assert.equal(kit.mem.applications[0].stageHistory.length, 1);
  assert.equal(kit.mem.applications[0].outcome, null);
  assert.deepEqual(hookLog, [['moved', 'in-a', 'applied', 'screening'], ['moved', 'in-b', 'applied', 'screening'], ['moved', 'in-c', 'applied', 'screening']], 'stage.moved fans out per moved id');
  assert.equal(kit.events.filter((e) => e.event === 'stage.moved').length, 3);

  const replay = await call(kit, pipeline, 'POST', '/cycles/cy-fall/moves', { body });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.moved, first.body.moved, 'the stored result comes back untouched');
  assert.equal(kit.apps.calls.length, 3, 'a replayed request writes nothing');
  assert.equal(kit.mem.audit.length, 3);
  assert.equal(hookLog.length, 3, 'a replayed request emits nothing');

  const again = await call(kit, pipeline, 'POST', '/cycles/cy-fall/moves', { body: { ...body, requestId: 'rq-22222222-bbbb' } });
  assert.deepEqual(again.body.moved, []);
  assert.deepEqual(again.body.skipped, [{ id: 'in-a', reason: 'Already in Screening' }, { id: 'in-b', reason: 'Already in Screening' }, { id: 'in-c', reason: 'Already in Screening' }]);

  const guarded = await call(kit, pipeline, 'POST', '/cycles/cy-fall/moves', { body: { requestId: 'rq-33333333-cccc', ids: ['in-a', 'in-zz'], to: 'interview', from: 'applied' } });
  assert.equal(guarded.status, 200);
  assert.deepEqual(guarded.body.moved, []);
  assert.deepEqual(guarded.body.skipped, [{ id: 'in-a', reason: 'Not in Applied' }, { id: 'in-zz', reason: 'No such application' }], 'a from mismatch reports the row as skipped');
  assert.equal(kit.mem.applications[0].stage, 'screening');

  const closed = await call(kit, pipeline, 'POST', '/cycles/cy-fall/moves', { body: { requestId: 'rq-44444444-dddd', ids: ['in-a'], to: 'rejected' } });
  assert.equal(closed.body.moved[0].from, 'screening');
  assert.equal(kit.mem.applications[0].outcome, 'rejected', 'a closed stage carries its outcome');
  assert.equal(kit.mem.applications[0].editVersion, 2);

  const writesBefore = kit.apps.calls.length;
  const bad = async (body, status, re) => { const out = await call(kit, pipeline, 'POST', '/cycles/cy-fall/moves', { body }); assert.equal(out.status, status, JSON.stringify(out.body)); assert.match(out.body.error, re); };
  await bad({ ids: ['in-a'], to: 'screening' }, 400, /request id/);
  await bad({ requestId: 'nope', ids: ['in-a'], to: 'screening' }, 400, /request id/);
  await bad({ requestId: 'rq-55555555-eeee', ids: [], to: 'screening' }, 400, /at least one/);
  await bad({ requestId: 'rq-55555555-eeee', ids: ['in-a'], to: 'nowhere' }, 400, /Choose a stage/);
  await bad({ requestId: 'rq-55555555-eeee', ids: ['in-a'], to: 'screening', from: 'nowhere' }, 400, /starting stage/);
  await bad({ requestId: 'rq-55555555-eeee', ids: ['../etc'], to: 'screening' }, 400, /Unknown application id/);
  await bad({ requestId: 'rq-55555555-eeee', ids: Array.from({ length: 2001 }, (_, i) => 'in-' + i), to: 'screening' }, 400, /at most 2000/);
  assert.equal(kit.apps.calls.length, writesBefore, 'rejected bodies never reach storage');
}

/* ------------------------ moves by reviewers and scope ------------------- */

{
  const kit = makeKit([pipeline, spy], { cycles: [cycleRow()], applications: [app('in-a'), app('in-b')] });
  const reviewer = { role: 'reviewer', me: { email: 'rev@example.com', role: 'member' } };
  const denied = await call(kit, pipeline, 'POST', '/cycles/cy-fall/moves', { ...reviewer, body: { requestId: 'rq-66666666-ffff', ids: ['in-a'], to: 'screening' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'Not allowed in this cycle');
  kit.mem.cycles[0].doc.pipeline.reviewersMayMove = true;
  const scoped = await call(kit, pipeline, 'POST', '/cycles/cy-fall/moves', { ...reviewer, body: { requestId: 'rq-66666666-ffff', ids: ['in-a', 'in-b'], to: 'screening' } });
  assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.body.moved.map((m) => m.id), ['in-a']);
  assert.deepEqual(scoped.body.skipped, [{ id: 'in-b', reason: 'Outside your assignments' }], 'reviewers move only what the scope collector granted');
  const decide = await call(kit, pipeline, 'POST', '/cycles/cy-fall/moves', { ...reviewer, body: { requestId: 'rq-77777777-aaaa', ids: ['in-a'], to: 'accepted' } });
  assert.equal(decide.status, 403);
  assert.equal(decide.body.error, 'Decisions are made by leads', 'stage kinds bound what reviewers may do');
  assert.equal((await call(kit, pipeline, 'POST', '/cycles/cy-fall/moves', { role: 'interviewer', me: { email: 'i@example.com' }, body: {} })).status, 403);
  assert.equal((await call(kit, pipeline, 'POST', '/cycles/cy-fall/decisions', { ...reviewer, body: {} })).status, 403, 'decisions are lead-only at the route');
  assert.equal((await call(kit, pipeline, 'POST', '/cycles/cy-fall/tags', { ...reviewer, body: {} })).status, 403);
  kit.mem.cycles[0].status = 'archived';
  assert.equal((await call(kit, pipeline, 'POST', '/cycles/cy-fall/moves', { body: { requestId: 'rq-88888888-bbbb', ids: ['in-a'], to: 'interview' } })).status, 409);
}

/* -------------------------------- decisions ----------------------------- */

{
  hookLog.length = 0;
  const kit = makeKit([pipeline, spy], { cycles: [cycleRow()], applications: [app('in-a', { stage: 'decision' }), app('in-b', { stage: 'decision' }), app('in-w', { stage: 'waitlisted', outcome: 'waitlisted' })] });
  const body = { requestId: 'rq-99999999-cccc', ids: ['in-a', 'in-b', 'in-zz'], outcome: 'accepted', reason: '  Strong   build  ', subteam: 'Software' };
  const out = await call(kit, pipeline, 'POST', '/cycles/cy-fall/decisions', { body });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual(out.body.decided, [{ id: 'in-a', from: 'decision', editVersion: 1 }, { id: 'in-b', from: 'decision', editVersion: 1 }]);
  assert.deepEqual(out.body.skipped, [{ id: 'in-zz', reason: 'No such application' }]);
  const a = kit.mem.applications[0];
  assert.equal(a.stage, 'accepted', 'a decision moves to the stage recording that outcome');
  assert.equal(a.outcome, 'accepted');
  assert.deepEqual({ ...a.decision, at: 0 }, { outcome: 'accepted', reason: 'Strong build', by: 'lead@example.com', at: 0, subteam: 'software' }, 'subteam names resolve to keys');
  assert.deepEqual(kit.mem.audit.filter((x) => x.kind === 'decision').map((x) => [x.applicationId, x.detail.outcome, x.detail.from]), [['in-a', 'accepted', 'decision'], ['in-b', 'accepted', 'decision']]);
  assert.deepEqual(hookLog, [['moved', 'in-a', 'decision', 'accepted'], ['decided', 'in-a', 'accepted'], ['moved', 'in-b', 'decision', 'accepted'], ['decided', 'in-b', 'accepted']]);
  const replay = await call(kit, pipeline, 'POST', '/cycles/cy-fall/decisions', { body });
  assert.equal(replay.body.replayed, true);
  assert.equal(kit.apps.calls.filter((c) => c[0] === 'decide').length, 3, 'three attempts the first time, none on replay');
  const same = await call(kit, pipeline, 'POST', '/cycles/cy-fall/decisions', { body: { requestId: 'rq-aaaaaaaa-dddd', ids: ['in-w'], outcome: 'waitlisted' } });
  assert.equal(same.body.decided[0].from, 'waitlisted');
  assert.equal(hookLog.length, 5, 'no stage.moved when the stage did not change, still decision.set');
  const bad = async (body, re) => { const out = await call(kit, pipeline, 'POST', '/cycles/cy-fall/decisions', { body }); assert.equal(out.status, 400); assert.match(out.body.error, re); };
  await bad({ requestId: 'rq-bbbbbbbb-eeee', ids: ['in-a'], outcome: 'hired' }, /Choose an outcome/);
  await bad({ requestId: 'rq-bbbbbbbb-eeee', ids: ['in-a'], outcome: 'accepted', subteam: 'Plumbing' }, /Unknown subteam/);
  kit.mem.cycles[0].doc.pipeline.stages = DEFAULT_STAGES.filter((s) => s.key !== 'waitlisted');
  await bad({ requestId: 'rq-bbbbbbbb-eeee', ids: ['in-a'], outcome: 'waitlisted' }, /No stage records "waitlisted"/);
}

/* ---------------------------------- tags -------------------------------- */

{
  const kit = makeKit([pipeline], { cycles: [cycleRow()], applications: [app('in-a', { tags: ['old', 'keep'] }), app('in-b')] });
  const body = { requestId: 'rq-cccccccc-ffff', ids: ['in-a', 'in-b'], add: [' Strong  build ', 'strong build', ''], remove: ['old'] };
  const out = await call(kit, pipeline, 'POST', '/cycles/cy-fall/tags', { body });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual(out.body.tagged, [{ id: 'in-a', editVersion: 1, tags: ['keep', 'Strong build'] }, { id: 'in-b', editVersion: 1, tags: ['Strong build'] }]);
  assert.deepEqual(kit.mem.audit.map((x) => [x.kind, x.applicationId, x.detail.added, x.detail.removed]), [['tag', 'in-a', 1, 1], ['tag', 'in-b', 1, 1]]);
  assert.equal((await call(kit, pipeline, 'POST', '/cycles/cy-fall/tags', { body })).body.replayed, true);
  const none = await call(kit, pipeline, 'POST', '/cycles/cy-fall/tags', { body: { requestId: 'rq-dddddddd-aaaa', ids: ['in-a'], add: [' '] } });
  assert.equal(none.status, 400);
  assert.equal(none.body.error, 'Nothing to change');
  assert.equal((await call(kit, pipeline, 'POST', '/cycles/cy-fall/tags', { body: { requestId: 'rq-dddddddd-aaaa', ids: ['in-a'], add: 'x' } })).status, 400);
  assert.equal((await call(kit, pipeline, 'POST', '/cycles/cy-fall/tags', { body: { requestId: 'rq-dddddddd-aaaa', ids: ['in-a'], add: Array.from({ length: 21 }, (_, i) => 't' + i) } })).status, 400);
}

/* ------------------------------ postgres shape -------------------------- */

{
  const statements = [];
  const sql = (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    statements.push({ text, values });
    if (text.startsWith('SELECT stage, count(*)::int AS n FROM recruit_applications WHERE cycle_id = ? GROUP BY stage')) return { rows: [{ stage: 'screening', n: 2 }, { stage: 'applied', n: 1 }] };
    throw new Error('Unexpected synthetic SQL: ' + text);
  };
  const kit = { mode: 'postgres', sql: async () => sql, mem: null, now: () => 1 };
  const cycle = cycleRow();
  await assert.rejects(pipeline.validateSettings({ stages: DEFAULT_STAGES.filter((s) => s.key !== 'screening') }, cycle, kit), (e) => e.status === 409);
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0].values, ['cy-fall'], 'the count is parameterised by cycle');
  const out = await routeFor('GET', '/cycles/:cycle/pipeline').handler({ cycle, params: { cycle: 'cy-fall' }, query: {}, me: { email: 'x' }, role: 'lead' }, kit);
  assert.deepEqual(out.body.counts, { total: 3, byStage: { screening: 2, applied: 1 } });
  assert.equal(statements.length, 2);
}

/* ---------------------------- default settings -------------------------- */

assert.deepEqual(settingsOf({ doc: {} }).stages.map((s) => s.key), DEFAULT_STAGES.map((s) => s.key));
assert.equal(settingsOf({ doc: { pipeline: { reviewersMayMove: true } } }).reviewersMayMove, true);
assert.notEqual(pipeline.defaults({}).stages, pipeline.defaults({}).stages, 'defaults hand out fresh copies');

// The module file keeps to node built-ins and pure helpers: no sibling imports.
const source = await readFile(new URL('../lib/recruit/modules/pipeline.js', import.meta.url), 'utf8');
assert.equal(/from\s+['"]\.\.?\/modules\//.test(source), false);
assert.equal(/BEGIN|COMMIT/.test(source), false, 'no transactions');
assert.ok(new vm.Script(source.replace(/^export default/m, 'module.exports =').replace(/^export /gm, '')), 'parses');

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
  const source = await readFile(new URL('../src/client/recruit-pipeline.js', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/client/main.js', import.meta.url), 'utf8');
  const focusHelpers = main.slice(main.indexOf('function focusReference'), main.indexOf('function modalFocusables'));
  assert.equal((source.match(/RECRUIT\.register\(/g) || []).length, 1, 'exactly one registration');
  assert.ok(source.startsWith('// recruit:pipeline:start') && source.trimEnd().endsWith('// recruit:pipeline:end'), 'slice markers');
  assert.equal(/<select|<datalist/i.test(source), false, 'no native selects');
  const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const { document } = makeDom();
  const requests = [], toasts = [], backgrounds = [], menus = [], registered = [];
  let renders = 0, closes = 0, asyncPhase = false;
  const cycle = { id: 'cy-fall', version: 3, name: 'Fall 2026', status: 'open', doc: { subteams: [{ key: 'software', name: 'Software' }, { key: 'electrical', name: 'Electrical' }], pipeline: { stages: DEFAULT_STAGES.map((s) => ({ ...s })), views: [], reviewersMayMove: false } } };
  const rows = [{ id: 'in-a', name: 'Ada', stage: 'applied', editVersion: 2, tags: [] }, { id: 'in-b', name: 'Bo', stage: 'applied', editVersion: 5, tags: [] }, { id: 'in-c', name: 'Cy', stage: 'applied', editVersion: 0, tags: [] }];
  const ctx = vm.createContext({
    UI: { modal: null, recruit: { cycleId: 'cy-fall', cycle: { data: cycle, role: 'lead', counts: { total: 3, byStage: { applied: 3 } } }, apps: { key: 'cy-fall', rows, byId: Object.fromEntries(rows.map((r) => [r.id, r])), counts: { total: 3, byStage: { applied: 3 } } }, filters: {}, selected: new Set(), detail: {}, mod: {} } },
    MD: { esc }, I: new Proxy({}, { get: () => '' }), Store: { me: () => ({ email: 'lead@example.com' }) }, recruitDate: () => 'today', REMOTE: {},
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
  const run = (code) => vm.runInContext(code, ctx);
  const settle = () => new Promise((r) => setImmediate(r));
  const timeout = () => Object.assign(new Error('Timed out'), { name: 'TimeoutError' });
  const plain = (v) => JSON.parse(JSON.stringify(v)); // vm-realm values for deepStrictEqual
  const mod = registered[0];
  assert.equal(mod.name, 'pipeline');
  assert.equal(typeof mod.order, 'number');
  for (const key of [...Object.keys(mod.actions), ...Object.keys(mod.modals), ...Object.keys(mod.dd)]) assert.ok(key.startsWith('recruit-'), key);

  // Filters build the list query in a fixed key order; empties are dropped.
  assert.equal(run('rcPipeQuery')({ q: 'ada', stage: 'screening', flagged: true, dir: '', tag: 'a b', unscored: false, nope: 1 }), '?q=ada&stage=screening&tag=a%20b&flagged=1');
  assert.equal(run('rcPipeQuery')({}), '');
  assert.equal(run('rcPipeQuery')(undefined), '');
  assert.deepEqual(plain(run('rcPipeQueryOf')({ stage: 'x', flagged: true, q: '' })), { stage: 'x', flagged: '1' });
  // Saved views translate the list's group-keyed filter state to the server query and back.
  ctx.RECRUIT.filters = () => [
    { group: 'review', value: 'flagged', label: 'Flagged', query: { flagged: '1' } },
    { group: 'review', value: 'unscored', label: 'Unscored', query: { unscored: '1' } },
    { group: 'subteam', value: 'Electrical', label: 'Electrical', query: { subteam: 'Electrical' } },
  ];
  assert.deepEqual(plain(run('rcPipeQueryOf')({ stage: 'screening', review: 'flagged', subteam: 'Electrical', q: ' ada', view: 'x' })), { q: ' ada', stage: 'screening', flagged: '1', subteam: 'Electrical' }, 'group state becomes the server query');
  assert.deepEqual(plain(run('rcPipeQueryOf')({ review: 'nope' })), {}, 'an unknown group value adds nothing');
  assert.equal(run('rcPipeFilterSummary')(cycle, { stage: 'screening', subteam: 'Electrical', flagged: '1' }), 'Screening · Electrical · Flagged');
  assert.equal(run('rcPipeFilterSummary')(cycle, {}), 'All people');
  assert.equal(run('rcPipeFilterSummary')(cycle, { subteam: '__undecided' }), 'Undecided');

  assert.equal(mod.strip, undefined, 'the stage strip belongs to the Applications panel');
  assert.equal(mod.filters, undefined, 'stage filtering comes from the strip, not a filter group');
  assert.equal(mod.dd['recruit-app-stage'], undefined, 'the per-application stage control belongs to the Applications panel');
  const renders0 = renders;
  assert.equal(mod.columns[0].cell({ stage: 'screening' }, cycle), 'Screening');

  assert.deepEqual(plain(mod.selectionActions(['in-a'], cycle, 'lead').map((a) => a.action)), ['recruit-move-open', 'recruit-decide-open', 'recruit-tag-open']);
  assert.deepEqual(plain(mod.selectionActions(['in-a'], cycle, 'reviewer')), []);
  cycle.doc.pipeline.reviewersMayMove = true;
  assert.deepEqual(plain(mod.selectionActions(['in-a'], cycle, 'reviewer').map((a) => a.label)), ['Move to…']);
  cycle.doc.pipeline.reviewersMayMove = false;

  // Bulk move: one request id per dialog, kept across a timeout retry.
  ctx.UI.recruit.selected = new Set(['in-a', 'in-b']);
  mod.actions['recruit-move-open']({ dataset: {} });
  assert.equal(ctx.UI.modal.kind, 'recruit-move');
  assert.deepEqual(plain(ctx.UI.modal.ids), ['in-a', 'in-b']);
  assert.equal(/<select/i.test(document.body.innerHTML), false);
  assert.ok(document.body.querySelector('.modal [data-m="recruit-move-stage"]'), 'the stage choice is a dd');
  document.body.querySelector('[data-m="recruit-move-stage"]').dataset.value = 'screening';
  document.body.querySelector('[data-m="recruit-move-note"]').value = 'batch';
  asyncPhase = true;
  mod.actions['recruit-move-go']();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/recruit/cycles/cy-fall/moves');
  assert.equal(requests[0].method, 'POST');
  assert.ok(requests[0].signal instanceof AbortSignal, 'every fetch carries an AbortSignal');
  assert.match(requests[0].body.requestId, /^rq-[0-9a-f-]{36}$/);
  assert.deepEqual(requests[0].body, { requestId: requests[0].body.requestId, ids: ['in-a', 'in-b'], to: 'screening', note: 'batch' });
  const goButton = document.body.querySelector('[data-action="recruit-move-go"]');
  assert.equal(goButton.disabled, true);
  assert.equal(goButton.textContent, 'Moving…');
  mod.actions['recruit-move-go']();
  assert.equal(requests.length, 1, 'a second click while pending sends nothing');
  requests[0].reject(timeout());
  await settle();
  assert.equal(document.body.querySelector('[data-rc-error]').textContent, 'The request timed out. Try again.');
  assert.equal(document.body.querySelector('[data-rc-error]').hidden, false);
  assert.equal(goButton.disabled, false);
  assert.equal(ctx.UI.modal.kind, 'recruit-move', 'the dialog stays open for a retry');
  mod.actions['recruit-move-go']();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.requestId, requests[0].body.requestId, 'the retry replays the same request id');
  requests[1].resolve({ moved: [{ id: 'in-a', from: 'applied', editVersion: 3 }, { id: 'in-b', from: 'applied', editVersion: 1 }], skipped: [{ id: 'in-c', reason: 'x' }] });
  await settle();
  assert.equal(renders, renders0, 'no render() from the async completion');
  assert.equal(closes, 1);
  assert.deepEqual(backgrounds, ['recruit'], 'the list repaints through renderBackground');
  assert.deepEqual(toasts, ['Moved 2 to Screening · 1 skipped']);
  assert.equal(rows[0].stage, 'screening');
  assert.equal(rows[0].editVersion, 3);
  assert.equal(rows[1].stage, 'applied', 'a row older than the cached editVersion is not merged');
  assert.equal(rows[1].editVersion, 5);
  assert.deepEqual(ctx.UI.recruit.apps.counts.byStage, { applied: 1, screening: 2 });
  assert.deepEqual(ctx.UI.recruit.cycle.counts.byStage, { applied: 1, screening: 2 }, 'the cycle counts (the strip) shift too');
  assert.equal(ctx.UI.recruit.selected.size, 0);
  asyncPhase = false;

  // Decide and tag dialogs go through the same path.
  ctx.UI.recruit.selected = new Set(['in-c']);
  mod.actions['recruit-decide-open']({ dataset: {} });
  assert.equal(ctx.UI.modal.kind, 'recruit-decide');
  assert.ok(document.body.querySelector('[data-m="recruit-decide-outcome"]'));
  document.body.querySelector('[data-m="recruit-decide-reason"]').value = 'Great fit';
  document.body.querySelector('[data-m="recruit-decide-subteam"]').dataset.value = 'software';
  asyncPhase = true;
  mod.actions['recruit-decide-go']();
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].body, { requestId: requests[2].body.requestId, ids: ['in-c'], outcome: 'waitlisted', reason: 'Great fit', subteam: 'software' });
  assert.ok(requests[2].signal instanceof AbortSignal);
  requests[2].resolve({ decided: [{ id: 'in-c', from: 'applied', editVersion: 1 }], skipped: [] });
  await settle();
  assert.equal(rows[2].stage, 'waitlisted');
  assert.equal(rows[2].decision.outcome, 'waitlisted');
  assert.equal(toasts.at(-1), 'Marked 1 waitlisted');
  assert.equal(renders, renders0);
  asyncPhase = false;
  ctx.UI.recruit.selected = new Set(['in-a']);
  mod.actions['recruit-tag-open']({ dataset: {} });
  document.body.querySelector('[data-m="recruit-tag-add"]').value = 'Strong, build, ';
  mod.actions['recruit-tag-go']();
  assert.deepEqual(requests[3].body, { requestId: requests[3].body.requestId, ids: ['in-a'], add: ['Strong', 'build'], remove: [] });
  asyncPhase = true;
  requests[3].resolve({ tagged: [{ id: 'in-a', editVersion: 4, tags: ['Strong', 'build'] }], skipped: [] });
  await settle();
  assert.deepEqual(rows[0].tags, ['Strong', 'build']);
  assert.equal(toasts.at(-1), 'Tagged 1');
  asyncPhase = false;

  // Saved views: the menu is computed, saving PUTs the settings with the version.
  ctx.UI.recruit.filters['cy-fall'] = { stage: 'screening', review: 'flagged', q: '' };
  const host = { dataset: { m: 'recruit-view' } };
  const menu0 = mod.dd['recruit-view'](host);
  assert.ok(Array.isArray(menu0), 'the dd handler returns computed items for RECRUIT.dd to open');
  assert.equal(menus.length, 0, 'the module never opens a menu itself');
  assert.deepEqual(plain(menu0.map((i) => (i === '-' ? '-' : i.label))), ['Save current view…']);
  assert.equal(mod.dd['recruit-view'](host, 'x'), undefined, 'a pick is not a computed menu');
  menu0[0].run();
  assert.equal(ctx.UI.modal.kind, 'recruit-view');
  assert.ok(document.body.innerHTML.includes('Screening · Flagged'));
  document.body.querySelector('[data-m="recruit-view-name"]').value = 'Screening flagged';
  asyncPhase = true;
  mod.actions['recruit-view-go']();
  assert.equal(requests[4].path, '/recruit/cycles/cy-fall/settings/pipeline');
  assert.equal(requests[4].method, 'PUT');
  assert.ok(requests[4].signal instanceof AbortSignal);
  assert.equal(requests[4].body.version, 3, 'the cycle version rides along for the CAS');
  assert.deepEqual(requests[4].body.settings.views, [{ key: 'screening-flagged', name: 'Screening flagged', query: { stage: 'screening', flagged: '1' } }]);
  assert.deepEqual(requests[4].body.settings.stages.map((s) => s.key), DEFAULT_STAGES.map((s) => s.key));
  const saved = { ...cycle, version: 4, doc: { ...cycle.doc, pipeline: { ...cycle.doc.pipeline, views: requests[4].body.settings.views } } };
  requests[4].resolve({ cycle: saved });
  await settle();
  assert.equal(ctx.UI.recruit.cycle.data.version, 4, 'the returned cycle replaces the cached one');
  assert.equal(ctx.UI.recruit.filters['cy-fall'].view, 'screening-flagged');
  assert.equal(toasts.at(-1), 'View saved');
  assert.equal(renders, renders0);
  asyncPhase = false;
  const menu1 = mod.dd['recruit-view'](host);
  assert.deepEqual(plain(menu1.map((i) => (i === '-' ? '-' : i.label))), ['Screening flagged', '-', 'Save current view…', 'Manage views…']);
  assert.equal(menu1[0].selected, true);
  ctx.UI.recruit.filters['cy-fall'] = { stage: 'applied' };
  ctx.UI.recruit.apps = { key: 'cy-fall', rows, byId: {}, counts: {} };
  menu1[0].run();
  assert.deepEqual(plain(ctx.UI.recruit.filters['cy-fall']), { stage: 'screening', review: 'flagged', view: 'screening-flagged' }, 'applying a view restores the group state');
  assert.equal(ctx.UI.recruit.apps, undefined, 'the list reloads through the mount loader');
  assert.equal(renders, renders0 + 1, 'a view choice is a user action and renders');
  ctx.UI.recruit.cycle.role = 'reviewer';
  assert.deepEqual(plain(mod.dd['recruit-view']({ dataset: {} }).map((i) => i.label)), ['Screening flagged'], 'reviewers only open views');
  ctx.UI.recruit.cycle.role = 'lead';

  // Stages settings: rows edit a draft in place, submit PUTs the stages.
  const view = mod.settings.view(ctx.UI.recruit.cycle.data);
  assert.equal(/<select/i.test(view), false);
  assert.ok(view.startsWith('<form data-action="recruit-settings-pipeline"'), 'the cycles panel supplies the section and heading');
  document.body.innerHTML = view;
  const form = document.body.querySelector('form');
  document.body.querySelector('[data-m="recruit-stage-new"]').value = 'Phone screen';
  mod.actions['recruit-stage-add'](document.body.querySelector('[data-action="recruit-stage-add"]'));
  const keys = () => [...document.body.querySelectorAll('[data-rc-stage]')].map((r) => r.dataset.rcStage);
  assert.equal(keys().at(-1), 'phone_screen');
  assert.equal(document.activeElement.dataset.action, 'recruit-stage-remove');
  assert.equal(document.activeElement.dataset.key, 'phone_screen', 'focus lands on the new row');
  assert.equal(form.dataset.adminDirty, 'true');
  mod.actions['recruit-stage-up'](document.body.querySelector('[data-action="recruit-stage-up"][data-key="phone_screen"]'));
  assert.equal(keys().indexOf('phone_screen'), DEFAULT_STAGES.length - 1);
  assert.equal(document.activeElement.dataset.key, 'phone_screen', 'focus follows the moved row');
  document.body.querySelector('[name="stage-name-phone_screen"]').value = 'Phone call';
  mod.actions['recruit-stage-remove'](document.body.querySelector('[data-action="recruit-stage-remove"][data-key="offer"]'));
  assert.equal(keys().includes('offer'), false);
  assert.equal(document.body.querySelector('[name="stage-name-phone_screen"]').value, 'Phone call', 'edits survive a repaint');
  assert.equal(document.body.querySelector('[data-action="recruit-stage-remove"][data-key="applied"]').disabled, true);
  form.elements = { reviewersMayMove: { checked: true } };
  asyncPhase = true;
  const submit = mod.settings.submit(form, ctx.UI.recruit.cycle.data);
  assert.equal(requests[5].method, 'PUT');
  assert.equal(requests[5].body.version, 4);
  assert.equal(requests[5].body.settings.reviewersMayMove, true);
  assert.deepEqual(requests[5].body.settings.stages.find((s) => s.key === 'phone_screen'), { key: 'phone_screen', name: 'Phone call', kind: 'open' });
  assert.deepEqual(requests[5].body.settings.stages.find((s) => s.key === 'accepted'), { key: 'accepted', name: 'Accepted', kind: 'closed', outcome: 'accepted' });
  assert.equal(requests[5].body.settings.stages.some((s) => s.key === 'offer'), false);
  requests[5].resolve({ cycle: { ...saved, version: 5 } });
  await submit;
  assert.equal(ctx.UI.recruit.cycle.data.version, 5);
  assert.equal(ctx.UI.recruit.mod.pipeline.stageDraft, null);
  assert.equal(renders, renders0 + 1);
  asyncPhase = false;

  // Detail section: reasons stay hidden from reviewers until a closed stage.
  const app = { id: 'in-a', stage: 'screening', decision: { outcome: 'rejected', reason: 'Not this time', at: 1 } };
  assert.ok(mod.detailSections(app, cycle, 'lead')[0].html.includes('Not this time'));
  assert.equal(mod.detailSections(app, cycle, 'reviewer')[0].html.includes('Not this time'), false);
  assert.ok(mod.detailSections({ ...app, stage: 'rejected' }, cycle, 'reviewer')[0].html.includes('Not this time'));
  assert.ok(mod.detailSections({ id: 'in-z', stage: 'applied' }, cycle, 'lead')[0].html.includes('No decision yet'));
}

console.log('PASS: pipeline stage kinds and roles, one write per row with request idempotency, from-guard skips, decisions to the outcome stage, tags, saved views, populated stage removal blocked, hook fan-out; client filters build the query, bulk move keeps its request id across a timeout, completions repaint through renderBackground');
