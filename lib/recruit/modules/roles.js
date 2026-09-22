// Roles module (kernel): per-cycle grants, the append-only audit trail and
// the once-only request guard. Owns recruit_roles, recruit_audit and
// recruit_requests; the kit implements once/audit/grantFor on top of them.
// Routes: /me, cycle roles CRUD, the audit list and its CSV.

import { createHash } from 'node:crypto';
const hash = (email) => createHash('sha256').update(String(email || '').toLowerCase()).digest('hex').slice(0, 24);

const ROLE_KEYS = ['lead', 'reviewer', 'interviewer'];
const AUDIT_PAGE = 200;
const fail = (status, error, extra = {}) => Object.assign(new Error(error), { status, error, ...extra });
const isObject = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const asArray = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? (() => { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } })() : []);
const asObject = (v) => (isObject(v) ? v : typeof v === 'string' ? (() => { try { const p = JSON.parse(v); return isObject(p) ? p : {}; } catch { return {}; } })() : {});
const REQUEST_ID = /^rq-[a-z0-9-]{8,80}$/;

const grantFromPg = (r) => ({ cycleId: r.cycle_id, member: r.member, roles: asArray(r.roles), subteams: asArray(r.subteams), grantedBy: r.granted_by || '', ts: Number(r.ts || 0) });
const auditFromPg = (r) => ({ id: r.id, ts: Number(r.ts), cycleId: r.cycle_id, applicationId: r.application_id || null, actor: r.actor, kind: r.kind, detail: asObject(r.detail) });

async function listGrants(kit, cycleId) {
  if (kit.mode === 'memory') return kit.mem.roles.filter((g) => g.cycleId === cycleId).map((g) => ({ ...g }));
  const s = await kit.sql();
  const r = await s`SELECT * FROM recruit_roles WHERE cycle_id = ${cycleId} ORDER BY ts`;
  return r.rows.map(grantFromPg);
}

async function putGrant(kit, grant) {
  if (kit.mode === 'memory') {
    const m = kit.mem;
    const i = m.roles.findIndex((g) => g.cycleId === grant.cycleId && g.member === grant.member);
    if (i >= 0) m.roles[i] = grant; else m.roles.push(grant);
    kit.memSave();
    return grant;
  }
  const s = await kit.sql();
  const r = await s`INSERT INTO recruit_roles (cycle_id, member, roles, subteams, granted_by, ts)
    VALUES (${grant.cycleId}, ${grant.member}, ${JSON.stringify(grant.roles)}::jsonb, ${JSON.stringify(grant.subteams)}::jsonb, ${grant.grantedBy}, ${grant.ts})
    ON CONFLICT (cycle_id, member) DO UPDATE SET roles = EXCLUDED.roles, subteams = EXCLUDED.subteams, granted_by = EXCLUDED.granted_by, ts = EXCLUDED.ts
    RETURNING *`;
  return grantFromPg(r.rows[0]);
}

async function removeGrant(kit, cycleId, member) {
  if (kit.mode === 'memory') {
    const m = kit.mem;
    const before = m.roles.length;
    m.roles = m.roles.filter((g) => !(g.cycleId === cycleId && g.member === member));
    if (m.roles.length !== before) kit.memSave();
    return m.roles.length !== before;
  }
  const s = await kit.sql();
  const r = await s`DELETE FROM recruit_roles WHERE cycle_id = ${cycleId} AND member = ${member}`;
  return r.rowCount === 1;
}

async function listAudit(kit, { cycleId, applicationId, kind, cursor, limit = AUDIT_PAGE }) {
  const page = Math.max(1, Math.min(AUDIT_PAGE, Number(limit) || AUDIT_PAGE));
  let before = null, beforeId = null;
  if (cursor) {
    const at = String(cursor).lastIndexOf('|');
    before = Number(String(cursor).slice(0, at));
    beforeId = String(cursor).slice(at + 1);
    if (!Number.isFinite(before)) throw fail(400, 'Bad cursor');
  }
  let rows;
  if (kit.mode === 'memory') {
    rows = kit.mem.audit
      .filter((a) => a.cycleId === cycleId && (!applicationId || a.applicationId === applicationId) && (!kind || a.kind === kind))
      .filter((a) => before === null || a.ts < before || (a.ts === before && a.id < beforeId))
      .sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1))
      .slice(0, page + 1)
      .map((a) => ({ ...a }));
  } else {
    const s = await kit.sql();
    const q = kit.build();
    q`SELECT * FROM recruit_audit WHERE cycle_id = ${cycleId}`;
    if (applicationId) q` AND application_id = ${applicationId}`;
    if (kind) q` AND kind = ${kind}`;
    if (before !== null) q` AND (ts, id) < (${before}::bigint, ${beforeId}::text)`;
    q` ORDER BY ts DESC, id DESC LIMIT ${page + 1}`;
    rows = (await q.run(s)).rows.map(auditFromPg);
  }
  const next = rows.length > page ? `${rows[page - 1].ts}|${rows[page - 1].id}` : null;
  return { rows: rows.slice(0, page), next };
}

/* -------------------------------- routes -------------------------------- */

async function me(rq, kit) {
  const admin = rq.role === 'admin';
  let cycles;
  if (admin) {
    cycles = (await kit.cycles.list({ all: false })).map((c) => ({ id: c.id, name: c.name, term: c.term, status: c.status, roles: ['admin'] }));
  } else {
    const grants = rq.grant?.cycles || [];
    const all = grants.length ? await kit.cycles.list({ all: true, ids: grants.map((g) => g.cycleId) }) : [];
    cycles = all.filter((c) => c.status !== 'archived').map((c) => ({ id: c.id, name: c.name, term: c.term, status: c.status, roles: grants.find((g) => g.cycleId === c.id)?.roles || [] }));
  }
  return { status: 200, body: { admin, cycles } };
}

