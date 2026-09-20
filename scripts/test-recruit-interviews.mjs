// Synthetic fixtures only: an in-test kit over a temp-dir memory file, a fake
// SQL tag for statement shapes, and a vm DOM stub for the client. No network,
// credentials, browser or production data are used.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';

globalThis.fetch = async () => { throw new Error('Network disabled in recruit tests'); };
process.env.RECRUIT_TZ = 'UTC';
process.env.RECRUIT_RSVP_BASE = 'https://wiki.test';
const interviews = (await import('../lib/recruit/modules/interviews.js')).default;
const sha = (t) => createHash('sha256').update(t).digest('hex');

/* ------------------------------- in-test kit ------------------------------ */

const PARAMS = { cycle: 'cy-[a-z0-9-]+', app: 'in-[a-z0-9]+', slot: 'sl-[a-z0-9]+', booking: 'bk-[a-z0-9]+', token: '[a-f0-9]{32}', email: '[^/]{3,200}', round: '[a-z0-9_-]{0,40}', key: '[a-z][a-z0-9_-]{0,59}', mail: 'ml-[a-z0-9]+' };
const compile = (path) => {
  const names = [];
  const re = path.split('/').map((seg) => { const p = /^:([a-z]+)$/i.exec(seg); if (!p) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); assert.ok(PARAMS[p[1]], `known param ${p[1]}`); names.push(p[1]); return `(${PARAMS[p[1]]})`; }).join('/');
  return { regex: new RegExp('^' + re + '$'), names };
};
const ADMIN = { email: 'admin@cornell.edu', name: 'Admin', role: 'admin', status: 'active' };
const LEAD = { email: 'lead@cornell.edu', name: 'Lead', role: 'member', status: 'active' };
const IVY = { email: 'iv@cornell.edu', name: 'Ivy', role: 'member', status: 'active' };
const IVO = { email: 'iv2@cornell.edu', name: 'Ivo', role: 'member', status: 'active' };
const NOBODY = { email: 'plain@cornell.edu', name: 'Plain', role: 'member', status: 'active' };

function seedMem() {
  return {
    settings: { version: 1, doc: { retention: { months: 24 }, defaults: {} } },
    cycles: [{ id: 'cy-fall', version: 1, status: 'open', name: 'Fall 2026', term: 'Fall 2026', closedAt: null, doc: {
      modules: {}, subteams: [{ key: 'software', name: 'Software' }],
      pipeline: { stages: [{ key: 'applied', name: 'Applied', kind: 'open' }, { key: 'interview', name: 'Interview', kind: 'open' }, { key: 'rejected', name: 'Rejected', kind: 'closed', outcome: 'rejected' }] },
      interviews: { rounds: [{ key: 'r1', name: 'First interview', minutes: 20, place: 'Upson 116' }, { key: 'r2', name: 'Second interview', minutes: 30, place: '' }], selfSchedule: false },
    } }],
    applicants: [], requests: [], audit: [], roles: [
      { cycleId: 'cy-fall', member: 'lead@cornell.edu', roles: ['lead'], subteams: [] },
      { cycleId: 'cy-fall', member: 'iv@cornell.edu', roles: ['interviewer'], subteams: [] },
      { cycleId: 'cy-fall', member: 'iv2@cornell.edu', roles: ['interviewer'], subteams: [] },
    ],
    applications: ['a', 'b', 'c', 'd', 'e'].map((x) => ({ id: `in-${x}`, cycleId: 'cy-fall', email: `${x}@cornell.edu`, name: `Applicant <${x.toUpperCase()}>`, subteam: 'software', stage: 'interview', ts: 1, updated: 1, answers: {}, files: [], tags: [], review: {}, editVersion: 0 })),
    scores: [], assignments: [], slots: [], bookings: [], mail: [],
  };
}

