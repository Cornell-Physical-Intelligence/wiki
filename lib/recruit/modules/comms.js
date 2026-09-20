// Comms module: templates in the cycle doc, one send log table, and a guarded
// batch sender. Sending is two phases in one request: a single INSERT that
// the once-only index filters (nobody receives the same lifecycle email
// twice), then a claim-render-send loop with a time budget. Rows the loop
// does not reach stay `queued` and are picked up by /flush. Failures are
// logged on the row, never thrown. The module never imports a sibling; the
// booking and decision modules reach it through events.

import { renderTemplate, purposeKeyFor, mergeFor, missingFields, unknownFields, DEFAULT_TEMPLATES, TEMPLATE_KEY, SUBJECT_MAX, BODY_MAX, MERGE_FIELDS, SAMPLE_MERGE } from '../mailer.js';

export const LIMITS = { rows: 100, ms: 40000, ids: 500, queuedAge: 5000, staleSending: 600000 };
const STATUSES = new Set(['queued', 'sending', 'sent', 'failed', 'skipped']);
const REQUEST_ID = /^rq-[a-z0-9-]{8,80}$/;
const OUTCOME_TEMPLATE = { accepted: 'offer', rejected: 'rejection', waitlisted: 'waitlist' };

/* ------------------------------- mappers ---------------------------------- */

const num = (v) => (v === null || v === undefined ? null : Number(v));
const obj = (v) => (typeof v === 'string' ? JSON.parse(v) : v || {});

function mailFromPg(r) {
  return {
    id: r.id, cycleId: r.cycle_id, applicationId: r.application_id, templateKey: r.template_key, purposeKey: r.purpose_key,
    toEmail: r.to_email, subject: r.subject, status: r.status, attempt: Number(r.attempt || 0), reason: r.reason || '', batch: r.batch || '',
    created: num(r.created), updated: num(r.updated), sentAt: num(r.sent_at), createdBy: r.created_by || '', doc: obj(r.doc),
  };
}

// Applications are read here, never written. Memory rows may arrive in
// either casing depending on who wrote them.
function normApp(r) {
  if (!r) return null;
  return {
    id: r.id, cycleId: r.cycleId ?? r.cycle_id, email: r.email, name: r.name, subteam: r.subteam ?? '', year: r.year ?? null,
    stage: r.stage, outcome: r.outcome ?? null, decision: obj(r.decision), erasedAt: num(r.erasedAt ?? r.erased_at),
  };
}

function settingsDoc(kit) {
  const s = kit.mem?.settings;
  return (s && (s.doc || s)) || {};
}

async function readSettingsDoc(kit) {
  if (kit.mode === 'memory') return settingsDoc(kit);
  const s = await kit.sql();
  const out = await s`SELECT doc FROM recruit_settings WHERE id = 1`;
  return obj(out.rows[0]?.doc);
}

const mailRow = (kit, id) => (kit.mem.mail ||= []).find((m) => m.id === id) || null;
const memApp = (kit, id) => normApp((kit.mem.applications || []).find((a) => a.id === id));

async function appsById(kit, cycleId, ids) {
  if (!ids.length) return new Map();
  if (kit.mode === 'memory') {
    return new Map((kit.mem.applications || []).filter((a) => ids.includes(a.id) && (a.cycleId ?? a.cycle_id) === cycleId).map((a) => [a.id, normApp(a)]));
  }
  const s = await kit.sql();
  const out = await s`SELECT id, cycle_id, email, name, subteam, year, stage, outcome, decision, erased_at FROM recruit_applications WHERE cycle_id = ${cycleId} AND id = ANY(${ids})`;
  return new Map(out.rows.map((r) => [r.id, normApp(r)]));
}

async function getApp(kit, id) {
  if (kit.mode === 'memory') return memApp(kit, id);
  const s = await kit.sql();
  const out = await s`SELECT id, cycle_id, email, name, subteam, year, stage, outcome, decision, erased_at FROM recruit_applications WHERE id = ${id}`;
  return normApp(out.rows[0]);
}

async function resolveCycle(kit, cycle) {
  if (!cycle) return null;
  if (typeof cycle === 'string') return kit.cycles.get(cycle);
  return cycle;
}

/* ------------------------------- templates -------------------------------- */

