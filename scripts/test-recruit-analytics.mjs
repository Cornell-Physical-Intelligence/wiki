// Synthetic fixtures only: an in-test kit over a temp-dir memory file with a
// fake wiki roster, a fake SQL tag for statement shapes, and a vm DOM stub
// for the client. No network, credentials, browser or production data.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

globalThis.fetch = async () => { throw new Error('Network disabled in recruit tests'); };
process.env.WIKI_URL = 'https://wiki.test';
const analyticsModule = await import('../lib/recruit/modules/analytics.js');
const analytics = analyticsModule.default;
const { computeAnalytics, csvText, csvCell, baseColumns, LEGACY_HEADER } = analyticsModule;
const onboarding = (await import('../lib/recruit/modules/onboarding.js')).default;
const comms = (await import('../lib/recruit/modules/comms.js')).default;
const interviews = (await import('../lib/recruit/modules/interviews.js')).default;

/* ------------------------------- in-test kit ------------------------------ */

const PARAMS = { cycle: 'cy-[a-z0-9-]+', app: 'in-[a-z0-9]+', email: '[^/]{3,200}', mail: 'ml-[a-z0-9]+', key: '[a-z][a-z0-9_-]{0,59}', slot: 'sl-[a-z0-9]+', booking: 'bk-[a-z0-9]+', token: '[a-f0-9]{32}' };
const compile = (path) => {
  const names = [];
  const re = path.split('/').map((seg) => { const p = /^:([a-z]+)$/i.exec(seg); if (!p) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); assert.ok(PARAMS[p[1]], `known param ${p[1]}`); names.push(p[1]); return `(${PARAMS[p[1]]})`; }).join('/');
  return { regex: new RegExp('^' + re + '$'), names };
};
const ADMIN = { email: 'admin@cornell.edu', name: 'Admin Person', role: 'admin', status: 'active' };
const LEAD = { email: 'lead@cornell.edu', name: 'Lead', role: 'member', status: 'active' };
const NOBODY = { email: 'plain@cornell.edu', name: 'Plain', role: 'member', status: 'active' };
const NOW = 1789500000000;
const H = 3600000, D = 86400000;
const STAGES = [{ key: 'applied', name: 'Applied', kind: 'open' }, { key: 'screening', name: 'Screening', kind: 'open' }, { key: 'interview', name: 'Interview', kind: 'open' }, { key: 'accepted', name: 'Accepted', kind: 'closed', outcome: 'accepted' }, { key: 'rejected', name: 'Rejected', kind: 'closed', outcome: 'rejected' }];

function app(id, over = {}) {
  return { id, cycleId: 'cy-fall', email: `${id.slice(3)}@cornell.edu`, ts: NOW - 10 * D, updated: NOW - 9 * D, name: `Person ${id.slice(3).toUpperCase()}`, cornell: true, subteam: 'software', year: 'Junior', source: 'form', formVersion: 0,
    answers: { project: 'A robot' }, files: [], stage: 'applied', stageAt: NOW - 10 * D, stageHistory: [{ stage: 'applied', at: NOW - 10 * D, by: 'applicant' }], outcome: null, decision: {}, tags: [], review: {}, reviewVersion: 0, editVersion: 0, onboardedAt: null, erasedAt: null, receiptId: `jr-${id}`, ...over };
}

function seedMem() {
  return {
    settings: { version: 1, doc: { retention: { months: 24 }, defaults: {} } },
    receipts: { 'jr-in-a': 'saved' },
    cycles: [
      { id: 'cy-fall', version: 1, status: 'open', name: 'Fall 2026', term: 'Fall 2026', closedAt: null, doc: { modules: {}, subteams: [{ key: 'software', name: 'Software' }, { key: 'electrical', name: 'Electrical' }], pipeline: { stages: STAGES }, comms: {}, interviews: { rounds: [{ key: 'r1', name: 'Interview', minutes: 20 }] } } },
      { id: 'cy-old', version: 1, status: 'archived', name: 'Spring 2024', term: 'Spring 2024', closedAt: NOW - 800 * D, doc: { modules: {}, pipeline: { stages: STAGES } } },
    ],
    applicants: [{ email: 'a@cornell.edu', name: 'Person A', applications: 1, doc: {} }, { email: 'b@cornell.edu', name: 'Person B', applications: 1, doc: {} }, { email: 'x@cornell.edu', name: 'Person X', applications: 1, doc: {} }],
    requests: [], audit: [], roles: [{ cycleId: 'cy-fall', member: 'lead@cornell.edu', roles: ['lead'], subteams: [] }],
    applications: [
      app('in-a', { name: '=SUM(A1:A9) Person A', answers: { project: '+cmd|"/c calc"' }, files: [{ id: 'int-a1', question: 'file', name: 'resume.pdf', type: 'application/pdf', size: 10 }], stage: 'accepted', stageAt: NOW - 2 * D, outcome: 'accepted', decision: { outcome: 'accepted', reason: '-nice', at: NOW - 2 * D, by: 'lead@cornell.edu' }, tags: ['top', 'ee'], review: { flagged: true, comments: [{ id: 'ic-1', text: 'hi' }] },
        stageHistory: [{ stage: 'applied', at: NOW - 10 * D }, { stage: 'screening', at: NOW - 8 * D }, { stage: 'interview', at: NOW - 4 * D }, { stage: 'accepted', at: NOW - 2 * D }] }),
      app('in-b', { name: '@Person B', year: 'Senior', stage: 'screening', stageAt: NOW - 6 * D, ts: NOW - 9 * D, subteam: 'electrical', stageHistory: [{ stage: 'applied', at: NOW - 9 * D }, { stage: 'screening', at: NOW - 6 * D }], answers: { project: 'Tabs\there', extra: 'Loves <b>robots</b>' } }),
      app('in-c', { name: 'Person C', year: null, stage: 'rejected', outcome: 'rejected', ts: NOW - 8 * D, source: 'migrated', subteam: '', stageHistory: [{ stage: 'applied', at: NOW - 8 * D }, { stage: 'rejected', at: NOW - 7 * D }], decision: { outcome: 'rejected', reason: 'no', at: NOW - 7 * D } }),
      app('in-d', { stage: 'accepted', outcome: 'accepted', ts: NOW - 7 * D, decision: { outcome: 'accepted', at: NOW - 1 * D }, stageHistory: [{ stage: 'applied', at: NOW - 7 * D }, { stage: 'accepted', at: NOW - 1 * D }] }),
      app('in-x', { cycleId: 'cy-old', email: 'x@cornell.edu', name: 'Person X', ts: NOW - 900 * D, receiptId: null }),
      app('in-y', { cycleId: 'cy-old', email: 'y@cornell.edu', name: 'Person Y', ts: NOW - 899 * D, receiptId: null }),
      app('in-z', { cycleId: 'cy-old', email: 'z@cornell.edu', name: 'Person Z', ts: NOW - 898 * D, receiptId: null }),
    ],
    forms: [{ id: 'fm-1', cycleId: 'cy-fall', version: 1, status: 'published', doc: { questions: [{ key: 'name', system: true, label: 'Name' }, { key: 'extra', type: 'short', label: 'Why <us>?' }] } }],
    scores: [
      { applicationId: 'in-a', member: 'lead@cornell.edu', kind: 'review', round: '', created: NOW - 5 * D, submitted: NOW - 5 * D + 2 * H, doc: { total: 4, notes: 'private note' } },
      { applicationId: 'in-b', member: 'lead@cornell.edu', kind: 'review', round: '', created: NOW - 5 * D, submitted: NOW - 5 * D + 4 * H, doc: { total: 2, notes: 'another note' } },
      { applicationId: 'in-b', member: 'rev@cornell.edu', kind: 'review', round: '', created: NOW - 5 * D, submitted: NOW - 4 * D, doc: { conflict: true, notes: 'coi' } },
    ],
    assignments: [{ applicationId: 'in-a', member: 'lead@cornell.edu', kind: 'reviewer' }, { applicationId: 'in-b', member: 'lead@cornell.edu', kind: 'reviewer' }, { applicationId: 'in-b', member: 'rev@cornell.edu', kind: 'reviewer' }, { applicationId: 'in-c', member: 'rev@cornell.edu', kind: 'reviewer' }],
    slots: [{ id: 'sl-1', cycleId: 'cy-fall', round: 'r1', starts: NOW, ends: NOW + H, capacity: 2, booked: 1, interviewers: [], version: 1 }],
    bookings: [{ id: 'bk-1', cycleId: 'cy-fall', round: 'r1', applicationId: 'in-a', slotId: 'sl-1', status: 'confirmed', tokenHash: 'abc', version: 1, updated: NOW, doc: {} }, { id: 'bk-2', cycleId: 'cy-fall', round: 'r1', applicationId: 'in-b', slotId: null, status: 'no_show', tokenHash: 'def', version: 1, updated: NOW, doc: {} }],
    mail: [{ id: 'ml-1', cycleId: 'cy-fall', applicationId: 'in-a', templateKey: 'received', purposeKey: 'received', toEmail: 'a@cornell.edu', status: 'sent', doc: { merge: {} } }, { id: 'ml-2', cycleId: 'cy-fall', applicationId: 'in-b', templateKey: 'received', purposeKey: 'received', toEmail: 'b@cornell.edu', status: 'failed', doc: {} }],
    onboarding: [],
  };
}

