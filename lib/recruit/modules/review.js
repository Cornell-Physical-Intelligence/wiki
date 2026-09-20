// Review module: reviewer assignments, rubric scorecards, blind scoring,
// conflicts of interest and calibration aggregates for one cycle. It owns
// recruit_assignments and recruit_scores, reads recruit_applications for
// names and cycle membership, and never writes a shared application column.
// Reviewer scoping is enforced in SQL by application-id intersection through
// the scope.applications collector; nothing here trusts the client.

const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const APP_ID = /^in-[a-z0-9]+$/;
const REQUEST_ID = /^rq-[a-z0-9-]{8,80}$/;
const ROUND = /^[a-z0-9_-]{0,40}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RECOMMENDATIONS = new Set(['strong_yes', 'yes', 'no', 'strong_no']);
const BLIND = new Set(['until-submitted', 'off']);
const VISIBILITY = new Set(['assigned', 'subteam', 'all']);
// Route param :kind is review|interview (the scorecard kind); assignment rows
// use the person's role name.
const ASSIGN_KIND = { review: 'reviewer', interview: 'interviewer' };
const SCORE_KIND = { reviewer: 'review', interviewer: 'interview' };
const MAX_IDS = 2000;

export const DEFAULT_RUBRIC = {
  version: 1,
  scale: 5,
  criteria: [
    { key: 'motivation', name: 'Motivation', weight: 1, help: '' },
    { key: 'skills', name: 'Relevant skills', weight: 2, help: '' },
    { key: 'teamwork', name: 'Works with others', weight: 1, help: '' },
  ],
};

const fail = (status, error) => Object.assign(new Error(error), { status, error });
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const clipText = (v, n) => String(v ?? '').trim().slice(0, n);
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isLead = (role) => role === 'admin' || role === 'lead';
const round2 = (n) => Math.round(n * 100) / 100;
const slug = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const defaults = () => ({
  blind: 'until-submitted',
  visibility: 'assigned',
  perApplication: 2,
  editAfterSubmit: false,
  rubric: JSON.parse(JSON.stringify(DEFAULT_RUBRIC)),
});
export const settingsOf = (cycle) => ({ ...defaults(cycle), ...(isObject(cycle?.doc?.review) ? cycle.doc.review : {}) });

/* ------------------------------ validation ------------------------------ */

export function normalizeRubric(raw, label = 'rubric') {
  if (!isObject(raw)) throw fail(400, `The ${label} must be an object`);
  const version = Number.isInteger(raw.version) && raw.version >= 1 ? raw.version : 1;
  const scale = Number(raw.scale ?? 5);
  if (!Number.isInteger(scale) || scale < 3 || scale > 10) throw fail(400, 'The scale is a whole number from 3 to 10');
  if (!Array.isArray(raw.criteria) || !raw.criteria.length) throw fail(400, 'Add at least one criterion');
  if (raw.criteria.length > 20) throw fail(400, 'Keep it to 20 criteria');
  const seen = new Set();
  const criteria = raw.criteria.map((c) => {
    if (!isObject(c)) throw fail(400, 'Each criterion needs a key, a name and a weight');
    const key = String(c.key || '');
    if (!KEY.test(key)) throw fail(400, `Criterion key "${key.slice(0, 40)}" must be lowercase letters, digits or underscores`);
    if (seen.has(key)) throw fail(400, `Criterion key "${key}" is used twice`);
    seen.add(key);
    const name = clip(c.name, 80);
    if (!name) throw fail(400, `Give criterion "${key}" a name`);
    const weight = Number(c.weight ?? 1);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 10) throw fail(400, `Criterion "${name}" needs a weight between 0 and 10`);
    return { key, name, weight, help: clip(c.help, 300) };
  });
  return { version, scale, criteria };
}

function validateSettings(next) {
  if (!isObject(next)) throw fail(400, 'Review settings must be an object');
  const blind = next.blind === undefined ? 'until-submitted' : String(next.blind);
  if (!BLIND.has(blind)) throw fail(400, 'Blind scoring is "until-submitted" or "off"');
  const visibility = next.visibility === undefined ? 'assigned' : String(next.visibility);
  if (!VISIBILITY.has(visibility)) throw fail(400, 'Visibility is "assigned", "subteam" or "all"');
  const perApplication = Number(next.perApplication ?? 2);
  if (!Number.isInteger(perApplication) || perApplication < 1 || perApplication > 10) throw fail(400, 'Reviewers per application is a whole number from 1 to 10');
  return { blind, visibility, perApplication, editAfterSubmit: next.editAfterSubmit === true, rubric: normalizeRubric(next.rubric ?? DEFAULT_RUBRIC) };
}

