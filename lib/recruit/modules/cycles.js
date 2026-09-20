// Cycles module (kernel): the settings row (one CAS document), the cycle
// records and their lifecycle, which cycle receives the website form, and
// the legacy import routes. Provides kit.cycles to every other module.

import { DEFAULT_SUBTEAMS, slug } from '../fixed-form.js';
import { sectionsFor, validateSite } from '../sections.js';
import { importLegacy, adoptOrphans, migrationState, liveCycleLabel, LIVE_CYCLE } from '../migrate.js';

const STATUSES = ['draft', 'open', 'closed', 'archived'];
const TRANSITIONS = { 'draft>open': 'lead', 'open>closed': 'lead', 'closed>open': 'lead', 'closed>archived': 'admin', 'archived>closed': 'admin' };
const KERNEL_SECTIONS = new Set(['modules', 'intake', 'subteams', 'site']);
const ADMIN_SECTIONS = new Set(['modules', 'intake', 'onboarding']);
const REQUEST_ID = /^rq-[a-z0-9-]{8,80}$/;
const TARGET_TTL = 10000;
const NOTIFY = (process.env.INTEREST_NOTIFY || 'ab3233@cornell.edu').split(',').map((s) => s.trim()).filter(Boolean);

const fail = (status, error, extra = {}) => Object.assign(new Error(error), { status, error, ...extra });
const isObject = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const asObject = (v) => (isObject(v) ? v : typeof v === 'string' ? (() => { try { const p = JSON.parse(v); return isObject(p) ? p : {}; } catch { return {}; } })() : {});
const num = (v) => (v == null ? null : Number(v));
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const nonKernel = (modules) => modules.filter((m) => !m.kernel);

// The import before Sept 20, 2026 labelled the live cycle "Interest list /
// Rolling". Such a cycle reads as its term until someone renames it; a name
// saved from Settings is kept as typed.
const labelled = (c) => (c && c.name === 'Interest list' && c.term === 'Rolling' ? { ...c, ...liveCycleLabel(c.created || Date.now()) } : c);

const cycleFromPg = (r) => ({
  id: r.id, version: Number(r.version), status: r.status, name: r.name, term: r.term || '',
  opensAt: num(r.opens_at), closesAt: num(r.closes_at), closedAt: num(r.closed_at),
  created: Number(r.created), createdBy: r.created_by || '', updated: Number(r.updated), updatedBy: r.updated_by || '',
  formVersion: Number(r.form_version || 0), doc: asObject(r.doc), legacy: r.legacy ? asObject(r.legacy) : null,
});
const clone = (c) => (c ? JSON.parse(JSON.stringify(c)) : null);

/* ------------------------------- defaults ------------------------------- */

function moduleDefaults(modules, cycle) {
  const out = {};
  for (const m of nonKernel(modules)) {
    if (typeof m.defaults !== 'function') continue;
    try { out[m.name] = m.defaults(cycle) ?? {}; } catch (e) { out[m.name] = {}; }
  }
  return out;
}

export function defaultDoc(modules, cycle = {}) {
  return {
    description: '', capacity: 0,
    subteams: DEFAULT_SUBTEAMS.map((s) => ({ ...s, leads: [] })),
    modules: Object.fromEntries(nonKernel(modules).map((m) => [m.name, true])),
    intake: { perIpHour: 5, perDay: 2000, notify: true, confirmUpdate: true },
    ...moduleDefaults(modules, cycle),
  };
}

function settingsSeed(modules) {
  const d = moduleDefaults(modules, null);
  return {
    intakeCycleId: null, migration: null, notify: NOTIFY, retention: { months: 24 },
    defaults: { subteams: DEFAULT_SUBTEAMS.map((s) => ({ ...s })), ...(Object.keys(d).length ? { modules: d } : {}) },
  };
}

/* ------------------------------- validation ----------------------------- */

