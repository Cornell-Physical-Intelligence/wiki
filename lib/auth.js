// Google OAuth (authorization-code flow, no libraries) + HMAC-signed session
// cookies. "Sign in with Google" IS Cornell login here: Cornell email runs on
// Google Workspace, we pass hd=cornell.edu, and we re-verify the domain and
// the member allowlist server-side — the hd hint alone is not a control.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SECRET = () => process.env.SESSION_SECRET || 'dev-secret-not-for-production';
const DAYS30 = 30 * 24 * 3600;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) => createHmac('sha256', SECRET()).update(payload).digest('base64url');

export function makeSession(email) {
  const payload = b64u(JSON.stringify({ email, exp: Date.now() + DAYS30 * 1000 }));
  return `${payload}.${sign(payload)}`;
}

export function readSession(cookieHeader) {
  const m = /(?:^|;\s*)cupi_session=([^;]+)/.exec(cookieHeader || '');
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  const expect = sign(payload);
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Date.now()) return null;
    return data.email;
  } catch (e) { return null; }
}

export const sessionCookie = (token) =>
  `cupi_session=${token}; Path=/; Max-Age=${DAYS30}; HttpOnly; Secure; SameSite=Lax`;
export const clearSessionCookie = () =>
  `cupi_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

export function oauthStart(req) {
  const state = randomBytes(16).toString('hex');
  const redirect = `https://${req.headers.host}/api/auth/callback`;
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'openid email profile',
    hd: 'cornell.edu',
    prompt: 'select_account',
    state,
  });
  return { url, stateCookie: `cupi_oauth=${state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax` };
}

// Exchanges the code and verifies the identity. Returns {email, name} or {error}.
export async function oauthCallback(req, query) {
  const m = /(?:^|;\s*)cupi_oauth=([^;]+)/.exec(req.headers.cookie || '');
  if (!m || m[1] !== query.state) return { error: 'State mismatch — try signing in again.' };
  const redirect = `https://${req.headers.host}/api/auth/callback`;
  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: query.code,
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirect_uri: redirect,
      grant_type: 'authorization_code',
    }),
  });
  const tok = await tr.json();
  if (!tok.id_token) return { error: 'Google did not return an identity. Check OAuth credentials.' };
  // Google validates the signature for us at tokeninfo; we validate the claims.
  const vr = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(tok.id_token));
  const info = await vr.json();
  if (info.aud !== process.env.GOOGLE_CLIENT_ID) return { error: 'Token audience mismatch.' };
  if (info.email_verified !== 'true' && info.email_verified !== true) return { error: 'Email not verified.' };
  const email = String(info.email || '').toLowerCase();
  if (!email.endsWith('@cornell.edu')) return { error: 'A cornell.edu account is required.', email };
  return { email, name: info.name || email.split('@')[0] };
}
