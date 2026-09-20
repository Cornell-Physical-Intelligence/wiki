// Legacy import: copies interest_submissions and interest_archives into
// recruit cycles. Explicit, admin-triggered, copy-only, idempotent and
// resumable: every statement is ON CONFLICT DO NOTHING or a guarded UPDATE,
// nothing legacy is ever rewritten. Also the read-only legacy readers the
// cycle index uses (counts, archives, orphans). Uses only the kit.

import { readFileSync } from 'node:fs';

const LEGACY_FILE = new URL('../../.devinterest.json', import.meta.url);
export const LIVE_CYCLE = 'cy-interest';

// The current list is imported as this term's cycle: Fall from July on,
// Spring before that.
export function liveCycleLabel(ts) {
  const d = new Date(Number(ts) || 0);
  const name = `${d.getUTCMonth() >= 6 ? 'Fall' : 'Spring'} ${d.getUTCFullYear()}`;
  return { name, term: name };
}
export const cycleIdForArchive = (archiveId) => 'cy-' + String(archiveId).slice(3);
export const termOf = (name) => (/\b(Fall|Spring) (\d{4})\b/.exec(String(name || '')) || []).slice(1).join(' ');

const isObject = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const asArray = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? (() => { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } })() : []);

function readLegacyFile() {
  try { const d = JSON.parse(readFileSync(LEGACY_FILE, 'utf8')); return { rows: d.rows || [], archives: d.archives || [], receipts: d.receipts || {} }; }
  catch (e) { return { rows: [], archives: [], receipts: {} }; }
}

async function legacyTablesExist(kit) {
  const s = await kit.sql();
  const r = await s`SELECT to_regclass('public.interest_submissions') AS live, to_regclass('public.interest_archives') AS archives`;
  return { live: Boolean(r.rows[0]?.live), archives: Boolean(r.rows[0]?.archives) };
}

// { available, live, archives:[{ id, ts, name, count }], orphans }
export async function legacySummary(kit) {
  if (kit.mode === 'memory') {
    const d = readLegacyFile();
    const known = new Set(kit.mem.applications.map((a) => a.id));
    return {
      available: true, live: d.rows.length,
      archives: [...d.archives].sort((a, b) => b.ts - a.ts).map((a) => ({ id: a.id, ts: a.ts, name: a.name, count: a.count ?? (a.rows || []).length })),
      orphans: d.rows.filter((r) => !known.has(r.id)).length,
    };
  }
  const s = await kit.sql();
  const exists = await legacyTablesExist(kit);
  const out = { available: exists.live, live: 0, archives: [], orphans: 0 };
  if (exists.live) {
    const live = await s`SELECT count(*) AS n, count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM recruit_applications a WHERE a.id = interest_submissions.id)) AS orphans FROM interest_submissions`;
    out.live = Number(live.rows[0]?.n || 0);
    out.orphans = Number(live.rows[0]?.orphans || 0);
  }
  if (exists.archives) {
    const archives = await s`SELECT id, ts, name, count FROM interest_archives ORDER BY ts DESC`;
    out.archives = archives.rows.map((a) => ({ id: a.id, ts: Number(a.ts), name: a.name, count: Number(a.count) }));
  }
  return out;
}

// Legacy rows not yet in recruit_applications (the inbox that filled while
// no cycle was receiving the form), in the legacy camelCase shape.
export async function legacyOrphans(kit, limit = 1000) {
  if (kit.mode === 'memory') {
    const known = new Set(kit.mem.applications.map((a) => a.id));
    return readLegacyFile().rows.filter((r) => !known.has(r.id)).slice(0, limit);
  }
  const s = await kit.sql();
  if (!(await legacyTablesExist(kit)).live) return [];
  const r = await s`SELECT * FROM interest_submissions s WHERE NOT EXISTS (SELECT 1 FROM recruit_applications a WHERE a.id = s.id) ORDER BY ts DESC LIMIT ${limit}`;
  return r.rows.map((x) => ({
    id: x.id, ts: Number(x.ts), updated: Number(x.updated), name: x.name, email: x.email, subteam: x.subteam, project: x.project,
    cornell: x.cornell, year: x.year || null, fileId: x.file_id || null, fileName: x.file_name || null, fileType: x.file_type || null,
    fileSize: x.file_size == null ? null : Number(x.file_size), review: isObject(x.review) ? x.review : {}, reviewVersion: Number(x.review_version || 0),
  }));
}

