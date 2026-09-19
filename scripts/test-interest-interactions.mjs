// Real comment handlers and painter against an isolated, stable DOM fixture.
// No network, production data or browser credentials are used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const ui = await readFile(new URL('../src/client/ui2.js', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/client/main.js', import.meta.url), 'utf8');
const painter = ui.slice(ui.indexOf('function interestCommentHtml'), ui.indexOf('function interestRowModalHtml'));
const handler = main.slice(main.indexOf('function acceptInterestReview'), main.indexOf('function confirmInterestRemoval'));
const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function fixture() {
  const first = { id: 'ic-first', text: 'Existing comment', name: 'Reviewer', ts: 1 };
  const row = { id: 'in-one', review: { comments: [first] }, reviewVersion: 1 };
  const draft = { text: 'New <comment>', sending: false }, requests = [], messages = [];
  const document = { body: {}, activeElement: null };
  const field = { value: draft.text, readOnly: false, focus() { document.activeElement = field; } };
  document.activeElement = field;
  const button = {}, error = {}, count = {}, dialog = {};
  const makeNode = (id) => {
    const node = { dataset: { commentId: id }, contains: (el) => el?.owner === node,
      remove() { thread.nodes = thread.nodes.filter((item) => item !== node); if (node.contains(document.activeElement)) document.activeElement = document.body; } };
    const action = (name) => ({ owner: node, dataset: { action: name }, focus() { document.activeElement = this; } });
    node.trigger = action('interest-comment-delete');
    node.controls = { contains: (el) => el?.owner === node && el !== node.trigger, actions: {},
      set innerHTML(html) { if (this.contains(document.activeElement)) document.activeElement = document.body; this.html = html; this.actions = {}; for (const match of html.matchAll(/data-action="([^"]+)"/g)) this.actions[match[1]] = action(match[1]); },
      get innerHTML() { return this.html || ''; } };
    return node;
  };
  const existingNode = makeNode(first.id);
  const thread = { nodes: [existingNode], additions: [], insertAdjacentHTML(position, html) {
    assert.equal(position, 'beforeend');
    this.additions.push(html);
    if (html.includes('interest-thread__empty')) this.empty = { remove: () => { this.empty = null; } };
    for (const match of html.matchAll(/data-comment-id="([^"]+)"/g)) this.nodes.push(makeNode(match[1]));
  } };
  const scroller = { scrollTop: 80, clientHeight: 200, get scrollHeight() { return 400 + thread.nodes.length * 100; } };
  let rowUpdates = 0;
  const ctx = vm.createContext({
    UI: { modal: { kind: 'interest-row', id: row.id }, interest: { rows: [row] } },
    Store: { isAdmin: () => true }, document, crypto: { randomUUID }, AbortSignal,
    MD: { esc }, interestDate: () => 'Today', interestDraft: () => draft,
    interestSource: () => ctx.UI.interest.rows,
    $: (selector, root) => {
      if (selector === '.interest-thread__empty') return thread.empty || null;
      if (selector === '[data-comment-controls]') return root?.controls || null;
      const action = selector.match(/^\[data-action="([^"]+)"\]$/)?.[1];
      if (action) return root?.actions?.[action] || (action === 'interest-comment-delete' ? (root === thread ? thread.nodes[0]?.trigger : root?.trigger) : root?.controls?.actions?.[action]) || null;
      return ({ '.interest-review': dialog, '.interest-thread': thread, '.interest-compose textarea': field,
        '.interest-compose [type="submit"]': button, '[data-comment-error]': error, '.interest-review__body': scroller, '.interest-subhead .count': count })[selector] || null;
    },
    $$: () => thread.nodes,
    api(url, options) { return new Promise((resolve, reject) => requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null, signal: options.signal, resolve, reject })); },
    render() { throw new Error('Comment interaction remounted the app'); },
    renderInterestRows() { rowUpdates++; }, toast: (text) => messages.push(text),
  });
  vm.runInContext(painter + handler, ctx);
  return { ctx, draft, requests, field, button, error, count, thread, existingNode, scroller, messages,
    get rowUpdates() { return rowUpdates; }, run: (source) => vm.runInContext(source, ctx) };
}

