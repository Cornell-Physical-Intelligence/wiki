// Synthetic state/DOM regressions for shell preservation. No application data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const ui2 = await readFile(new URL('../src/client/ui2.js', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/client/main.js', import.meta.url), 'utf8');
const renderSource = ui2.slice(ui2.indexOf('function render() {'), ui2.indexOf('\nfunction mountTocSpy()'));
const sidebarSource = main.slice(main.indexOf('function syncSidebarInteraction('), main.indexOf('\nfunction mountMenu('));
const closeSource = main.slice(main.indexOf('function closeModal('), main.indexOf('// Opening a dialog over the editor'));

function fixture() {
  const nodes = new Map(), timers = [], frames = [], counts = { appWrites: 0, listPaints: 0 };
  const UI = { route: { name: 'page', params: { id: 'sample' } }, navOpen: false, navHidden: false, editor: null, palette: null, modal: null };
  let forms = [], formActions = [];
  const document = { activeElement: null };
  function node(selector, properties = {}) {
    const n = { selector, isConnected: true, inert: false, children: [], dataset: {}, attrs: {}, scrollTop: 0,
      classList: { contains: () => false, add() {}, remove() {} },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      querySelectorAll: () => [], querySelector: () => null, closest: () => null,
      contains(target) { return this === target || this.children.some((child) => child.contains(target)); },
      focus() { if (this.isConnected) document.activeElement = this; },
      connect(value) { this.isConnected = value; this.children.forEach((child) => child.connect(value)); },
      remove() { this.connect(false); if (nodes.get(this.selector) === this) nodes.delete(this.selector); },
      replaceWith(old) { this.connect(false); old.connect(true); nodes.set(this.selector, old); },
      addEventListener() {}, getBoundingClientRect: () => ({ top: 0 }), ...properties };
    if (selector) nodes.set(selector, n);
    return n;
  }
  document.body = node('body');
  document.activeElement = document.body;
  function makePalette() {
    const input = node(null, { value: UI.palette.q, selectionStart: 2, selectionEnd: 4, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; } });
    const veil = node('.palette-veil', { children: [input], input, rowCount: context.liveResultCount });
    veil.replaceWith = function (old) { this.connect(false); old.connect(true); nodes.set('.palette-veil', old); nodes.set('.palette input', old.input); };
    nodes.set('.palette input', input);
    return veil;
  }
  function makeModal() {
    const body = node('.modal__body');
    return node('.modal-veil', { children: [body] });
  }
  function makeForm(action, dirty = false) {
    const input = node(null, { value: '', selectionStart: 1, selectionEnd: 2 });
    const form = node(null, { dataset: { action, adminDirty: String(dirty) }, children: [input], input });
    form.replaceWith = function (old) { this.connect(false); old.connect(true); forms[forms.indexOf(this)] = old; };
    return form;
  }
  function mountShell() {
    for (const [selector, old] of nodes) if (!['body', '#app'].includes(selector)) old.connect(false);
    for (const old of forms) old.connect(false);
    for (const selector of ['.palette-veil', '.palette input', '.modal-veil', '.modal__body', '.editor', '[data-ed="body"]']) nodes.delete(selector);
    document.activeElement = document.body;
    node('.shell'); node('.main'); node('.sidebar'); node('[data-action="nav-toggle"]');
    node('.sidebar__scroll'); node('.content');
    forms = formActions.map((action) => makeForm(action));
    if (UI.editor) {
      const input = node('[data-ed="body"]');
      node('.editor', { children: [input] });
    }
    if (UI.palette) makePalette();
    if (UI.modal) makeModal();
  }
  document.querySelector = (selector) => {
    if (selector.startsWith('form[data-action=')) return forms.find((form) => selector.includes('"' + form.dataset.action + '"')) || null;
    return nodes.get(selector) || null;
  };
  document.querySelectorAll = (selector) => selector === 'form[data-action]' ? forms : [];
  document.body.insertAdjacentHTML = (_position, html) => {
    if (html.includes('synthetic-palette')) makePalette();
    if (html.includes('synthetic-modal')) makeModal();
  };
  const app = node('#app');
  Object.defineProperty(app, 'innerHTML', { set() { counts.appWrites++; mountShell(); } });
  const context = vm.createContext({ UI, document, window: {}, innerWidth: 1200,
    location: { pathname: '/', search: '', hash: '#/page/sample' },
    Store: { me: () => ({ email: 'synthetic@example.test' }), isAdmin: () => true },
    $: (selector) => document.querySelector(selector), $$: () => [],
    cadCleanups: [], pageReviewEditor: null, summaryEditor: null, liveResultCount: 3,
    CSS: { escape: (text) => text },
    captureModalFocus() {}, mountModalFocus() {}, modalFocusState: null, resolveFocus: () => null,
    viewModal: () => '<synthetic-modal>', viewPalette() { if (UI.palette) UI.palette.count = context.liveResultCount; return UI.palette ? '<synthetic-palette>' : ''; },
    renderSearchList() { counts.listPaints++; const palette = nodes.get('.palette-veil'); if (palette) palette.rowCount = context.liveResultCount; },
    setTimeout(fn) { timers.push(fn); }, requestAnimationFrame(fn) { frames.push(fn); },
  });
  for (const name of ['killPreview', 'cancelPageReview', 'stopMeaningSearch', 'mountHeroTitle', 'mountLoginCard', 'mountSearchHome', 'syncMeaningSearch', 'syncPageReview', 'syncChangeSummary', 'syncAiUsage', 'cancelChangeSummary', 'mountCadViewer', 'mountTableSort', 'mountVideoMeta', 'edUpdatePreview', 'mountBugDrop', 'mountTocSpy', 'viewPage', 'viewAdmin', 'viewSidebar', 'viewEditor', 'viewSearchHome', 'topbar']) context[name] = () => '';
  vm.runInContext(sidebarSource + '\n' + closeSource + '\n' + renderSource, context);
  mountShell();
  return { context, UI, document, nodes, node, timers, frames, counts,
    render: () => vm.runInContext('render()', context), run: (source) => vm.runInContext(source, context),
    setForms(actions) { formActions = actions; forms = actions.map((action) => makeForm(action, true)); return forms; },
    mountShell,
  };
}