/* ------------------------------- migration ------------------------------ */

const appFromLegacy = (r, cycleId, source = 'migrated') => ({
  id: r.id, cycleId, email: String(r.email || '').toLowerCase(), ts: Number(r.ts), updated: Number(r.updated || r.ts),
  name: r.name || '', cornell: Boolean(r.cornell), subteam: r.subteam || '', year: r.year || null, source, formVersion: 0, section: 'interest',
  answers: { project: r.project || '' },
  files: r.fileId ? [{ id: r.fileId, question: 'file', name: r.fileName, type: r.fileType, size: r.fileSize == null ? null : Number(r.fileSize) }] : [],
  stage: 'applied', stageAt: Number(r.ts), stageHistory: [{ stage: 'applied', at: Number(r.ts), by: 'migration' }],
  outcome: null, decision: {}, tags: [], review: isObject(r.review) ? r.review : {}, reviewVersion: Number(r.reviewVersion || 0),
  editVersion: 0, onboardedAt: null, erasedAt: null, receiptId: null,
});

// Insert legacy rows into a cycle: ON CONFLICT DO NOTHING on ids, one row
// per email inside the cycle (duplicate ids across two archives keep the
// first). Returns the number inserted.
async function copyRows(kit, cycleId, rows, source = 'migrated') {
  const m = kit.mem;
  const ids = new Set(m.applications.map((a) => a.id));
  const emails = new Set(m.applications.filter((a) => a.cycleId === cycleId).map((a) => a.email));
  let inserted = 0;
  for (const r of [...rows].sort((a, b) => a.ts - b.ts)) {
    const app = appFromLegacy(r, cycleId, source);
    if (ids.has(app.id) || emails.has(app.email)) continue;
    m.applications.push(app);
    ids.add(app.id); emails.add(app.email);
    inserted++;
  }
  return inserted;
}

// Recompute applicant identity rows for one cycle's emails (memory).
function refreshApplicants(kit, cycleId) {
  const m = kit.mem;
  const emails = new Set(m.applications.filter((a) => a.cycleId === cycleId).map((a) => a.email));
  for (const email of emails) {
    const apps = m.applications.filter((a) => a.email === email).sort((a, b) => b.updated - a.updated);
    const prior = m.applicants.find((p) => p.email === email);
    const next = {
      email, name: apps[0].name, cornell: apps.some((a) => a.cornell),
      firstSeen: Math.min(...apps.map((a) => a.ts), prior?.firstSeen ?? Infinity), lastSeen: Math.max(...apps.map((a) => a.updated), prior?.lastSeen ?? 0),
      applications: apps.length, erasedAt: prior?.erasedAt ?? null, doc: prior?.doc || { tags: [], note: '', memberEmail: '' },
    };
    if (prior) Object.assign(prior, next); else m.applicants.push(next);
  }
}

async function upsertApplicantsPg(kit, cycleId) {
  const s = await kit.sql();
  await s`INSERT INTO recruit_applicants (email, name, cornell, first_seen, last_seen, applications)
    SELECT email, (array_agg(name ORDER BY updated DESC))[1], bool_or(cornell), min(ts), max(updated),
      (SELECT count(*) FROM recruit_applications x WHERE x.email = a.email)::int
    FROM recruit_applications a WHERE cycle_id = ${cycleId} GROUP BY email
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, cornell = recruit_applicants.cornell OR EXCLUDED.cornell,
      first_seen = LEAST(recruit_applicants.first_seen, EXCLUDED.first_seen), last_seen = GREATEST(recruit_applicants.last_seen, EXCLUDED.last_seen),
      applications = EXCLUDED.applications`;
}

async function countIn(kit, cycleId) {
  if (kit.mode === 'memory') return kit.mem.applications.filter((a) => a.cycleId === cycleId).length;
  const s = await kit.sql();
  return Number((await s`SELECT count(*) AS n FROM recruit_applications WHERE cycle_id = ${cycleId}`).rows[0]?.n || 0);
}