{
  const f = fixture(), posting = f.run("postInterestComment('in-one')");
  assert.equal(f.field.readOnly, true); assert.equal(f.button.textContent, 'Posting…');
  assert.equal(f.field.value, 'New <comment>'); assert.equal(f.scroller.scrollTop, 80);
  await f.run("postInterestComment('in-one')");
  assert.equal(f.requests.length, 1, 'repeated submit while pending cannot duplicate a comment');
  const saved = { id: f.requests[0].body.id, text: f.requests[0].body.text, ts: 2, name: 'Reviewer' };
  f.requests[0].resolve({ row: { id: 'in-one', reviewVersion: 2, review: { comments: [{ id: 'ic-first', text: 'Existing comment', ts: 1 }, saved] } } });
  await posting;
  assert.equal(f.field.value, ''); assert.equal(f.field.readOnly, false);
  assert.equal(f.count.textContent, 2); assert.equal(f.thread.nodes[0], f.existingNode, 'existing comments retain their DOM identity');
  assert.equal(f.scroller.scrollTop, 80, 'a reader higher in the thread keeps their position');
  assert.equal(f.thread.additions.length, 1); assert.match(f.thread.additions[0], /New &lt;comment&gt;/);
  assert.equal(f.rowUpdates, 1); assert.equal(f.messages[0], 'Comment posted');
  f.run("paintInterestDiscussion('in-one')");
  assert.equal(f.thread.additions.length, 1, 'repainting cannot duplicate a saved reply');
}
{
  const f = fixture(), posting = f.run("postInterestComment('in-one')");
  f.requests[0].reject(new Error('Offline')); await posting;
  assert.equal(f.field.value, 'New <comment>'); assert.equal(f.field.readOnly, false);
  assert.equal(f.error.hidden, false); assert.match(f.error.textContent, /Offline/);
  assert.equal(f.scroller.scrollTop, 80); assert.equal(f.rowUpdates, 0);
  const retry = f.run("postInterestComment('in-one')");
  assert.equal(f.requests[1].body.id, f.requests[0].body.id, 'a lost response is retried with the same idempotency ID');
  f.ctx.UI.modal = { kind: 'interest-row', id: 'in-another' };
  f.requests[1].resolve({ row: { id: 'in-one', reviewVersion: 2, review: { comments: [{ id: f.requests[1].body.id, text: 'Saved', ts: 2 }] } } });
  await retry;
  assert.equal(f.ctx.UI.modal.id, 'in-another', 'completion never reopens the old dialog');
  assert.equal(f.field.value, 'New <comment>', 'another dialog’s composer is not cleared');
}
{
  const f = fixture(), posting = f.run("postInterestComment('in-one')");
  assert.ok(f.requests[0].signal instanceof AbortSignal, 'a stalled post has a bounded lifetime');
  f.requests[0].reject(Object.assign(new Error('Timed out'), { name: 'TimeoutError' }));
  await posting;
  assert.equal(f.field.readOnly, false); assert.equal(f.draft.sending, false);
  assert.equal(f.draft.text, 'New <comment>'); assert.match(f.error.textContent, /retrying will not post it twice/);
  const retry = f.run("postInterestComment('in-one')");
  assert.equal(f.requests[1].body.id, f.requests[0].body.id);
  f.requests[1].reject(new Error('Offline')); await retry;
}
{
  const f = fixture(), flagging = f.run("toggleInterestFlag('in-one')");
  assert.ok(f.requests[0].signal instanceof AbortSignal);
  await f.run("toggleInterestFlag('in-one')"); assert.equal(f.requests.length, 1, 'pending flag changes cannot be double-submitted');
  f.requests[0].reject(Object.assign(new Error('Timed out'), { name: 'TimeoutError' })); await flagging;
  assert.equal(f.ctx.UI.interestFlagBusy.size, 0, 'a timed-out flag unlocks its control');
  const retry = f.run("toggleInterestFlag('in-one')");
  assert.equal(f.requests[0].body.flagged, true); assert.equal(f.requests[1].body.flagged, true, 'lost-response retries set the same desired flag instead of toggling twice');
  f.requests[1].resolve({ row: { id: 'in-one', reviewVersion: 2, review: { flagged: true, comments: [] } } }); await retry;
  assert.equal(f.ctx.UI.interest.rows[0].review.flagged, true); assert.equal(f.ctx.UI.interestFlagBusy.size, 0);
}
console.log('PASS: comment posts preserve dialog/composer/scroll, append only new comments, escape text, prevent double submits, retain failed drafts and retry IDs, and ignore closed dialogs');

