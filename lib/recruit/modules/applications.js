// Applications module (kernel): the application records and applicant
// identity, the intake commit (one statement with the receipt), the review
// column ported verbatim from interest.js, the list projection (keyset
// cursor, filters in SQL, reviewer scope by id intersection), files, erase
// and the pending queue. Every write to stage/outcome/decision/tags/
// edit_version in the whole system goes through kit.apps.* from here.

import { createHash } from 'node:crypto';
import { validateAnswers, fixedFormFor, DEFAULT_STAGES, FILE_TYPES, MAX_FILE, EMAIL_RE, isCornell, slug, YEARS, COLUMN_KEYS } from '../fixed-form.js';
import { sectionsFor, formForRow } from '../sections.js';

const REQUEST_ID = /^rq-[a-z0-9-]{8,80}$/;
const SORTS = { ts: { col: 'a.ts', dir: 'desc', kind: 'num' }, updated: { col: 'a.updated', dir: 'desc', kind: 'num' }, stage_at: { col: 'a.stage_at', dir: 'desc', kind: 'num' }, name: { col: 'lower(a.name)', dir: 'asc', kind: 'text' }, score: { col: 'COALESCE(sc.score, -1)', dir: 'desc', kind: 'num' } };
const PAGE_DEFAULT = 100;
const PAGE_MAX = 200;
const QUEUE_THROTTLE = 5 * 60000;

const fail = (status, error, extra = {}) => Object.assign(new Error(error), { status, error, ...extra });
const isObject = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const asArray = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? (() => { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } })() : []);
const asObject = (v) => (isObject(v) ? v : typeof v === 'string' ? (() => { try { const p = JSON.parse(v); return isObject(p) ? p : {}; } catch { return {}; } })() : {});
const num = (v) => (v == null ? null : Number(v));
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const hash = (s) => createHash('sha256').update(String(s || '').toLowerCase()).digest('hex').slice(0, 24);
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const stripId = (rid) => String(rid).replace(/[^a-z0-9]/g, '');

const appFromPg = (r) => ({
  id: r.id, cycleId: r.cycle_id, email: r.email, ts: Number(r.ts), updated: Number(r.updated), name: r.name, cornell: Boolean(r.cornell),
  subteam: r.subteam || '', year: r.year || null, source: r.source || 'form', formVersion: Number(r.form_version || 0), section: r.section || 'interest',
  answers: asObject(r.answers), files: asArray(r.files), stage: r.stage, stageAt: Number(r.stage_at || 0), stageHistory: asArray(r.stage_history),
  outcome: r.outcome || null, decision: asObject(r.decision), tags: asArray(r.tags), review: asObject(r.review),
  reviewVersion: Number(r.review_version || 0), editVersion: Number(r.edit_version || 0),
  onboardedAt: num(r.onboarded_at), erasedAt: num(r.erased_at), receiptId: r.receipt_id || null,
});
// Memory rows carry ipHash; it never leaves storage.
const project = (row) => { if (!row) return null; const { ipHash, ...rest } = row; return clone(rest); };
const applicantFromPg = (r) => ({ email: r.email, name: r.name, cornell: Boolean(r.cornell), firstSeen: Number(r.first_seen), lastSeen: Number(r.last_seen), applications: Number(r.applications || 0), erasedAt: num(r.erased_at), doc: asObject(r.doc) });

const stagesOf = (cycle) => (Array.isArray(cycle?.doc?.pipeline?.stages) && cycle.doc.pipeline.stages.length ? cycle.doc.pipeline.stages : DEFAULT_STAGES);
const firstStageOf = (cycle) => stagesOf(cycle)[0]?.key || 'applied';
const outcomeOf = (cycle, key) => { const s = stagesOf(cycle).find((x) => x.key === key); return s && s.kind !== 'open' ? s.outcome || null : null; };
// Subteam values may arrive as keys or names; the column holds the name.
const subteamNames = (cycle, values) => {
  const list = Array.isArray(cycle?.doc?.subteams) ? cycle.doc.subteams : [];
  const out = new Set();
  for (const v of values || []) {
    const s = slug(v);
    const match = list.find((x) => x.key === v || x.name === v || slug(x.name) === s || x.key === s);
    out.add(match ? match.name : String(v));
    if (match) out.add(match.key);
  }
  return [...out];
};

export const toLegacyRow = (app) => {
  if (!app) return null;
  const f = (app.files || [])[0] || null;
  return {
    id: app.id, ts: Number(app.ts), updated: Number(app.updated), name: app.name, email: app.email, subteam: app.subteam || '',
    project: String(app.answers?.project ?? ''), cornell: Boolean(app.cornell), year: app.year || null,
    fileId: f?.id || null, fileName: f?.name || null, fileType: f?.type || null, fileSize: f?.size == null ? null : Number(f.size),
    ...(Number(app.reviewVersion) ? { review: app.review, reviewVersion: Number(app.reviewVersion) } : {}),
  };
};

/* ------------------------------- facade -------------------------------- */