test('a mounted editor keeps its native input through dialog and palette transitions', () => {
  const f = fixture();
  f.UI.editor = { pageId: 'sample', _focused: true };
  f.mountShell(); f.UI._mountedEditor = f.UI.editor;
  const input = f.nodes.get('[data-ed="body"]');
  f.UI.palette = { q: 'query' };
  f.render();
  assert.ok(f.nodes.get('.palette-veil'), 'Search opened from editor chrome must actually mount');
  assert.equal(f.nodes.get('.shell').inert, true);
  assert.equal(f.nodes.get('[data-ed="body"]'), input);
  f.UI.palette = null; f.render();
  assert.equal(f.nodes.has('.palette-veil'), false);
  assert.equal(f.nodes.get('.shell').inert, false);
  f.UI.modal = { kind: 'synthetic' }; f.render();
  assert.equal(f.nodes.get('.shell').inert, true);
  f.run('closeModal()'); f.timers.splice(0).forEach((fn) => fn());
  assert.equal(f.nodes.get('.shell').inert, false);
  assert.equal(f.nodes.get('[data-ed="body"]'), input);
  assert.equal(f.counts.appWrites, 0, 'The editor subtree was never replaced');
});

test('hidden navigation and collapsed branches are inert; mobile drawer isolates content', () => {
  const f = fixture();
  const branch = { inert: false };
  f.nodes.get('.sidebar').querySelectorAll = () => [{ classList: { contains: () => true }, querySelector: () => branch }];
  f.context.innerWidth = 390;
  f.run('syncSidebarInteraction()');
  assert.equal(f.nodes.get('.sidebar').inert, true);
  assert.equal(branch.inert, true);
  f.UI.navOpen = true; f.run('syncSidebarInteraction()');
  assert.equal(f.nodes.get('.sidebar').inert, false);
  assert.equal(f.nodes.get('.main').inert, true);
  f.UI.navOpen = false; f.run('syncSidebarInteraction()');
  assert.equal(f.nodes.get('.main').inert, false);
});

test('same-anchor repaint preserves reading position and a different anchor lands once', () => {
  const f = fixture();
  f.UI.route.params.anchor = 'hardware';
  f.node('#hardware', { getBoundingClientRect: () => ({ top: 1000 - f.nodes.get('.content').scrollTop }) });
  f.render(); f.frames.splice(0).forEach((fn) => fn());
  assert.equal(f.nodes.get('.content').scrollTop, 932);
  f.nodes.get('.content').scrollTop = 1400;
  f.render(); f.frames.splice(0).forEach((fn) => fn());
  assert.equal(f.nodes.get('.content').scrollTop, 1400, 'Repaint must not revisit a previously landed anchor');
  f.UI.route.params.anchor = 'software';
  f.node('#software', { getBoundingClientRect: () => ({ top: 2000 - f.nodes.get('.content').scrollTop }) });
  f.render();
  assert.equal(f.nodes.get('.content').scrollTop, 1932);
});