{
  const f = fixture();
  f.run("confirmInterestCommentRemoval('in-one', 'ic-first')");
  assert.equal(f.requests.length, 0, 'opening confirmation does not delete');
  assert.match(f.existingNode.controls.innerHTML, /Delete this comment\?/);
  assert.equal(f.ctx.document.activeElement.dataset.action, 'interest-comment-delete-cancel', 'confirmation initially focuses its safe action');
  assert.equal(f.field.value, 'New <comment>');
  f.run("confirmInterestCommentRemoval('in-one', 'ic-first', true)");
  assert.equal(f.existingNode.controls.innerHTML, '');
  assert.equal(f.ctx.document.activeElement, f.existingNode.trigger, 'Cancel returns focus to the original action');
  assert.equal(f.requests.length, 0);
}
{
  const f = fixture();
  f.run("confirmInterestCommentRemoval('in-one', 'ic-first')");
  f.ctx.document.activeElement = f.existingNode.controls.actions['interest-comment-delete-confirm'];
  const deleting = f.run("deleteInterestComment('in-one', 'ic-first')");
  await f.run("deleteInterestComment('in-one', 'ic-first')");
  assert.equal(f.requests.length, 1, 'double confirmation sends one deletion');
  assert.equal(f.requests[0].method, 'DELETE');
  assert.equal(f.requests[0].url, '/interest/in-one/comments/ic-first');
  assert.ok(f.requests[0].signal instanceof AbortSignal);
  assert.match(f.existingNode.controls.innerHTML, /Deleting…/);
  f.requests[0].resolve({ row: { id: 'in-one', reviewVersion: 2, review: { comments: [], deletedCommentIds: ['ic-first'] } } });
  await deleting;
  assert.equal(f.thread.nodes.length, 0);
  assert.ok(f.thread.empty);
  assert.equal(f.count.textContent, 0);
  assert.equal(f.field.value, 'New <comment>', 'deleting never clears an unsent composer');
  assert.equal(f.draft.text, 'New <comment>');
  assert.equal(f.scroller.scrollTop, 80);
  assert.equal(f.ctx.document.activeElement, f.field, 'deleting the last focused comment returns focus to the composer');
  assert.equal(f.messages.at(-1), 'Comment deleted');
}
{
  const f = fixture();
  f.run("confirmInterestCommentRemoval('in-one', 'ic-first')");
  const deleting = f.run("deleteInterestComment('in-one', 'ic-first')");
  f.requests[0].reject(Object.assign(new Error('Timed out'), { name: 'TimeoutError' })); await deleting;
  assert.equal(f.thread.nodes[0], f.existingNode, 'failed deletion retains the original comment node');
  assert.match(f.existingNode.controls.innerHTML, /Retry to confirm deletion/);
  assert.equal(f.field.value, 'New <comment>');
  const retry = f.run("deleteInterestComment('in-one', 'ic-first')");
  assert.equal(f.requests[1].url, f.requests[0].url, 'deletion retries address the same comment');
  const otherDialog = f.ctx.UI.modal = { kind: 'interest-row', id: 'in-other' };
  f.requests[1].resolve({ row: { id: 'in-one', reviewVersion: 2, review: { comments: [], deletedCommentIds: ['ic-first'] } } });
  await retry;
  assert.equal(f.ctx.UI.modal, otherDialog, 'late completion never reopens the old discussion');
  assert.equal(f.thread.nodes[0], f.existingNode, 'another discussion is not patched');
}
{
  const f = fixture();
  f.ctx.UI.interestArchiveView = { id: 'ar-synthetic' };
  assert.doesNotMatch(f.run("interestCommentHtml({id:'ic-first',name:'Reviewer',text:'Archived',ts:1}, 'in-one', true)"), /interest-comment-delete/);
  f.run("confirmInterestCommentRemoval('in-one', 'ic-first')");
  await f.run("deleteInterestComment('in-one', 'ic-first')");
  assert.equal(f.requests.length, 0, 'archives are read-only');
  f.ctx.UI.interestArchiveView = null; f.ctx.Store.isAdmin = () => false;
  assert.doesNotMatch(f.run("interestCommentHtml({id:'ic-first',text:'Comment',ts:1}, 'in-one')"), /interest-comment-delete/);
  f.run("confirmInterestCommentRemoval('in-one', 'ic-first')");
  await f.run("deleteInterestComment('in-one', 'ic-first')");
  assert.equal(f.requests.length, 0, 'non-admin clients cannot request deletion');
}
console.log('PASS: comment deletion confirms inline, preserves composer/scroll/focus, retries safely, keeps archives read-only and ignores closed discussions');

