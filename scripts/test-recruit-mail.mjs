// Synthetic fixtures only: a fetch stub that counts Resend calls, an in-test
// kit over a temp-dir memory file, a fake SQL tag for statement shapes, and
// a vm DOM stub for the client. No network, credentials or production data.
// Run with: node --test scripts/test-recruit-mail.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

/* ------------------------------- fetch stub ------------------------------- */

const resend = { calls: [], fail: false, refuse: false };
globalThis.fetch = async (url, init = {}) => {
  if (String(url) !== 'https://api.resend.com/emails') throw new Error('Network disabled in recruit tests: ' + url);
  resend.calls.push({ url: String(url), body: init.body, headers: init.headers });
  if (resend.refuse) return { ok: false, status: 403, text: async () => 'You can only send testing emails to your own address', json: async () => ({}) };
  if (resend.fail) return { ok: false, status: 500, text: async () => 'Synthetic Resend outage', json: async () => ({}) };
  return { ok: true, status: 200, text: async () => '', json: async () => ({ id: 'msg_' + resend.calls.length }) };
};
process.env.RESEND_API_KEY = '';

const { sendEmail } = await import('../lib/email-send.js');
const { sendWelcome } = await import('../lib/email.js');
const mailer = await import('../lib/recruit/mailer.js');
const commsModule = await import('../lib/recruit/modules/comms.js');
const comms = commsModule.default;
const { renderTemplate, purposeKeyFor, unknownFields, missingFields, mergeFor, DEFAULT_TEMPLATES } = mailer;

/* ------------------------------- in-test kit ------------------------------ */

const PARAMS = { cycle: 'cy-[a-z0-9-]+', app: 'in-[a-z0-9]+', mail: 'ml-[a-z0-9]+', key: '[a-z][a-z0-9_-]{0,59}', email: '[^/]{3,200}' };
const compile = (path) => {
  const names = [];
  const re = path.split('/').map((seg) => { const p = /^:([a-z]+)$/i.exec(seg); if (!p) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); assert.ok(PARAMS[p[1]], `known param ${p[1]}`); names.push(p[1]); return `(${PARAMS[p[1]]})`; }).join('/');
  return { regex: new RegExp('^' + re + '$'), names };
};
const LEAD = { email: 'lead@cornell.edu', name: 'Lead Person', role: 'member', status: 'active' };
const NOBODY = { email: 'plain@cornell.edu', name: 'Plain', role: 'member', status: 'active' };
const SETTINGS = { key: 're_test_key', from: 'wiki@example.com', name: 'CUPI Wiki' };

function seedMem() {
  return {
    settings: { version: 1, doc: { retention: { months: 24 }, defaults: { templates: {} } } },
    cycles: [{ id: 'cy-fall', version: 1, status: 'open', name: 'Fall 2026', term: 'Fall 2026', doc: {
      modules: {}, subteams: [{ key: 'software', name: 'Software' }],
      pipeline: { stages: [{ key: 'applied', name: 'Applied', kind: 'open' }, { key: 'accepted', name: 'Accepted', kind: 'closed', outcome: 'accepted' }] },
      comms: { templates: {}, replyTo: 'team@example.com' },
    } }],
    applicants: [], requests: [], audit: [], roles: [{ cycleId: 'cy-fall', member: 'lead@cornell.edu', roles: ['lead'], subteams: [] }],
    applications: [
      { id: 'in-a', cycleId: 'cy-fall', email: 'a@cornell.edu', name: 'Ada <script>alert(1)</script>', subteam: 'software', year: 'Junior', stage: 'applied', decision: {} },
      { id: 'in-b', cycleId: 'cy-fall', email: 'b@cornell.edu', name: 'Bo "Quotes" & Co', subteam: '', year: null, stage: 'applied', decision: {} },
      { id: 'in-c', cycleId: 'cy-fall', email: 'c@cornell.edu', name: 'Cy', subteam: 'software', year: 'Grad', stage: 'applied', decision: { outcome: 'accepted', reason: 'Great work' } },
    ],
    scores: [], assignments: [], slots: [], bookings: [], mail: [],
  };
}