function makeFacade(kit) {
  const memApps = () => kit.mem.applications;

  async function get(cycle, id) {
    const cycleId = typeof cycle === 'string' ? cycle : cycle?.id || null;
    if (!id) return null;
    if (kit.mode === 'memory') {
      const row = memApps().find((a) => a.id === id && (!cycleId || a.cycleId === cycleId));
      return project(row);
    }
    const s = await kit.sql();
    const r = cycleId
      ? await s`SELECT * FROM recruit_applications WHERE id = ${id} AND cycle_id = ${cycleId}`
      : await s`SELECT * FROM recruit_applications WHERE id = ${id}`;
    return r.rows[0] ? appFromPg(r.rows[0]) : null;
  }

  const sectionOf = (a) => a.section || 'interest';

  async function allByEmail(cycleId, email) {
    if (kit.mode === 'memory') return memApps().filter((a) => a.cycleId === cycleId && a.email === email).map(project);
    const s = await kit.sql();
    const r = await s`SELECT * FROM recruit_applications WHERE cycle_id = ${cycleId} AND email = ${email} ORDER BY ts ASC`;
    return r.rows.map(appFromPg);
  }

  async function findByEmail(cycleId, email, section = 'interest') {
    if (kit.mode === 'memory') return project(memApps().find((a) => a.cycleId === cycleId && a.email === email && sectionOf(a) === section));
    const s = await kit.sql();
    const r = await s`SELECT * FROM recruit_applications WHERE cycle_id = ${cycleId} AND section = ${section} AND email = ${email}`;
    return r.rows[0] ? appFromPg(r.rows[0]) : null;
  }

  async function count(cycleId, section = null) {
    if (kit.mode === 'memory') return memApps().filter((a) => a.cycleId === cycleId && (!section || sectionOf(a) === section)).length;
    const s = await kit.sql();
    const r = section
      ? await s`SELECT count(*) AS n FROM recruit_applications WHERE cycle_id = ${cycleId} AND section = ${section}`
      : await s`SELECT count(*) AS n FROM recruit_applications WHERE cycle_id = ${cycleId}`;
    return Number(r.rows[0]?.n || 0);
  }

  // Every row of one section, newest first, for the CSV export.
  async function exportRows(cycleId, section) {
    if (kit.mode === 'memory') return memApps().filter((a) => a.cycleId === cycleId && sectionOf(a) === section).sort((a, b) => b.ts - a.ts).slice(0, 10000).map(project);
    const s = await kit.sql();
    const r = await s`SELECT * FROM recruit_applications WHERE cycle_id = ${cycleId} AND section = ${section} ORDER BY ts DESC LIMIT 10000`;
    return r.rows.map(appFromPg);
  }

  // Ids in a cycle, optionally narrowed to subteams (keys or names).
  async function ids(cycleId, { subteams = null, cycle = null } = {}) {
    let names = null;
    if (subteams && subteams.length) names = subteamNames(cycle || await kit.cycles.get(cycleId), subteams);
    if (kit.mode === 'memory') return new Set(memApps().filter((a) => a.cycleId === cycleId && (!names || names.includes(a.subteam))).map((a) => a.id));
    const s = await kit.sql();
    const q = kit.build();
    q`SELECT id FROM recruit_applications WHERE cycle_id = ${cycleId}`;
    if (names) q` AND subteam = ANY(${names})`;
    return new Set((await q.run(s)).rows.map((r) => r.id));
  }

  async function receiptOutcome(id) {
    if (kit.mode === 'memory') return kit.mem.receipts[id] || null;
    const s = await kit.sql();
    const r = await s`SELECT outcome FROM interest_receipts WHERE id = ${id}`;
    return r.rows[0]?.outcome || null;
  }

  async function recordOutcome(entry, outcome, override = false) {
    if (kit.mode === 'memory') {
      const m = kit.mem;
      if (!m.receipts[entry.id] || (override && ['review', 'held'].includes(m.receipts[entry.id]))) m.receipts[entry.id] = outcome;
      kit.memSave();
      return m.receipts[entry.id];
    }
    const s = await kit.sql();
    if (override) {
      await s`INSERT INTO interest_receipts (id, outcome, ts) VALUES (${entry.id}, ${outcome}, ${entry.ts})
        ON CONFLICT (id) DO UPDATE SET outcome = EXCLUDED.outcome WHERE interest_receipts.outcome IN ('review', 'held')`;
    } else {
      await s`INSERT INTO interest_receipts (id, outcome, ts) VALUES (${entry.id}, ${outcome}, ${entry.ts}) ON CONFLICT DO NOTHING`;
    }
    return receiptOutcome(entry.id);
  }

  function upsertApplicantMem(row, inserted) {
    const m = kit.mem;
    const prior = m.applicants.find((p) => p.email === row.email);
    if (prior) {
      prior.name = row.name; prior.lastSeen = Math.max(prior.lastSeen || 0, row.updated); prior.cornell = prior.cornell || row.cornell;
      if (inserted) prior.applications = (prior.applications || 0) + 1;
    } else {
      m.applicants.push({ email: row.email, name: row.name, cornell: row.cornell, firstSeen: row.ts, lastSeen: row.updated, applications: 1, erasedAt: null, doc: { tags: [], note: '', memberEmail: '' } });
    }
  }

  // The intake commit. Idempotent by receipt; upsert by (cycle, email) only
  // when the applicant confirmed and the incoming submission is not older;
  // review/stage/tags/decision/edit_version are never in the SET list.
  async function commitIntake(cycle, entry, journal, originalFile = null, { confirmUpdate = Boolean(entry.confirmUpdate), override = false, source = 'form' } = {}) {
    const rid = entry.id;
    const overridable = (o) => override && ['review', 'held'].includes(o);
    const prior = await receiptOutcome(rid);
    if (prior && !overridable(prior)) return { outcome: prior };
    const email = String(entry.email || '').toLowerCase();
    const section = entry.section || 'interest';
    const existing = await findByEmail(cycle.id, email, section);
    if (existing && !confirmUpdate) return { outcome: await recordOutcome(entry, 'review', override), existing };
    if (existing && existing.updated > entry.ts) return { outcome: await recordOutcome(entry, 'superseded', override), existing };
    let fileEntry = null;
    if (entry.fileSize) {
      const data = originalFile?.data || await journal.getFile(entry.id);
      if (!data || data.length !== entry.fileSize) throw new Error('Saved attachment is not available yet');
      const fileId = 'int-' + stripId(entry.id);
      await kit.files.put({ id: fileId, name: entry.fileName, type: entry.fileType, size: data.length, by: email, ts: entry.ts, data });
      fileEntry = { id: fileId, question: 'file', name: entry.fileName, type: entry.fileType, size: entry.fileSize };
    }
    const answers = { ...(isObject(entry.answers) ? entry.answers : {}), ...(entry.project !== undefined ? { project: String(entry.project ?? '') } : {}) };
    const row = {
      id: existing?.id || 'in-' + stripId(rid), cycleId: cycle.id, section, email, ts: existing?.ts || entry.ts, updated: entry.ts,
      name: entry.name, cornell: isCornell(email), subteam: entry.subteam || '', year: entry.hasYear ? (entry.year || null) : (existing?.year ?? null),
      source: existing?.source || source, formVersion: Number(entry.formVersion ?? cycle.formVersion ?? 0),
      answers: { ...(existing?.answers || {}), ...answers }, files: fileEntry ? [fileEntry] : (existing?.files || []),
      stage: existing?.stage || firstStageOf(cycle), stageAt: existing?.stageAt || entry.ts,
      stageHistory: existing?.stageHistory || [{ stage: firstStageOf(cycle), at: entry.ts, by: 'applicant' }],
      outcome: existing?.outcome ?? null, decision: existing?.decision || {}, tags: existing?.tags || [],
      review: existing?.review || {}, reviewVersion: existing?.reviewVersion || 0, editVersion: existing?.editVersion || 0,
      onboardedAt: existing?.onboardedAt ?? null, erasedAt: null, receiptId: rid, ipHash: entry.ipHash || '',
    };
    let outcome, inserted = false;
    if (kit.mode === 'memory') {
      // No asynchronous work between the final check and the durable local write.
      const m = kit.mem;
      const current = memApps().find((a) => a.cycleId === cycle.id && a.email === email && sectionOf(a) === section);
      if (m.receipts[rid] && !overridable(m.receipts[rid])) return { outcome: m.receipts[rid] };
      if (current && !confirmUpdate) outcome = 'review';
      else if (current && current.updated > entry.ts) outcome = 'superseded';
      else {
        if (current) {
          // Applicant updates never replace the team's review or pipeline state.
          Object.assign(current, {
            name: row.name, subteam: row.subteam, updated: row.updated, ipHash: row.ipHash, formVersion: row.formVersion,
            year: entry.hasYear ? (entry.year || null) : current.year, answers: { ...(current.answers || {}), ...answers },
            files: fileEntry ? [fileEntry] : current.files, receiptId: rid,
          });
        } else { memApps().push(row); inserted = true; }
        upsertApplicantMem(row, inserted);
        outcome = 'saved';
      }
      m.receipts[rid] = outcome; kit.memSave();
      const saved = memApps().find((a) => a.cycleId === cycle.id && a.email === email && sectionOf(a) === section);
      return { outcome, existing, row: project(saved) || project(row), inserted };
    }
    const s = await kit.sql();
    const r = await s`WITH prior AS (
      SELECT outcome FROM interest_receipts WHERE id = ${rid} AND NOT (${override} AND outcome IN ('review', 'held'))
    ), written AS (
      INSERT INTO recruit_applications (id, cycle_id, section, email, ts, updated, name, cornell, subteam, year, source, form_version, answers, files, stage, stage_at, stage_history, ip_hash, receipt_id)
      SELECT ${row.id}, ${row.cycleId}, ${section}, ${row.email}, ${row.ts}, ${row.updated}, ${row.name}, ${row.cornell}, ${row.subteam}, ${row.year}, ${row.source}, ${row.formVersion},
        ${JSON.stringify(answers)}::jsonb, ${JSON.stringify(fileEntry ? [fileEntry] : [])}::jsonb, ${row.stage}, ${row.ts}, ${JSON.stringify(row.stageHistory)}::jsonb, ${row.ipHash}, ${rid}
      WHERE NOT EXISTS (SELECT 1 FROM prior)
      ON CONFLICT (cycle_id, section, email) DO UPDATE SET name = EXCLUDED.name, subteam = EXCLUDED.subteam, updated = EXCLUDED.updated, ip_hash = EXCLUDED.ip_hash,
        year = CASE WHEN ${Boolean(entry.hasYear)} THEN EXCLUDED.year ELSE recruit_applications.year END,
        answers = recruit_applications.answers || EXCLUDED.answers,
        files = CASE WHEN jsonb_array_length(EXCLUDED.files) > 0 THEN EXCLUDED.files ELSE recruit_applications.files END,
        form_version = EXCLUDED.form_version, receipt_id = EXCLUDED.receipt_id
      WHERE ${confirmUpdate} AND recruit_applications.updated <= EXCLUDED.updated
      RETURNING id, (xmax = 0) AS inserted
    ), applicant AS (
      INSERT INTO recruit_applicants (email, name, cornell, first_seen, last_seen, applications)
      SELECT ${row.email}, ${row.name}, ${row.cornell}, ${row.ts}, ${row.updated}, 1 WHERE EXISTS (SELECT 1 FROM written)
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, last_seen = EXCLUDED.last_seen,
        applications = recruit_applicants.applications + (SELECT count(*) FROM written WHERE inserted)::int
    ), recorded AS (
      INSERT INTO interest_receipts (id, outcome, ts)
      SELECT ${rid}, CASE WHEN EXISTS (SELECT 1 FROM written) THEN 'saved' WHEN ${confirmUpdate} THEN 'superseded' ELSE 'review' END, ${entry.ts}
      WHERE NOT EXISTS (SELECT 1 FROM prior)
      ON CONFLICT (id) DO UPDATE SET outcome = EXCLUDED.outcome WHERE ${override} AND interest_receipts.outcome IN ('review', 'held')
      RETURNING outcome
    ) SELECT outcome, (SELECT bool_or(inserted) FROM written) AS inserted FROM recorded
      UNION ALL SELECT outcome, NULL FROM prior LIMIT 1`;
    outcome = r.rows[0]?.outcome || await receiptOutcome(rid);
    if (!outcome) throw new Error('The saved receipt could not be verified');
    inserted = Boolean(r.rows[0]?.inserted);
    const saved = outcome === 'saved' ? await findByEmail(cycle.id, email, section) : null;
    return { outcome, existing, row: saved || project(row), inserted };
  }

  // One statement per id: the move, its history entry and the audit row.
  // Returns { from, editVersion } or null when nothing changed.
  async function move(cycle, { id, to, from = null, outcome, by, requestId = null, note = '', now = kit.now() }) {
    const target = outcome === undefined ? outcomeOf(cycle, to) : outcome;
    const entry = { stage: to, at: now, by, ...(requestId ? { requestId } : {}), ...(note ? { note: String(note).slice(0, 500) } : {}) };
    if (kit.mode === 'memory') {
      const row = memApps().find((a) => a.id === id && a.cycleId === cycle.id);
      if (!row || row.stage === to || (from !== null && row.stage !== from)) return null;
      const prev = row.stage;
      row.stage = to; row.stageAt = now; row.outcome = target;
      row.stageHistory = [...(row.stageHistory || []).slice(-199), entry];
      row.editVersion = (row.editVersion || 0) + 1;
      kit.mem.audit.push({ id: kit.id('au'), ts: now, cycleId: cycle.id, applicationId: id, actor: by, kind: 'stage', detail: { from: prev, to, requestId } });
      kit.memSave();
      return { id, from: prev, to, editVersion: row.editVersion };
    }
    const s = await kit.sql();
    const auId = kit.id('au');
    const r = await s`WITH moved AS (UPDATE recruit_applications SET stage = ${to}, stage_at = ${now}, outcome = ${target},
        stage_history = (CASE WHEN jsonb_array_length(stage_history) >= 200 THEN stage_history - 0 ELSE stage_history END) || ${JSON.stringify([entry])}::jsonb,
        edit_version = edit_version + 1
      WHERE id = ${id} AND cycle_id = ${cycle.id} AND stage <> ${to} AND (${from}::text IS NULL OR stage = ${from})
      RETURNING id, edit_version, (SELECT stage FROM recruit_applications WHERE id = ${id}) AS from_stage),
      audited AS (INSERT INTO recruit_audit (id, ts, cycle_id, application_id, actor, kind, detail)
        SELECT ${auId}, ${now}, ${cycle.id}, id, ${by}, 'stage', jsonb_build_object('from', from_stage, 'to', ${to}::text, 'requestId', ${requestId}::text) FROM moved)
      SELECT * FROM moved`;
    const row = r.rows[0];
    return row ? { id, from: row.from_stage, to, editVersion: Number(row.edit_version) } : null;
  }

  // Record a decision and move to its stage in one UPDATE per id.
  async function setDecision(cycle, { id, outcome, reason = '', subteam = '', stage, by, requestId = null, now = kit.now() }) {
    const target = stage || stagesOf(cycle).find((x) => x.kind !== 'open' && x.outcome === outcome)?.key;
    if (!target) return null;
    const decision = { outcome, reason: String(reason || '').slice(0, 2000), by, at: now, subteam: subteam || '' };
    const entry = { stage: target, at: now, by, ...(requestId ? { requestId } : {}) };
    if (kit.mode === 'memory') {
      const row = memApps().find((a) => a.id === id && a.cycleId === cycle.id);
      if (!row) return null;
      const prev = row.stage;
      if (row.stage !== target) { row.stage = target; row.stageAt = now; row.stageHistory = [...(row.stageHistory || []).slice(-199), entry]; }
      row.outcome = outcome; row.decision = decision; row.editVersion = (row.editVersion || 0) + 1;
      kit.memSave();
      return { id, from: prev, to: target, editVersion: row.editVersion };
    }
    const s = await kit.sql();
    const r = await s`UPDATE recruit_applications SET decision = ${JSON.stringify(decision)}::jsonb, outcome = ${outcome},
        stage_history = CASE WHEN stage <> ${target} THEN (CASE WHEN jsonb_array_length(stage_history) >= 200 THEN stage_history - 0 ELSE stage_history END) || ${JSON.stringify([entry])}::jsonb ELSE stage_history END,
        stage_at = CASE WHEN stage <> ${target} THEN ${now} ELSE stage_at END, stage = ${target}, edit_version = edit_version + 1
      WHERE id = ${id} AND cycle_id = ${cycle.id}
      RETURNING id, edit_version, (SELECT stage FROM recruit_applications WHERE id = ${id}) AS from_stage`;
    const row = r.rows[0];
    return row ? { id, from: row.from_stage, to: target, editVersion: Number(row.edit_version) } : null;
  }

  const mergeTags = (current, add = [], remove = []) => {
    const out = [];
    for (const t of [...(current || []), ...add]) if (!remove.includes(t) && !out.includes(t)) out.push(t);
    return out;
  };
  const validTags = (list) => {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) throw fail(400, 'Tags must be a list');
    const tags = [...new Set(list.map((t) => clip(t, 30)).filter(Boolean))];
    if (tags.length > 20) throw fail(400, 'Keep it to 20 tags');
    return tags;
  };

  // Field/tag edits. With editVersion the write is CAS-guarded and null means
  // a version miss; without it (bulk tags) the row is updated as it stands.
  async function patch(cycle, { id, editVersion = null, fields = null, tags = null, by, requestId = null, now = kit.now() }) {
    const add = validTags(tags?.add), remove = validTags(tags?.remove);
    const f = isObject(fields) ? fields : {};
    const set = {};
    if (f.name !== undefined) { set.name = clip(f.name, 100); if (!set.name) throw fail(400, 'Tell us your name'); }
    if (f.subteam !== undefined) { const names = subteamNames(cycle, [f.subteam]); set.subteam = f.subteam ? names[0] : ''; }
    if (f.year !== undefined) { set.year = f.year == null || f.year === '' ? null : String(f.year); }
    if (f.answers !== undefined) { if (!isObject(f.answers)) throw fail(400, 'Answers must be an object'); set.answers = Object.fromEntries(Object.entries(f.answers).filter(([k]) => /^[a-z][a-z0-9_]{0,39}$/.test(k)).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 20000) : v])); }
    if (kit.mode === 'memory') {
      const row = memApps().find((a) => a.id === id && a.cycleId === cycle.id);
      if (!row || (editVersion !== null && row.editVersion !== editVersion)) return null;
      if (set.name !== undefined) row.name = set.name;
      if (set.subteam !== undefined) row.subteam = set.subteam;
      if (set.year !== undefined) row.year = set.year;
      if (set.answers !== undefined) row.answers = { ...(row.answers || {}), ...set.answers };
      const next = mergeTags(row.tags, add, remove);
      if (next.length > 20) throw fail(400, 'Keep it to 20 tags');
      row.tags = next;
      row.editVersion = (row.editVersion || 0) + 1;
      kit.memSave();
      return project(row);
    }
    const s = await kit.sql();
    const q = kit.build();
    q`WITH next AS (
        SELECT a.id, (SELECT COALESCE(jsonb_agg(t ORDER BY ord), '[]'::jsonb) FROM (
          SELECT DISTINCT ON (t) t, ord FROM (SELECT value AS t, ordinality AS ord FROM jsonb_array_elements_text(a.tags || ${JSON.stringify(add)}::jsonb) WITH ORDINALITY) x
          WHERE NOT (${JSON.stringify(remove)}::jsonb ? t) ORDER BY t, ord) y) AS tags
        FROM recruit_applications a WHERE a.id = ${id} AND a.cycle_id = ${cycle.id}
      )
      UPDATE recruit_applications a SET tags = n.tags, edit_version = a.edit_version + 1`;
    if (set.name !== undefined) q`, name = ${set.name}`;
    if (set.subteam !== undefined) q`, subteam = ${set.subteam}`;
    if (set.year !== undefined) q`, year = ${set.year}`;
    if (set.answers !== undefined) q`, answers = a.answers || ${JSON.stringify(set.answers)}::jsonb`;
    q` FROM next n WHERE n.id = a.id AND jsonb_array_length(n.tags) <= 20`;
    if (editVersion !== null) q` AND a.edit_version = ${editVersion}`;
    q` RETURNING a.*`;
    const r = await q.run(s);
    return r.rows[0] ? appFromPg(r.rows[0]) : null;
  }

  async function remove(id, { by = 'system', cycleId = null } = {}) {
    let removed = null;
    if (kit.mode === 'memory') {
      const i = memApps().findIndex((a) => a.id === id && (!cycleId || a.cycleId === cycleId));
      if (i < 0) return null;
      [removed] = memApps().splice(i, 1);
      const p = kit.mem.applicants.find((x) => x.email === removed.email);
      if (p) p.applications = Math.max(0, (p.applications || 1) - 1);
      kit.memSave();
      removed = project(removed);
    } else {
      const s = await kit.sql();
      const r = await s`WITH gone AS (DELETE FROM recruit_applications WHERE id = ${id} AND (${cycleId}::text IS NULL OR cycle_id = ${cycleId}) RETURNING *),
        counted AS (UPDATE recruit_applicants p SET applications = GREATEST(p.applications - 1, 0) FROM gone WHERE p.email = gone.email)
        SELECT * FROM gone`;
      removed = r.rows[0] ? appFromPg(r.rows[0]) : null;
    }
    if (!removed) return null;
    for (const f of removed.files || []) { try { await kit.files.removeUnreferenced(f.id); } catch (e) { /* retain on cleanup failure */ } }
    try { await kit.audit({ kind: 'app.delete', cycleId: removed.cycleId, applicationId: id, actor: by, detail: { emailHash: hash(removed.email) } }); } catch (e) { /* best effort */ }
    return removed;
  }

  async function legacyRows(cycleId, limit = 1000) {
    if (kit.mode === 'memory') {
      const rows = memApps().filter((a) => a.cycleId === cycleId).sort((a, b) => b.ts - a.ts);
      return { rows: rows.slice(0, limit).map(project), truncated: rows.length > limit };
    }
    const s = await kit.sql();
    const r = await s`SELECT * FROM recruit_applications WHERE cycle_id = ${cycleId} ORDER BY ts DESC LIMIT ${limit + 1}`;
    return { rows: r.rows.slice(0, limit).map(appFromPg), truncated: r.rows.length > limit };
  }

  async function create(cycle, { name, email, cornell, subteam, year, answers, files = [], source = 'admin', section = 'interest', by, now = kit.now() }) {
    const id = 'in-' + Math.random().toString(36).slice(2, 10) + now.toString(36);
    const stage = firstStageOf(cycle);
    const row = { id, cycleId: cycle.id, section, email, ts: now, updated: now, name, cornell: Boolean(cornell), subteam: subteam || '', year: year || null, source, formVersion: cycle.formVersion || 0, answers: answers || {}, files, stage, stageAt: now, stageHistory: [{ stage, at: now, by }], outcome: null, decision: {}, tags: [], review: {}, reviewVersion: 0, editVersion: 0, onboardedAt: null, erasedAt: null, receiptId: null, ipHash: '' };
    if (kit.mode === 'memory') {
      if (memApps().some((a) => a.cycleId === cycle.id && a.email === email && sectionOf(a) === section)) return null;
      memApps().push(row);
      upsertApplicantMem(row, true);
      kit.memSave();
      return project(row);
    }
    const s = await kit.sql();
    const r = await s`WITH written AS (
      INSERT INTO recruit_applications (id, cycle_id, section, email, ts, updated, name, cornell, subteam, year, source, form_version, answers, files, stage, stage_at, stage_history)
      VALUES (${id}, ${cycle.id}, ${section}, ${email}, ${now}, ${now}, ${name}, ${row.cornell}, ${row.subteam}, ${row.year}, ${source}, ${row.formVersion}, ${JSON.stringify(row.answers)}::jsonb, ${JSON.stringify(files)}::jsonb, ${stage}, ${now}, ${JSON.stringify(row.stageHistory)}::jsonb)
      ON CONFLICT (cycle_id, section, email) DO NOTHING RETURNING *
    ), applicant AS (
      INSERT INTO recruit_applicants (email, name, cornell, first_seen, last_seen, applications)
      SELECT ${email}, ${name}, ${row.cornell}, ${now}, ${now}, 1 WHERE EXISTS (SELECT 1 FROM written)
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, last_seen = EXCLUDED.last_seen, applications = recruit_applicants.applications + 1
    ) SELECT * FROM written`;
    return r.rows[0] ? appFromPg(r.rows[0]) : null;
  }

  async function addFile(cycle, id, file, { by, now = kit.now() }) {
    const fileId = 'int-' + Math.random().toString(36).slice(2, 10) + now.toString(36);
    await kit.files.put({ id: fileId, name: file.name, type: file.type, size: file.size, by, ts: now, data: file.data });
    const entry = { id: fileId, question: file.question || 'file', name: file.name, type: file.type, size: file.size };
    if (kit.mode === 'memory') {
      const row = memApps().find((a) => a.id === id && a.cycleId === cycle.id);
      if (!row) return null;
      row.files = [...(row.files || []), entry]; row.editVersion = (row.editVersion || 0) + 1;
      kit.memSave();
      return project(row);
    }
    const s = await kit.sql();
    const r = await s`UPDATE recruit_applications SET files = files || ${JSON.stringify([entry])}::jsonb, edit_version = edit_version + 1 WHERE id = ${id} AND cycle_id = ${cycle.id} RETURNING *`;
    if (!r.rows[0]) { try { await kit.files.removeUnreferenced(fileId); } catch (e) { /* stray upload */ } return null; }
    return appFromPg(r.rows[0]);
  }

  async function fileOwner(fileId) {
    if (kit.mode === 'memory') return project(memApps().find((a) => (a.files || []).some((f) => f.id === fileId)));
    const s = await kit.sql();
    const r = await s`SELECT * FROM recruit_applications WHERE files @> ${JSON.stringify([{ id: fileId }])}::jsonb LIMIT 1`;
    return r.rows[0] ? appFromPg(r.rows[0]) : null;
  }

  async function applicant(email) {
    if (kit.mode === 'memory') {
      const p = kit.mem.applicants.find((x) => x.email === email);
      return { applicant: p ? clone(p) : null, applications: memApps().filter((a) => a.email === email).sort((a, b) => b.ts - a.ts).map(project) };
    }
    const s = await kit.sql();
    const p = await s`SELECT * FROM recruit_applicants WHERE email = ${email}`;
    const apps = await s`SELECT * FROM recruit_applications WHERE email = ${email} ORDER BY ts DESC`;
    return { applicant: p.rows[0] ? applicantFromPg(p.rows[0]) : null, applications: apps.rows.map(appFromPg) };
  }

  // Each row names its form by title, looked up in its own cycle.
  async function withFormTitles(rows) {
    const cache = new Map();
    for (const h of rows) {
      if (!cache.has(h.cycleId)) { let c = null; try { c = await kit.cycles.get(h.cycleId); } catch (e) { c = null; } cache.set(h.cycleId, c ? sectionsFor(c) : {}); }
      h.sectionTitle = cache.get(h.cycleId)[h.section]?.title || h.section;
    }
    return rows;
  }

  async function history(email, exceptId) {
    if (kit.mode === 'memory') {
      const cycles = new Map(kit.mem.cycles.map((c) => [c.id, c.name]));
      return withFormTitles(memApps().filter((a) => a.email === email && a.id !== exceptId && a.erasedAt == null).sort((a, b) => b.ts - a.ts).slice(0, 20)
        .map((a) => ({ id: a.id, cycleId: a.cycleId, cycleName: cycles.get(a.cycleId) || a.cycleId, section: sectionOf(a), ts: a.ts })));
    }
    const s = await kit.sql();
    const r = await s`SELECT a.id, a.cycle_id, c.name AS cycle_name, a.section, a.ts FROM recruit_applications a LEFT JOIN recruit_cycles c ON c.id = a.cycle_id
      WHERE a.email = ${email} AND a.id <> ${exceptId} AND a.erased_at IS NULL ORDER BY a.ts DESC LIMIT 20`;
    return withFormTitles(r.rows.map((x) => ({ id: x.id, cycleId: x.cycle_id, cycleName: x.cycle_name || x.cycle_id, section: x.section || 'interest', ts: Number(x.ts) })));
  }

  // Everyone in a cycle, one row per email, with what they sent to each
  // section. Newest activity first; the whole cycle at once, capped, so the
  // team can read it as one list.
  async function people(cycleId, { q = '', grantSubteams = null, cycle = null } = {}) {
    let apps;
    if (kit.mode === 'memory') {
      apps = memApps().filter((a) => a.cycleId === cycleId && a.erasedAt == null);
    } else {
      const s = await kit.sql();
      const r = await s`SELECT id, cycle_id, section, email, ts, updated, name, cornell, subteam, year, source, files, review, edit_version, review_version, answers
        FROM recruit_applications WHERE cycle_id = ${cycleId} AND erased_at IS NULL ORDER BY ts DESC LIMIT 10000`;
      apps = r.rows.map(appFromPg);
    }
    const granted = Array.isArray(grantSubteams) && grantSubteams.length ? subteamNames(cycle, grantSubteams) : null;
    if (granted) apps = apps.filter((a) => granted.includes(a.subteam));
    const byEmail = new Map();
    for (const a of apps) {
      const row = { ...listRow(a), legacyFlagged: a.review?.flagged === true, legacyComments: (a.review?.comments || []).length };
      const p = byEmail.get(a.email) || { email: a.email, name: a.name, cornell: Boolean(a.cornell), subteam: '', year: null, first: a.ts, last: 0, latest: null, sections: {} };
      p.sections[row.section] = row;
      const at = Math.max(Number(a.ts) || 0, Number(a.updated) || 0);
      if (at >= p.last) { p.last = at; p.name = a.name; p.latest = row.id; }
      if (a.ts < p.first) p.first = a.ts;
      if (!p.subteam && a.subteam) p.subteam = a.subteam;
      if (!p.year && a.year) p.year = a.year;
      byEmail.set(a.email, p);
    }
    const needle = String(q || '').trim().toLowerCase();
    const rows = [...byEmail.values()].filter((p) => !needle || String(p.name).toLowerCase().includes(needle) || p.email.includes(needle)).sort((a, b) => b.last - a.last);
    const bySection = {};
    for (const a of apps) bySection[sectionOf(a)] = (bySection[sectionOf(a)] || 0) + 1;
    return { rows: rows.slice(0, 2000), total: rows.length, counts: { people: byEmail.size, bySection } };
  }

  // Scrub personal data from a set of rows (erase by email, purge by cycle).
  // Counts, stages, scores and audit survive; the email becomes erased:<id>.
  async function scrub(selector, now, limit = 200) {
    let targets = [];
    if (kit.mode === 'memory') {
      const rows = memApps().filter((a) => a.erasedAt == null && (selector.email ? a.email === selector.email : a.cycleId === selector.cycleId)).slice(0, limit);
      for (const row of rows) {
        targets.push({ id: row.id, cycleId: row.cycleId, files: row.files || [], email: row.email, receiptId: row.receiptId });
        const { comments, ...review } = row.review || {};
        Object.assign(row, { name: 'Applicant', email: 'erased:' + row.id, answers: {}, files: [], ipHash: '', review, erasedAt: now, editVersion: (row.editVersion || 0) + 1 });
      }
      const ids = targets.map((t) => t.id);
      for (const [key, rows2] of Object.entries(kit.mem)) {
        if (!Array.isArray(rows2)) continue;
        if (key === 'scores') for (const x of rows2) if (ids.includes(x.applicationId) && x.doc) x.doc.notes = '';
        if (key === 'mail') for (const x of rows2) if (ids.includes(x.applicationId)) x.toEmail = 'erased';
        if (key === 'bookings') for (const x of rows2) if (ids.includes(x.applicationId)) x.tokenHash = '';
      }
      for (const t of targets) {
        const remaining = memApps().filter((a) => a.email === t.email).length;
        if (!remaining) kit.mem.applicants = kit.mem.applicants.filter((p) => p.email !== t.email);
      }
      kit.memSave();
    } else {
      const s = await kit.sql();
      const q = kit.build();
      q`WITH before AS (SELECT id, cycle_id, files, email, receipt_id FROM recruit_applications WHERE erased_at IS NULL AND `;
      if (selector.email) q`email = ${selector.email}`; else q`cycle_id = ${selector.cycleId}`;
      q` LIMIT ${limit}), done AS (
        UPDATE recruit_applications a SET name = 'Applicant', email = 'erased:' || a.id, answers = '{}'::jsonb, files = '[]'::jsonb, ip_hash = '',
          review = a.review - 'comments', erased_at = ${now}, edit_version = a.edit_version + 1
        WHERE a.id IN (SELECT id FROM before) RETURNING a.id
      ) SELECT b.id, b.cycle_id, b.files, b.email, b.receipt_id FROM before b JOIN done d ON d.id = b.id`;
      const r = await q.run(s);
      targets = r.rows.map((x) => ({ id: x.id, cycleId: x.cycle_id, files: asArray(x.files), email: x.email, receiptId: x.receipt_id }));
      const ids = targets.map((t) => t.id);
      if (ids.length) {
        const t = kit.tables;
        if (t.has('recruit_scores')) await s`UPDATE recruit_scores SET doc = jsonb_set(doc, '{notes}', '""'::jsonb) WHERE application_id = ANY(${ids})`;
        if (t.has('recruit_mail')) await s`UPDATE recruit_mail SET to_email = 'erased' WHERE application_id = ANY(${ids}) AND to_email <> 'erased'`;
        if (t.has('recruit_bookings')) await s`UPDATE recruit_bookings SET token_hash = '' WHERE application_id = ANY(${ids}) AND token_hash <> ''`;
        await s`DELETE FROM recruit_applicants p WHERE p.email = ANY(${[...new Set(targets.map((x) => x.email))]}) AND NOT EXISTS (SELECT 1 FROM recruit_applications a WHERE a.email = p.email)`;
      }
    }
    const ids = targets.map((t) => t.id);
    if (ids.length) { try { await kit.collect('purge', { cycle: selector.cycle || null, ids }); } catch (e) { /* modules scrub best effort */ } }
    for (const f of new Set(targets.flatMap((t) => t.files.map((x) => x.id)).filter(Boolean))) {
      try { await kit.files.removeUnreferenced(f); } catch (e) { /* retain on cleanup failure */ }
    }
    if (targets.some((t) => t.receiptId)) {
      try {
        const journal = await kit.intake.journal();
        if (typeof journal.forget === 'function') for (const t of targets) if (t.receiptId) { try { await journal.forget(t.receiptId); } catch (e) { /* best effort */ } }
      } catch (e) { /* no journal */ }
    }
    return targets;
  }

  async function eraseApplicant(email, { by, now = kit.now() }) {
    const targets = await scrub({ email }, now, 10000);
    try { await kit.people?.forget(email); } catch (e) { /* the row is scrubbed; the thread follows on the next erase */ }
    for (const t of targets) { try { await kit.audit({ kind: 'app.erase', cycleId: t.cycleId || '', applicationId: t.id, actor: by, detail: { emailHash: hash(email) } }); } catch (e) { /* best effort */ } }
    return { erased: targets.length };
  }

  async function purgePage(cycle, { by, now = kit.now(), limit = 200 }) {
    const targets = await scrub({ cycleId: cycle.id, cycle }, now, limit);
    let remaining;
    if (kit.mode === 'memory') remaining = memApps().filter((a) => a.cycleId === cycle.id && a.erasedAt == null).length;
    else { const s = await kit.sql(); remaining = Number((await s`SELECT count(*) AS n FROM recruit_applications WHERE cycle_id = ${cycle.id} AND erased_at IS NULL`).rows[0]?.n || 0); }
    return { erased: targets.length, remaining };
  }

  /* --------------------------------- list -------------------------------- */

  const encodeCursor = (v, id) => Buffer.from(JSON.stringify([v, id])).toString('base64url');
  const decodeCursor = (c) => { try { const [v, id] = JSON.parse(Buffer.from(String(c), 'base64url').toString()); return { v, id: String(id) }; } catch (e) { throw fail(400, 'Bad cursor'); } };

  // ListRow projection (memory mode; the SQL branch projects in the query).
  const listRow = (a) => ({
    id: a.id, cycleId: a.cycleId, section: sectionOf(a), email: a.email, name: a.name, ts: a.ts, updated: a.updated, cornell: Boolean(a.cornell), subteam: a.subteam || '', year: a.year || null,
    source: a.source, stage: a.stage, stageAt: a.stageAt || 0, outcome: a.outcome || null, tags: a.tags || [],
    files: (a.files || []).map((f) => ({ id: f.id, name: f.name, size: f.size, type: f.type })),
    preview: String(a.answers?.project ?? Object.values(a.answers || {}).find((v) => typeof v === 'string') ?? '').slice(0, 160),
    editVersion: a.editVersion || 0, reviewVersion: a.reviewVersion || 0,
  });

  function listOptions(cycle, cyc, opts) {
    const limit = Math.max(1, Math.min(PAGE_MAX, Number(opts.limit) || PAGE_DEFAULT));
    const sortKey = SORTS[opts.sort] ? opts.sort : 'ts';
    const hasScores = kit.tables.has('recruit_scores');
    const key = sortKey === 'score' && !hasScores ? SORTS.ts : SORTS[sortKey];
    return {
      limit, sortKey: sortKey === 'score' && !hasScores ? 'ts' : sortKey, key,
      dir: opts.dir === 'asc' || opts.dir === 'desc' ? opts.dir : key.dir,
      q: String(opts.q || '').trim().toLowerCase().slice(0, 100) || null,
      scope: opts.scope instanceof Set ? [...opts.scope] : Array.isArray(opts.scope) ? opts.scope : null,
      subteam: opts.subteam && opts.subteam !== 'none' && opts.subteam !== 'Undecided' ? subteamNames(cyc, [opts.subteam]) : null,
      undecided: opts.subteam === 'none' || opts.subteam === 'Undecided',
      grantSubteams: Array.isArray(opts.grantSubteams) && opts.grantSubteams.length ? subteamNames(cyc, opts.grantSubteams) : null,
      year: opts.year && opts.year !== 'none' ? String(opts.year) : null, noYear: opts.year === 'none',
      section: opts.section ? String(opts.section) : null,
      stage: opts.stage ? String(opts.stage) : null, tag: opts.tag ? String(opts.tag) : null, outcome: opts.outcome ? String(opts.outcome) : null, source: opts.source ? String(opts.source) : null,
      unscored: (opts.unscored === '1' || opts.unscored === true) && hasScores,
      assigned: opts.assigned && kit.tables.has('recruit_assignments') ? String(opts.assigned) : null, me: opts.me || null,
      cursor: opts.cursor ? decodeCursor(opts.cursor) : null, hasScores,
    };
  }

  async function list(cycle, opts = {}) {
    const cycleId = typeof cycle === 'string' ? cycle : cycle.id;
    const cyc = typeof cycle === 'string' ? await kit.cycles.get(cycle) : cycle;
    const o = listOptions(cycle, cyc, opts);

    if (kit.mode === 'memory') {
      const m = kit.mem;
      const assignments = m.assignments || [];
      const scores = m.scores || [];
      const scoreOf = (id) => {
        const s = scores.filter((x) => x.applicationId === id && x.kind === 'review' && x.submitted && !x.doc?.conflict).map((x) => Number(x.doc?.total)).filter(Number.isFinite);
        return s.length ? s.reduce((a, b) => a + b, 0) / s.length : -1;
      };
      const inBase = (a) => a.cycleId === cycleId && (!o.scope || o.scope.includes(a.id)) && (!o.grantSubteams || o.grantSubteams.includes(a.subteam));
      let rows = memApps().filter(inBase);
      const byStage = {}, bySection = {};
      for (const a of rows) { byStage[a.stage] = (byStage[a.stage] || 0) + 1; bySection[sectionOf(a)] = (bySection[sectionOf(a)] || 0) + 1; }
      if (o.section) rows = rows.filter((a) => sectionOf(a) === o.section);
      if (o.stage) rows = rows.filter((a) => a.stage === o.stage);
      if (o.undecided) rows = rows.filter((a) => !a.subteam); else if (o.subteam) rows = rows.filter((a) => o.subteam.includes(a.subteam));
      if (o.noYear) rows = rows.filter((a) => !a.year); else if (o.year) rows = rows.filter((a) => a.year === o.year);
      if (o.tag) rows = rows.filter((a) => (a.tags || []).includes(o.tag));
      if (o.outcome) rows = rows.filter((a) => a.outcome === o.outcome);
      if (o.source) rows = rows.filter((a) => a.source === o.source);
      if (o.q) rows = rows.filter((a) => a.name.toLowerCase().includes(o.q) || a.email.toLowerCase().includes(o.q));
      if (o.assigned === 'none') rows = rows.filter((a) => !assignments.some((x) => x.applicationId === a.id && x.kind === 'reviewer'));
      else if (o.assigned) { const who = o.assigned === 'me' ? o.me : o.assigned; rows = rows.filter((a) => assignments.some((x) => x.applicationId === a.id && x.kind === 'reviewer' && x.member === who)); }
      if (o.unscored) rows = rows.filter((a) => !scores.some((x) => x.applicationId === a.id && x.kind === 'review' && x.submitted));
      const keyOf = (a) => (o.sortKey === 'name' ? a.name.toLowerCase() : o.sortKey === 'score' ? scoreOf(a.id) : o.sortKey === 'updated' ? a.updated : o.sortKey === 'stage_at' ? (a.stageAt || 0) : a.ts);
      const sign = o.dir === 'asc' ? 1 : -1;
      const cmpKeys = (ka, ia, kb, ib) => { const c = ka < kb ? -1 : ka > kb ? 1 : 0; return sign * (c || (ia < ib ? -1 : ia > ib ? 1 : 0)); };
      rows.sort((a, b) => cmpKeys(keyOf(a), a.id, keyOf(b), b.id));
      const total = rows.length;
      if (o.cursor) rows = rows.filter((a) => cmpKeys(keyOf(a), a.id, o.cursor.v, o.cursor.id) > 0);
      const page = rows.slice(0, o.limit);
      const last = page[page.length - 1];
      const next = rows.length > o.limit ? encodeCursor(keyOf(last), last.id) : null;
      return { rows: page.map((a) => listRow(project(a))), next, total, counts: { byStage, bySection } };
    }

    const s = await kit.sql();
    const base = kit.build();
    base` FROM recruit_applications a`;
    if (o.sortKey === 'score') base` LEFT JOIN (SELECT application_id, avg((doc->>'total')::numeric) AS score FROM recruit_scores WHERE kind = 'review' AND submitted IS NOT NULL AND COALESCE((doc->>'conflict')::boolean, false) = false GROUP BY application_id) sc ON sc.application_id = a.id`;
    base` WHERE a.cycle_id = ${cycleId}`;
    if (o.scope) base` AND a.id = ANY(${o.scope})`;
    if (o.grantSubteams) base` AND a.subteam = ANY(${o.grantSubteams})`;
    const where = kit.build().append(base);
    if (o.section) where` AND a.section = ${o.section}`;
    if (o.stage) where` AND a.stage = ${o.stage}`;
    if (o.undecided) where` AND a.subteam = ''`; else if (o.subteam) where` AND a.subteam = ANY(${o.subteam})`;
    if (o.noYear) where` AND a.year IS NULL`; else if (o.year) where` AND a.year = ${o.year}`;
    if (o.tag) where` AND a.tags ? ${o.tag}`;
    if (o.outcome) where` AND a.outcome = ${o.outcome}`;
    if (o.source) where` AND a.source = ${o.source}`;
    if (o.q) { const like = '%' + o.q.replace(/[%_\\]/g, '\\$&') + '%'; where` AND (a.name ILIKE ${like} OR a.email ILIKE ${like})`; }
    if (o.assigned === 'none') where` AND NOT EXISTS (SELECT 1 FROM recruit_assignments x WHERE x.application_id = a.id AND x.kind = 'reviewer')`;
    else if (o.assigned) where` AND EXISTS (SELECT 1 FROM recruit_assignments x WHERE x.application_id = a.id AND x.kind = 'reviewer' AND x.member = ${o.assigned === 'me' ? o.me : o.assigned})`;
    if (o.unscored) where` AND NOT EXISTS (SELECT 1 FROM recruit_scores x WHERE x.application_id = a.id AND x.kind = 'review' AND x.submitted IS NOT NULL)`;

    const keyExpr = o.key.col;
    const rowsQ = kit.build();
    rowsQ`SELECT a.id, a.cycle_id, a.section, a.email, a.name, a.ts, a.updated, a.cornell, a.subteam, a.year, a.source, a.stage, a.stage_at, a.outcome, a.tags, a.files, a.edit_version, a.review_version,
      left(COALESCE(a.answers->>'project', (SELECT value FROM jsonb_each_text(a.answers) LIMIT 1), ''), 160) AS preview`;
    rowsQ.raw(`, ${keyExpr} AS sort_key`).append(where);
    if (o.cursor) {
      rowsQ.raw(` AND (${keyExpr}, a.id) ${o.dir === 'asc' ? '>' : '<'} (`);
      rowsQ`${o.cursor.v}`; rowsQ.raw(o.key.kind === 'text' ? '::text, ' : '::numeric, ');
      rowsQ`${o.cursor.id}`; rowsQ.raw('::text)');
    }
    rowsQ.raw(` ORDER BY ${keyExpr} ${o.dir === 'asc' ? 'ASC' : 'DESC'}, a.id ${o.dir === 'asc' ? 'ASC' : 'DESC'} LIMIT `);
    rowsQ`${o.limit + 1}`;
    const r = await rowsQ.run(s);
    const countQ = kit.build().raw('SELECT count(*) AS n').append(where);
    const total = Number((await countQ.run(s)).rows[0]?.n || 0);
    const stageQ = kit.build().raw('SELECT a.stage, count(*)::int AS n').append(base).raw(' GROUP BY a.stage');
    const byStage = {};
    for (const x of (await stageQ.run(s)).rows) byStage[x.stage] = Number(x.n);
    const sectionQ = kit.build().raw('SELECT a.section, count(*)::int AS n').append(base).raw(' GROUP BY a.section');
    const bySection = {};
    for (const x of (await sectionQ.run(s)).rows) bySection[x.section || 'interest'] = Number(x.n);
    const pageRows = r.rows.slice(0, o.limit);
    const last = pageRows[pageRows.length - 1];
    const next = r.rows.length > o.limit ? encodeCursor(o.key.kind === 'text' ? String(last.sort_key) : Number(last.sort_key), last.id) : null;
    return {
      rows: pageRows.map((x) => ({
        id: x.id, cycleId: x.cycle_id, section: x.section || 'interest', email: x.email, name: x.name, ts: Number(x.ts), updated: Number(x.updated), cornell: Boolean(x.cornell), subteam: x.subteam || '', year: x.year || null,
        source: x.source, stage: x.stage, stageAt: Number(x.stage_at || 0), outcome: x.outcome || null, tags: asArray(x.tags),
        files: asArray(x.files).map((f) => ({ id: f.id, name: f.name, size: f.size, type: f.type })), preview: x.preview || '', editVersion: Number(x.edit_version || 0), reviewVersion: Number(x.review_version || 0),
      })),
      next, total, counts: { byStage, bySection },
    };
  }

  return {
    get, findByEmail, count, exportRows, ids, commitIntake, move, setDecision, patch, remove, toLegacyRow, legacyRows, create, addFile, fileOwner,
    applicant, history, people, allByEmail, eraseApplicant, purgePage, receiptOutcome, recordOutcome, listRow, list,
  };
}

