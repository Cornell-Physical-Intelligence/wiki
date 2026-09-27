// The recruitment flow: the stage graph and checklist model (pure), then the
// people tracking routes in memory mode against a temp copy of lib/. Synthetic
// people only; no network, no keys, no configured database.
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (!process.env.RECRUIT_FLOW_TEST_ROOT) {
  const dir = await mkdtemp(join(tmpdir(), 'cupi-recruit-flow-'));
  try {
    await cp(new URL('../lib', import.meta.url), join(dir, 'lib'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    // The wiki roster the team helper reads in memory mode.
    await writeFile(join(dir, '.devdata.json'), JSON.stringify({ state: { users: [
      { email: 'admin@example.com', name: 'Ada Admin', role: 'admin', status: 'active' },
      { email: 'lead@example.com', name: 'Lee Lead', role: 'member', status: 'active' },
      { email: 'rev@example.com', name: 'Rae Reviewer', role: 'member', status: 'active' },
      { email: 'sub@example.com', name: 'Sam Scoped', role: 'member', status: 'active' },
      { email: 'outsider@example.com', name: 'Out Sider', role: 'member', status: 'active' },
    ] } }));
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, DEV_FAKE_AUTH: 'admin@example.com', RECRUIT_FLOW_TEST_ROOT: dir },
      stdio: 'inherit',
    });
    process.exitCode = result.status || (result.error ? 1 : 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
} else {
  globalThis.fetch = async () => { throw new Error('Network disabled in recruit tests'); };
  const root = process.env.RECRUIT_FLOW_TEST_ROOT;
  const lib = (p) => import(pathToFileURL(join(root, 'lib', p)));
  let clock = 1789600000000;
  Date.now = () => clock;
  const tick = (ms = 1000) => { clock += ms; return clock; };

  const flow = await lib('recruit/flow.js');
  const S = await lib('recruit/sections.js');

  /* ------------------------------- the model ------------------------------ */
  {
    // Older cycles read as the straight line they were; saved lists are exact.
    const line = { a: {}, b: {}, c: {} };
    assert.deepEqual([...flow.edgesOf(line)], [['a', ['b']], ['b', ['c']], ['c', []]]);
    const branched = { a: { next: ['b', 'c'] }, b: { next: ['c'] }, c: { next: [] }, d: { next: ['zz', 'd'] } };
    const edges = flow.edgesOf(branched);
    assert.deepEqual(edges.get('d'), [], 'unknown stages and self-links are dropped');
    const ranks = flow.ranksOf(edges);
    assert.deepEqual([ranks.get('a'), ranks.get('b'), ranks.get('c'), ranks.get('d')], [0, 1, 2, 0], 'a stage sits past the furthest stage leading to it');
    assert.deepEqual(flow.flowKeys(branched, ranks), ['a', 'd', 'b', 'c'], 'flow order is column, then the cycle order');
    assert.equal(flow.loopIn(flow.edgesOf({ a: { next: ['b'] }, b: { next: ['a'] } })), 'a');
    assert.equal(flow.loopIn(edges), null);

    // Fields: strict on edit, lenient on read.
    assert.throws(() => flow.cleanFields([{ key: 'x', type: 'choice', label: 'Pick' }]), /at least one choice/);
    assert.throws(() => flow.cleanFields([{ key: 'x', type: 'check', label: 'Done', each: true }]), /one answer for the whole team/);
    assert.throws(() => flow.cleanFields([{ key: 'x', type: 'check', label: 'A' }, { key: 'x', type: 'text', label: 'B' }]), /listed twice/);
    assert.throws(() => flow.cleanFields([{ key: 'Bad', type: 'check', label: 'A' }]), /needs a key/);
    assert.throws(() => flow.cleanFields([{ key: 'r', type: 'rating', label: 'R', max: 20 }]), /between 3 and 10/);
    assert.deepEqual(flow.cleanFields([{ key: 'ok', type: 'check', label: 'Ok' }, { key: 'bad', type: 'nope', label: 'x' }], { lenient: true }), [{ key: 'ok', type: 'check', label: 'Ok' }]);
    const rating = { key: 'score', type: 'rating', label: 'Score', max: 5, each: true };
    assert.equal(flow.cleanValue(rating, 4), 4);
    assert.throws(() => flow.cleanValue(rating, 6), /1 to 5/);
    assert.equal(flow.cleanValue(rating, null), null, 'null clears');
    assert.throws(() => flow.cleanValue({ key: 'd', type: 'date', label: 'Date' }, '2026-02-30'), /date like/);
    assert.throws(() => flow.cleanValue({ key: 'm', type: 'member', label: 'Who' }, 'x@example.com', { members: ['y@example.com'] }), /team/);
    assert.equal(flow.cleanValue({ key: 'n', type: 'note', label: 'N' }, '  line one\r\nline two  '), 'line one\nline two');
    assert.throws(() => flow.cleanValue({ key: 'c', type: 'check', label: 'C' }, 'yes'), /checked or not/);

    // Where a person stands: furthest form first, then the team's move, then
    // a later form after the move.
    const sections = { interest: { form: {}, fields: [] }, coffee: { form: {}, fields: [{ key: 'completed', type: 'check', label: 'Done' }], done: 'completed' }, application: { form: {}, fields: [] }, interview: { form: null, fields: [{ key: 'completed', type: 'check', label: 'Done' }], done: 'completed' } };
    const f = flow.flowOf(sections);
    const subs = [{ section: 'interest', ts: 10 }, { section: 'coffee', ts: 20 }];
    assert.equal(flow.positionOf(f, subs, {}), 'coffee');
    assert.equal(flow.positionOf(f, subs, { stage: 'interest', stageAt: 30 }), 'interest', 'a move back stands');
    assert.equal(flow.positionOf(f, [...subs, { section: 'application', ts: 40 }], { stage: 'interest', stageAt: 30 }), 'application', 'a later form after the move moves them on');
    assert.equal(flow.positionOf(f, [...subs, { section: 'coffee', ts: 40 }], { stage: 'interview', stageAt: 30 }), 'interview', 'a form for an earlier stage never moves them back');
    const pf = flow.personFlow(f, [...subs, { section: 'application', ts: 40 }], {});
    assert.deepEqual(pf.states, { interest: 'done', coffee: 'open', application: 'current', interview: 'ahead' }, 'a coffee chat requested and never held reads open');
    const held = flow.personFlow(f, subs, { fields: { coffee: { completed: { v: true } } } });
    assert.equal(held.done.coffee, true);
    assert.equal(held.states.coffee, 'current');
    const skipped = flow.personFlow(f, [{ section: 'interest', ts: 1 }], { stage: 'interview', stageAt: 2 });
    assert.deepEqual([skipped.states.coffee, skipped.states.application, skipped.states.interview], ['skipped', 'skipped', 'current']);
    assert.equal(flow.personFlow(f, subs, { status: 'bogus' }).status, 'active');

    // Summaries: the team's answer, or per-reviewer answers with the reader's own.
    assert.deepEqual(flow.fieldSummary(rating, { each: { 'a@x.co': { v: 4 }, 'b@x.co': { v: 5 } } }, 'a@x.co'), { n: 2, avg: 4.5, mine: 4 });
    assert.equal(flow.fieldSummary({ key: 'c', type: 'check', label: 'C' }, { v: false }), false);
    assert.equal(flow.fieldSummary({ key: 't', type: 'note', label: 'T' }, { v: null }), null);

    // Insights: statuses, reach, completion and what the checklists hold.
    const people = [
      { email: 'a@x.co', subteam: 'Software', year: 'Junior', flagged: true, comments: 2, submissions: [{ section: 'interest', ts: 1789600000000 }, { section: 'coffee', ts: 1789600000000 }], track: { fields: { coffee: { completed: { v: true } } } } },
      { email: 'b@x.co', subteam: '', year: null, flagged: false, comments: 0, submissions: [{ section: 'interest', ts: 1789600000000 }, { section: 'coffee', ts: 1789600000000 }], track: { status: 'declined' } },
      { email: 'c@x.co', subteam: 'Software', year: 'Junior', flagged: false, comments: 1, submissions: [{ section: 'interest', ts: 1789600000000 }], track: { stage: 'interview', stageAt: 1789600000001, status: 'accepted', fields: { interview: { completed: { v: true } } } } },
    ];
    const ins = flow.insightsFor(f, people, { now: 1789600000000 });
    assert.equal(ins.people, 3);
    assert.deepEqual(ins.statuses, { active: 1, accepted: 1, waitlisted: 0, declined: 1, withdrew: 0 });
    const coffee = ins.stages.find((s) => s.key === 'coffee');
    assert.deepEqual([coffee.reached, coffee.done, coffee.here, coffee.declined, coffee.responses, coffee.notDone], [2, 1, 1, 1, 2, 1]);
    assert.deepEqual(coffee.fields[0].summary, { yes: 1, of: 2 }, 'a chat completed for one of the two who reached coffee chats');
    assert.deepEqual(ins.stages.find((s) => s.key === 'interview').fields[0].summary, { yes: 1, of: 1 });
    assert.deepEqual(ins.subteams, [{ name: 'Software', n: 2 }, { name: 'Undecided', n: 1 }]);
    assert.equal(ins.daily.length, 1);
    assert.deepEqual(ins.daily[0].counts, { interest: 3, coffee: 2 });
    console.log('PASS: flow model — edges, loops, columns, fields, values, positions, stage states, summaries and insights');
  }

  /* ------------------------------- stage shape ---------------------------- */
  {
    const legacy = { id: 'cy-x', doc: { site: { sections: { coffee: { title: 'Coffee chats', open: true, form: { questions: S.defaultQuestions() } } } } } };
    const sec = S.sectionsFor(legacy);
    assert.equal(sec.coffee.kind, 'meeting', 'a coffee chat form saved before the flow chart is a meeting');
    assert.deepEqual(sec.coffee.fields.map((x) => x.key), ['completed', 'met_with', 'notes'], 'and gains the chat-completed checklist');
    assert.equal(sec.coffee.done, 'completed');
    assert.equal(sec.interest.next, undefined, 'older cycles keep implicit connections');
    const made = S.validateSite({ sections: { interview: { title: 'Interview', form: null, kind: 'meeting', fields: [{ key: 'done', type: 'check', label: 'Held' }], done: 'done' } }, order: ['interest', 'coffee', 'application', 'interview'] }, legacy);
    assert.equal(made.sections.interview.form, null);
    const withInterview = { ...legacy, doc: { site: made } };
    assert.deepEqual(S.publicSections(withInterview).map((x) => x.key), ['interest', 'coffee', 'application'], 'a stage without a form never reaches the website');
    assert.throws(() => S.validateSite({ sections: { interview: { open: true } } }, withInterview), /no form to open/);
    assert.throws(() => S.validateSite({ sections: { interview: { next: ['interest'] } } }, withInterview), /loop back/);
    assert.throws(() => S.validateSite({ sections: { interest: { next: ['interest'] } } }, withInterview), /cannot lead to itself/);
    assert.throws(() => S.validateSite({ sections: { interest: { next: ['ghost'] } } }, withInterview), /does not have/);
    assert.throws(() => S.validateSite({ sections: { interview: { done: 'nope' } } }, withInterview), /its own checkboxes/);
    assert.throws(() => S.validateSite({ landing: 'interview' }, withInterview), /needs a form/);
    assert.throws(() => S.validateSite({ sections: { interview: { kind: 'party' } } }, withInterview), /form, meeting, review or step/);
    // Dropping the done checkbox from the fields clears `done` instead of failing.
    const cleared = S.validateSite({ sections: { interview: { fields: [{ key: 'notes', type: 'note', label: 'Notes' }] } } }, withInterview);
    assert.equal(cleared.sections.interview.done, null);
    // A removed stage's connections fall away.
    const linked = { ...legacy, doc: { site: S.validateSite({ sections: { application: { next: ['interview'] } } }, withInterview) } };
    const removed = S.validateSite({ remove: ['interview'] }, linked);
    assert.deepEqual(removed.sections.application.next, []);
    assert.equal(S.newCycleSite().sections.interview.form, null);
    console.log('PASS: stage shape — legacy coffee chats gain the checklist, formless stages stay off the website, connections validate');
  }

  /* ------------------------------- the routes ----------------------------- */
  const R = await lib('recruit/index.js');
  const USERS = { 'admin@example.com': 'admin', 'lead@example.com': 'member', 'rev@example.com': 'member', 'sub@example.com': 'member', 'outsider@example.com': 'member' };
  const NAMES = { 'admin@example.com': 'Ada Admin', 'lead@example.com': 'Lee Lead', 'rev@example.com': 'Rae Reviewer', 'sub@example.com': 'Sam Scoped', 'outsider@example.com': 'Out Sider' };
  function call(method, path, body, as = 'admin@example.com') {
    return new Promise((resolve, reject) => {
      const headers = {};
      const req = { method, url: '/api' + path, headers: { host: 'wiki.test', origin: 'https://cornellphysicalintelligence.com' }, socket: { remoteAddress: '127.0.0.1' }, body };
      const res = {
        statusCode: 200, setHeader(k, v) { headers[k.toLowerCase()] = v; }, getHeader(k) { return headers[k.toLowerCase()]; },
        end(data) { let parsed = data; try { parsed = JSON.parse(data); } catch { /* csv */ } resolve({ status: this.statusCode, body: parsed, headers }); },
      };
      const me = async () => ({ email: as, name: NAMES[as], role: USERS[as], status: 'active' });
      R.handleRecruit(req, res, path.split('?')[0], { me, readJson: async () => body ?? {}, host: 'wiki.test' }).catch(reject);
    });
  }
  const ok = (r, msg) => { assert.ok(r.status >= 200 && r.status < 300, `${msg}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const rq = () => 'rq-' + Math.random().toString(36).slice(2, 12);

  // A fresh cycle starts with the default flow, interview included.
  const created = ok(await call('POST', '/recruit/cycles', { requestId: rq(), name: 'Fall 2027', term: 'Fall 2027' }), 'create');
  const id = created.cycle.id;
  let cycle = ok(await call('GET', `/recruit/cycles/${id}`), 'get cycle');
  assert.deepEqual(Object.keys(cycle.sections), ['interest', 'coffee', 'application', 'interview']);
  assert.equal(cycle.sections.interview.form, null);
  assert.deepEqual(cycle.sections.interest.next, ['coffee', 'application'], 'coffee chats are optional in the default flow');
  assert.deepEqual(cycle.team.map((m) => m.email), ['admin@example.com'], 'the team is the admins until roles are granted');
  assert.equal(cycle.me.email, 'admin@example.com');
  ok(await call('PUT', `/recruit/cycles/${id}/roles/lead@example.com`, { requestId: rq(), roles: ['lead'], subteams: [] }), 'grant lead');
  ok(await call('PUT', `/recruit/cycles/${id}/roles/rev@example.com`, { requestId: rq(), roles: ['reviewer'], subteams: [] }), 'grant reviewer');
  ok(await call('PUT', `/recruit/cycles/${id}/roles/sub@example.com`, { requestId: rq(), roles: ['reviewer'], subteams: ['software'] }), 'grant scoped reviewer');
  cycle = ok(await call('GET', `/recruit/cycles/${id}`, null, 'rev@example.com'), 'reviewer reads the cycle');
  assert.deepEqual(cycle.team.map((m) => m.name), ['Ada Admin', 'Lee Lead', 'Rae Reviewer', 'Sam Scoped'], 'reviewers see the team by name, not the roster');

  // People arrive through forms.
  const kit = R.kitFor({});
  const cyc = await kit.cycles.get(id);
  const add = async (email, name, section, extra = {}) => { tick(); return kit.apps.create(cyc, { name, email, cornell: true, section, answers: {}, by: 'test', subteam: extra.subteam || '', year: extra.year || null }); };
  await add('ann@cornell.edu', 'Ann', 'interest', { subteam: 'Software', year: 'Junior' });
  await add('ann@cornell.edu', 'Ann', 'coffee', { subteam: 'Software' });
  await add('ben@cornell.edu', 'Ben', 'interest', { subteam: 'Mechanical' });
  await add('ben@cornell.edu', 'Ben', 'application', { subteam: 'Mechanical' });
  await add('cat@cornell.edu', 'Cat', 'coffee', { subteam: 'Software' });
  await add('dan@cornell.edu', 'Dan', 'interest');

  let list = ok(await call('GET', `/recruit/cycles/${id}/people?limit=100`), 'people');
  const byEmail = (rows) => Object.fromEntries(rows.map((p) => [p.email, p]));
  let people = byEmail(list.rows);
  assert.equal(people['ann@cornell.edu'].stage, 'coffee');
  assert.equal(people['ben@cornell.edu'].stage, 'application');
  assert.equal(people['ben@cornell.edu'].states.coffee, 'skipped', 'Ben went straight to the application');
  assert.equal(people['ann@cornell.edu'].status, 'active');
  assert.deepEqual(list.counts.byStatus, { active: 4, accepted: 0, waitlisted: 0, declined: 0, withdrew: 0 });
  assert.deepEqual(list.counts.byStage, { coffee: 2, application: 1, interest: 1 });
  assert.ok(!('_track' in list.rows[0]) && !('_submissions' in list.rows[0]), 'internal fields never leave the server');

  // Checklist values: a reviewer ticks the chat, the value is the person's.
  const field = (email, stage, key, value, as = 'rev@example.com') => call('PATCH', `/recruit/cycles/${id}/people/${encodeURIComponent(email)}/fields`, { stage, field: key, value }, as);
  let out = ok(await field('ann@cornell.edu', 'coffee', 'completed', true), 'tick chat');
  assert.equal(out.person.done.coffee, true);
  assert.equal(out.person.track.fields.coffee.completed.v, true);
  assert.equal(out.person.track.fields.coffee.completed.by, 'rev@example.com');
  assert.equal(out.person.track.fields.coffee.completed.name, 'Rae Reviewer');
  ok(await field('ann@cornell.edu', 'coffee', 'met_with', 'Lee'), 'met with');
  out = ok(await field('ann@cornell.edu', 'coffee', 'notes', 'Great chat about robots.', 'lead@example.com'), 'notes');
  assert.equal(out.person.track.fields.coffee.completed.v, true, 'setting one field never clears another');
  assert.equal(out.person.fields.coffee.met_with, 'Lee');
  assert.equal((await field('ann@cornell.edu', 'coffee', 'completed', 'yes')).status, 400, 'values are validated');
  assert.equal((await field('ann@cornell.edu', 'coffee', 'ghost', true)).status, 400);
  assert.equal((await field('ann@cornell.edu', 'nowhere', 'completed', true)).status, 400);
  assert.equal((await field('ann@cornell.edu', 'coffee', 'completed', true, 'outsider@example.com')).status, 403, 'people outside the cycle cannot write');
  assert.equal((await field('nobody@cornell.edu', 'coffee', 'completed', true)).status, 404);
  // Per-reviewer scores keep one answer each.
  ok(await field('ben@cornell.edu', 'application', 'score', 4, 'rev@example.com'), 'score 1');
  out = ok(await field('ben@cornell.edu', 'application', 'score', 2, 'lead@example.com'), 'score 2');
  assert.deepEqual(out.person.fields.application.score, { n: 2, avg: 3, mine: 2 });
  assert.equal(out.person.track.fields.application.score.each['rev@example.com'].v, 4);
  // A person field names someone on the team.
  assert.equal((await field('ben@cornell.edu', 'interview', 'interviewer', 'outsider@example.com', 'lead@example.com')).status, 400);
  ok(await field('ben@cornell.edu', 'interview', 'interviewer', 'Rev@Example.com', 'lead@example.com'), 'interviewer');
  // Scoped reviewers only reach their subteam's people.
  assert.equal((await field('ben@cornell.edu', 'application', 'score', 5, 'sub@example.com')).status, 404, 'a Software reviewer cannot score a Mechanical applicant');
  ok(await field('cat@cornell.edu', 'coffee', 'completed', false, 'sub@example.com'), 'scoped reviewer on their own subteam');

  // Moves: leads place people and set their status; reviewers cannot.
  const move = (email, body, as = 'lead@example.com') => call('POST', `/recruit/cycles/${id}/people/${encodeURIComponent(email)}/move`, body, as);
  assert.equal((await move('ann@cornell.edu', { requestId: rq(), stage: 'interview' }, 'rev@example.com')).status, 403);
  assert.equal((await move('ann@cornell.edu', { stage: 'interview' })).status, 400, 'moves carry a request id');
  assert.equal((await move('ann@cornell.edu', { requestId: rq(), stage: 'ghost' })).status, 400);
  assert.equal((await move('ann@cornell.edu', { requestId: rq(), status: 'maybe' })).status, 400);
  assert.equal((await move('ann@cornell.edu', { requestId: rq() })).status, 400);
  const again = rq();
  tick();
  out = ok(await move('ann@cornell.edu', { requestId: again, stage: 'interview' }), 'move');
  assert.equal(out.person.stage, 'interview');
  assert.equal(out.person.states.application, 'skipped');
  assert.deepEqual(out.person.track.moves.at(-1).stage, { from: 'coffee', to: 'interview' });
  const replay = ok(await move('ann@cornell.edu', { requestId: again, stage: 'interview' }), 'replay');
  assert.equal(replay.person.track.moves.length, 1, 'a retried move is applied once');
  tick();
  out = ok(await move('ann@cornell.edu', { requestId: rq(), status: 'accepted' }), 'accept');
  assert.equal(out.person.status, 'accepted');
  assert.deepEqual(out.person.track.moves.at(-1).status, { from: 'active', to: 'accepted' });

  // Bulk: one move for many, each keeps where they came from.
  tick();
  const bulk = ok(await call('POST', `/recruit/cycles/${id}/moves`, { requestId: rq(), emails: ['ben@cornell.edu', 'cat@cornell.edu', 'ghost@cornell.edu'], status: 'declined' }, 'lead@example.com'), 'bulk');
  assert.equal(bulk.moved, 2);
  assert.deepEqual(bulk.missing, ['ghost@cornell.edu']);
  assert.equal((await call('POST', `/recruit/cycles/${id}/moves`, { requestId: rq(), emails: [], status: 'declined' }, 'lead@example.com')).status, 400);
  assert.equal((await call('POST', `/recruit/cycles/${id}/moves`, { requestId: rq(), emails: ['ben@cornell.edu'], status: 'declined' }, 'rev@example.com')).status, 403);
  const ben = ok(await call('GET', `/recruit/cycles/${id}/people/${encodeURIComponent('ben@cornell.edu')}`), 'ben');
  assert.equal(ben.person.status, 'declined');
  assert.deepEqual(ben.person.track.moves.at(-1).status, { from: 'active', to: 'declined' });
  assert.equal(ben.person.stage, 'application', 'declining keeps them where they were');
  ok(await call('POST', `/recruit/cycles/${id}/moves`, { requestId: rq(), emails: ['cat@cornell.edu'], status: 'active' }, 'lead@example.com'), 'reactivate');

  // Filters and sorting over the whole cycle.
  const query = async (qs, as) => ok(await call('GET', `/recruit/cycles/${id}/people?${qs}`, null, as), qs).rows.map((p) => p.email);
  assert.deepEqual(await query('stage=interview'), ['ann@cornell.edu']);
  assert.deepEqual((await query('reached=coffee')).sort(), ['ann@cornell.edu', 'cat@cornell.edu']);
  assert.deepEqual(await query('done=coffee'), ['ann@cornell.edu'], 'who actually had their coffee chat');
  assert.deepEqual(await query('notdone=coffee'), ['cat@cornell.edu'], 'who requested one and never had it');
  assert.deepEqual(await query('status=declined'), ['ben@cornell.edu']);
  assert.deepEqual(await query('sort=name'), ['ann@cornell.edu', 'ben@cornell.edu', 'cat@cornell.edu', 'dan@cornell.edu']);
  assert.deepEqual(await query('sort=stage'), ['dan@cornell.edu', 'cat@cornell.edu', 'ben@cornell.edu', 'ann@cornell.edu']);
  assert.deepEqual(await query('subteam=Software&sort=name'), ['ann@cornell.edu', 'cat@cornell.edu']);
  assert.deepEqual(await query('subteam=none'), ['dan@cornell.edu']);
  assert.equal((await call('GET', `/recruit/cycles/${id}/people?stage=ghost`)).status, 400);
  assert.equal((await call('GET', `/recruit/cycles/${id}/people?status=maybe`)).status, 400);
  assert.deepEqual((await query('sort=name', 'sub@example.com')), ['ann@cornell.edu', 'cat@cornell.edu'], 'scoped reviewers list their subteam');
  // Paging follows the chosen order.
  const page1 = ok(await call('GET', `/recruit/cycles/${id}/people?sort=name&limit=3`), 'page 1');
  const page2 = ok(await call('GET', `/recruit/cycles/${id}/people?sort=name&limit=3&cursor=${page1.next}`), 'page 2');
  assert.deepEqual([...page1.rows, ...page2.rows].map((p) => p.name), ['Ann', 'Ben', 'Cat', 'Dan']);
  assert.equal(page2.next, null);
  assert.equal((await call('GET', `/recruit/cycles/${id}/people?cursor=bad`)).status, 400);
  const newest = Math.max(...[...page1.rows, ...page2.rows].map((p) => p.last));
  const legacyCursor = Buffer.from(JSON.stringify({ last: newest + 1, email: '' })).toString('base64url');
  assert.equal(ok(await call('GET', `/recruit/cycles/${id}/people?cursor=${legacyCursor}`), 'legacy cursor').rows.length, 4, 'cursors from before stay readable');

  // Comments may name a stage.
  const commented = ok(await call('POST', `/recruit/cycles/${id}/people/${encodeURIComponent('cat@cornell.edu')}/comments`, { id: 'ic-flow-test-1', text: 'Missed the chat twice.', stage: 'coffee' }, 'rev@example.com'), 'comment');
  assert.equal(commented.person.review.comments.at(-1).stage, 'coffee');
  assert.equal((await call('POST', `/recruit/cycles/${id}/people/${encodeURIComponent('cat@cornell.edu')}/comments`, { id: 'ic-flow-test-2', text: 'x', stage: 'ghost' }, 'rev@example.com')).status, 400);

  // Insights, in the reader's scope.
  const ins = ok(await call('GET', `/recruit/cycles/${id}/insights`), 'insights');
  assert.equal(ins.people, 4);
  assert.deepEqual(ins.statuses, { active: 2, accepted: 1, waitlisted: 0, declined: 1, withdrew: 0 });
  const coffeeInsight = ins.stages.find((s) => s.key === 'coffee');
  assert.deepEqual(coffeeInsight.fields.find((x) => x.key === 'completed').summary, { yes: 1, of: 2 });
  assert.deepEqual(coffeeInsight.fields.find((x) => x.key === 'met_with').summary.top, [{ value: 'Lee', n: 1 }]);
  assert.equal(ins.stages.find((s) => s.key === 'application').fields.find((x) => x.key === 'score').summary.avg, 3);
  assert.equal(ok(await call('GET', `/recruit/cycles/${id}/insights`, null, 'sub@example.com'), 'scoped insights').people, 2);

  // A stage holding people or checklist entries is not removed; nor is a
  // form with responses taken off its stage.
  const site = (settings, as = 'lead@example.com') => call('PUT', `/recruit/cycles/${id}/settings/site`, { version: cycle.version, settings }, as);
  cycle = ok(await call('GET', `/recruit/cycles/${id}`), 'reload').cycle;
  let refused = await site({ remove: ['interview'] });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /1 person is at Interview/);
  refused = await site({ sections: { coffee: { form: null } } });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Coffee chats's form has 2 responses/);
  // An empty stage can go, and a new one can come, with connections.
  const added = ok(await site({ sections: { onsite: { title: 'Onsite', form: null, kind: 'meeting', fields: [{ key: 'attended', type: 'check', label: 'Attended' }], done: 'attended', next: [] }, interview: { next: ['onsite'] } }, order: ['interest', 'coffee', 'application', 'interview', 'onsite'] }), 'add onsite');
  cycle = added.cycle;
  const flowNow = ok(await call('GET', `/recruit/cycles/${id}`), 'flow').sections;
  assert.deepEqual(flowNow.interview.next, ['onsite']);
  // Point the website at this cycle and read what it publishes.
  kit.mem.settings.doc.migration = { done: true };
  kit.memSave(); kit.uncache();
  cycle = ok(await call('POST', `/recruit/cycles/${id}/status`, { version: cycle.version, status: 'open' }), 'open').cycle;
  ok(await call('POST', `/recruit/cycles/${id}/intake`, { version: (await kit.cycles.settings()).version, on: true }), 'receive the website');
  const feed = ok(await call('GET', '/recruit/site'), 'feed');
  assert.deepEqual(feed.sections.map((s) => s.key), ['interest', 'coffee', 'application'], 'the website lists only the stages with a form');
  assert.ok(feed.sections.every((s) => !('fields' in s) && !('next' in s) && !('kind' in s)), 'checklists and connections never reach the website');
  const refusedPost = await call('POST', '/recruit/site/onsite', { answers: { name: 'X', email: 'x@cornell.edu' } });
  assert.equal(refusedPost.status, 404, 'a stage without a form takes no submissions');
  ok(await site({ remove: ['onsite'] }), 'remove empty onsite');
  cycle = ok(await call('GET', `/recruit/cycles/${id}`), 'reload').cycle;
  assert.equal(ok(await call('GET', `/recruit/cycles/${id}`), 'reload').sections.interview.next.length, 0, 'a removed stage takes its connections with it');

  // The people CSV: the familiar header by default, everything with ?columns=full.
  const csv = await call('GET', `/recruit/cycles/${id}/people.csv?columns=full&sort=name`, null, 'lead@example.com');
  assert.equal(csv.status, 200);
  const [head, ...lines] = String(csv.body).replace(/^﻿/, '').split('\r\n');
  assert.match(head, /"Status","Stage"/);
  assert.match(head, /"Coffee chats: Chat completed","Coffee chats: Met with","Coffee chats: Notes"/);
  assert.match(head, /"Application form: Score"/);
  const annLine = lines.find((l) => l.includes('ann@cornell.edu'));
  assert.match(annLine, /"accepted","Interview"/);
  assert.match(annLine, /"yes","Lee","Great chat about robots\."/);
  assert.match(lines.find((l) => l.includes('ben@cornell.edu')), /"3 \(2\)"/, 'per-reviewer scores export as their average');
  const plain = await call('GET', `/recruit/cycles/${id}/people.csv`, null, 'lead@example.com');
  assert.doesNotMatch(String(plain.body).split('\r\n')[0], /Status|Chat completed/);
  // A lead's stage and field names become headers, and no header starts a formula.
  cycle = ok(await call('GET', `/recruit/cycles/${id}`), 'reload').cycle;
  ok(await site({ sections: { evil: { title: '=Evil', form: null, kind: 'step', fields: [{ key: 'cmd', type: 'text', label: '@cmd' }], next: [] } }, order: ['interest', 'coffee', 'application', 'interview', 'evil'] }), 'a stage named like a formula');
  const guarded = String((await call('GET', `/recruit/cycles/${id}/people.csv?columns=full`, null, 'lead@example.com')).body).replace(/^\uFEFF/, '').split('\r\n')[0];
  assert.match(guarded, /"'=Evil","/); assert.match(guarded, /"'=Evil: @cmd"/);

  // Everything is audited.
  const audit = ok(await call('GET', `/recruit/cycles/${id}/audit`), 'audit').rows.map((a) => a.kind);
  for (const kind of ['person.field', 'person.move', 'comment.post']) assert.ok(audit.includes(kind), `${kind} is audited`);
  console.log('PASS: people tracking — checklist values per stage and per reviewer, team-only person fields, scoped writes, idempotent single and bulk moves, filters, sorting and paging, stage comments, insights, removal guards, feed and CSV');
}