export function rubricFor(cycle, kind, round) {
  if (kind === 'interview') {
    const rounds = Array.isArray(cycle?.doc?.interviews?.rounds) ? cycle.doc.interviews.rounds : [];
    const r = rounds.find((x) => x.key === round);
    if (r && isObject(r.rubric)) return normalizeRubric(r.rubric, 'interview rubric');
  }
  return normalizeRubric(settingsOf(cycle).rubric);
}

// total = Σ weight·score / Σ weight over the criteria that were scored.
export function computeTotal(rubric, input) {
  const scores = {};
  let weighted = 0, weights = 0;
  if (input !== undefined && !isObject(input)) throw fail(400, 'Scores must be an object of criterion: number');
  for (const c of rubric.criteria) {
    const v = input?.[c.key];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > rubric.scale) throw fail(400, `${c.name} is scored 1 to ${rubric.scale}`);
    scores[c.key] = n;
    weighted += c.weight * n;
    weights += c.weight;
  }
  return { scores, total: weights ? round2(weighted / weights) : null };
}

export function aggregateOf(rows) {
  const usable = rows.filter((r) => r.submitted && !r.doc?.conflict && typeof r.doc?.total === 'number');
  if (!usable.length) return null;
  const totals = usable.map((r) => r.doc.total);
  const mean = round2(totals.reduce((a, b) => a + b, 0) / totals.length);
  const byCriterion = {};
  for (const r of usable) for (const [k, v] of Object.entries(r.doc.scores || {})) (byCriterion[k] ||= []).push(v);
  for (const k of Object.keys(byCriterion)) byCriterion[k] = round2(byCriterion[k].reduce((a, b) => a + b, 0) / byCriterion[k].length);
  const recommendations = {};
  for (const r of usable) if (r.doc.recommendation) recommendations[r.doc.recommendation] = (recommendations[r.doc.recommendation] || 0) + 1;
  return { n: usable.length, mean, spread: round2(Math.max(...totals) - Math.min(...totals)), byCriterion, recommendations };
}

const canSeeOthers = (role, settings, mine) => isLead(role) || settings.blind === 'off' || Boolean(mine?.submitted);

/* ------------------------------- planning ------------------------------- */

// Pure and deterministic: applications in ts order, members by current load
// then email. Skips conflicts and a member reviewing their own application.
export function planAssignments({ applications = [], members = [], load = {}, perApplication = 2, bySubteam = false, coi = new Set() }) {
  const people = members.map((m) => (typeof m === 'string' ? { email: m.toLowerCase(), subteams: [] } : { email: String(m.email).toLowerCase(), subteams: Array.isArray(m.subteams) ? m.subteams : [] }));
  const running = Object.fromEntries(people.map((p) => [p.email, Number(load[p.email]) || 0]));
  const apps = [...applications].sort((a, b) => (Number(a.ts) - Number(b.ts)) || String(a.id).localeCompare(String(b.id)));
  const plan = [];
  const per = Math.max(1, Math.min(10, Number(perApplication) || 1));
  for (const app of apps) {
    const eligible = people.filter((p) => {
      if (coi.has(app.id + '|' + p.email)) return false;
      if (app.email && String(app.email).toLowerCase() === p.email) return false;
      if (bySubteam && p.subteams.length && app.subteam && !p.subteams.includes(app.subteam)) return false;
      return true;
    }).sort((a, b) => (running[a.email] - running[b.email]) || a.email.localeCompare(b.email));
    for (const p of eligible.slice(0, per)) {
      plan.push({ applicationId: app.id, member: p.email });
      running[p.email] += 1;
    }
  }
  return plan;
}

/* -------------------------------- storage ------------------------------- */

const asRow = (r) => ({
  applicationId: r.application_id, member: r.member, kind: r.kind, round: r.round, status: r.status,
  created: r.created == null ? null : Number(r.created), createdBy: r.created_by || '',
});
const scoreRow = (r) => ({
  applicationId: r.application_id, member: r.member, kind: r.kind, round: r.round,
  rubricVersion: Number(r.rubric_version), created: Number(r.created), updated: Number(r.updated),
  submitted: r.submitted == null ? null : Number(r.submitted),
  doc: typeof r.doc === 'string' ? JSON.parse(r.doc) : (r.doc || {}),
});
const cycleApps = (kit, cycle) => (kit.mem.applications || []).filter((a) => a.cycleId === cycle.id);
const cycleAppIds = (kit, cycle) => new Set(cycleApps(kit, cycle).map((a) => a.id));

async function loadApps(kit, cycle, ids) {
  if (kit.mode === 'memory') {
    const want = new Set(ids);
    return cycleApps(kit, cycle).filter((a) => want.has(a.id)).map((a) => ({ id: a.id, ts: Number(a.ts), subteam: a.subteam || '', email: a.email, name: a.name }));
  }
  const s = await kit.sql();
  const r = await s`SELECT id, ts, subteam, email, name FROM recruit_applications WHERE cycle_id = ${cycle.id} AND id = ANY(${ids}::text[]) ORDER BY ts, id`;
  return r.rows.map((a) => ({ id: a.id, ts: Number(a.ts), subteam: a.subteam || '', email: a.email, name: a.name }));
}