function makeKit({ mode = 'memory', mem = seedMem(), sql = null, modules = [comms], emailSettings = async () => SETTINGS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cupi-recruit-mail-'));
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
    async audit(row) { kit.audits.push(row); },
    async emit(event, payload) { kit.events.push({ event, payload }); for (const m of modules) if (m.hooks?.[event]) await m.hooks[event](payload, kit); },
    async collect(event, payload) { const out = []; for (const m of modules) if (m.collect?.[event]) { const r = await m.collect[event](payload, kit); if (r !== undefined) out.push(r); } return out; },
    cycles: { get: async (id) => mem.cycles.find((c) => c.id === id) || null },
    roles: {
      grantFor: async (cycleId, email) => mem.roles.find((g) => g.member === email && (!cycleId || g.cycleId === cycleId)) || null,
      roleOf: (me, grant) => (me.role === 'admin' ? 'admin' : grant ? ['lead', 'reviewer', 'interviewer'].find((r) => grant.roles.includes(r)) || null : null),
      roster: async () => [],
    },
    files: { removeUnreferenced: async () => {} },
    email: { send: sendEmail, settings: emailSettings, clientId: null, saveOauth: null, host: 'wiki.test' },
    wiki: {},
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  const routes = comms.routes.map((r) => ({ ...r, ...compile(r.path) }));
  kit.call = async (method, path, { body = {}, me = LEAD, query = {} } = {}) => {
    const [p, qs] = path.split('?');
    if (qs) for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
    const route = routes.find((r) => r.method === method && r.regex.test(p));
    if (!route) return { status: 404, body: { error: 'No such endpoint' } };
    const params = Object.fromEntries(route.names.map((n, i) => [n, route.regex.exec(p)[i + 1]]));
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
      const ok = { member: true, role: !!rq.role, lead: ['admin', 'lead'].includes(rq.role), admin: rq.role === 'admin' }[route.access];
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
const bodyOf = (call) => JSON.parse(call.body);
const kits = [];
after(() => { for (const k of kits) k.cleanup(); console.log('PASS: recruit mail — merge escaping, template guards, once-only batch send with a log row per recipient, failures logged and retried, budget and flush, auto lifecycle sends, sendWelcome byte-identical, SQL shapes, client preview and confirm-send'); });

/* -------------------------------- mailer ---------------------------------- */

test('renderTemplate escapes every merged value, links URLs, renders buttons and a text part', () => {
  const tpl = { subject: 'Hi {{firstName}} <b>', body: 'Dear {{name}},\n\nSee https://example.com/a?b=1&c=2. Term: {{term}}\nSecond line\n\n{{button:Respond|rsvpUrl}}\n\nNothing: {{ subteam }}' };
  const out = renderTemplate(tpl, { name: 'Ada <script>alert(1)</script>', firstName: 'Ada', term: 'Fall & Spring', rsvpUrl: 'https://wiki.test/api/recruit/rsvp/0123456789abcdef0123456789abcdef', subteam: 'Software' });
  assert.equal(out.subject, 'Hi Ada <b>', 'subjects are plain text');
  assert.doesNotMatch(out.html, /<script>/);
  assert.match(out.html, /Dear Ada &lt;script&gt;alert\(1\)&lt;\/script&gt;,/);
  assert.match(out.html, /Term: Fall &amp; Spring<br>Second line/);
  assert.match(out.html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" style="color:#141414">https:\/\/example\.com\/a\?b=1&amp;c=2<\/a>\./);
  assert.match(out.html, /<a href="https:\/\/wiki\.test\/api\/recruit\/rsvp\/0123456789abcdef0123456789abcdef" style="display:inline-block;background:#141414/);
  assert.match(out.html, /Respond<\/a>/);
  assert.match(out.html, /font-family:Georgia,serif[^>]*>CUPI</); assert.match(out.html, /max-width:520px/);
  assert.match(out.html, /Sent by Cornell Physical Intelligence recruitment\. Reply to reach the team\./);
  assert.match(out.text, /^Dear Ada <script>alert\(1\)<\/script>,\n\nSee https:\/\/example\.com\/a\?b=1&c=2\. Term: Fall & Spring\nSecond line\n\nRespond: https:\/\/wiki\.test/);
  assert.deepEqual(out.warnings, []);
  const injected = renderTemplate({ subject: 's', body: '{{name}} {{button:Go|https://x.test/?"><img src=x>}}' }, { name: '"><img src=x onerror=alert(1)>' });
  assert.doesNotMatch(injected.html, /<img/);
  assert.match(injected.html, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('unknown and missing fields are reported; purpose keys follow the once-only rules', () => {
  assert.deepEqual(unknownFields('Hi {{name}} {{nope}}', '{{button:Go|rsvpUrl}} {{also.bad}}'), ['nope', 'also.bad']);
  assert.deepEqual(missingFields({ subject: '{{name}}', body: '{{interview.date}} {{term}}' }, { name: 'A', term: '' }), ['interview.date', 'term']);
  assert.deepEqual(renderTemplate({ subject: 'x', body: '{{ghost}}' }, {}).warnings, ['Unknown field {{ghost}}']);
  assert.equal(purposeKeyFor('received'), 'received');
  assert.equal(purposeKeyFor('interview_invite', { bookingId: 'bk-1' }), 'interview_invite:bk-1');
  assert.equal(purposeKeyFor('interview_reschedule', { bookingId: 'bk-1', version: 3 }), 'interview_reschedule:bk-1:3');
  assert.equal(purposeKeyFor('custom', { requestId: 'rq-abc' }), 'announce:rq-abc');
  assert.equal(purposeKeyFor('offer', { again: true, batch: 'bt-1' }), 'offer:again-bt-1');
  assert.equal(purposeKeyFor('offer', { purpose: 'custom-key' }), 'custom-key');
  const merge = mergeFor({ application: { name: 'Ada Lovelace', email: 'a@x', subteam: 'software', stage: 'applied', decision: { reason: 'r' } }, cycle: { name: 'Fall 2026', term: 'Fall 2026', doc: { subteams: [{ key: 'software', name: 'Software' }], pipeline: { stages: [{ key: 'applied', name: 'Applied' }] }, comms: { replyTo: 'team@x' } } }, sender: { name: 'Lead' }, extra: { interview: { round: 'R1', date: 'D', time: 'T', place: 'Upson' } } });
  assert.equal(merge.firstName, 'Ada'); assert.equal(merge.subteam, 'Software'); assert.equal(merge.stage, 'Applied'); assert.equal(merge['interview.place'], ' in Upson'); assert.equal(merge.contactEmail, 'team@x');
  for (const key of Object.keys(DEFAULT_TEMPLATES)) assert.deepEqual(unknownFields(DEFAULT_TEMPLATES[key].subject, DEFAULT_TEMPLATES[key].body), [], `default ${key} uses known fields`);
});

/* ------------------------------ templates --------------------------------- */

test('templates: defaults are inherited, unknown merge fields are refused at save, versions are checked', async () => {
  const kit = makeKit(); kits.push(kit);
  let r = await kit.call('GET', '/cycles/cy-fall/templates');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.templates.map((t) => t.key), ['received', 'interview_invite', 'offer', 'rejection', 'waitlist']);
  assert.ok(r.body.templates.every((t) => t.inherited)); assert.ok(r.body.fields.includes('rsvpUrl'));
  assert.equal((await kit.call('GET', '/cycles/cy-fall/templates', { me: NOBODY })).status, 403);
  r = await kit.call('PUT', '/cycles/cy-fall/templates/offer', { body: { version: 1, subject: 'Welcome {{firstName}}', body: 'Hi {{nickname}}', auto: false } });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'Unknown field {{nickname}}');
  r = await kit.call('PUT', '/cycles/cy-fall/templates/offer', { body: { version: 1, subject: 'Welcome {{firstName}}', body: 'Hi {{firstName}}, you are in{{subteam}}.\n\nReason: {{decision.reason}}', auto: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.cycle.version, 2);
  assert.equal(kit.mem.cycles[0].doc.comms.templates.offer.by, 'lead@cornell.edu');
  r = await kit.call('PUT', '/cycles/cy-fall/templates/offer', { body: { version: 1, subject: 'x', body: 'y' } });
  assert.equal(r.status, 409); assert.equal(r.body.version, 2);
  assert.equal((await kit.call('PUT', '/cycles/cy-fall/templates/bogus', { body: { version: 2, subject: 'x', body: 'y' } })).status, 400);
  r = await kit.call('GET', '/cycles/cy-fall/templates');
  const offer = r.body.templates.find((t) => t.key === 'offer');
  assert.equal(offer.inherited, false); assert.equal(offer.auto, true);
  assert.throws(() => comms.validateSettings({ replyTo: 'not-an-email' }), (e) => e.status === 400);
  comms.validateSettings({ replyTo: 'team@example.com', templates: { 'custom-hello': { subject: 's', body: 'b {{name}}' } } });
  r = await kit.call('POST', '/cycles/cy-fall/mail/preview', { body: { templateKey: 'offer', applicationId: 'in-a' } });
  assert.equal(r.status, 200); assert.match(r.body.html, /Hi Ada, you are inSoftware\./); assert.doesNotMatch(r.body.html, /<script>/); assert.match(r.body.subject, /^Welcome Ada$/);
  r = await kit.call('POST', '/cycles/cy-fall/mail/preview', { body: { template: { subject: 'S', body: 'Sample {{name}}' } } });
  assert.match(r.body.html, /Sample Sample Applicant/);
});

/* --------------------------------- send ----------------------------------- */

test('batch send: one log row and one Resend call per recipient, once-only by purpose, idempotent request ids, again suffix', async () => {
  const kit = makeKit(); kits.push(kit);
  resend.calls.length = 0;
  const first = rq();
  let r = await kit.call('POST', '/cycles/cy-fall/mail/send', { body: { requestId: first, templateKey: 'rejection', ids: ['in-a', 'in-b', 'in-a', 'in-zz'] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.queued, 2); assert.equal(r.body.sent, 2); assert.equal(r.body.failed, 0); assert.equal(r.body.remaining, 0);
  assert.deepEqual(r.body.skipped, [{ id: 'in-zz', reason: 'not in this cycle' }]);
  assert.equal(resend.calls.length, 2, 'one Resend call per recipient');
  const toA = resend.calls.map(bodyOf).find((b) => b.to === 'a@cornell.edu');
  assert.equal(toA.from, 'CUPI Wiki <wiki@example.com>'); assert.equal(toA.reply_to, 'team@example.com');
  assert.match(toA.html, /Hi Ada,/); assert.doesNotMatch(toA.html, /<script>/); assert.match(toA.text, /^Hi Ada,/);
  assert.equal(toA.subject, 'Your application to Cornell Physical Intelligence');
  const rows = kit.mem.mail;
  assert.equal(rows.length, 2); assert.ok(rows.every((m) => m.status === 'sent' && m.purposeKey === 'rejection' && m.attempt === 1 && m.sentAt));
  assert.ok(rows.every((m) => m.batch === r.body.batch));
  const replay = await kit.call('POST', '/cycles/cy-fall/mail/send', { body: { requestId: first, templateKey: 'rejection', ids: ['in-a', 'in-b'] } });
  assert.equal(replay.body.replayed, true); assert.equal(resend.calls.length, 2, 'a replayed request sends nothing');
  r = await kit.call('POST', '/cycles/cy-fall/mail/send', { body: { requestId: rq(), templateKey: 'rejection', ids: ['in-a', 'in-b', 'in-c'] } });
  assert.equal(r.body.queued, 1); assert.equal(r.body.sent, 1);
  assert.deepEqual(r.body.skipped.map((s) => s.id).sort(), ['in-a', 'in-b']); assert.ok(r.body.skipped.every((s) => s.reason === 'already sent'));
  assert.equal(resend.calls.length, 3, 'the second send reaches only the new person');
  r = await kit.call('POST', '/cycles/cy-fall/mail/send', { body: { requestId: rq(), templateKey: 'rejection', ids: ['in-a'], dryRun: true } });
  assert.deepEqual(r.body, { will: 0, already: 1, purpose: 'rejection' });
  r = await kit.call('POST', '/cycles/cy-fall/mail/send', { body: { requestId: rq(), templateKey: 'rejection', ids: ['in-a'], again: true } });
  assert.equal(r.body.sent, 1); assert.equal(resend.calls.length, 4);
  assert.match(kit.mem.mail.at(-1).purposeKey, /^rejection:again-bt-/);
  assert.ok(kit.audits.some((a) => a.kind === 'mail' && a.detail.sent === 2));
  assert.equal((await kit.call('POST', '/cycles/cy-fall/mail/send', { body: { requestId: rq(), templateKey: 'rejection', ids: ['in-a'] }, me: NOBODY })).status, 403);
  assert.equal((await kit.call('POST', '/cycles/cy-fall/mail/send', { body: { requestId: 'bad', templateKey: 'rejection', ids: ['in-a'] } })).status, 400);
  r = await kit.call('GET', '/cycles/cy-fall/mail?status=sent');
  assert.equal(r.body.rows.length, 4); assert.equal(r.body.counts.sent, 4); assert.ok(r.body.rows.every((m) => m.doc === undefined));
  r = await kit.call('GET', '/cycles/cy-fall/mail.csv');
  assert.equal(r.status, 200); assert.match(r.text, /^\uFEFFTo,Application,Template,Purpose,Status/); assert.match(r.text, /"a@cornell\.edu","in-a","rejection"/);
});

test('missing fields skip the recipient, failures are logged and retried, sending is bounded and flushed', async () => {
  const kit = makeKit(); kits.push(kit);
  resend.calls.length = 0;
  let r = await kit.call('POST', '/cycles/cy-fall/mail/send', { body: { requestId: rq(), custom: { subject: 'Note for {{firstName}}', body: 'Reason: {{decision.reason}}' }, ids: ['in-a', 'in-c'] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sent, 1); assert.equal(resend.calls.length, 1);
  const a = kit.mem.mail.find((m) => m.applicationId === 'in-a'), c = kit.mem.mail.find((m) => m.applicationId === 'in-c');
  assert.equal(a.status, 'skipped'); assert.equal(a.reason, 'missing fields'); assert.equal(c.status, 'sent'); assert.match(c.purposeKey, /^announce:rq-/);
  assert.match(bodyOf(resend.calls[0]).html, /Reason: Great work/);
  // A Resend outage is a failed row, never a thrown request.
  resend.fail = true;
  r = await kit.call('POST', '/cycles/cy-fall/mail/send', { body: { requestId: rq(), templateKey: 'waitlist', ids: ['in-b'] } });
  resend.fail = false;
  assert.equal(r.status, 200); assert.equal(r.body.failed, 1); assert.equal(r.body.sent, 0);
  const b = kit.mem.mail.find((m) => m.templateKey === 'waitlist');
  assert.equal(b.status, 'failed'); assert.match(b.reason, /Resend 500/); assert.equal(b.attempt, 1);
  r = await kit.call('POST', `/mail/${b.id}/retry`, { body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.row.status, 'sent'); assert.equal(b.attempt, 2);
  assert.equal((await kit.call('POST', `/mail/${b.id}/retry`, { body: {} })).status, 409, 'only failed rows retry');
  assert.equal((await kit.call('POST', `/mail/${b.id}/retry`, { body: {}, me: NOBODY })).status, 403, 'cycle-less routes still resolve the role');
  // A refused From address reads as a reason members can act on.
  resend.refuse = true;
  r = await kit.call('POST', '/cycles/cy-fall/mail/send', { body: { requestId: rq(), templateKey: 'received', ids: ['in-b'] } });
  resend.refuse = false;
  assert.match(kit.mem.mail.at(-1).reason, /Resend refuses the From address/);
  // Missing email settings fail the rows, never the request.
  const noMail = makeKit({ emailSettings: async () => { throw new Error('Email disabled in tests'); } }); kits.push(noMail);
  r = await noMail.call('POST', '/cycles/cy-fall/mail/send', { body: { requestId: rq(), templateKey: 'received', ids: ['in-a'] } });
  assert.equal(r.status, 200); assert.equal(r.body.failed, 1); assert.match(noMail.mem.mail[0].reason, /Email disabled/);
  // Budget: two rows per request, the rest stays queued for flush.
  const budget = makeKit(); kits.push(budget);
  resend.calls.length = 0;
  const saved = commsModule.LIMITS.rows;
  commsModule.LIMITS.rows = 2;
  try {
    r = await budget.call('POST', '/cycles/cy-fall/mail/send', { body: { requestId: rq(), templateKey: 'rejection', ids: ['in-a', 'in-b', 'in-c'] } });
    assert.equal(r.body.queued, 3); assert.equal(r.body.sent, 2); assert.equal(r.body.remaining, 1);
    assert.equal(budget.mem.mail.filter((m) => m.status === 'queued').length, 1);
    r = await budget.call('POST', '/cycles/cy-fall/mail/flush', { body: { requestId: rq() } });
    assert.equal(r.body.processed, 0, 'freshly queued rows wait for the sender that queued them');
    budget.tick(6000);
    r = await budget.call('POST', '/cycles/cy-fall/mail/flush', { body: { requestId: rq() } });
    assert.equal(r.body.sent, 1); assert.equal(r.body.remaining, 0); assert.equal(resend.calls.length, 3);
    // A row stuck in `sending` for over ten minutes is reclaimed by flush.
    const stuck = budget.mem.mail[0];
    stuck.status = 'sending'; stuck.updated = budget.now() - 11 * 60000;
    r = await budget.call('POST', '/cycles/cy-fall/mail/flush', { body: { requestId: rq() } });
    assert.equal(r.body.processed, 1); assert.equal(stuck.status, 'sent'); assert.equal(stuck.attempt, 2);
    // Manual reconciliation.
    stuck.status = 'failed';
    r = await budget.call('PATCH', `/mail/${stuck.id}`, { body: { status: 'sent' } });
    assert.equal(r.status, 200); assert.equal(stuck.status, 'sent'); assert.match(stuck.reason, /marked sent by lead@cornell\.edu/);
  } finally { commsModule.LIMITS.rows = saved; }
});

test('auto sends: received on application.created, interview_invite on booking.created, decisions only when asked or auto', async () => {
  const kit = makeKit(); kits.push(kit);
  resend.calls.length = 0;
  await kit.emit('application.created', { cycle: kit.mem.cycles[0], application: { id: 'in-a' }, source: 'form' });
  assert.equal(resend.calls.length, 1); assert.equal(bodyOf(resend.calls[0]).to, 'a@cornell.edu');
  assert.equal(kit.mem.mail[0].purposeKey, 'received'); assert.equal(kit.mem.mail[0].createdBy, 'system');
  await kit.emit('application.created', { cycle: 'cy-fall', application: 'in-a', source: 'form' });
  assert.equal(resend.calls.length, 1, 'a replayed intake never re-sends');
  await kit.emit('application.created', { cycle: kit.mem.cycles[0], application: { id: 'in-b' }, source: 'migrated' });
  assert.equal(resend.calls.length, 1, 'imports and migrations stay silent');
  await kit.emit('booking.created', { cycle: kit.mem.cycles[0], booking: { id: 'bk-1', applicationId: 'in-b', round: 'r1' }, application: { id: 'in-b' }, interview: { round: 'First interview', date: 'Monday, October 5', time: '2:00 PM', place: 'Upson 116' }, rsvpUrl: 'https://wiki.test/api/recruit/rsvp/0123456789abcdef0123456789abcdef', purpose: 'interview_invite:bk-1', send: true });
  assert.equal(resend.calls.length, 2);
  const invite = bodyOf(resend.calls[1]);
  assert.match(invite.html, /First interview is on Monday, October 5 at 2:00 PM in Upson 116/);
  assert.match(invite.html, /href="https:\/\/wiki\.test\/api\/recruit\/rsvp\/0123456789abcdef0123456789abcdef"/);
  assert.equal(kit.mem.mail.at(-1).purposeKey, 'interview_invite:bk-1');
  await kit.emit('booking.created', { cycle: kit.mem.cycles[0], booking: { id: 'bk-1', applicationId: 'in-b' }, application: { id: 'in-b' }, purpose: 'interview_invite:bk-1', send: true });
  assert.equal(resend.calls.length, 2, 'one invite per booking');
  await kit.emit('booking.created', { cycle: kit.mem.cycles[0], booking: { id: 'bk-2', applicationId: 'in-c' }, application: { id: 'in-c' }, purpose: 'interview_invite:bk-2', send: false });
  assert.equal(resend.calls.length, 2, 'send:false is honoured');
  await kit.emit('decision.set', { cycle: kit.mem.cycles[0], application: 'in-c', outcome: 'accepted', reason: 'Great work', by: 'lead@cornell.edu' });
  assert.equal(resend.calls.length, 2, 'offer is not automatic by default');
  await kit.emit('decision.set', { cycle: kit.mem.cycles[0], application: 'in-c', outcome: 'accepted', reason: 'Great work', by: 'lead@cornell.edu', send: true });
  assert.equal(resend.calls.length, 3); assert.equal(kit.mem.mail.at(-1).purposeKey, 'offer');
  kit.mem.cycles[0].doc.modules.comms = false;
  await kit.emit('decision.set', { cycle: kit.mem.cycles[0], application: 'in-a', outcome: 'rejected', send: true });
  assert.equal(resend.calls.length, 3, 'a cycle with comms off sends nothing');
  const cols = await comms.collect['csv.columns'](kit.mem.cycles[0], kit);
  assert.equal(cols[0].header, 'Emails sent'); assert.equal(cols[0].cell({ id: 'in-b' }), 1);
  await comms.collect.purge({ cycle: kit.mem.cycles[0], ids: ['in-a'] }, kit);
  assert.equal(kit.mem.mail[0].toEmail, 'erased');
});

test('sendWelcome and sendEmail produce a byte-identical Resend request body', async () => {
  resend.calls.length = 0;
  const args = { to: 'new@cornell.edu', addedByName: 'Lead Person', host: 'wiki.test', settings: SETTINGS, clientId: null, saveOauth: null };
  assert.deepEqual(await sendWelcome(args), { sent: true });
  const legacy = resend.calls[0].body;
  const { html, subject } = JSON.parse(legacy);
  const out = await sendEmail({ to: args.to, subject, html, settings: SETTINGS, clientId: null, saveOauth: null });
  assert.equal(out.sent, true); assert.equal(out.id, 'msg_2');
  assert.equal(resend.calls[1].body, legacy, 'delegating sendWelcome to sendEmail changes nothing on the wire');
  assert.equal(resend.calls[1].headers.authorization, resend.calls[0].headers.authorization);
  assert.deepEqual(await sendEmail({ to: 'x@y.z', subject: 's', html: 'h', settings: {} }), { sent: false, reason: 'no Resend connection yet. An admin can connect one under Integrations → Email' });
});

/* -------------------------------- SQL shapes ------------------------------ */

test('SQL: the mail INSERT precedes any Resend call and the once-only index shape is declared', async () => {
  const statements = [];
  const fetchAt = [];
  const app = { id: 'in-a', cycle_id: 'cy-fall', email: 'a@cornell.edu', name: 'Ada', subteam: '', year: null, stage: 'applied', outcome: null, decision: {}, erased_at: null };
  const row = { id: 'ml-1', cycle_id: 'cy-fall', application_id: 'in-a', template_key: 'received', purpose_key: 'received', to_email: 'a@cornell.edu', subject: '', status: 'queued', attempt: 0, reason: '', batch: 'bt-1', created: '1', updated: '1', sent_at: null, created_by: 'lead@cornell.edu', doc: {} };
  const sql = async (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    statements.push({ text, values, fetches: resend.calls.length });
    const result = (list = []) => ({ rows: structuredClone(list), rowCount: list.length });
    if (text.startsWith('SELECT doc FROM recruit_settings')) return result([{ doc: {} }]);
    if (text.startsWith('SELECT id, cycle_id, email, name, subteam, year, stage, outcome, decision, erased_at FROM recruit_applications')) return result([app]);
    if (text.startsWith('INSERT INTO recruit_mail')) {
      const inserted = JSON.parse(values.find((v) => typeof v === 'string' && v.includes('"purpose"')));
      row.id = inserted[0].id;
      return result(inserted.map((r) => ({ id: r.id, application_id: r.app })));
    }
    if (text.startsWith("UPDATE recruit_mail SET status = 'sending'")) { assert.equal(values[1], row.id); return result([{ ...row, status: 'sending', attempt: 1 }]); }
    if (text.startsWith('UPDATE recruit_mail SET status = ?')) return result();
    if (text.startsWith('SELECT count(*) AS n FROM recruit_mail')) return result([{ n: 0 }]);
    throw new Error('Unexpected synthetic SQL: ' + text);
  };
  const kit = makeKit({ mode: 'postgres', sql }); kits.push(kit);
  resend.calls.length = 0;
  const r = await kit.call('POST', '/cycles/cy-fall/mail/send', { body: { requestId: rq(), templateKey: 'received', ids: ['in-a'] } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.sent, 1, JSON.stringify({ body: r.body, statements: statements.map((x) => x.text.slice(0, 80)) }));
  const ins = statements.find((s) => s.text.startsWith('INSERT INTO recruit_mail'));
  assert.ok(ins, 'one INSERT for the batch'); assert.equal(ins.fetches, 0, 'the log row exists before Resend is called');
  assert.match(ins.text, /FROM jsonb_to_recordset\(\?::jsonb\) AS r\(id text, app text, purpose text, to_email text\) ON CONFLICT DO NOTHING RETURNING id, application_id$/);
  const claim = statements.find((s) => s.text.startsWith("UPDATE recruit_mail SET status = 'sending'"));
  assert.match(claim.text, /attempt = attempt \+ 1, updated = \? WHERE id = \? AND \(status IN \('queued', 'failed'\) OR \(status = 'sending' AND updated < \?\)\) RETURNING \*/);
  assert.equal(claim.fetches, 0, 'claim before send');
  const settle = statements.filter((s) => s.text.startsWith('UPDATE recruit_mail SET status = ?'));
  assert.equal(settle.length, 1); assert.equal(settle[0].fetches, 1, 'settle after send'); assert.equal(settle[0].values[0], 'sent');
  assert.equal(resend.calls.length, 1);
  assert.equal(comms.schema.find((s) => s.startsWith('CREATE UNIQUE INDEX')), "CREATE UNIQUE INDEX IF NOT EXISTS recruit_mail_once ON recruit_mail (application_id, purpose_key) WHERE status IN ('queued', 'sending', 'sent')");
  assert.ok(comms.schema.every((s) => /^CREATE (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS/.test(s)), 'schema is additive only');
});

/* ---------------------------------- client -------------------------------- */

test('client: preview opens through showModal, confirm-send loops flush with a kept request id', async () => {
  const src = await readFile(new URL('../src/client/recruit-comms.js', import.meta.url), 'utf8');
  const ui2 = await readFile(new URL('../src/client/ui2.js', import.meta.url), 'utf8');
  const ddSource = ui2.slice(ui2.indexOf('function dd('), ui2.indexOf('const ddSections'));
  assert.equal((src.match(/RECRUIT\.register\(/g) || []).length, 1); assert.doesNotMatch(src, /<select|<datalist/i);
  assert.ok(src.includes('// recruit:comms:start') && src.includes('// recruit:comms:end'));
  const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const cycle = { id: 'cy-fall', version: 2, status: 'open', name: 'Fall 2026', doc: { modules: {}, comms: { templates: {}, replyTo: '' } } };
  const requests = [], toasts = [], shown = [];
  let background = 0, renders = 0, closed = 0;
  const modules = [];
  const ctx = vm.createContext({
    UI: { recruit: { cycleId: 'cy-fall', cycle: { data: cycle, role: 'lead' }, mod: {}, busy: new Set(), selected: new Set(['in-a', 'in-b', 'in-c']) }, modal: null, menu: null },
    RECRUIT: { modules, register(m) { modules.push(m); }, api(url, options = {}) { return new Promise((resolve, reject) => requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, signal: options.signal, resolve, reject })); } },
    REMOTE: {}, MD: { esc }, I: new Proxy({}, { get: () => '<svg></svg>' }), Store: { userName: (e) => e },
    crypto: { randomUUID }, AbortSignal, document: { activeElement: null },
    $: (sel, root) => (root ? root.q?.(sel) ?? null : null), $$: (sel, root) => root?.qa?.(sel) ?? [],
    render() { renders += 1; }, renderBackground(name) { assert.equal(name, 'recruit'); background += 1; },
    toast: (t) => toasts.push(t), openMenu: () => {}, closeModal(after) { closed += 1; ctx.UI.modal = null; after?.(); },
    showModal(m) { shown.push(m); ctx.UI.modal = m; }, focusReference: () => null, resolveFocus: () => null,
    recruitDate: (ts) => new Date(ts).toISOString().slice(0, 10),
  });
  vm.runInContext(ddSource + src, ctx);
  const mod = modules[0];
  assert.equal(mod.name, 'comms'); assert.equal(mod.panel.when(cycle, 'lead'), true); assert.equal(mod.panel.when(cycle, 'reviewer'), false);
  mod.mount(cycle);
  assert.equal(requests.length, 2); assert.ok(requests.every((r) => r.signal instanceof AbortSignal));
  requests[0].resolve({ templates: [{ key: 'received', subject: 'We got it <b>', body: 'Hi {{firstName}}', auto: true, inherited: true }, { key: 'offer', subject: 'Welcome', body: 'x', auto: false, inherited: false, by: 'lead@cornell.edu', updatedAt: 1 }], fields: ['name', 'firstName'] });
  requests[1].resolve({ rows: [{ id: 'ml-1', toEmail: 'a@cornell.edu', templateKey: 'offer', status: 'failed', reason: 'Resend 500', created: 1 }], next: null, counts: { failed: 1 } });
  await new Promise((r) => setImmediate(r));
  assert.equal(background, 1); assert.equal(renders, 0);
  const html = mod.view(cycle, 'lead');
  assert.match(html, /We got it &lt;b&gt;/); assert.match(html, /data-action="recruit-cm-retry" data-id="ml-1"/); assert.match(html, /1 failed/); assert.doesNotMatch(html, /<select/i);

  // Template editor and preview.
  ctx.UI.modal = { kind: 'recruit-template', key: 'received' };
  const editor = mod.modals['recruit-template'](ctx.UI.modal);
  assert.match(editor, /data-action="recruit-cm-template-form"/); assert.match(editor, /\{\{firstName\}\}/); assert.match(editor, /sandbox|Preview/);
  const fields = { 'recruit-cm-subject': { value: 'Hi {{firstName}} <b>' }, 'recruit-cm-body': { value: 'Body {{name}}' }, 'recruit-cm-auto': { checked: true } };
  const error = { textContent: '', hidden: true };
  const form = { tagName: 'FORM', dataset: { action: 'recruit-cm-template-form', key: 'received' }, q: (sel) => (sel === '[data-cm-error]' ? error : fields[/\[data-m="([^"]+)"\]/.exec(sel)?.[1]] || null), qa: () => [] };
  const opener = ctx.UI.modal;
  const previewing = mod.actions['recruit-cm-preview']({ closest: () => form }, null, () => {});
  const p = requests[2];
  assert.equal(p.url, '/recruit/cycles/cy-fall/mail/preview'); assert.equal(p.method, 'POST'); assert.ok(p.signal instanceof AbortSignal);
  assert.deepEqual(p.body, { template: { subject: 'Hi {{firstName}} <b>', body: 'Body {{name}}', auto: true } });
  p.resolve({ subject: 'Hi Sample <b>', html: '<p>Body Sample "Applicant"</p>', text: 'Body', warnings: [] });
  await previewing;
  assert.equal(shown.length, 1); assert.equal(ctx.UI.modal.kind, 'recruit-mail-preview'); assert.equal(ctx.UI.modal.back, opener); assert.equal(renders, 0, 'the preview opens without a direct render()');
  const previewHtml = mod.modals['recruit-mail-preview'](ctx.UI.modal);
  assert.match(previewHtml, /<iframe sandbox="" srcdoc="&lt;p&gt;Body Sample &quot;Applicant&quot;&lt;\/p&gt;"/);
  assert.match(previewHtml, /Hi Sample &lt;b&gt;/);
  mod.actions['recruit-cm-preview-back'](null, null, () => {});
  assert.equal(ctx.UI.modal, opener);
  const baseRenders = renders;

  // Compose from a selection: guard line, then a send that loops flush.
  ctx.UI.modal = null;
  const act = mod.selectionActions(new Set(['in-a', 'in-b', 'in-c']), cycle, 'lead')[0];
  assert.equal(act.label, 'Email…'); assert.equal(mod.selectionActions(new Set(), cycle, 'reviewer').length, 0);
  act.run();
  const m = ctx.UI.modal;
  assert.equal(m.kind, 'recruit-send'); assert.equal(renders, baseRenders + 1, 'opening the dialog is a user action');
  const guard = requests[3];
  assert.equal(guard.url, '/recruit/cycles/cy-fall/mail/send'); assert.equal(guard.body.dryRun, true); assert.deepEqual(guard.body.ids, ['in-a', 'in-b', 'in-c']); assert.match(guard.body.requestId, /^rq-/);
  guard.resolve({ will: 2, already: 1, purpose: 'received' });
  await new Promise((r) => setImmediate(r));
  assert.equal(JSON.stringify(m.guard), JSON.stringify({ will: 2, already: 1 }));
  const sendHtml = mod.modals['recruit-send'](m);
  assert.match(sendHtml, /2 of 3 will be sent · 1 already received “Application received”/); assert.match(sendHtml, /data-m="recruit-cm-again"/); assert.doesNotMatch(sendHtml, /<select/i);
  assert.match(sendHtml, /data-m="recruit-cm-template"/);
  const sfields = { 'recruit-cm-template': { dataset: { value: 'received' } }, 'recruit-cm-again': { checked: false } };
  const submit = { disabled: false, textContent: 'Send' };
  const sform = { tagName: 'FORM', dataset: { action: 'recruit-cm-send-form', ids: JSON.stringify(['in-a', 'in-b', 'in-c']) }, q: (sel) => (sel === '[data-cm-error]' ? error : sel === '[type="submit"]' ? submit : sfields[/\[data-m="([^"]+)"\]/.exec(sel)?.[1]] || null), qa: () => [] };
  let sending = mod.actions['recruit-cm-send-form'](sform);
  await mod.actions['recruit-cm-send-form'](sform);
  assert.equal(requests.length, 5, 'a second submit while sending is ignored');
  const send = requests[4];
  assert.equal(send.url, '/recruit/cycles/cy-fall/mail/send'); assert.equal(send.body.templateKey, 'received'); assert.equal(send.body.dryRun, undefined); assert.equal(send.body.again, undefined);
  assert.equal(send.body.requestId, guard.body.requestId, 'the dialog keeps one request id from the guard through the send');
  assert.ok(send.signal instanceof AbortSignal); assert.equal(submit.disabled, true);
  send.reject(Object.assign(new Error('Timed out'), { name: 'TimeoutError' }));
  await sending;
  assert.match(error.textContent, /Retrying will not send twice/); assert.equal(ctx.UI.modal, m); assert.equal(submit.disabled, false);
  sending = mod.actions['recruit-cm-send-form'](sform);
  assert.equal(requests[5].body.requestId, send.body.requestId, 'the retry reuses the request id');
  requests[5].resolve({ batch: 'bt-1', queued: 2, sent: 1, failed: 0, skipped: [{ id: 'in-c', reason: 'already sent' }], remaining: 1 });
  await new Promise((r) => setImmediate(r));
  const flush = requests[6];
  assert.equal(flush.url, '/recruit/cycles/cy-fall/mail/flush'); assert.match(flush.body.requestId, /^rq-/); assert.ok(flush.signal instanceof AbortSignal);
  flush.resolve({ processed: 1, sent: 1, failed: 0, skipped: 0, remaining: 0 });
  await sending;
  assert.equal(closed, 1); assert.equal(ctx.UI.modal, null); assert.equal(toasts.at(-1), '2 emails sent · 1 skipped'); assert.equal(renders, baseRenders + 1, 'no render() from the send completion');
  // Retry from the log repaints in place.
  const retry = mod.actions['recruit-cm-retry']({ dataset: { id: 'ml-1' } }, null, () => {});
  assert.equal(requests.at(-1).url, '/recruit/mail/ml-1/retry');
  requests.at(-1).resolve({ row: { id: 'ml-1', toEmail: 'a@cornell.edu', templateKey: 'offer', status: 'sent', created: 1 } });
  await retry;
  assert.equal(toasts.at(-1), 'Sent'); assert.equal(renders, baseRenders + 1);
  assert.equal(mod.detailSections({ mail: [{ templateKey: 'offer', status: 'sent', sentAt: 1 }] }, cycle, 'lead')[0].title, 'Emails sent');
  assert.equal(mod.detailSections({ mail: [] }, cycle, 'reviewer').length, 0);
  assert.match(mod.settings.view(cycle), /data-action="recruit-settings-comms"/);
});