function makeKit({ mode = 'memory', mem = seedMem(), sql = null, modules = [analytics, onboarding, comms, interviews], roster = [] } = {}) {
  modules = [...modules].sort((a, b) => a.order - b.order); // the registry runs collectors in module order
  const dir = mkdtempSync(join(tmpdir(), 'cupi-recruit-an-'));
  const file = join(dir, '.devrecruit.json');
  let clock = NOW, seq = 0;
  const requests = new Map();
  const kit = {
    mode, dir, file, events: [], audits: [], removed: [], forgotten: [], invites: [], welcomes: [],
    get mem() { return mem; },
    memSave() { writeFileSync(file + '.tmp', JSON.stringify(mem)); renameSync(file + '.tmp', file); },
    now: () => clock, tick: (ms) => { clock += ms; },
    id: (p) => `${p}-${(++seq).toString(36).padStart(4, '0')}${clock.toString(36)}`,
    sql: async () => { if (!sql) throw new Error('SQL is not available in memory mode'); return sql; },
    async once(requestId, actor, run) {
      assert.match(requestId, /^rq-[a-z0-9-]{8,80}$/);
      if (requests.has(requestId)) return { ...requests.get(requestId), replayed: true };
      const out = await run();
      requests.set(requestId, out);
      return out;
    },
    requests,
    async audit(row) { kit.audits.push(row); },
    async emit(event, payload) { kit.events.push({ event, payload }); for (const m of modules) if (m.hooks?.[event]) await m.hooks[event](payload, kit); },
    async collect(event, payload) { const out = []; for (const m of modules) if (m.collect?.[event] && payload?.cycle?.doc?.modules?.[m.name] !== false) { const r = await m.collect[event](payload, kit); if (r !== undefined) out.push(r); } return out; },
    cycles: { get: async (id) => mem.cycles.find((c) => c.id === id) || null },
    roles: {
      grantFor: async (cycleId, email) => mem.roles.find((g) => g.member === email && (!cycleId || g.cycleId === cycleId)) || null,
      roleOf: (me, grant) => (me.role === 'admin' ? 'admin' : grant ? ['lead', 'reviewer', 'interviewer'].find((r) => grant.roles.includes(r)) || null : null),
      roster: async () => roster.filter((u) => u.status === 'active'), // active members only, as kit.roles.roster() projects
    },
    files: { removeUnreferenced: async (id) => { kit.removed.push(id); } },
    journal: { forget: async (id) => { kit.forgotten.push(id); } },
    email: { send: async () => ({ sent: false, reason: 'disabled' }), settings: async () => { throw new Error('Email disabled in tests'); }, clientId: null, saveOauth: null, host: 'wiki.test' },
    wiki: {
      // Mirrors api/index.js: the actor must be an active admin, addMembers
      // rejects roster duplicates and bad addresses, one result per email.
      async addMembers(emails, actorEmail) {
        kit.invites.push({ emails, actorEmail });
        if (actorEmail !== ADMIN.email) return { results: false };
        const results = emails.map((email) => (roster.some((u) => u.email === email) ? { email, ok: false, reason: 'Already on the roster' } : !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) ? { email, ok: false, reason: 'Not a valid email address' } : (roster.push({ email, name: email.split('@')[0], status: 'invited' }), { email, ok: true })));
        return { results, settings: { key: 're_test', from: 'wiki@example.com' } };
      },
      async sendWelcome(args) { kit.welcomes.push(args); return args.to.startsWith('d@') ? { sent: false, reason: 'Resend 500' } : { sent: true }; },
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  const routes = modules.flatMap((m) => m.routes.map((r) => ({ ...r, module: m, ...compile(r.path) })));
  kit.call = async (method, path, { body = {}, me = ADMIN, query = {} } = {}) => {
    const [p, qs] = path.split('?');
    if (qs) for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
    const route = routes.find((r) => r.method === method && r.regex.test(p));
    if (!route) return { status: 404, body: { error: 'No such endpoint' } };
    const params = Object.fromEntries(route.names.map((n, i) => [n, route.regex.exec(p)[i + 1]]));
    if (params.email) params.email = decodeURIComponent(params.email).toLowerCase();
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(v) { this.text = v; } };
    const rq = { method, path: p, params, query, req: {}, res, me, role: null, grant: null, cycle: null, scope: null, body: async () => body };
    try {
      if (params.cycle) {
        rq.cycle = await kit.cycles.get(params.cycle);
        if (!rq.cycle) return { status: 404, body: { error: 'No such cycle' } };
        if (route.mutates && rq.cycle.status === 'archived') return { status: 409, body: { error: 'This cycle is archived' } };
      }
      rq.grant = me.role === 'admin' ? null : await kit.roles.grantFor(rq.cycle?.id || null, me.email);
      rq.role = kit.roles.roleOf(me, rq.grant);
      const ok = { member: true, role: !!rq.role, interviewer: ['admin', 'lead', 'interviewer'].includes(rq.role), lead: ['admin', 'lead'].includes(rq.role), admin: rq.role === 'admin' }[route.access];
      if (!ok) return { status: 403, body: { error: rq.role ? 'Not allowed in this cycle' : 'Admins only' } };
      const out = await route.handler(rq, kit);
      if (out === undefined) return { status: res.statusCode, headers: res.headers, text: res.text };
      if (out.audit && out.status < 300) kit.audits.push({ kind: out.audit.kind, cycleId: out.audit.cycleId ?? rq.cycle?.id ?? '', applicationId: typeof out.audit.target === 'string' ? out.audit.target : null, detail: out.audit.detail || {} });
      return { status: out.status, body: out.body, headers: out.headers || {} };
    } catch (e) {
      if (e && e.status && e.error !== undefined) { const { status, error, ...extra } = e; return { status, body: { error, ...extra } }; }
      throw e;
    }
  };
  return kit;
}