const mutationHandlers = main.slice(main.indexOf('function refreshInterestAfterRemoval'), main.indexOf("document.addEventListener('click', async"));
function mutationFixture() {
  const requests = [], renders = [], closes = [];
  const ctx = vm.createContext({
    UI: { route: { name: 'interest' }, interest: { rows: [{ id: 'in-one', name: 'One' }, { id: 'in-two', name: 'Two' }] } },
    Store: { isAdmin: () => true }, MD: { esc }, AbortSignal,
    interestVisible: () => ctx.UI.interest?.rows || [],
    api(url, options) { return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })); },
    render() { renders.push(ctx.UI.modal); },
    renderBackground(route) { if (ctx.UI.route.name === route && !ctx.UI.modal && !ctx.UI.editor) renders.push(null); },
    closeModal(after) { closes.push(ctx.UI.modal); ctx.UI.modal = null; after?.(); }, toast() {},
  });
  vm.runInContext(mutationHandlers, ctx);
  return { ctx, requests, renders, closes, run: (code) => vm.runInContext(code, ctx) };
}
{
  const f = mutationFixture(); f.run("confirmInterestRemoval(['in-one'])");
  const remove = f.ctx.UI.modal.onGo; f.ctx.UI.modal = null;
  const pending = remove();
  assert.ok(f.ctx.UI.interestDeleting.has('in-one'));
  await remove(); assert.equal(f.requests.length, 1, 'duplicate confirmations cannot duplicate a pending deletion');
  const discussion = f.ctx.UI.modal = { kind: 'interest-row', id: 'in-two' };
  f.requests[0].resolve({}); await pending;
  assert.equal(f.ctx.UI.modal, discussion); assert.equal(f.renders.length, 1, 'deleting another person never remounts the current discussion');
  assert.equal(f.closes.length, 0); assert.equal(f.ctx.UI.interestDeleting.size, 0);
}
{
  const f = mutationFixture(); f.run("confirmInterestRemoval(['in-one'])");
  const remove = f.ctx.UI.modal.onGo; f.ctx.UI.modal = null;
  const pending = remove(); f.ctx.UI.modal = { kind: 'interest-row', id: 'in-one' };
  f.requests[0].resolve({}); await pending;
  assert.equal(f.ctx.UI.modal, null); assert.equal(f.closes.length, 1, 'a removed submission cannot strand an empty modal');
}
{
  const f = mutationFixture(); f.run('archiveInterestList()');
  const archive = f.ctx.UI.modal.onGo; f.ctx.UI.modal = null;
  archive('Synthetic');
  f.ctx.UI.modal = { kind: 'interest-row', id: 'in-two' };
  f.requests[0].resolve({}); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.ctx.UI.modal, null); assert.equal(f.closes.length, 1); assert.equal(f.ctx.UI.interest, undefined);
  assert.equal(f.ctx.UI.interestArchiving, false);
}
{
  const f = mutationFixture(); f.run('archiveInterestList()');
  const archive = f.ctx.UI.modal.onGo; f.ctx.UI.modal = null;
  archive('Synthetic');
  const other = f.ctx.UI.modal = { kind: 'profile' };
  f.requests[0].resolve({}); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.ctx.UI.modal, other); assert.equal(f.renders.length, 1, 'archive completion preserves unrelated modal DOM');
}
{
  const fallback = ui.slice(ui.indexOf('function interestRowModalHtml'), ui.indexOf('function viewAdmin'));
  const ctx = vm.createContext({ interestSource: () => [], I: { x: '' } });
  vm.runInContext(fallback, ctx);
  assert.match(vm.runInContext("interestRowModalHtml('missing')", ctx), /data-action="modal-close"/, 'a vanished submission always has a close control');
}
console.log('PASS: deferred deletion/archive completions preserve unrelated dialogs, close missing rows, and prevent duplicate removal');