function validateSubteams(input) {
  if (!Array.isArray(input) || !input.length) throw fail(400, 'Keep at least one subteam');
  if (input.length > 20) throw fail(400, 'Keep it to 20 subteams');
  const seen = new Set();
  return input.map((raw) => {
    if (!isObject(raw)) throw fail(400, 'Each subteam needs a name');
    const name = clip(raw.name, 40);
    if (!name) throw fail(400, 'Each subteam needs a name');
    const key = /^[a-z][a-z0-9-]{0,39}$/.test(String(raw.key || '')) ? raw.key : slug(name);
    if (!key || seen.has(key)) throw fail(400, `Subteam "${name}" is listed twice`);
    seen.add(key);
    const capacity = Math.max(0, Math.min(100000, Math.floor(Number(raw.capacity) || 0)));
    const leads = Array.isArray(raw.leads) ? [...new Set(raw.leads.map((e) => String(e).trim().toLowerCase()).filter(Boolean))].slice(0, 20) : [];
    return { key, name, capacity, leads };
  });
}

function validateIntake(input) {
  if (!isObject(input)) throw fail(400, 'Intake settings must be an object');
  const perIpHour = Math.max(1, Math.min(1000, Math.floor(Number(input.perIpHour) || 5)));
  const perDay = Math.max(1, Math.min(100000, Math.floor(Number(input.perDay) || 2000)));
  return { perIpHour, perDay, notify: input.notify !== false, confirmUpdate: input.confirmUpdate !== false };
}

function validateSettings(next) {
  if (!isObject(next)) throw fail(400, 'Settings must be an object');
  const out = {};
  if (next.description !== undefined) out.description = String(next.description ?? '').trim().slice(0, 2000);
  if (next.capacity !== undefined) {
    const n = Number(next.capacity);
    if (!Number.isInteger(n) || n < 0 || n > 1000000) throw fail(400, 'Capacity must be a whole number (0 = unlimited)');
    out.capacity = n;
  }
  if (next.subteams !== undefined) out.subteams = validateSubteams(next.subteams);
  if (next.intake !== undefined) out.intake = validateIntake(next.intake);
  if (next.modules !== undefined) {
    if (!isObject(next.modules)) throw fail(400, 'Modules must be a map of name to on/off');
    out.modules = Object.fromEntries(Object.entries(next.modules).filter(([k]) => /^[a-z]+$/.test(k)).map(([k, v]) => [k, v !== false]));
  }
  return out;
}

const dateValue = (v, label) => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
  if (!m) throw fail(400, `${label} must be a date like 2026-10-03`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(t)) throw fail(400, `${label} must be a date like 2026-10-03`);
  return t;
};

/* -------------------------------- storage ------------------------------- */