// The migration state: which archives have a cycle, what is next.
export async function migrationState(kit) {
  const settings = await kit.cycles.settings();
  const migration = isObject(settings.doc.migration) ? settings.doc.migration : null;
  const summary = await legacySummary(kit);
  const cycles = await kit.cycles.list({ all: true });
  const byArchive = new Map(cycles.filter((c) => c.legacy?.archiveId).map((c) => [c.legacy.archiveId, c.id]));
  const legacyArchives = summary.archives.map((a) => ({ id: a.id, ts: a.ts, name: a.name, count: a.count, cycleId: byArchive.get(a.id) || null }));
  const pending = [...legacyArchives].sort((a, b) => a.ts - b.ts).find((a) => !a.cycleId);
  const liveDone = Boolean(migration) && cycles.some((c) => c.id === LIVE_CYCLE);
  const next = !liveDone ? { step: 'live' } : pending ? { step: 'archive', archiveId: pending.id } : null;
  return { done: liveDone && !pending, migration, legacyLive: summary.live, legacyArchives, orphans: summary.orphans, next, available: summary.available };
}

async function stampDuplicates(kit, cycles, summary) {
  let duplicates = 0;
  for (const a of summary.archives) {
    const c = cycles.find((x) => x.legacy?.archiveId === a.id);
    if (c) duplicates += Math.max(0, a.count - await countIn(kit, c.id));
  }
  return duplicates;
}