async function templatesFor(kit, cycle) {
  const settings = await readSettingsDoc(kit);
  const defaults = { ...DEFAULT_TEMPLATES, ...(settings.defaults?.templates || {}) };
  const own = cycle?.doc?.comms?.templates || {};
  const keys = [...new Set([...Object.keys(defaults), ...Object.keys(own)])].filter((k) => TEMPLATE_KEY.test(k));
  return keys.map((key) => {
    const src = own[key] || defaults[key];
    return { key, subject: String(src.subject || ''), body: String(src.body || ''), auto: src.auto === true, updatedAt: num(src.updatedAt), by: src.by || '', inherited: !own[key] };
  });
}

async function templateFor(kit, cycle, key) {
  return (await templatesFor(kit, cycle)).find((t) => t.key === key) || null;
}

function validateTemplate(t) {
  const subject = String(t?.subject ?? '').trim();
  const body = String(t?.body ?? '').replace(/\r\n?/g, '\n');
  if (!subject) throw { status: 400, error: 'Give the email a subject' };
  if (subject.length > SUBJECT_MAX) throw { status: 400, error: `Subjects are capped at ${SUBJECT_MAX} characters` };
  if (!body.trim()) throw { status: 400, error: 'Write the email body' };
  if (body.length > BODY_MAX) throw { status: 400, error: `Bodies are capped at ${BODY_MAX} characters` };
  const unknown = unknownFields(subject, body);
  if (unknown.length) throw { status: 400, error: `Unknown field {{${unknown[0]}}}` };
  return { subject, body, auto: t?.auto === true };
}

function validateSettings(next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) throw { status: 400, error: 'Comms settings must be an object' };
  const replyTo = String(next.replyTo ?? '').trim().toLowerCase().slice(0, 200);
  if (replyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(replyTo)) throw { status: 400, error: 'Reply-to must be an email address' };
  const templates = next.templates && typeof next.templates === 'object' ? next.templates : {};
  for (const [key, t] of Object.entries(templates)) {
    if (!TEMPLATE_KEY.test(key)) throw { status: 400, error: `Unknown template ${key}` };
    validateTemplate(t);
  }
}

/* --------------------------------- log ------------------------------------ */

const emptyResult = () => ({ queued: [], skipped: [] });

// Phase A: one INSERT for the batch. The partial unique index on
// (application_id, purpose_key) turns every second send into a no-op, so a
// retried request or an overlapping batch cannot double-mail anyone.
async function enqueue(kit, { cycle, ids, templateKey, subject, purposeFor, batch, by, context = {} }) {
  const apps = await appsById(kit, cycle.id, ids);
  const result = emptyResult();
  const rows = [];
  for (const id of ids) {
    const a = apps.get(id);
    if (!a) { result.skipped.push({ id, reason: 'not in this cycle' }); continue; }
    if (a.erasedAt || !a.email || a.email.startsWith('erased:')) { result.skipped.push({ id, reason: 'erased' }); continue; }
    rows.push({ id: kit.id('ml'), app: id, purpose: purposeFor(a), to: a.email });
  }
  if (!rows.length) return result;
  const now = kit.now();
  const doc = { merge: context };
  if (kit.mode === 'memory') {
    const mail = (kit.mem.mail ||= []);
    for (const r of rows) {
      const dup = mail.some((m) => m.applicationId === r.app && m.purposeKey === r.purpose && ['queued', 'sending', 'sent'].includes(m.status));
      if (dup) { result.skipped.push({ id: r.app, reason: 'already sent' }); continue; }
      mail.push({ id: r.id, cycleId: cycle.id, applicationId: r.app, templateKey, purposeKey: r.purpose, toEmail: r.to, subject, status: 'queued', attempt: 0, reason: '', batch, created: now, updated: now, sentAt: null, createdBy: by, doc: { merge: { ...context } } });
      result.queued.push(r.id);
    }
    await kit.memSave();
    return result;
  }
  const s = await kit.sql();
  const out = await s`INSERT INTO recruit_mail (id, cycle_id, application_id, template_key, purpose_key, to_email, subject, status, attempt, reason, batch, created, updated, created_by, doc)
    SELECT r.id, ${cycle.id}, r.app, ${templateKey}, r.purpose, r.to_email, ${subject}, 'queued', 0, '', ${batch}, ${now}, ${now}, ${by}, ${JSON.stringify(doc)}::jsonb
    FROM jsonb_to_recordset(${JSON.stringify(rows.map((r) => ({ id: r.id, app: r.app, purpose: r.purpose, to_email: r.to })))}::jsonb) AS r(id text, app text, purpose text, to_email text)
    ON CONFLICT DO NOTHING RETURNING id, application_id`;
  const inserted = new Set(out.rows.map((r) => r.id));
  for (const r of rows) {
    if (inserted.has(r.id)) result.queued.push(r.id);
    else result.skipped.push({ id: r.app, reason: 'already sent' });
  }
  return result;
}