/* -------------------------------- routes -------------------------------- */

const isLead = (role) => role === 'admin' || role === 'lead';
const requestIdOf = (body) => { const id = String(body?.requestId || ''); if (!REQUEST_ID.test(id)) throw fail(400, 'A request ID is required'); return id; };

async function extrasFor(kit, rq, ids, detail = false) {
  const out = {};
  if (!ids.length) return out;
  const parts = await kit.collect('application.extras', { cycle: rq.cycle, ids, me: rq.me, role: rq.role, grant: rq.grant, detail });
  for (const part of parts) if (isObject(part)) for (const [id, extra] of Object.entries(part)) out[id] = { ...(out[id] || {}), ...(isObject(extra) ? extra : {}) };
  return out;
}

async function listRoute(rq, kit) {
  const qy = rq.query;
  const out = await kit.apps.list(rq.cycle, {
    q: qy.q, section: qy.section, stage: qy.stage, subteam: qy.subteam, year: qy.year, tag: qy.tag, outcome: qy.outcome, source: qy.source,
    assigned: qy.assigned, unscored: qy.unscored, sort: qy.sort, dir: qy.dir, cursor: qy.cursor, limit: qy.limit,
    scope: rq.scope, grantSubteams: rq.grant?.subteams || null, me: rq.me.email,
  });
  const extras = await extrasFor(kit, rq, out.rows.map((r) => r.id));
  return { status: 200, body: { ...out, rows: out.rows.map((r) => ({ ...r, extras: extras[r.id] || {} })) } };
}