const rq = () => 'rq-' + randomUUID();
const parseCsvLine = (line) => {
  const cells = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
};
const parseCsv = (text) => text.replace(/^\uFEFF/, '').split('\r\n').map(parseCsvLine);

/* ------------------------------- pure math -------------------------------- */
{
  const mem = seedMem();
  const cycle = mem.cycles[0];
  const rows = mem.applications.filter((a) => a.cycleId === 'cy-fall');
  const d = computeAnalytics({ cycle, apps: rows, scores: mem.scores, assignments: mem.assignments, slots: mem.slots, bookings: mem.bookings, mail: mem.mail, now: NOW });
  assert.equal(d.total, 4);
  assert.deepEqual(d.funnel, [{ stage: 'applied', n: 0 }, { stage: 'screening', n: 1 }, { stage: 'interview', n: 0 }, { stage: 'accepted', n: 2 }, { stage: 'rejected', n: 1 }], 'funnel follows the configured stage order');
  assert.deepEqual(d.bySubteam, [{ subteam: '', stage: 'rejected', n: 1 }, { subteam: 'electrical', stage: 'screening', n: 1 }, { subteam: 'software', stage: 'accepted', n: 2 }]);
  assert.deepEqual(d.byYear, [{ year: '', stage: 'rejected', n: 1 }, { year: 'Junior', stage: 'accepted', n: 2 }, { year: 'Senior', stage: 'screening', n: 1 }]);
  assert.deepEqual(d.bySource, [{ source: 'form', n: 3 }, { source: 'migrated', n: 1 }]);
  assert.deepEqual(d.outcomes, [{ outcome: 'accepted', n: 2 }, { outcome: 'open', n: 1 }, { outcome: 'rejected', n: 1 }]);
  assert.equal(d.daily.reduce((n, x) => n + x.n, 0), 4); assert.equal(d.daily[0].day, new Date(NOW - 10 * D).toISOString().slice(0, 10));
  const tis = Object.fromEntries(d.timeInStage.map((t) => [t.stage, t]));
  assert.equal(tis.applied.n, 4); assert.equal(tis.applied.medianHours, (2 * 24 + 3 * 24) / 2, 'applied spans 2d, 3d, 1d, 6d → median 60 h');
  assert.equal(tis.screening.n, 2); assert.equal(tis.screening.medianHours, (4 * 24 + 6 * 24) / 2, 'screening: 4d (moved on) and 6d (still there)');
  assert.equal(tis.accepted.p90Hours, 48);
  assert.deepEqual(d.reviewers, [{ member: 'lead@cornell.edu', assigned: 2, done: 2, mean: 3, medianHours: 3 }, { member: 'rev@cornell.edu', assigned: 2, done: 1, mean: null, medianHours: 24 }], 'conflicts count as done but never in the mean');
  assert.deepEqual(d.interviews, { slots: 1, booked: 1, invited: 0, confirmed: 1, noShow: 1, done: 0 });
  assert.deepEqual(d.mail, { sent: 1, failed: 1, queued: 0, skipped: 0 });
  assert.equal(d.generatedAt, NOW);
  console.log('PASS: analytics math — funnel in stage order, subteam/year/source/outcome breakdowns, time in stage from history, reviewer throughput without conflicts, interview and mail tallies');
}

/* ------------------------------- csv cells -------------------------------- */
{
  assert.equal(csvCell('=SUM(A1)'), '"\'=SUM(A1)"'); assert.equal(csvCell('+1'), '"\'+1"'); assert.equal(csvCell('-x'), '"\'-x"'); assert.equal(csvCell('@cmd'), '"\'@cmd"');
  assert.equal(csvCell('\tx'), '"\'\tx"'); assert.equal(csvCell('say "hi"'), '"say ""hi"""'); assert.equal(csvCell(12), '"12"'); assert.equal(csvCell(null), '""'); assert.equal(csvCell('2026-01-01'), '"2026-01-01"');
  assert.equal(baseColumns().slice(0, 9).map((c) => c.header).join(','), LEGACY_HEADER, 'the legacy nine columns come first');
  const text = csvText([{ id: 'x', name: '=evil', email: 'e', ts: 1, subteam: '', answers: {}, files: [], tags: [], review: {} }], baseColumns().slice(0, 4).concat([{ header: 'Extra', cell: (r, extras) => extras.note }]), { x: { note: 'from extras' } });
  assert.equal(text.split('\r\n')[0], '"Submitted","Updated","Name","Email","Extra"');
  assert.match(text.split('\r\n')[1], /^"1970-01-01T00:00:00\.001Z","1970-01-01T00:00:00\.001Z","'=evil","e","from extras"$/);
  console.log('PASS: analytics csv — leading = + - @ and tab are neutralised, quotes doubled, legacy nine columns lead');
}