async function listAssignments(kit, cycle, { member = null, kind = null } = {}) {
  if (kit.mode === 'memory') {
    const ids = cycleAppIds(kit, cycle);
    return (kit.mem.assignments || []).filter((a) => ids.has(a.applicationId) && (!member || a.member === member) && (!kind || a.kind === kind))
      .sort((a, b) => (a.created - b.created) || a.applicationId.localeCompare(b.applicationId) || a.member.localeCompare(b.member))
      .map((a) => ({ ...a }));
  }
  const s = await kit.sql();
  const r = await s`SELECT a.application_id, a.member, a.kind, a.round, a.status, a.created, a.created_by
    FROM recruit_assignments a JOIN recruit_applications p ON p.id = a.application_id
    WHERE p.cycle_id = ${cycle.id} AND (${member}::text IS NULL OR a.member = ${member}) AND (${kind}::text IS NULL OR a.kind = ${kind})
    ORDER BY a.created, a.application_id, a.member`;
  return r.rows.map(asRow);
}

async function listScores(kit, cycle, { kind = 'review', ids = null, member = null } = {}) {
  if (kit.mode === 'memory') {
    const cycleIds = cycleAppIds(kit, cycle);
    return (kit.mem.scores || []).filter((x) => cycleIds.has(x.applicationId) && x.kind === kind && (!ids || ids.includes(x.applicationId)) && (!member || x.member === member)).map((x) => ({ ...x }));
  }
  const s = await kit.sql();
  const r = await s`SELECT s.application_id, s.member, s.kind, s.round, s.rubric_version, s.created, s.updated, s.submitted, s.doc
    FROM recruit_scores s JOIN recruit_applications p ON p.id = s.application_id
    WHERE p.cycle_id = ${cycle.id} AND s.kind = ${kind} AND (${ids}::text[] IS NULL OR s.application_id = ANY(${ids}::text[])) AND (${member}::text IS NULL OR s.member = ${member})`;
  return r.rows.map(scoreRow);
}

async function coiPairs(kit, cycle) {
  const pairs = new Set();
  for (const a of await listAssignments(kit, cycle)) if (a.status === 'coi') pairs.add(a.applicationId + '|' + a.member);
  for (const x of await listScores(kit, cycle)) if (x.doc?.conflict) pairs.add(x.applicationId + '|' + x.member);
  return pairs;
}

async function insertAssignments(kit, cycle, pairs, { kind, round, by, now }) {
  if (!pairs.length) return 0;
  if (kit.mode === 'memory') {
    const ids = cycleAppIds(kit, cycle);
    let created = 0;
    kit.mem.assignments ||= [];
    for (const p of pairs) {
      if (!ids.has(p.applicationId)) continue;
      if (kit.mem.assignments.some((a) => a.applicationId === p.applicationId && a.member === p.member && a.kind === kind && a.round === round)) continue;
      kit.mem.assignments.push({ applicationId: p.applicationId, member: p.member, kind, round, status: 'open', created: now, createdBy: by });
      created += 1;
    }
    kit.memSave();
    return created;
  }
  const s = await kit.sql();
  const r = await s`INSERT INTO recruit_assignments (application_id, member, kind, round, status, created, created_by)
    SELECT r.application_id, r.member, ${kind}, ${round}, 'open', ${now}, ${by}
    FROM jsonb_to_recordset(${JSON.stringify(pairs.map((p) => ({ application_id: p.applicationId, member: p.member })))}::jsonb) AS r(application_id text, member text)
    WHERE EXISTS (SELECT 1 FROM recruit_applications p WHERE p.id = r.application_id AND p.cycle_id = ${cycle.id})
    ON CONFLICT DO NOTHING RETURNING application_id`;
  return r.rowCount ?? r.rows.length;
}

async function hasAssignment(kit, app, member, kind, round) {
  if (kit.mode === 'memory') return (kit.mem.assignments || []).some((a) => a.applicationId === app && a.member === member && a.kind === kind && a.round === round && a.status !== 'coi');
  const s = await kit.sql();
  const r = await s`SELECT 1 FROM recruit_assignments WHERE application_id = ${app} AND member = ${member} AND kind = ${kind} AND round = ${round} AND status <> 'coi'`;
  return r.rows.length > 0;
}