// importLegacy(kit, { step:'live' | 'archive', archiveId?, by }) → migrationState
export async function importLegacy(kit, step = {}) {
  const by = String(step.by || 'system');
  const now = kit.now();
  const label = liveCycleLabel(now);
  const defaults = kit.cycles.defaultDoc({ id: LIVE_CYCLE, name: label.name, term: label.term });
  const settingsBefore = await kit.cycles.settings();
  if (step.step === 'live') {
    if (kit.mode === 'memory') {
      const m = kit.mem;
      const d = readLegacyFile();
      if (!m.cycles.some((c) => c.id === LIVE_CYCLE)) {
        m.cycles.push({ id: LIVE_CYCLE, version: 1, status: 'open', name: label.name, term: label.term, opensAt: null, closesAt: null, closedAt: null, created: now, createdBy: by, updated: now, updatedBy: by, formVersion: 0, doc: defaults, legacy: { source: 'live' } });
      }
      await copyRows(kit, LIVE_CYCLE, d.rows);
      refreshApplicants(kit, LIVE_CYCLE);
      const settings = m.settings;
      if (!settings.doc.intakeCycleId) { settings.doc.intakeCycleId = LIVE_CYCLE; settings.version++; }
      if (!isObject(settings.doc.migration)) { settings.doc.migration = { at: now, by, live: await countIn(kit, LIVE_CYCLE), archives: {}, duplicates: 0 }; settings.version++; }
      kit.memSave();
    } else {
      const s = await kit.sql();
      const exists = await legacyTablesExist(kit);
      await s`INSERT INTO recruit_cycles (id, status, name, term, created, updated, created_by, updated_by, legacy, doc)
        VALUES (${LIVE_CYCLE}, 'open', ${label.name}, ${label.term}, ${now}, ${now}, ${by}, ${by}, '{"source":"live"}'::jsonb, ${JSON.stringify(defaults)}::jsonb)
        ON CONFLICT (id) DO NOTHING`;
      if (exists.live) {
        await s`INSERT INTO recruit_applications (id, cycle_id, email, ts, updated, name, cornell, subteam, year, source, form_version, answers, files, stage, stage_at, stage_history, review, review_version, ip_hash)
          SELECT id, ${LIVE_CYCLE}, lower(email), ts, updated, name, cornell, subteam, year, 'migrated', 0, jsonb_build_object('project', project),
            CASE WHEN file_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('id', file_id, 'question', 'file', 'name', file_name, 'type', file_type, 'size', file_size)) END,
            'applied', ts, jsonb_build_array(jsonb_build_object('stage', 'applied', 'at', ts, 'by', 'migration')), review, review_version, ip_hash
          FROM interest_submissions ON CONFLICT (id) DO NOTHING`;
        await upsertApplicantsPg(kit, LIVE_CYCLE);
      }
      await s`UPDATE recruit_settings SET doc = doc || jsonb_build_object('intakeCycleId', ${LIVE_CYCLE}::text), version = version + 1 WHERE id = 1 AND doc->>'intakeCycleId' IS NULL`;
      const live = await countIn(kit, LIVE_CYCLE);
      await s`UPDATE recruit_settings SET doc = jsonb_set(doc, '{migration}', ${JSON.stringify({ at: now, by, live, archives: {}, duplicates: 0 })}::jsonb), version = version + 1 WHERE id = 1 AND doc->>'migration' IS NULL`;
    }
    kit.uncache();
  } else if (step.step === 'archive') {
    const archiveId = String(step.archiveId || '');
    if (!/^ar-[a-z0-9]+$/.test(archiveId)) throw Object.assign(new Error('Unknown archive'), { status: 400, error: 'Unknown archive' });
    if (!isObject(settingsBefore.doc.migration)) throw Object.assign(new Error('Import the current list first'), { status: 409, error: 'Import the current list first' });
    const cycleId = cycleIdForArchive(archiveId);
    if (kit.mode === 'memory') {
      const m = kit.mem;
      const a = readLegacyFile().archives.find((x) => x.id === archiveId);
      if (!a) throw Object.assign(new Error('No such archive'), { status: 404, error: 'No such archive' });
      const cycleDoc = kit.cycles.defaultDoc({ id: cycleId, name: a.name, term: termOf(a.name) });
      if (!m.cycles.some((c) => c.id === cycleId || c.legacy?.archiveId === archiveId)) {
        m.cycles.push({ id: cycleId, version: 1, status: 'archived', name: a.name, term: termOf(a.name), opensAt: null, closesAt: null, closedAt: a.ts, created: a.ts, createdBy: by, updated: now, updatedBy: by, formVersion: 0, doc: cycleDoc, legacy: { source: 'archive', archiveId, archivedAt: a.ts } });
      }
      await copyRows(kit, cycleId, a.rows || []);
      refreshApplicants(kit, cycleId);
      m.settings.doc.migration.archives = { ...(m.settings.doc.migration.archives || {}), [archiveId]: cycleId };
      m.settings.doc.migration.duplicates = await stampDuplicates(kit, m.cycles, await legacySummary(kit));
      m.settings.version++;
      kit.memSave();
    } else {
      const s = await kit.sql();
      const a = (await s`SELECT id, ts, name, count FROM interest_archives WHERE id = ${archiveId}`).rows[0];
      if (!a) throw Object.assign(new Error('No such archive'), { status: 404, error: 'No such archive' });
      const cycleDoc = kit.cycles.defaultDoc({ id: cycleId, name: a.name, term: termOf(a.name) });
      await s`INSERT INTO recruit_cycles (id, status, name, term, created, updated, closed_at, created_by, updated_by, legacy, doc)
        VALUES (${cycleId}, 'archived', ${a.name}, ${termOf(a.name)}, ${Number(a.ts)}, ${now}, ${Number(a.ts)}, ${by}, ${by},
          ${JSON.stringify({ source: 'archive', archiveId, archivedAt: Number(a.ts) })}::jsonb, ${JSON.stringify(cycleDoc)}::jsonb)
        ON CONFLICT (id) DO NOTHING`;
      await s`INSERT INTO recruit_applications (id, cycle_id, email, ts, updated, name, cornell, subteam, year, source, form_version, answers, files, stage, stage_at, stage_history, review, review_version, ip_hash)
        SELECT r.id, ${cycleId}, lower(r.email), r.ts, COALESCE(r.updated, r.ts), COALESCE(r.name, ''), COALESCE(r.cornell, false), COALESCE(r.subteam, ''), r.year, 'migrated', 0,
          jsonb_build_object('project', COALESCE(r.project, '')),
          CASE WHEN r."fileId" IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('id', r."fileId", 'question', 'file', 'name', r."fileName", 'type', r."fileType", 'size', r."fileSize")) END,
          'applied', r.ts, jsonb_build_array(jsonb_build_object('stage', 'applied', 'at', r.ts, 'by', 'migration')), COALESCE(r.review, '{}'::jsonb), COALESCE(r."reviewVersion", 0), ''
        FROM (
          SELECT DISTINCT ON (lower(x.email)) x.* FROM interest_archives a,
            jsonb_to_recordset(a.rows) AS x(id text, ts bigint, updated bigint, name text, email text, subteam text, project text, cornell boolean, year text, "fileId" text, "fileName" text, "fileType" text, "fileSize" int, review jsonb, "reviewVersion" bigint)
          WHERE a.id = ${archiveId} ORDER BY lower(x.email), x.ts
        ) r
        ON CONFLICT (id) DO NOTHING`;
      await upsertApplicantsPg(kit, cycleId);
      const cycles = await kit.cycles.list({ all: true });
      const duplicates = await stampDuplicates(kit, cycles, await legacySummary(kit));
      await s`UPDATE recruit_settings SET doc = jsonb_set(doc, '{migration}', (doc->'migration') || jsonb_build_object('archives', COALESCE(doc->'migration'->'archives', '{}'::jsonb) || ${JSON.stringify({ [archiveId]: cycleId })}::jsonb, 'duplicates', ${duplicates}::int)), version = version + 1
        WHERE id = 1 AND doc->>'migration' IS NOT NULL`;
    }
    kit.uncache();
  } else {
    throw Object.assign(new Error('Unknown migration step'), { status: 400, error: 'Unknown migration step' });
  }
  const state = await migrationState(kit);
  if (state.done && !settingsBefore.doc.migration?.completedAt) {
    // Stamp completion once and record it.
    if (kit.mode === 'memory') { kit.mem.settings.doc.migration.completedAt = now; kit.mem.settings.version++; kit.memSave(); }
    else {
      const s = await kit.sql();
      await s`UPDATE recruit_settings SET doc = jsonb_set(doc, '{migration,completedAt}', ${String(now)}::jsonb), version = version + 1 WHERE id = 1 AND doc->>'migration' IS NOT NULL AND doc->'migration'->>'completedAt' IS NULL`;
    }
    kit.uncache();
    await kit.audit({ kind: 'migrate', cycleId: LIVE_CYCLE, actor: by, detail: { live: state.migration?.live ?? 0, archives: Object.keys(state.migration?.archives || {}).length, duplicates: state.migration?.duplicates ?? 0 } });
    return migrationState(kit);
  }
  return state;
}

