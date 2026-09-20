// The entire backend: auth, state, mutations, attachments. One function.
// Rewrites in vercel.json send every /api/* request here.

import { getState, getMember, getEmailSettings, savePreferences, updateState, putFile, getFile, deleteFile, listFiles, putPart, finishUpload, StorageNotConfigured } from '../lib/db.js';
import { applyOp, cleanPreferences, healWelcomeCrab } from '../lib/ops.js';
import { makeSession, readSession, readSessionInfo, renewSession, sessionCookie, clearSessionCookie, oauthStart, oauthCallback } from '../lib/auth.js';
import { sendWelcome, freshOauthToken } from '../lib/email.js';
import { handleInterest } from '../lib/interest.js';
import { fileBugPR } from '../lib/github.js';
import { generateChangeSummary, validateChangeSummary } from '../lib/change-summary.js';
import { reviewPage, validatePageReview } from '../lib/page-review.js';
import { meaningSearch, validateMeaningSearch } from '../lib/meaning-search.js';
import { getAiSettings } from '../lib/db.js';
import { aiUsageLedger } from '../lib/ai-usage.js';
import { AI_MODELS, aiPublicSettings, validateAiSettings, sealAiKey, resolveAiConnection } from '../lib/ai-settings.js';
import { attachmentHeaders } from '../lib/attachment-headers.js';

// Best-effort per-instance spacing so one member cannot firehose PRs.
const bugLast = new Map();
let crabHealed = false; // once per instance; the transform itself no-ops after the first real write
import { createHash, randomBytes } from 'node:crypto';

// The deployment's canonical origin is its OAuth client identity.
const WIKI_URL = (process.env.WIKI_URL || 'https://wiki.cornellphysicalintelligence.com').replace(/\/$/, '');
const WIKI_HOST = new URL(WIKI_URL).host;
const OAUTH_CLIENT_ID = `${WIKI_URL}/oauth/client.json`;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

export const config = { api: { bodyParser: false } };

const MAX_UPLOAD = 4 * 1024 * 1024; // Vercel function body ceiling is ~4.5MB