// One statement: the score upsert and the assignment status ride together.
// The conflict-of-interest doc stores no scores and locks the row.
async function upsertScore(kit, { app, member, kind, round, rubricVersion, doc, submit, editAfterSubmit, now }) {
  const akind = ASSIGN_KIND[kind];
  const conflict = Boolean(doc.conflict);
  if (kit.mode === 'memory') {
    kit.mem.scores ||= [];
    const i = kit.mem.scores.findIndex((x) => x.applicationId === app && x.member === member && x.kind === kind && x.round === round);
    const prior = i >= 0 ? kit.mem.scores[i] : null;
    if (prior?.submitted && !editAfterSubmit) return null;
    const row = { applicationId: app, member, kind, round, rubricVersion, created: prior?.created ?? now, updated: now, submitted: prior?.submitted ?? (submit ? now : null), doc };
    if (i >= 0) kit.mem.scores[i] = row; else kit.mem.scores.push(row);
    for (const a of kit.mem.assignments || []) {
      if (a.applicationId !== app || a.member !== member || a.kind !== akind || a.round !== round) continue;
      if (conflict) a.status = 'coi'; else if (row.submitted) a.status = 'done';
    }
    kit.memSave();
    return { ...row };
  }
  const s = await kit.sql();
  const r = await s`WITH up AS (
      INSERT INTO recruit_scores (application_id, member, kind, round, rubric_version, created, updated, submitted, doc)
      VALUES (${app}, ${member}, ${kind}, ${round}, ${rubricVersion}, ${now}, ${now}, ${submit ? now : null}, ${JSON.stringify(doc)}::jsonb)
      ON CONFLICT (application_id, member, kind, round) DO UPDATE SET doc = EXCLUDED.doc, updated = EXCLUDED.updated, rubric_version = EXCLUDED.rubric_version,
        submitted = COALESCE(recruit_scores.submitted, EXCLUDED.submitted)
      WHERE recruit_scores.submitted IS NULL OR ${editAfterSubmit}
      RETURNING *),
    marked AS (
      UPDATE recruit_assignments SET status = CASE WHEN ${conflict} THEN 'coi' ELSE 'done' END
      WHERE application_id = ${app} AND member = ${member} AND kind = ${akind} AND round = ${round}
        AND EXISTS (SELECT 1 FROM up WHERE ${conflict} OR submitted IS NOT NULL))
    SELECT * FROM up`;
  return r.rows[0] ? scoreRow(r.rows[0]) : null;
}

async function markConflict(kit, { app, member, rubricVersion, note, now }) {
  const doc = { scores: {}, total: null, notes: note, recommendation: null, conflict: true };
  if (kit.mode === 'memory') {
    kit.mem.assignments ||= []; kit.mem.scores ||= [];
    const a = kit.mem.assignments.find((x) => x.applicationId === app && x.member === member && x.kind === 'reviewer' && x.round === '');
    if (a) a.status = 'coi'; else kit.mem.assignments.push({ applicationId: app, member, kind: 'reviewer', round: '', status: 'coi', created: now, createdBy: member });
    const i = kit.mem.scores.findIndex((x) => x.applicationId === app && x.member === member && x.kind === 'review' && x.round === '');
    const prior = i >= 0 ? kit.mem.scores[i] : null;
    const row = { applicationId: app, member, kind: 'review', round: '', rubricVersion, created: prior?.created ?? now, updated: now, submitted: prior?.submitted ?? now, doc };
    if (i >= 0) kit.mem.scores[i] = row; else kit.mem.scores.push(row);
    kit.memSave();
    return { ...row };
  }
  const s = await kit.sql();
  const r = await s`WITH a AS (
      INSERT INTO recruit_assignments (application_id, member, kind, round, status, created, created_by)
      VALUES (${app}, ${member}, 'reviewer', '', 'coi', ${now}, ${member})
      ON CONFLICT (application_id, member, kind, round) DO UPDATE SET status = 'coi' RETURNING application_id)
    INSERT INTO recruit_scores (application_id, member, kind, round, rubric_version, created, updated, submitted, doc)
    SELECT ${app}, ${member}, 'review', '', ${rubricVersion}, ${now}, ${now}, ${now}, ${JSON.stringify(doc)}::jsonb FROM a
    ON CONFLICT (application_id, member, kind, round) DO UPDATE SET doc = EXCLUDED.doc, updated = EXCLUDED.updated, submitted = COALESCE(recruit_scores.submitted, EXCLUDED.submitted)
    RETURNING *`;
  return r.rows[0] ? scoreRow(r.rows[0]) : null;
}

async function memberLoad(kit, cycle, kind) {
  const load = {};
  for (const a of await listAssignments(kit, cycle, { kind })) if (a.status !== 'coi') load[a.member] = (load[a.member] || 0) + 1;
  return load;
}

/* -------------------------------- routes -------------------------------- */

function requestIdOf(body) {
  const id = String(body?.requestId || '');
  if (!REQUEST_ID.test(id)) throw fail(400, 'A request id is required');
  return id;
}