async function detailRoute(rq, kit) {
  const app = await kit.apps.get(rq.cycle, rq.params.app);
  if (!app || (rq.scope && !rq.scope.has(app.id))) throw fail(404, 'No such application');
  const extras = (await extrasFor(kit, rq, [app.id], true))[app.id] || {};
  const lead = isLead(rq.role);
  const form = { questions: formForRow(sectionsFor(rq.cycle), app).questions };
  const application = { ...app };
  let audit = undefined;
  if (lead) {
    if (kit.mode === 'memory') audit = kit.mem.audit.filter((a) => a.applicationId === app.id).sort((a, b) => b.ts - a.ts).slice(0, 50).map((a) => ({ ...a }));
    else {
      const s = await kit.sql();
      audit = (await s`SELECT * FROM recruit_audit WHERE application_id = ${app.id} ORDER BY ts DESC LIMIT 50`).rows.map((r) => ({ id: r.id, ts: Number(r.ts), cycleId: r.cycle_id, applicationId: r.application_id, actor: r.actor, kind: r.kind, detail: asObject(r.detail) }));
    }
  }
  const history = await kit.apps.history(app.email, app.id);
  return {
    status: 200,
    body: {
      application, form, extras, history,
      ...(lead ? { audit } : {}),
    },
  };
}