test('dirty admin forms preserve their input values, identity, and focus', () => {
  const f = fixture();
  f.UI.route = { name: 'admin', params: {} }; f.UI._mountedRoute = 'admin';
  const [form] = f.setForms(['synthetic-settings']);
  form.input.value = 'synthetic unsaved value'; form.input.focus();
  f.render();
  const current = f.document.querySelector('form[data-action="synthetic-settings"]');
  assert.equal(current, form);
  assert.equal(current.input.value, 'synthetic unsaved value');
  assert.equal(f.document.activeElement, form.input);
});

test('retained palette keeps the input and caret while refreshing changed results', () => {
  const f = fixture();
  f.UI.palette = { q: 'ab' }; f.mountShell(); f.UI._mountedPalette = f.UI.palette;
  const palette = f.nodes.get('.palette-veil'); palette.input.focus();
  f.context.liveResultCount = 1;
  f.render();
  assert.equal(f.nodes.get('.palette-veil'), palette);
  assert.equal(f.document.activeElement, palette.input);
  assert.deepEqual([palette.input.selectionStart, palette.input.selectionEnd], [2, 4]);
  assert.equal(palette.rowCount, 1, 'Preserving the overlay cannot preserve stale/deleted result rows');
});

test('same-editor modal repaint preserves a scrolled dialog body', () => {
  const f = fixture();
  f.UI.editor = { pageId: 'sample', _focused: true }; f.UI._mountedEditor = f.UI.editor;
  f.UI.modal = { kind: 'synthetic' }; f.UI._shownModal = f.UI.modal;
  f.mountShell();
  f.nodes.get('.modal__body').scrollTop = 350;
  f.render();
  assert.equal(f.nodes.get('.modal__body').scrollTop, 350);
});

test('template thumbnails are decorative and contain no nested links, buttons, or duplicate IDs', async () => {
  const markdown = await readFile(new URL('../src/client/markdown.js', import.meta.url), 'utf8');
  const modalSource = ui2.slice(ui2.indexOf('function viewModal() {'), ui2.indexOf('\n/* ------------------------------- video hydration'));
  const body = '## Agenda\n\n[[Missing page]] and [Reference](https://example.test)\n\n| Item | Owner |\n| --- | --- |\n| Review | Team |\n\n!file[Reference](att:sample)';
  const context = vm.createContext({
    UI: { modal: { kind: 'new-page' } }, I: { x: '×' },
    TEMPLATES: [
      { id: 'blank', name: 'Blank page', desc: 'Start from nothing', body: '' },
      { id: 'meeting', name: 'Meeting notes', desc: 'Agenda, decisions, actions', body },
      { id: 'design', name: 'Design doc', desc: 'Requirements, design, tests', body },
    ],
    ddSections: () => '<span>Projects</span>',
    mdCtx: (options) => ({ ...options, pageByTitle: () => null,
      att: () => ({ id: 'sample', name: 'reference.pdf', type: 'application/pdf', size: 128 }) }),
  });
  vm.runInContext(markdown + '\n' + modalSource, context);
  const html = vm.runInContext('viewModal()', context);
  assert.equal((html.match(/class="tpl__thumb[^\"]*" aria-hidden="true" inert/g) || []).length, 3,
    'Every thumbnail, including the blank option, is hidden from accessibility and focus');
  assert.doesNotMatch(html, /<a\b|\sid=|\shref=/i, 'Preview links and heading IDs do not escape into the live dialog');
  assert.equal((html.match(/<button\b/g) || []).length, 6,
    'Only the three template options and close/cancel/create controls remain buttons');
  let buttonDepth = 0;
  for (const tag of html.match(/<\/?button\b[^>]*>/g) || []) {
    buttonDepth += tag.startsWith('</') ? -1 : 1;
    assert.ok(buttonDepth >= 0 && buttonDepth <= 1, 'Buttons cannot nest inside template choices');
  }
  assert.equal(buttonDepth, 0);
  assert.match(html, /<span class="hlink">/, 'Decorative heading styling is retained');
  assert.match(html, /Agenda, decisions, actions/, 'Useful template structure descriptions stay visible');
  assert.match(html, /data-tpl="blank"[^>]*aria-pressed="true"/, 'The default template is announced as selected');
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  context.UI.modal.tpl = 'design';
  const changed = vm.runInContext('viewModal()', context);
  assert.match(changed, /data-tpl="design"[^>]*aria-pressed="true"/);
  assert.match(changed, /data-tpl="blank"[^>]*aria-pressed="false"/);
  assert.equal((changed.match(/aria-pressed="true"/g) || []).length, 1, 'Exactly one template remains selected');
  const css = await readFile(new URL('../src/client/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.tpl__thumb\s*\{[^}]*pointer-events:\s*none/, 'Pointer clicks belong to the template button');
});
