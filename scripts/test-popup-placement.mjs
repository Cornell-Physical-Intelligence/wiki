// Geometry-only regressions using synthetic sizes, not browser or member data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const ui2 = await readFile(new URL('../src/client/ui2.js', import.meta.url), 'utf8');
const ui3 = await readFile(new URL('../src/client/ui3.js', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/client/main.js', import.meta.url), 'utf8');
const autocomplete = ui2.slice(ui2.indexOf('function edAutocomplete('), ui2.indexOf('\nfunction edAcceptAc('));
const preview = ui3.slice(ui3.indexOf('let previewPop ='), ui3.indexOf('/* --------------------------- sortable tables'));

function surface(width, height) {
  return { style: {}, hidden: true, remove() {},
    get offsetWidth() { return Math.min(width, parseFloat(this.style.maxWidth) || Infinity); },
    get offsetHeight() { return Math.min(height, parseFloat(this.style.maxHeight) || Infinity); },
  };
}
function complete(options = {}) {
  const pop = surface(options.popupWidth || 500, options.popupHeight || 260);
  const ta = { value: 'a soft-wrapped line [[', selectionStart: 21, scrollTop: 0,
    getBoundingClientRect: () => ({ left: options.left ?? 30, top: options.top ?? 80 }) };
  ta.selectionStart = ta.value.length;
  let measuredCaret = false;
  const context = vm.createContext({
    $: () => pop, Store: { s: { pages: [{ title: 'Synthetic page' }] } },
    MD: { esc: (s) => s }, I: { page: '<svg></svg>' },
    window: { visualViewport: options.viewport }, innerWidth: options.width || 1200, innerHeight: options.height || 800,
    getComputedStyle: () => ({ paddingTop: '26px', paddingLeft: '40px', borderTopWidth: '0px' }),
    taTextY(_input, position) { assert.equal(position, ta.selectionStart); measuredCaret = true; return options.caret || { top: 260, bottom: 282 }; },
    ta,
  });
  vm.runInContext(autocomplete, context);
  vm.runInContext('edAutocomplete(ta)', context);
  assert.equal(measuredCaret, true, 'Wrapped text must use the measured caret row');
  assert.equal(pop.hidden, false);
  assert.equal(pop.style.visibility, '');
  return pop;
}
function inside(pop, viewport, margin) {
  const x = parseFloat(pop.style.left), y = parseFloat(pop.style.top);
  assert.ok(x >= (viewport.offsetLeft || 0) + margin);
  assert.ok(y >= (viewport.offsetTop || 0) + margin);
  assert.ok(x + pop.offsetWidth <= (viewport.offsetLeft || 0) + viewport.width - margin);
  assert.ok(y + pop.offsetHeight <= (viewport.offsetTop || 0) + viewport.height - margin);
}

test('autocomplete measures long choices and clamps their right edge', () => {
  const pop = complete({ left: 1060 });
  inside(pop, { width: 1200, height: 800 }, 10);
  assert.equal(parseFloat(pop.style.top), 394, 'Popup follows the soft-wrapped caret rather than newline count');
});

test('autocomplete fits above the caret in a keyboard-sized visual viewport', () => {
  const viewport = { width: 320, height: 260, offsetTop: 300, offsetLeft: 0 };
  const pop = complete({ viewport, top: 350, caret: { top: 60, bottom: 82 } });
  inside(pop, viewport, 10);
  assert.ok(parseFloat(pop.style.top) + pop.offsetHeight <= 430, 'Choices remain above the caret with a gap');
  assert.equal(pop.style.overflowY, 'auto', 'Long lists can scroll within the available side');
});

test('autocomplete remains reachable in a short landscape viewport', () => {
  const pop = complete({ width: 320, height: 140, top: 40, caret: { top: 24, bottom: 46 } });
  inside(pop, { width: 320, height: 140 }, 10);
  assert.ok(pop.offsetHeight < 260, 'The list contracts to the available vertical space');
});

test('hover previews cannot flip above the viewport or overflow its right edge', () => {
  const listeners = {}, timers = [], pop = surface(700, 400);
  const viewport = { width: 390, height: 180, offsetLeft: 30, offsetTop: 40 };
  const link = { closest: () => null, getAttribute: () => '#/page/synthetic', getBoundingClientRect: () => ({ left: 350, top: 65, bottom: 85 }) };
  const context = vm.createContext({
    document: { addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, createElement: () => pop, body: { appendChild() {} } },
    window: { visualViewport: viewport }, innerWidth: 1000, innerHeight: 800,
    matchMedia: () => ({ matches: true }), UI: {},
    Store: { page: () => ({ title: 'Synthetic preview', body: 'Synthetic text', section: 'synthetic' }), userName: () => 'Synthetic' },
    MD: { esc: (s) => s, mdToText: (s) => s }, SECTIONS: [], relTime: () => 'today',
    setTimeout(fn) { timers.push(fn); }, clearTimeout() {},
  });
  vm.runInContext(preview, context);
  listeners.pointerover[0]({ target: { closest: () => link } });
  timers[0]();
  inside(pop, viewport, 8);
});

test('expanding a save preview preserves its top and fits the remaining viewport', () => {
  const veil = { clientHeight: 720, style: {} };
  const dialog = { offsetHeight: 264, style: {}, closest: () => veil,
    getBoundingClientRect() { throw new Error('Entry transforms must not affect the layout anchor'); } };
  const context = vm.createContext({ UI: { modal: { kind: 'save-summary' } }, innerHeight: 720, dialog });
  vm.runInContext(main.slice(main.indexOf('function anchorSaveDialog'), main.indexOf('function closeModal')), context);
  vm.runInContext('anchorSaveDialog(dialog)', context);
  assert.equal(veil.style.paddingTop, '228px');
  dialog.offsetHeight = 500;
  vm.runInContext('anchorSaveDialog(dialog)', context);
  assert.equal(veil.style.paddingTop, '228px', 'Details expand down, without recentering');
  assert.equal(dialog.style.maxHeight, '472px', 'Long changes remain inside the viewport');
});