async function claim(kit, id, now) {
  if (kit.mode === 'memory') {
    const m = mailRow(kit, id);
    if (!m) return null;
    const stale = m.status === 'sending' && m.updated < now - LIMITS.staleSending;
    if (!(['queued', 'failed'].includes(m.status) || stale)) return null;
    m.status = 'sending'; m.attempt += 1; m.updated = now;
    await kit.memSave();
    return { ...m };
  }
  const s = await kit.sql();
  const out = await s`UPDATE recruit_mail SET status = 'sending', attempt = attempt + 1, updated = ${now}
    WHERE id = ${id} AND (status IN ('queued', 'failed') OR (status = 'sending' AND updated < ${now - LIMITS.staleSending})) RETURNING *`;
  return out.rows[0] ? mailFromPg(out.rows[0]) : null;
}

async function settle(kit, id, { status, reason = '', sentAt = null, subject }) {
  const now = kit.now();
  if (kit.mode === 'memory') {
    const m = mailRow(kit, id);
    if (!m) return;
    Object.assign(m, { status, reason: String(reason).slice(0, 300), updated: now, sentAt: sentAt ?? m.sentAt, subject: subject ?? m.subject });
    await kit.memSave();
    return;
  }
  const s = await kit.sql();
  await s`UPDATE recruit_mail SET status = ${status}, reason = ${String(reason).slice(0, 300)}, updated = ${now}, sent_at = COALESCE(${sentAt}, sent_at), subject = COALESCE(${subject ?? null}, subject) WHERE id = ${id}`;
}

async function emailSettings(kit) {
  try { return await kit.email.settings?.(); } catch (e) { return { __error: e.message }; }
}

// Phase B: claim, render, send, settle. The application and the template are
// read at send time, so a rename before the flush still lands correctly.
async function deliver(kit, cycle, ids, { budgetMs = LIMITS.ms, max = LIMITS.rows, sender } = {}) {
  const started = Date.now();
  const tally = { sent: 0, failed: 0, skipped: 0, processed: 0 };
  const templates = await templatesFor(kit, cycle);
  const settings = await emailSettings(kit);
  const replyTo = cycle.doc?.comms?.replyTo || '';
  for (const id of ids) {
    if (tally.processed >= max || Date.now() - started > budgetMs) break;
    const row = await claim(kit, id, kit.now());
    if (!row) continue;
    tally.processed += 1;
    const app = await getApp(kit, row.applicationId);
    if (!app || app.erasedAt || row.toEmail === 'erased') { await settle(kit, row.id, { status: 'skipped', reason: 'erased' }); tally.skipped += 1; continue; }
    const tpl = row.templateKey === 'custom' ? row.doc?.template : templates.find((t) => t.key === row.templateKey);
    if (!tpl) { await settle(kit, row.id, { status: 'failed', reason: 'template missing' }); tally.failed += 1; continue; }
    const merge = mergeFor({ application: app, cycle, sender: sender || { name: row.createdBy, email: row.createdBy }, extra: row.doc?.merge || {} });
    if (missingFields(tpl, merge).length) { await settle(kit, row.id, { status: 'skipped', reason: 'missing fields' }); tally.skipped += 1; continue; }
    const rendered = renderTemplate(tpl, merge);
    if (settings?.__error) { await settle(kit, row.id, { status: 'failed', reason: settings.__error, subject: rendered.subject }); tally.failed += 1; continue; }
    let out;
    try {
      out = await kit.email.send({ to: app.email, subject: rendered.subject, html: rendered.html, text: rendered.text, replyTo, settings, clientId: kit.email.clientId, saveOauth: kit.email.saveOauth });
    } catch (e) { out = { sent: false, reason: e.message }; }
    if (out?.sent) { await settle(kit, row.id, { status: 'sent', sentAt: kit.now(), subject: rendered.subject }); tally.sent += 1; }
    else { await settle(kit, row.id, { status: 'failed', reason: out?.reason || 'send failed', subject: rendered.subject }); tally.failed += 1; }
  }
  return tally;
}