function makeKit({ mode = 'memory', mem = seedMem(), sql = null, modules = [interviews] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cupi-recruit-iv-'));
  const file = join(dir, '.devrecruit.json');
  let clock = 1789500000000, seq = 0;
  const requests = new Map();
  const kit = {
    mode, dir, file, events: [], audits: [],
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
    async audit(row) { assert.equal(typeof row.kind, 'string'); kit.audits.push(row); },
    async emit(event, payload) { kit.events.push({ event, payload }); for (const m of modules) if (m.hooks?.[event]) await m.hooks[event](payload, kit); },
    async collect(event, payload) { const out = []; for (const m of modules) if (m.collect?.[event]) { const r = await m.collect[event](payload, kit); if (r !== undefined) out.push(r); } return out; },
    cycles: { get: async (id) => mem.cycles.find((c) => c.id === id) || null },
    roles: {
      grantFor: async (cycleId, email) => mem.roles.find((g) => g.member === email && (!cycleId || g.cycleId === cycleId)) || null,
      roleOf: (me, grant) => (me.role === 'admin' ? 'admin' : grant ? ['lead', 'reviewer', 'interviewer'].find((r) => grant.roles.includes(r)) || null : null),
      roster: async () => [LEAD, IVY, IVO, NOBODY].map((u) => ({ email: u.email, name: u.name, role: 'member', subteam: '' })),
    },
    files: { removeUnreferenced: async () => {} },
    email: { send: async () => ({ sent: false, reason: 'disabled' }), settings: async () => { throw new Error('Email disabled in tests'); }, clientId: null, saveOauth: null, host: 'wiki.test' },
    wiki: {},
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  const routes = interviews.routes.map((r) => ({ ...r, ...compile(r.path) }));
  kit.meCalls = 0;
  kit.call = async (method, path, { body = {}, me = LEAD, query = {} } = {}) => {
    const [p, qs] = path.split('?');
    if (qs) for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
    const route = routes.find((r) => r.method === method && r.regex.test(p));
    if (!route) return { status: 404, body: { error: 'No such endpoint' } };
    const params = Object.fromEntries(route.names.map((n, i) => [n, route.regex.exec(p)[i + 1]]));
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(v) { this.text = v; } };
    const rq = { method, path: p, params, query, req: {}, res, me: null, role: null, grant: null, cycle: null, scope: null, body: async () => body };
    try {
      if (route.access !== 'public') {
        kit.meCalls += 1;
        rq.me = me;
        if (params.cycle) {
          rq.cycle = await kit.cycles.get(params.cycle);
          if (!rq.cycle) return { status: 404, body: { error: 'No such cycle' } };
          if (route.mutates && rq.cycle.status === 'archived') return { status: 409, body: { error: 'This cycle is archived' } };
        }
        rq.grant = me.role === 'admin' ? null : await kit.roles.grantFor(rq.cycle?.id || null, me.email);
        rq.role = kit.roles.roleOf(me, rq.grant);
        const ok = { member: true, role: !!rq.role, interviewer: ['admin', 'lead', 'interviewer'].includes(rq.role), reviewer: ['admin', 'lead', 'reviewer'].includes(rq.role), lead: ['admin', 'lead'].includes(rq.role), admin: rq.role === 'admin' }[route.access];
        if (!ok) return { status: 403, body: { error: rq.role ? 'Not allowed in this cycle' : 'Admins only' } };
      }
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
const bookedInvariant = (mem) => { for (const s of mem.slots) assert.equal(s.booked, mem.bookings.filter((b) => b.slotId === s.id && ['invited', 'confirmed'].includes(b.status)).length, `slot ${s.id} booked matches its live bookings`); };
const T0 = Date.UTC(2026, 9, 5, 14, 0, 0);

/* ------------------------------- memory mode ------------------------------ */
{
  const kit = makeKit();
  const mem = kit.mem;
  assert.deepEqual(interviews.defaults().rounds.map((r) => r.key), ['r1'], 'rounds come from settings defaults');
  assert.throws(() => interviews.validateSettings({ rounds: [] }), (e) => e.status === 400 && /at least one/.test(e.error));
  assert.throws(() => interviews.validateSettings({ rounds: [{ key: 'Bad Key', name: 'x', minutes: 20 }] }), (e) => e.status === 400 && /lowercase/.test(e.error));
  interviews.validateSettings({ rounds: [{ key: 'r1', name: 'Interview', minutes: 20, place: '' }], selfSchedule: true });

  // Slot generation: an hour split every 20 minutes, one interviewer from the roster.
  const first = rq();
  let out = await kit.call('POST', '/cycles/cy-fall/slots', { body: { requestId: first, round: 'r1', starts: T0, ends: T0 + 20 * 60000, place: 'Upson 116', capacity: 1, interviewers: ['iv@cornell.edu'], repeat: { every: 20, until: T0 + 60 * 60000 } } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.body.slots.length, 3);
  assert.deepEqual(out.body.slots.map((s) => s.starts - T0), [0, 20 * 60000, 40 * 60000]);
  const replay = await kit.call('POST', '/cycles/cy-fall/slots', { body: { requestId: first, round: 'r1', starts: T0, ends: T0 + 20 * 60000, capacity: 1, interviewers: [] } });
  assert.equal(replay.body.replayed, true); assert.equal(mem.slots.length, 3, 'a replayed request creates nothing');
  assert.ok(existsSync(kit.file) && JSON.parse(readFileSync(kit.file, 'utf8')).slots.length === 3, 'memory doc is written to the temp dir');
  assert.equal((await kit.call('POST', '/cycles/cy-fall/slots', { body: { requestId: rq(), round: 'r1', starts: T0, ends: T0 + 60000, interviewers: ['ghost@cornell.edu'] } })).status, 400, 'interviewers come from the roster');
  assert.equal((await kit.call('POST', '/cycles/cy-fall/slots', { body: { requestId: rq(), round: 'nope', starts: T0, ends: T0 + 60000 } })).status, 400, 'rounds come from the cycle settings');
  assert.equal((await kit.call('POST', '/cycles/cy-fall/slots', { body: { requestId: rq(), round: 'r1', starts: T0, ends: T0 + 60000, capacity: 11 } })).status, 400, 'capacity is capped');
  assert.equal((await kit.call('POST', '/cycles/cy-fall/slots', { body: { requestId: rq(), round: 'r1', starts: T0, ends: T0 + 60000 }, me: IVY })).status, 403, 'interviewers cannot create slots');
  const [s1, s2, s3] = out.body.slots;
  // A fourth slot for the other interviewer, capacity 2.
  const s4 = (await kit.call('POST', '/cycles/cy-fall/slots', { body: { requestId: rq(), round: 'r1', starts: T0 + 3600000, ends: T0 + 3600000 + 20 * 60000, capacity: 2, interviewers: ['iv2@cornell.edu'] } })).body.slots[0];

  // Interviewers see only their own slots; leads see all with members.
  const mine = await kit.call('GET', '/cycles/cy-fall/slots?round=r1', { me: IVY });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.slots.map((s) => s.id).sort(), [s1.id, s2.id, s3.id].sort());
  assert.equal(mine.body.members, undefined, 'the roster is for leads only');
  const all = await kit.call('GET', '/cycles/cy-fall/slots?round=r1');
  assert.equal(all.body.slots.length, 4); assert.ok(all.body.members.some((m) => m.email === 'iv@cornell.edu'));
  assert.equal((await kit.call('GET', '/cycles/cy-fall/slots', { me: NOBODY })).status, 403);

  // Invitations: one row per (application, round); the seat goes to whoever fits.
  const inv = await kit.call('POST', '/cycles/cy-fall/invitations', { body: { requestId: rq(), round: 'r1', ids: ['in-a', 'in-b', 'in-c'], slotId: s1.id } });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal(inv.body.created.length, 3); assert.equal(inv.body.existing.length, 0);
  assert.deepEqual(inv.body.full.sort(), ['in-b', 'in-c'], 'a capacity-1 slot seats exactly one of three');
  assert.equal(inv.body.created.find((b) => b.applicationId === 'in-a').status, 'confirmed');
  assert.equal(mem.slots.find((s) => s.id === s1.id).booked, 1);
  for (const b of inv.body.created) assert.equal(b.tokenHash, undefined, 'token hashes never leave the module');
  const created = kit.events.filter((e) => e.event === 'booking.created');
  assert.equal(created.length, 3);
  for (const e of created) { assert.match(e.payload.rsvpUrl, /^https:\/\/wiki\.test\/api\/recruit\/rsvp\/[a-f0-9]{32}$/); assert.equal(e.payload.purpose, `interview_invite:${e.payload.booking.id}`); }
  const seated = created.find((e) => e.payload.application.id === 'in-a').payload;
  assert.equal(seated.interview.date, 'Monday, October 5'); assert.equal(seated.interview.time, '2:00 PM'); assert.equal(seated.interview.place, 'Upson 116');
  const again = await kit.call('POST', '/cycles/cy-fall/invitations', { body: { requestId: rq(), round: 'r1', ids: ['in-a', 'in-b'] } });
  assert.equal(again.body.created.length, 0); assert.equal(again.body.existing.length, 2, 'double invitation is rejected by (application, round)');
  assert.equal(mem.bookings.length, 3);
  const bk = (app) => mem.bookings.find((b) => b.applicationId === app && b.round === 'r1');

  // Capacity enforced: the second booking into the full slot fails, nothing drifts.
  let r = await kit.call('POST', `/bookings/${bk('in-b').id}/book`, { body: { version: bk('in-b').version, slotId: s1.id } });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'That time is full');
  r = await kit.call('POST', `/bookings/${bk('in-b').id}/book`, { body: { version: bk('in-b').version, slotId: s2.id } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.booking.status, 'confirmed'); assert.equal(r.body.slot.booked, 1);
  r = await kit.call('POST', `/bookings/${bk('in-b').id}/book`, { body: { version: bk('in-b').version, slotId: s3.id } });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'Already booked');
  r = await kit.call('POST', `/bookings/${bk('in-c').id}/book`, { body: { version: 99, slotId: s3.id } });
  assert.equal(r.status, 409); assert.match(r.body.error, /changed/); assert.equal(mem.slots.find((s) => s.id === s3.id).booked, 0, 'a stale version takes no seat');
  assert.equal((await kit.call('POST', `/bookings/${bk('in-c').id}/book`, { body: { version: 1, slotId: s3.id }, me: IVY })).status, 403, 'interviewers cannot book');
  bookedInvariant(mem);

  // Reschedule frees the old seat and takes the new one in one step.
  const a = bk('in-a');
  r = await kit.call('POST', `/bookings/${a.id}/reschedule`, { body: { version: a.version, slotId: s3.id, send: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(mem.slots.find((s) => s.id === s1.id).booked, 0); assert.equal(mem.slots.find((s) => s.id === s3.id).booked, 1);
  assert.equal(bk('in-a').slotId, s3.id); assert.equal(bk('in-a').status, 'confirmed');
  const resch = kit.events.filter((e) => e.event === 'booking.created').at(-1).payload;
  assert.equal(resch.purpose, `interview_reschedule:${a.id}:${bk('in-a').version}`); assert.match(resch.rsvpUrl, /[a-f0-9]{32}$/);
  r = await kit.call('POST', `/bookings/${a.id}/reschedule`, { body: { version: bk('in-a').version, slotId: s3.id } });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'Already booked');
  r = await kit.call('POST', `/bookings/${a.id}/reschedule`, { body: { version: bk('in-a').version, slotId: s2.id } });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'That time is full');
  assert.equal(mem.slots.find((s) => s.id === s3.id).booked, 1, 'a failed reschedule keeps the old seat');
  bookedInvariant(mem);

  // Status changes: no-show releases the seat, done keeps it; illegal moves are 409.
  const b = bk('in-b');
  assert.equal((await kit.call('PATCH', `/bookings/${b.id}`, { body: { version: b.version, status: 'no_show' }, me: IVO })).status, 403, 'an interviewer not on the slot cannot change it');
  r = await kit.call('PATCH', `/bookings/${b.id}`, { body: { version: b.version, status: 'no_show' }, me: IVY });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(mem.slots.find((s) => s.id === s2.id).booked, 0);
  assert.equal(kit.events.filter((e) => e.event === 'booking.status').length, 1);
  r = await kit.call('PATCH', `/bookings/${b.id}`, { body: { version: bk('in-b').version, status: 'done' } });
  assert.equal(r.status, 409, 'no-show cannot become done');
  r = await kit.call('PATCH', `/bookings/${bk('in-a').id}`, { body: { version: bk('in-a').version, status: 'done' } });
  assert.equal(r.status, 200); assert.equal(mem.slots.find((s) => s.id === s3.id).booked, 0, 'done hands the seat back');
  bookedInvariant(mem);
  // Reschedule a no-show: takes a seat again.
  r = await kit.call('POST', `/bookings/${bk('in-b').id}/reschedule`, { body: { version: bk('in-b').version, slotId: s1.id, send: false } });
  assert.equal(r.status, 200); assert.equal(mem.slots.find((s) => s.id === s1.id).booked, 1); assert.equal(bk('in-b').status, 'confirmed');
  bookedInvariant(mem);

  // RSVP: hashed single-use token, no session, no applicant data, expiring.
  const tokenOf = (app) => kit.events.filter((e) => e.event === 'booking.created' && e.payload.application.id === app).at(-1).payload.rsvpUrl.split('/').pop();
  const cToken = tokenOf('in-c');
  assert.equal(bk('in-c').tokenHash, sha(cToken));
  const before = kit.meCalls;
  r = await kit.call('GET', `/rsvp/${cToken}`);
  assert.equal(kit.meCalls, before, 'public RSVP never resolves a session');
  assert.equal(r.status, 200); assert.equal(r.body.round, 'First interview'); assert.equal(r.body.slot, null); assert.equal(r.body.status, 'invited');
  assert.doesNotMatch(JSON.stringify(r.body), /Applicant|cornell\.edu/, 'RSVP carries no applicant data');
  assert.equal(r.body.slots, undefined, 'no slot list without self-scheduling');
  r = await kit.call('POST', `/rsvp/${cToken}`, { body: { action: 'confirm', slotId: s1.id } });
  assert.equal(r.status, 400, 'self-scheduling is off');
  mem.cycles[0].doc.interviews.selfSchedule = true;
  r = await kit.call('GET', `/rsvp/${cToken}`);
  assert.ok(Array.isArray(r.body.slots)); assert.deepEqual(r.body.slots.map((s) => s.id).sort(), [s2.id, s3.id, s4.id].sort(), 'only future slots with a free seat are offered');
  assert.equal(r.body.slots.find((s) => s.id === s4.id).free, 2);
  r = await kit.call('POST', `/rsvp/${cToken}`, { body: { action: 'confirm', slotId: s1.id } });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'That time is full');
  r = await kit.call('POST', `/rsvp/${cToken}`, { body: { action: 'confirm', slotId: s2.id } });
  assert.equal(r.status, 200); assert.equal(r.body.status, 'confirmed'); assert.equal(mem.slots.find((s) => s.id === s2.id).booked, 1);
  assert.equal(bk('in-c').tokenHash, '', 'a used token is spent');
  assert.equal((await kit.call('GET', `/rsvp/${cToken}`)).status, 404, 'single use');
  assert.equal((await kit.call('POST', `/rsvp/${cToken}`, { body: { action: 'decline' } })).status, 404);
  assert.equal((await kit.call('GET', `/rsvp/${'0'.repeat(32)}`)).status, 404, 'unknown token');
  assert.ok(kit.audits.some((x) => x.kind === 'rsvp' && x.actor === 'applicant'));
  bookedInvariant(mem);
  // Decline through the link releases the lead-booked seat.
  const bToken = kit.events.filter((e) => e.event === 'booking.created' && e.payload.application.id === 'in-b').at(-1).payload.rsvpUrl.split('/').pop();
  r = await kit.call('POST', `/rsvp/${bToken}`, { body: { action: 'decline' } });
  assert.equal(r.status, 200); assert.equal(r.body.status, 'declined'); assert.equal(mem.slots.find((s) => s.id === s1.id).booked, 0);
  bookedInvariant(mem);
  // Expiry: an invite older than the token window is dead.
  await kit.call('POST', '/cycles/cy-fall/invitations', { body: { requestId: rq(), round: 'r1', ids: ['in-d'], send: false } });
  const dToken = tokenOf('in-d');
  assert.equal((await kit.call('GET', `/rsvp/${dToken}`)).status, 200);
  kit.tick(15 * 86400000);
  assert.equal((await kit.call('GET', `/rsvp/${dToken}`)).status, 404, 'tokens expire');
  kit.tick(-15 * 86400000);
  // Resend rotates the token; the old one dies.
  r = await kit.call('POST', `/bookings/${bk('in-d').id}/resend`, { body: {} });
  assert.equal(r.status, 200);
  assert.equal((await kit.call('GET', `/rsvp/${dToken}`)).status, 404);
  assert.equal((await kit.call('GET', `/rsvp/${tokenOf('in-d')}`)).status, 200);
  assert.equal(kit.events.at(-1).payload.purpose, `interview_invite:${bk('in-d').id}:again-${bk('in-d').version}`);
  assert.equal(bk('in-d').invitedAt, kit.now(), 'a resent link starts a fresh expiry window');

  // Slot edits and deletes respect seats and versions.
  r = await kit.call('PATCH', `/slots/${s2.id}`, { body: { version: mem.slots.find((s) => s.id === s2.id).version, capacity: 0 } });
  assert.equal(r.status, 400);
  r = await kit.call('PATCH', `/slots/${s4.id}`, { body: { version: mem.slots.find((s) => s.id === s4.id).version, capacity: 1, place: 'Duffield' } });
  assert.equal(r.status, 200); assert.equal(r.body.slot.place, 'Duffield');
  r = await kit.call('DELETE', `/slots/${s2.id}?version=${mem.slots.find((s) => s.id === s2.id).version}`);
  assert.equal(r.status, 409); assert.match(r.body.error, /already booked/);
  r = await kit.call('DELETE', `/slots/${s4.id}?version=${mem.slots.find((s) => s.id === s4.id).version}`);
  assert.equal(r.status, 200); assert.equal(mem.slots.length, 3);

  // My interviews for an interviewer: only their slots, with scored flags.
  mem.scores.push({ applicationId: 'in-c', member: 'iv@cornell.edu', kind: 'interview', round: 'r1', submitted: 5 });
  r = await kit.call('GET', '/cycles/cy-fall/my-interviews', { me: IVY });
  assert.equal(r.status, 200);
  const cRow = r.body.upcoming.flatMap((g) => g.bookings).find((x) => x.applicationId === 'in-c');
  assert.equal(cRow.scored, true); assert.equal(cRow.name, 'Applicant <C>');
  assert.equal((await kit.call('GET', '/cycles/cy-fall/my-interviews', { me: IVO })).body.upcoming.length, 0);

  // Bookings list and collectors.
  r = await kit.call('GET', '/cycles/cy-fall/bookings?round=r1');
  assert.equal(r.body.bookings.length, 4); assert.ok(r.body.bookings.every((x) => x.tokenHash === undefined));
  const scope = await interviews.collect['scope.applications']({ cycle: mem.cycles[0], me: IVY }, kit);
  assert.deepEqual([...scope].sort(), ['in-a', 'in-c'], 'an interviewer scopes to people booked with them');
  const extras = await interviews.collect['application.extras']({ cycle: mem.cycles[0], ids: ['in-a', 'in-e'] }, kit);
  assert.equal(extras['in-a'].booking.status, 'done'); assert.equal(extras['in-e'], undefined);
  const cols = await interviews.collect['csv.columns'](mem.cycles[0], kit);
  assert.equal(cols[0].header, 'Interview'); assert.match(cols[0].cell({ id: 'in-b' }), /^declined/); assert.equal(cols[0].cell({ id: 'in-e' }), '');

  // Hooks: leaving the interview stage cancels open invitations; closing the cycle blanks every token.
  await kit.call('POST', '/cycles/cy-fall/invitations', { body: { requestId: rq(), round: 'r1', ids: ['in-e'], send: false } });
  await kit.emit('stage.moved', { cycle: mem.cycles[0], application: 'in-e', from: 'interview', to: 'rejected', by: 'lead@cornell.edu' });
  assert.equal(bk('in-e').status, 'cancelled'); assert.equal(bk('in-e').tokenHash, '');
  assert.equal(bk('in-d').status, 'invited');
  await kit.emit('cycle.status', { cycle: mem.cycles[0], from: 'open', to: 'closed', by: 'admin@cornell.edu' });
  assert.equal(bk('in-d').status, 'cancelled'); assert.ok(mem.bookings.every((x) => x.tokenHash === ''), 'a closed cycle keeps no live tokens');
  bookedInvariant(mem);
  // Archived cycles refuse booking changes even on cycle-less routes.
  mem.cycles[0].status = 'archived';
  r = await kit.call('PATCH', `/bookings/${bk('in-a').id}`, { body: { version: bk('in-a').version, status: 'cancelled' } });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'This cycle is archived');
  await interviews.collect.purge({ cycle: mem.cycles[0], ids: ['in-a'] }, kit);
  kit.cleanup();
  console.log('PASS: interviews memory mode — slot generation, roster-checked interviewers, own-slot scoping, once-only invitations, capacity, atomic reschedule, seat invariant, single-use expiring RSVP, hooks and collectors');
}

/* -------------------------------- SQL shapes ------------------------------ */
{
  const statements = [];
  const rows = { slot: { id: 'sl-1', cycle_id: 'cy-fall', round: 'r1', starts: '1', ends: '2', place: '', capacity: 1, booked: 0, interviewers: [], version: '1', created: '1', created_by: 'lead@cornell.edu' } };
  rows.booking = { id: 'bk-1', cycle_id: 'cy-fall', round: 'r1', application_id: 'in-a', slot_id: null, status: 'invited', token_hash: 'h', version: '1', invited_at: '1', confirmed_at: null, updated: '1', doc: { history: [] } };
  const sql = async (strings, ...values) => {
    assert.ok(Array.isArray(strings) && values.length === strings.length - 1, 'tagged template call');
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    statements.push({ text, values });
    const result = (list = []) => ({ rows: structuredClone(list), rowCount: list.length });
    if (text.startsWith('SELECT * FROM recruit_bookings WHERE id')) return result([rows.booking]);
    if (text.startsWith('SELECT * FROM recruit_slots WHERE id')) return result([rows.slot]);
    if (text.startsWith('SELECT id, cycle_id, email, name, subteam, stage, erased_at FROM recruit_applications')) return result([{ id: 'in-a', cycle_id: 'cy-fall', email: 'a@x.edu', name: 'A', subteam: '', stage: 'interview', erased_at: null }]);
    if (text.startsWith('WITH s AS (UPDATE recruit_slots SET booked = booked + 1')) return result([{ ...rows.booking, slot_id: 'sl-1', status: 'confirmed', version: '2', slot_interviewers: [] }]);
    if (text.startsWith('WITH prev AS (SELECT id, slot_id, status FROM recruit_bookings')) return result([{ ...rows.booking, status: 'declined', version: '2', prev_status: 'confirmed', prev_slot: 'sl-1' }]);
    if (text.startsWith('WITH old AS (SELECT id, slot_id, status FROM recruit_bookings')) return result([{ ...rows.booking, slot_id: 'sl-2', status: 'confirmed', version: '3', slot_interviewers: [] }]);
    if (text.startsWith('INSERT INTO recruit_bookings')) return result([{ ...rows.booking }]);
    if (text.startsWith('INSERT INTO recruit_slots')) return result([rows.slot]);
    if (text.startsWith('SELECT * FROM recruit_bookings WHERE cycle_id')) return result([]);
    if (text.startsWith('SELECT * FROM recruit_slots WHERE cycle_id')) return result([rows.slot]);
    if (text.startsWith('SELECT * FROM recruit_bookings WHERE slot_id')) return result([]);
    if (text.startsWith('SELECT count(*) AS n FROM recruit_mail')) return result([{ n: 0 }]);
    if (text.startsWith('UPDATE recruit_bookings SET token_hash')) return result([{ ...rows.booking, version: '2' }]);
    throw new Error('Unexpected synthetic SQL: ' + text);
  };
  const kit = makeKit({ mode: 'postgres', sql });
  const mark = () => statements.length;
  const writesSince = (n) => statements.slice(n).filter((s) => /^(WITH|UPDATE|INSERT|DELETE)/.test(s.text));

  let n = mark();
  let r = await kit.call('POST', '/bookings/bk-1/book', { body: { version: 1, slotId: 'sl-1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let w = writesSince(n);
  assert.equal(w.length, 1, 'booking is one statement');
  assert.match(w[0].text, /^WITH s AS \(UPDATE recruit_slots SET booked = booked \+ 1, version = version \+ 1 WHERE id = \? AND cycle_id = \? AND round = \? AND booked < capacity AND EXISTS \(SELECT 1 FROM recruit_bookings b WHERE b\.id = \?/);
  assert.match(w[0].text, /b\.status IN \('invited', 'confirmed'\) AND b\.slot_id IS NULL\) RETURNING id, interviewers\) UPDATE recruit_bookings b SET slot_id = s\.id, status = 'confirmed'/);
  assert.match(w[0].text, /RETURNING b\.\*/);
  assert.doesNotMatch(w[0].text, /BEGIN|COMMIT/);

  n = mark();
  r = await kit.call('PATCH', '/bookings/bk-1', { body: { version: 1, status: 'declined' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  w = writesSince(n);
  assert.equal(w.length, 1, 'status change and seat release are one statement');
  assert.match(w[0].text, /UPDATE recruit_slots SET booked = GREATEST\(booked - 1, 0\)/);
  assert.match(w[0].text, /prev\.status = ANY\(\?\)/);
  assert.deepEqual(w[0].values.find((v) => Array.isArray(v)), ['invited', 'confirmed']);

  n = mark();
  r = await kit.call('POST', '/bookings/bk-1/reschedule', { body: { version: 1, slotId: 'sl-2', send: false } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  w = writesSince(n);
  assert.equal(w.length, 1, 'reschedule releases and books in one statement');
  assert.match(w[0].text, /taken AS \(UPDATE recruit_slots SET booked = booked \+ 1/);
  assert.match(w[0].text, /freed AS \(UPDATE recruit_slots SET booked = GREATEST\(booked - 1, 0\)/);
  assert.match(w[0].text, /AND EXISTS \(SELECT 1 FROM taken\)/);
  assert.match(w[0].text, /token_hash = \?/);
  assert.ok(w[0].values.some((v) => /^[a-f0-9]{64}$/.test(v)), 'a fresh hashed token rides in the same statement');

  n = mark();
  r = await kit.call('POST', '/cycles/cy-fall/invitations', { body: { requestId: rq(), round: 'r1', ids: ['in-a'], send: false } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ins = writesSince(n).find((s) => s.text.startsWith('INSERT INTO recruit_bookings'));
  assert.match(ins.text, /ON CONFLICT \(application_id, round\) DO NOTHING RETURNING \*/);
  assert.match(ins.text, /jsonb_to_recordset\(\?::jsonb\)/);
  const bookingsRow = JSON.parse(ins.values.find((v) => typeof v === 'string' && v.includes('"hash"')));
  assert.match(bookingsRow[0].hash, /^[a-f0-9]{64}$/, 'only the hash is stored');
  assert.deepEqual(interviews.schema.filter((s) => /CREATE (UNIQUE )?INDEX|CREATE TABLE/.test(s)).length, interviews.schema.length);
  assert.match(interviews.schema.find((s) => s.includes('recruit_bookings')), /UNIQUE \(application_id, round\)/);
  kit.cleanup();
  console.log('PASS: interviews SQL shapes — single-statement booking with the guard on the slot UPDATE, one-statement release and reschedule, once-only invitation insert');
}

/* ---------------------------------- client -------------------------------- */
{
  const src = await readFile(new URL('../src/client/recruit-interviews.js', import.meta.url), 'utf8');
  const ui2 = await readFile(new URL('../src/client/ui2.js', import.meta.url), 'utf8');
  const ddSource = ui2.slice(ui2.indexOf('function dd('), ui2.indexOf('const ddSections'));
  assert.equal((src.match(/RECRUIT\.register\(/g) || []).length, 1, 'registers once');
  assert.ok(src.includes('// recruit:interviews:start') && src.includes('// recruit:interviews:end'));
  assert.doesNotMatch(src, /<select|<datalist/i, 'no native select');
  const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const cycle = { id: 'cy-fall', version: 3, status: 'open', name: 'Fall 2026', doc: { modules: {}, interviews: { rounds: [{ key: 'r1', name: 'First interview', minutes: 20, place: '' }], selfSchedule: false } } };
  const requests = [], toasts = [], menus = [];
  let background = 0, closed = 0, renders = 0;
  const modules = [];
  const ctx = vm.createContext({
    UI: { recruit: { cycleId: 'cy-fall', cycle: { data: cycle, role: 'lead' }, mod: {}, busy: new Set(), selected: new Set(['in-a']) }, modal: null, menu: null },
    RECRUIT: { modules, register(m) { modules.push(m); }, api(url, options = {}) { return new Promise((resolve, reject) => requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, signal: options.signal, resolve, reject })); } },
    REMOTE: {}, MD: { esc }, I: new Proxy({}, { get: () => '<svg></svg>' }), Store: { userName: (e) => e },
    crypto: { randomUUID }, AbortSignal, document: { activeElement: null },
    $: (sel, root) => (root ? root.q?.(sel) ?? null : null), $$: (sel, root) => root?.qa?.(sel) ?? [],
    render() { renders += 1; },
    renderBackground(name) { assert.equal(name, 'recruit'); background += 1; },
    toast: (t) => toasts.push(t), openMenu: (items, anchor) => menus.push({ items, anchor }),
    closeModal(after) { closed += 1; ctx.UI.modal = null; after?.(); }, showModal(m) { ctx.UI.modal = m; },
    focusReference: () => null, resolveFocus: () => null, recruitDate: (ts) => new Date(ts).toISOString().slice(0, 10),
  });
  vm.runInContext(ddSource + src, ctx);
  const mod = modules[0];
  assert.equal(mod.name, 'interviews'); assert.equal(mod.order, 60);
  for (const group of ['actions', 'dd', 'modals']) for (const k of Object.keys(mod[group])) assert.ok(k.startsWith('recruit-'), `${group} key ${k}`);
  assert.equal(mod.panel.when(cycle, 'interviewer'), true); assert.equal(mod.panel.when(cycle, 'reviewer'), false);
  assert.equal(mod.panel.when({ doc: { modules: { interviews: false } } }, 'admin'), false);

  // Mount loads slots, bookings and my interviews for a lead; view shows loading.
  mod.mount(cycle);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((r) => r.signal instanceof AbortSignal), 'every fetch has a bounded lifetime');
  assert.equal(requests[0].url, '/recruit/cycles/cy-fall/slots?round=r1');
  assert.match(mod.view(cycle, 'lead'), /Loading…/);
  requests[0].resolve({ slots: [{ id: 'sl-1', round: 'r1', starts: Date.UTC(2026, 9, 5, 14), ends: Date.UTC(2026, 9, 5, 14, 20), place: 'Upson <116>', capacity: 3, booked: 1, interviewers: ['iv@cornell.edu'], version: 1 }], rounds: [{ key: 'r1', name: 'First interview' }], selfSchedule: false, members: [{ email: 'iv@cornell.edu', name: 'Ivy "Q"' }] });
  requests[1].resolve({ bookings: [{ id: 'bk-1', applicationId: 'in-a', name: 'Ada <b>', email: 'a@x.edu', status: 'confirmed', slotId: 'sl-1', starts: Date.UTC(2026, 9, 5, 14), version: 2, interviewers: ['iv@cornell.edu'] }] });
  requests[2].resolve({ upcoming: [] });
  await new Promise((r) => setImmediate(r));
  assert.equal(background, 1, 'completion repaints through renderBackground'); assert.equal(renders, 0, 'no render() from an async completion');
  const html = mod.view(cycle, 'lead');
  assert.match(html, /1\/3/); assert.match(html, /Upson &lt;116&gt;/); assert.match(html, /Ada &lt;b&gt;/);
  assert.match(html, /data-m="recruit-round"/); assert.doesNotMatch(html, /<select/i);
  assert.match(mod.view(cycle, 'interviewer'), /My interviews/);

  // Slot creation form: validation, requestId retained across a timeout, no render().
  ctx.UI.modal = { kind: 'recruit-slots' };
  const modalHtml = mod.modals['recruit-slots'](ctx.UI.modal);
  assert.match(modalHtml, /data-action="recruit-iv-slots-form"/); assert.match(modalHtml, /Ivy &quot;Q&quot;/); assert.doesNotMatch(modalHtml, /<select/i);
  const fields = { 'recruit-iv-date': { value: '2026-10-05' }, 'recruit-iv-start': { value: '14:00' }, 'recruit-iv-end': { value: '15:00' }, 'recruit-iv-every': { value: '20' }, 'recruit-iv-capacity': { value: '1' }, 'recruit-iv-place': { value: 'Upson' }, 'recruit-iv-modal-round': { dataset: { value: 'r1' } } };
  const error = { textContent: '', hidden: true };
  const form = { tagName: 'FORM', dataset: { action: 'recruit-iv-slots-form' }, q: (sel) => (sel === '[data-iv-error]' ? error : fields[/\[data-m="([^"]+)"\]/.exec(sel)?.[1]] || null), qa: (sel) => (sel.includes('recruit-iv-interviewer') ? [{ checked: true, value: 'iv@cornell.edu' }, { checked: false, value: 'iv2@cornell.edu' }] : []) };
  fields['recruit-iv-end'].value = '13:00';
  await mod.actions['recruit-iv-slots-form'](form);
  assert.equal(requests.length, 3); assert.match(error.textContent, /end after it starts/); assert.equal(error.hidden, false);
  fields['recruit-iv-end'].value = '15:00';
  const m = ctx.UI.modal;
  let pending = mod.actions['recruit-iv-slots-form'](form);
  await mod.actions['recruit-iv-slots-form'](form);
  assert.equal(requests.length, 4, 'a second submit while pending sends nothing');
  const post = requests[3];
  assert.equal(post.url, '/recruit/cycles/cy-fall/slots'); assert.equal(post.method, 'POST'); assert.ok(post.signal instanceof AbortSignal);
  assert.match(post.body.requestId, /^rq-/); assert.equal(post.body.round, 'r1'); assert.equal(post.body.capacity, 1);
  assert.deepEqual(post.body.interviewers, ['iv@cornell.edu']); assert.equal(post.body.repeat.every, 20);
  assert.equal(post.body.ends - post.body.starts, 20 * 60000); assert.equal(post.body.repeat.until - post.body.starts, 60 * 60000);
  post.reject(Object.assign(new Error('Timed out'), { name: 'TimeoutError' }));
  await pending;
  assert.match(error.textContent, /timed out/); assert.equal(ctx.UI.modal, m, 'the dialog stays open after a timeout');
  pending = mod.actions['recruit-iv-slots-form'](form);
  assert.equal(requests[4].body.requestId, post.body.requestId, 'the retry keeps its request id');
  requests[4].resolve({ slots: [{ id: 'sl-2' }, { id: 'sl-3' }, { id: 'sl-4' }] });
  await pending;
  assert.equal(closed, 1); assert.equal(toasts.at(-1), 'Added 3 slots'); assert.equal(ctx.UI.modal, null); assert.equal(renders, 0);
  assert.equal(requests.length, 8, 'a successful save refreshes the panel');
  const slotRow = { id: 'sl-1', round: 'r1', starts: Date.UTC(2026, 9, 5, 14), ends: Date.UTC(2026, 9, 5, 14, 20), place: 'Upson', capacity: 3, booked: 1, interviewers: ['iv@cornell.edu'], version: 1 };
  const bookingRow = { id: 'bk-1', applicationId: 'in-a', name: 'Ada', email: 'a@x.edu', status: 'confirmed', slotId: 'sl-1', starts: slotRow.starts, version: 2, round: 'r1', interviewers: ['iv@cornell.edu'] };
  const answerRefresh = async (from) => {
    requests[from].resolve({ slots: [slotRow], rounds: [{ key: 'r1', name: 'First interview' }], selfSchedule: false, members: [] });
    requests[from + 1].resolve({ bookings: [bookingRow] });
    requests[from + 2].resolve({ upcoming: [] });
    await new Promise((r) => setImmediate(r));
  };
  await answerRefresh(5);
  assert.equal(ctx.UI.recruit.mod.interviews.bookings.length, 1);

  // Booking actions: status PATCH with version, coalesced while pending; menus are custom.
  mod.actions['recruit-iv-booking-menu']({ dataset: { id: 'bk-1', status: 'confirmed', version: '2', slot: 'sl-1' } }, null, () => {});
  assert.equal(menus.length, 1);
  const labels = menus[0].items.filter((i) => i !== '-').map((i) => i.label);
  assert.equal(JSON.stringify(labels), JSON.stringify(['Reschedule…', 'Resend invite', 'No-show', 'Done', 'Cancel invitation']));
  const n0 = requests.length;
  const p1 = mod.actions['recruit-iv-status']({ dataset: { id: 'bk-1', status: 'no_show', version: '2' } }, null, () => {});
  await mod.actions['recruit-iv-status']({ dataset: { id: 'bk-1', status: 'no_show', version: '2' } }, null, () => {});
  assert.equal(requests.length, n0 + 1, 'double clicks send one request');
  const patch = requests[n0];
  assert.equal(patch.url, '/recruit/bookings/bk-1'); assert.equal(patch.method, 'PATCH'); assert.deepEqual(patch.body, { version: 2, status: 'no_show' }); assert.ok(patch.signal instanceof AbortSignal);
  patch.resolve({ booking: { id: 'bk-1', status: 'no_show' } });
  await p1;
  assert.equal(toasts.at(-1), 'Marked no-show');
  assert.equal(requests.length, n0 + 4, 'the status change refreshes the panel');
  await answerRefresh(n0 + 1);
  // Reschedule dialog and its submit.
  menus[0].items.find((i) => i.label === 'Reschedule…').run();
  assert.equal(ctx.UI.modal.kind, 'recruit-booking'); assert.equal(renders, 1, 'a menu pick is a user action and may render');
  const bookHtml = mod.modals['recruit-booking'](ctx.UI.modal);
  assert.match(bookHtml, /data-action="recruit-iv-booking-form"/); assert.match(bookHtml, /data-m="recruit-iv-slot-pick"/); assert.match(bookHtml, /2 free/);
  const bform = { tagName: 'FORM', dataset: { action: 'recruit-iv-booking-form', id: 'bk-1', version: '2', mode: 'reschedule' }, q: (sel) => (sel === '[data-iv-error]' ? error : sel.includes('recruit-iv-slot-pick') ? { dataset: { value: 'sl-1' } } : sel.includes('recruit-iv-send') ? { checked: false } : null), qa: () => [] };
  const n1 = requests.length;
  const p2 = mod.actions['recruit-iv-booking-form'](bform);
  assert.equal(requests[n1].url, '/recruit/bookings/bk-1/reschedule'); assert.deepEqual(requests[n1].body, { version: 2, slotId: 'sl-1', send: false });
  requests[n1].resolve({ booking: { id: 'bk-1' } });
  await p2;
  assert.equal(toasts.at(-1), 'Rescheduled'); assert.equal(renders, 1, 'the completion did not render');

  // Late responses after a cycle switch are dropped: the reschedule's refresh
  // is still in flight when the member opens another cycle.
  assert.equal(requests.length, n1 + 4, 'the reschedule refreshes the panel');
  const bg = background, n2 = n1 + 1;
  ctx.UI.recruit.cycleId = 'cy-spring';
  requests[n2].resolve({ slots: [], rounds: [] }); requests[n2 + 1].resolve({ bookings: [] }); requests[n2 + 2].resolve({ upcoming: [] });
  await new Promise((r) => setImmediate(r));
  assert.equal(background, bg, 'a stale cycle response never repaints');
  assert.equal(ctx.UI.recruit.mod.interviews.loading, true, 'stale data is not adopted');
  ctx.UI.recruit.cycleId = 'cy-fall';

  // Selection and detail hooks; the invite dialog.
  const acts = mod.selectionActions(new Set(['in-a']), cycle, 'lead');
  assert.equal(acts[0].label, 'Invite to interview…'); assert.equal(mod.selectionActions(new Set(), cycle, 'reviewer').length, 0);
  const sections = mod.detailSections({ id: 'in-a', bookings: [{ round: 'r1', status: 'confirmed', starts: Date.UTC(2026, 9, 5, 14) }] }, cycle, 'lead');
  assert.equal(sections[0].title, 'Interview'); assert.match(sections[0].html, /Confirmed/);
  assert.equal(mod.columns[0].cell({ extras: { booking: { status: 'invited' } } }), 'Invited');
  assert.match(mod.modals['recruit-invite']({ kind: 'recruit-invite', ids: ['in-a', 'in-b'] }), /Invite 2 people/);
  assert.match(mod.settings.view(cycle), /data-action="recruit-settings-interviews"/);
  console.log('PASS: interviews client — slot form validation and retry with a kept request id, booking status and reschedule actions with bounded fetches, custom menus only, stale responses dropped, no render() from async paths');
}
