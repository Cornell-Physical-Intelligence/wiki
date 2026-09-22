// The kit: everything a recruit module touches instead of the world. One
// per request (it carries the request's ctx), sharing a per-instance store
// (schema-ready promise, memory document, caches, pre-gate counters).
// Modules never import db.js; they call kit.sql() / kit.mem, kit.once,
// kit.audit, kit.emit/collect, kit.files, kit.roles and the facades that the
// kernel modules provide (kit.cycles, kit.apps).

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { storageMode, rawSql, putFile, getFile, deleteFile } from '../db.js';
import { attachmentHeaders } from '../attachment-headers.js';
import { once as eventOnce } from 'node:events';
import { roleOf } from './permissions.js';

const DEV_FILE = new URL('../../.devrecruit.json', import.meta.url);
const DEV_TMP = new URL('../../.devrecruit.json.tmp', import.meta.url);
const DEV_WIKI = new URL('../../.devdata.json', import.meta.url);
const WEEK = 7 * 86400000;
const REQUEST_ID = /^rq-[a-z0-9-]{8,80}$/;
const BASE_MEMORY = { settings: null, cycles: [], applicants: [], applications: [], receipts: {}, requests: [], audit: [], roles: [] };

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const newId = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
export const fail = (status, error, extra = {}) => Object.assign(new Error(error), { status, error, ...extra });

const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};
const asObject = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; } catch { return {}; } }
  return {};
};

// Every table a mounted module declares, so kernel helpers can touch other
// modules' rows (cycle delete, erase) only when those tables exist.
function declaredTables(modules) {
  const tables = new Set();
  for (const m of modules) {
    const schema = typeof m.schema === 'function' ? m.schema(modules) : (m.schema || []);
    for (const text of schema) {
      const match = /CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/i.exec(String(text));
      if (match) tables.add(match[1]);
    }
  }
  return tables;
}

export function createStore(modules = []) {
  return { modules, ready: null, mem: null, cache: new Map(), hits: new Map(), tables: declaredTables(modules), bridge: null };
}

function loadMemory(store) {
  if (store.mem) return store.mem;
  const base = structuredClone(BASE_MEMORY);
  for (const m of store.modules) for (const [k, v] of Object.entries(m.memory || {})) if (!(k in base)) base[k] = structuredClone(v);
  let saved = {};
  try { saved = JSON.parse(readFileSync(DEV_FILE, 'utf8')) || {}; } catch (e) { /* first run */ }
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) base[k] = v;
  for (const [k, v] of Object.entries(BASE_MEMORY)) if (base[k] == null && v != null) base[k] = structuredClone(v);
  store.mem = base;
  return base;
}

function saveMemory(store) {
  if (!store.mem) return;
  try {
    writeFileSync(DEV_TMP, JSON.stringify(store.mem));
    renameSync(DEV_TMP, DEV_FILE);
  } catch (e) { /* dev only */ }
}

// Statement builder for queries whose shape depends on filters: text
// fragments are constants, every value is a parameter, and the result is
// handed to the tagged-template runner exactly as a template literal would be.
export function build() {
  const strings = [''];
  const values = [];
  const frag = (parts, ...vals) => {
    for (let i = 0; i < parts.length; i++) {
      strings[strings.length - 1] += parts[i];
      if (i < vals.length) { values.push(vals[i]); strings.push(''); }
    }
    return frag;
  };
  // Literal SQL text chosen from a fixed table (never user input).
  frag.raw = (text) => { strings[strings.length - 1] += text; return frag; };
  // Splice another fragment (its text and its parameters) in place.
  frag.append = (other) => {
    strings[strings.length - 1] += other.strings[0];
    for (let i = 1; i < other.strings.length; i++) { values.push(other.values[i - 1]); strings.push(other.strings[i]); }
    return frag;
  };
  frag.run = (s) => s(Object.assign([...strings], { raw: [...strings] }), ...values);
  frag.text = () => strings.join('?');
  frag.strings = strings;
  frag.values = values;
  return frag;
}

