// The entire backend: auth, state, mutations, attachments. One function.
// Rewrites in vercel.json send every /api/* request here.

import { getState, updateState, putFile, getFile, listFiles } from '../lib/db.js';
import { applyOp } from '../lib/ops.js';
import { makeSession, readSession, sessionCookie, clearSessionCookie, oauthStart, oauthCallback } from '../lib/auth.js';
import { sendInvite } from '../lib/email.js';

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

// What each member is allowed to see: invite codes are admin-only,
// other people's prefs are nobody's business.
function shapeState(state, me) {
  const admin = me?.role === 'admin';
  return {
    ...state,
    users: state.users.map((u) => admin ? u : { ...u, inviteCode: undefined }),
    prefs: me ? { [me.email]: state.prefs?.[me.email] || {} } : {},
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
        // OAuth proves ownership of the invited address — activate directly.
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

    /* ------------------------------ session -------------------------------- */

    const devAuth = process.env.DEV_FAKE_AUTH; // local dev only
    const email = devAuth || readSession(req.headers.cookie);
    const { state, version } = await getState();
    const me = email ? state.users.find((u) => u.email === email && u.status === 'active') : null;

    if (path === '/me') {
      if (!me) return json(res, 401, { error: 'Not signed in' });
      return json(res, 200, { email: me.email, name: me.name, role: me.role });
    }

    if (path === '/redeem' && req.method === 'POST') {
      const body = await readJson(req, 4096);
      const code = String(body.code || '').trim().toUpperCase();
      let activated = null;
      await updateState((s) => {
        const u = s.users.find((x) => x.status === 'invited' && x.inviteCode === code);
        if (!u) return false;
        u.status = 'active'; u.joined = Date.now(); delete u.inviteCode;
        s.activity.unshift({ ts: Date.now(), by: u.email, kind: 'join' });
        activated = u.email;
        return s;
      });
      if (!activated) return json(res, 400, { error: 'That code doesn’t match any pending invite.' });
      return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie(makeSession(activated)) });
    }

    // Everything below requires a signed-in, active member.
    if (!me) return json(res, 401, { error: 'Not signed in' });

    /* ------------------------------ state ---------------------------------- */

    if (path === '/state') {
      if (q.since && Number(q.since) === version) return json(res, 200, { version, unchanged: true });
      return json(res, 200, { version, state: shapeState(state, me), files: await listFiles() });
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

      // Invites: send the emails after the state is durably written.
      let emailed = [];
      if (op === 'addMembers' && Array.isArray(opResult)) {
        for (const r of opResult.filter((x) => x.ok)) {
          const sent = await sendInvite({ to: r.email, code: r.code, invitedByName: me.name, host: req.headers.host });
          emailed.push({ email: r.email, ...sent });
        }
      }
      if (op === 'resendInvite' && opResult?.code) {
        const sent = await sendInvite({ to: opResult.email, code: opResult.code, invitedByName: me.name, host: req.headers.host });
        emailed.push({ email: opResult.email, ...sent });
      }

      return json(res, 200, { version: out.version, state: shapeState(out.state, me), result: opResult, emailed });
    }

    /* ------------------------------ attachments ---------------------------- */

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
      res.setHeader('content-type', f.type);
      res.setHeader('content-disposition', `inline; filename="${encodeURIComponent(f.name)}"`);
      res.setHeader('cache-control', 'private, max-age=31536000, immutable');
      return res.end(Buffer.from(f.data));
    }

    return json(res, 404, { error: 'No such endpoint' });
  } catch (e) {
    return json(res, 500, { error: e.message || 'Server error' });
  }
}
