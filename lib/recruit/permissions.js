// Who may do what. Pure helpers shared by the registry and the modules:
// the role ladder, the access matrix, the public-origin allowlist (same rules
// as interest.js cors()) and the salted IP hash used by the public pre-gate.

import { createHash } from 'node:crypto';

export const MAIN_SITE = 'https://cornellphysicalintelligence.com';
export const WIKI_URL = (process.env.WIKI_URL || 'https://wiki.cornellphysicalintelligence.com').replace(/\/$/, '');
const IP_SALT = process.env.SESSION_SECRET || 'cupi-dev-salt';

export const ROLES = ['admin', 'lead', 'reviewer', 'interviewer'];
export const CYCLE_ROLES = ['lead', 'reviewer', 'interviewer'];
export const ACCESS_LEVELS = ['public', 'member', 'role', 'interviewer', 'reviewer', 'lead', 'admin'];

// Exact-origin CORS: the main site in production, localhost only under dev auth.
export function cors(req, res) {
  const origin = req.headers.origin || '';
  const devOk = process.env.DEV_FAKE_AUTH && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
  if (origin === MAIN_SITE || origin === WIKI_URL || devOk) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    return true;
  }
  return false;
}
export const PUBLIC_CORS = { MAIN_SITE, WIKI_URL, cors };

// IPs never touch storage raw: the same salted hash as interest.js.
export function ipHashOf(req) {
  const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
    .split(',')[0].trim();
  return createHash('sha256').update(`interest|${IP_SALT}|${ip}`).digest('hex').slice(0, 24);
}

export const emailHash = (email) => createHash('sha256').update(String(email || '').toLowerCase()).digest('hex').slice(0, 24);

// The single role a member acts as: admin from the roster, else the highest
// cycle role in the grant, else null (a member without a role).
export function roleOf(me, grant) {
  if (me?.role === 'admin') return 'admin';
  const roles = Array.isArray(grant?.roles) ? grant.roles : [];
  if (roles.includes('lead')) return 'lead';
  if (roles.includes('reviewer')) return 'reviewer';
  if (roles.includes('interviewer')) return 'interviewer';
  return null;
}

// access → who passes. `grant` is optional: a reviewer who is also an
// interviewer acts as 'reviewer' but still passes interviewer routes.
export function allowed(access, role, grant = null) {
  const roles = Array.isArray(grant?.roles) ? grant.roles : [];
  switch (access) {
    case 'public': return true;
    case 'member': return role !== undefined;
    case 'role': return role !== null && role !== undefined;
    case 'interviewer': return role === 'admin' || role === 'lead' || role === 'interviewer' || roles.includes('interviewer');
    case 'reviewer': return role === 'admin' || role === 'lead' || role === 'reviewer' || roles.includes('reviewer');
    case 'lead': return role === 'admin' || role === 'lead';
    case 'admin': return role === 'admin';
    default: return false;
  }
}

export function requireRole(access, role, grant = null) {
  if (!allowed(access, role, grant)) throw Object.assign(new Error(role ? 'Not allowed in this cycle' : 'Admins only'), { status: 403, error: role ? 'Not allowed in this cycle' : 'Admins only' });
}

// The signed-in active member, or null. Public routes never call this.
export async function resolveActor(ctx) {
  if (typeof ctx?.me !== 'function') return null;
  const me = await ctx.me();
  if (!me || (me.status && me.status !== 'active')) return null;
  return me;
}

// Application ids a reviewer/interviewer may touch: the union of what the
// enabled modules grant, narrowed to the grant's subteams when it has any.
// Admins and leads get null (everything).
export async function scopeFor(kit, { cycle, me, role, grant }) {
  if (role === 'admin' || role === 'lead') return null;
  const scope = new Set();
  const parts = (await kit.collect('scope.applications', { cycle, me, role, grant })).filter(Boolean);
  for (const part of parts) for (const id of part) scope.add(id);
  const subteams = Array.isArray(grant?.subteams) ? grant.subteams.filter(Boolean) : [];
  // With no module narrowing the list, a reviewer reads the whole cycle,
  // or their subteams' rows when the grant names some.
  if (!parts.length) return subteams.length && kit.apps?.ids ? await kit.apps.ids(cycle.id, { subteams, cycle }) : null;
  if (subteams.length && scope.size && kit.apps?.ids) {
    const inSubteams = await kit.apps.ids(cycle.id, { subteams, cycle });
    for (const id of [...scope]) if (!inSubteams.has(id)) scope.delete(id);
  }
  return scope;
}