// One section of one cycle as a spreadsheet: identity columns, then every
// question of that section's form, then files and review state.
async function csvRoute(rq, kit) {
  const sections = sectionsFor(rq.cycle);
  const key = sections[rq.query.section] ? rq.query.section : null;
  if (!key) throw fail(400, "Choose one of this cycle's forms");
  const section = sections[key];
  const rows = await kit.apps.exportRows(rq.cycle.id, key);
  const safe = (v) => { const s = String(v ?? ''); return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; };
  const when = (ts) => (ts ? new Date(Number(ts)).toISOString() : '');
  const columns = [
    { header: 'Name', cell: (r) => safe(r.name) }, { header: 'Email', cell: (r) => safe(r.email) }, { header: 'Cornell', cell: (r) => (r.cornell ? 'yes' : 'no') },
    { header: 'Year', cell: (r) => safe(r.year || '') }, { header: 'Subteam', cell: (r) => safe(r.subteam || '') },
    { header: 'Received', cell: (r) => when(r.ts) }, { header: 'Updated', cell: (r) => when(r.updated) },
    ...section.form.questions.filter((q) => !COLUMN_KEYS.includes(q.key) && q.type !== 'file').map((q) => ({ header: q.label || q.key, cell: (r) => safe(Array.isArray(r.answers?.[q.key]) ? r.answers[q.key].join('; ') : r.answers?.[q.key] ?? '') })),
    { header: 'Files', cell: (r) => safe((r.files || []).map((f) => f.name).join('; ')) },
  ];
  kit.csv(rq.res, rows, columns, `cupi-${rq.cycle.term || rq.cycle.name}-${key}-${new Date(kit.now()).toISOString().slice(0, 10)}`);
  return undefined;
}