function idsOf(input) {
  if (!Array.isArray(input) || !input.length) throw fail(400, 'Choose at least one application');
  if (input.length > MAX_IDS) throw fail(400, `Choose at most ${MAX_IDS} applications at a time`);
  const ids = [...new Set(input.map((v) => String(v)))];
  for (const id of ids) if (!APP_ID.test(id)) throw fail(400, 'Unknown application id');
  return ids;
}

const roundOf = (v) => {
  const round = String(v ?? '');
  if (!ROUND.test(round)) throw fail(400, 'Unknown round');
  return round;
};

function inScope(rq, app) {
  if (rq.scope && !rq.scope.has(app)) throw fail(404, 'No such application');
}

function subteamKey(cycle, value) {
  const list = Array.isArray(cycle?.doc?.subteams) ? cycle.doc.subteams : [];
  const v = String(value || '');
  if (!v) return '';
  return list.find((s) => s.key === v || s.name === v)?.key || slug(v);
}

async function rosterNames(kit) {
  try {
    const roster = await kit.roles.roster();
    return Object.fromEntries((roster || []).map((u) => [String(u.email).toLowerCase(), u.name || u.email]));
  } catch { return {}; }
}

async function getAssignments(rq, kit) {
  const { cycle, me, role } = rq;
  const lead = isLead(role);
  const member = lead ? (rq.query?.member ? String(rq.query.member).toLowerCase() : null) : me.email;
  const assignments = (await listAssignments(kit, cycle, { member })).map((a) => ({ applicationId: a.applicationId, member: a.member, kind: a.kind, round: a.round, status: a.status, created: a.created }));
  if (!lead) return { status: 200, body: { assignments, load: [] } };
  const names = await rosterNames(kit);
  const byMember = {};
  for (const a of await listAssignments(kit, cycle)) {
    const m = (byMember[a.member] ||= { member: a.member, name: names[a.member] || a.member, assigned: 0, done: 0, coi: 0, totals: [] });
    if (a.status === 'coi') m.coi += 1; else { m.assigned += 1; if (a.status === 'done') m.done += 1; }
  }
  for (const x of await listScores(kit, cycle)) {
    if (!x.submitted || x.doc?.conflict || typeof x.doc?.total !== 'number') continue;
    (byMember[x.member] ||= { member: x.member, name: names[x.member] || x.member, assigned: 0, done: 0, coi: 0, totals: [] }).totals.push(x.doc.total);
  }
  const load = Object.values(byMember).sort((a, b) => a.member.localeCompare(b.member)).map(({ totals, ...m }) => ({ ...m, mean: totals.length ? round2(totals.reduce((a, b) => a + b, 0) / totals.length) : null }));
  return { status: 200, body: { assignments, load } };
}

async function createAssignments(rq, kit) {
  const { cycle, me } = rq;
  const settings = settingsOf(cycle);
  const body = await rq.body();
  const requestId = requestIdOf(body);
  const ids = idsOf(body.ids);
  const kindIn = String(body.kind || 'reviewer');
  const kind = ASSIGN_KIND[kindIn] || kindIn;
  if (kind !== 'reviewer' && kind !== 'interviewer') throw fail(400, 'Assignments are for reviewers or interviewers');
  const round = roundOf(body.round);
  const mode = body.mode === 'manual' ? 'manual' : 'round-robin';
  if (!Array.isArray(body.members) || !body.members.length) throw fail(400, 'Choose at least one reviewer');
  if (body.members.length > 100) throw fail(400, 'Choose at most 100 reviewers');
  const emails = [...new Set(body.members.map((m) => clip(m, 200).toLowerCase()))];
  for (const e of emails) if (!EMAIL.test(e)) throw fail(400, 'Reviewers are chosen by email');
  const perApplication = Number(body.perApplication ?? settings.perApplication);
  if (!Number.isInteger(perApplication) || perApplication < 1 || perApplication > 10) throw fail(400, 'Reviewers per application is a whole number from 1 to 10');
  const bySubteam = body.bySubteam === true;
  const apps = (await loadApps(kit, cycle, ids)).map((a) => ({ ...a, subteam: subteamKey(cycle, a.subteam) }));
  const unknown = ids.length - apps.length;
  const members = [];
  for (const email of emails) {
    let subteams = [];
    if (bySubteam) { const grant = await kit.roles.grantFor(cycle.id, email); subteams = Array.isArray(grant?.subteams) ? grant.subteams : []; }
    members.push({ email, subteams });
  }
  const coi = await coiPairs(kit, cycle);
  const skipped = [];
  let plan;
  if (mode === 'manual') {
    plan = [];
    for (const app of apps) for (const m of members) {
      if (coi.has(app.id + '|' + m.email) || String(app.email).toLowerCase() === m.email) { skipped.push({ applicationId: app.id, member: m.email, reason: 'Conflict of interest' }); continue; }
      if (bySubteam && m.subteams.length && app.subteam && !m.subteams.includes(app.subteam)) continue;
      plan.push({ applicationId: app.id, member: m.email });
    }
  } else {
    const load = await memberLoad(kit, cycle, kind);
    plan = planAssignments({ applications: apps, members, load, perApplication, bySubteam, coi });
  }
  if (body.dryRun === true) return { status: 200, body: { created: 0, existing: 0, plan, skipped, unknown } };
  const result = await kit.once(requestId, me.email, async () => {
    const created = await insertAssignments(kit, cycle, plan, { kind, round, by: me.email, now: kit.now() });
    await kit.audit({ cycleId: cycle.id, applicationId: null, actor: me.email, kind: 'assign', detail: { requestId, kind, round, mode, planned: plan.length, created } });
    return { created, existing: plan.length - created, plan, skipped, unknown };
  });
  return { status: 200, body: result };
}