function makeFacade(kit) {
  const memSettings = () => {
    const m = kit.mem;
    if (!m.settings || !isObject(m.settings.doc)) { m.settings = { version: 1, doc: settingsSeed(kit.modules) }; kit.memSave(); }
    return m.settings;
  };

  const facade = {
    defaultDoc: (cycle) => defaultDoc(kit.modules, cycle),

    async settings() {
      if (kit.mode === 'memory') { const s = memSettings(); return { version: s.version, doc: s.doc }; }
      const s = await kit.sql();
      const r = await s`SELECT version, doc FROM recruit_settings WHERE id = 1`;
      const row = r.rows[0];
      return row ? { version: Number(row.version), doc: asObject(row.doc) } : { version: 0, doc: settingsSeed(kit.modules) };
    },

    async get(id) {
      if (!id) return null;
      if (kit.mode === 'memory') return labelled(clone(kit.mem.cycles.find((c) => c.id === id) || null));
      const s = await kit.sql();
      const r = await s`SELECT * FROM recruit_cycles WHERE id = ${id}`;
      return r.rows[0] ? labelled(cycleFromPg(r.rows[0])) : null;
    },

    async list({ all = false, ids = null } = {}) {
      if (kit.mode === 'memory') {
        return kit.mem.cycles.filter((c) => (all || c.status !== 'archived') && (!ids || ids.includes(c.id)))
          .sort((a, b) => b.updated - a.updated).map((c) => labelled(clone(c)));
      }
      const s = await kit.sql();
      const q = kit.build();
      q`SELECT * FROM recruit_cycles WHERE true`;
      if (!all) q` AND status <> 'archived'`;
      if (ids) q` AND id = ANY(${ids})`;
      q` ORDER BY updated DESC`;
      return (await q.run(s)).rows.map((r) => labelled(cycleFromPg(r)));
    },

    // One projection, cached 10 s per instance: the settings pointer joined
    // to the open cycle it names (or null) plus the migration flag.
    async pointer() {
      return kit.cached('cycles.pointer', TARGET_TTL, async () => {
        if (kit.mode === 'memory') {
          const st = memSettings();
          const c = st.doc.intakeCycleId ? kit.mem.cycles.find((x) => x.id === st.doc.intakeCycleId && x.status === 'open') : null;
          return { migrated: isObject(st.doc.migration), intakeCycleId: st.doc.intakeCycleId || null, cycle: c ? clone(c) : null };
        }
        const s = await kit.sql();
        const r = await s`SELECT s.doc->'migration' AS migration, s.doc->>'intakeCycleId' AS intake_cycle_id, c.id, c.form_version, c.status, c.doc->'intake' AS intake, c.doc->'capacity' AS capacity
          FROM recruit_settings s LEFT JOIN recruit_cycles c ON c.id = s.doc->>'intakeCycleId' AND c.status = 'open' WHERE s.id = 1`;
        const row = r.rows[0];
        if (!row) return { migrated: false, intakeCycleId: null, cycle: null };
        return {
          migrated: isObject(row.migration), intakeCycleId: row.intake_cycle_id || null,
          cycle: row.id ? { id: row.id, formVersion: Number(row.form_version || 0), status: row.status, doc: { intake: asObject(row.intake), capacity: Number(row.capacity || 0) } } : null,
        };
      });
    },

    async intakeTarget() {
      const p = await facade.pointer();
      if (!p.cycle) return null;
      const intake = { perIpHour: 5, perDay: 2000, notify: true, confirmUpdate: true, ...(p.cycle.doc?.intake || {}) };
      return { cycleId: p.cycle.id, formVersion: p.cycle.formVersion || 0, perIpHour: intake.perIpHour, perDay: intake.perDay, capacity: Number(p.cycle.doc?.capacity || 0), notify: intake.notify !== false, confirmUpdate: intake.confirmUpdate !== false };
    },

    async migrated() {
      return (await facade.pointer()).migrated;
    },

    enabled(cycle, name) {
      const m = kit.modules.find((x) => x.name === name);
      if (m?.kernel) return true;
      return cycle?.doc?.modules?.[name] !== false;
    },

    async insert(cycle) {
      if (kit.mode === 'memory') {
        if (kit.mem.cycles.some((c) => c.id === cycle.id)) return null;
        kit.mem.cycles.push(clone(cycle)); kit.memSave();
        return clone(cycle);
      }
      const s = await kit.sql();
      const r = await s`INSERT INTO recruit_cycles (id, version, status, name, term, opens_at, closes_at, created, created_by, updated, updated_by, form_version, doc, legacy)
        VALUES (${cycle.id}, 1, ${cycle.status}, ${cycle.name}, ${cycle.term}, ${cycle.opensAt}, ${cycle.closesAt}, ${cycle.created}, ${cycle.createdBy}, ${cycle.updated}, ${cycle.updatedBy}, ${cycle.formVersion || 0}, ${JSON.stringify(cycle.doc)}::jsonb, ${cycle.legacy ? JSON.stringify(cycle.legacy) : null}::jsonb)
        ON CONFLICT (id) DO NOTHING RETURNING *`;
      return r.rows[0] ? cycleFromPg(r.rows[0]) : null;
    },

    // Version-matched update of the columns and/or a doc patch (doc || patch).
    async update(id, version, { name, term, opensAt, closesAt, status, closedAt, docPatch, docSet, by, now }) {
      if (kit.mode === 'memory') {
        const c = kit.mem.cycles.find((x) => x.id === id);
        if (!c || c.version !== version) return null;
        if (name !== undefined) c.name = name;
        if (term !== undefined) c.term = term;
        if (opensAt !== undefined) c.opensAt = opensAt;
        if (closesAt !== undefined) c.closesAt = closesAt;
        if (status !== undefined) c.status = status;
        if (closedAt !== undefined) c.closedAt = closedAt;
        if (docPatch) c.doc = { ...c.doc, ...docPatch };
        if (docSet) c.doc = { ...c.doc, [docSet.key]: docSet.value };
        c.version += 1; c.updated = now; c.updatedBy = by;
        kit.memSave();
        kit.uncache();
        return clone(c);
      }
      const s = await kit.sql();
      const q = kit.build();
      q`UPDATE recruit_cycles SET version = version + 1, updated = ${now}, updated_by = ${by}`;
      if (name !== undefined) q`, name = ${name}`;
      if (term !== undefined) q`, term = ${term}`;
      if (opensAt !== undefined) q`, opens_at = ${opensAt}`;
      if (closesAt !== undefined) q`, closes_at = ${closesAt}`;
      if (status !== undefined) q`, status = ${status}`;
      if (closedAt !== undefined) q`, closed_at = ${closedAt}`;
      if (docPatch) q`, doc = doc || ${JSON.stringify(docPatch)}::jsonb`;
      if (docSet) q`, doc = jsonb_set(doc, ${'{' + docSet.key + '}'}::text[], ${JSON.stringify(docSet.value)}::jsonb)`;
      q` WHERE id = ${id} AND version = ${version} RETURNING *`;
      const r = await q.run(s);
      kit.uncache();
      return r.rows[0] ? cycleFromPg(r.rows[0]) : null;
    },

    // Closing or archiving the receiving cycle also clears the pointer.
    async clearPointerFor(id) {
      if (kit.mode === 'memory') {
        const st = memSettings();
        if (st.doc.intakeCycleId === id) { delete st.doc.intakeCycleId; st.version++; kit.memSave(); }
      } else {
        const s = await kit.sql();
        await s`UPDATE recruit_settings SET doc = doc - 'intakeCycleId', version = version + 1 WHERE id = 1 AND doc->>'intakeCycleId' = ${id}`;
      }
      kit.uncache();
    },

    async setPointer(id, on, version) {
      if (kit.mode === 'memory') {
        const st = memSettings();
        if (st.version !== version) return null;
        if (on) {
          const c = kit.mem.cycles.find((x) => x.id === id && x.status === 'open');
          if (!c) return null;
          st.doc.intakeCycleId = id;
        } else if (st.doc.intakeCycleId === id) delete st.doc.intakeCycleId;
        st.version++; kit.memSave(); kit.uncache();
        return { version: st.version, doc: st.doc };
      }
      const s = await kit.sql();
      const r = on
        ? await s`UPDATE recruit_settings SET doc = doc || jsonb_build_object('intakeCycleId', ${id}::text), version = version + 1
            WHERE id = 1 AND version = ${version} AND EXISTS (SELECT 1 FROM recruit_cycles WHERE id = ${id} AND status = 'open') RETURNING version, doc`
        : await s`UPDATE recruit_settings SET doc = CASE WHEN doc->>'intakeCycleId' = ${id} THEN doc - 'intakeCycleId' ELSE doc END, version = version + 1
            WHERE id = 1 AND version = ${version} RETURNING version, doc`;
      kit.uncache();
      return r.rows[0] ? { version: Number(r.rows[0].version), doc: asObject(r.rows[0].doc) } : null;
    },

    async counts(cycleIds = null) {
      const out = {};
      const add = (cycleId, stage, section, n) => {
        const c = (out[cycleId] ||= { total: 0, byStage: {}, bySection: {} });
        c.total += n; c.byStage[stage] = (c.byStage[stage] || 0) + n; c.bySection[section] = (c.bySection[section] || 0) + n;
      };
      if (kit.mode === 'memory') {
        for (const a of kit.mem.applications) if (!cycleIds || cycleIds.includes(a.cycleId)) add(a.cycleId, a.stage, a.section || 'interest', 1);
        return out;
      }
      const s = await kit.sql();
      const q = kit.build();
      q`SELECT cycle_id, stage, section, count(*)::int AS n FROM recruit_applications WHERE true`;
      if (cycleIds) q` AND cycle_id = ANY(${cycleIds})`;
      q` GROUP BY cycle_id, stage, section`;
      for (const r of (await q.run(s)).rows) add(r.cycle_id, r.stage, r.section || 'interest', Number(r.n));
      return out;
    },

    // Ordered, idempotent deletes across every mounted module's table, then
    // the applications (files returned for the reference check) and the cycle.
    async remove(cycle) {
      const id = cycle.id;
      let files = [];
      if (kit.mode === 'memory') {
        const m = kit.mem;
        const appIds = new Set(m.applications.filter((a) => a.cycleId === id).map((a) => a.id));
        for (const key of Object.keys(m)) {
          if (!Array.isArray(m[key]) || ['cycles', 'applications', 'audit', 'requests', 'applicants'].includes(key)) continue;
          m[key] = m[key].filter((row) => !(row.cycleId === id || (row.applicationId && appIds.has(row.applicationId))));
        }
        files = m.applications.filter((a) => a.cycleId === id).flatMap((a) => (a.files || []).map((f) => f.id));
        m.applications = m.applications.filter((a) => a.cycleId !== id);
        m.cycles = m.cycles.filter((c) => c.id !== id);
        kit.memSave();
      } else {
        const s = await kit.sql();
        const t = kit.tables;
        if (t.has('recruit_mail')) await s`DELETE FROM recruit_mail WHERE cycle_id = ${id}`;
        if (t.has('recruit_bookings')) await s`DELETE FROM recruit_bookings WHERE cycle_id = ${id}`;
        if (t.has('recruit_slots')) await s`DELETE FROM recruit_slots WHERE cycle_id = ${id}`;
        if (t.has('recruit_scores')) await s`DELETE FROM recruit_scores WHERE application_id IN (SELECT id FROM recruit_applications WHERE cycle_id = ${id})`;
        if (t.has('recruit_assignments')) await s`DELETE FROM recruit_assignments WHERE application_id IN (SELECT id FROM recruit_applications WHERE cycle_id = ${id})`;
        await s`DELETE FROM recruit_roles WHERE cycle_id = ${id}`;
        if (t.has('recruit_forms')) await s`DELETE FROM recruit_forms WHERE cycle_id = ${id}`;
        if (t.has('recruit_onboarding')) await s`DELETE FROM recruit_onboarding WHERE cycle_id = ${id}`;
        const r = await s`DELETE FROM recruit_applications WHERE cycle_id = ${id} RETURNING files`;
        files = r.rows.flatMap((x) => kit.asArray(x.files).map((f) => f.id));
        await s`DELETE FROM recruit_cycles WHERE id = ${id}`;
      }
      await facade.clearPointerFor(id);
      for (const fileId of new Set(files.filter(Boolean))) {
        try { await kit.files.removeUnreferenced(fileId); } catch (e) { /* retain on cleanup failure */ }
      }
      return files.length;
    },
  };
  return facade;
}

