// Adversarial editor fixtures: controlled requests, synthetic pages and DOM.
// No network, production state, credentials or browser storage are accessed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { applyOp } from '../lib/ops.js';

const ui = await readFile(new URL('../src/client/ui2.js', import.meta.url), 'utf8');
const remote = await readFile(new URL('../src/remote.js', import.meta.url), 'utf8');
const editorHelpers = ui.slice(ui.indexOf('function editorDraft'), ui.indexOf('// [[ autocomplete'));
const commit = ui.slice(ui.indexOf('function edSummaryValue'), ui.indexOf('/* ------------------------------- history'));
const transport = remote.slice(remote.indexOf('async function requestMutation'), remote.indexOf('// Invites need'));
const settle = () => new Promise((resolve) => setImmediate(resolve));

function editorFixture({ isNew = true, current = null } = {}) {
  const calls = [], uploads = [], toasts = [], navigations = [];
  let renders = 0, serial = 0;
  const e = { pageId: isNew ? null : 'page', isNew, title: 'Draft title', body: 'My text', section: 'electrical',
    origBody: 'Original text', origTitle: 'Draft title', origSection: 'electrical', baseUpdated: 1, dirty: true };
  const field = { value: e.body, selectionStart: 2, selectionEnd: 2, scrollTop: 80, disabled: false, isConnected: true,
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    focus() { context.document.activeElement = this; } };
  const button = { disabled: false, textContent: 'Save' }, status = { hidden: true, textContent: '' };
  const surface = { setAttribute() {} };
  const existing = current || { id: 'page', title: 'Draft title', body: 'Original text', section: 'electrical', updated: 1, updatedBy: 'other' };
  const Store = {
    lastPersistOk: true, page: () => existing, userName: () => 'Another member',
    createPage(args) { return new Promise((resolve, reject) => calls.push({ op: 'create', args, resolve, reject })); },
    savePage(id, args) { return new Promise((resolve, reject) => calls.push({ op: 'save', id, args, resolve, reject })); },
    addAttachment(file) { return new Promise((resolve, reject) => uploads.push({ file, resolve, reject })); },
  };
  const context = vm.createContext({
    UI: { editor: e, modal: { kind: 'save-summary' } }, REMOTE: {}, Store,
    draftStash: new Map(), draftDeleted: new Set(), persistDrafts() {},
    document: { activeElement: field },
    $: (selector) => selector === '[data-ed="body"]' ? field : selector.includes('save-commit') ? button : selector.includes('save-summary__status') ? status : surface,
    $$: () => [field, button],
    MD: { esc: (s) => s, fmtSize: () => '1 KB' }, relTime: () => 'just now',
    uid: () => 'page-synthetic-' + ++serial,
    showModal(m) { context.UI.modal = m; }, toast(message, action) { toasts.push({ message, action }); },
    nav(hash) { navigations.push(hash); }, route() {}, render() { renders++; },
    edType(target, text) {
      target.value = target.value.slice(0, target.selectionStart) + text + target.value.slice(target.selectionEnd);
      context.UI.editor.body = target.value;
    },
  });
  vm.runInContext(editorHelpers + commit, context);
  return { context, e, field, button, status, calls, uploads, toasts, navigations,
    run: (code) => vm.runInContext(code, context), get renders() { return renders; } };
}

test('a failed create retains its editor and durable draft without claiming success', async () => {
  const f = editorFixture();
  const work = f.run("edCommit('Created a page')");
  assert.equal(f.calls.length, 1);
  assert.equal(f.context.UI.editor, f.e);
  assert.equal(f.e.saving, true);
  assert.equal(f.context.draftStash.get('new').body, 'My text');
  assert.ok(f.calls[0].args.requestId, 'create receives a stable retry token');
  assert.equal(f.toasts.length, 0, 'no premature Page created toast');
  f.calls[0].reject(Object.assign(new Error('Temporarily unavailable'), { status: 503 }));
  await work;
  assert.equal(f.context.UI.editor, f.e);
  assert.equal(f.e.saving, false);
  assert.equal(f.field.disabled, false);
  assert.equal(f.context.draftStash.get('new').body, 'My text');
  assert.equal(f.renders, 0, 'failure never remounts the editor');
  assert.equal(f.status.textContent, 'Temporarily unavailable');
  assert.doesNotThrow(() => f.toasts.at(-1).action.run(), 'draft recovery uses an existing route');
});