async function cycleRoles(rq, kit) {
  const roles = await listGrants(kit, rq.cycle.id);
  const roster = await kit.roles.roster();
  const names = new Map(roster.map((u) => [u.email, u.name]));
  return {
    status: 200,
    body: {
      roles: roles.map((g) => ({ member: g.member, name: names.get(g.member) || '', roles: g.roles, subteams: g.subteams, ts: g.ts })),
      members: roster.map((u) => ({ email: u.email, name: u.name, subteam: u.subteam })),
    },
  };
}

async function putRole(rq, kit) {
  const body = await rq.body();
  const requestId = String(body?.requestId || '');
  if (!REQUEST_ID.test(requestId)) throw fail(400, 'A request ID is required');
  const roles = [...new Set(asArray(body.roles).map(String))];
  if (!roles.length || roles.some((r) => !ROLE_KEYS.includes(r))) throw fail(400, 'Choose lead, reviewer or interviewer');
  if (rq.role !== 'admin' && roles.includes('lead')) throw fail(403, 'Only admins grant the lead role');
  const known = new Set((rq.cycle.doc?.subteams || []).flatMap((s) => [s.key, s.name]).filter(Boolean));
  const subteams = [...new Set(asArray(body.subteams).map((v) => String(v).trim()).filter(Boolean))];
  if (subteams.length > 20 || subteams.some((k) => !known.has(k))) throw fail(400, 'Unknown subteam');
  const member = rq.params.member;
  const roster = await kit.roles.roster();
  if (!roster.some((u) => u.email === member)) throw fail(400, 'That person is not on the roster');
  const result = await kit.once(requestId, rq.me.email, async () => {
    const grant = await putGrant(kit, { cycleId: rq.cycle.id, member, roles, subteams, grantedBy: rq.me.email, ts: kit.now() });
    return { role: { member: grant.member, roles: grant.roles, subteams: grant.subteams, ts: grant.ts } };
  });
  return { status: 200, body: result, audit: { kind: 'role', detail: { memberHash: hash(member), roles, subteams: subteams.length, requestId } } };
}

async function deleteRole(rq, kit) {
  const removed = await removeGrant(kit, rq.cycle.id, rq.params.member);
  return { status: 200, body: { ok: true, removed }, audit: removed ? { kind: 'role', detail: { memberHash: hash(rq.params.member), roles: [] } } : undefined };
}

async function audit(rq, kit) {
  const out = await listAudit(kit, { cycleId: rq.cycle.id, applicationId: rq.query.application || null, kind: rq.query.kind || null, cursor: rq.query.cursor || null });
  return { status: 200, body: out };
}

async function auditCsv(rq, kit) {
  const rows = [];
  let cursor = null;
  for (let i = 0; i < 50; i++) {
    const page = await listAudit(kit, { cycleId: rq.cycle.id, cursor });
    rows.push(...page.rows);
    cursor = page.next;
    if (!cursor) break;
  }
  const columns = [
    { header: 'When', cell: (r) => new Date(r.ts).toISOString() },
    { header: 'Actor', cell: (r) => r.actor },
    { header: 'Kind', cell: (r) => r.kind },
    { header: 'Application', cell: (r) => r.applicationId || '' },
    { header: 'Detail', cell: (r) => JSON.stringify(r.detail) },
  ];
  await kit.csv(rq.res, rows, columns, `cupi-audit-${rq.cycle.id}-${new Date().toISOString().slice(0, 10)}`);
  return undefined;
}


export default {
  name: 'roles',
  kernel: true,
  order: 20,
  schema: [
    `CREATE TABLE IF NOT EXISTS recruit_roles (cycle_id text NOT NULL, member text NOT NULL, roles jsonb NOT NULL DEFAULT '[]'::jsonb, subteams jsonb NOT NULL DEFAULT '[]'::jsonb, granted_by text, ts bigint, PRIMARY KEY (cycle_id, member))`,
    `CREATE INDEX IF NOT EXISTS recruit_roles_member ON recruit_roles (member)`,
    `CREATE TABLE IF NOT EXISTS recruit_audit (id text PRIMARY KEY, ts bigint NOT NULL, cycle_id text NOT NULL DEFAULT '', application_id text, actor text NOT NULL, kind text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb)`,
    `CREATE INDEX IF NOT EXISTS recruit_audit_cycle ON recruit_audit (cycle_id, ts DESC)`,
    `CREATE INDEX IF NOT EXISTS recruit_audit_application ON recruit_audit (application_id, ts DESC)`,
    `CREATE TABLE IF NOT EXISTS recruit_requests (id text PRIMARY KEY, ts bigint NOT NULL, actor text NOT NULL, result jsonb)`,
  ],
  memory: { roles: [], audit: [], requests: [] },
  defaults: () => ({}),
  validateSettings: () => ({}),
  routes: [
    { method: 'GET', path: '/me', access: 'member', handler: me },
    { method: 'GET', path: '/cycles/:cycle/roles', access: 'lead', handler: cycleRoles },
    { method: 'PUT', path: '/cycles/:cycle/roles/:member', access: 'lead', mutates: true, handler: putRole },
    { method: 'DELETE', path: '/cycles/:cycle/roles/:member', access: 'admin', mutates: true, handler: deleteRole },
    { method: 'GET', path: '/cycles/:cycle/audit', access: 'lead', handler: audit },
    { method: 'GET', path: '/cycles/:cycle/audit.csv', access: 'admin', handler: auditCsv },
  ],
  hooks: {},
  collect: {},
  auditKinds: ['role', 'hook.failed'],
};
