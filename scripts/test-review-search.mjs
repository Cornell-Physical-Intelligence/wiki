// Adversarial regressions using synthetic UI state only; no network or credentials.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/client/search.js', import.meta.url), 'utf8');
function fixture() {
  const listeners = {};
  const timers = new Map();
  let timerId = 0;
  const input = { value: '', focus() {}, setAttribute() {}, removeAttribute() {} };
  const home = {};
  const palette = {};
  const context = vm.createContext({
    console,
    document: { activeElement: null, hidden: false, addEventListener(type, listener) { (listeners[type] ||= []).push(listener); } },
    UI: { route: { name: 'home', params: {} }, navOpen: true, palette: null },
    Store: { me: () => ({ email: 'synthetic@example.test' }), s: { pages: [] }, prefs: () => ({ recents: [] }) },
    MD: { esc: (s) => String(s), mdToText: (s) => s },
    I: {}, SECTIONS: [],
    render() {},
    $: (selector, scope) => selector === '.search-home' ? home : selector === '.search-palette' ? palette : selector === 'input' ? input : null,
    $$: () => [],
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(source, context);
  return { context, listeners, timers, input, home, palette, run: (code) => vm.runInContext(code, context) };
}

test('mobile Search closes navigation before focusing the home search', () => {
  const { context, run } = fixture();
  run('openPalette()');
  assert.equal(context.UI.navOpen, false, 'The input cannot remain behind the navigation scrim');
});

test('Escape cancelling an IME candidate leaves the search palette open', () => {
  const { context, listeners } = fixture();
  context.UI.palette = { q: '日本', sel: 0, filters: {}, composing: true };
  let prevented = false;
  const event = { key: 'Escape', isComposing: true, target: { closest: () => null, matches: () => true },
    preventDefault() { prevented = true; }, stopImmediatePropagation() {} };
  listeners.keydown[0](event);
  assert.ok(context.UI.palette, 'IME cancellation must not dismiss search');
  assert.equal(prevented, false, 'The input method owns this Escape');
});

test('search over an editor keeps meaning search and the palette keyboard trap', () => {
  const { context, listeners, timers, input, palette, run } = fixture();
  context.UI.editor = { pageId: 'sample' };
  context.UI.palette = { q: 'power', sel: 0, filters: {} };
  context.REMOTE = {};
  context.AbortController = AbortController;
  run("scheduleMeaningSearch('modal')");
  assert.equal(timers.size, 1, 'Visible search must not wait forever because an editor is underneath');
  Object.assign(input, { disabled: false, hidden: false, offsetParent: {}, focus() { context.document.activeElement = this; } });
  const last = { disabled: false, hidden: false, offsetParent: {}, closest: () => null, matches: () => false };
  palette.contains = (element) => element === input || element === last;
  context.$$ = () => [input, last];
  context.document.activeElement = last;
  let prevented = false;
  listeners.keydown[0]({ key: 'Tab', target: last, preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
  assert.equal(prevented, true);
  assert.equal(context.document.activeElement, input, 'Tab wraps inside search while the editor remains inert');
});

test('an exact title remains the first result after semantic completion', () => {
  const { context, run } = fixture();
  context.Store.s.pages = [
    { id: 'power', title: 'Power', section: 'electrical', body: 'Power distribution reference', tags: [], updated: 1 },
    { id: 'bringup', title: 'Bring-up checklist', section: 'electrical', body: 'Power-on checks', tags: [], updated: 2 },
  ];
  context.UI.palette = { q: 'Power', sel: 0, filters: {} };
  assert.equal(run('paletteResults().items[0].page.id'), 'power');
  run("UI.palette.meaning = { key: searchMeaningKey(UI.palette), available: true, ids: ['bringup'] }");
  assert.equal(run('paletteResults().items[0].page.id'), 'power', 'A deterministic exact match should not jump after the provider answers');
});

test('result replacement waits until the pointer activation completes', () => {
  const { context, listeners, timers, palette, run } = fixture();
  context.UI.palette = { q: 'power', sel: 0, filters: {} };
  let paints = 0;
  const list = { set innerHTML(value) { paints++; } };
  context.$ = (selector) => selector === '.search-palette' ? palette : selector === '.search-list' ? list : null;
  const result = { closest: () => ({ dataset: { searchMode: 'modal' } }) };
  const pointer = { pointerId: 4, target: { closest: (selector) => selector === '[data-search-page]' ? result : null } };
  for (const listener of listeners.pointerdown) listener(pointer);
  run("renderSearchList('modal')");
  assert.equal(paints, 0, 'A pressed result keeps its original DOM node');
  listeners.pointerup[0](pointer);
  assert.equal(paints, 0, 'pointerup must not remove the target before click');
  for (const [id, flush] of [...timers]) { timers.delete(id); flush(); }
  assert.equal(paints, 1, 'The pending result update paints after activation');
});

test('pointer-hovered choices retain their order when semantic search completes', async () => {
  const { context, listeners, palette, run } = fixture();
  context.REMOTE = {};
  context.AbortController = AbortController;
  context.AbortSignal = AbortSignal;
  context.Store.s.pages = [
    { id: 'power', title: 'Power reference', section: 'electrical', body: 'Power distribution reference', tags: [], updated: 1 },
    { id: 'bringup', title: 'Bring-up checklist', section: 'electrical', body: 'Power-on checks', tags: [], updated: 2 },
  ];
  context.UI.palette = { q: 'power', sel: 0, filters: {} };
  context.$ = (selector) => selector === '.search-palette' ? palette : null;
  const list = { closest: () => ({ dataset: { searchMode: 'modal' } }) };
  listeners.pointerover[0]({ target: { closest: () => list } });
  const original = Array.from(run('paletteResults().items'), (item) => item.page.id);
  context.api = async () => ({ available: true, ids: ['bringup'] });
  run("renderSearchList = () => {}; scheduleMeaningSearch('modal')");
  await run("searchByMeaning('modal', searchMeaningWork.get('modal'))");
  assert.deepEqual(Array.from(run('paletteResults().items'), (item) => item.page.id), original);
});

test('article table headers expose native buttons and announce each sort direction', async () => {
  const listeners = {};
  const attributes = new Map();
  const inlineLabel = { nodeName: 'EM', textContent: 'Voltage' };
  const rows = ['10', '2', '1'].map((value) => ({ cells: [{ textContent: value }] }));
  const tbody = { rows, appendChild(row) { this.rows.splice(this.rows.indexOf(row), 1); this.rows.push(row); } };
  let button;
  const header = {
    textContent: 'Voltage', firstChild: inlineLabel, dataset: {},
    setAttribute: (name, value) => attributes.set(name, value),
    querySelector: (selector) => selector === '[data-table-sort]' ? button || null : null,
    appendChild(node) { button = node; },
  };
  header.parentNode = { children: [header] };
  const table = { tBodies: [tbody], querySelectorAll: () => [header] };
  header.closest = (selector) => selector === 'table' ? table : null;
  const thumbnailHeader = {
    closest: (selector) => selector === '.tpl__thumb' ? {} : null,
    querySelector() { assert.fail('Decorative template tables must not gain sorting controls'); },
  };
  let nativeButtonCount = 0;
  const context = vm.createContext({
    Store: {}, UI: {}, $$: () => [thumbnailHeader, header],
    document: {
      addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
      createElement(tag) {
        assert.equal(tag, 'button'); nativeButtonCount++;
        return { dataset: {}, style: {}, children: [], attributes: new Map(),
          setAttribute(name, value) { this.attributes.set(name, value); },
          appendChild(node) { this.children.push(node); header.firstChild = null; },
          closest: (selector) => selector === '.prose th' ? header : null,
        };
      },
    },
  });
  vm.runInContext(await readFile(new URL('../src/client/ui3.js', import.meta.url), 'utf8'), context);
  vm.runInContext('mountTableSort(); mountTableSort()', context);
  assert.equal(nativeButtonCount, 1, 'Repeated mounts do not nest buttons');
  assert.equal(button.type, 'button', 'Native button supplies Enter and Space activation');
  assert.equal(button.children[0], inlineLabel, 'Existing inline header markup is preserved');
  assert.equal(attributes.get('scope'), 'col');
  assert.equal(attributes.get('aria-sort'), 'none');
  listeners.click[0]({ target: button });
  assert.deepEqual(rows.map((row) => row.cells[0].textContent), ['1', '2', '10']);
  assert.equal(attributes.get('aria-sort'), 'ascending');
  assert.equal(button.attributes.get('aria-label'), 'Voltage, sort descending');
  listeners.click[0]({ target: button });
  assert.deepEqual(rows.map((row) => row.cells[0].textContent), ['10', '2', '1']);
  assert.equal(attributes.get('aria-sort'), 'descending');
  assert.equal(button.attributes.get('aria-label'), 'Voltage, sort ascending');
  // Headers can contain wiki links. Preserve the link as its own control and
  // make the column heading keyboard sortable without nesting a link/button.
  button = undefined;
  header.querySelector = (selector) => selector === '[data-table-sort]' ? null : { nodeName: 'A' };
  header.matches = (selector) => selector === '[data-table-sort-header]';
  vm.runInContext('mountTableSort()', context);
  assert.equal(nativeButtonCount, 1, 'Interactive header content is not nested in a new button');
  assert.equal(header.tabIndex, 0);
  let prevented = false;
  listeners.keydown[0]({ key: 'Enter', target: header, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(attributes.get('aria-sort'), 'ascending');
  assert.deepEqual(rows.map((row) => row.cells[0].textContent), ['1', '2', '10']);
});