// Hand-entered rows belong to one of the cycle's forms: the one named, else
// the interest form when there is one, else the first.
function sectionKeyFor(cycle, body) {
  const sections = sectionsFor(cycle);
  const key = String(body?.section || (sections.interest ? 'interest' : Object.keys(sections)[0] || ''));
  if (!sections[key]) throw fail(400, "Choose one of this cycle's forms");
  return key;
}

function validated(cycle, body, key = sectionKeyFor(cycle, body)) {
  const v = validateAnswers(sectionsFor(cycle)[key].form, body, cycle);
  if (v.error) throw fail(v.status || 400, v.error);
  const extra = isObject(body.answers) ? Object.fromEntries(Object.entries(body.answers).filter(([k, val]) => /^[a-z][a-z0-9_]{0,39}$/.test(k) && !['name', 'email', 'subteam', 'year', 'file'].includes(k)).map(([k, val]) => [k, typeof val === 'string' ? val.slice(0, 20000) : val])) : {};
  return { ...v, answers: { ...extra, ...v.answers } };
}

async function createRoute(rq, kit) {
  const body = await rq.body();
  const requestId = requestIdOf(body);
  const now = kit.now();
  if (Array.isArray(body.import)) {
    if (body.import.length > 500) throw fail(400, 'Import at most 500 people at a time');
    const result = await kit.once(requestId, rq.me.email, async () => {
      let created = 0;
      const skipped = [];
      for (const item of body.import) {
        let v;
        let key;
        try { key = sectionKeyFor(rq.cycle, item.section ? item : body); v = validated(rq.cycle, item, key); } catch (e) { skipped.push({ email: String(item?.email || '').slice(0, 200), reason: e.error || 'Invalid' }); continue; }
        const app = await kit.apps.create(rq.cycle, { ...v.columns, answers: v.answers, source: 'import', section: key, by: rq.me.email, now });
        if (app) created++; else skipped.push({ email: v.columns.email, reason: 'Already applied to this cycle' });
      }
      return { created, skipped };
    });
    return { status: 200, body: result, audit: { kind: 'app.create', detail: { source: 'import', created: result.created, skipped: result.skipped?.length || 0, requestId } } };
  }
  const key = sectionKeyFor(rq.cycle, body);
  const v = validated(rq.cycle, body, key);
  const result = await kit.once(requestId, rq.me.email, async () => {
    const app = await kit.apps.create(rq.cycle, { ...v.columns, answers: v.answers, source: 'admin', section: key, by: rq.me.email, now });
    if (!app) throw fail(409, 'Already applied to this cycle');
    await kit.emit('application.created', { cycle: rq.cycle, application: app, source: 'admin' });
    return { application: app };
  });
  return { status: result.replayed ? 200 : 201, body: result, audit: { kind: 'app.create', target: result.application?.id, detail: { source: 'admin', requestId } } };
}

