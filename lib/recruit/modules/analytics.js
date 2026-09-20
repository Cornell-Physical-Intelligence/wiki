// Analytics module: no tables of its own. It reads the shared applications
// table for funnel counts and breakdowns, folds in what the other modules
// expose through `csv.columns`, writes the cycle export, and owns retention:
// purging an archived cycle and erasing one applicant everywhere. Counts,
// stage keys, score numbers and audit survive a purge; names, emails,
// answers, files, notes, recipients and tokens do not.

import { createHash } from 'node:crypto';

const WIKI_URL = (process.env.WIKI_URL || 'https://wiki.cornellphysicalintelligence.com').replace(/\/$/, '');
export const LIMITS = { scan: 5000, exportPage: 500, purgePage: 200, cacheMs: 60000 };
const SYSTEM_QUESTIONS = new Set(['name', 'email', 'subteam', 'year', 'project', 'file']);
const jsonRoute = (status, body) => ({ status, body });
const num = (v) => (v === null || v === undefined ? null : Number(v));
const obj = (v) => (typeof v === 'string' ? JSON.parse(v) : v || {});
const arr = (v) => (typeof v === 'string' ? JSON.parse(v) : Array.isArray(v) ? v : []);

/* ------------------------------- mappers ---------------------------------- */

// Read-only projection of an application, accepting either casing (memory
// rows are written by the applications module, SQL rows arrive snake_case).
export function normApp(r) {
  if (!r) return null;
  return {
    id: r.id, cycleId: r.cycleId ?? r.cycle_id, email: r.email ?? '', ts: num(r.ts), updated: num(r.updated), name: r.name ?? '', cornell: r.cornell === true,
    subteam: r.subteam ?? '', year: r.year ?? null, source: r.source ?? 'form', formVersion: Number(r.formVersion ?? r.form_version ?? 0),
    answers: obj(r.answers), files: arr(r.files), stage: r.stage ?? 'applied', stageAt: num(r.stageAt ?? r.stage_at) || 0,
    stageHistory: arr(r.stageHistory ?? r.stage_history), outcome: r.outcome ?? null, decision: obj(r.decision), tags: arr(r.tags),
    review: obj(r.review), reviewVersion: Number(r.reviewVersion ?? r.review_version ?? 0), editVersion: Number(r.editVersion ?? r.edit_version ?? 0),
    onboardedAt: num(r.onboardedAt ?? r.onboarded_at), erasedAt: num(r.erasedAt ?? r.erased_at), receiptId: r.receiptId ?? r.receipt_id ?? null,
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

const stagesOf = (cycle) => (cycle?.doc?.pipeline?.stages || []).map((s) => s.key);

/* ------------------------------- math ------------------------------------- */

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const percentile = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const round1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

function countBy(rows, key) {
  const m = new Map();
  for (const r of rows) { const k = key(r); m.set(k, (m.get(k) || 0) + 1); }
  return m;
}

function orderedStages(cycle, seen) {
  const order = stagesOf(cycle);
  const extra = [...seen].filter((s) => !order.includes(s)).sort();
  return [...order, ...extra];
}

// Pure: every table on the Analytics panel from plain row arrays. Used by
// memory mode outright and by the SQL path for the bounded-scan parts.
export function computeAnalytics({ cycle, apps, scores = [], assignments = [], slots = [], bookings = [], mail = [], now = Date.now() }) {
  const rows = apps.map(normApp);
  const stageOrder = orderedStages(cycle, rows.map((r) => r.stage));
  const byStage = countBy(rows, (r) => r.stage);
  const funnel = stageOrder.map((stage) => ({ stage, n: byStage.get(stage) || 0 }));
  const breakdown = (key) => {
    const m = countBy(rows, (r) => JSON.stringify([key(r), r.stage]));
    return [...m.entries()].map(([k, n]) => { const [group, stage] = JSON.parse(k); return { group, stage, n }; })
      .sort((a, b) => a.group.localeCompare(b.group) || stageOrder.indexOf(a.stage) - stageOrder.indexOf(b.stage));
  };
  const bySubteam = breakdown((r) => r.subteam || '').map(({ group, stage, n }) => ({ subteam: group, stage, n }));
  const byYear = breakdown((r) => r.year || '').map(({ group, stage, n }) => ({ year: group, stage, n }));
  const bySource = [...countBy(rows, (r) => r.source || 'form').entries()].map(([source, n]) => ({ source, n })).sort((a, b) => a.source.localeCompare(b.source));
  const daily = [...countBy(rows.filter((r) => r.ts), (r) => dayOf(r.ts)).entries()].map(([day, n]) => ({ day, n })).sort((a, b) => a.day.localeCompare(b.day));
  const outcomes = [...countBy(rows, (r) => r.outcome || '').entries()].map(([outcome, n]) => ({ outcome: outcome || 'open', n })).sort((a, b) => a.outcome.localeCompare(b.outcome));

  // Time in stage: each history entry lasts until the next one; the current
  // stage lasts until now.
  const spans = new Map();
  for (const r of rows) {
    const h = [...r.stageHistory].filter((x) => x && x.stage && Number.isFinite(Number(x.at))).sort((a, b) => Number(a.at) - Number(b.at));
    if (!h.length) h.push({ stage: r.stage, at: r.stageAt || r.ts || now });
    for (let i = 0; i < h.length; i++) {
      const end = i + 1 < h.length ? Number(h[i + 1].at) : now;
      const hours = Math.max(0, end - Number(h[i].at)) / 3600000;
      if (!spans.has(h[i].stage)) spans.set(h[i].stage, []);
      spans.get(h[i].stage).push(hours);
    }
  }
  const timeInStage = orderedStages(cycle, spans.keys()).filter((s) => spans.has(s)).map((stage) => ({ stage, n: spans.get(stage).length, medianHours: round1(median(spans.get(stage))), p90Hours: round1(percentile(spans.get(stage), 0.9)) }));

  const ids = new Set(rows.map((r) => r.id));
  const perMember = new Map();
  const member = (m) => { if (!perMember.has(m)) perMember.set(m, { member: m, assigned: 0, done: 0, totals: [], hours: [] }); return perMember.get(m); };
  for (const a of assignments) if (ids.has(a.applicationId ?? a.application_id) && (a.kind || 'reviewer') === 'reviewer') member(a.member).assigned += 1;
  for (const s of scores) {
    if (!ids.has(s.applicationId ?? s.application_id) || (s.kind || 'review') !== 'review') continue;
    const d = obj(s.doc);
    const m = member(s.member);
    if (s.submitted) { m.done += 1; if (Number.isFinite(Number(s.created))) m.hours.push(Math.max(0, Number(s.submitted) - Number(s.created)) / 3600000); }
    if (d.conflict !== true && Number.isFinite(Number(d.total)) && s.submitted) m.totals.push(Number(d.total));
  }
  const reviewers = [...perMember.values()].map((m) => ({ member: m.member, assigned: m.assigned, done: m.done, mean: m.totals.length ? round1(m.totals.reduce((a, b) => a + b, 0) / m.totals.length) : null, medianHours: round1(median(m.hours)) })).sort((a, b) => a.member.localeCompare(b.member));

  const cycleSlots = slots.filter((s) => (s.cycleId ?? s.cycle_id) === cycle.id);
  const cycleBookings = bookings.filter((b) => (b.cycleId ?? b.cycle_id) === cycle.id);
  const bStatus = countBy(cycleBookings, (b) => b.status);
  const interviews = { slots: cycleSlots.length, booked: cycleSlots.reduce((n, s) => n + Number(s.booked || 0), 0), invited: bStatus.get('invited') || 0, confirmed: bStatus.get('confirmed') || 0, noShow: bStatus.get('no_show') || 0, done: bStatus.get('done') || 0 };
  const mStatus = countBy(mail.filter((m) => (m.cycleId ?? m.cycle_id) === cycle.id), (m) => m.status);
  const mailOut = { sent: mStatus.get('sent') || 0, failed: mStatus.get('failed') || 0, queued: (mStatus.get('queued') || 0) + (mStatus.get('sending') || 0), skipped: mStatus.get('skipped') || 0 };
  return { total: rows.length, funnel, bySubteam, byYear, bySource, daily, reviewers, timeInStage, interviews, mail: mailOut, outcomes, generatedAt: now };
}

const cache = new Map();

async function analyticsFor(kit, cycle, { fresh = false } = {}) {
  const now = kit.now();
  const hit = cache.get(cycle.id);
  if (!fresh && hit && hit.at > now - LIMITS.cacheMs && hit.version === cycle.version) return hit.data;
  let data;
  if (kit.mode === 'memory') {
    const apps = (kit.mem.applications || []).filter((a) => (a.cycleId ?? a.cycle_id) === cycle.id);
    data = computeAnalytics({ cycle, apps, scores: kit.mem.scores || [], assignments: kit.mem.assignments || [], slots: kit.mem.slots || [], bookings: kit.mem.bookings || [], mail: kit.mem.mail || [], now });
  } else {
    const s = await kit.sql();
    const id = cycle.id;
    const [stage, subteam, year, source, daily, outcome, scan] = await Promise.all([
      s`SELECT stage, count(*) AS n FROM recruit_applications WHERE cycle_id = ${id} GROUP BY stage`,
      s`SELECT subteam, stage, count(*) AS n FROM recruit_applications WHERE cycle_id = ${id} GROUP BY subteam, stage`,
      s`SELECT COALESCE(year, '') AS year, stage, count(*) AS n FROM recruit_applications WHERE cycle_id = ${id} GROUP BY 1, 2`,
      s`SELECT source, count(*) AS n FROM recruit_applications WHERE cycle_id = ${id} GROUP BY source`,
      s`SELECT to_char(to_timestamp(ts / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) AS n FROM recruit_applications WHERE cycle_id = ${id} GROUP BY 1 ORDER BY 1`,
      s`SELECT COALESCE(outcome, '') AS outcome, count(*) AS n FROM recruit_applications WHERE cycle_id = ${id} GROUP BY 1`,
      s`SELECT id, ts, stage, stage_at, stage_history FROM recruit_applications WHERE cycle_id = ${id} ORDER BY ts DESC LIMIT ${LIMITS.scan}`,
    ]);
    const optional = async (q) => { try { return (await q()).rows; } catch (e) { return []; } };
    const [scores, assignments, slots, bookings, mail] = await Promise.all([
      optional(() => s`SELECT s.application_id, s.member, s.kind, s.created, s.submitted, s.doc FROM recruit_scores s JOIN recruit_applications a ON a.id = s.application_id WHERE a.cycle_id = ${id} AND s.kind = 'review' LIMIT ${LIMITS.scan}`),
      optional(() => s`SELECT x.application_id, x.member, x.kind FROM recruit_assignments x JOIN recruit_applications a ON a.id = x.application_id WHERE a.cycle_id = ${id} AND x.kind = 'reviewer' LIMIT ${LIMITS.scan}`),
      optional(() => s`SELECT cycle_id, booked FROM recruit_slots WHERE cycle_id = ${id}`),
      optional(() => s`SELECT cycle_id, status FROM recruit_bookings WHERE cycle_id = ${id}`),
      optional(() => s`SELECT cycle_id, status FROM recruit_mail WHERE cycle_id = ${id}`),
    ]);
    const scanned = computeAnalytics({ cycle, apps: scan.rows.map((r) => ({ ...r, cycle_id: id })), scores, assignments, slots, bookings, mail, now });
    const order = orderedStages(cycle, stage.rows.map((r) => r.stage));
    const n = (r) => Number(r.n);
    data = {
      total: stage.rows.reduce((t, r) => t + n(r), 0),
      funnel: order.map((k) => ({ stage: k, n: n(stage.rows.find((r) => r.stage === k) || { n: 0 }) })),
      bySubteam: subteam.rows.map((r) => ({ subteam: r.subteam || '', stage: r.stage, n: n(r) })).sort((a, b) => a.subteam.localeCompare(b.subteam) || order.indexOf(a.stage) - order.indexOf(b.stage)),
      byYear: year.rows.map((r) => ({ year: r.year || '', stage: r.stage, n: n(r) })).sort((a, b) => a.year.localeCompare(b.year) || order.indexOf(a.stage) - order.indexOf(b.stage)),
      bySource: source.rows.map((r) => ({ source: r.source, n: n(r) })).sort((a, b) => a.source.localeCompare(b.source)),
      daily: daily.rows.map((r) => ({ day: r.day, n: n(r) })),
      outcomes: outcome.rows.map((r) => ({ outcome: r.outcome || 'open', n: n(r) })).sort((a, b) => a.outcome.localeCompare(b.outcome)),
      reviewers: scanned.reviewers, timeInStage: scanned.timeInStage, interviews: scanned.interviews, mail: scanned.mail, generatedAt: now,
    };
  }
  cache.set(cycle.id, { at: now, version: cycle.version, data });
  return data;
}

async function retentionFor(kit) {
  const settings = await readSettingsDoc(kit);
  const months = Number(settings.retention?.months ?? 24);
  const now = kit.now();
  const cutoff = now - months * 30.4375 * 86400000;
  let cycles;
  if (kit.mode === 'memory') {
    cycles = (kit.mem.cycles || []).filter((c) => c.status === 'archived' && Number(c.closedAt ?? c.closed_at) && Number(c.closedAt ?? c.closed_at) < cutoff)
      .map((c) => ({ id: c.id, name: c.name, term: c.term || '', closedAt: Number(c.closedAt ?? c.closed_at), remaining: (kit.mem.applications || []).filter((a) => (a.cycleId ?? a.cycle_id) === c.id && !(a.erasedAt ?? a.erased_at)).length }))
      .filter((c) => c.remaining > 0);
  } else {
    const s = await kit.sql();
    const out = await s`SELECT c.id, c.name, c.term, c.closed_at, (SELECT count(*) FROM recruit_applications a WHERE a.cycle_id = c.id AND a.erased_at IS NULL) AS remaining
      FROM recruit_cycles c WHERE c.status = 'archived' AND c.closed_at IS NOT NULL AND c.closed_at < ${Math.floor(cutoff)}
      AND EXISTS (SELECT 1 FROM recruit_applications a WHERE a.cycle_id = c.id AND a.erased_at IS NULL) ORDER BY c.closed_at LIMIT 100`;
    cycles = out.rows.map((r) => ({ id: r.id, name: r.name, term: r.term || '', closedAt: Number(r.closed_at), remaining: Number(r.remaining) }));
  }
  return { months, cycles };
}

/* ------------------------------- export ----------------------------------- */

export const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
};
const iso = (ts) => (ts ? new Date(Number(ts)).toISOString() : '');

function exportFilters(q) {
  const f = {
    q: String(q.q || '').trim().slice(0, 100) || null, stage: q.stage ? String(q.stage) : null, subteam: q.subteam ? String(q.subteam) : null,
    year: q.year ? String(q.year) : null, tag: q.tag ? String(q.tag).slice(0, 30) : null, flagged: q.flagged === '1' || q.flagged === 'true',
    outcome: q.outcome ? String(q.outcome) : null, dir: q.dir === 'asc' ? 'asc' : 'desc',
  };
  const [cursorTs, cursorId] = String(q.cursor || '').split('|');
  f.cursorTs = Number(cursorTs) || null;
  f.cursorId = cursorId || null;
  return f;
}

// Filters match the list endpoint; order is by received time so the cursor
// stays a plain (ts, id) pair.
export function matchesExport(r, f) {
  if (f.stage && r.stage !== f.stage) return false;
  if (f.subteam && (f.subteam === '__undecided' ? r.subteam !== '' : r.subteam !== f.subteam)) return false;
  if (f.year && (r.year || '') !== f.year) return false;
  if (f.tag && !r.tags.includes(f.tag)) return false;
  if (f.flagged && r.review?.flagged !== true) return false;
  if (f.outcome && (r.outcome || '') !== f.outcome) return false;
  if (f.q) { const q = f.q.toLowerCase(); if (!r.name.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) return false; }
  return true;
}

async function exportPage(kit, cycleId, f, limit) {
  if (kit.mode === 'memory') {
    const sign = f.dir === 'asc' ? 1 : -1;
    const rows = (kit.mem.applications || []).map(normApp).filter((r) => r.cycleId === cycleId && matchesExport(r, f))
      .filter((r) => !f.cursorTs || (sign < 0 ? r.ts < f.cursorTs || (r.ts === f.cursorTs && r.id < f.cursorId) : r.ts > f.cursorTs || (r.ts === f.cursorTs && r.id > f.cursorId)))
      .sort((a, b) => sign * (a.ts - b.ts) || sign * (a.id < b.id ? -1 : 1));
    return rows.slice(0, limit + 1);
  }
  const s = await kit.sql();
  const like = f.q ? `%${f.q.replace(/[\\%_]/g, '\\$&')}%` : null;
  const undecided = f.subteam === '__undecided';
  const subteam = undecided ? null : f.subteam;
  const asc = f.dir === 'asc';
  const out = await s`SELECT * FROM recruit_applications WHERE cycle_id = ${cycleId}
    AND (${f.stage}::text IS NULL OR stage = ${f.stage}) AND (${subteam}::text IS NULL OR subteam = ${subteam}) AND (NOT ${undecided} OR subteam = '')
    AND (${f.year}::text IS NULL OR COALESCE(year, '') = ${f.year}) AND (${f.tag}::text IS NULL OR tags @> ${JSON.stringify([f.tag || ''])}::jsonb)
    AND (NOT ${f.flagged} OR (review->>'flagged')::boolean IS TRUE) AND (${f.outcome}::text IS NULL OR COALESCE(outcome, '') = ${f.outcome})
    AND (${like}::text IS NULL OR name ILIKE ${like} OR email ILIKE ${like})
    AND (${f.cursorTs}::bigint IS NULL OR (${asc} AND (ts > ${f.cursorTs || 0} OR (ts = ${f.cursorTs || 0} AND id > ${f.cursorId || ''}))) OR (NOT ${asc} AND (ts < ${f.cursorTs || 0} OR (ts = ${f.cursorTs || 0} AND id < ${f.cursorId || ''}))))
    ORDER BY CASE WHEN ${asc} THEN ts END ASC, CASE WHEN ${asc} THEN id END ASC, CASE WHEN NOT ${asc} THEN ts END DESC, CASE WHEN NOT ${asc} THEN id END DESC
    LIMIT ${limit + 1}`;
  return out.rows.map(normApp);
}

async function questionColumns(kit, cycleId) {
  let docs = [];
  try {
    if (kit.mode === 'memory') docs = (kit.mem.forms || []).filter((f) => (f.cycleId ?? f.cycle_id) === cycleId && ['published', 'superseded'].includes(f.status)).sort((a, b) => Number(a.version) - Number(b.version)).map((f) => obj(f.doc));
    else {
      const s = await kit.sql();
      const out = await s`SELECT doc FROM recruit_forms WHERE cycle_id = ${cycleId} AND status IN ('published', 'superseded') ORDER BY version`;
      docs = out.rows.map((r) => obj(r.doc));
    }
  } catch (e) { docs = []; }
  const seen = new Map();
  for (const d of docs) for (const q of d.questions || []) if (q?.key && !SYSTEM_QUESTIONS.has(q.key) && !q.system) seen.set(q.key, q.label || q.key);
  return [...seen.entries()].map(([key, label]) => ({ header: label, cell: (row) => { const v = row.answers?.[key]; return Array.isArray(v) ? v.join('; ') : v === true ? 'yes' : v === false ? 'no' : v ?? ''; } }));
}

function flattenColumns(collected) {
  const out = [];
  const push = (x) => { if (Array.isArray(x)) x.forEach(push); else if (x && typeof x.header === 'string' && typeof x.cell === 'function') out.push(x); };
  push(collected);
  return out;
}

function mergeExtras(collected) {
  const out = {};
  const fold = (x) => { if (Array.isArray(x)) x.forEach(fold); else if (x && typeof x === 'object') for (const [id, v] of Object.entries(x)) out[id] = { ...(out[id] || {}), ...(v || {}) }; };
  fold(collected);
  return out;
}

export const LEGACY_HEADER = 'Submitted,Updated,Name,Email,Subteam,Coolest project,Cornell address,File,Year';

export function baseColumns() {
  return [
    { header: 'Submitted', cell: (r) => iso(r.ts) }, { header: 'Updated', cell: (r) => iso(r.updated || r.ts) },
    { header: 'Name', cell: (r) => r.name }, { header: 'Email', cell: (r) => r.email }, { header: 'Subteam', cell: (r) => r.subteam || '' },
    { header: 'Coolest project', cell: (r) => r.answers?.project ?? '' }, { header: 'Cornell address', cell: (r) => (r.cornell ? 'yes' : 'no') },
    { header: 'File', cell: (r) => (r.files?.[0]?.id ? `${r.files[0].name} · ${WIKI_URL}/api/recruit/files/${r.files[0].id}` : '') },
    { header: 'Year', cell: (r) => r.year || '' },
    { header: 'Stage', cell: (r) => r.stage }, { header: 'Stage since', cell: (r) => iso(r.stageAt) }, { header: 'Outcome', cell: (r) => r.outcome || '' },
    { header: 'Reason', cell: (r) => r.decision?.reason || '' }, { header: 'Tags', cell: (r) => (r.tags || []).join('; ') }, { header: 'Source', cell: (r) => r.source || '' },
    { header: 'Flagged', cell: (r) => (r.review?.flagged ? 'yes' : 'no') }, { header: 'Comments', cell: (r) => (r.review?.comments || []).length },
  ];
}

export function csvText(rows, columns, extras = {}) {
  const lines = [columns.map((c) => csvCell(c.header)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(c.cell(r, extras[r.id] || {}))).join(','));
  return lines.join('\r\n');
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cycle';

/* ------------------------------ retention --------------------------------- */

async function scrubOthers(kit, ids) {
  if (!ids.length) return;
  if (kit.mode === 'memory') {
    for (const s of kit.mem.scores || []) if (ids.includes(s.applicationId ?? s.application_id)) { s.doc = { ...obj(s.doc), notes: '' }; }
    for (const m of kit.mem.mail || []) if (ids.includes(m.applicationId ?? m.application_id)) { m.toEmail = 'erased'; if (m.to_email) m.to_email = 'erased'; m.doc = {}; }
    for (const b of kit.mem.bookings || []) if (ids.includes(b.applicationId ?? b.application_id)) { b.tokenHash = ''; if (b.token_hash) b.token_hash = ''; }
    await kit.memSave();
    return;
  }
  const s = await kit.sql();
  const optional = async (q) => { try { await q(); } catch (e) { /* the owning module may not be mounted */ } };
  await optional(() => s`UPDATE recruit_scores SET doc = jsonb_set(doc, '{notes}', '""'::jsonb) WHERE application_id = ANY(${ids}) AND doc ? 'notes' AND doc->>'notes' <> ''`);
  await optional(() => s`UPDATE recruit_mail SET to_email = 'erased', doc = '{}'::jsonb WHERE application_id = ANY(${ids}) AND to_email <> 'erased'`);
  await optional(() => s`UPDATE recruit_bookings SET token_hash = '' WHERE application_id = ANY(${ids}) AND token_hash <> ''`);
}

async function forgetApplicants(kit, emails) {
  if (!emails.length) return;
  if (kit.mode === 'memory') {
    const live = new Set((kit.mem.applications || []).filter((a) => !(a.erasedAt ?? a.erased_at)).map((a) => a.email));
    kit.mem.applicants = (kit.mem.applicants || []).filter((p) => !(emails.includes(p.email) && !live.has(p.email)));
    await kit.memSave();
    return;
  }
  const s = await kit.sql();
  await s`DELETE FROM recruit_applicants p WHERE p.email = ANY(${emails}) AND NOT EXISTS (SELECT 1 FROM recruit_applications a WHERE a.email = p.email AND a.erased_at IS NULL)`;
}

async function forgetJournal(kit, receipts) {
  if (!receipts.length || typeof kit.journal?.forget !== 'function') return;
  try {
    let saved = receipts;
    if (kit.mode !== 'memory') {
      const s = await kit.sql();
      const out = await s`SELECT id FROM interest_receipts WHERE id = ANY(${receipts}) AND outcome = 'saved'`;
      saved = out.rows.map((r) => r.id);
    }
    for (const id of saved) await kit.journal.forget(id);
  } catch (e) { /* best effort */ }
}

// One statement redacts a page of applications and hands back what the
// follow-up steps need: the old email for the applicant row, the file ids,
// the receipt for the journal. The email rewrite keeps UNIQUE(cycle_id,email).
async function redact(kit, { cycleId = null, email = null, limit }) {
  const now = kit.now();
  let hit = [];
  if (kit.mode === 'memory') {
    const rows = (kit.mem.applications || []).filter((a) => !(a.erasedAt ?? a.erased_at) && (cycleId === null || (a.cycleId ?? a.cycle_id) === cycleId) && (email === null || a.email === email))
      .sort((a, b) => Number(a.ts) - Number(b.ts)).slice(0, limit);
    for (const a of rows) {
      hit.push({ id: a.id, cycleId: a.cycleId ?? a.cycle_id, email: a.email, files: arr(a.files).map((f) => f.id).filter(Boolean), receiptId: a.receiptId ?? a.receipt_id ?? null });
      const review = { ...obj(a.review) }; delete review.comments;
      Object.assign(a, { name: 'Applicant', email: `erased:${a.id}`, answers: {}, files: [], review });
      if ('ipHash' in a) a.ipHash = ''; if ('ip_hash' in a) a.ip_hash = '';
      if ('erased_at' in a) a.erased_at = now; else a.erasedAt = now;
      if ('edit_version' in a) a.edit_version = Number(a.edit_version) + 1; else a.editVersion = Number(a.editVersion || 0) + 1;
    }
    await kit.memSave();
    return hit;
  }
  const s = await kit.sql();
  const out = await s`WITH target AS (SELECT id, cycle_id, email, files, receipt_id FROM recruit_applications
      WHERE erased_at IS NULL AND (${cycleId}::text IS NULL OR cycle_id = ${cycleId}) AND (${email}::text IS NULL OR email = ${email}) ORDER BY ts LIMIT ${limit}),
    done AS (UPDATE recruit_applications a SET name = 'Applicant', email = 'erased:' || a.id, answers = '{}'::jsonb, files = '[]'::jsonb, ip_hash = '', review = a.review - 'comments', erased_at = ${now}, edit_version = a.edit_version + 1
      FROM target t WHERE a.id = t.id AND a.erased_at IS NULL RETURNING a.id)
    SELECT t.id, t.cycle_id, t.email, t.files, t.receipt_id FROM target t JOIN done d ON d.id = t.id`;
  hit = out.rows.map((r) => ({ id: r.id, cycleId: r.cycle_id, email: r.email, files: arr(r.files).map((f) => f.id).filter(Boolean), receiptId: r.receipt_id || null }));
  return hit;
}

async function erasePage(kit, { cycle = null, email = null, limit, actor }) {
  const hit = await redact(kit, { cycleId: cycle?.id ?? null, email, limit });
  const ids = hit.map((h) => h.id);
  if (!ids.length) return { erased: 0, ids };
  await scrubOthers(kit, ids);
  const byCycle = new Map();
  for (const h of hit) { if (!byCycle.has(h.cycleId)) byCycle.set(h.cycleId, []); byCycle.get(h.cycleId).push(h.id); }
  for (const [cycleId, cycleIds] of byCycle) {
    try { await kit.collect('purge', { cycle: cycle && cycle.id === cycleId ? cycle : (await kit.cycles.get(cycleId)) || { id: cycleId }, ids: cycleIds }); } catch (e) { /* collectors log their own failures */ }
  }
  for (const h of hit) for (const fileId of h.files) { try { await kit.files.removeUnreferenced(fileId); } catch (e) { /* best effort */ } }
  await forgetApplicants(kit, [...new Set(hit.map((h) => h.email))]);
  await forgetJournal(kit, hit.map((h) => h.receiptId).filter(Boolean));
  return { erased: ids.length, ids, hit };
}

async function remainingIn(kit, cycleId) {
  if (kit.mode === 'memory') return (kit.mem.applications || []).filter((a) => (a.cycleId ?? a.cycle_id) === cycleId && !(a.erasedAt ?? a.erased_at)).length;
  const s = await kit.sql();
  const out = await s`SELECT count(*) AS n FROM recruit_applications WHERE cycle_id = ${cycleId} AND erased_at IS NULL`;
  return Number(out.rows[0]?.n || 0);
}

/* -------------------------------- module ---------------------------------- */

export default {
  name: 'analytics',
  kernel: false,
  order: 80,
  schema: [],
  memory: {},
  defaults: () => ({}),
  validateSettings: () => {},
  auditKinds: ['purge', 'app.erase'],

  routes: [
    { method: 'GET', path: '/cycles/:cycle/analytics', access: 'lead', async handler(rq, kit) {
      const data = await analyticsFor(kit, rq.cycle, { fresh: (rq.query || {}).fresh === '1' });
      const retention = rq.role === 'admin' ? await retentionFor(kit) : { months: (await readSettingsDoc(kit)).retention?.months ?? 24, cycles: [] };
      return jsonRoute(200, { ...data, retention });
    } },

    { method: 'GET', path: '/cycles/:cycle/export.csv', access: 'lead', async handler(rq, kit) {
      const q = rq.query || {};
      const f = exportFilters(q);
      const page = await exportPage(kit, rq.cycle.id, f, LIMITS.exportPage);
      const rows = page.slice(0, LIMITS.exportPage);
      const more = page.length > LIMITS.exportPage;
      const columns = [...baseColumns(), ...(await questionColumns(kit, rq.cycle.id))];
      let extras = {};
      try {
        const collected = await kit.collect('csv.columns', rq.cycle);
        columns.push(...flattenColumns(collected));
        if (rows.length) extras = mergeExtras(await kit.collect('application.extras', { cycle: rq.cycle, ids: rows.map((r) => r.id), me: rq.me, role: rq.role }));
      } catch (e) { /* a module that fails to describe its columns leaves the base export intact */ }
      const res = rq.res;
      res.statusCode = 200;
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="cupi-${slug(rq.cycle.term || rq.cycle.name)}-${new Date(kit.now()).toISOString().slice(0, 10)}.csv"`);
      res.setHeader('cache-control', 'private, no-store');
      if (more) {
        const last = rows[rows.length - 1];
        const params = new URLSearchParams();
        for (const k of ['q', 'stage', 'subteam', 'year', 'tag', 'flagged', 'outcome', 'dir']) if (q[k]) params.set(k, String(q[k]));
        params.set('cursor', `${last.ts}|${last.id}`);
        res.setHeader('link', `</api/recruit/cycles/${rq.cycle.id}/export.csv?${params}>; rel="next"`);
      }
      res.end('\uFEFF' + csvText(rows, columns, extras));
      return undefined;
    } },

    // Not `mutates`: the registry guard would refuse the archived cycles this
    // route exists for. Archived-only is checked here instead.
    { method: 'POST', path: '/cycles/:cycle/purge', access: 'admin', cap: 65536, async handler(rq, kit) {
      if (rq.cycle.status !== 'archived') return jsonRoute(409, { error: 'Only archived cycles can be purged' });
      const body = await rq.body();
      if (String(body?.confirm || '').trim() !== String(rq.cycle.name).trim()) return jsonRoute(400, { error: 'Type the cycle name to confirm' });
      const out = await erasePage(kit, { cycle: rq.cycle, limit: LIMITS.purgePage, actor: rq.me.email });
      const remaining = await remainingIn(kit, rq.cycle.id);
      cache.delete(rq.cycle.id);
      if (out.erased) await kit.audit({ cycleId: rq.cycle.id, actor: rq.me.email, kind: 'purge', detail: { purged: out.erased, remaining } });
      return jsonRoute(200, { purged: out.erased, remaining });
    } },

    { method: 'POST', path: '/applicants/:email/erase', access: 'admin', cap: 65536, async handler(rq, kit) {
      const email = String(rq.params.email || '').trim().toLowerCase();
      const body = await rq.body();
      if (String(body?.confirm || '').trim().toLowerCase() !== email) return jsonRoute(400, { error: 'Type the email address to confirm' });
      const out = await erasePage(kit, { email, limit: 1000, actor: rq.me.email });
      for (const h of out.hit || []) { cache.delete(h.cycleId); await kit.audit({ cycleId: h.cycleId, applicationId: h.id, actor: rq.me.email, kind: 'app.erase', detail: { emailHash: hashEmail(email) } }); }
      return jsonRoute(200, { erased: out.erased });
    } },
  ],

  hooks: {
    async 'stage.moved'(ev) { cache.delete(typeof ev.cycle === 'string' ? ev.cycle : ev.cycle?.id); },
    async 'decision.set'(ev) { cache.delete(typeof ev.cycle === 'string' ? ev.cycle : ev.cycle?.id); },
    async 'application.created'(ev) { cache.delete(typeof ev.cycle === 'string' ? ev.cycle : ev.cycle?.id); },
    async 'application.deleted'(ev) { cache.delete(typeof ev.cycle === 'string' ? ev.cycle : ev.cycle?.id); },
  },

  collect: {},
};

const hashEmail = (e) => createHash('sha256').update(String(e)).digest('hex').slice(0, 24);

export { analyticsFor, erasePage, exportPage, retentionFor };