test('repeated Save waits for one write and navigates to the canonical created ID', async () => {
  const f = editorFixture();
  const first = f.run("edCommit('Create')");
  await f.run("edCommit('Repeated click')");
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve({ id: 'canonical-server-id' });
  await first;
  assert.deepEqual(f.navigations, ['#/page/canonical-server-id']);
  assert.equal(f.context.draftStash.size, 0);
  assert.equal(f.context.UI.editor, null);
  assert.equal(f.toasts.at(-1).message, 'Page created');
});

test('saving an empty summary commits the suggestion while manual text takes precedence', async () => {
  for (const [typed, suggested, expected] of [
    ['', 'Changed the sensor supply to 3.3V', 'Changed the sensor supply to 3.3V'],
    ['  A hand-written summary  ', 'Generated suggestion', 'A hand-written summary'],
    ['', '', 'Created Draft title'],
  ]) {
    const f = editorFixture();
    Object.assign(f.context.UI.modal, { suggestedSummary: suggested, preview: { fallback: 'Created Draft title' } });
    f.context.summaryInput = typed;
    const work = f.run('edCommit(edSummaryValue(summaryInput))');
    assert.equal(f.calls[0].args.summary, expected);
    f.calls[0].resolve({ id: 'created' }); await work;
  }
});

test('an unchanged retry keeps its creation token; an edited draft gets a fresh token', async () => {
  const f = editorFixture();
  const first = f.run("edCommit('Create')");
  f.calls[0].reject(new Error('Offline')); await first;
  const token = f.calls[0].args.requestId;
  assert.equal(f.context.draftStash.get('new').createRequestId, token);
  const retry = f.run("edCommit('Retry')");
  assert.equal(f.calls[1].args.requestId, token);
  f.calls[1].reject(new Error('Offline')); await retry;
  f.e.body += ' More text';
  assert.equal(f.run('editorDraft(UI.editor).createRequestId'), undefined, 'autosave cannot associate changed text with an earlier create');
  const edited = f.run("edCommit('Changed draft')");
  assert.notEqual(f.calls[2].args.requestId, token);
  f.calls[2].resolve({ id: 'created' }); await edited;
});

test('explicit conflict replacement acknowledges the shown revision, including metadata', async () => {
  const f = editorFixture({ isNew: false, current: { id: 'page', title: 'A newer title', body: 'Original text', section: 'software', updated: 2, updatedBy: 'other' } });
  await f.run("edCommit('Update')");
  assert.equal(f.context.UI.modal.kind, 'conflict');
  assert.equal(f.calls.length, 0);
  f.context.UI.modal.onGo();
  assert.equal(f.calls[0].args.baseUpdated, 2, 'replacement acknowledges exactly the shown canonical revision');
  f.calls[0].resolve({ id: 'page' }); await settle();
  assert.equal(f.context.UI.editor, null);
});

test('pending attachments block Save and insert without stealing focus', async () => {
  const f = editorFixture();
  const title = { isConnected: true, focus() { f.context.document.activeElement = this; } };
  const work = f.run("edHandleFiles([{name:'drawing.pdf'}])");
  assert.equal(f.e.uploads, 1);
  await f.run("edCommit('Create')");
  assert.equal(f.calls.length, 0);
  f.context.document.activeElement = title;
  f.uploads[0].resolve({ id: 'drawing', type: 'application/pdf', size: 1024 }); await work;
  assert.equal(f.e.uploads, 0);
  assert.match(f.e.body, /att:drawing/);
  assert.equal(f.context.document.activeElement, title);
  assert.equal(f.field.scrollTop, 80);
});

test('upload completion can update only its unchanged originating draft', async () => {
  for (const discard of [false, true]) {
    const f = editorFixture({ isNew: false });
    const work = f.run("edHandleFiles([{name:'A.pdf'}])");
    const next = { pageId: 'other', body: 'Page B text', title: 'Other' };
    f.context.UI.editor = next;
    if (discard) f.context.draftStash.delete('page');
    f.uploads[0].resolve({ id: 'file-a', type: 'application/pdf', size: 1024 }); await work;
    assert.equal(next.body, 'Page B text');
    if (discard) assert.equal(f.context.draftStash.has('page'), false, 'discarded drafts are not resurrected');
    else assert.match(f.context.draftStash.get('page').body, /att:file-a/);
  }
});

