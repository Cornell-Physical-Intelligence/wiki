import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/client/ai.js', import.meta.url), 'utf8');
const period = { costMicros: 240000, reservedMicros: 1000, uncertainMicros: 2000, requests: 42 };
const usage = { startedAt: Date.parse('2026-09-01T00:00:00Z'), current: period, today: period,
  limits: { monthMicros: 5000000, dayMicros: 1000000 }, paused: false, halted: false };
function fixture() {
  const pending = [], timers = new Map(), host = { innerHTML: '' }, document = { body: {}, activeElement: null, hidden: false };
  const key = { value: 'unsaved synthetic key' }, refresh = { disabled: false, focus() { document.activeElement = this; } };
  let nextTimer = 0;
  const ctx = vm.createContext({ UI: { route: { name: 'integrations' } }, Store: { isAdmin: () => true }, REMOTE: {}, AbortSignal, document,
    MD: { esc: (s) => String(s).replaceAll('<', '&lt;') },
    $: (selector) => selector === '[data-ai-usage]' ? host : selector === '[data-action="ai-usage-refresh"]' ? refresh : key,
    setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout(id) { timers.delete(id); },
    api: (...args) => new Promise((resolve, reject) => pending.push({ args, resolve, reject })),
    render() { throw new Error('Usage must not remount any form'); },
  });
  document.activeElement = key;
  return { ctx, host, key, refresh, document, pending, timers, run(code) { return vm.runInContext(code, ctx); } };
}

test('usage refresh updates only its readout, preserves drafts/focus, and coalesces requests', async () => {
  const f = fixture(); f.run(source);
  assert.equal(f.run('aiMoney(45)'), '$0.000045', 'a real sub-cent charge never appears as zero');
  const loading = f.run('loadAiUsage()');
  await f.run('loadAiUsage()');
  assert.equal(f.pending.length, 1); assert.equal(f.pending[0].args[0], '/ai/usage');
  assert.ok(f.pending[0].args[1].signal instanceof AbortSignal);
  assert.equal(f.refresh.disabled, true);
  f.pending[0].resolve({ usage }); await loading;
  assert.equal(f.key.value, 'unsaved synthetic key'); assert.equal(f.document.activeElement, f.key);
  assert.equal(f.refresh.disabled, false);
  assert.match(f.host.innerHTML, /\$0\.243/); assert.match(f.host.innerHTML, /\$5\.00/); assert.match(f.host.innerHTML, /\$1\.00/);
  assert.match(f.host.innerHTML, /42 requests · \$0\.003 held/); assert.match(f.host.innerHTML, /Sep 1, 2026/);
  assert.equal((f.host.innerHTML.match(/role="meter"/g) || []).length, 2);
  f.document.activeElement = f.refresh;
  const second = f.run('loadAiUsage()'); f.document.activeElement = f.document.body;
  f.pending[1].resolve({ usage }); await second;
  assert.equal(f.document.activeElement, f.refresh, 'keyboard refresh restores focus after disabling');
});

test('failed refresh retains the last known spend and late responses cannot repaint an editor', async () => {
  const f = fixture(); f.run(source); f.ctx.UI.aiUsage = usage;
  const failed = f.run('loadAiUsage()'); f.pending[0].reject(new Error('Offline')); await failed;
  assert.match(f.host.innerHTML, /\$0\.243/); assert.match(f.host.innerHTML, /Usage could not refresh/);
  const previous = f.host.innerHTML, late = f.run('loadAiUsage()');
  f.ctx.UI.route.name = 'edit'; f.ctx.UI.editor = { dirty: true };
  f.pending[1].resolve({ usage: { ...usage, paused: true } }); await late;
  assert.equal(f.host.innerHTML, previous); assert.equal(f.key.value, 'unsaved synthetic key');
  const empty = fixture(); empty.run(source);
  assert.doesNotMatch(empty.run('viewAiUsage()'), /\$0\.00/, 'unknown usage is never presented as zero spend');
});

test('usage polls only for a visible admin settings page, and paused state explains editing stays available', async () => {
  const f = fixture(); f.run(source);
  f.document.hidden = true; f.run('syncAiUsage()'); assert.equal(f.pending.length, 0); assert.equal(f.timers.size, 0);
  f.document.hidden = false; f.ctx.Store.isAdmin = () => false; f.run('syncAiUsage()'); assert.equal(f.pending.length, 0);
  f.ctx.Store.isAdmin = () => true; f.run('syncAiUsage()'); assert.equal(f.pending.length, 1); assert.equal(f.timers.size, 1);
  f.pending[0].resolve({ usage }); await new Promise(setImmediate);
  f.run('syncAiUsage()'); assert.equal(f.pending.length, 1, 'fresh data is not refetched on every render');
  f.ctx.UI.route.name = 'page'; f.run('syncAiUsage()'); assert.equal(f.timers.size, 0);
  f.ctx.UI.aiUsage = { ...usage, paused: true };
  assert.match(f.run('viewAiUsage()'), /AI paused at the spending limit/);
  assert.match(f.run('viewAiUsage()'), /Editing and saving remain available/);
  f.ctx.UI.aiUsage.halted = true;
  assert.match(f.run('viewAiUsage()'), /provider usage needs review/);
});