/* --------------------------------- routes -------------------------------- */

const isLead = (role) => role === 'admin' || role === 'lead';
const requestIdOf = (body) => { const id = String(body?.requestId || ''); if (!REQUEST_ID.test(id)) throw fail(400, 'A request ID is required'); return id; };
const versionOf = (body) => { const v = Number(body?.version); if (!Number.isInteger(v) || v < 0) throw fail(400, 'Send the version you loaded'); return v; };

// Non-leads never see templates or intake limits.
function docFor(cycle, role) {
  if (isLead(role)) return cycle.doc;
  const doc = { ...cycle.doc };
  delete doc.intake;
  return doc;
}

async function listCycles(rq, kit) {
  const all = rq.query.all === '1' || rq.query.all === 'true';
  const admin = rq.role === 'admin';
  const mine = admin ? null : new Map((rq.grant?.cycles || []).map((g) => [g.cycleId, g.roles]));
  let cycles = await kit.cycles.list({ all: true, ids: mine ? [...mine.keys()] : null });
  if (!all) cycles = cycles.filter((c) => c.status !== 'archived');
  const settings = await kit.cycles.settings();
  const counts = await kit.cycles.counts(cycles.map((c) => c.id));
  const rows = cycles.map((c) => ({
    id: c.id, name: c.name, term: c.term, status: c.status, opensAt: c.opensAt, closesAt: c.closesAt,
    intake: settings.doc.intakeCycleId === c.id && c.status === 'open', formVersion: c.formVersion,
    counts: counts[c.id] || { total: 0, byStage: {}, bySection: {} }, updated: c.updated, version: c.version,
    myRoles: admin ? ['admin'] : (mine.get(c.id) || []), legacy: c.legacy || null,
  }));
  let migration = null;
  if (admin) {
    try {
      const st = await migrationState(kit);
      migration = { done: st.done, legacyLive: st.legacyLive, legacyArchives: st.legacyArchives, orphans: st.orphans, next: st.next };
    } catch (e) { migration = { done: false, legacyLive: 0, legacyArchives: [], orphans: 0, next: null, unavailable: true }; }
  }
  return { status: 200, body: { cycles: rows, intakeCycleId: settings.doc.intakeCycleId || null, migration } };
}

