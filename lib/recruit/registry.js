// The registry: mounts the recruit modules and dispatches /api/recruit/*.
// createRecruit(modules) validates every module's shape at load, compiles
// the routes to pinned regexes, and returns handleRecruit (the request
// dispatcher), intakeBridge (what lib/interest.js calls at its five seam
// points) and kitFor(ctx) (a kit bound to a request's capability context).

import { createKit, createStore, fail } from './kit.js';
import { allowed, roleOf, cors, ipHashOf, scopeFor, ACCESS_LEVELS } from './permissions.js';
import { createIntakeBridge } from './bridge.js';

const PARAMS = {
  cycle: 'cy-[a-z0-9-]+', app: 'in-[a-z0-9]+', file: 'int-[a-z0-9]+', form: 'fm-[a-z0-9]+', slot: 'sl-[a-z0-9]+',
  booking: 'bk-[a-z0-9]+', mail: 'ml-[a-z0-9]+', comment: 'ic-[a-z0-9-]{8,80}', email: '[^/]{3,200}', token: '[a-f0-9]{32}',
  kind: 'review|interview', round: '[a-z0-9_-]{0,40}', receipt: 'jr-\\d{13}-[a-f0-9]{24}', member: '[^/]{3,200}',
  module: '[a-z]+', version: '\\d+', key: '[a-z][a-z0-9_-]{0,59}',
};
const LOWERCASED = new Set(['email', 'member']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const PUBLIC_HITS_PER_MINUTE = 30;

const json = (res, status, body, headers = {}) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && v !== null) res.setHeader(k, v);
  res.end(JSON.stringify(body));
};

const labelOf = (m) => m.label || (m.name.charAt(0).toUpperCase() + m.name.slice(1));

export function compileRoute(route, module) {
  const names = [];
  const parts = String(route.path || '').split('/').map((seg) => {
    const p = /^:([a-zA-Z]+)$/.exec(seg);
    if (!p) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const name = p[1];
    if (!PARAMS[name]) throw new Error(`Recruit module "${module.name}": unknown route param :${name} in ${route.path}`);
    names.push(name);
    return `(${PARAMS[name]})`;
  });
  if (parts[0] !== '') throw new Error(`Recruit module "${module.name}": route path must start with / (${route.path})`);
  return { regex: new RegExp('^' + parts.join('/') + '$'), names };
}

function validateModule(m, seen) {
  if (!m || typeof m !== 'object') throw new Error('A recruit module must be an object');
  if (!/^[a-z]+$/.test(String(m.name || ''))) throw new Error(`Recruit module "${m.name}" needs a lowercase name`);
  if (seen.has(m.name)) throw new Error(`Recruit module "${m.name}" is mounted twice`);
  seen.add(m.name);
  if (typeof m.order !== 'number' || Number.isNaN(m.order)) throw new Error(`Recruit module "${m.name}" needs an order`);
  const schema = typeof m.schema === 'function' ? m.schema([]) : m.schema;
  if (!Array.isArray(schema) || schema.some((s) => typeof s !== 'string')) throw new Error(`Recruit module "${m.name}": schema must be an array of SQL strings`);
  if (!Array.isArray(m.routes)) throw new Error(`Recruit module "${m.name}": routes must be an array`);
  for (const r of m.routes) {
    if (!METHODS.has(r.method)) throw new Error(`Recruit module "${m.name}": route ${r.path} has an unknown method`);
    if (!ACCESS_LEVELS.includes(r.access)) throw new Error(`Recruit module "${m.name}": route ${r.path} needs an access level`);
    if (typeof r.handler !== 'function') throw new Error(`Recruit module "${m.name}": route ${r.path} needs a handler`);
  }
}

