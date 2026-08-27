// The entire backend: auth, state, mutations, attachments. One function.
// Rewrites in vercel.json send every /api/* request here.

import { getState, updateState, putFile, getFile, deleteFile, listFiles, putPart, takeParts, StorageNotConfigured } from '../lib/db.js';
import { applyOp, healWelcomeCrab } from '../lib/ops.js';
import { makeSession, readSession, sessionCookie, clearSessionCookie, oauthStart, oauthCallback } from '../lib/auth.js';
import { sendWelcome, sendInterestNotice, freshOauthToken } from '../lib/email.js';
import { fileBugPR } from '../lib/github.js';

// Best-effort per-instance spacing so one member cannot firehose PRs.
const bugLast = new Map();
let crabHealed = false; // once per instance; the transform itself no-ops after the first real write
import { createHash, randomBytes } from 'node:crypto';

// The deployment's canonical origin is its OAuth client identity.
const WIKI_URL = (process.env.WIKI_URL || 'https://wiki.cornellphysicalintelligence.com').replace(/\/$/, '');
const WIKI_HOST = new URL(WIKI_URL).host;
const OAUTH_CLIENT_ID = `${WIKI_URL}/oauth/client.json`;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

/* ----------------------- public interest form config ---------------------- */

// The one unauthenticated write in the whole API, so every screen is explicit.
const MAIN_SITE = 'https://cornellphysicalintelligence.com';
const INTEREST_NOTIFY = (process.env.INTEREST_NOTIFY || 'ab3233@cornell.edu')
  .split(',').map((s) => s.trim()).filter(Boolean);
const INTEREST_SUBTEAMS = new Set(['Mechanical', 'Electrical', 'Software', 'Business & Marketing']);
const INTEREST_FILE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);
const INTEREST_MAX_FILE = 2.5 * 1024 * 1024;
const interestHits = new Map(); // per-instance pre-gate: ipHash -> recent timestamps

// IPs are never stored raw — only a salted hash used for rate limiting.
const IP_SALT = process.env.SESSION_SECRET || 'cupi-dev-salt';
const ipHashOf = (req) => {
  const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
    .split(',')[0].trim();
  return createHash('sha256').update(`interest|${IP_SALT}|${ip}`).digest('hex').slice(0, 24);
};

// Exact-origin CORS: the main site in production, localhost only under dev auth.
const interestCors = (req, res) => {
  const origin = req.headers.origin || '';
  const devOk = process.env.DEV_FAKE_AUTH && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
  if (origin === MAIN_SITE || origin === WIKI_URL || devOk) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    return true;
  }
  return false;
};

export const config = { api: { bodyParser: false } };

const MAX_UPLOAD = 4 * 1024 * 1024; // Vercel function body ceiling is ~4.5MB

// Vercel may have pre-parsed the body despite the config flag; prefer it.
async function readJson(req, cap = MAX_UPLOAD) {
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  }
  const buf = await readBody(req, cap);
  return JSON.parse(buf.toString() || '{}');
}