async function queuedIds(kit, cycleId, { batch = null, minAge = 0, includeStale = false, limit = LIMITS.rows } = {}) {
  const now = kit.now();
  if (kit.mode === 'memory') {
    return (kit.mem.mail || []).filter((m) => m.cycleId === cycleId && (batch === null || m.batch === batch)
      && ((m.status === 'queued' && m.created <= now - minAge) || (includeStale && m.status === 'sending' && m.updated < now - LIMITS.staleSending)))
      .sort((a, b) => a.created - b.created).slice(0, limit).map((m) => m.id);
  }
  const s = await kit.sql();
  const out = await s`SELECT id FROM recruit_mail WHERE cycle_id = ${cycleId} AND (${batch}::text IS NULL OR batch = ${batch})
    AND ((status = 'queued' AND created <= ${now - minAge}) OR (${includeStale} AND status = 'sending' AND updated < ${now - LIMITS.staleSending}))
    ORDER BY created LIMIT ${limit}`;
  return out.rows.map((r) => r.id);
}

async function queuedCount(kit, cycleId, batch = null) {
  if (kit.mode === 'memory') return (kit.mem.mail || []).filter((m) => m.cycleId === cycleId && m.status === 'queued' && (batch === null || m.batch === batch)).length;
  const s = await kit.sql();
  const out = await s`SELECT count(*) AS n FROM recruit_mail WHERE cycle_id = ${cycleId} AND status = 'queued' AND (${batch}::text IS NULL OR batch = ${batch})`;
  return Number(out.rows[0]?.n || 0);
}

async function alreadySent(kit, cycleId, ids, purpose) {
  if (kit.mode === 'memory') {
    return new Set((kit.mem.mail || []).filter((m) => m.cycleId === cycleId && ids.includes(m.applicationId) && m.purposeKey === purpose && ['queued', 'sending', 'sent'].includes(m.status)).map((m) => m.applicationId));
  }
  const s = await kit.sql();
  const out = await s`SELECT application_id FROM recruit_mail WHERE cycle_id = ${cycleId} AND application_id = ANY(${ids}) AND purpose_key = ${purpose} AND status IN ('queued', 'sending', 'sent')`;
  return new Set(out.rows.map((r) => r.application_id));
}

async function getMail(kit, id) {
  if (kit.mode === 'memory') { const m = mailRow(kit, id); return m ? { ...m } : null; }
  const s = await kit.sql();
  const out = await s`SELECT * FROM recruit_mail WHERE id = ${id}`;
  return out.rows[0] ? mailFromPg(out.rows[0]) : null;
}

// Routes without :cycle resolve the role themselves from the mail row.
async function leadFor(kit, rq, cycleId) {
  if (rq.role === 'admin') return 'admin';
  const grant = await kit.roles.grantFor(cycleId, rq.me.email);
  const role = kit.roles.roleOf(rq.me, grant);
  if (role !== 'admin' && role !== 'lead') throw { status: 403, error: role ? 'Not allowed in this cycle' : 'Admins only' };
  return role;
}

// One lifecycle email to one applicant, fired by an event after the durable
// write. Best effort: a failure is a log row, never an error for the caller.
async function autoSend(kit, { cycle, applicationId, templateKey, purpose, context, explicit }) {
  cycle = await resolveCycle(kit, cycle);
  if (!cycle || cycle.doc?.modules?.comms === false) return null;
  const tpl = await templateFor(kit, cycle, templateKey);
  if (!tpl) return null;
  if (!tpl.auto && explicit !== true) return null;
  const batch = kit.id('bt');
  const queued = await enqueue(kit, { cycle, ids: [applicationId], templateKey, subject: tpl.subject, purposeFor: () => purpose, batch, by: 'system', context });
  if (!queued.queued.length) return { sent: 0, skipped: queued.skipped };
  const tally = await deliver(kit, cycle, queued.queued, { sender: { name: 'The team' } });
  for (const id of queued.queued) await kit.audit({ cycleId: cycle.id, applicationId, actor: 'system', kind: 'mail', detail: { mailId: id, templateKey, purpose, auto: true } });
  return tally;
}

/* -------------------------------- routes ---------------------------------- */

const jsonRoute = (status, body) => ({ status, body });

