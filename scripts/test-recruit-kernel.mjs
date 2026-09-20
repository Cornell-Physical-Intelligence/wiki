// Synthetic fixtures only: memory-mode storage in a temp copy of lib/, no network, no keys.
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (!process.env.RECRUIT_KERNEL_TEST_ROOT) {
  const dir = await mkdtemp(join(tmpdir(), 'cupi-recruit-kernel-'));
  try {
    await cp(new URL('../lib', import.meta.url), join(dir, 'lib'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, DEV_FAKE_AUTH: 'admin@example.com', RECRUIT_KERNEL_TEST_ROOT: dir },
      stdio: 'inherit',
    });
    process.exitCode = result.status || (result.error ? 1 : 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
} else {
  globalThis.fetch = async () => { throw new Error('Network disabled in recruit tests'); };
  const root = process.env.RECRUIT_KERNEL_TEST_ROOT;
  const lib = (p) => import(pathToFileURL(join(root, 'lib', p)));
  const users = [
    { email: 'admin@example.com', name: 'Ada Admin', role: 'admin', status: 'active', subteam: 'Team Lead' },
    { email: 'lead@example.com', name: 'Lee Lead', role: 'member', status: 'active', subteam: 'Software' },
    { email: 'rev@example.com', name: 'Rae Reviewer', role: 'member', status: 'active', subteam: 'Electrical' },
    { email: 'plain@example.com', name: 'Pat Plain', role: 'member', status: 'active', subteam: '' },
    { email: 'gone@example.com', name: 'Gone', role: 'member', status: 'removed', subteam: '' },
  ];
  await writeFile(join(root, '.devdata.json'), JSON.stringify({ state: { users, pages: [], trash: [], activity: [], settings: {} }, version: 1, prefs: {}, files: [] }));

  const { createRecruit, compileRoute } = await lib('recruit/registry.js');
  const { allowed, roleOf, scopeFor } = await lib('recruit/permissions.js');
  const { INTAKE_VOCAB, FIXED_FORM_V1, validateAnswers, fixedFormFor } = await lib('recruit/fixed-form.js');
  const cycles = (await lib('recruit/modules/cycles.js')).default;
  const applications = (await lib('recruit/modules/applications.js')).default;
  const roles = (await lib('recruit/modules/roles.js')).default;

  /* ---- vocabularies never drift from interest.js ---- */
  const interestSource = await readFile(join(root, 'lib/interest.js'), 'utf8');
  const listOf = (name) => JSON.parse(/const NAME = new Set\((\[[^\]]*\])\)/.source && new RegExp(`const ${name} = new Set\\((\\[[^\\]]*\\])\\)`).exec(interestSource)[1].replace(/'/g, '"'));
  assert.deepEqual([...INTAKE_VOCAB.SUBTEAMS], listOf('SUBTEAMS'));
  assert.deepEqual([...INTAKE_VOCAB.YEARS], listOf('YEARS'));
  assert.deepEqual([...INTAKE_VOCAB.FILE_TYPES], listOf('FILE_TYPES'));
  assert.equal(INTAKE_VOCAB.MAX_FILE, 2.5 * 1024 * 1024);
  assert.deepEqual(FIXED_FORM_V1.questions.map((q) => q.key), ['name', 'email', 'subteam', 'year', 'project', 'file']);
  assert.ok(FIXED_FORM_V1.questions.every((q) => q.system));
  const v = validateAnswers(FIXED_FORM_V1, { name: '  Ada   Lovelace ', email: 'ADA@Cornell.EDU', subteam: 'Software', year: 'Grad', project: 'x'.repeat(2000), extra: 'dropped' });
  assert.equal(v.columns.name, 'Ada Lovelace');
  assert.equal(v.columns.email, 'ada@cornell.edu');
  assert.equal(v.columns.cornell, true);
  assert.equal(v.answers.project.length, 1000);
  assert.equal(v.answers.extra, undefined);
  assert.equal(validateAnswers(FIXED_FORM_V1, { name: 'A', email: 'a@b.co', year: 'Unknown' }).error, 'Choose Freshman, Sophomore, Junior, Senior, or Grad for year');
  assert.equal(validateAnswers(FIXED_FORM_V1, { name: 'A', email: 'a@b.co', subteam: 'Robots' }).columns.subteam, '', 'unknown subteam becomes blank like today');
  assert.equal(validateAnswers(FIXED_FORM_V1, { name: '', email: 'a@b.co' }).error, 'Tell us your name');
  assert.equal(validateAnswers(FIXED_FORM_V1, { name: 'A', email: 'nope' }).error, 'That email does not look right');
  assert.equal(validateAnswers(FIXED_FORM_V1, { name: 'A', email: 'a@b.co', file: { name: 'x', type: 'text/plain', data: 'aGk=' } }).error, 'Images or PDF only');
  assert.equal(validateAnswers(FIXED_FORM_V1, { name: 'A', email: 'a@b.co', file: { name: 'x', type: 'image/png', data: '!!' } }).error, 'The file did not decode');
  assert.equal(validateAnswers(FIXED_FORM_V1, { name: 'A', email: 'a@b.co', file: { name: 'cv', type: 'application/pdf', data: Buffer.from('pdf').toString('base64') } }).files[0].size, 3);
  const custom = { sections: [{ key: 'main', title: '', subteam: null }, { key: 'sw', title: 'Software', subteam: 'software' }], questions: [...FIXED_FORM_V1.questions, { key: 'github', type: 'link', label: 'GitHub', required: true, section: 'sw' }, { key: 'langs', type: 'multi', label: 'Languages', options: ['C', 'Rust'], section: 'main' }] };
  assert.equal(validateAnswers(custom, { name: 'A', email: 'a@b.co', subteam: 'Electrical', answers: { langs: ['C'] } }).answers.github, undefined, 'a required question in a hidden section is not required');
  assert.equal(validateAnswers(custom, { name: 'A', email: 'a@b.co', subteam: 'Software' }).error, 'GitHub is required');
  assert.equal(validateAnswers(custom, { name: 'A', email: 'a@b.co', subteam: 'Software', answers: { github: 'ftp://x' } }).error, 'GitHub must start with http:// or https://');
  assert.equal(validateAnswers(custom, { name: 'A', email: 'a@b.co', answers: { langs: ['Go'] } }).error, 'Choose from the options for Languages');
  assert.deepEqual(fixedFormFor({ doc: { subteams: [{ key: 'a', name: 'Alpha' }] } }).questions.find((q) => q.key === 'subteam').options, ['Alpha']);
  console.log('PASS: fixed form vocabulary matches interest.js; validateAnswers coerces, clips, gates sections and files');

  /* ---- permissions ---- */
  assert.equal(roleOf({ role: 'admin' }, null), 'admin');
  assert.equal(roleOf({ role: 'member' }, { roles: ['reviewer', 'interviewer'] }), 'reviewer');
  assert.equal(roleOf({ role: 'member' }, null), null);
  assert.equal(allowed('member', null), true);
  assert.equal(allowed('role', null), false);
  assert.equal(allowed('lead', 'reviewer'), false);
  assert.equal(allowed('reviewer', 'lead'), true);
  assert.equal(allowed('interviewer', 'reviewer', { roles: ['reviewer', 'interviewer'] }), true, 'a reviewer who is also an interviewer passes interviewer routes');
  assert.equal(allowed('interviewer', 'reviewer', { roles: ['reviewer'] }), false);
  assert.equal(allowed('admin', 'lead'), false);
  assert.throws(() => compileRoute({ path: '/cycles/:nope' }, { name: 'x' }), /unknown route param :nope/);
  console.log('PASS: role ladder and access matrix');

  /* ---- a probe module exercises the registry ---- */
  const events = [];
  const probe = {
    name: 'probe', kernel: false, order: 50, schema: [], memory: { probes: [] }, defaults: () => ({ on: true }), validateSettings: (next) => { if (next?.bad) throw Object.assign(new Error('Bad probe settings'), { status: 400, error: 'Bad probe settings' }); return { on: next?.on !== false }; },
    routes: [
      { method: 'GET', path: '/cycles/:cycle/probe', access: 'reviewer', scoped: true, async handler(rq) { return { status: 200, body: { role: rq.role, scope: rq.scope ? [...rq.scope].sort() : null } }; } },
      { method: 'POST', path: '/cycles/:cycle/probe', access: 'lead', mutates: true, async handler(rq, kit) { const b = await rq.body(); return { status: 200, body: { ok: true, n: b.n }, audit: { kind: 'probe.poke', detail: { n: b.n } } }; } },
      { method: 'POST', path: '/cycles/:cycle/probe/once', access: 'lead', mutates: true, async handler(rq, kit) { const b = await rq.body(); const out = await kit.once(b.requestId, rq.me.email, async () => { events.push('ran'); if (b.boom) throw Object.assign(new Error('boom'), { status: 400, error: 'boom' }); return { stamp: kit.now() }; }); return { status: 200, body: out }; } },
      { method: 'GET', path: '/public-probe', access: 'public', async handler() { return { status: 200, body: { open: true }, headers: { 'cache-control': 'public, max-age=60' } }; } },
      { method: 'GET', path: '/cycles/:cycle/probe/:kind/:round', access: 'role', async handler(rq) { return { status: 200, body: rq.params }; } },
      { method: 'GET', path: '/applicants/:email', access: 'lead', async handler(rq) { return { status: 200, body: { email: rq.params.email } }; } },
    ],
    hooks: { 'cycle.status': async (ev) => { events.push(`status:${ev.from}>${ev.to}`); }, 'cycle.created': async () => { throw new Error('hook exploded'); } },
    collect: { 'scope.applications': async ({ me }) => new Set(me.email === 'rev@example.com' ? ['in-a', 'in-b'] : []) },
    auditKinds: ['probe.poke'],
  };
  // The applicants route above collides with the kernel's; keep the kernel's by dropping the probe's.
  probe.routes = probe.routes.filter((r) => r.path !== '/applicants/:email');
  assert.throws(() => createRecruit([cycles, applications, roles, { ...probe, name: 'Bad' }]), /lowercase name/);
  assert.throws(() => createRecruit([cycles, applications, roles, probe, probe]), /mounted twice/);
  const R = createRecruit([probe, roles, applications, cycles]);
  assert.deepEqual(R.MODULES.map((m) => m.name), ['cycles', 'applications', 'roles', 'probe'], 'modules sort by order');
  await assert.rejects(R.kitFor({}).sql(), /memory mode/);

  const members = Object.fromEntries(users.map((u) => [u.email, u]));
  let sessionCalls = 0;
  async function request(method, path, body = {}, me = members['admin@example.com'], extra = {}) {
    const req = { method, url: path, headers: { origin: extra.origin ?? 'https://cornellphysicalintelligence.com', 'content-type': 'application/json', 'x-real-ip': extra.ip || 'kernel-test' } };
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(v) { this.body = v; } };
    await R.handleRecruit(req, res, path.replace(/^\/api/, '').split('?')[0], {
      readJson: async () => body, me: async () => me, host: 'wiki.test',
      session: () => { sessionCalls++; return { 'set-cookie': 'cupi_session=renewed; Path=/' }; },
      emailSettings: async () => { throw new Error('Email disabled in tests'); },
    });
    return { status: res.statusCode, headers: res.headers, data: res.headers['content-type'] === 'application/json' ? JSON.parse(res.body) : res.body };
  }
  const admin = members['admin@example.com'], lead = members['lead@example.com'], rev = members['rev@example.com'], plain = members['plain@example.com'];

  /* ---- dispatch matrix ---- */
  assert.deepEqual(await request('GET', '/api/recruit/nope').then((r) => [r.status, r.data]), [404, { error: 'No such endpoint' }]);
  assert.deepEqual(await request('GET', '/api/recruit/me', {}, null).then((r) => [r.status, r.data]), [401, { error: 'Not signed in' }]);
  assert.equal((await request('GET', '/api/recruit/me', {}, members['gone@example.com'])).status, 401, 'inactive members are not signed in');
  assert.deepEqual(await request('GET', '/api/recruit/cycles', {}, plain).then((r) => [r.status, r.data]), [403, { error: 'Admins only' }]);
  assert.deepEqual((await request('GET', '/api/recruit/me', {}, plain)).data, { admin: false, cycles: [] }, 'any active member may ask /me');
  assert.deepEqual(await request('GET', '/api/recruit/cycles/not-a-cycle').then((r) => [r.status, r.data]), [404, { error: 'No such endpoint' }], 'params are pinned by prefix');
  assert.deepEqual(await request('GET', '/api/recruit/cycles/cy-missing').then((r) => [r.status, r.data]), [404, { error: 'No such cycle' }]);
  assert.equal((await request('GET', '/api/recruit/applicants/not-an-email')).status, 404, 'email params are regex-checked after decoding');
  const me = await request('GET', '/api/recruit/me');
  assert.equal(me.headers['cache-control'], 'private, no-store');
  assert.equal(me.headers['set-cookie'], 'cupi_session=renewed; Path=/', 'member responses carry the renewed cookie from ctx.session()');
  assert.ok(sessionCalls >= 1);

  /* ---- public routes: cors, preflight, pre-gate, no ctx.me() ---- */
  const preflight = await request('OPTIONS', '/api/recruit/public-probe', {}, () => { throw new Error('ctx.me must not run on public routes'); });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'https://cornellphysicalintelligence.com');
  assert.equal((await request('OPTIONS', '/api/recruit/public-probe', {}, null, { origin: 'https://evil.example' })).status, 403);
  assert.deepEqual(await request('GET', '/api/recruit/public-probe', {}, null, { origin: 'https://evil.example' }).then((r) => [r.status, r.data]), [403, { error: 'Origin not allowed' }]);
  const pub = await request('GET', '/api/recruit/public-probe', {}, null);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers['cache-control'], 'public, max-age=60');
  assert.equal(pub.headers['set-cookie'], undefined, 'public responses carry no session cookie');
  let gated;
  for (let i = 0; i < 32; i++) gated = await request('GET', '/api/recruit/public-probe', {}, null, { ip: 'hot-loop' });
  assert.equal(gated.status, 429, 'instance pre-gate after 30 hits per minute');
  console.log('PASS: 404/401/403 matrix with exact texts, param pinning, public cors and pre-gate, session cookie and cache headers');

  /* ---- cycles and the archived / disabled guards ---- */
  assert.equal((await request('POST', '/api/recruit/cycles', { name: 'Fall 2026' })).status, 400, 'bulk POSTs need a request id');
  const created = await request('POST', '/api/recruit/cycles', { requestId: 'rq-create-0001', name: 'Fall 2026', term: 'Fall 2026' });
  assert.equal(created.status, 201);
  const cycle = created.data.cycle;
  assert.match(cycle.id, /^cy-[a-z0-9]+$/);
  assert.equal(cycle.status, 'draft');
  assert.deepEqual(cycle.doc.modules, { probe: true });
  assert.deepEqual(cycle.doc.probe, { on: true }, 'each module seeds its namespace');
  assert.equal(cycle.doc.subteams.length, 5);
  const replayCreate = await request('POST', '/api/recruit/cycles', { requestId: 'rq-create-0001', name: 'Fall 2026', term: 'Fall 2026' });
  assert.equal(replayCreate.data.cycle.id, cycle.id, 'the same request id returns the stored result');
  assert.equal(replayCreate.data.replayed, true);
  assert.equal((await request('GET', '/api/recruit/cycles')).data.cycles.length, 1, 'no second cycle was created');
  assert.equal((await request('POST', '/api/recruit/cycles', { requestId: 'rq-create-0001', name: 'X' }, lead)).status, 403);
  assert.ok(events.length === 0 || !events.includes('hook.failed'));
  const audit0 = (await request('GET', `/api/recruit/cycles/${cycle.id}/audit`)).data.rows;
  assert.ok(audit0.some((a) => a.kind === 'hook.failed' && a.detail.module === 'probe' && a.detail.event === 'cycle.created'), 'a throwing hook is recorded, not fatal');
  assert.ok(audit0.some((a) => a.kind === 'cycle.create' && a.actor === 'admin@example.com'));

  const poke = await request('POST', `/api/recruit/cycles/${cycle.id}/probe`, { n: 7 });
  assert.deepEqual([poke.status, poke.data], [200, { ok: true, n: 7 }]);
  const auditPoke = (await request('GET', `/api/recruit/cycles/${cycle.id}/audit?kind=probe.poke`)).data.rows;
  assert.equal(auditPoke.length, 1, 'audit rows are written after a 2xx handler result');
  assert.deepEqual(auditPoke[0].detail, { n: 7 });
  assert.equal(auditPoke[0].cycleId, cycle.id);

  // Disable the probe module for this cycle → 409 with the label.
  const off = await request('PUT', `/api/recruit/cycles/${cycle.id}/settings/modules`, { version: cycle.version, settings: { probe: false } });
  assert.equal(off.status, 200);
  assert.deepEqual(await request('GET', `/api/recruit/cycles/${cycle.id}/probe`).then((r) => [r.status, r.data]), [409, { error: 'Probe is off for this cycle' }]);
  const stale = await request('PUT', `/api/recruit/cycles/${cycle.id}/settings/modules`, { version: cycle.version, settings: { probe: true } });
  assert.deepEqual([stale.status, stale.data.error, stale.data.version], [409, 'This cycle changed. Reload.', off.data.cycle.version], 'version-matched settings write');
  const on = await request('PUT', `/api/recruit/cycles/${cycle.id}/settings/modules`, { version: off.data.cycle.version, settings: { probe: true } });
  assert.equal(on.status, 200);
  assert.deepEqual(await request('PUT', `/api/recruit/cycles/${cycle.id}/settings/probe`, { version: on.data.cycle.version, settings: { bad: true } }).then((r) => [r.status, r.data]), [400, { error: 'Bad probe settings' }]);
  assert.equal((await request('PUT', `/api/recruit/cycles/${cycle.id}/settings/modules`, { version: on.data.cycle.version, settings: {} }, lead)).status, 403, 'module switches are admin-only');
  assert.equal((await request('PUT', `/api/recruit/cycles/${cycle.id}/settings/nothing`, { version: on.data.cycle.version, settings: {} })).status, 404);

  // Lifecycle: draft → open → closed → archived, then mutations are refused.
  let cur = on.data.cycle;
  assert.equal((await request('POST', `/api/recruit/cycles/${cycle.id}/status`, { version: cur.version, status: 'archived' })).status, 409, 'draft cannot jump to archived');
  cur = (await request('POST', `/api/recruit/cycles/${cycle.id}/status`, { version: cur.version, status: 'open' })).data.cycle;
  assert.equal(cur.status, 'open');
  cur = (await request('POST', `/api/recruit/cycles/${cycle.id}/status`, { version: cur.version, status: 'closed' })).data.cycle;
  assert.equal(cur.status, 'closed');
  assert.ok(cur.closedAt > 0);
  assert.deepEqual(events.filter((e) => e.startsWith('status')), ['status:draft>open', 'status:open>closed'], 'cycle.status hooks fan out');
  const archived = await request('POST', `/api/recruit/cycles/${cycle.id}/status`, { version: cur.version, status: 'archived' });
  assert.equal(archived.status, 200);
  assert.deepEqual(await request('POST', `/api/recruit/cycles/${cycle.id}/probe`, { n: 1 }).then((r) => [r.status, r.data]), [409, { error: 'This cycle is archived' }]);
  assert.equal((await request('GET', `/api/recruit/cycles/${cycle.id}/probe`)).status, 200, 'reads still work on an archived cycle');
  assert.equal((await request('GET', '/api/recruit/cycles')).data.cycles.length, 0, 'archived cycles hide unless ?all=1');
  assert.equal((await request('GET', '/api/recruit/cycles?all=1')).data.cycles.length, 1);
  cur = (await request('POST', `/api/recruit/cycles/${cycle.id}/status`, { version: archived.data.cycle.version, status: 'closed' })).data.cycle;
  cur = (await request('POST', `/api/recruit/cycles/${cycle.id}/status`, { version: cur.version, status: 'open' })).data.cycle;
  assert.equal(cur.status, 'open');
  console.log('PASS: cycle lifecycle, disabled-module 409, archived mutates 409, version-matched settings, hook failure audit');

  /* ---- roles CRUD, roster projection, scoping ---- */
  const roster = await request('GET', `/api/recruit/cycles/${cycle.id}/roles`);
  assert.deepEqual(roster.data.roles, []);
  assert.deepEqual(roster.data.members.map((u) => u.email), ['admin@example.com', 'lead@example.com', 'rev@example.com', 'plain@example.com'], 'roster projection lists active members only');
  assert.deepEqual(roster.data.members[1], { email: 'lead@example.com', name: 'Lee Lead', subteam: 'Software' });
  assert.equal((await request('GET', `/api/recruit/cycles/${cycle.id}/roles`, {}, lead)).status, 403, 'no grant yet');
  assert.equal((await request('PUT', `/api/recruit/cycles/${cycle.id}/roles/nobody%40example.com`, { requestId: 'rq-role-0001', roles: ['lead'] })).status, 400, 'grants go to roster members');
  assert.equal((await request('PUT', `/api/recruit/cycles/${cycle.id}/roles/lead%40example.com`, { requestId: 'rq-role-0002', roles: ['boss'] })).status, 400);
  const grantLead = await request('PUT', `/api/recruit/cycles/${cycle.id}/roles/Lead%40Example.com`, { requestId: 'rq-role-0003', roles: ['lead'], subteams: [] });
  assert.equal(grantLead.status, 200);
  assert.deepEqual(grantLead.data.role.member, 'lead@example.com', 'member params are lowercased');
  assert.equal((await request('GET', `/api/recruit/cycles/${cycle.id}/roles`, {}, lead)).status, 200, 'the lead now reads roles');
  assert.equal((await request('GET', `/api/recruit/cycles/${cycle.id}/audit`, {}, lead)).status, 200);
  assert.deepEqual(await request('PUT', `/api/recruit/cycles/${cycle.id}/roles/rev%40example.com`, { requestId: 'rq-role-0004', roles: ['lead'] }, lead).then((r) => [r.status, r.data.error]), [403, 'Only admins grant the lead role']);
  const grantRev = await request('PUT', `/api/recruit/cycles/${cycle.id}/roles/rev%40example.com`, { requestId: 'rq-role-0005', roles: ['reviewer'], subteams: ['electrical'] }, lead);
  assert.equal(grantRev.status, 200, 'leads may grant reviewer');
  assert.deepEqual(grantRev.data.role.subteams, ['electrical']);
  assert.equal((await request('PUT', `/api/recruit/cycles/${cycle.id}/roles/rev%40example.com`, { requestId: 'rq-role-0006', roles: ['reviewer'], subteams: ['robots'] }, lead)).status, 400, 'unknown subteam');
  const revMe = await request('GET', '/api/recruit/me', {}, rev);
  assert.deepEqual(revMe.data, { admin: false, cycles: [{ id: cycle.id, name: 'Fall 2026', term: 'Fall 2026', status: 'open', roles: ['reviewer'] }] });
  assert.deepEqual(await request('GET', `/api/recruit/cycles/${cycle.id}/roles`, {}, rev).then((r) => [r.status, r.data]), [403, { error: 'Not allowed in this cycle' }]);
  assert.equal((await request('GET', `/api/recruit/cycles/${cycle.id}`, {}, rev)).status, 200);
  assert.equal((await request('GET', `/api/recruit/cycles/${cycle.id}`, {}, rev)).data.cycle.doc.intake, undefined, 'non-leads do not see intake limits');
  assert.equal((await request('GET', `/api/recruit/cycles/${cycle.id}`, {}, lead)).data.cycle.doc.intake.perIpHour, 5);
  const probeAdmin = await request('GET', `/api/recruit/cycles/${cycle.id}/probe`);
  assert.deepEqual(probeAdmin.data, { role: 'admin', scope: null });
  const probeRev = await request('GET', `/api/recruit/cycles/${cycle.id}/probe`, {}, rev);
  assert.deepEqual(probeRev.data, { role: 'reviewer', scope: [] }, 'grant subteams narrow the collected scope (no Electrical applications yet)');
  // Add two applications so the subteam narrowing has something to keep.
  const addA = await request('POST', `/api/recruit/cycles/${cycle.id}/applications`, { requestId: 'rq-app-000a', name: 'Amy', email: 'amy@example.com', subteam: 'Electrical' }, lead);
  assert.equal(addA.status, 201);
  const addB = await request('POST', `/api/recruit/cycles/${cycle.id}/applications`, { requestId: 'rq-app-000b', name: 'Bo', email: 'bo@example.com', subteam: 'Software' }, lead);
  assert.equal(addB.status, 201);
  probe.collect['scope.applications'] = async ({ me }) => new Set(me.email === 'rev@example.com' ? [addA.data.application.id, addB.data.application.id] : []);
  assert.deepEqual((await request('GET', `/api/recruit/cycles/${cycle.id}/probe`, {}, rev)).data.scope, [addA.data.application.id], 'scope = collector ids ∩ grant subteams');
  const revList = await request('GET', `/api/recruit/cycles/${cycle.id}/applications`, {}, rev);
  assert.deepEqual(revList.data.rows.map((r) => r.email), ['amy@example.com'], 'the list is scoped in storage');
  assert.equal((await request('GET', `/api/recruit/cycles/${cycle.id}/applications/${addB.data.application.id}`, {}, rev)).status, 404, 'outside scope is 404');
  assert.equal((await request('GET', `/api/recruit/cycles/${cycle.id}/applications/${addA.data.application.id}`, {}, rev)).status, 200);
  const dropRole = await request('DELETE', `/api/recruit/cycles/${cycle.id}/roles/rev%40example.com`);
  assert.deepEqual([dropRole.status, dropRole.data.ok], [200, true]);
  assert.equal((await request('GET', `/api/recruit/cycles/${cycle.id}`, {}, rev)).status, 403);
  const auditRoles = (await request('GET', `/api/recruit/cycles/${cycle.id}/audit?kind=role`)).data.rows;
  assert.equal(auditRoles.length, 3);
  assert.ok(auditRoles.every((a) => !JSON.stringify(a.detail).includes('@')), 'audit detail never holds an email');
  console.log('PASS: roles CRUD with lead limits, roster projection, /me for members, reviewer scoping by id intersection and subteam');

  /* ---- kit.once ---- */
  const onceA = await request('POST', `/api/recruit/cycles/${cycle.id}/probe/once`, { requestId: 'rq-once-0001' });
  assert.equal(onceA.status, 200);
  assert.ok(onceA.data.stamp > 0);
  const onceB = await request('POST', `/api/recruit/cycles/${cycle.id}/probe/once`, { requestId: 'rq-once-0001' });
  assert.deepEqual(onceB.data, { stamp: onceA.data.stamp, replayed: true }, 'replay returns the stored result');
  assert.equal(events.filter((e) => e === 'ran').length, 1, 'the work ran once');
  assert.equal((await request('POST', `/api/recruit/cycles/${cycle.id}/probe/once`, { requestId: 'rq-once-0001' }, lead)).status, 403, 'another actor cannot replay it');
  assert.equal((await request('POST', `/api/recruit/cycles/${cycle.id}/probe/once`, { requestId: 'bad' })).status, 400);
  const boom = await request('POST', `/api/recruit/cycles/${cycle.id}/probe/once`, { requestId: 'rq-once-0002', boom: true });
  assert.deepEqual([boom.status, boom.data], [400, { error: 'boom' }]);
  const again = await request('POST', `/api/recruit/cycles/${cycle.id}/probe/once`, { requestId: 'rq-once-0002' });
  assert.equal(again.status, 200, 'a failed run releases the request id');
  assert.equal(again.data.replayed, undefined);
  const disk = JSON.parse(await readFile(join(root, '.devrecruit.json'), 'utf8'));
  assert.ok(disk.requests.some((r) => r.id === 'rq-once-0001' && r.result.stamp === onceA.data.stamp), 'requests persist in .devrecruit.json');
  assert.ok(disk.audit.length > 0 && disk.cycles.length === 1 && disk.roles.length === 1 && Array.isArray(disk.probes), 'module memory collections are merged into the dev document');
  console.log('PASS: kit.once replay, actor guard, release on failure, memory document persistence');

  /* ---- params: kind/round, member; a lead reading an applicant ---- */
  assert.deepEqual((await request('GET', `/api/recruit/cycles/${cycle.id}/probe/review/r1`)).data, { cycle: cycle.id, kind: 'review', round: 'r1' });
  assert.equal((await request('GET', `/api/recruit/cycles/${cycle.id}/probe/other/r1`)).status, 404, 'kind is pinned to review|interview');
  const applicant = await request('GET', '/api/recruit/applicants/amy%40example.com', {}, lead);
  assert.equal(applicant.status, 200);
  assert.equal(applicant.data.applicant.applications, 1);
  assert.equal((await request('GET', '/api/recruit/applicants/amy%40example.com', {}, rev)).status, 403);

  /* ---- delete: empty drafts and archived cycles only ---- */
  const draft = (await request('POST', '/api/recruit/cycles', { requestId: 'rq-create-0002', name: 'Scratch', term: '' })).data.cycle;
  assert.equal((await request('DELETE', `/api/recruit/cycles/${draft.id}`)).status, 200);
  assert.equal((await request('GET', `/api/recruit/cycles/${draft.id}`)).status, 404);
  assert.equal((await request('DELETE', `/api/recruit/cycles/${cycle.id}`)).status, 409, 'an open cycle with applications stays');
  console.log('PASS: registry dispatch, actor resolution, role scoping, request idempotency, audit rows, memory mode');
}