async function createCycle(rq, kit) {
  const body = await rq.body();
  const requestId = requestIdOf(body);
  const name = clip(body.name, 80);
  if (!name) throw fail(400, 'Give the cycle a name');
  const term = clip(body.term, 40);
  let doc = null;
  if (body.copyFrom) {
    const from = await kit.cycles.get(String(body.copyFrom));
    if (!from) throw fail(404, 'No such cycle to copy');
    doc = JSON.parse(JSON.stringify(from.doc));
  }
  const now = kit.now();
  const id = kit.id('cy');
  const cycle = { id, version: 1, status: 'draft', name, term, opensAt: null, closesAt: null, closedAt: null, created: now, createdBy: rq.me.email, updated: now, updatedBy: rq.me.email, formVersion: 0, doc: doc || defaultDoc(kit.modules, { id, name, term }), legacy: null };
  const result = await kit.once(requestId, rq.me.email, async () => {
    const saved = await kit.cycles.insert(cycle);
    await kit.emit('cycle.created', { cycle: saved });
    return { cycle: saved };
  });
  return { status: 201, body: result, audit: { kind: 'cycle.create', cycleId: result.cycle?.id || id, detail: { requestId, copyFrom: body.copyFrom ? String(body.copyFrom) : null } } };
}

async function getCycle(rq, kit) {
  const cycle = rq.cycle;
  const counts = (await kit.cycles.counts([cycle.id]))[cycle.id] || { total: 0, byStage: {}, bySection: {} };
  const sections = sectionsFor(cycle);
  const roles = isLead(rq.role) ? await rolesFor(kit, cycle.id) : undefined;
  const settings = await kit.cycles.settings();
  return {
    status: 200,
    body: {
      cycle: { ...cycle, doc: docFor(cycle, rq.role), intake: settings.doc.intakeCycleId === cycle.id && cycle.status === 'open' },
      sections, ...(roles ? { roles } : {}), counts, me: { roles: rq.role === 'admin' ? ['admin'] : (rq.grant?.roles || []) },
    },
  };
}