async function listMail(kit, cycleId, q) {
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 100));
  const [cursorTs, cursorId] = String(q.cursor || '').split('|');
  const application = q.application || null, status = STATUSES.has(q.status) ? q.status : null, template = q.template || null;
  let rows;
  if (kit.mode === 'memory') {
    rows = (kit.mem.mail || []).filter((m) => m.cycleId === cycleId && (!application || m.applicationId === application) && (!status || m.status === status) && (!template || m.templateKey === template)
      && (!cursorTs || m.created < Number(cursorTs) || (m.created === Number(cursorTs) && m.id < cursorId)))
      .sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1)).slice(0, limit + 1).map((m) => ({ ...m }));
  } else {
    const s = await kit.sql();
    const out = await s`SELECT * FROM recruit_mail WHERE cycle_id = ${cycleId}
      AND (${application}::text IS NULL OR application_id = ${application}) AND (${status}::text IS NULL OR status = ${status}) AND (${template}::text IS NULL OR template_key = ${template})
      AND (${cursorTs || null}::bigint IS NULL OR created < ${Number(cursorTs) || 0} OR (created = ${Number(cursorTs) || 0} AND id < ${cursorId || ''}))
      ORDER BY created DESC, id DESC LIMIT ${limit + 1}`;
    rows = out.rows.map(mailFromPg);
  }
  const next = rows.length > limit ? `${rows[limit - 1].created}|${rows[limit - 1].id}` : null;
  rows = rows.slice(0, limit).map((m) => ({ ...m, doc: undefined }));
  let counts;
  if (kit.mode === 'memory') {
    counts = {};
    for (const m of kit.mem.mail || []) if (m.cycleId === cycleId) counts[m.status] = (counts[m.status] || 0) + 1;
  } else {
    const s = await kit.sql();
    const out = await s`SELECT status, count(*) AS n FROM recruit_mail WHERE cycle_id = ${cycleId} GROUP BY status`;
    counts = Object.fromEntries(out.rows.map((r) => [r.status, Number(r.n)]));
  }
  return { rows, next, counts };
}

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
};

