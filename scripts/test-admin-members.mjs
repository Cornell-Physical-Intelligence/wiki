// Synthetic members only. View/filter tests do not issue membership mutations.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/client/ui2.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function memberListUsers'), source.indexOf('function welcomeEmailHtml'));
const users = [
  { email: 'owner@example.com', name: 'Zoe Owner', status: 'active', role: 'admin', joined: 1000, subteam: 'Software' },
  { email: 'ben@example.com', name: 'Ben <New>', status: 'invited', role: 'member', invitedAt: 2000, invitedBy: 'owner@example.com' },
  { email: 'alice@example.com', name: 'Alice Active', status: 'active', role: 'member', joined: 1000, subteam: 'Electrical' },
  { email: 'former@example.com', name: 'Former', status: 'removed', role: 'member' },
];
const body = { innerHTML: '', contains: () => false }, count = {}, audit = {};
const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const ctx = vm.createContext({ UI: {}, REMOTE: {}, I: new Proxy({}, { get: () => '<svg></svg>' }), MD: { esc },
  Store: { s: { users }, isAdmin: () => true, me: () => users[0], userName: (email) => users.find((u) => u.email === email)?.name || email,
    activity: () => [], emailSettings: () => ({ from: '', name: '' }) },
  topbar: (text) => text, relTime: () => 'Today', interestDate: () => '9/18/26', RESEND_MARK: '<svg></svg>',
  viewAiSettings: () => '<section data-test-ai>AI</section>', dd: (name) => `<button data-m="${name}"></button>`,
  document: { activeElement: {} }, $: (selector) => selector === '[data-member-rows]' ? body : selector === '[data-member-count]' ? count : selector === '[data-member-audit]' ? audit : null,
  render() { throw new Error('Filtering members must not remount the screen'); },
});
vm.runInContext(helpers, ctx);
const run = (code) => vm.runInContext(code, ctx);
const html = run('viewAdmin()');
assert.equal((html.match(/<table\b/g) || []).length, 1, 'invited and active people share one list');
assert.match(html, /Ben &lt;New>/); assert.match(html, /Alice Active/);
assert.doesNotMatch(html, /awaiting first sign-in|chip--admin|class="chip"|<h2>Add members/);
assert.equal((html.match(/class="member-invited"/g) || []).length, 1);
assert.match(html, /class="member-role">Admin<\/td>/);
assert.match(html, /data-member-invite hidden/); assert.match(html, /aria-label="Search members/);
assert.doesNotMatch(html, /data-test-ai|<h2>Email/, 'integrations left the members page'); assert.match(html, /<h2>Access log/);
const integrations = run('viewIntegrations()');
assert.match(integrations, /<h1>Integrations<\/h1>/); assert.match(integrations, /data-test-ai/); assert.match(integrations, /<h2>Email/);
assert.doesNotMatch(integrations, /<table\b|alice@example.com/, 'the integrations page carries no member data');
assert.doesNotMatch(html, /Welcome emails for new members/);
ctx.UI.emailBusy = 'disconnect';
ctx.Store.emailSettings = () => ({ from: 'wiki@example.com', name: 'Team', oauthConnected: true });
const pendingEmail = run('viewEmailSettings()');
assert.match(pendingEmail, /aria-busy="true"/);
assert.match(pendingEmail, /data-action="resend-disconnect" disabled/);
assert.match(pendingEmail, /data-action="email-test" disabled/);
ctx.UI.emailBusy = false;
assert.equal(run('memberListUsers().map(u => u.email).join(",")'), 'alice@example.com,ben@example.com,owner@example.com');
assert.equal(users.length, 4, 'view sorting/filtering does not mutate saved members');
const ownerRow = run('memberRowsHtml([Store.me()])');
assert.doesNotMatch(ownerRow, /data-action="role-toggle"|data-action="user-remove"/);
assert.match(ownerRow, />You<\/span>/);
ctx.UI.memberQuery = 'INVITED';
assert.equal(run('memberListUsers().map(u => u.email).join(",")'), 'ben@example.com');
ctx.UI.memberQuery = '  ALICE electrical ';
assert.equal(run('memberListUsers().map(u => u.email).join(",")'), 'alice@example.com');
run('renderMemberRows()'); assert.match(body.innerHTML, /Alice Active/); assert.doesNotMatch(body.innerHTML, /Ben/);
assert.equal(count.textContent, '1 of 3 people shown');
assert.match(audit.innerHTML, /Nothing yet/);
ctx.UI.memberPending = new Set(['alice@example.com']);
const pendingRow = run('memberRowsHtml([Store.s.users[2]])');
assert.match(pendingRow, /aria-busy="true"/); assert.equal((pendingRow.match(/ disabled/g) || []).length, 2, 'both conflicting member actions are disabled while pending');
ctx.UI.memberPending.clear();
ctx.UI.memberQuery = 'missing'; run('renderMemberRows()');
assert.match(body.innerHTML, /No people match this search/); assert.equal(count.textContent, '0 of 3 people shown');
ctx.UI.memberInviteOpen = true;
assert.match(run('viewAdmin()'), /data-member-invite >/);
delete ctx.REMOTE; assert.match(run('memberRowsHtml([Store.s.users[1]])'), /data-action="invite-view"/);
ctx.Store.isAdmin = () => false;
assert.match(run('viewAdmin()'), /Only admins/); assert.doesNotMatch(run('viewAdmin()'), /alice@example.com|data-test-ai/);
assert.match(run('viewIntegrations()'), /Only admins/); assert.doesNotMatch(run('viewIntegrations()'), /data-test-ai|<h2>Email/);
console.log('PASS: unified members/invites, plain roles, subtle status, search, self-action protection, inline invitation disclosure, a separate integrations page, and admin authorization');