function readBody(req, cap = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const json = (res, code, obj, headers = {}) => {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
};

const redirect = (res, to, cookies = []) => {
  res.statusCode = 302;
  res.setHeader('location', to);
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.end();
};

// What each member is allowed to see: other people's prefs are nobody's
// business, and the Resend key never leaves the server in any form.
function shapeState(state, me) {
  const email = state.settings?.email;
  return {
    ...state,
    // Interest submissions are prospective-student PII: admins only. The
    // rate-limit ledger never leaves the server at all.
    interest: me?.role === 'admin' ? state.interest || [] : [],
    interestMeta: undefined,
    prefs: me ? { [me.email]: state.prefs?.[me.email] || {} } : {},
    settings: {
      email: {
        from: email?.from || '',
        name: email?.name || '',
        keySet: Boolean(email?.key),
        oauthConnected: Boolean(email?.oauth?.refresh),
        keyTail: email?.key ? email.key.slice(-4) : '',
        envKeySet: Boolean(process.env.RESEND_API_KEY),
        envFrom: process.env.RESEND_FROM || '',
      },
    },
  };
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const q = Object.fromEntries(url.searchParams);

  try {
    /* ------------------------------ auth ---------------------------------- */

    if (path === '/auth/login') {
      const { url: to, stateCookie } = oauthStart(req);
      return redirect(res, to, [stateCookie]);
    }

    if (path === '/auth/callback') {
      const id = await oauthCallback(req, q);
      if (id.error) return redirect(res, '/?denied=' + encodeURIComponent(id.email || '') + '&reason=' + encodeURIComponent(id.error));
      const { state } = await getState();
      const u = state.users.find((x) => x.email === id.email);
      if (!u) return redirect(res, '/?denied=' + encodeURIComponent(id.email));
      if (u.status === 'invited') {
        // Being on the roster is the whole gate: OAuth proves the address,
        // so the first sign-in activates the account.
        await updateState((s) => {
          const v = s.users.find((x) => x.email === id.email);
          if (v && v.status === 'invited') {
            v.status = 'active'; v.joined = Date.now(); v.name = id.name || v.name; delete v.inviteCode;
            s.activity.unshift({ ts: Date.now(), by: id.email, kind: 'join' });
          }
          return s;
        });
      }
      return redirect(res, '/', [sessionCookie(makeSession(id.email))]);
    }

    if (path === '/auth/logout') return redirect(res, '/', [clearSessionCookie()]);

    /* ------------------------- public interest form ------------------------ */

    if (path === '/interest' && req.method === 'OPTIONS') {
      const ok = interestCors(req, res);
      if (ok) {
        res.setHeader('access-control-allow-methods', 'POST');
        res.setHeader('access-control-allow-headers', 'content-type');
        res.setHeader('access-control-max-age', '86400');
      }
      res.statusCode = ok ? 204 : 403;
      return res.end();
    }

    if (path === '/interest' && req.method === 'POST') {
      if (!interestCors(req, res)) return json(res, 403, { error: 'Origin not allowed' });
      if (!/application\/json/.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'JSON only' });

      // Instance-local pre-gate: hot loops die before the database hears of them.
      const ipHash = ipHashOf(req);
      const now = Date.now();
      const hits = (interestHits.get(ipHash) || []).filter((t) => now - t < 60000);
      hits.push(now);
      interestHits.set(ipHash, hits);
      if (interestHits.size > 5000) interestHits.clear(); // memory backstop
      if (hits.length > 3) return json(res, 429, { error: 'Too many submissions. Give it a minute' });

      const body = await readJson(req, 3600000);
      // Honeypot: humans never see this field; bots fill everything. Pretend
      // success so the bot moves on, store nothing.
      if (String(body.website || '').trim()) return json(res, 200, { ok: true });

      const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
      const subteam = INTEREST_SUBTEAMS.has(body.subteam) ? body.subteam : '';
      const project = String(body.project || '').trim().slice(0, 1000);
      if (!name) return json(res, 400, { error: 'Tell us your name' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json(res, 400, { error: 'That email does not look right' });

      let file = null;
      if (body.file && typeof body.file === 'object' && body.file.data) {
        const data = String(body.file.data);
        if (!/^[A-Za-z0-9+/=]+$/.test(data)) return json(res, 400, { error: 'The file did not decode' });
        const buf = Buffer.from(data, 'base64');
        if (buf.length) {
          if (buf.length > INTEREST_MAX_FILE) return json(res, 413, { error: 'Files are capped at 2.5 MB' });
          const type = String(body.file.type || '');
          if (!INTEREST_FILE_TYPES.has(type)) return json(res, 400, { error: 'Images or PDF only' });
          file = { name: String(body.file.name || 'project').slice(0, 200), type, data: buf };
        }
      }

      // Durable screens: per-network hourly cap, then a global daily fuse so
      // a distributed flood cannot fill the database or the inbox.
      const pre = await getState();
      const log24 = (pre.state.interestMeta?.ipLog || []).filter((e) => now - e.ts < 86400000);
      if (log24.filter((e) => e.h === ipHash && now - e.ts < 3600000).length >= 5) {
        return json(res, 429, { error: 'Too many submissions from this network today' });
      }
      if (log24.length >= 300) return json(res, 429, { error: 'The interest list is briefly closed. Email cuphysint@cornell.edu instead' });
      const already = (pre.state.interest || []).some((r) => r.email === email);
      if (!already && (pre.state.interest || []).length >= 1000) {
        return json(res, 429, { error: 'The interest list is full. Email cuphysint@cornell.edu instead' });
      }

      let fileMeta = null;
      if (file) {
        const id = 'int-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        await putFile({ id, name: file.name, type: file.type, size: file.data.length, by: email, ts: now, data: file.data });
        fileMeta = { fileId: id, fileName: file.name, fileType: file.type, fileSize: file.data.length };
      }

      let isUpdate = false;
      let replacedFile = null;
      let saved = null;
      const out = await updateState((s) => {
        isUpdate = false;
        replacedFile = null;
        if (!s.interest) s.interest = [];
        if (!s.interestMeta) s.interestMeta = {};
        s.interestMeta.ipLog = (s.interestMeta.ipLog || []).filter((e) => now - e.ts < 86400000).slice(-1999);
        s.interestMeta.ipLog.push({ ts: now, h: ipHash });
        const cur = s.interest.find((r) => r.email === email);
        if (cur) {
          isUpdate = true;
          cur.name = name; cur.subteam = subteam; cur.project = project; cur.updated = now;
          if (fileMeta) { replacedFile = cur.fileId || null; Object.assign(cur, fileMeta); }
          saved = cur;
        } else {
          saved = {
            id: 'in-' + Math.random().toString(36).slice(2, 10) + now.toString(36),
            ts: now, updated: now, name, email, subteam, project,
            cornell: email.endsWith('@cornell.edu') || email.endsWith('.cornell.edu'),
            ...(fileMeta || {}),
          };
          s.interest.unshift(saved);
        }
        return s;
      });
      if (replacedFile) { try { await deleteFile(replacedFile); } catch (e) { /* best effort */ } }

      // Notify on new submissions only; a resubmit just refreshes the live table.
      if (!isUpdate) {
        for (const to of INTEREST_NOTIFY) {
          try {
            await sendInterestNotice({
              to, sub: saved, host: req.headers.host,
              settings: out.state.settings?.email, clientId: OAUTH_CLIENT_ID,
              saveOauth: (next) => updateState((s) => { if (s.settings?.email?.oauth) s.settings.email.oauth = next; return s; }),
            });
          } catch (e) { /* the stored row is the source of truth */ }
        }
      }
      return json(res, 200, { ok: true });
    }

    /* ------------------------------ session -------------------------------- */

    const devAuth = process.env.DEV_FAKE_AUTH; // local dev only
    const email = devAuth || readSession(req.headers.cookie);
    if (!crabHealed) { crabHealed = true; try { await updateState(healWelcomeCrab); } catch (e) { crabHealed = false; } }
    const { state, version } = await getState();
    const me = email ? state.users.find((u) => u.email === email && u.status === 'active') : null;

    if (path === '/me') {
      if (!me) return json(res, 401, { error: 'Not signed in' });
      return json(res, 200, { email: me.email, name: me.name, role: me.role });
    }

    // Everything below requires a signed-in, active member.
    if (!me) return json(res, 401, { error: 'Not signed in' });

    /* ------------------------------ state ---------------------------------- */

    if (path === '/state') {
      if (q.since && Number(q.since) === version) return json(res, 200, { version, unchanged: true });
      return json(res, 200, { version, state: shapeState(state, me), files: await listFiles() });
    }

    // The interest list as a spreadsheet, generated fresh on every download.
    if (path === '/interest.csv') {
      if (me.role !== 'admin') return json(res, 403, { error: 'Admins only' });
      const rows = state.interest || [];
      const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const csv = ['Submitted,Updated,Name,Email,Subteam,Coolest project,Cornell address,File']
        .concat(rows.map((r) => [
          new Date(r.ts).toISOString(),
          new Date(r.updated || r.ts).toISOString(),
          cell(r.name), cell(r.email), cell(r.subteam || ''), cell(r.project || ''),
          r.cornell ? 'yes' : 'no',
          r.fileId ? cell(`${r.fileName} · ${WIKI_URL}/api/interest/file/${r.fileId}`) : '',
        ].join(',')))
        .join('\r\n');
      res.statusCode = 200;
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="cupi-interest-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.end('﻿' + csv); // BOM so Excel opens it as UTF-8
    }

    const interestFile = path.match(/^\/interest\/file\/(int-[a-z0-9]+)$/);
    if (interestFile && req.method === 'GET') {
      if (me.role !== 'admin') return json(res, 403, { error: 'Admins only' });
      const f = await getFile(interestFile[1]);
      if (!f) return json(res, 404, { error: 'No such file' });
      res.statusCode = 200;
      res.setHeader('content-type', f.type || 'application/octet-stream');
      res.setHeader('content-disposition', `inline; filename="${encodeURIComponent(f.name)}"`);
      res.setHeader('cache-control', 'private, max-age=3600');
      return res.end(Buffer.from(f.data));
    }

    // Admins can verify the Resend wiring with one click — the real welcome
    // email, sent only to their own signed-in address.
    if (path === '/test-email' && req.method === 'POST') {
      if (me.role !== 'admin') return json(res, 403, { error: 'Admins only' });
      const out = await sendWelcome({ to: me.email, addedByName: me.name, host: req.headers.host, settings: state.settings?.email, clientId: OAUTH_CLIENT_ID, saveOauth: (next) => updateState((s) => { if (s.settings?.email?.oauth) s.settings.email.oauth = next; return s; }) });
      return json(res, 200, out);
    }

    /* ------------------------------ bug reports ---------------------------- */

    if (path === '/bug' && req.method === 'POST') {
      const body = await readJson(req, 4 * 1024 * 1024);
      const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const text = String(body.body || '').trim().slice(0, 10000);
      if (!title || !text) return json(res, 400, { error: 'A title and a description are both required' });
      const last = bugLast.get(me.email) || 0;
      if (Date.now() - last < 20000) return json(res, 429, { error: 'Give it a few seconds between bug reports' });
      const allowed = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
      const images = [];
      let total = 0;
      for (const im of (Array.isArray(body.images) ? body.images : []).slice(0, 4)) {
        const data = String(im?.data || '');
        if (!data) continue;
        if (!/^[A-Za-z0-9+/=]+$/.test(data)) return json(res, 400, { error: 'A screenshot did not decode as an image' });
        total += data.length;
        if (total > 3.5 * 1024 * 1024) return json(res, 413, { error: 'Screenshots are too large even after compression. Drop one and retry' });
        images.push({ type: allowed.has(im.type) ? im.type : 'image/png', data });
      }
      const context = {
        page: String(body.context?.page || '').slice(0, 200),
        ua: String(body.context?.ua || '').slice(0, 300),
        viewport: String(body.context?.viewport || '').slice(0, 20),
      };
      const out = await fileBugPR({ title, body: text, images, context, reporter: { name: me.name, email: me.email } });
      if (out.error) return json(res, out.status || 502, { error: out.error });
      bugLast.set(me.email, Date.now());
      return json(res, 200, out);
    }

    /* --------------------------- Resend connect ---------------------------- */

    if (path === '/resend/connect') {
      if (me.role !== 'admin') return json(res, 403, { error: 'Admins only' });
      if ((req.headers.host || '') !== WIKI_HOST) {
        return json(res, 400, { error: `Connect from ${WIKI_URL} so the OAuth identity matches this deployment's domain.` });
      }
      const verifier = b64url(randomBytes(64));
      const challenge = b64url(createHash('sha256').update(verifier).digest());
      const ostate = b64url(randomBytes(24));
      const u = new URL('https://api.resend.com/oauth/authorize');
      u.searchParams.set('client_id', OAUTH_CLIENT_ID);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('redirect_uri', `${WIKI_URL}/api/resend/callback`);
      u.searchParams.set('scope', 'full_access');
      u.searchParams.set('state', ostate);
      u.searchParams.set('code_challenge', challenge);
      u.searchParams.set('code_challenge_method', 'S256');
      return redirect(res, u.toString(), [`cupi_resend=${ostate}.${verifier}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`]);
    }

    if (path === '/resend/callback') {
      const clear = 'cupi_resend=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax';
      if (me.role !== 'admin') return redirect(res, '/#/admin', [clear]);
      const cookie = /(?:^|;\s*)cupi_resend=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '';
      const dot = cookie.indexOf('.');
      const oastate = dot > 0 ? cookie.slice(0, dot) : '';
      const verifier = dot > 0 ? cookie.slice(dot + 1) : '';
      if (q.error) return redirect(res, '/#/admin?resend=denied', [clear]);
      if (!q.code || !oastate || q.state !== oastate || !verifier) return redirect(res, '/#/admin?resend=state', [clear]);
      const tr = await fetch('https://api.resend.com/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: OAUTH_CLIENT_ID,
          code: q.code,
          redirect_uri: `${WIKI_URL}/api/resend/callback`,
          code_verifier: verifier,
        }),
      });
      if (!tr.ok) return redirect(res, '/#/admin?resend=exchange', [clear]);
      const t = await tr.json();
      // With the grant in hand, pick a sender automatically: wiki@ on the
      // account's first verified domain. Nothing to type when all is well.
      let autoFrom = '';
      let verifiedNames = null;
      try {
        const dr = await fetch('https://api.resend.com/domains', { headers: { authorization: `Bearer ${t.access_token}` } });
        if (dr.ok) {
          const dj = await dr.json();
          const verified = (dj.data || []).filter((x) => x.status === 'verified');
          verifiedNames = verified.map((x) => x.name.toLowerCase());
          if (verified[0]) autoFrom = `wiki@${verified[0].name}`;
        }
      } catch (e) { /* the dropdown covers it later */ }
      await updateState((s) => {
        if (!s.settings) s.settings = {};
        const cur = s.settings.email || {};
        // A saved From that is not on any verified domain can never send.
        // Connecting is the moment we know the truth, so heal it here.
        const curDomain = (cur.from || '').split('@')[1] || '';
        const curFromOk = cur.from && (verifiedNames === null || verifiedNames.includes(curDomain.toLowerCase()));
        s.settings.email = {
          ...cur,
          name: cur.name || 'CUPI Wiki',
          from: curFromOk ? cur.from : autoFrom,
          oauth: {
            refresh: t.refresh_token,
            access: t.access_token,
            accessExp: Date.now() + (Number(t.expires_in) || 900) * 1000,
          },
        };
        return s;
      });
      return redirect(res, '/#/admin?resend=connected', [clear]);
    }

    if (path === '/resend/domains') {
      if (me.role !== 'admin') return json(res, 403, { error: 'Admins only' });
      const email = state.settings?.email;
      let bearer = null;
      if (email?.oauth?.refresh) {
        try {
          bearer = await freshOauthToken(email.oauth, OAUTH_CLIENT_ID, (next) => updateState((s) => { if (s.settings?.email?.oauth) s.settings.email.oauth = next; return s; }));
        } catch (e) { bearer = null; }
      }
      if (!bearer) bearer = email?.key || process.env.RESEND_API_KEY || null;
      if (!bearer) return json(res, 200, { domains: null });
      try {
        const dr = await fetch('https://api.resend.com/domains', { headers: { authorization: `Bearer ${bearer}` } });
        if (!dr.ok) return json(res, 200, { domains: null });
        const dj = await dr.json();
        return json(res, 200, { domains: (dj.data || []).map((d) => ({ name: d.name, status: d.status })) });
      } catch (e) {
        return json(res, 200, { domains: null });
      }
    }

    if (path === '/resend/disconnect' && req.method === 'POST') {
      if (me.role !== 'admin') return json(res, 403, { error: 'Admins only' });
      const cur = state.settings?.email?.oauth;
      if (cur?.refresh) {
        try {
          await fetch('https://api.resend.com/oauth/revoke', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID, token: cur.refresh }),
          });
        } catch (e) { /* best effort */ }
      }
      const out = await updateState((s) => {
        if (s.settings?.email) delete s.settings.email.oauth;
        return s;
      });
      return json(res, 200, { version: out.version, state: shapeState(out.state, me) });
    }

    /* ------------------------------ mutations ------------------------------ */

    if (path === '/mutate' && req.method === 'POST') {
      const body = await readJson(req, 2 * 1024 * 1024);
      const { op, args } = body;
      let opResult, opError;
      const out = await updateState((s) => {
        const r = applyOp(s, op, args, me.email, me.role);
        if (r.error) { opError = r.error; return false; }
        opResult = r.result;
        return s;
      });
      if (opError) return json(res, 400, { error: opError, version: out.version });

      // Welcome emails go out after the state is durably written — access
      // exists either way, the email is just the pointer.
      let emailed = [];
      if (op === 'addMembers' && Array.isArray(opResult)) {
        for (const r of opResult.filter((x) => x.ok)) {
          const sent = await sendWelcome({ to: r.email, addedByName: me.name, host: req.headers.host, settings: out.state.settings?.email, clientId: OAUTH_CLIENT_ID, saveOauth: (next) => updateState((s) => { if (s.settings?.email?.oauth) s.settings.email.oauth = next; return s; }) });
          emailed.push({ email: r.email, ...sent });
        }
      }

      // Removed interest rows take their uploaded files with them.
      if ((op === 'deleteInterest' || op === 'purgeInterest') && opResult?.fileIds) {
        for (const id of opResult.fileIds) {
          try { await deleteFile(id); } catch (e) { /* best effort */ }
        }
      }

      // Purges orphan attachments: sweep anything no live or trashed body references.
      if (op === 'purgePage') {
        try {
          const referenced = new Set();
          for (const list of [out.state.pages, out.state.trash]) {
            for (const pg of list) {
              for (const mm of pg.body.matchAll(/att:([A-Za-z0-9-]+)/g)) referenced.add(mm[1]);
              for (const rv of pg.revs || []) for (const mm of String(rv.body).matchAll(/att:([A-Za-z0-9-]+)/g)) referenced.add(mm[1]);
            }
          }
          for (const f of await listFiles()) if (!referenced.has(f.id)) await deleteFile(f.id);
        } catch (e) { /* sweep is best-effort */ }
      }

      return json(res, 200, { version: out.version, state: shapeState(out.state, me), result: opResult, emailed });
    }

    /* ------------------------------ attachments ---------------------------- */

    // Chunked uploads: big CAD files arrive in ~2.8 MB base64 parts.
    if (path === '/att/begin' && req.method === 'POST') {
      const uploadId = 'up-' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
      return json(res, 200, { uploadId });
    }
    if (path === '/att/part' && req.method === 'POST') {
      const body = await readJson(req);
      if (!/^up-[a-z0-9]+$/.test(String(body.uploadId || ''))) return json(res, 400, { error: 'Bad upload id' });
      const part = String(body.data || '');
      if (!part || part.length > 3200000) return json(res, 400, { error: 'Bad part' });
      await putPart(body.uploadId, Number(body.seq) || 0, part);
      return json(res, 200, { ok: true });
    }
    if (path === '/att/finish' && req.method === 'POST') {
      const body = await readJson(req, 64 * 1024);
      if (!/^up-[a-z0-9]+$/.test(String(body.uploadId || ''))) return json(res, 400, { error: 'Bad upload id' });
      const parts = await takeParts(body.uploadId);
      if (!parts.length) return json(res, 400, { error: 'No uploaded parts found' });
      const data = Buffer.from(parts.join(''), 'base64');
      if (!data.length) return json(res, 400, { error: 'Empty file' });
      if (data.length > 25 * 1048576) return json(res, 413, { error: 'File is over the 25 MB cap' });
      const id = 'att-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      const f = {
        id,
        name: String(body.name || 'file').slice(0, 200),
        type: String(body.type || 'application/octet-stream').slice(0, 100),
        size: data.length, by: me.email, ts: Date.now(), data,
      };
      await putFile(f);
      return json(res, 200, { id, name: f.name, type: f.type, size: f.size, by: f.by, ts: f.ts, url: '/api/att/' + id });
    }

    if (path === '/att' && req.method === 'POST') {
      const body = await readJson(req);
      const data = Buffer.from(String(body.data || ''), 'base64');
      if (!data.length) return json(res, 400, { error: 'Empty file' });
      if (data.length > MAX_UPLOAD) return json(res, 413, { error: 'File is over the 4 MB upload cap' });
      const id = 'att-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      const f = {
        id,
        name: String(body.name || 'file').slice(0, 200),
        type: String(body.type || 'application/octet-stream').slice(0, 100),
        size: data.length, by: me.email, ts: Date.now(), data,
      };
      await putFile(f);
      return json(res, 200, { id, name: f.name, type: f.type, size: f.size, by: f.by, ts: f.ts, url: '/api/att/' + id });
    }

    const attMatch = path.match(/^\/att\/(att-[a-z0-9]+)$/);
    if (attMatch && req.method === 'GET') {
      const f = await getFile(attMatch[1]);
      if (!f) return json(res, 404, { error: 'No such file' });
      res.statusCode = 200;
      res.setHeader('content-type', f.type || 'application/octet-stream');
      res.setHeader('content-disposition', `inline; filename="${encodeURIComponent(f.name)}"`);
      res.setHeader('cache-control', 'private, max-age=31536000, immutable');
      return res.end(Buffer.from(f.data));
    }

    return json(res, 404, { error: 'No such endpoint' });
  } catch (e) {
    if (e instanceof StorageNotConfigured) return json(res, 503, { error: e.message });
    return json(res, 500, { error: e.message || 'Server error' });
  }
}