export function createKit(ctx = {}, modules = [], store = createStore(modules)) {
  const mode = storageMode();
  const kit = { mode, ctx, modules, tables: store.tables, store, esc, build, asArray, asObject };

  kit.id = newId;
  kit.now = () => Date.now();
  kit.json = (status, body, headers, audit) => ({ status, body, ...(headers ? { headers } : {}), ...(audit ? { audit } : {}) });
  kit.session = () => { try { return ctx.session?.() || {}; } catch (e) { return {}; } };

  /* ------------------------------- storage ------------------------------- */

  Object.defineProperty(kit, 'mem', { get: () => (mode === 'memory' ? loadMemory(store) : null), enumerable: true });
  kit.memSave = () => { if (mode === 'memory') saveMemory(store); };

  kit.statements = () => {
    const out = [];
    for (const m of modules) {
      const schema = typeof m.schema === 'function' ? m.schema(modules) : (m.schema || []);
      for (const text of schema) out.push(String(text));
    }
    return out;
  };

  kit.sql = async () => {
    if (mode === 'memory') throw new Error('SQL is not available in memory mode');
    const s = await rawSql();
    if (!store.ready) {
      store.ready = (async () => {
        for (const text of kit.statements()) await s(Object.assign([text], { raw: [text] }));
      })().catch((error) => { store.ready = null; throw error; });
    }
    await store.ready;
    return s;
  };

  // Per-instance caches with a TTL (intake target, roster).
  kit.cached = async (key, ttl, load) => {
    const hit = store.cache.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    const value = await load();
    store.cache.set(key, { value, until: Date.now() + ttl });
    return value;
  };
  kit.uncache = (key) => { if (key) store.cache.delete(key); else store.cache.clear(); };

  /* -------------------------------- once --------------------------------- */

  // A client-generated rq- id runs its work once. A second call with the same
  // id returns the stored result with replayed:true; while the first is still
  // running (or if it crashed before storing) the caller is told to retry.
  const replay = (row) => {
    if (!row || row.result == null) throw fail(409, 'That request is still being processed. Try again in a moment.');
    const result = row.result;
    return result && typeof result === 'object' && !Array.isArray(result) ? { ...result, replayed: true } : result;
  };
  const forgetRequest = async (id) => {
    if (mode === 'memory') { const m = kit.mem; m.requests = m.requests.filter((r) => r.id !== id); kit.memSave(); return; }
    const s = await kit.sql();
    await s`DELETE FROM recruit_requests WHERE id = ${id} AND result IS NULL`;
  };
  kit.once = async (requestId, actor, run) => {
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw fail(400, 'A request ID is required');
    const now = Date.now();
    const who = String(actor || 'system');
    if (mode === 'memory') {
      const m = kit.mem;
      m.requests = m.requests.filter((r) => now - r.ts < WEEK);
      const prior = m.requests.find((r) => r.id === requestId);
      if (prior) { if (prior.actor !== who) throw fail(403, 'Not allowed'); return replay(prior); }
      m.requests.push({ id: requestId, ts: now, actor: who, result: null });
      kit.memSave();
    } else {
      const s = await kit.sql();
      const r = await s`WITH purged AS (DELETE FROM recruit_requests WHERE ts < ${now - WEEK})
        INSERT INTO recruit_requests (id, ts, actor) VALUES (${requestId}, ${now}, ${who})
        ON CONFLICT (id) DO NOTHING RETURNING id`;
      if (!r.rows.length) {
        const prior = await s`SELECT actor, result FROM recruit_requests WHERE id = ${requestId}`;
        if (prior.rows[0] && prior.rows[0].actor !== who) throw fail(403, 'Not allowed');
        return replay(prior.rows[0] ? { result: asObjectOrValue(prior.rows[0].result) } : null);
      }
    }
    let result;
    try { result = await run(); }
    catch (e) { try { await forgetRequest(requestId); } catch (x) { /* retry can still run */ } throw e; }
    const stored = result === undefined ? { ok: true } : result;
    if (mode === 'memory') {
      const row = kit.mem.requests.find((r) => r.id === requestId);
      if (row) row.result = stored;
      kit.memSave();
    } else {
      const s = await kit.sql();
      await s`UPDATE recruit_requests SET result = ${JSON.stringify(stored)}::jsonb WHERE id = ${requestId}`;
    }
    return result;
  };
  const asObjectOrValue = (v) => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v);

  /* -------------------------------- audit -------------------------------- */

  kit.audit = async (row) => {
    const rec = {
      id: newId('au'), ts: Date.now(), cycleId: String(row.cycleId || ''), applicationId: row.applicationId || null,
      actor: String(row.actor || 'system'), kind: String(row.kind || 'note'), detail: row.detail && typeof row.detail === 'object' ? row.detail : {},
    };
    if (mode === 'memory') { kit.mem.audit.push(rec); kit.memSave(); return rec; }
    const s = await kit.sql();
    await s`INSERT INTO recruit_audit (id, ts, cycle_id, application_id, actor, kind, detail)
      VALUES (${rec.id}, ${rec.ts}, ${rec.cycleId}, ${rec.applicationId}, ${rec.actor}, ${rec.kind}, ${JSON.stringify(rec.detail)}::jsonb)`;
    return rec;
  };

  /* --------------------------- events and collect ------------------------ */

  const enabledFor = (cycle, m) => m.kernel || !cycle || cycle?.doc?.modules?.[m.name] !== false;

  // Hooks run after the durable write, in module order; a failing hook is
  // recorded and never fails the request that triggered it.
  kit.emit = async (event, payload = {}) => {
    for (const m of modules) {
      const hook = m.hooks?.[event];
      if (typeof hook !== 'function' || !enabledFor(payload?.cycle, m)) continue;
      try { await hook(payload, kit); }
      catch (e) {
        try {
          await kit.audit({
            kind: 'hook.failed', cycleId: payload?.cycle?.id || payload?.cycleId || '', actor: 'system',
            applicationId: typeof payload?.application === 'string' ? payload.application : payload?.application?.id || null,
            detail: { module: m.name, event, message: String(e?.message || e).slice(0, 200) },
          });
        } catch (x) { /* audit is best effort here */ }
      }
    }
  };

  // Collectors answer in module order; disabled modules are skipped and
  // modules without the collector contribute nothing.
  kit.collect = async (event, payload = {}) => {
    const out = [];
    for (const m of modules) {
      const fn = m.collect?.[event];
      // csv.columns is called with the cycle itself as the payload.
      const cycle = payload?.cycle ?? (payload?.id && payload?.doc ? payload : null);
      if (typeof fn !== 'function' || !enabledFor(cycle, m)) continue;
      const result = await fn(payload, kit);
      if (result !== undefined) out.push(result);
    }
    return out;
  };

  /* -------------------------------- files -------------------------------- */

  kit.files = {
    async put(f, transaction = null) {
      if (mode === 'memory') { if (!await getFile(f.id)) await putFile({ ...f, data: Buffer.from(f.data) }); return f.id; }
      const s = transaction || await kit.sql();
      await s`INSERT INTO wiki_files (id, name, type, size, by, ts, data)
        VALUES (${f.id}, ${f.name}, ${f.type}, ${f.size}, ${f.by}, ${f.ts}, decode(${Buffer.from(f.data).toString('base64')}, 'base64'))
        ON CONFLICT (id) DO NOTHING`;
      return f.id;
    },
    get: (id) => getFile(id),
    // Delete only a file nothing references any more: no application, no
    // legacy submission and no legacy archive.
    async removeUnreferenced(id) {
      if (!/^int-[a-z0-9]+$/.test(String(id))) return false;
      if (mode === 'memory') {
        const m = kit.mem;
        if (m.applications.some((a) => (a.files || []).some((f) => f.id === id))) return false;
        let legacy = { rows: [], archives: [] };
        try { legacy = JSON.parse(readFileSync(new URL('../../.devinterest.json', import.meta.url), 'utf8')); } catch (e) { /* none */ }
        if ((legacy.rows || []).some((r) => r.fileId === id)) return false;
        if ((legacy.archives || []).some((a) => (a.rows || []).some((r) => r.fileId === id))) return false;
        await deleteFile(id);
        return true;
      }
      const s = await kit.sql();
      const r = await s`DELETE FROM wiki_files WHERE id = ${id}
        AND NOT EXISTS (SELECT 1 FROM recruit_applications WHERE files @> ${JSON.stringify([{ id }])}::jsonb)
        AND NOT EXISTS (SELECT 1 FROM interest_submissions WHERE file_id = ${id})
        AND NOT EXISTS (SELECT 1 FROM interest_archives a, jsonb_array_elements(a.rows) r WHERE r->>'fileId' = ${id})`;
      return r.rowCount === 1;
    },
    serve(res, f) {
      res.statusCode = 200;
      for (const [k, v] of Object.entries(attachmentHeaders(f))) res.setHeader(k, v);
      return res.end(Buffer.from(f.data));
    },
  };

  /* -------------------------------- roles -------------------------------- */

  const grantFromPg = (r) => ({ cycleId: r.cycle_id, member: r.member, roles: asArray(r.roles), subteams: asArray(r.subteams), grantedBy: r.granted_by || '', ts: Number(r.ts || 0) });
  const aggregate = (email, rows) => {
    if (!rows.length) return null;
    return { cycleId: null, member: email, roles: [...new Set(rows.flatMap((g) => g.roles))], subteams: [], grantedBy: '', ts: Math.max(...rows.map((g) => g.ts || 0)), cycles: rows.map((g) => ({ cycleId: g.cycleId, roles: g.roles, subteams: g.subteams })) };
  };
  kit.roles = {
    // One cycle's grant, or with cycleId null the member's grants across
    // every cycle folded into one (roles = union, cycles = the list).
    async grantFor(cycleId, email) {
      const who = String(email || '').toLowerCase();
      if (!who) return null;
      if (mode === 'memory') {
        const rows = kit.mem.roles.filter((g) => g.member === who && (!cycleId || g.cycleId === cycleId));
        if (cycleId) return rows[0] ? { ...rows[0] } : null;
        return aggregate(who, rows);
      }
      const s = await kit.sql();
      if (cycleId) {
        const r = await s`SELECT * FROM recruit_roles WHERE cycle_id = ${cycleId} AND member = ${who}`;
        return r.rows[0] ? grantFromPg(r.rows[0]) : null;
      }
      const r = await s`SELECT * FROM recruit_roles WHERE member = ${who}`;
      return aggregate(who, r.rows.map(grantFromPg));
    },
    roleOf,
    // Active roster members (email, name, role, subteam). Admin screens only.
    async roster() {
      if (mode === 'memory') {
        try {
          const d = JSON.parse(readFileSync(DEV_WIKI, 'utf8'));
          return (d.state?.users || []).filter((u) => u.status === 'active').map((u) => ({ email: u.email, name: u.name || '', role: u.role || 'member', subteam: u.subteam || '' }));
        } catch (e) { return []; }
      }
      const s = await rawSql();
      const r = await s`SELECT jsonb_agg(jsonb_build_object('email', u->>'email', 'name', u->>'name', 'role', u->>'role', 'subteam', u->>'subteam')) AS roster
        FROM wiki_state, jsonb_array_elements(state->'users') u WHERE id = 1 AND u->>'status' = 'active'`;
      return asArray(r.rows[0]?.roster);
    },
  };

  /* ------------------------------- output -------------------------------- */

  // One CSV writer: BOM, CRLF, every cell quoted. columns = [{ header, cell(row, extras) }].
  kit.csv = async (res, rows, columns, filename, extras = {}) => {
    const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    res.statusCode = 200;
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${String(filename).replace(/[^a-z0-9._-]+/gi, '-')}.csv"`);
    res.setHeader('cache-control', 'private, no-store');
    let chunk = '\uFEFF' + columns.map((c) => cell(c.header)).join(',');
    const chunks = [];
    const write = async () => {
      if (typeof res.write === 'function') {
        if (!res.write(chunk)) await eventOnce(res, 'drain');
      } else chunks.push(chunk); // test/adapter responses without a stream
      chunk = '';
    };
    for await (const row of rows) {
      chunk += '\r\n' + columns.map((c) => cell(c.cell(row, extras))).join(',');
      if (chunk.length >= 64000) await write();
    }
    if (chunk) await write();
    return res.end(typeof res.write === 'function' ? undefined : chunks.join(''));
  };

  /* ----------------------------- capabilities ---------------------------- */

  kit.email = {
    send: async (args) => (await import('../email-send.js')).sendEmail(args),
    settings: ctx.emailSettings, clientId: ctx.clientId, saveOauth: ctx.saveOauth, host: ctx.host,
  };

  // The Blob journal and the legacy replay, for the queue screens. The
  // replay prefers interest.js's own routine (which also drains entries that
  // belong to the legacy inbox) and otherwise drains only cycle-bound entries.
  kit.intake = {
    async journal() { return ctx.journal || (await import('../intake-journal.js')).intakeJournal; },
    async commit(entry, journal, files, target = {}) {
      if (!entry.section && store.bridge) return store.bridge.commit(entry, journal, files, target);
      const cycle = await kit.cycles.get(target.cycleId || entry.cycleId);
      if (!cycle || cycle.status === 'archived') throw fail(409, 'Choose an available cycle');
      const result = await kit.apps.commitIntake(cycle, entry, journal, files, {
        confirmUpdate: entry.confirmUpdate === true, override: target.override === true,
        source: target.source || 'site',
      });
      return { ...result, cycleId: cycle.id, id: result.row?.id || result.existing?.id || null };
    },
    async replay(requestCtx = ctx) {
      const journal = await kit.intake.journal();
      const bridge = store.bridge;
      try {
        const mod = await import('../interest.js');
        if (typeof mod.replayIntake === 'function') return await mod.replayIntake(journal, { ...requestCtx, intake: { commit: kit.intake.commit } });
      } catch (e) { /* fall back to the cycle-only replay */ }
      if (!bridge) return { pendingReview: [], queueUnavailable: false };
      let entries;
      try { entries = await journal.listPending(); } catch (e) { return { pendingReview: [], queueUnavailable: true }; }
      const pendingReview = [];
      for (const entry of entries) {
        if (!entry.cycleId) continue;
        try {
          const result = await kit.intake.commit(entry, journal, null, { cycleId: entry.cycleId });
          if (result.outcome === 'review' || result.outcome === 'held') pendingReview.push({ id: entry.id, reason: result.outcome === 'review' ? 'duplicate' : 'capacity' });
          else { try { await journal.complete(entry.id, result.outcome); } catch (e) { /* receipt prevents repeats */ } }
        } catch (e) { pendingReview.push({ id: entry.id, reason: 'replay_failed' }); }
      }
      return { pendingReview, queueUnavailable: false };
    },
  };
  // Erase and retention purge drop the applicant's Blob record as well.
  kit.journal = {
    async forget(id) {
      const journal = await kit.intake.journal();
      return typeof journal.forget === 'function' ? journal.forget(id) : false;
    },
  };

  // Kernel modules attach their facades (kit.cycles, kit.apps).
  for (const m of modules) {
    if (typeof m.provide === 'function') Object.assign(kit, m.provide(kit) || {});
  }
  return kit;
}