async function rolesFor(kit, cycleId) {
  if (kit.mode === 'memory') return kit.mem.roles.filter((g) => g.cycleId === cycleId).map((g) => ({ member: g.member, roles: g.roles, subteams: g.subteams, ts: g.ts }));
  const s = await kit.sql();
  const r = await s`SELECT member, roles, subteams, ts FROM recruit_roles WHERE cycle_id = ${cycleId} ORDER BY ts`;
  return r.rows.map((g) => ({ member: g.member, roles: kit.asArray(g.roles), subteams: kit.asArray(g.subteams), ts: Number(g.ts || 0) }));
}

async function patchCycle(rq, kit) {
  const body = await rq.body();
  const version = versionOf(body);
  const patch = {};
  if (body.name !== undefined) { patch.name = clip(body.name, 80); if (!patch.name) throw fail(400, 'Give the cycle a name'); }
  if (body.term !== undefined) patch.term = clip(body.term, 40);
  if (body.opensAt !== undefined) patch.opensAt = dateValue(body.opensAt, 'Opens');
  if (body.closesAt !== undefined) patch.closesAt = dateValue(body.closesAt, 'Closes');
  const docPatch = validateSettings({ ...(body.description !== undefined ? { description: body.description } : {}), ...(body.capacity !== undefined ? { capacity: body.capacity } : {}) });
  if (docPatch.capacity !== undefined && rq.role !== 'admin') throw fail(403, 'Admins set the capacity');
  const cycle = await kit.cycles.update(rq.cycle.id, version, { ...patch, docPatch: Object.keys(docPatch).length ? docPatch : null, by: rq.me.email, now: kit.now() });
  if (!cycle) { const cur = await kit.cycles.get(rq.cycle.id); throw fail(409, 'This cycle changed. Reload.', { version: cur?.version ?? null }); }
  return { status: 200, body: { cycle }, audit: { kind: 'cycle.update', detail: { fields: [...Object.keys(patch), ...Object.keys(docPatch)] } } };
}