export function createRecruit(modulesIn, options = {}) {
  const seen = new Set();
  const modules = [...(modulesIn || [])];
  for (const m of modules) validateModule(m, seen);
  modules.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  const routes = [];
  const keys = new Set();
  for (const m of modules) {
    for (const r of m.routes) {
      const compiled = compileRoute(r, m);
      const key = `${r.method} ${r.path}`;
      if (keys.has(key)) throw new Error(`Recruit route ${key} is declared twice`);
      keys.add(key);
      routes.push({ ...r, ...compiled, module: m, cap: r.cap ?? 65536 });
    }
  }

  const store = createStore(modules);
  const kitFor = (ctx = {}) => createKit(ctx, modules, store);
  const intakeBridge = createIntakeBridge(kitFor(options.bridgeCtx || {}));
  store.bridge = intakeBridge;

  function match(method, sub) {
    for (const route of routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(sub);
      if (!m) continue;
      const params = {};
      let ok = true;
      route.names.forEach((name, i) => {
        let v = m[i + 1];
        if (LOWERCASED.has(name)) {
          try { v = decodeURIComponent(v); } catch (e) { ok = false; return; }
          v = v.trim().toLowerCase();
          if (!EMAIL_RE.test(v)) ok = false;
        }
        params[name] = v;
      });
      if (!ok) continue;
      return { route, params };
    }
    return null;
  }

  function isPublicPath(sub) {
    return routes.some((r) => r.access === 'public' && r.regex.test(sub));
  }

  async function handleRecruit(req, res, path, ctx = {}) {
    const sub = String(path || '').replace(/^\/recruit/, '') || '/';
    const method = String(req.method || 'GET').toUpperCase();

    if (method === 'OPTIONS' && isPublicPath(sub)) {
      const ok = cors(req, res);
      if (ok) {
        res.setHeader('access-control-allow-methods', 'GET, POST');
        res.setHeader('access-control-allow-headers', 'content-type');
        res.setHeader('access-control-max-age', '86400');
      }
      res.statusCode = ok ? 204 : 403;
      return res.end();
    }

    const found = match(method, sub);
    if (!found) return json(res, 404, { error: 'No such endpoint' });
    const { route, params } = found;
    const kit = kitFor(ctx);
    let query = {};
    try { query = Object.fromEntries(new URL(req.url || sub, 'http://recruit.local').searchParams); } catch (e) { query = {}; }
    let bodyPromise = null;
    const rq = {
      method, path: sub, params, query, req, res, me: null, role: null, grant: null, cycle: null, scope: null,
      body: () => { if (!bodyPromise) bodyPromise = Promise.resolve(ctx.readJson ? ctx.readJson(req, route.cap) : (req.body ?? {})); return bodyPromise; },
    };

    try {
      if (route.access === 'public') {
        if (!cors(req, res)) return json(res, 403, { error: 'Origin not allowed' });
        const ipHash = ipHashOf(req);
        const now = Date.now();
        const hits = (store.hits.get(ipHash) || []).filter((t) => now - t < 60000);
        hits.push(now);
        store.hits.set(ipHash, hits);
        if (store.hits.size > 5000) store.hits.clear();
        if (hits.length > PUBLIC_HITS_PER_MINUTE) return json(res, 429, { error: 'Too many requests. Give it a minute' });
        rq.ipHash = ipHash;
        const out = await route.handler(rq, kit);
        if (out === undefined) return;
        return json(res, out.status, out.body, out.headers || {});
      }

      const me = typeof ctx.me === 'function' ? await ctx.me() : null;
      if (!me || (me.status && me.status !== 'active')) return json(res, 401, { error: 'Not signed in' });
      rq.me = me;

      if (params.cycle) {
        const cycle = kit.cycles ? await kit.cycles.get(params.cycle) : null;
        if (!cycle) return json(res, 404, { error: 'No such cycle' });
        rq.cycle = cycle;
        if (!route.module.kernel && cycle.doc?.modules?.[route.module.name] === false) {
          return json(res, 409, { error: `${labelOf(route.module)} is off for this cycle` });
        }
        if (route.mutates && cycle.status === 'archived') return json(res, 409, { error: 'This cycle is archived' });
      }

      const grant = me.role === 'admin' ? null : await kit.roles.grantFor(rq.cycle?.id || null, me.email);
      const role = roleOf(me, grant);
      rq.grant = grant;
      rq.role = role;
      if (!allowed(route.access, role, grant)) return json(res, 403, { error: role ? 'Not allowed in this cycle' : 'Admins only' });

      if (route.scoped && rq.cycle && (role === 'reviewer' || role === 'interviewer')) {
        rq.scope = await scopeFor(kit, { cycle: rq.cycle, me, role, grant });
      }

      const out = await route.handler(rq, kit);
      if (out === undefined) return;
      if (out.audit && out.status >= 200 && out.status < 300) {
        try {
          const a = out.audit;
          await kit.audit({
            kind: a.kind, actor: a.actor || me.email, detail: a.detail || {},
            cycleId: a.cycleId ?? rq.cycle?.id ?? '',
            applicationId: typeof a.target === 'string' ? a.target : (a.applicationId ?? (typeof a.target === 'object' ? a.target?.applicationId : null) ?? params.app ?? null),
          });
        } catch (e) { /* the durable write already happened */ }
      }
      const headers = { 'cache-control': 'private, no-store', ...(out.headers || {}), ...kit.session() };
      return json(res, out.status, out.body, headers);
    } catch (e) {
      if (e && e.status && e.error !== undefined) {
        const extra = {};
        for (const k of Object.keys(e)) if (!['status', 'error', 'message', 'stack'].includes(k)) extra[k] = e[k];
        return json(res, e.status, { error: e.error, ...extra });
      }
      throw e;
    }
  }

  return { MODULES: modules, routes, handleRecruit, intakeBridge, kitFor, store };
}

export { PARAMS, fail };
