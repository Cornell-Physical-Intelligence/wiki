// Session cookies: signing, expiry, tamper rejection, and renewal on use.
process.env.SESSION_SECRET = 'test-secret';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
const { makeSession, readSession, readSessionInfo, renewSession } = await import('../lib/auth.js');

const DAY = 864e5;
const b64u = (v) => Buffer.from(v).toString('base64url');
const forge = (data) => { const p = b64u(JSON.stringify(data)); return `${p}.${createHmac('sha256', 'test-secret').update(p).digest('base64url')}`; };

const token = makeSession('a@cornell.edu');
assert.equal(readSession(`theme=dark; cupi_session=${token}`), 'a@cornell.edu');
const fresh = readSessionInfo(`cupi_session=${token}`);
assert.ok(fresh.exp > Date.now() + 29 * DAY && fresh.exp <= Date.now() + 30 * DAY, 'sessions last 30 days');
assert.equal(renewSession(fresh), null, 'a young session is left alone');
assert.equal(renewSession(null), null);

assert.equal(readSession(''), null);
assert.equal(readSession(`cupi_session=${token}x`), null, 'a tampered signature is rejected');
assert.equal(readSession(`cupi_session=${token.split('.')[0]}.`), null);
assert.equal(readSession(`cupi_session=${forge({ email: 'a@cornell.edu', exp: Date.now() - 1 })}`), null, 'an expired session is rejected');
assert.equal(readSession(`cupi_session=${forge({ exp: Date.now() + DAY })}`), null, 'a session without an email is rejected');

const aging = readSessionInfo(`cupi_session=${forge({ email: 'a@cornell.edu', exp: Date.now() + 10 * DAY })}`);
const cookie = renewSession(aging);
assert.match(cookie, /^cupi_session=[^;]+; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/, 'a session past its midpoint is reissued');
const renewed = readSessionInfo(cookie.split(';')[0]);
assert.equal(renewed.email, 'a@cornell.edu');
assert.ok(renewed.exp > aging.exp + 19 * DAY, 'the reissued session runs a full 30 days');

console.log('session tests passed: signing, 30-day expiry, tamper rejection, renewal past the midpoint');