async function deleteAssignment(rq, kit) {
  const { cycle, me, params } = rq;
  const kind = ASSIGN_KIND[params.kind];
  const member = String(params.member).toLowerCase();
  const round = roundOf(params.round);
  let removed = false;
  if (kit.mode === 'memory') {
    const ids = cycleAppIds(kit, cycle);
    const before = (kit.mem.assignments || []).length;
    kit.mem.assignments = (kit.mem.assignments || []).filter((a) => !(ids.has(a.applicationId) && a.applicationId === params.app && a.member === member && a.kind === kind && a.round === round));
    removed = kit.mem.assignments.length < before;
    if (removed) kit.memSave();
  } else {
    const s = await kit.sql();
    const r = await s`DELETE FROM recruit_assignments WHERE application_id = ${params.app} AND member = ${member} AND kind = ${kind} AND round = ${round}
      AND EXISTS (SELECT 1 FROM recruit_applications p WHERE p.id = ${params.app} AND p.cycle_id = ${cycle.id}) RETURNING application_id`;
    removed = r.rows.length > 0;
  }
  if (!removed) throw fail(404, 'No such assignment');
  return { status: 200, body: { ok: true }, audit: { kind: 'unassign', target: params.app, detail: { member, kind, round } } };
}

async function putScore(rq, kit) {
  const { cycle, me, role, params } = rq;
  if (cycle.status === 'closed' || cycle.status === 'archived') throw fail(409, 'This cycle is closed');
  const app = params.app;
  inScope(rq, app);
  const application = await kit.apps.get(cycle, app);
  if (!application || (application.cycleId && application.cycleId !== cycle.id)) throw fail(404, 'No such application');
  const settings = settingsOf(cycle);
  const kind = params.kind;
  const round = roundOf(rq.query?.round);
  if (!isLead(role) && settings.visibility !== 'all' && !(await hasAssignment(kit, app, me.email, ASSIGN_KIND[kind], round))) throw fail(403, 'You are not assigned to this application');
  const body = await rq.body();
  const rubric = rubricFor(cycle, kind, round);
  if (body.rubricVersion !== undefined && Number(body.rubricVersion) !== rubric.version) throw fail(409, 'The rubric changed. Reload.');
  const conflict = body.conflict === true;
  const notes = clipText(body.notes, 4000);
  const recommendation = body.recommendation == null || body.recommendation === '' ? null : String(body.recommendation);
  if (recommendation && !RECOMMENDATIONS.has(recommendation)) throw fail(400, 'Unknown recommendation');
  let submit = body.submit === true;
  let doc;
  if (conflict) {
    doc = { scores: {}, total: null, notes, recommendation: null, conflict: true };
    submit = true;
  } else {
    const { scores, total } = computeTotal(rubric, body.scores);
    if (submit && rubric.criteria.some((c) => scores[c.key] === undefined)) throw fail(400, 'Score every criterion before submitting');
    doc = { scores, total, notes, recommendation, conflict: false };
  }
  const row = await upsertScore(kit, { app, member: me.email, kind, round, rubricVersion: rubric.version, doc, submit, editAfterSubmit: settings.editAfterSubmit === true, now: kit.now() });
  if (!row) throw fail(409, 'This scorecard was submitted and is locked');
  const aggregate = canSeeOthers(role, settings, row) ? aggregateOf(await listScores(kit, cycle, { kind, ids: [app] })) : null;
  return { status: 200, body: { score: row, aggregate }, audit: { kind: 'score', target: app, detail: { kind, round, submitted: Boolean(row.submitted), conflict } } };
}

async function getScores(rq, kit) {
  const { cycle, me, role, params } = rq;
  const app = params.app;
  inScope(rq, app);
  const application = await kit.apps.get(cycle, app);
  if (!application || (application.cycleId && application.cycleId !== cycle.id)) throw fail(404, 'No such application');
  const settings = settingsOf(cycle);
  const kind = rq.query?.kind === 'interview' ? 'interview' : 'review';
  const round = roundOf(rq.query?.round);
  const rows = (await listScores(kit, cycle, { kind, ids: [app] })).filter((x) => x.round === round);
  const mine = rows.find((x) => x.member === me.email) || null;
  const visible = canSeeOthers(role, settings, mine);
  const others = visible ? rows.filter((x) => x.member !== me.email && x.submitted && !x.doc?.conflict) : null;
  return { status: 200, body: { mine, others, aggregate: visible ? aggregateOf(rows) : null, rubric: rubricFor(cycle, kind, round), blind: settings.blind } };
}