// Adopt legacy rows that never reached recruit (arrived while no cycle was
// receiving the form) into a cycle as source 'orphan'. Returns { adopted }.
export async function adoptOrphans(kit, cycle) {
  if (kit.mode === 'memory') {
    const rows = await legacyOrphans(kit);
    const adopted = await copyRows(kit, cycle.id, rows, 'orphan');
    refreshApplicants(kit, cycle.id);
    kit.memSave();
    return { adopted };
  }
  const s = await kit.sql();
  if (!(await legacyTablesExist(kit)).live) return { adopted: 0 };
  const r = await s`INSERT INTO recruit_applications (id, cycle_id, email, ts, updated, name, cornell, subteam, year, source, form_version, answers, files, stage, stage_at, stage_history, review, review_version, ip_hash)
    SELECT id, ${cycle.id}, lower(email), ts, updated, name, cornell, subteam, year, 'orphan', 0, jsonb_build_object('project', project),
      CASE WHEN file_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('id', file_id, 'question', 'file', 'name', file_name, 'type', file_type, 'size', file_size)) END,
      'applied', ts, jsonb_build_array(jsonb_build_object('stage', 'applied', 'at', ts, 'by', 'migration')), review, review_version, ip_hash
    FROM interest_submissions s WHERE NOT EXISTS (SELECT 1 FROM recruit_applications a WHERE a.id = s.id)
      AND NOT EXISTS (SELECT 1 FROM recruit_applications a WHERE a.cycle_id = ${cycle.id} AND a.email = lower(s.email))
    ON CONFLICT DO NOTHING RETURNING id`;
  await upsertApplicantsPg(kit, cycle.id);
  return { adopted: r.rows.length };
}