async function putSettings(rq, kit) {
  const name = rq.params.module;
  const body = await rq.body();
  const version = versionOf(body);
  const target = kit.modules.find((m) => m.name === name && !m.kernel);
  if (!target && !KERNEL_SECTIONS.has(name)) throw fail(404, 'No such settings section');
  if (ADMIN_SECTIONS.has(name) && rq.role !== 'admin') throw fail(403, 'Admins only');
  let value;
  let docPatch = null;
  if (target) {
    value = await target.validateSettings(body.settings, rq.cycle, kit);
    if (value === undefined) value = body.settings;
  } else if (name === 'site') {
    value = validateSite(body.settings, rq.cycle);
  } else if (name === 'modules') {
    const map = validateSettings({ modules: body.settings }).modules;
    const known = Object.fromEntries(nonKernel(kit.modules).map((m) => [m.name, map[m.name] !== false]));
    docPatch = { modules: known };
    for (const m of nonKernel(kit.modules)) if (known[m.name] && !isObject(rq.cycle.doc[m.name])) docPatch[m.name] = m.defaults?.(rq.cycle) ?? {};
  } else {
    value = validateSettings({ [name]: body.settings })[name];
  }
  const cycle = await kit.cycles.update(rq.cycle.id, version, { by: rq.me.email, now: kit.now(), ...(docPatch ? { docPatch } : { docSet: { key: name, value } }) });
  if (!cycle) { const cur = await kit.cycles.get(rq.cycle.id); throw fail(409, 'This cycle changed. Reload.', { version: cur?.version ?? null }); }
  kit.uncache();
  return { status: 200, body: { cycle }, audit: { kind: `cycle.settings.${name}`, detail: { module: name } } };
}

async function setStatus(rq, kit) {
  const body = await rq.body();
  const version = versionOf(body);
  const to = String(body.status || '');
  if (!STATUSES.includes(to)) throw fail(400, 'Choose draft, open, closed or archived');
  const from = rq.cycle.status;
  if (from === to) return { status: 200, body: { cycle: rq.cycle } };
  const need = TRANSITIONS[`${from}>${to}`];
  if (!need) throw fail(409, `A ${from} cycle cannot become ${to}`);
  if (need === 'admin' && rq.role !== 'admin') throw fail(403, 'Admins only');
  const now = kit.now();
  const cycle = await kit.cycles.update(rq.cycle.id, version, { status: to, closedAt: to === 'closed' || to === 'archived' ? (rq.cycle.closedAt || now) : undefined, by: rq.me.email, now });
  if (!cycle) { const cur = await kit.cycles.get(rq.cycle.id); throw fail(409, 'This cycle changed. Reload.', { version: cur?.version ?? null }); }
  if (to === 'closed' || to === 'archived') await kit.cycles.clearPointerFor(cycle.id);
  kit.uncache();
  await kit.emit('cycle.status', { cycle, from, to, by: rq.me.email });
  return { status: 200, body: { cycle }, audit: { kind: 'cycle.status', detail: { from, to } } };
}

async function setIntake(rq, kit) {
  const body = await rq.body();
  const version = versionOf(body);
  const on = body.on === true;
  if (on) {
    if (rq.cycle.status !== 'open') throw fail(409, 'Open the cycle before it can receive the form');
    if (!(await kit.cycles.migrated())) throw fail(409, 'Import the current list and archives first');
  }
  const out = await kit.cycles.setPointer(rq.cycle.id, on, version);
  if (!out) { const cur = await kit.cycles.settings(); throw fail(409, 'Settings changed. Reload.', { version: cur.version }); }
  return { status: 200, body: { intakeCycleId: out.doc.intakeCycleId || null, version: out.version }, audit: { kind: 'cycle.intake', detail: { on } } };
}

async function deleteCycle(rq, kit) {
  const cycle = rq.cycle;
  const counts = (await kit.cycles.counts([cycle.id]))[cycle.id];
  const total = counts?.total || 0;
  let confirm = rq.query.confirm;
  if (confirm === undefined) { try { confirm = (await rq.body())?.confirm; } catch (e) { confirm = undefined; } }
  if (cycle.status === 'draft' && total === 0) { /* deletable */ }
  else if (cycle.status === 'archived') { if (String(confirm || '') !== cycle.name) throw fail(400, 'Type the cycle name to confirm'); }
  else throw fail(409, 'Only empty drafts and archived cycles can be deleted');
  await kit.audit({ kind: 'cycle.delete', cycleId: cycle.id, actor: rq.me.email, detail: { applications: total, status: cycle.status } });
  const files = await kit.cycles.remove(cycle);
  return { status: 200, body: { ok: true, applications: total, files } };
}