async function patchRoute(rq, kit) {
  const body = await rq.body();
  const requestId = requestIdOf(body);
  const editVersion = Number(body.editVersion);
  if (!Number.isInteger(editVersion) || editVersion < 0) throw fail(400, 'Send the version you loaded');
  const fields = isObject(body.fields) ? body.fields : {};
  if (fields.year !== undefined && fields.year !== null && fields.year !== '') {
    const cur = await kit.apps.get(rq.cycle, rq.params.app);
    const years = formForRow(sectionsFor(rq.cycle), cur).questions.find((q) => q.key === 'year')?.options || YEARS;
    if (!years.includes(fields.year)) throw fail(400, `Choose ${years.join(', ')} for year`);
  }
  const result = await kit.once(requestId, rq.me.email, async () => {
    const app = await kit.apps.patch(rq.cycle, { id: rq.params.app, editVersion, fields, tags: body.tags, by: rq.me.email, requestId, now: kit.now() });
    if (!app) {
      const cur = await kit.apps.get(rq.cycle, rq.params.app);
      if (!cur) throw fail(404, 'No such application');
      throw fail(409, 'This application changed. Reload.', { editVersion: cur.editVersion });
    }
    return { application: app };
  });
  return { status: 200, body: result, audit: { kind: 'app.edit', detail: { fields: Object.keys(fields), tagsAdded: (body.tags?.add || []).length, tagsRemoved: (body.tags?.remove || []).length, requestId } } };
}

async function deleteRoute(rq, kit) {
  const removed = await kit.apps.remove(rq.params.app, { by: rq.me.email, cycleId: rq.cycle.id });
  if (!removed) throw fail(404, 'No such application');
  await kit.emit('application.deleted', { cycle: rq.cycle, ids: [removed.id] });
  return { status: 200, body: { ok: true } };
}

async function fileRoute(rq, kit) {
  const body = await rq.body();
  const data = String(body?.data || '');
  if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) throw fail(400, 'The file did not decode');
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw fail(400, 'The file did not decode');
  if (buf.length > MAX_FILE) throw fail(413, 'Files are capped at 2.5 MB');
  const type = String(body.type || '');
  if (!FILE_TYPES.includes(type)) throw fail(400, 'Images or PDF only');
  const app = await kit.apps.addFile(rq.cycle, rq.params.app, { name: String(body.name || 'file').slice(0, 200), type, size: buf.length, data: buf, question: /^[a-z][a-z0-9_]{0,39}$/.test(String(body.question || '')) ? body.question : 'file' }, { by: rq.me.email });
  if (!app) throw fail(404, 'No such application');
  return { status: 200, body: { application: app }, audit: { kind: 'app.edit', detail: { file: true } } };
}

async function serveFile(rq, kit) {
  const owner = await kit.apps.fileOwner(rq.params.file);
  if (!owner) throw fail(404, 'No such file');
  if (rq.role !== 'admin') {
    const grant = await kit.roles.grantFor(owner.cycleId, rq.me.email);
    if (!grant || !grant.roles.length) throw fail(404, 'No such file');
  }
  const f = await kit.files.get(rq.params.file);
  if (!f) throw fail(404, 'No such file');
  kit.files.serve(rq.res, f);
  return undefined;
}

async function applicantRoute(rq, kit) {
  const out = await kit.apps.applicant(rq.params.email);
  if (!out.applicant && !out.applications.length) throw fail(404, 'No such applicant');
  return { status: 200, body: out };
}

// A held entry as the queue shows it: who, which form of which cycle, and
// every answer they gave (the old flat entries carry theirs as columns).
const pendingEntry = (entry, reason, form) => ({
  id: entry.id, receivedAt: entry.ts, reason, cycleId: entry.cycleId ?? null, section: entry.section || 'interest', sectionTitle: form?.title || null,
  name: entry.name, email: entry.email, subteam: entry.subteam, year: entry.year,
  answers: { ...(entry.project ? { project: entry.project } : {}), ...(entry.answers || {}) },
  questions: form?.form?.questions || null,
  fileName: entry.fileName, fileType: entry.fileType, fileSize: entry.fileSize,
  ...(entry.fileSize ? { fileUrl: `/api/recruit/queue/${entry.id}/file` } : {}),
});

