// Exercise the actual archive render hook with delayed synthetic responses.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/client/ui2.js', import.meta.url), 'utf8');
const hook = source.slice(source.indexOf('  // Opening one archive pulls its rows once.'),
  source.indexOf("  $$('.video-embed__face').forEach(mountVideoMeta);"));
const requests = [];
let renders = 0;
const context = vm.createContext({
  REMOTE: {}, UI: { route: { name: 'interest' }, interestArchiveView: { id: 'synthetic-a', loading: true } },
  api(url) { return new Promise((resolve, reject) => requests.push({ url, resolve, reject })); },
  render() { renders++; vm.runInContext(hook, context); },
});
vm.runInContext(source.slice(source.indexOf('function renderBackground('), source.indexOf('function render()')), context);
const render = () => vm.runInContext(hook, context);
const settle = () => new Promise((resolve) => setImmediate(resolve));

render(); render(); render();
assert.equal(requests.length, 1, 'rerenders do not duplicate a pending archive download');
assert.equal(context.UI.interestArchiveView.loading, 'pending');
requests[0].resolve({ archive: { id: 'synthetic-a', rows: [] } }); await settle();
assert.equal(renders, 1); assert.equal(requests.length, 1);
assert.equal(context.UI.interestArchiveView.archive.id, 'synthetic-a');

context.UI.interestArchiveView = { id: 'synthetic-b', loading: true }; render();
context.UI.interestArchiveView = null;
requests[1].resolve({ archive: { id: 'synthetic-b', rows: [] } }); await settle();
assert.equal(context.UI.interestArchiveView, null, 'an old response does not reopen an archive after navigating back');
assert.equal(renders, 1);

context.UI.interestArchiveView = { id: 'synthetic-c', loading: true }; render();
requests[2].reject(new Error('Synthetic unavailable archive')); await settle();
assert.equal(context.UI.interestArchiveView.error, true);
render(); assert.equal(requests.length, 3, 'error state does not cause a retry loop');
context.UI.interestArchiveView = { id: 'synthetic-d', loading: true }; render();
context.UI.modal = { kind: 'interest-row', id: 'synthetic-person' };
const before = renders;
requests[3].resolve({ archive: { id: 'synthetic-d', rows: [] } }); await settle();
assert.equal(renders, before, 'late archive data must not remount a live comment dialog');
assert.equal(context.UI.interestArchiveView.archive.id, 'synthetic-d');
console.log('archive load tests passed: one pending request, navigation guard, stable error state');
