// Mutation dispatch and attachment responses cannot be turned against the wiki.
import assert from 'node:assert/strict';
import { applyOp } from '../lib/ops.js';
import { attachmentHeaders } from '../lib/attachment-headers.js';

const state = () => ({ users: [{ email: 'a@cornell.edu', status: 'active', role: 'member' }], pages: [], trash: [], activity: [],
  settings: { email: { key: 'SECRET-KEY', oauth: { refresh: 'R' } } } });

for (const op of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', '__defineGetter__', '', 42, null, undefined, {}]) {
  const s = state();
  const r = applyOp(s, op, {}, 'a@cornell.edu', 'member');
  assert.equal(r.error, 'Unknown op', `${String(op)} is rejected`);
  assert.equal(typeof r.error, 'string');
  assert.ok(!JSON.stringify(r).includes('SECRET-KEY'), `${String(op)} leaks nothing`);
}
assert.equal(applyOp(state(), 'purgePage', { id: 'x' }, 'a@cornell.edu', 'member').error, 'Admins only', 'real admin ops still gate on role');

const png = attachmentHeaders({ type: 'image/png', name: 'board.png' });
assert.equal(png['content-type'], 'image/png'); assert.match(png['content-disposition'], /^inline; filename="board\.png"/);
assert.equal(png['x-content-type-options'], 'nosniff'); assert.equal(png['content-security-policy'], 'sandbox');

const html = attachmentHeaders({ type: 'text/html; charset=utf-8', name: 'evil.html' });
assert.equal(html['content-type'], 'application/octet-stream'); assert.match(html['content-disposition'], /^attachment;/);
assert.equal(html['content-security-policy'], 'sandbox');

const svg = attachmentHeaders({ type: 'image/svg+xml', name: 'logo.svg' });
assert.equal(svg['content-type'], 'image/svg+xml'); assert.match(svg['content-disposition'], /^inline;/); assert.equal(svg['content-security-policy'], 'sandbox');

const pdf = attachmentHeaders({ type: 'application/pdf', name: 'sch.pdf' });
assert.equal(pdf['content-type'], 'application/pdf'); assert.equal(pdf['content-security-policy'], undefined, 'the PDF viewer needs no sandbox');

const stl = attachmentHeaders({ type: 'model/stl', name: 'bracket v2.stl' });
assert.equal(stl['content-type'], 'application/octet-stream'); assert.match(stl['content-disposition'], /^attachment; filename="bracket%20v2\.stl"/);

const odd = attachmentHeaders({ type: 'IMAGE/JPEG', name: 'a"b.jpg' });
assert.equal(odd['content-type'], 'image/jpeg'); assert.ok(!odd['content-disposition'].includes('a"b'), 'quotes are encoded');

console.log('hardening tests passed: prototype op names rejected without leaking state, attachments nosniff/sandboxed, unknown types download');