// Vercel may have pre-parsed the body despite the config flag; prefer it.
async function readJson(req, cap = MAX_UPLOAD) {
  if (req.body !== undefined && req.body !== null) {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(raw, 'utf8') > cap) throw Object.assign(new Error('Body too large'), { status: 413 });
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
function shapeState(state, me, prefs) {
  const email = state.settings?.email;
  return {
    ...state,
    prefs: me ? { [me.email]: prefs ?? state.prefs?.[me.email] ?? {} } : {},
    settings: {
      ai: aiPublicSettings(state.settings?.ai, me?.role === 'admin'),
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
      const { member: u } = await getMember(id.email);
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

    /* ---------------- interest-list component (self-contained) ------------- */

    // Everything under /api/interest* belongs to lib/interest.js. The core
    // hands it a small capability context and stays ignorant of the feature.
    if (path === '/interest' || path === '/interest.csv' || path.startsWith('/interest/')) {
      return await handleInterest(req, res, path, {
        readJson,
        host: req.headers.host,
        clientId: OAUTH_CLIENT_ID,
        me: async () => {
          const who = process.env.DEV_FAKE_AUTH || readSession(req.headers.cookie);
          if (!who) return null;
          const { member } = await getMember(who);
          return member?.status === 'active' ? member : null;
        },
        emailSettings: getEmailSettings,
        saveOauth: (next) => updateState((s) => { if (s.settings?.email?.oauth) s.settings.email.oauth = next; return s; }),
      });
    }

    /* ------------------------------ session -------------------------------- */

    const devAuth = process.env.DEV_FAKE_AUTH; // local dev only
    const session = devAuth ? null : readSessionInfo(req.headers.cookie);
    const email = devAuth || session?.email;
    if (!email) return json(res, 401, { error: 'Not signed in' });
    // Page loads and polls carry a fresh cookie once a session is half over.
    const renewed = renewSession(session);
    const sessionHeaders = renewed ? { 'set-cookie': renewed } : {};
    const syncing = ['/state', '/mutate', '/resend/disconnect'].includes(path);
    const sync = await getMember(email, syncing ? {
      prefsSince: Number.isFinite(Number(q.prefsSince)) ? Number(q.prefsSince) : -1,
      since: Number.isFinite(Number(q.since)) ? Number(q.since) : -1,
    } : null);
    const { member, version, prefsVersion, prefs } = sync;
    const me = member?.status === 'active' ? member : null;

    if (path === '/me') {
      if (!me) return json(res, 401, { error: 'Not signed in' });
      return json(res, 200, { email: me.email, name: me.name, role: me.role }, sessionHeaders);
    }

    // Everything below requires a signed-in, active member.
    if (!me) return json(res, 401, { error: 'Not signed in' });

    if (path === '/ai/usage' && req.method === 'GET') {
      if (me.role !== 'admin') return json(res, 403, { error: 'Only admins can view AI usage' });
      return json(res, 200, { usage: await aiUsageLedger.snapshot() }, { 'cache-control': 'private, no-store' });
    }

    if (path === '/ai/settings' || path === '/ai/test') {
      if (me.role !== 'admin') return json(res, 403, { error: 'Only admins can configure AI' });
      const headers = { 'cache-control': 'private, no-store' };
      if (path === '/ai/settings' && req.method === 'GET') {
        return json(res, 200, { settings: aiPublicSettings(await getAiSettings(), true), models: AI_MODELS }, headers);
      }
      if ((path === '/ai/settings' && req.method === 'PUT') || (path === '/ai/test' && req.method === 'POST')) {
        const body = await readJson(req, 6000);
        const disconnect = path === '/ai/settings' && body?.disconnect === true;
        const checked = disconnect ? { value: {} } : validateAiSettings(body);
        if (checked.error) return json(res, 400, { error: checked.error }, headers);
        const input = checked.value;
        if (path === '/ai/test') {
          const connection = resolveAiConnection(await getAiSettings());
          if (input.key) connection.apiKey = input.key;
          if (!connection.apiKey) return json(res, 400, { error: 'Add an OpenAI API key first' }, headers);
          const result = await generateChangeSummary({ title: 'Connection test', beforeTitle: 'Connection test', section: 'Software', beforeSection: 'Software', diff: '- Test pending\n+ Test complete', isNew: false, truncated: false }, { ...connection, model: input.model, effort: input.effort, actor: email });
          const errors = { budget_limit: 'The wiki has reached its AI spending limit. Editing and saving are still available.', request_limit: 'This request could exceed the 5¢ limit. Choose Luna or a lower reasoning effort.', rate_limit: 'Too many AI requests. Try again in a minute.', concurrency_limit: 'AI is handling other requests. Try again shortly.', duplicate: 'This request was already checked recently. Try again later.', accounting_unavailable: 'Spending protection is unavailable. No AI request was sent.', accounting_halted: 'AI is paused because provider usage exceeded its reservation. Review the account billing before resuming.', authentication: 'OpenAI rejected this key. Check its permissions or replace it.', quota: 'OpenAI could not accept the request. Check the account’s credits and rate limits.', configuration: 'This account cannot use the selected model and effort.', incomplete: 'The model did not finish in the available response budget. Try a lower effort.', unavailable: 'OpenAI did not respond in time. Try again.' };
          return result.available ? json(res, 200, { ok: true }, headers) : json(res, 422, { error: errors[result.reason] || 'The connection could not complete a test request.' }, headers);
        }
        const credential = input.key ? sealAiKey(input.key) : null;
        let denied = false;
        const out = await updateState((s) => {
          denied = !s.users.some((u) => u.email === email && u.status === 'active' && u.role === 'admin');
          if (denied) return false;
          s.settings ||= {};
          const current = s.settings.ai || {};
          s.settings.ai = disconnect
            ? { ...current, credential: null, keyTail: '', enabled: false, updatedAt: Date.now(), updatedBy: email }
            : { ...current, model: input.model, effort: input.effort, enabled: true,
                ...(credential ? { credential, keyTail: input.key.slice(-4) } : {}), updatedAt: Date.now(), updatedBy: email };
          return s;
        });
        if (denied) return json(res, 403, { error: 'Only active admins can configure AI' }, headers);
        return json(res, 200, { settings: aiPublicSettings(out.state.settings.ai, true) }, headers);
      }
      return json(res, 405, { error: 'Method not allowed' }, headers);
    }

    // Server-only credentials; summaries never mutate the page or bypass its
    // normal save/conflict checks. Every provider call reserves shared budget.
    if (path === '/change-summary' && req.method === 'POST') {
      const input = validateChangeSummary(await readJson(req, 80000));
      if (!input) return json(res, 400, { error: 'Invalid change preview' });
      return json(res, 200, await generateChangeSummary(input, { ...resolveAiConnection(await getAiSettings()), actor: email }), { 'cache-control': 'private, no-store' });
    }

    if (path === '/page-review' && req.method === 'POST') {
      const input = validatePageReview(await readJson(req, 240000));
      if (!input) return json(res, 400, { error: 'Invalid page review' });
      return json(res, 200, await reviewPage(input), { 'cache-control': 'private, no-store' });
    }

    if (path === '/meaning-search' && req.method === 'POST') {
      const input = validateMeaningSearch(await readJson(req, 180000));
      if (!input) return json(res, 400, { error: 'Invalid search request' });
      return json(res, 200, await meaningSearch(input), { 'cache-control': 'private, no-store' });
    }

    /* ------------------------------ state ---------------------------------- */

    if (path === '/state') {
      if (q.since && Number(q.since) === version) {
        return json(res, 200, { version, unchanged: true, prefsVersion, ...(prefs !== null ? { prefs } : {}) }, sessionHeaders);
      }
      let out = await getState();
      // Check the legacy content migration against state we already needed.
      // Cold starts and unchanged polls must not fetch a second full copy.
      if (!crabHealed) {
        crabHealed = true;
        if (healWelcomeCrab(structuredClone(out.state)) !== false) {
          try { out = await updateState(healWelcomeCrab); } catch (e) { crabHealed = false; }
        }
      }
      const currentMe = out.state.users.find((u) => u.email === email && u.status === 'active');
      if (!currentMe) return json(res, 401, { error: 'Not signed in' });
      return json(res, 200, { version: out.version, prefsVersion, state: shapeState(out.state, currentMe, prefs), files: await listFiles() }, sessionHeaders);
    }

    // Admins can verify the Resend wiring with one click — the real welcome
    // email, sent only to their own signed-in address.
    if (path === '/test-email' && req.method === 'POST') {
      if (me.role !== 'admin') return json(res, 403, { error: 'Admins only' });
      const out = await sendWelcome({ to: me.email, addedByName: me.name, host: req.headers.host, settings: await getEmailSettings(), clientId: OAUTH_CLIENT_ID, saveOauth: (next) => updateState((s) => { if (s.settings?.email?.oauth) s.settings.email.oauth = next; return s; }) });
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
      const email = await getEmailSettings();
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
      const cur = (await getEmailSettings())?.oauth;
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
      return json(res, 200, { version: out.version, prefsVersion, state: shapeState(out.state, me, prefs) });
    }

    /* ------------------------------ mutations ------------------------------ */

    if (path === '/mutate' && req.method === 'POST') {
      const body = await readJson(req, 2 * 1024 * 1024);
      const { op, args } = body;
      if (op === 'setPrefs') {
        const saved = await savePreferences(email, cleanPreferences(args?.prefs));
        if (!saved) return json(res, 401, { error: 'Not signed in' });
        return json(res, 200, { ok: true, ...saved });
      }
      let opResult, opError, opStatus = 400;
      const out = await updateState((s) => {
        // Authorize against the same revision that is being changed, including
        // retries after another admin removes a member or changes their role.
        const actor = s.users.find((u) => u.email === email && u.status === 'active');
        if (!actor) { opStatus = 401; opError = 'Not signed in'; return false; }
        const r = applyOp(s, op, args, actor.email, actor.role);
        if (r.error) { opError = typeof r.error === 'string' ? r.error : 'Unknown op'; return false; }
        opResult = r.result;
        return s;
      });
      if (opError) return json(res, opStatus, { error: opError, version: out.version });

      // Welcome emails go out after the state is durably written — access
      // exists either way, the email is just the pointer.
      let emailed = [];
      if (op === 'addMembers' && Array.isArray(opResult)) {
        for (const r of opResult.filter((x) => x.ok)) {
          const sent = await sendWelcome({ to: r.email, addedByName: me.name, host: req.headers.host, settings: out.state.settings?.email, clientId: OAUTH_CLIENT_ID, saveOauth: (next) => updateState((s) => { if (s.settings?.email?.oauth) s.settings.email.oauth = next; return s; }) });
          emailed.push({ email: r.email, ...sent });
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

      return json(res, 200, { version: out.version, prefsVersion, state: shapeState(out.state, me, prefs), result: opResult, emailed });
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
      const seq = Number(body.seq);
      if (!Number.isSafeInteger(seq) || seq < 0) return json(res, 400, { error: 'Bad part number' });
      await putPart(body.uploadId, seq, part);
      return json(res, 200, { ok: true });
    }
    if (path === '/att/finish' && req.method === 'POST') {
      const body = await readJson(req, 64 * 1024);
      if (!/^up-[a-z0-9]+$/.test(String(body.uploadId || ''))) return json(res, 400, { error: 'Bad upload id' });
      const f = await finishUpload(body.uploadId, {
        name: String(body.name || 'file').slice(0, 200),
        type: String(body.type || 'application/octet-stream').slice(0, 100),
        by: me.email,
      });
      if (f.error) return json(res, f.status, { error: f.error });
      return json(res, 200, { ...f, url: '/api/att/' + f.id });
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
      for (const [k, v] of Object.entries(attachmentHeaders(f))) res.setHeader(k, v);
      return res.end(Buffer.from(f.data));
    }

    return json(res, 404, { error: 'No such endpoint' });
  } catch (e) {
    if (e.status === 413) return json(res, 413, { error: 'Body too large' });
    if (e instanceof StorageNotConfigured) return json(res, 503, { error: e.message });
    if (/exceeded (?:the )?data transfer quota/i.test(String(e?.message || ''))) {
      return json(res, 503, {
        error: 'The wiki database has reached its monthly transfer limit. An administrator needs to restore database access.',
        code: 'DATABASE_QUOTA_EXCEEDED',
      }, { 'retry-after': '300' });
    }
    return json(res, 500, { error: e.message || 'Server error' });
  }
}
