// Deferred transports exercise the real admin handlers without network or keys.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { AI_MODELS, AI_DEFAULTS } from '../lib/ai-settings.js';

const main = await readFile(new URL('../src/client/main.js', import.meta.url), 'utf8');
const ai = await readFile(new URL('../src/client/ai.js', import.meta.url), 'utf8');
const handlers = main.slice(main.indexOf('function adminFormMessage'), main.indexOf("document.addEventListener('submit'"));
function fixture(kind = 'email-settings-form') {
  const requests = [], messages = [], document = { body: {}, activeElement: null };
  const field = (value) => ({ value, disabled: false, isConnected: true, focus() { document.activeElement = this; } });
  const form = { dataset: { action: kind, adminDirty: 'true' }, style: {}, isConnected: true,
    elements: { from: field('wiki@example.com'), fromname: field('Team wiki'), key: field('synthetic-only'), emails: field('first@example.com, second@example.com') },
    append(el) { this.error = el; }, error: { hidden: true, dataset: {} },
  };
  let renders = 0;
  document.activeElement = form.elements.key;
  document.createElement = () => ({ dataset: {}, style: {}, setAttribute() {} });
  const model = { dataset: { value: 'gpt-5.6-luna' } }, effort = { dataset: { value: 'none' } };
  const rowError = { hidden: true }, row = { isConnected: true, setAttribute() {}, contains: (el) => controls.includes(el) };
  const configure = { focus() { document.activeElement = configure; } };
  const controls = [...Object.values(form.elements), { disabled: false }];
  const transport = (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject }));
  const ctx = vm.createContext({ UI: { route: { name: 'admin' }, aiEdit: kind === 'ai-settings-form' }, REMOTE: {}, Store: { s: { settings: {} }, isAdmin: () => false }, AbortSignal, document, AI_MODELS, AI_DEFAULTS,
    MD: { esc: (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;') },
    dd: (name, options, value) => `<button type="button" class="dd" data-m="${name}" data-value="${value}">${options.find((o) => o.value === value)?.label || ''}</button>`,
    $: (selector, scope) => selector.includes('data-ai-connection-error') ? rowError : selector.includes('data-action="ai-configure"') ? configure
      : selector === '.ai-integration' || selector === '.email-integration' ? row : selector === '.ai-settings' ? (ctx.UI.aiEdit ? form : null) : selector === '.ai-settings [name="key"]' ? form.elements.key
      : selector.includes('data-admin-error') || selector.includes('data-ai-error') ? (scope || form).error
      : selector.includes('ai-model') ? model : selector.includes('ai-effort') ? effort : selector.includes('invite-role') ? { dataset: { value: 'member' } } : form,
    $$: () => controls, api: transport, requestMutation: transport,
    render() { renders++; }, toast: (text) => messages.push(text),
  });
  vm.runInContext(handlers + ai, ctx);
  ctx.form = form;
  return { ctx, requests, messages, form, controls, rowError, get renders() { return renders; }, run: (source) => vm.runInContext(source, ctx) };
}
{
  const f = fixture(), save = f.run('submitEmailSettings(form)');
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].args[0], 'setEmailSettings');
  assert.equal(f.form.elements.key.value, 'synthetic-only'); assert.equal(f.messages.length, 0);
  assert.equal(f.form.dataset.adminPending, 'true'); assert.ok(f.controls.every((el) => el.disabled));
  await f.run('submitEmailSettings(form)'); assert.equal(f.requests.length, 1, 'pending admin submits coalesce');
  f.requests[0].reject(new Error('Synthetic validation failure')); await save;
  assert.equal(f.form.elements.key.value, 'synthetic-only'); assert.equal(f.renders, 0);
  assert.equal(f.form.dataset.adminDirty, 'true'); assert.equal(f.form.dataset.adminPending, 'false');
  assert.match(f.form.error.textContent, /Synthetic validation failure/); assert.ok(f.controls.every((el) => !el.disabled));
  const retry = f.run('submitEmailSettings(form)');
  f.ctx.UI.route.name = 'edit'; f.ctx.UI.editor = { dirty: true }; f.form.isConnected = false;
  f.requests[1].resolve({}); await retry;
  assert.equal(f.form.elements.key.value, ''); assert.equal(f.renders, 0, 'late settings save cannot remount an editor');
  assert.deepEqual(f.messages, ['Email settings saved']);
}
{
  const f = fixture('invite-form'), save = f.run('submitInvites(form)');
  assert.equal(f.form.elements.emails.value, 'first@example.com, second@example.com'); assert.equal(f.messages.length, 0);
  f.requests[0].reject(new Error('Offline')); await save;
  assert.equal(f.form.elements.emails.value, 'first@example.com, second@example.com'); assert.equal(f.renders, 0);
  const retry = f.run('submitInvites(form)');
  f.requests[1].resolve({ result: [{ email: 'first@example.com', ok: true }, { email: 'second@example.com', ok: false, reason: 'Already on roster' }],
    emailed: [{ email: 'first@example.com', sent: false, reason: 'No email connection' }] }); await retry;
  assert.equal(f.form.elements.emails.value, 'second@example.com');
  assert.match(f.form.error.textContent, /Already on roster/); assert.match(f.form.error.textContent, /Welcome email not sent/);
  assert.deepEqual(f.messages, ['Added 1 member'], 'membership and mail delivery have separate confirmed outcomes');
}
{
  const f = fixture('ai-settings-form'), save = f.run('changeAiSettings(form)');
  f.ctx.UI.route.name = 'edit'; f.ctx.UI.editor = { dirty: true }; f.form.isConnected = false;
  f.requests[0].resolve({ settings: { model: 'gpt-5.6-luna', effort: 'none', connected: true } }); await save;
  assert.equal(f.renders, 0); assert.equal(f.form.elements.key.value, '');
  assert.equal(f.form.dataset.adminPending, 'false'); assert.equal(f.form.dataset.adminDirty, 'false');
}
{
  const f = fixture('ai-settings-form'), save = f.run('changeAiSettings(form)');
  f.requests[0].reject(new Error('Synthetic invalid key')); await save;
  assert.equal(f.form.elements.key.value, 'synthetic-only'); assert.equal(f.form.dataset.adminDirty, 'true');
  assert.match(f.form.error.textContent, /Synthetic invalid key/); assert.equal(f.renders, 0);
}
{
  const f = fixture('invite-form'), save = f.run('submitInvites(form)');
  const laterForm = { elements: { emails: { value: 'new-draft@example.com' } } };
  f.form.isConnected = false;
  const previousQuery = f.ctx.$;
  f.ctx.$ = (selector, scope) => selector === 'form[data-action="invite-form"]' ? laterForm : previousQuery(selector, scope);
  f.requests[0].resolve({ result: [{ email: 'first@example.com', ok: false, reason: 'Already on roster' }], emailed: [] });
  await save;
  assert.equal(laterForm.elements.emails.value, 'new-draft@example.com', 'a late response cannot overwrite a newly opened admin draft');
  assert.equal(f.renders, 0); assert.match(f.messages.at(-1), /Already on roster/);
}
{
  const start = main.indexOf("if (host.dataset.m === 'email-from')");
  const end = main.indexOf('\n        },', start);
  const field = { value: 'original@example.com', setAttribute() {}, focus() {} };
  const form = { elements: { from: field }, dataset: {} };
  const ctx = vm.createContext({ UI: {}, host: { dataset: { m: 'email-from' }, closest: () => form, remove() {} }, o: { value: 'changed@example.com' },
    Store: { setEmailSettings() { throw new Error('Dropdown saved without submitting'); } }, render() { throw new Error('Dropdown remounted the form'); },
  });
  vm.runInContext(main.slice(start, end), ctx);
  assert.equal(field.value, 'changed@example.com'); assert.equal(form.dataset.adminDirty, 'true');
  ctx.o.value = '__custom'; vm.runInContext(main.slice(start, end), ctx);
  assert.equal(field.type, 'text'); assert.equal(field.value, 'changed@example.com');
}
{
  const f = fixture('ai-settings-form'); f.ctx.UI.aiEdit = false;
  const closed = f.run('viewAiSettings()');
  assert.match(closed, /integration__tile/); assert.match(closed, /OpenAI/); assert.match(closed, />Connect<\/button>/);
  assert.doesNotMatch(closed, /data-action="ai-settings-form"/); assert.doesNotMatch(closed, /type="password"/);
  assert.doesNotMatch(closed, /Automatic change summaries/);
  assert.match(closed, /aria-controls="ai-configuration"/);
  f.run('setAiConfiguration(true)');
  assert.equal(f.ctx.UI.aiEdit, true); assert.equal(f.ctx.UI.aiDraft.model, 'gpt-5.6-luna'); assert.equal(f.ctx.UI.aiDraft.effort, 'none');
  const open = f.run('viewAiSettings()');
  assert.match(open, /data-action="ai-settings-form"/); assert.match(open, /data-action="ai-cancel"/); assert.match(open, /data-m="ai-model"/);
  assert.match(open, /id="ai-configuration"/);
  assert.doesNotMatch(open, /<select|<datalist/);
  f.form.elements.key.value = 'unsaved-synthetic-key'; f.run('setAiConfiguration(false)');
  assert.equal(f.form.elements.key.value, ''); assert.equal(f.ctx.UI.aiDraft, null); assert.equal(f.ctx.UI.aiEdit, false);
  assert.equal(f.requests.length, 0, 'cancel discards local configuration without saving');
}
{
  const f = fixture('ai-settings-form'); f.ctx.UI.aiEdit = false;
  f.ctx.Store.s.settings.ai = { model: 'gpt-5.6-luna', effort: 'none', connected: true };
  const closed = f.run('viewAiSettings()');
  assert.match(closed, /Connected/); assert.match(closed, /Luna · Fastest/); assert.match(closed, /data-action="ai-configure"/);
  assert.doesNotMatch(closed, /data-action="ai-settings-form"/);
  f.ctx.UI.aiDraft = { model: 'gpt-6-astra', effort: 'high' };
  const checking = f.run("changeAiSettings(null, 'test')");
  const body = JSON.parse(f.requests[0].args[1].body);
  assert.deepEqual(body, { model: 'gpt-5.6-luna', effort: 'none', key: '' }, 'row testing uses saved configuration, never a hidden draft');
  f.requests[0].reject(new Error('Synthetic account unavailable')); await checking;
  assert.match(f.rowError.textContent, /Synthetic account unavailable/); assert.equal(f.ctx.UI.aiEdit, false);
  const disconnecting = f.run("changeAiSettings(null, 'disconnect')");
  assert.deepEqual(JSON.parse(f.requests[1].args[1].body), { disconnect: true });
  f.requests[1].resolve({ settings: { model: 'gpt-5.6-luna', effort: 'none', connected: false } }); await disconnecting;
  assert.equal(f.ctx.Store.s.settings.ai.connected, false); assert.equal(f.ctx.UI.aiEdit, false);
  assert.equal(f.messages.at(-1), 'AI disconnected');
}
{
  const f = fixture('ai-settings-form'), save = f.run('changeAiSettings(form)');
  const unrelatedInput = { value: 'pending email draft' };
  f.ctx.document.activeElement = unrelatedInput;
  f.requests[0].resolve({ settings: { model: 'gpt-5.6-luna', effort: 'none', connected: true } }); await save;
  assert.equal(f.ctx.document.activeElement, unrelatedInput, 'AI save does not take focus from another admin form');
  assert.equal(unrelatedInput.value, 'pending email draft');
  assert.equal(f.renders, 0, 'AI completion refreshes only its own integration');
  assert.equal(f.messages.at(-1), 'AI settings saved');
}
{
  const f = fixture('ai-settings-form'), checking = f.run("changeAiSettings(form, 'test')");
  f.ctx.document.activeElement = f.ctx.document.body;
  f.requests[0].resolve({}); await checking;
  assert.equal(f.ctx.document.activeElement, f.form.elements.key, 'testing returns focus if disabling the control dropped focus');
}
function memberFixture() {
  const f = fixture(), users = [{ email: 'owner@example.com', name: 'Owner', role: 'admin' }, { email: 'member@example.com', name: 'Member', role: 'member' }];
  Object.assign(f.ctx.Store, { user: (email) => users.find((u) => u.email === email), me: () => users[0], isAdmin: () => true,
    setRole() { throw new Error('Remote role update must await acknowledgment'); }, removeUser() { throw new Error('Remote removal must await acknowledgment'); } });
  f.form.contains = () => false;
  let rows = 0;
  f.ctx.renderMemberRows = () => { rows++; };
  return { ...f, users, get renders() { return f.renders; }, get rowRenders() { return rows; } };
}
{
  const f = memberFixture(), changing = f.run("updateAdminMember('member@example.com', 'admin')");
  assert.equal(f.ctx.UI.memberPending.has('member@example.com'), true);
  assert.equal(f.users[1].role, 'member'); assert.equal(f.messages.length, 0);
  assert.equal(f.requests[0].args[0], 'setRole');
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[0].args[1])), { email: 'member@example.com', role: 'admin' });
  await f.run("updateAdminMember('member@example.com', null)");
  await f.run("updateAdminMember('member@example.com', 'admin')");
  assert.equal(f.requests.length, 1, 'role changes and removal cannot overlap for the same person');
  f.users[1].role = 'admin'; f.requests[0].resolve({}); await changing;
  assert.deepEqual(f.messages, ['Member is now an admin']);
  assert.equal(f.ctx.UI.memberPending.size, 0); assert.equal(f.rowRenders, 2);
  assert.equal(f.renders, 0); assert.equal(f.form.elements.key.value, 'synthetic-only');
}
{
  const f = memberFixture(), removing = f.run("updateAdminMember('member@example.com', null)");
  assert.equal(f.requests[0].args[0], 'removeUser'); assert.equal(f.users.length, 2);
  f.requests[0].reject(new Error('Synthetic authorization failure')); await removing;
  assert.equal(f.users.length, 2); assert.deepEqual(f.messages, ['Synthetic authorization failure']);
  assert.equal(f.ctx.UI.memberPending.size, 0); assert.equal(f.renders, 0);
  const retry = f.run("updateAdminMember('member@example.com', null)");
  f.ctx.UI.route.name = 'edit'; f.ctx.UI.editor = { dirty: true };
  f.users.splice(1, 1); f.requests[1].resolve({}); await retry;
  assert.equal(f.rowRenders, 3, 'late member completion does not repaint the new editor');
  assert.equal(f.messages.at(-1), 'Member removed');
  await f.run("updateAdminMember('owner@example.com', null)");
  assert.equal(f.requests.length, 2, 'the owner cannot remove themself');
  f.ctx.Store.isAdmin = () => false;
  await f.run("updateAdminMember('owner@example.com', 'member')");
  assert.equal(f.requests.length, 2, 'non-admin actions are denied locally');
}
function emailFixture() {
  const f = fixture(), adopted = [];
  f.ctx.Store.isAdmin = () => true;
  f.ctx.Store.me = () => ({ email: 'owner@example.com' });
  f.ctx.adoptServer = (out) => adopted.push(out);
  f.ctx.viewEmailSettings = () => '<section>Updated email connection</section>';
  const previousAll = f.ctx.$$;
  f.ctx.$$ = (selector, scope) => selector === 'form[data-action="email-settings-form"]' ? [] : previousAll(selector, scope);
  return { ...f, adopted, get renders() { return f.renders; } };
}
{
  const f = emailFixture(), testing = f.run("runEmailIntegrationAction('test')");
  assert.equal(f.requests[0].args[0], '/test-email'); assert.ok(f.requests[0].args[1].signal instanceof AbortSignal);
  assert.equal(f.ctx.UI.emailBusy, 'test'); assert.ok(f.controls.every((el) => el.disabled));
  await f.run("runEmailIntegrationAction('disconnect')"); await f.run('submitEmailSettings(form)');
  assert.equal(f.requests.length, 1, 'test, disconnect and settings writes cannot overlap');
  f.ctx.UI.route.name = 'edit'; f.ctx.UI.editor = { dirty: true }; f.ctx.Store.me = () => null;
  f.requests[0].resolve({ sent: true }); await testing;
  assert.deepEqual(f.messages, ['Test sent to owner@example.com.'], 'late success uses the original recipient');
  assert.equal(f.renders, 0); assert.equal(f.ctx.UI.emailBusy, false); assert.ok(f.controls.every((el) => !el.disabled));
}
{
  const f = emailFixture(), disconnecting = f.run("runEmailIntegrationAction('disconnect')");
  assert.equal(f.requests[0].args[0], '/resend/disconnect'); assert.ok(f.requests[0].args[1].signal instanceof AbortSignal);
  const timeout = new Error('Synthetic timeout'); timeout.name = 'TimeoutError';
  f.requests[0].reject(timeout); await disconnecting;
  assert.equal(f.adopted.length, 0); assert.equal(f.renders, 0); assert.equal(f.ctx.UI.emailBusy, false);
  assert.match(f.messages[0], /disconnect timed out/); assert.ok(f.controls.every((el) => !el.disabled));
  const retry = f.run("runEmailIntegrationAction('disconnect')");
  f.ctx.UI.route.name = 'edit'; f.ctx.UI.editor = { dirty: true };
  f.requests[1].resolve({ state: 'synthetic' }); await retry;
  assert.equal(f.adopted.length, 1); assert.equal(f.renders, 0);
  assert.equal(f.messages.at(-1), 'Resend disconnected');
}
{
  const f = emailFixture(), oldSection = f.ctx.$('.email-integration'), newSection = { setAttribute() {} };
  const disclosure = { open: false }, senderForm = { dataset: { adminDirty: 'true' }, classList: { contains: () => true }, closest: () => null };
  f.form.classList = { contains: () => false }; f.form.closest = () => disclosure;
  const replacements = [];
  let currentSection = oldSection;
  Object.defineProperty(oldSection, 'outerHTML', { set(html) {
    assert.match(html, /Updated email connection/); currentSection = newSection; oldSection.isConnected = false;
    f.ctx.document.activeElement = f.ctx.document.body;
  } });
  const previousQuery = f.ctx.$, previousAll = f.ctx.$$;
  f.ctx.$ = (selector, scope) => selector === '.email-integration' ? currentSection
    : selector === 'form.integration__editor' || selector === 'form:not(.integration__editor)' ? { replaceWith(form) { replacements.push([selector, form]); } }
    : previousQuery(selector, scope);
  f.ctx.$$ = (selector, scope) => selector === 'form[data-action="email-settings-form"]' ? [senderForm, f.form] : previousAll(selector, scope);
  f.ctx.UI.menu = { kind: 'unrelated custom menu' };
  const disconnecting = f.run("runEmailIntegrationAction('disconnect')");
  f.requests[0].resolve({ state: 'synthetic' }); await disconnecting;
  assert.deepEqual(replacements, [['form.integration__editor', senderForm], ['form:not(.integration__editor)', f.form]], 'both dirty email forms preserve their exact DOM');
  assert.equal(f.form.elements.key.value, 'synthetic-only'); assert.equal(disclosure.open, true);
  assert.equal(f.ctx.document.activeElement, f.form.elements.key); assert.equal(f.ctx.UI.emailEdit, true);
  assert.equal(f.ctx.UI.menu.kind, 'unrelated custom menu'); assert.equal(f.renders, 0);
}
console.log('PASS: admin saves await confirmation, preserve failed drafts, avoid unrelated renders, report delivery truthfully, and keep sender changes local');
console.log('PASS: compact AI connection row, explicit configuration, custom model menus, local cancel, saved-config tests, and inline connection errors');
console.log('PASS: member actions await confirmation, coalesce overlapping changes, retain drafts on failure, guard authorization, and avoid late editor repaint');
console.log('PASS: email test/disconnect timeout recovery, request coalescing, original recipient, route guards, and dirty sender/key form preservation');