function transportFixture() {
  const calls = []; let renders = 0;
  const Store = { s: { pages: [] }, me: () => ({ email: 'synthetic@example.test' }) };
  for (const name of ['toggleTask', 'restoreRev', 'deletePage', 'restorePage', 'purgePage', 'movePage', 'toggleReaction', 'setProfile', 'setEmailSettings', 'setRole', 'removeUser']) Store[name] = () => ({});
  const context = vm.createContext({ Store, UI: { editor: null, modal: null }, REMOTE: { pending: 0, email: 'synthetic@example.test' }, AbortSignal,
    api(path, options) { return new Promise((resolve, reject) => calls.push({ path, options, resolve, reject })); },
    adoptServer(out) { Store.s = out.state; }, render() { renders++; }, toast() {},
  });
  vm.runInContext(transport, context);
  return { context, calls, run: (code) => vm.runInContext(code, context), get renders() { return renders; } };
}

test('remote page creation is confirmed and returns the server ID without remounting', async () => {
  const f = transportFixture();
  const work = f.run("Store.createPage({title:'Reused title', body:'Body'})");
  assert.equal(f.context.Store.s.pages.length, 0, 'no optimistic page is presented as saved');
  f.calls[0].resolve({ version: 2, state: { pages: [{ id: 'reused-title-server', title: 'Reused title', body: 'Body' }] }, result: { id: 'reused-title-server' } });
  assert.equal((await work).id, 'reused-title-server');
  assert.equal(f.renders, 0);
  assert.equal(f.context.REMOTE.pending, 0);
});

test('a lost creation response is confirmed by its request token, never just a matching title', async () => {
  const f = transportFixture();
  const work = f.run("Store.createPage({title:'A page', body:'Body', requestId:'page-synthetic-token'})");
  f.calls[0].reject(new Error('Connection lost')); await settle();
  assert.equal(f.calls[1].path, '/state');
  f.calls[1].resolve({ version: 2, state: { pages: [{ id: 'created', title: 'A page', owner: 'synthetic@example.test', createRequestId: 'page-synthetic-token' }] } });
  assert.equal((await work).id, 'created');
  assert.equal(f.calls.length, 2, 'confirmation does not repeat the create');
});

test('background mutation completion never remounts an editor, dialog, palette or menu', async () => {
  for (const overlay of ['editor', 'modal', 'palette', 'menu']) {
    const f = transportFixture();
    const work = f.run("sendOp('toggleReaction', {})");
    f.context.UI[overlay] = {};
    f.calls[0].resolve({ version: 2, state: { pages: [] } }); await work;
    assert.equal(f.renders, 0, overlay);
  }
});

const serverState = () => ({ users: [], pages: [{ id: 'page', title: 'New title', body: 'Same body', section: 'software', updated: 2, updatedBy: 'other', revs: [], tags: [] }], trash: [], activity: [] });

test('server detects stale metadata, permits acknowledged replacement and rejects another intervening edit', () => {
  const state = serverState();
  const args = { id: 'page', title: 'Old title', body: 'Same body', section: 'electrical', baseUpdated: 1 };
  assert.match(applyOp(state, 'savePage', args, 'author', 'member').error, /Edit conflict/);
  assert.equal(state.pages[0].title, 'New title');
  assert.equal(applyOp(state, 'savePage', { ...args, baseUpdated: 2 }, 'author', 'member').error, undefined);
  assert.match(applyOp(state, 'savePage', { ...args, title: 'Third title', baseUpdated: 2 }, 'author', 'member').error, /Edit conflict/);
});

test('server creation retries return one canonical page even when its slug is in Trash', () => {
  const state = { users: [], pages: [], trash: [{ id: 'a-page' }], activity: [] };
  const args = { title: 'A page', body: 'Body', section: 'projects', requestId: 'page-synthetic-token' };
  const first = applyOp(state, 'createPage', args, 'author', 'member');
  const retry = applyOp(state, 'createPage', args, 'author', 'member');
  assert.equal(first.error, undefined);
  assert.notEqual(first.result.id, 'a-page');
  assert.equal(retry.result.id, first.result.id);
  assert.equal(state.pages.length, 1);
  assert.equal(state.activity.length, 1);
  assert.match(applyOp(state, 'createPage', args, 'different-author', 'member').error, /title exists/);
});

test('a move advances the revision so an already-open editor cannot silently move it back', () => {
  const state = serverState();
  applyOp(state, 'movePage', { id: 'page', section: 'projects' }, 'other', 'member');
  assert.ok(state.pages[0].updated > 2);
  assert.match(applyOp(state, 'savePage', { id: 'page', title: 'New title', body: 'Same body', section: 'software', baseUpdated: 2 }, 'author', 'member').error, /Edit conflict/);
});