async function summary(rq, kit) {
  const { cycle } = rq;
  const kind = rq.query?.kind === 'interview' ? 'interview' : 'review';
  const stage = rq.query?.stage ? String(rq.query.stage) : null;
  let apps;
  if (kit.mode === 'memory') {
    apps = cycleApps(kit, cycle).filter((a) => !stage || a.stage === stage).map((a) => ({ id: a.id, name: a.name, subteam: a.subteam || '', ts: Number(a.ts) }));
  } else {
    const s = await kit.sql();
    const r = await s`SELECT id, name, subteam, ts FROM recruit_applications WHERE cycle_id = ${cycle.id} AND (${stage}::text IS NULL OR stage = ${stage}) ORDER BY ts, id LIMIT 5000`;
    apps = r.rows.map((a) => ({ id: a.id, name: a.name, subteam: a.subteam || '', ts: Number(a.ts) }));
  }
  const scores = (await listScores(kit, cycle, { kind })).filter((x) => x.submitted && !x.doc?.conflict && typeof x.doc?.total === 'number');
  const byApp = {};
  for (const x of scores) (byApp[x.applicationId] ||= []).push(x);
  const rows = apps.map((a) => {
    const mine = byApp[a.id] || [];
    const agg = aggregateOf(mine);
    return { id: a.id, name: a.name, subteam: a.subteam, n: agg?.n || 0, mean: agg?.mean ?? null, spread: agg?.spread ?? null, byMember: Object.fromEntries(mine.map((x) => [x.member, x.doc.total])) };
  });
  const byMember = {};
  for (const x of scores) (byMember[x.member] ||= []).push(x.doc.total);
  const members = Object.entries(byMember).sort(([a], [b]) => a.localeCompare(b)).map(([email, totals]) => {
    const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
    const sd = Math.sqrt(totals.reduce((a, t) => a + (t - mean) ** 2, 0) / totals.length);
    return { email, n: totals.length, mean: round2(mean), sd: round2(sd) };
  });
  return { status: 200, body: { rows, members } };
}

async function coi(rq, kit) {
  const { cycle, me, params } = rq;
  const app = params.app;
  inScope(rq, app);
  const application = await kit.apps.get(cycle, app);
  if (!application || (application.cycleId && application.cycleId !== cycle.id)) throw fail(404, 'No such application');
  const body = await rq.body();
  const note = clipText(body.note, 300);
  const row = await markConflict(kit, { app, member: me.email, rubricVersion: rubricFor(cycle, 'review', '').version, note, now: kit.now() });
  return { status: 200, body: { ok: true, score: row }, audit: { kind: 'coi', target: app, detail: {} } };
}

/* --------------------------- hooks and collectors ------------------------ */

async function onStageMoved(ev, kit) {
  const stages = Array.isArray(ev.cycle?.doc?.pipeline?.stages) ? ev.cycle.doc.pipeline.stages : [];
  const stage = stages.find((s) => s.key === ev.to);
  if (!stage || stage.kind !== 'closed' || !ev.application) return;
  if (kit.mode === 'memory') {
    let changed = false;
    for (const a of kit.mem.assignments || []) if (a.applicationId === ev.application && a.status === 'open') { a.status = 'done'; changed = true; }
    if (changed) kit.memSave();
    return;
  }
  const s = await kit.sql();
  await s`UPDATE recruit_assignments SET status = 'done' WHERE application_id = ${ev.application} AND status = 'open'`;
}

async function onBookingCreated(ev, kit) {
  const booking = ev.booking || {};
  const interviewers = Array.isArray(ev.slot?.interviewers) ? ev.slot.interviewers : Array.isArray(ev.interviewers) ? ev.interviewers : [];
  if (!booking.applicationId || !interviewers.length || !ev.cycle) return;
  await insertAssignments(kit, ev.cycle, interviewers.map((m) => ({ applicationId: booking.applicationId, member: String(m).toLowerCase() })),
    { kind: 'interviewer', round: roundOf(booking.round), by: 'system', now: kit.now() });
}