export default {
  name: 'comms',
  kernel: false,
  order: 70,
  schema: [
    `CREATE TABLE IF NOT EXISTS recruit_mail (id text PRIMARY KEY, cycle_id text NOT NULL, application_id text, template_key text NOT NULL, purpose_key text NOT NULL, to_email text NOT NULL, subject text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'queued', attempt int NOT NULL DEFAULT 0, reason text NOT NULL DEFAULT '', batch text NOT NULL DEFAULT '', created bigint, updated bigint, sent_at bigint, created_by text, doc jsonb NOT NULL DEFAULT '{}')`,
    `CREATE UNIQUE INDEX IF NOT EXISTS recruit_mail_once ON recruit_mail (application_id, purpose_key) WHERE status IN ('queued', 'sending', 'sent')`,
    `CREATE INDEX IF NOT EXISTS recruit_mail_cycle ON recruit_mail (cycle_id, created DESC)`,
  ],
  memory: { mail: [] },
  defaults: () => ({ templates: {}, replyTo: '' }),
  validateSettings,
  auditKinds: ['mail', 'cycle.settings.comms'],

  routes: [
    { method: 'GET', path: '/cycles/:cycle/templates', access: 'lead', async handler(rq, kit) {
      return jsonRoute(200, { templates: await templatesFor(kit, rq.cycle), fields: MERGE_FIELDS });
    } },

    { method: 'PUT', path: '/cycles/:cycle/templates/:key', access: 'lead', mutates: true, cap: 262144, async handler(rq, kit) {
      const key = rq.params.key;
      if (!TEMPLATE_KEY.test(key)) return jsonRoute(400, { error: 'Unknown template' });
      const body = await rq.body();
      const version = Number(body?.version);
      if (!Number.isFinite(version)) return jsonRoute(400, { error: 'Missing version' });
      const t = validateTemplate(body);
      const next = { ...t, updatedAt: kit.now(), by: rq.me.email };
      let cycle;
      if (kit.mode === 'memory') {
        const c = (kit.mem.cycles || []).find((x) => x.id === rq.cycle.id);
        if (!c || Number(c.version) !== version) return jsonRoute(409, { error: 'This cycle changed. Reload.', version: c?.version });
        c.doc = c.doc || {}; c.doc.comms = c.doc.comms || {}; c.doc.comms.templates = c.doc.comms.templates || {};
        c.doc.comms.templates[key] = next;
        c.version = version + 1; c.updated = kit.now(); c.updatedBy = rq.me.email;
        await kit.memSave();
        cycle = { ...c };
      } else {
        const s = await kit.sql();
        const out = await s`UPDATE recruit_cycles SET doc = doc || jsonb_build_object('comms', COALESCE(doc->'comms', '{}'::jsonb) || jsonb_build_object('templates', COALESCE(doc->'comms'->'templates', '{}'::jsonb) || jsonb_build_object(${key}::text, ${JSON.stringify(next)}::jsonb))),
          version = version + 1, updated = ${kit.now()}, updated_by = ${rq.me.email} WHERE id = ${rq.cycle.id} AND version = ${version} RETURNING *`;
        if (!out.rows[0]) {
          const cur = await kit.cycles.get(rq.cycle.id);
          return jsonRoute(409, { error: 'This cycle changed. Reload.', version: cur?.version });
        }
        cycle = (await kit.cycles.get(rq.cycle.id)) || out.rows[0];
      }
      return { status: 200, body: { cycle }, audit: { kind: 'cycle.settings.comms', detail: { template: key } } };
    } },

    { method: 'POST', path: '/cycles/:cycle/mail/preview', access: 'lead', cap: 262144, async handler(rq, kit) {
      const body = await rq.body();
      let tpl;
      if (body?.templateKey) {
        tpl = await templateFor(kit, rq.cycle, String(body.templateKey));
        if (!tpl) return jsonRoute(404, { error: 'No such template' });
      } else tpl = validateTemplate(body?.template || body?.custom);
      let merge = SAMPLE_MERGE;
      if (body?.applicationId) {
        const app = await getApp(kit, String(body.applicationId));
        if (!app || app.cycleId !== rq.cycle.id) return jsonRoute(404, { error: 'No such application' });
        merge = mergeFor({ application: app, cycle: rq.cycle, sender: rq.me, extra: { ...SAMPLE_MERGE, ...(body.extra || {}) } });
        for (const k of ['interview.round', 'interview.date', 'interview.time', 'interview.place', 'rsvpUrl']) if (!merge[k]) merge[k] = SAMPLE_MERGE[k];
        if (!merge['decision.reason']) merge['decision.reason'] = SAMPLE_MERGE['decision.reason'];
      }
      return jsonRoute(200, renderTemplate(tpl, merge));
    } },

    { method: 'POST', path: '/cycles/:cycle/mail/send', access: 'lead', mutates: true, cap: 262144, async handler(rq, kit) {
      const body = await rq.body();
      const requestId = String(body?.requestId || '');
      if (!REQUEST_ID.test(requestId)) return jsonRoute(400, { error: 'Missing requestId' });
      const ids = [...new Set((Array.isArray(body?.ids) ? body.ids : []).map(String).filter((id) => /^in-[a-z0-9]+$/.test(id)))];
      if (!ids.length) return jsonRoute(400, { error: 'Pick at least one person' });
      if (ids.length > LIMITS.ids) return jsonRoute(400, { error: `Send to at most ${LIMITS.ids} people at once` });
      let templateKey, tpl, doc = {};
      if (body.templateKey) {
        templateKey = String(body.templateKey);
        tpl = await templateFor(kit, rq.cycle, templateKey);
        if (!tpl) return jsonRoute(404, { error: 'No such template' });
      } else if (body.custom) {
        templateKey = 'custom';
        tpl = validateTemplate(body.custom);
        doc = { template: tpl };
      } else return jsonRoute(400, { error: 'Pick a template or write a custom email' });
      const again = body.again === true;
      const explicitPurpose = body.purpose ? String(body.purpose).slice(0, 120) : '';
      if (explicitPurpose && !/^[a-z0-9_:.-]+$/i.test(explicitPurpose)) return jsonRoute(400, { error: 'Bad purpose key' });
      const basePurpose = purposeKeyFor(templateKey, { requestId, purpose: explicitPurpose });
      if (body.dryRun === true) {
        const done = await alreadySent(kit, rq.cycle.id, ids, basePurpose);
        return jsonRoute(200, { will: ids.length - done.size, already: done.size, purpose: basePurpose });
      }
      const out = await kit.once(requestId, rq.me.email, async () => {
        const batch = kit.id('bt');
        const purpose = again ? `${basePurpose}:again-${batch}` : basePurpose;
        const queued = await enqueue(kit, { cycle: rq.cycle, ids, templateKey, subject: tpl.subject, purposeFor: () => purpose, batch, by: rq.me.email });
        // The custom template rides in doc for later flushes.
        if (doc.template) await stampTemplate(kit, queued.queued, doc.template);
        const tally = await deliver(kit, rq.cycle, queued.queued, { sender: rq.me });
        const remaining = await queuedCount(kit, rq.cycle.id, batch);
        await kit.audit({ cycleId: rq.cycle.id, actor: rq.me.email, kind: 'mail', detail: { batch, templateKey, purpose, queued: queued.queued.length, sent: tally.sent, failed: tally.failed, skipped: queued.skipped.length + tally.skipped, requestId } });
        return { batch, queued: queued.queued.length, sent: tally.sent, failed: tally.failed, skipped: queued.skipped, remaining };
      });
      return jsonRoute(200, out);
    } },

    { method: 'POST', path: '/cycles/:cycle/mail/flush', access: 'lead', mutates: true, cap: 65536, async handler(rq, kit) {
      const ids = await queuedIds(kit, rq.cycle.id, { minAge: LIMITS.queuedAge, includeStale: true });
      const tally = await deliver(kit, rq.cycle, ids, { sender: rq.me });
      const remaining = await queuedCount(kit, rq.cycle.id);
      return jsonRoute(200, { processed: tally.processed, sent: tally.sent, failed: tally.failed, skipped: tally.skipped, remaining });
    } },

    { method: 'POST', path: '/mail/:mail/retry', access: 'member', cap: 65536, async handler(rq, kit) {
      const row = await getMail(kit, rq.params.mail);
      if (!row) return jsonRoute(404, { error: 'No such email' });
      await leadFor(kit, rq, row.cycleId);
      const cycle = await kit.cycles.get(row.cycleId);
      if (!cycle) return jsonRoute(404, { error: 'No such cycle' });
      if (cycle.status === 'archived') return jsonRoute(409, { error: 'This cycle is archived' });
      const stale = row.status === 'sending' && row.updated < kit.now() - LIMITS.staleSending;
      if (row.status !== 'failed' && !stale) return jsonRoute(409, { error: 'Only failed emails can be retried', row });
      const tally = await deliver(kit, cycle, [row.id], { sender: rq.me });
      const after = await getMail(kit, row.id);
      return { status: 200, body: { row: { ...after, doc: undefined }, ...tally }, audit: { kind: 'mail', cycleId: row.cycleId, target: row.applicationId, detail: { mailId: row.id, retry: true } } };
    } },

    { method: 'PATCH', path: '/mail/:mail', access: 'member', cap: 65536, async handler(rq, kit) {
      const row = await getMail(kit, rq.params.mail);
      if (!row) return jsonRoute(404, { error: 'No such email' });
      await leadFor(kit, rq, row.cycleId);
      const body = await rq.body();
      if (body?.status !== 'sent') return jsonRoute(400, { error: 'Only "sent" can be set by hand' });
      if (row.status === 'sent') return jsonRoute(200, { row: { ...row, doc: undefined } });
      const now = kit.now();
      if (kit.mode === 'memory') {
        const m = mailRow(kit, row.id);
        Object.assign(m, { status: 'sent', reason: `marked sent by ${rq.me.email}`, updated: now, sentAt: m.sentAt || now });
        await kit.memSave();
      } else {
        const s = await kit.sql();
        await s`UPDATE recruit_mail SET status = 'sent', reason = ${`marked sent by ${rq.me.email}`}, updated = ${now}, sent_at = COALESCE(sent_at, ${now}) WHERE id = ${row.id} AND status <> 'sent'`;
      }
      const after = await getMail(kit, row.id);
      return { status: 200, body: { row: { ...after, doc: undefined } }, audit: { kind: 'mail', cycleId: row.cycleId, target: row.applicationId, detail: { mailId: row.id, marked: 'sent' } } };
    } },

    { method: 'GET', path: '/cycles/:cycle/mail', access: 'lead', async handler(rq, kit) {
      return jsonRoute(200, await listMail(kit, rq.cycle.id, rq.query || {}));
    } },

    { method: 'GET', path: '/cycles/:cycle/mail.csv', access: 'lead', async handler(rq, kit) {
      let rows = [];
      let cursor = null;
      for (let page = 0; page < 25; page++) {
        const out = await listMail(kit, rq.cycle.id, { ...(rq.query || {}), limit: 200, cursor });
        rows = rows.concat(out.rows);
        if (!out.next) break;
        cursor = out.next;
      }
      const iso = (ts) => (ts ? new Date(ts).toISOString() : '');
      const csv = ['To,Application,Template,Purpose,Status,Attempts,Reason,Subject,Created,Sent']
        .concat(rows.map((m) => [csvCell(m.toEmail), csvCell(m.applicationId || ''), csvCell(m.templateKey), csvCell(m.purposeKey), csvCell(m.status), m.attempt, csvCell(m.reason), csvCell(m.subject), iso(m.created), iso(m.sentAt)].join(',')))
        .join('\r\n');
      const res = rq.res;
      res.statusCode = 200;
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="cupi-mail-${rq.cycle.id}.csv"`);
      res.setHeader('cache-control', 'private, no-store');
      res.end('\uFEFF' + csv);
      return undefined;
    } },

    { method: 'POST', path: '/cycles/:cycle/mail/test', access: 'lead', cap: 262144, async handler(rq, kit) {
      const body = await rq.body();
      let tpl;
      if (body?.templateKey) {
        tpl = await templateFor(kit, rq.cycle, String(body.templateKey));
        if (!tpl) return jsonRoute(404, { error: 'No such template' });
      } else tpl = validateTemplate(body?.template || body?.custom);
      const merge = { ...SAMPLE_MERGE, cycle: rq.cycle.name || SAMPLE_MERGE.cycle, term: rq.cycle.term || SAMPLE_MERGE.term, 'sender.name': rq.me.name || rq.me.email, email: rq.me.email };
      const rendered = renderTemplate(tpl, merge);
      const settings = await emailSettings(kit);
      if (settings?.__error) return jsonRoute(200, { sent: false, reason: settings.__error });
      let out;
      try { out = await kit.email.send({ to: rq.me.email, subject: `[Test] ${rendered.subject}`, html: rendered.html, text: rendered.text, replyTo: rq.cycle.doc?.comms?.replyTo || '', settings, clientId: kit.email.clientId, saveOauth: kit.email.saveOauth }); }
      catch (e) { out = { sent: false, reason: e.message }; }
      return jsonRoute(200, { sent: !!out?.sent, reason: out?.reason });
    } },
  ],

  hooks: {
    async 'application.created'(ev, kit) {
      const source = ev?.source || ev?.application?.source || 'form';
      if (!['form', 'apply'].includes(source)) return;
      const applicationId = typeof ev.application === 'string' ? ev.application : ev.application?.id;
      if (!applicationId) return;
      await autoSend(kit, { cycle: ev.cycle, applicationId, templateKey: 'received', purpose: 'received' });
    },
    async 'booking.created'(ev, kit) {
      if (ev?.send === false) return;
      const booking = ev.booking || {};
      const applicationId = ev.application?.id || booking.applicationId;
      if (!applicationId || !booking.id) return;
      const templateKey = ev.templateKey || 'interview_invite';
      const purpose = ev.purpose || purposeKeyFor('interview_invite', { bookingId: booking.id });
      await autoSend(kit, { cycle: ev.cycle, applicationId, templateKey, purpose, explicit: ev.send === true, context: { interview: ev.interview || null, rsvpUrl: ev.rsvpUrl || '' } });
    },
    async 'decision.set'(ev, kit) {
      if (ev?.send === false) return;
      const outcome = ev.outcome || ev.decision?.outcome;
      const templateKey = OUTCOME_TEMPLATE[outcome];
      if (!templateKey) return;
      const list = Array.isArray(ev.applications) ? ev.applications : Array.isArray(ev.ids) ? ev.ids : ev.application ? [ev.application] : [];
      for (const item of list) {
        const applicationId = typeof item === 'string' ? item : item?.id;
        if (!applicationId) continue;
        await autoSend(kit, { cycle: ev.cycle, applicationId, templateKey, purpose: templateKey, explicit: ev.send === true, context: { 'decision.reason': ev.reason || ev.decision?.reason || '' } });
      }
    },
  },

  collect: {
    async 'csv.columns'(cycle, kit) {
      const counts = new Map();
      if (kit.mode === 'memory') {
        for (const m of kit.mem.mail || []) if (m.cycleId === cycle.id && m.status === 'sent') counts.set(m.applicationId, (counts.get(m.applicationId) || 0) + 1);
      } else {
        const s = await kit.sql();
        const out = await s`SELECT application_id, count(*) AS n FROM recruit_mail WHERE cycle_id = ${cycle.id} AND status = 'sent' GROUP BY application_id`;
        for (const r of out.rows) counts.set(r.application_id, Number(r.n));
      }
      return [{ header: 'Emails sent', cell: (row) => counts.get(row.id) || 0 }];
    },
    async purge({ ids }, kit) {
      if (!ids?.length) return;
      if (kit.mode === 'memory') {
        for (const m of kit.mem.mail || []) if (ids.includes(m.applicationId)) { m.toEmail = 'erased'; m.doc = {}; }
        await kit.memSave();
        return;
      }
      const s = await kit.sql();
      await s`UPDATE recruit_mail SET to_email = 'erased', doc = '{}'::jsonb WHERE application_id = ANY(${ids}) AND to_email <> 'erased'`;
    },
  },
};

async function stampTemplate(kit, ids, template) {
  if (!ids.length) return;
  if (kit.mode === 'memory') {
    for (const m of kit.mem.mail || []) if (ids.includes(m.id)) m.doc = { ...(m.doc || {}), template };
    await kit.memSave();
    return;
  }
  const s = await kit.sql();
  await s`UPDATE recruit_mail SET doc = doc || ${JSON.stringify({ template })}::jsonb WHERE id = ANY(${ids})`;
}

export { enqueue, deliver, templatesFor, autoSend };