/* ------------------------------ memory routes ----------------------------- */
{
  const kit = makeKit({ roster: [{ email: 'lead@cornell.edu', name: 'Lead', status: 'active' }, { email: 'b@cornell.edu', name: 'Person B', status: 'active' }] });
  const mem = kit.mem;
  let r = await kit.call('GET', '/cycles/cy-fall/analytics', { me: LEAD });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total, 4); assert.equal(r.body.funnel[3].n, 2); assert.equal(r.body.retention.months, 24); assert.deepEqual(r.body.retention.cycles, [], 'leads do not see the purge list');
  assert.equal((await kit.call('GET', '/cycles/cy-fall/analytics', { me: NOBODY })).status, 403);
  r = await kit.call('GET', '/cycles/cy-fall/analytics');
  assert.equal(r.body.retention.cycles.length, 1); assert.equal(r.body.retention.cycles[0].id, 'cy-old'); assert.equal(r.body.retention.cycles[0].remaining, 3);
  mem.settings.doc.retention.months = 36;
  r = await kit.call('GET', '/cycles/cy-fall/analytics');
  assert.equal(r.body.retention.cycles.length, 0, 'retention.months from settings decides what is due');
  mem.settings.doc.retention.months = 24;
  // The 60 s cache: a change is invisible until the TTL passes, a hook, or ?fresh=1.
  mem.applications.push(app('in-e', { stage: 'interview', ts: NOW - 1 * D }));
  assert.equal((await kit.call('GET', '/cycles/cy-fall/analytics')).body.total, 4, 'cached');
  assert.equal((await kit.call('GET', '/cycles/cy-fall/analytics?fresh=1')).body.total, 5);
  mem.applications.push(app('in-f', { stage: 'interview', ts: NOW - 1 * D }));
  assert.equal((await kit.call('GET', '/cycles/cy-fall/analytics')).body.total, 5);
  await kit.emit('stage.moved', { cycle: mem.cycles[0], application: 'in-f', from: 'applied', to: 'interview' });
  assert.equal((await kit.call('GET', '/cycles/cy-fall/analytics')).body.total, 6, 'a move clears the cache');
  mem.applications.push(app('in-g', { stage: 'interview', ts: NOW - 1 * D }));
  kit.tick(61000);
  assert.equal((await kit.call('GET', '/cycles/cy-fall/analytics')).body.total, 7, 'the cache expires');
  mem.applications.splice(mem.applications.findIndex((a) => a.id === 'in-e'), 3);

  // Export: legacy nine columns first, formula-safe cells, question and module columns, filters, pages.
  r = await kit.call('GET', '/cycles/cy-fall/export.csv', { me: LEAD });
  assert.equal(r.status, 200); assert.equal(r.headers['content-type'], 'text/csv; charset=utf-8');
  assert.equal(r.headers['content-disposition'], 'attachment; filename="cupi-fall-2026-2026-09-15.csv"'); assert.equal(r.headers.link, undefined);
  assert.ok(r.text.startsWith('\uFEFF')); assert.ok(r.text.includes('\r\n'));
  const csv = parseCsv(r.text);
  assert.equal(csv[0].slice(0, 9).join(','), LEGACY_HEADER);
  assert.deepEqual(csv[0].slice(9, 17), ['Stage', 'Stage since', 'Outcome', 'Reason', 'Tags', 'Source', 'Flagged', 'Comments']);
  assert.deepEqual(csv[0].slice(17), ['Why <us>?', 'Interview', 'Emails sent', 'Onboarded'], 'question labels, then module columns in module order');
  assert.equal(csv.length, 5);
  const byName = Object.fromEntries(csv.slice(1).map((row) => [row[3], row]));
  const a = byName['a@cornell.edu'], b = byName['b@cornell.edu'], c = byName['c@cornell.edu'];
  assert.equal(csv[1][3], 'd@cornell.edu', 'newest first'); assert.equal(csv[4][3], 'a@cornell.edu');
  assert.equal(a[2], "'=SUM(A1:A9) Person A"); assert.equal(a[5], "'+cmd|\"/c calc\""); assert.equal(a[12], "'-nice"); assert.equal(b[2], "'@Person B"); assert.equal(b[5], 'Tabs\there', 'a tab inside a cell is not a formula');
  assert.equal(a[6], 'yes'); assert.equal(a[7], 'resume.pdf · https://wiki.test/api/recruit/files/int-a1'); assert.equal(a[8], 'Junior');
  assert.equal(a[9], 'accepted'); assert.equal(a[11], 'accepted'); assert.equal(a[13], 'top; ee'); assert.equal(a[14], 'form'); assert.equal(a[15], 'yes'); assert.equal(a[16], '1');
  assert.equal(b[17], 'Loves <b>robots</b>'); assert.match(a[18], /^confirmed · /); assert.equal(b[18], 'no-show'); assert.equal(c[18], ''); assert.equal(a[19], '1'); assert.equal(b[19], '0');
  assert.equal(c[14], 'migrated'); assert.equal(c[8], '');
  r = await kit.call('GET', '/cycles/cy-fall/export.csv?stage=accepted&flagged=1');
  assert.equal(parseCsv(r.text).length, 2); assert.equal(parseCsv(r.text)[1][3], 'a@cornell.edu', 'filters narrow the export');
  r = await kit.call('GET', '/cycles/cy-fall/export.csv?q=person%20b');
  assert.equal(parseCsv(r.text)[1][3], 'b@cornell.edu');
  r = await kit.call('GET', '/cycles/cy-fall/export.csv?tag=ee&subteam=software');
  assert.equal(parseCsv(r.text).length, 2);
  r = await kit.call('GET', '/cycles/cy-fall/export.csv?subteam=__undecided');
  assert.equal(parseCsv(r.text)[1][3], 'c@cornell.edu');
  r = await kit.call('GET', '/cycles/cy-fall/export.csv?year=Senior&outcome=');
  assert.equal(parseCsv(r.text).length, 2);
  const savedPage = analyticsModule.LIMITS.exportPage;
  analyticsModule.LIMITS.exportPage = 2;
  try {
    r = await kit.call('GET', '/cycles/cy-fall/export.csv?dir=asc&stage=');
    let page = parseCsv(r.text);
    assert.equal(page.length, 3); assert.equal(page[1][3], 'a@cornell.edu', 'ascending by received time');
    assert.match(r.headers.link, /^<\/api\/recruit\/cycles\/cy-fall\/export\.csv\?dir=asc&cursor=\d+%7Cin-b>; rel="next"$/);
    const next = decodeURIComponent(/cursor=([^&>]+)/.exec(r.headers.link)[1]);
    r = await kit.call('GET', `/cycles/cy-fall/export.csv?dir=asc&cursor=${encodeURIComponent(next)}`);
    page = parseCsv(r.text);
    assert.deepEqual(page.slice(1).map((x) => x[3]), ['c@cornell.edu', 'd@cornell.edu']); assert.equal(r.headers.link, undefined);
  } finally { analyticsModule.LIMITS.exportPage = savedPage; }
  assert.equal((await kit.call('GET', '/cycles/cy-fall/export.csv', { me: NOBODY })).status, 403);

  // Onboarding: accepted people, invited through addMembers, stamped once.
  r = await kit.call('GET', '/cycles/cy-fall/onboarding');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.rows.map((x) => [x.applicationId, x.onRoster, x.onboarding]), [['in-a', null, null], ['in-d', null, null]], 'accepted only, oldest decision first');
  assert.equal((await kit.call('GET', '/cycles/cy-fall/onboarding', { me: LEAD })).status, 403, 'onboarding is admin only');
  mem.applications.find((x) => x.id === 'in-b').outcome = 'accepted';
  const first = rq();
  r = await kit.call('POST', '/cycles/cy-fall/onboarding', { body: { requestId: first, ids: ['in-a', 'in-b', 'in-c', 'in-d', 'in-nope'] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(kit.invites.length, 1); assert.deepEqual(kit.invites[0], { emails: ['a@cornell.edu', 'b@cornell.edu', 'd@cornell.edu'], actorEmail: ADMIN.email }, 'one addMembers call for the batch, as the admin');
  assert.equal(r.body.invited, 2); assert.equal(r.body.active, 1); assert.equal(r.body.failed, 0);
  const res = Object.fromEntries(r.body.results.map((x) => [x.id, x]));
  assert.equal(res['in-a'].status, 'invited'); assert.deepEqual(res['in-a'].emailed, { sent: true });
  assert.equal(res['in-b'].status, 'active'); assert.equal(res['in-b'].ok, true); assert.equal(res['in-b'].emailed, undefined);
  assert.equal(res['in-d'].status, 'invited'); assert.deepEqual(res['in-d'].emailed, { sent: false, reason: 'Resend 500' });
  assert.equal(res['in-c'].reason, 'not accepted'); assert.equal(res['in-nope'].reason, 'not accepted');
  assert.deepEqual(kit.welcomes.map((w) => w.to), ['a@cornell.edu', 'd@cornell.edu']); assert.equal(kit.welcomes[0].addedByName, 'Admin Person');
  for (const id of ['in-a', 'in-b', 'in-d']) assert.equal(mem.applications.find((x) => x.id === id).onboardedAt, kit.now(), `${id} stamped`);
  assert.equal(mem.applications.find((x) => x.id === 'in-a').editVersion, 1);
  assert.equal(mem.applicants.find((p) => p.email === 'a@cornell.edu').doc.memberEmail, 'a@cornell.edu');
  assert.equal(mem.onboarding.length, 3); assert.equal(mem.onboarding.find((x) => x.applicationId === 'in-b').status, 'active');
  assert.equal(kit.events.filter((e) => e.event === 'onboarding.invited').length, 1);
  assert.equal(kit.audits.filter((x) => x.kind === 'onboard').length, 3);
  const replay = await kit.call('POST', '/cycles/cy-fall/onboarding', { body: { requestId: first, ids: ['in-a', 'in-b', 'in-d'] } });
  assert.equal(replay.body.replayed, true); assert.equal(kit.invites.length, 1, 'a replayed request invites nobody');
  r = await kit.call('POST', '/cycles/cy-fall/onboarding', { body: { requestId: rq(), ids: ['in-a', 'in-d'] } });
  assert.equal(kit.invites.length, 1, 'onboarded people are never re-invited'); assert.ok(r.body.results.every((x) => x.reason === 'already onboarded' && x.status === 'active'));
  r = await kit.call('GET', '/cycles/cy-fall/onboarding');
  assert.deepEqual(r.body.rows.map((x) => [x.applicationId, x.onRoster]), [['in-b', 'active'], ['in-a', 'invited'], ['in-d', 'invited']], 'invited people read as invited until the roster shows them active');
  r = await kit.call('POST', '/cycles/cy-fall/onboarding', { body: { requestId: rq(), ids: ['in-a'] }, me: LEAD });
  assert.equal(r.status, 403);
  const stranger = makeKit({ mem: seedMem() });
  stranger.wiki.addMembers = async (emails, actor) => ({ results: false });
  r = await stranger.call('POST', '/cycles/cy-fall/onboarding', { body: { requestId: rq(), ids: ['in-a'] } });
  assert.equal(r.status, 403, 'the state write re-checks the admin');
  stranger.cleanup();
  const ex = await onboarding.collect['application.extras']({ cycle: mem.cycles[0], ids: ['in-a', 'in-c'] }, kit);
  assert.equal(ex['in-a'].onboarding.status, 'invited'); assert.equal(ex['in-c'], undefined);
  assert.throws(() => onboarding.validateSettings({ role: 'admin' }), (e) => e.status === 400);

  // Erase one applicant everywhere; keys and counts survive.
  const before = { requests: kit.requests.size, receipts: { ...mem.receipts }, audits: kit.audits.length };
  r = await kit.call('POST', '/applicants/A%40cornell.edu/erase', { body: { confirm: 'a@cornell.edu' } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual(r.body, { erased: 1 });
  const ea = mem.applications.find((x) => x.id === 'in-a');
  assert.equal(ea.name, 'Applicant'); assert.equal(ea.email, 'erased:in-a'); assert.deepEqual(ea.answers, {}); assert.deepEqual(ea.files, []);
  assert.equal(ea.review.comments, undefined); assert.equal(ea.review.flagged, true, 'flags survive, comment text does not');
  assert.equal(ea.erasedAt, kit.now()); assert.equal(ea.editVersion, 2); assert.equal(ea.stage, 'accepted'); assert.equal(ea.outcome, 'accepted'); assert.equal(ea.receiptId, 'jr-in-a');
  assert.equal(mem.scores.find((s) => s.applicationId === 'in-a').doc.notes, ''); assert.equal(mem.scores.find((s) => s.applicationId === 'in-a').doc.total, 4);
  assert.equal(mem.mail.find((m) => m.applicationId === 'in-a').toEmail, 'erased'); assert.equal(mem.bookings.find((b) => b.applicationId === 'in-a').tokenHash, '');
  assert.equal(mem.onboarding.find((o) => o.applicationId === 'in-a').memberEmail, 'erased');
  assert.deepEqual(kit.removed, ['int-a1']); assert.deepEqual(kit.forgotten, ['jr-in-a']);
  assert.equal(mem.applicants.some((p) => p.email === 'a@cornell.edu'), false); assert.equal(mem.applicants.some((p) => p.email === 'b@cornell.edu'), true);
  assert.deepEqual(mem.receipts, before.receipts, 'receipts are never touched'); assert.equal(kit.requests.size, before.requests, 'request ids survive');
  const erased = kit.audits.slice(before.audits).find((x) => x.kind === 'app.erase');
  assert.equal(erased.applicationId, 'in-a'); assert.match(erased.detail.emailHash, /^[a-f0-9]{24}$/); assert.doesNotMatch(JSON.stringify(erased.detail), /cornell\.edu|Person/, 'audit detail never holds applicant strings');
  assert.equal(mem.mail.find((m) => m.applicationId === 'in-b').toEmail, 'b@cornell.edu', 'other people are untouched');
  r = await kit.call('POST', '/applicants/a%40cornell.edu/erase', { body: { confirm: 'a@cornell.edu' } });
  assert.deepEqual(r.body, { erased: 0 }, 'erase is idempotent');
  assert.equal((await kit.call('POST', '/applicants/b%40cornell.edu/erase', { body: { confirm: 'wrong' } })).status, 400);
  assert.equal((await kit.call('POST', '/applicants/b%40cornell.edu/erase', { body: { confirm: 'b@cornell.edu' }, me: LEAD })).status, 403);
  assert.equal((await kit.call('GET', '/cycles/cy-fall/analytics?fresh=1')).body.total, 4, 'counts survive an erase');

  // Purge an archived cycle in pages; the open cycle refuses.
  assert.equal((await kit.call('POST', '/cycles/cy-fall/purge', { body: { confirm: 'Fall 2026' } })).status, 409);
  assert.equal((await kit.call('POST', '/cycles/cy-old/purge', { body: { confirm: 'nope' } })).status, 400);
  assert.equal((await kit.call('POST', '/cycles/cy-old/purge', { body: { confirm: 'Spring 2024' }, me: LEAD })).status, 403);
  const savedPurge = analyticsModule.LIMITS.purgePage;
  analyticsModule.LIMITS.purgePage = 2;
  try {
    r = await kit.call('POST', '/cycles/cy-old/purge', { body: { confirm: 'Spring 2024' } });
    assert.deepEqual(r.body, { purged: 2, remaining: 1 });
    r = await kit.call('POST', '/cycles/cy-old/purge', { body: { confirm: 'Spring 2024' } });
    assert.deepEqual(r.body, { purged: 1, remaining: 0 });
    r = await kit.call('POST', '/cycles/cy-old/purge', { body: { confirm: 'Spring 2024' } });
    assert.deepEqual(r.body, { purged: 0, remaining: 0 });
  } finally { analyticsModule.LIMITS.purgePage = savedPurge; }
  const old = mem.applications.filter((x) => x.cycleId === 'cy-old');
  assert.equal(old.length, 3, 'rows stay for counts');
  assert.ok(old.every((x) => x.name === 'Applicant' && x.email === `erased:${x.id}` && x.erasedAt));
  assert.equal(new Set(old.map((x) => x.email)).size, 3, 'rewritten emails stay unique per cycle');
  assert.equal(mem.applicants.some((p) => p.email === 'x@cornell.edu'), false);
  assert.equal(kit.audits.filter((x) => x.kind === 'purge').length, 2);
  r = await kit.call('GET', '/cycles/cy-fall/analytics?fresh=1');
  assert.deepEqual(r.body.retention.cycles, [], 'a purged cycle drops off the list');
  kit.cleanup();
  console.log('PASS: analytics memory mode — analytics cache and retention window, export with legacy columns, neutralised cells, filters and pages, onboarding through addMembers without duplicate invites, erase everywhere with keys kept, paged purge of archived cycles');
}

/* -------------------------------- SQL shapes ------------------------------ */
{
  const statements = [];
  const sql = async (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    statements.push({ text, values });
    const result = (rows = []) => ({ rows: structuredClone(rows), rowCount: rows.length });
    if (text.startsWith('SELECT doc FROM recruit_settings')) return result([{ doc: { retention: { months: 24 } } }]);
    if (text.startsWith('SELECT * FROM recruit_applications WHERE cycle_id')) return result([{ id: 'in-a', cycle_id: 'cy-fall', email: 'a@cornell.edu', ts: '5', updated: '6', name: 'A', cornell: true, subteam: 'software', year: 'Junior', source: 'form', form_version: 0, answers: { project: 'p' }, files: [], stage: 'applied', stage_at: '5', stage_history: [], outcome: null, decision: {}, tags: [], review: {}, review_version: '0', edit_version: '0', onboarded_at: null, erased_at: null, receipt_id: null }]);
    if (text.startsWith('SELECT doc FROM recruit_forms')) return result([]);
    if (text.startsWith('WITH target AS')) return result([{ id: 'in-a', cycle_id: 'cy-old', email: 'a@cornell.edu', files: [{ id: 'int-a1' }], receipt_id: 'jr-1' }]);
    if (text.startsWith('UPDATE recruit_scores') || text.startsWith('UPDATE recruit_mail') || text.startsWith('UPDATE recruit_bookings') || text.startsWith('UPDATE recruit_onboarding')) return result();
    if (text.startsWith('DELETE FROM recruit_applicants')) return result();
    if (text.startsWith('SELECT id FROM interest_receipts')) return result([{ id: 'jr-1' }]);
    if (text.startsWith('SELECT count(*) AS n FROM recruit_applications')) return result([{ n: 0 }]);
    if (text.startsWith('SELECT application_id, count(*) AS n FROM recruit_mail')) return result([]);
    if (text.startsWith('SELECT * FROM recruit_bookings WHERE cycle_id')) return result([]);
    if (text.startsWith('SELECT * FROM recruit_slots WHERE cycle_id')) return result([]);
    if (text.startsWith('SELECT * FROM recruit_onboarding')) return result([]);
    throw new Error('Unexpected synthetic SQL: ' + text);
  };
  const kit = makeKit({ mode: 'postgres', sql });
  let r = await kit.call('GET', '/cycles/cy-fall/export.csv?q=ada&stage=applied&flagged=1&tag=top');
  assert.equal(r.status, 200, r.body && JSON.stringify(r.body));
  const sel = statements.find((s) => s.text.startsWith('SELECT * FROM recruit_applications WHERE cycle_id'));
  assert.match(sel.text, /name ILIKE \? OR email ILIKE \?/); assert.match(sel.text, /tags @> \?::jsonb/); assert.match(sel.text, /\(review->>'flagged'\)::boolean IS TRUE/);
  assert.match(sel.text, /ORDER BY CASE WHEN \? THEN ts END ASC/); assert.match(sel.text, /LIMIT \?$/);
  assert.ok(sel.values.includes('%ada%') && sel.values.includes('applied') && sel.values.includes(JSON.stringify(['top'])));
  assert.equal(sel.values.at(-1), analyticsModule.LIMITS.exportPage + 1);
  assert.match(r.text, /^\uFEFF"Submitted","Updated","Name","Email","Subteam","Coolest project","Cornell address","File","Year","Stage"/);
  statements.length = 0;
  r = await kit.call('POST', '/cycles/cy-old/purge', { body: { confirm: 'Spring 2024' } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.purged, 1);
  const redact = statements.find((s) => s.text.startsWith('WITH target AS'));
  assert.match(redact.text, /^WITH target AS \(SELECT id, cycle_id, email, files, receipt_id FROM recruit_applications WHERE erased_at IS NULL AND \(\?::text IS NULL OR cycle_id = \?\) AND \(\?::text IS NULL OR email = \?\) ORDER BY ts LIMIT \?\), done AS \(UPDATE recruit_applications a SET name = 'Applicant', email = 'erased:' \|\| a\.id, answers = '\{\}'::jsonb, files = '\[\]'::jsonb, ip_hash = '', review = a\.review - 'comments', erased_at = \?, edit_version = a\.edit_version \+ 1 FROM target t WHERE a\.id = t\.id AND a\.erased_at IS NULL RETURNING a\.id\) SELECT/);
  assert.equal(redact.values[4], analyticsModule.LIMITS.purgePage);
  const kinds = statements.map((s) => s.text.split(' ').slice(0, 3).join(' '));
  for (const k of ['UPDATE recruit_scores SET', 'UPDATE recruit_mail SET', 'UPDATE recruit_bookings SET', 'UPDATE recruit_onboarding SET', 'DELETE FROM recruit_applicants']) assert.ok(kinds.includes(k), `purge runs ${k}`);
  assert.match(statements.find((s) => s.text.startsWith('DELETE FROM recruit_applicants')).text, /NOT EXISTS \(SELECT 1 FROM recruit_applications a WHERE a\.email = p\.email AND a\.erased_at IS NULL\)/);
  assert.deepEqual(kit.removed, ['int-a1']); assert.deepEqual(kit.forgotten, ['jr-1']);
  assert.ok(statements.every((s) => !/BEGIN|COMMIT/.test(s.text)));
  kit.cleanup();
  console.log('PASS: analytics SQL shapes — filtered keyset export, one-statement redaction with the email rewrite, module scrubs and applicant cleanup');
}

/* ---------------------------------- client -------------------------------- */
{
  const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const ui2 = await readFile(new URL('../src/client/ui2.js', import.meta.url), 'utf8');
  const ddSource = ui2.slice(ui2.indexOf('function dd('), ui2.indexOf('const ddSections'));
  const cycle = { id: 'cy-fall', version: 1, status: 'open', name: 'Fall 2026', doc: { modules: {}, subteams: [{ key: 'software', name: 'Software' }, { key: 'electrical', name: 'Electrical' }], pipeline: { stages: STAGES } } };
  const boot = async (file) => {
    const src = await readFile(new URL(`../src/client/${file}`, import.meta.url), 'utf8');
    assert.equal((src.match(/RECRUIT\.register\(/g) || []).length, 1, `${file} registers once`); assert.doesNotMatch(src, /<select|<datalist/i, `${file} has no native select`);
    const requests = [], toasts = [], modules = [];
    let renders = 0, background = 0;
    const ctx = vm.createContext({
      UI: { recruit: { cycleId: 'cy-fall', cycle: { data: cycle, role: 'admin' }, mod: {}, busy: new Set(), selected: new Set() }, modal: null, menu: null },
      RECRUIT: { modules, register(m) { modules.push(m); }, api(url, options = {}) { return new Promise((resolve, reject) => requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, signal: options.signal, resolve, reject })); } },
      REMOTE: {}, MD: { esc }, I: new Proxy({}, { get: () => '<svg></svg>' }), Store: { userName: (e) => e }, crypto: { randomUUID }, AbortSignal, document: { activeElement: null },
      $: (sel, root) => (root ? root.q?.(sel) ?? null : null), $$: (sel, root) => root?.qa?.(sel) ?? [],
      render() { renders += 1; }, renderBackground(name) { assert.equal(name, 'recruit'); background += 1; }, toast: (t) => toasts.push(t), openMenu: () => {},
      closeModal(after) { ctx.UI.modal = null; after?.(); }, showModal(m) { ctx.UI.modal = m; }, focusReference: () => null, resolveFocus: () => null,
      recruitDate: (ts) => new Date(ts).toISOString().slice(0, 10),
    });
    vm.runInContext(ddSource + src, ctx);
    return { ctx, mod: modules[0], requests, toasts, renders: () => renders, background: () => background };
  };

  // Analytics panel.
  {
    const f = await boot('recruit-analytics.js');
    assert.equal(f.mod.name, 'analytics'); assert.equal(f.mod.panel.when(cycle, 'lead'), true); assert.equal(f.mod.panel.when(cycle, 'interviewer'), false);
    f.mod.mount(cycle);
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, '/recruit/cycles/cy-fall/analytics'); assert.ok(f.requests[0].signal instanceof AbortSignal);
    assert.match(f.mod.view(cycle, 'admin'), /Loading…/);
    const data = computeAnalytics({ cycle, apps: seedMem().applications.filter((a) => a.cycleId === 'cy-fall'), now: NOW });
    f.requests[0].resolve({ ...data, retention: { months: 24, cycles: [{ id: 'cy-old', name: 'Spring <2024>', term: 'Spring 2024', closedAt: NOW - 800 * D, remaining: 3 }] } });
    await new Promise((r) => setImmediate(r));
    assert.equal(f.background(), 1); assert.equal(f.renders(), 0);
    const html = f.mod.view(cycle, 'admin');
    assert.match(html, /<h2>Funnel<\/h2>/); assert.match(html, /Screening<\/td><td class="font-mono">1<\/td>/); assert.match(html, /Electrical/); assert.match(html, /Spring &lt;2024&gt;/);
    assert.match(html, /href="\/api\/recruit\/cycles\/cy-fall\/export\.csv" download/); assert.match(html, /data-action="recruit-an-purge"/); assert.doesNotMatch(html, /<select/i); assert.doesNotMatch(html, /<canvas|<svg class="chart/);
    assert.doesNotMatch(f.mod.view(cycle, 'lead'), /recruit-an-purge/, 'leads cannot purge');
    f.mod.actions['recruit-an-purge']({ dataset: { id: 'cy-old', name: 'Spring <2024>', remaining: '3' } }, null, () => {});
    const m = f.ctx.UI.modal;
    assert.equal(m.kind, 'confirm'); assert.equal(m.danger, true); assert.equal(m.typed, 'Spring <2024>'); assert.equal(f.renders(), 1);
    const going = m.onGo();
    assert.equal(f.requests[1].url, '/recruit/cycles/cy-old/purge'); assert.deepEqual(f.requests[1].body, { confirm: 'Spring <2024>' }); assert.ok(f.requests[1].signal instanceof AbortSignal);
    f.requests[1].resolve({ purged: 2, remaining: 1 });
    await new Promise((r) => setImmediate(r));
    assert.equal(f.requests[2].url, '/recruit/cycles/cy-old/purge', 'pages until nothing remains');
    f.requests[2].resolve({ purged: 1, remaining: 0 });
    await going;
    assert.equal(f.toasts.at(-1), 'Purged 3 people from Spring <2024>'); assert.equal(f.requests[3].url, '/recruit/cycles/cy-fall/analytics?fresh=1'); assert.equal(f.renders(), 1);
  }

  // Onboarding panel.
  {
    const f = await boot('recruit-onboarding.js');
    assert.equal(f.mod.name, 'onboarding'); assert.equal(f.mod.panel.when(cycle, 'admin'), true); assert.equal(f.mod.panel.when(cycle, 'lead'), false);
    f.mod.mount(cycle);
    assert.equal(f.requests[0].url, '/recruit/cycles/cy-fall/onboarding'); assert.ok(f.requests[0].signal instanceof AbortSignal);
    f.requests[0].resolve({ rows: [
      { applicationId: 'in-a', name: 'Ada <b>', email: 'a@cornell.edu', subteam: 'software', decidedAt: NOW, onboardedAt: null, onboarding: null, onRoster: null },
      { applicationId: 'in-b', name: 'Bo', email: 'b@cornell.edu', subteam: '', decidedAt: NOW, onboardedAt: null, onboarding: null, onRoster: 'active' },
      { applicationId: 'in-d', name: 'Di', email: 'd@cornell.edu', subteam: '', decidedAt: NOW, onboardedAt: NOW, onboarding: { status: 'invited' }, onRoster: 'invited' },
    ] });
    await new Promise((r) => setImmediate(r));
    assert.equal(f.background(), 1); assert.equal(f.renders(), 0);
    const html = f.mod.view(cycle, 'admin');
    assert.match(html, /Ada &lt;b&gt;/); assert.match(html, /1 to invite/); assert.match(html, /Active member/); assert.match(html, /3 accepted · 1 onboarded/); assert.doesNotMatch(html, /<select/i);
    assert.match(f.mod.view(cycle, 'lead'), /Admins invite new members/);
    f.mod.actions['recruit-ob-invite']({ dataset: {} }, null, () => {});
    const m = f.ctx.UI.modal;
    assert.equal(m.kind, 'confirm'); assert.match(m.title, /Invite 1 to the wiki/); assert.match(m.text, /a@cornell\.edu/); assert.doesNotMatch(m.text, /b@cornell\.edu/, 'people already on the roster are not listed');
    let going = m.onGo();
    const post = f.requests[1];
    assert.equal(post.url, '/recruit/cycles/cy-fall/onboarding'); assert.equal(post.method, 'POST'); assert.deepEqual(post.body.ids, ['in-a']); assert.match(post.body.requestId, /^rq-/); assert.ok(post.signal instanceof AbortSignal);
    post.reject(Object.assign(new Error('Timed out'), { name: 'TimeoutError' }));
    await going;
    assert.match(f.toasts.at(-1), /timed out.*nobody is invited twice/);
    going = m.onGo();
    assert.equal(f.requests[3].body.requestId, post.body.requestId, 'a retry keeps the request id');
    f.requests[3].resolve({ results: [{ id: 'in-a', email: 'a@cornell.edu', ok: true, status: 'invited', emailed: { sent: true } }], invited: 1, active: 1, failed: 0 });
    await going;
    assert.equal(f.toasts.at(-1), '1 invited · 1 already on the roster'); assert.equal(f.requests.at(-1).url, '/recruit/cycles/cy-fall/onboarding'); assert.equal(f.renders(), 1, 'only the confirm dialog rendered');
    const sec = f.mod.detailSections({ id: 'in-a', outcome: 'accepted' }, cycle, 'admin');
    assert.equal(sec[0].title, 'Onboarding'); assert.match(sec[0].html, /data-action="recruit-ob-invite" data-ids="\[&quot;in-a&quot;\]"/);
    assert.equal(f.mod.detailSections({ id: 'in-a' }, cycle, 'lead').length, 0);
    assert.equal(f.mod.selectionActions(new Set(['in-a']), cycle, 'admin')[0].label, 'Invite to wiki'); assert.equal(f.mod.selectionActions(new Set(['in-a']), cycle, 'lead').length, 0);
  }
  console.log('PASS: analytics and onboarding client — plain tables from the analytics payload, typed purge confirm that pages, onboarding sheet with a listed confirm, kept request id on retry, bounded fetches and no render() from async paths');
}