async function scopeApplications({ cycle, me, role }, kit) {
  const settings = settingsOf(cycle);
  if (settings.visibility !== 'assigned' && (!role || role === 'reviewer')) {
    if (kit.mode === 'memory') return cycleAppIds(kit, cycle);
    const s = await kit.sql();
    const r = await s`SELECT id FROM recruit_applications WHERE cycle_id = ${cycle.id}`;
    return new Set(r.rows.map((x) => x.id));
  }
  if (kit.mode === 'memory') return new Set((await listAssignments(kit, cycle, { member: me.email })).filter((a) => a.status !== 'coi').map((a) => a.applicationId));
  const s = await kit.sql();
  const r = await s`SELECT a.application_id FROM recruit_assignments a JOIN recruit_applications p ON p.id = a.application_id
    WHERE p.cycle_id = ${cycle.id} AND a.member = ${me.email} AND a.status <> 'coi'`;
  return new Set(r.rows.map((x) => x.application_id));
}

async function applicationExtras({ cycle, ids, me, role }, kit) {
  const out = {};
  if (!Array.isArray(ids) || !ids.length) return out;
  const settings = settingsOf(cycle);
  const scores = await listScores(kit, cycle, { kind: 'review', ids });
  const byApp = {};
  for (const x of scores) (byApp[x.applicationId] ||= []).push(x);
  for (const id of ids) {
    const rows = byApp[id] || [];
    const mine = rows.find((x) => x.member === me?.email) || null;
    const agg = aggregateOf(rows);
    out[id] = { score: { mine: mine && !mine.doc?.conflict ? mine.doc?.total ?? null : null, n: agg?.n || 0, mean: canSeeOthers(role, settings, mine) ? agg?.mean ?? null : null } };
  }
  if (isLead(role)) {
    const byId = {};
    for (const a of await listAssignments(kit, cycle, { kind: 'reviewer' })) if (a.status !== 'coi' && ids.includes(a.applicationId)) (byId[a.applicationId] ||= []).push(a.member);
    for (const id of ids) out[id].assigned = byId[id] || [];
  }
  return out;
}

async function purge({ ids }, kit) {
  if (!Array.isArray(ids) || !ids.length) return;
  if (kit.mode === 'memory') {
    for (const x of kit.mem.scores || []) if (ids.includes(x.applicationId) && x.doc) x.doc.notes = '';
    kit.memSave();
    return;
  }
  const s = await kit.sql();
  await s`UPDATE recruit_scores SET doc = jsonb_set(doc, '{notes}', '""'::jsonb) WHERE application_id = ANY(${ids}::text[])`;
}

export default {
  name: 'review',
  kernel: false,
  order: 50,
  schema: [
    `CREATE TABLE IF NOT EXISTS recruit_assignments (application_id text NOT NULL, member text NOT NULL, kind text NOT NULL, round text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'open', created bigint, created_by text, PRIMARY KEY (application_id, member, kind, round))`,
    `CREATE INDEX IF NOT EXISTS recruit_assignments_member ON recruit_assignments (member, kind)`,
    `CREATE TABLE IF NOT EXISTS recruit_scores (application_id text NOT NULL, member text NOT NULL, kind text NOT NULL, round text NOT NULL DEFAULT '', rubric_version int NOT NULL DEFAULT 1, created bigint, updated bigint, submitted bigint, doc jsonb NOT NULL DEFAULT '{}', PRIMARY KEY (application_id, member, kind, round))`,
  ],
  memory: { assignments: [], scores: [] },
  defaults,
  validateSettings,
  routes: [
    { method: 'GET', path: '/cycles/:cycle/assignments', access: 'reviewer', handler: getAssignments },
    { method: 'POST', path: '/cycles/:cycle/assignments', access: 'lead', mutates: true, cap: 262144, handler: createAssignments },
    { method: 'DELETE', path: '/cycles/:cycle/assignments/:app/:member/:kind/:round', access: 'lead', mutates: true, handler: deleteAssignment },
    { method: 'PUT', path: '/cycles/:cycle/applications/:app/scores/:kind', access: 'reviewer', scoped: true, mutates: true, cap: 65536, handler: putScore },
    { method: 'GET', path: '/cycles/:cycle/applications/:app/scores', access: 'reviewer', scoped: true, handler: getScores },
    { method: 'GET', path: '/cycles/:cycle/scores/summary', access: 'lead', handler: summary },
    { method: 'POST', path: '/cycles/:cycle/applications/:app/coi', access: 'role', scoped: true, mutates: true, cap: 4096, handler: coi },
  ],
  hooks: { 'stage.moved': onStageMoved, 'booking.created': onBookingCreated },
  collect: {
    'scope.applications': scopeApplications,
    'application.extras': applicationExtras,
    'csv.columns': async () => [
      { header: 'Score mean', cell: (row, extras) => extras?.score?.mean ?? '' },
      { header: 'Scores', cell: (row, extras) => extras?.score?.n ?? '' },
      { header: 'Reviewers', cell: (row, extras) => (extras?.assigned || []).join('; ') },
    ],
    purge,
  },
  auditKinds: ['assign', 'unassign', 'score', 'coi'],
};