async function migrateGet(rq, kit) {
  return { status: 200, body: await migrationState(kit) };
}

async function migratePost(rq, kit) {
  const body = await rq.body();
  const requestId = requestIdOf(body);
  const step = String(body.step || '');
  if (!['live', 'archive'].includes(step)) throw fail(400, 'Unknown migration step');
  const result = await kit.once(requestId, rq.me.email, () => importLegacy(kit, { step, archiveId: body.archiveId, by: rq.me.email }));
  return { status: 200, body: result };
}

async function migrateAdopt(rq, kit) {
  const body = await rq.body();
  const requestId = requestIdOf(body);
  const cycle = await kit.cycles.get(String(body.cycleId || ''));
  if (!cycle) throw fail(404, 'No such cycle');
  if (cycle.status === 'archived') throw fail(409, 'This cycle is archived');
  const result = await kit.once(requestId, rq.me.email, () => adoptOrphans(kit, cycle));
  return { status: 200, body: result, audit: { kind: 'migrate', cycleId: cycle.id, detail: { adopted: result.adopted, requestId } } };
}

export default {
  name: 'cycles',
  kernel: true,
  order: 0,
  schema: (modules = []) => [
    `CREATE TABLE IF NOT EXISTS recruit_settings (id int PRIMARY KEY, version bigint NOT NULL, doc jsonb NOT NULL)`,
    `INSERT INTO recruit_settings (id, version, doc) VALUES (1, 1, '${JSON.stringify(settingsSeed(modules)).replace(/'/g, "''")}'::jsonb) ON CONFLICT DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS recruit_cycles (id text PRIMARY KEY, version bigint NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'draft', name text NOT NULL, term text NOT NULL DEFAULT '', opens_at bigint, closes_at bigint, closed_at bigint, created bigint NOT NULL, created_by text NOT NULL DEFAULT '', updated bigint NOT NULL, updated_by text NOT NULL DEFAULT '', form_version int NOT NULL DEFAULT 0, doc jsonb NOT NULL DEFAULT '{}'::jsonb, legacy jsonb)`,
    `CREATE INDEX IF NOT EXISTS recruit_cycles_status ON recruit_cycles (status, updated)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS recruit_cycles_legacy ON recruit_cycles ((legacy->>'archiveId')) WHERE legacy->>'archiveId' IS NOT NULL`,
  ],
  memory: { settings: null, cycles: [] },
  defaults: (cycle) => ({ description: '', capacity: 0, subteams: DEFAULT_SUBTEAMS.map((s) => ({ ...s })), modules: {}, intake: { perIpHour: 5, perDay: 2000, notify: true, confirmUpdate: true } }),
  validateSettings,
  provide: (kit) => ({ cycles: makeFacade(kit) }),
  routes: [
    { method: 'GET', path: '/cycles', access: 'role', handler: listCycles },
    { method: 'POST', path: '/cycles', access: 'admin', handler: createCycle },
    { method: 'GET', path: '/cycles/:cycle', access: 'role', handler: getCycle },
    { method: 'PATCH', path: '/cycles/:cycle', access: 'lead', mutates: true, handler: patchCycle },
    { method: 'PUT', path: '/cycles/:cycle/settings/:module', access: 'lead', mutates: true, cap: 262144, handler: putSettings },
    { method: 'POST', path: '/cycles/:cycle/status', access: 'lead', handler: setStatus },
    { method: 'POST', path: '/cycles/:cycle/intake', access: 'admin', mutates: true, handler: setIntake },
    { method: 'DELETE', path: '/cycles/:cycle', access: 'admin', handler: deleteCycle },
    { method: 'GET', path: '/migrate', access: 'admin', handler: migrateGet },
    { method: 'POST', path: '/migrate', access: 'admin', handler: migratePost },
    { method: 'POST', path: '/migrate/adopt', access: 'admin', handler: migrateAdopt },
  ],
  hooks: {},
  collect: {},
  auditKinds: ['cycle.create', 'cycle.update', 'cycle.status', 'cycle.intake', 'cycle.delete', 'cycle.settings', 'migrate'],
};

export { LIVE_CYCLE, settingsSeed };