async function queueRoute(rq, kit) {
  const force = rq.query.force === '1';
  const journal = await kit.intake.journal();
  let replayed = null;
  const last = kit.store.cache.get('queue.replayedAt');
  if (force || !last || last.until < Date.now()) {
    try { replayed = await kit.intake.replay(kit.ctx); } catch (e) { replayed = { pendingReview: [], queueUnavailable: true }; }
    kit.store.cache.set('queue.replayedAt', { value: true, until: Date.now() + QUEUE_THROTTLE });
  }
  let entries;
  try { entries = await journal.listPending(); } catch (e) { return { status: 200, body: { pending: [], queueUnavailable: true } }; }
  const reasons = new Map((replayed?.pendingReview || []).map((p) => [p.id, p.reason]));
  const pending = [];
  const forms = new Map();
  const formOf = async (entry) => {
    const id = entry.cycleId || null;
    if (!forms.has(id)) { let c = null; try { c = id ? await kit.cycles.get(id) : null; } catch (e) { c = null; } forms.set(id, c ? sectionsFor(c) : {}); }
    return forms.get(id)[entry.section || 'interest'] || null;
  };
  for (const entry of entries) {
    let reason = reasons.get(entry.id) || null;
    if (!reason) {
      const outcome = await kit.apps.receiptOutcome(entry.id);
      reason = outcome === 'review' ? 'duplicate' : outcome === 'held' ? 'capacity' : outcome ? null : (entry.cycleId ? 'unsynced' : 'legacy');
    }
    // A repeat the applicant went on to confirm (or that is older than the
    // row's last update) is settled; only a repeat nobody acted on is held.
    if (reason === 'duplicate' && entry.cycleId) {
      let row = null;
      try { row = await kit.apps.findByEmail(entry.cycleId, String(entry.email || '').toLowerCase(), entry.section || 'interest'); } catch (e) { row = null; }
      if (row && Number(row.updated || row.ts || 0) >= Number(entry.ts || 0)) continue;
    }
    if (reason) pending.push(pendingEntry(entry, reason, await formOf(entry)));
  }
  return { status: 200, body: { pending, queueUnavailable: Boolean(replayed?.queueUnavailable) } };
}

async function placeRoute(rq, kit) {
  const body = await rq.body();
  const requestId = requestIdOf(body);
  const cycle = await kit.cycles.get(String(body.cycleId || ''));
  if (!cycle) throw fail(404, 'No such cycle');
  if (cycle.status === 'archived') throw fail(409, 'This cycle is archived');
  const journal = await kit.intake.journal();
  const entry = await journal.getEntry(rq.params.receipt);
  if (!entry) throw fail(404, 'No saved submission');
  const bridge = kit.store.bridge;
  const result = await kit.once(requestId, rq.me.email, async () => {
    const out = await bridge.commit({ ...entry, confirmUpdate: body.confirmUpdate === true || Boolean(entry.confirmUpdate) }, journal, null, { cycleId: cycle.id, override: true, source: entry.cycleId ? 'form' : 'orphan' });
    if (out.outcome === 'saved' || out.outcome === 'superseded') { try { await journal.complete(entry.id, out.outcome); } catch (e) { /* receipt prevents repeats */ } }
    return { outcome: out.outcome, id: out.id, cycleId: cycle.id, existing: out.existing ? { id: out.existing.id, submitted: out.existing.ts } : null };
  });
  return { status: 200, body: result, audit: { kind: 'queue.place', cycleId: cycle.id, target: result.id || null, detail: { receipt: rq.params.receipt, outcome: result.outcome, requestId } } };
}

async function queueFile(rq, kit) {
  const journal = await kit.intake.journal();
  const entry = await journal.getEntry(rq.params.receipt);
  if (!entry?.fileSize) throw fail(404, 'No saved attachment');
  const data = await journal.getFile(entry.id);
  if (!data) throw fail(503, 'The saved attachment is temporarily unavailable');
  rq.res.statusCode = 200;
  rq.res.setHeader('content-type', entry.fileType || 'application/octet-stream');
  rq.res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(entry.fileName || 'attachment')}"`);
  rq.res.setHeader('cache-control', 'private, no-store');
  rq.res.end(data);
  return undefined;
}

async function storageCheck(rq, kit) {
  const journal = await kit.intake.journal();
  try { return { status: 200, body: await journal.check() }; }
  catch (e) { return { status: 503, body: { error: 'Private intake storage could not be verified. Try again shortly.' } }; }
}

export default {
  name: 'applications',
  kernel: true,
  order: 10,
  schema: [
    `CREATE TABLE IF NOT EXISTS recruit_applicants (email text PRIMARY KEY, name text NOT NULL DEFAULT '', cornell boolean NOT NULL DEFAULT false, first_seen bigint NOT NULL, last_seen bigint NOT NULL, applications int NOT NULL DEFAULT 0, erased_at bigint, doc jsonb NOT NULL DEFAULT '{}'::jsonb)`,
    `CREATE TABLE IF NOT EXISTS recruit_applications (id text PRIMARY KEY, cycle_id text NOT NULL, section text NOT NULL DEFAULT 'interest', email text NOT NULL, ts bigint NOT NULL, updated bigint NOT NULL, name text NOT NULL, cornell boolean NOT NULL DEFAULT false, subteam text NOT NULL DEFAULT '', year text, source text NOT NULL DEFAULT 'form', form_version int NOT NULL DEFAULT 0, answers jsonb NOT NULL DEFAULT '{}'::jsonb, files jsonb NOT NULL DEFAULT '[]'::jsonb, stage text NOT NULL DEFAULT 'applied', stage_at bigint NOT NULL DEFAULT 0, stage_history jsonb NOT NULL DEFAULT '[]'::jsonb, outcome text, decision jsonb NOT NULL DEFAULT '{}'::jsonb, tags jsonb NOT NULL DEFAULT '[]'::jsonb, review jsonb NOT NULL DEFAULT '{}'::jsonb, review_version bigint NOT NULL DEFAULT 0, edit_version bigint NOT NULL DEFAULT 0, ip_hash text NOT NULL DEFAULT '', onboarded_at bigint, erased_at bigint, receipt_id text)`,
    `ALTER TABLE recruit_applications ADD COLUMN IF NOT EXISTS section text NOT NULL DEFAULT 'interest'`,
    `ALTER TABLE recruit_applications DROP CONSTRAINT IF EXISTS recruit_applications_cycle_id_email_key`,
    `CREATE UNIQUE INDEX IF NOT EXISTS recruit_applications_cycle_section_email ON recruit_applications (cycle_id, section, email)`,
    `CREATE INDEX IF NOT EXISTS recruit_applications_cycle_stage ON recruit_applications (cycle_id, stage, ts DESC)`,
    `CREATE INDEX IF NOT EXISTS recruit_applications_email ON recruit_applications (email)`,
    `CREATE INDEX IF NOT EXISTS recruit_applications_cycle_updated ON recruit_applications (cycle_id, updated)`,
    `CREATE INDEX IF NOT EXISTS recruit_applications_files ON recruit_applications USING gin (files)`,
    `CREATE TABLE IF NOT EXISTS interest_receipts (id text PRIMARY KEY, outcome text NOT NULL, ts bigint NOT NULL)`,
  ],
  memory: { applicants: [], applications: [], receipts: {} },
  defaults: () => ({}),
  validateSettings: () => ({}),
  provide: (kit) => ({ apps: makeFacade(kit) }),
  routes: [
    { method: 'GET', path: '/cycles/:cycle/applications', access: 'role', scoped: true, handler: listRoute },
    { method: 'GET', path: '/cycles/:cycle/applications.csv', access: 'lead', handler: csvRoute },
    { method: 'POST', path: '/cycles/:cycle/applications', access: 'lead', mutates: true, cap: 262144, handler: createRoute },
    { method: 'GET', path: '/cycles/:cycle/applications/:app', access: 'role', scoped: true, handler: detailRoute },
    { method: 'PATCH', path: '/cycles/:cycle/applications/:app', access: 'lead', mutates: true, cap: 262144, handler: patchRoute },
    { method: 'DELETE', path: '/cycles/:cycle/applications/:app', access: 'admin', mutates: true, handler: deleteRoute },
    { method: 'POST', path: '/cycles/:cycle/applications/:app/files', access: 'lead', mutates: true, cap: 3600000, handler: fileRoute },
    { method: 'GET', path: '/files/:file', access: 'role', handler: serveFile },
    { method: 'GET', path: '/applicants/:email', access: 'lead', handler: applicantRoute },
    // POST /applicants/:email/erase is served by the analytics module (purge/erase); kit.apps.eraseApplicant backs it.
    { method: 'GET', path: '/queue', access: 'admin', handler: queueRoute },
    { method: 'POST', path: '/queue/:receipt/place', access: 'admin', handler: placeRoute },
    { method: 'GET', path: '/queue/:receipt/file', access: 'admin', handler: queueFile },
    { method: 'POST', path: '/storage-check', access: 'admin', handler: storageCheck },
  ],
  hooks: {},
  collect: {},
  auditKinds: ['app.create', 'app.edit', 'app.delete', 'app.erase', 'stage', 'queue.place'],
};
