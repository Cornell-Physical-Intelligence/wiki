// The recruit client (registry, shell, cycle index, Applications panel,
// sections) run whole inside vm against a small tree-based DOM fixture. No
// network, browser, production data or credentials are used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const files = { core: 'recruit-core.js', cycles: 'recruit-cycles.js', forms: 'recruit-forms.js', applications: 'recruit-applications.js' };
const src = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([k, f]) => [k, await read(`../src/client/${f}`)])));
const ui2 = await read('../src/client/ui2.js');
const main = await read('../src/client/main.js');
const ddSource = ui2.slice(ui2.indexOf('function dd('), ui2.indexOf('const ddSections'));
const focusSource = main.slice(main.indexOf('function focusReference('), main.indexOf('function modalFocusables('));
const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);
const unesc = (s) => String(s).replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&#39;', "'").replaceAll('&amp;', '&');

// Marker comments slice each module; every module registers exactly once.
for (const [name, text] of Object.entries(src)) {
  assert.ok(text.includes(`// recruit:${name}:start`) && text.includes(`// recruit:${name}:end`), `${name} carries slice markers`);
  assert.equal((text.match(/RECRUIT\.register\(/g) || []).length, name === 'core' ? 0 : 1, `${name} registers once`);
  assert.doesNotMatch(text, /<select|<datalist/i, `${name} has no native select`);
}

/* ------------------------------- fake DOM -------------------------------- */

const VOID = new Set(['input', 'br', 'hr', 'img', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'meta', 'link', 'use', 'ellipse']);
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const parseAttrs = (s) => [...String(s || '').matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)].map((m) => ({ name: m[1], value: unesc(m[2] ?? m[3] ?? m[4] ?? '') }));

class Text { constructor(text) { this.nodeType = 3; this.text = text; this.parentElement = null; } get textContent() { return this.text; } }

class El {
  constructor(doc, tag) {
    this.doc = doc; this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = {}; this.dataset = {}; this.children = []; this.parentElement = null;
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0;
    const self = this;
    this.classList = {
      list: () => (self.attrs.class || '').split(/\s+/).filter(Boolean),
      contains: (c) => self.classList.list().includes(c),
      add: (c) => { if (!self.classList.contains(c)) self.attrs.class = [...self.classList.list(), c].join(' '); },
      remove: (c) => { self.attrs.class = self.classList.list().filter((x) => x !== c).join(' '); },
      toggle: (c, force) => { (force ?? !self.classList.contains(c)) ? self.classList.add(c) : self.classList.remove(c); },
    };
  }
  get isConnected() { let n = this; while (n) { if (n === this.doc.body) return true; n = n.parentElement; } return false; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  get id() { return this.attrs.id || ''; }
  get className() { return this.attrs.class || ''; } set className(v) { this.attrs.class = v; }
  get hidden() { return this._hidden ?? ('hidden' in this.attrs); } set hidden(v) { this._hidden = Boolean(v); }
  get disabled() { return this._disabled ?? ('disabled' in this.attrs); } set disabled(v) { this._disabled = Boolean(v); }
  get readOnly() { return this._readOnly ?? ('readonly' in this.attrs); } set readOnly(v) { this._readOnly = Boolean(v); }
  get checked() { return this._checked ?? ('checked' in this.attrs); } set checked(v) { this._checked = Boolean(v); }
  get value() { return this._value ?? (this.tagName === 'TEXTAREA' ? this.textContent : (this.attrs.value || '')); } set value(v) { this._value = String(v); }
  get name() { return this.attrs.name || ''; }
  get tabIndex() { return Number(this.attrs.tabindex ?? 0); }
  get offsetParent() { return this.parentElement; }
  get textContent() { return this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { for (const c of this.children) c.parentElement = null; this.children = v === '' ? [] : [Object.assign(new Text(String(v)), { parentElement: this })]; }
  get innerHTML() { return this.children.map((c) => (c.nodeType === 3 ? esc(c.text) : c.outerHTML)).join(''); }
  set innerHTML(h) { if (this.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body; for (const c of this.children) c.parentElement = null; this.children = []; for (const c of parseHtml(h, this.doc)) this.appendChild(c); }
  get outerHTML() { const a = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join(''); const t = this.tagName.toLowerCase(); return VOID.has(t) ? `<${t}${a}>` : `<${t}${a}>${this.innerHTML}</${t}>`; }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  insertAdjacentHTML(pos, h) { const kids = parseHtml(h, this.doc); if (pos === 'afterbegin') { kids.forEach((k) => { k.parentElement = this; }); this.children.unshift(...kids); } else kids.forEach((k) => this.appendChild(k)); }
  remove() { if (this.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body; const p = this.parentElement; if (p) p.children = p.children.filter((c) => c !== this); this.parentElement = null; }
  contains(t) { let n = t; while (n) { if (n === this) return true; n = n.parentElement; } return false; }
  focus() { if (this.isConnected) this.doc.activeElement = this; }
  select() {} setSelectionRange() {} addEventListener() {} scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, bottom: 1, left: 0, right: 0, width: 0, height: 0 }; }
  matches(sel) { return String(sel).split(',').some((s) => matchSelector(this, s.trim())); }
  closest(sel) { let n = this; while (n && n.nodeType === 1) { if (n.matches(sel)) return n; n = n.parentElement; } return null; }
  querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (c.nodeType === 1) { if (c.matches(sel)) out.push(c); walk(c); } } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  get elements() { const list = this.querySelectorAll('input, textarea, button'); const o = {}; for (const el of list) if (el.attrs.name && !o[el.attrs.name]) o[el.attrs.name] = el; return Object.assign(list, o); }
}

function matchCompound(n, c) {
  const m = /^([a-zA-Z*][\w-]*)?((?:\.[\w-]+|#[\w-]+|\[[^\]]+\]|:[\w-]+(?:\([^)]*\))?)*)$/.exec(c);
  if (!m) return false;
  if (m[1] && m[1] !== '*' && n.tagName !== m[1].toUpperCase()) return false;
  for (const part of m[2].match(/\.[\w-]+|#[\w-]+|\[[^\]]+\]|:[\w-]+(?:\([^)]*\))?/g) || []) {
    if (part[0] === '.') { if (!n.classList.contains(part.slice(1))) return false; }
    else if (part[0] === '#') { if (n.id !== part.slice(1)) return false; }
    else if (part[0] === '[') {
      const a = /^\[([\w:-]+)(?:([~|^$*]?)=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]$/.exec(part);
      if (!a) return false;
      const v = n.getAttribute(a[1]);
      if (v === null) return false;
      const want = a[3] ?? a[4] ?? a[5];
      if (want !== undefined) { if (a[2] === '^') { if (!v.startsWith(want)) return false; } else if (v !== want) return false; }
    } else if (part.startsWith(':not(')) { if (matchSelector(n, part.slice(5, -1))) return false; }
  }
  return true;
}
function matchSelector(n, sel) {
  const parts = sel.split(/\s+(?![^[]*\])/).filter(Boolean);
  if (!matchCompound(n, parts[parts.length - 1])) return false;
  let node = n.parentElement;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (node && node.nodeType === 1 && !matchCompound(node, parts[i])) node = node.parentElement;
    if (!node || node.nodeType !== 1) return false;
    node = node.parentElement;
  }
  return true;
}
function parseHtml(html, doc) {
  const root = { children: [] }, stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z][\w:-]*)([^>]*?)(\/)?>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) { const t = new Text(unesc(m[5])); t.parentElement = top === root ? null : top; top.children.push(t); continue; }
    const [, close, tag, attrs, self] = m;
    if (close) { for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; } continue; }
    const el = new El(doc, tag);
    for (const a of parseAttrs(attrs)) el.setAttribute(a.name, a.value);
    el.parentElement = top === root ? null : top;
    top.children.push(el);
    if (!self && !VOID.has(tag.toLowerCase())) stack.push(el);
  }
  return root.children;
}
function makeDocument() {
  const doc = { hidden: false, createElement(tag) { return new El(doc, tag); } };
  doc.body = new El(doc, 'body');
  doc.activeElement = doc.body;
  doc.querySelector = (s) => doc.body.querySelector(s);
  doc.querySelectorAll = (s) => doc.body.querySelectorAll(s);
  return doc;
}

/* ------------------------------- fixture --------------------------------- */

function fixture({ remote = true, admin = true } = {}) {
  const document = makeDocument();
  const app = document.body.appendChild(new El(document, 'div'));
  app.setAttribute('id', 'app');
  const requests = [], renders = [], backgrounds = [], toasts = [], menus = [], navs = [], closes = [];
  const base = {
    UI: { route: { name: 'recruit', params: {} }, modal: null, menu: null, editor: null, palette: null, toasts: [] },
    Store: { me: () => ({ email: 'lead@cornell.edu', name: 'Lead' }), isAdmin: () => admin, userName: (e) => e, relTime: () => 'just now' },
    MD: { esc }, I: new Proxy({}, { get: () => '<svg></svg>' }),
    document, $: (sel, root) => (root || document.body).querySelector(sel), $$: (sel, root) => (root || document.body).querySelectorAll(sel),
    crypto: { randomUUID }, AbortSignal, URLSearchParams, setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clearTimeout, setImmediate, console,
    location: { hash: '' }, window: { open() {} }, navigator: { clipboard: { writeText: async () => {} } },
    topbar: (crumbs, right) => `<header class="topbar"><nav class="crumbs">${crumbs}</nav>${right || ''}</header>`,
    api(url, options = {}) { return new Promise((resolve, reject) => requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, signal: options.signal, resolve, reject })); },
    render() { renders.push(base.UI.modal); },
    renderBackground(route) { backgrounds.push(route); },
    closeModal(after) { closes.push(base.UI.modal); base.UI.modal = null; after?.(); },
    nav(hash) { navs.push(hash); },
    toast(text) { toasts.push(text); },
    openMenu(items, anchor) { menus.push({ items, anchor }); base.UI.menu = { items }; },
    runAdminForm: async (form, submit) => submit(),
    adminFormMessage() {},
  };
  if (remote) base.REMOTE = { pending: 0 };
  const ctx = vm.createContext(base);
  vm.runInContext(ddSource + '\n' + focusSource + '\n' + src.core + '\n' + src.cycles + '\n' + src.forms + '\n' + src.applications, ctx, { filename: 'recruit-client.js' });
  const run = (code) => vm.runInContext(code, ctx);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { ctx, document, app, requests, renders, backgrounds, toasts, menus, navs, closes, run, settle,
    mount() { app.innerHTML = run('viewRecruit()'); return app; },
    mountModal() { document.body.querySelector('.modal-veil')?.remove(); const veil = document.body.appendChild(new El(document, 'div')); veil.setAttribute('class', 'modal-veil'); veil.innerHTML = run('RECRUIT.modal(UI.modal)'); return veil; } };
}

const cycleRow = (over = {}) => ({ id: 'cy-a', version: 3, status: 'open', name: 'Fall 2026', term: 'Fall 2026', updated: 1, doc: { subteams: [{ key: 'electrical', name: 'Electrical' }, { key: 'software', name: 'Software' }], modules: {}, pipeline: { views: [{ key: 'v1', name: 'Unscored electrical', query: { subteam: 'Electrical' } }] } }, ...over });
const rows = () => [
  { id: 'in-1', name: '<img src=x onerror=alert(1)>', email: '"x"@cornell.edu', ts: 1700000000000, year: 'Junior', subteam: 'Electrical', stage: 'applied', tags: ['<b>'], flagged: false, comments: 1, files: [], editVersion: 2, reviewVersion: 1, source: 'form' },
  { id: 'in-2', name: 'Two', email: 'two@cornell.edu', ts: 1700000100000, year: '', subteam: '', stage: 'screening', tags: [], flagged: true, comments: 0, files: [], editVersion: 0, reviewVersion: 0, source: 'admin' },
];
function loadCycle(f, { role = 'admin', roles = ['admin'], counts = { total: 2, bySection: { interest: 2 } } } = {}) {
  const st = f.run('recruitState()');
  st.me = { admin: roles.includes('admin'), cycles: [{ id: 'cy-a', name: 'Fall 2026', term: 'Fall 2026', status: 'open', roles }] };
  f.ctx.UI.recruitMe = st.me;
  st.cycles = { list: [{ id: 'cy-a', name: 'Fall 2026', term: 'Fall 2026', status: 'open', counts, updated: 1, version: 3 }], intakeCycleId: 'cy-a', migration: { done: true, orphans: 0 } };
  st.cycleId = 'cy-a';
  st.cycle = { data: cycleRow(), role, roles, counts, sections: null, grants: [] };
  st.apps = { key: st.key + ':cy-a:interest', rows: rows(), byId: Object.fromEntries(rows().map((r) => [r.id, r])), next: 'cursor-1', total: 200, counts, loading: false, error: null };
  f.ctx.UI.route = { name: 'recruit', params: { id: 'cy-a', sub: 'interest' } };
  return st;
}

/* ------------------------------- registry -------------------------------- */
{
  const f = fixture();
  same(f.run('RECRUIT.modules.map((m) => m.name)'), ['cycles', 'applications', 'forms'], 'kernel modules register in order');
  f.ctx.zetaCalls = [];
  f.run(`RECRUIT.register({ name: 'zeta', order: 5, panel: { id: 'zeta', label: 'Zeta', when: (cycle, role) => role === 'admin' || role === 'lead' }, view: () => '<p>zeta</p>',
    actions: { 'recruit-zeta': (el, ev, stop) => zetaCalls.push(el.dataset.id) }, modals: { 'recruit-zeta': (m) => '<div class="modal" data-zeta></div>' },
    columns: [{ id: 'score', label: 'Score', sortKey: 'score', cell: (r) => '<b>' + (r.extras?.score?.mean ?? '—') + '</b>' }],
    filters: [{ group: 'review', value: 'unscored', label: 'Unscored', query: { unscored: 1 } }],
    selectionActions: (ids) => [{ id: 'zeta-move', label: 'Zeta ' + ids.length, run: () => {} }],
    detailSections: (app) => ({ id: 'zeta', title: 'Zeta', html: '<p data-zeta-section>' + app.id + '</p>' }) })`);
  same(f.run('RECRUIT.modules.map((m) => m.name)'), ['cycles', 'zeta', 'applications', 'forms'], 'registry sorts by order');
  assert.throws(() => f.run("RECRUIT.register({ name: 'zeta', order: 9 })"), /already registered/);
  assert.throws(() => f.run("RECRUIT.register({ name: 'bad', order: 9, actions: { 'nope': () => {} } })"), /must start with recruit-/);
  assert.throws(() => f.run("RECRUIT.register({ name: 'noorder' })"), /needs an order/);
  const cycle = cycleRow();
  f.ctx.cycle = cycle;
  same(f.run("RECRUIT.panels(cycle, 'admin').map((p) => p.id)"), ['zeta', 'interest', 'coffee', 'application', 'settings'], 'the three section tabs follow module tabs by panel order, Settings is last');
  same(f.run("RECRUIT.panels(cycle, 'reviewer').map((p) => p.id)"), ['interest', 'coffee', 'application'], 'tabs are gated by role');
  f.ctx.cycle = cycleRow({ doc: { modules: { zeta: false } } });
  same(f.run("RECRUIT.panels(cycle, 'admin').map((p) => p.id)"), ['interest', 'coffee', 'application', 'settings'], 'a module switched off for the cycle loses its tab');
  assert.match(f.run("RECRUIT.modal({ kind: 'recruit-zeta' })"), /data-zeta/, 'modal kinds resolve through the registry');
  assert.equal(f.run("RECRUIT.modal({ kind: 'recruit-nope' })"), '', 'unknown kinds draw nothing');
  const el = f.run("document.createElement('button')"); el.setAttribute('data-action', 'recruit-zeta'); el.setAttribute('data-id', 'x');
  let stopped = 0;
  assert.equal(await f.run('RECRUIT.click.bind(RECRUIT)')('recruit-zeta', el, { preventDefault() {}, stopPropagation() {} }, () => { stopped++; }), true);
  same(f.ctx.zetaCalls, ['x']); assert.equal(stopped, 1, 'the dispatcher stops the event for buttons');
  const form = f.run("document.createElement('form')"); form.setAttribute('data-action', 'recruit-zeta');
  assert.equal(await f.run('RECRUIT.click.bind(RECRUIT)')('recruit-zeta', form, {}, () => {}), false, 'a click that lands on a form is not an action');
  assert.equal(await f.run('RECRUIT.click.bind(RECRUIT)')('recruit-unknown', el, {}, () => {}), false);
  f.ctx.evt = { key: 'ArrowRight', target: null, prevented: 0, preventDefault() { this.prevented++; } };
  loadCycle(f);
  f.mount();
  const tabs = f.app.querySelectorAll('.rc-tabs [role="tab"]');
  same(tabs.map((t) => t.textContent), ['Zeta', 'Interest form', 'Coffee chats', 'Applications', 'Settings']);
  assert.equal(tabs[1].getAttribute('aria-current'), 'page');
  tabs[1].focus(); f.ctx.evt.target = tabs[1];
  assert.equal(f.run('RECRUIT.keydown(evt)'), true); assert.ok(f.document.activeElement === tabs[2], 'arrow keys rove the tablist');
  f.ctx.evt.key = 'a'; assert.equal(f.run('RECRUIT.keydown(evt)'), false);
  const sheet = f.app.querySelector('.sheet--recruit');
  assert.ok(sheet.querySelector('th[data-col="score"]'), 'module columns join the sheet');
  assert.match(sheet.querySelector('tbody td[data-col="score"]').innerHTML, /—/);
  f.ctx.st = f.run('recruitState()'); f.ctx.st.selected = new Set(['in-1', 'in-2']);
  f.run('recruitPaintSelection()');
  assert.match(f.app.querySelector('[data-recruit-selection]').innerHTML, /2 selected/, 'the selection toolbar counts');
  f.run("UI.modal = { kind: 'recruit-app', id: 'in-1' }"); f.ctx.st.detail['in-1'] = { application: { id: 'in-1', name: 'One', email: 'one@cornell.edu', answers: {}, files: [], review: { comments: [] }, tags: [] }, form: null, history: [], audit: [] };
  assert.match(f.run('RECRUIT.modal(UI.modal)'), /data-zeta-section/, 'module detail sections join the dialog');
  console.log('PASS: registry dispatches by view key, sorts by order, gates tabs by role and module switch, and merges columns, filters and detail sections');
}

/* ------------------------------- cycle index ----------------------------- */
{
  const f = fixture({ remote: false });
  assert.match(f.run('viewRecruit()'), /class="empty"/, 'no REMOTE draws the .empty stub');
}
{
  const f = fixture();
  const st = f.run('recruitState()');
  assert.match(f.run('viewRecruit()'), /Loading…/, 'me undefined shows loading');
  st.me = { loading: true }; assert.match(f.run('viewRecruit()'), /Loading…/);
  st.me = { error: 'Not <signed> in' };
  const err = f.run('viewRecruit()');
  assert.match(err, /Not &lt;signed&gt; in/); assert.match(err, /data-action="recruit-refresh"/, 'errors offer a retry');
  st.me = { admin: false, cycles: [] }; assert.match(f.run('viewRecruit()'), /Only admins and cycle reviewers/);
  st.me = { admin: true, cycles: [] }; f.ctx.UI.recruitMe = st.me;
  st.cycles = { loading: true }; assert.match(f.run('viewRecruit()'), /Loading…/);
  st.cycles = { error: 'boom' }; assert.match(f.run('viewRecruit()'), /Could not load: boom/);
  st.cycles = { list: [
    { id: 'cy-a', name: '<b>Fall</b> 2026', term: 'Fall 2026', status: 'open', counts: { total: 12, bySection: { interest: 10, coffee: 2 } }, updated: 1 },
    { id: 'cy-old', name: 'Spring 2025', term: 'Spring 2025', status: 'archived', counts: { total: 3 }, updated: 1 },
  ], intakeCycleId: 'cy-a', migration: { done: false, legacyLive: 40, legacyArchives: [{ id: 'ar-1' }], orphans: 0 } };
  const html = f.run('viewRecruit()');
  assert.match(html, /&lt;b&gt;Fall&lt;\/b&gt; 2026/, 'cycle names are escaped'); assert.doesNotMatch(html, /<b>Fall<\/b>/);
  assert.match(html, /Open · receives the website form · 10 interest · 2 coffee chats · 0 applications/);
  assert.match(html, /Archived<\/h2>/, 'archived cycles sit under a second heading');
  assert.match(html, /Import the current list and archives/); assert.match(html, /40 submissions and 1 archive/);
  assert.match(html, /data-action="recruit-cycle-new"/);
  st.cycles.migration = { done: true, orphans: 5 };
  assert.match(f.run('viewRecruit()'), /5 submissions arrived while no cycle was receiving the form/);
  assert.doesNotMatch(f.run('viewRecruit()'), /<select/);
  // The migration loop follows the server's next step and repaints from state.
  f.mount();
  const migrating = f.run('recruitRunMigration()');
  assert.equal(f.requests[0].url, '/recruit/migrate'); same(f.requests[0].body.step, 'live'); assert.match(f.requests[0].body.requestId, /^rq-/);
  f.requests[0].resolve({ done: false, next: { step: 'archive', archiveId: 'ar-1' } }); await f.settle();
  assert.equal(f.requests[1].body.archiveId, 'ar-1');
  f.requests[1].resolve({ done: true }); await migrating;
  assert.equal(st.cycles, undefined, 'the index refetches after the import'); same(f.backgrounds, ['recruit']); assert.equal(f.renders.length, 0);
  assert.equal(f.toasts.at(-1), 'Imported the current list and archives');
  console.log('PASS: the cycle index renders every UI.recruit sentinel, escapes names, lists archived cycles apart, and runs the resumable import without render()');
}

/* ------------------------------- sheet ----------------------------------- */
{
  const f = fixture();
  loadCycle(f);
  const html = f.run('viewRecruit()');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'names are escaped in rows'); assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&quot;x&quot;@cornell\.edu/, 'emails are escaped in rows and labels');
  assert.match(html, /data-m="recruit-filter"/); assert.match(html, /data-m="recruit-cycle-switch"/);
  assert.doesNotMatch(html, /<select|<datalist/);
  assert.match(html, /href="#\/applications\?all=1">Applications<\/a><span class="crumbs__sep">\/<\/span><span class="crumbs__here">Fall 2026/); assert.doesNotMatch(html, /receives the website form · 2 interest/, 'the cycle page has no counts subtitle'); assert.match(html, /class="rc-cycle-title" data-action="dd" data-m="recruit-cycle-switch"/, 'the title is the cycle switch'); assert.match(html, /data-rc-count="interest">2</, 'the tab bar counts responses');
  assert.match(html, /2 of 200 shown · <\/span><button class="linklike" data-action="recruit-load-more">Load more/);
  assert.match(html, /applications\.csv\?section=interest/, 'the export link names the section');
  f.mount();
  const person = f.app.querySelector('[data-action="recruit-app-open"][data-id="in-1"]');
  person.focus();
  f.run("recruitState().apps.rows[0].comments = 3"); f.run("recruitState().apps.byId['in-1'].comments = 3");
  assert.equal(f.run('recruitPaintRows()'), true);
  const again = f.app.querySelector('[data-action="recruit-app-open"][data-id="in-1"]');
  assert.ok(again !== person); assert.ok(f.document.activeElement === again, 'focus is restored after the tbody repaint');
  assert.match(f.app.querySelector('tbody').innerHTML, /<span>3<\/span>/);
  // Filters: the combined menu, its label, and the server query.
  const host = f.app.querySelector('[data-m="recruit-filter"]');
  f.run('RECRUIT.dd.bind(RECRUIT)')(host);
  const labels = f.menus[0].items.filter((i) => i !== '-').map((i) => i.label);
  for (const want of ['All people', 'Flagged', 'Has comments', 'All subteams', 'Electrical', 'Undecided', 'All years', 'Junior']) assert.ok(labels.includes(want), `filter menu offers ${want}`);
  f.menus[0].items.find((i) => i.label === 'Flagged').run();
  assert.equal(host.querySelector('.dd__label').textContent, 'Flagged');
  f.run('RECRUIT.dd.bind(RECRUIT)')(host); f.menus[1].items.find((i) => i.label === 'Electrical').run();
  assert.equal(host.querySelector('.dd__label').textContent, 'Flagged · Electrical', 'filter labels compose');
  f.run('RECRUIT.dd.bind(RECRUIT)')(host); f.menus[2].items.find((i) => i.label === 'Undecided').run();
  assert.equal(host.querySelector('.dd__label').textContent, 'Flagged · Undecided');
  f.run('RECRUIT.dd.bind(RECRUIT)')(host); f.menus[3].items.find((i) => i.label === 'All people').run();
  f.run('RECRUIT.dd.bind(RECRUIT)')(host); f.menus[4].items.find((i) => i.label === 'All subteams').run();
  assert.equal(host.querySelector('.dd__label').textContent, 'All people');
  const listCalls = f.requests.filter((r) => r.url.includes('/applications?'));
  assert.match(listCalls[1].url, /flagged=1&subteam=Electrical/, 'server filters ride the query');
  assert.ok(listCalls.every((r) => r.signal instanceof AbortSignal), 'every list fetch is bounded');
  // A dd without a handler gets the default menu from data-opts and marks its form dirty.
  f.ctx.UI.route.params.sub = 'settings'; f.mount();
  const term = f.app.querySelector('[data-m="recruit-term"]');
  assert.ok(term, 'Settings draws the Cycle form with a term dropdown');
  f.run('RECRUIT.dd.bind(RECRUIT)')(term);
  const pick = f.menus.at(-1).items.find((i) => i.label === 'Rolling'); pick.run();
  assert.equal(term.dataset.value, 'Rolling'); assert.equal(term.closest('form').dataset.adminDirty, 'true');
  assert.doesNotMatch(f.app.innerHTML, /<select/);
  const sw = f.app.querySelector('[data-m="recruit-cycle-switch"]');
  f.run('RECRUIT.dd.bind(RECRUIT)')(sw, 'cy-b'); assert.equal(f.navs.at(-1), '#/applications/cy-b/settings', 'switching cycles keeps the panel');
  console.log('PASS: sheet rows escape user data, focus survives repaints, dd() drives every choice with composed labels, and no template contains a native select');
}

/* ------------------------------- form editor ----------------------------- */
{
  const f = fixture();
  const st = loadCycle(f);
  const sections = () => ({
    interest: { title: 'Interest form', description: 'Say hi', open: true, form: { questions: [
      { key: 'name', type: 'short', label: 'Name', required: true, max: 100 }, { key: 'email', type: 'email', label: 'Email', required: true, max: 200 },
      { key: 'subteam', type: 'single', label: 'Subteam', options: ['Electrical', 'Software'] }, { key: 'year', type: 'single', label: 'Year', options: ['Freshman'] },
      { key: 'project', type: 'long', label: 'Project', help: 'Tell us', max: 1000 }, { key: 'file', type: 'file', label: 'File', accept: ['application/pdf'], maxBytes: 100 },
    ] } },
    coffee: { title: 'Coffee chats', description: '', open: false, form: { questions: [{ key: 'name', type: 'short', label: 'Name', required: true }, { key: 'email', type: 'email', label: 'Email', required: true }] } },
    application: { title: 'Application', description: '', open: false, form: { questions: [{ key: 'name', type: 'short', label: 'Name', required: true }, { key: 'email', type: 'email', label: 'Email', required: true }] } },
  });
  st.cycle.sections = sections();
  f.ctx.UI.route.params.sub = 'coffee';
  f.mount();
  assert.match(f.app.innerHTML, /class="rc-seg"/, 'a lead sees Responses | Form on the tab');
  assert.match(f.app.innerHTML, /Closed on the website/);
  assert.match(f.app.innerHTML, /href="#\/applications\/cy-a\/coffee\?edit=1"/, 'the Form view is a link');
  assert.ok(f.app.querySelector('.sheet--recruit'), 'Responses is the sheet');
  f.ctx.UI.route.params.edit = '1';
  f.mount();
  const editor = f.app.querySelector('[data-rc="form-editor"]');
  assert.ok(editor && !f.app.querySelector('.sheet--recruit'), 'Form draws the editor in the tab instead of the sheet');
  assert.equal(f.app.querySelectorAll('.fe-q').length, 2);
  assert.equal(f.app.querySelectorAll('.fe-q__type--fixed').length, 2, 'name and email keep their type');
  assert.equal(f.app.querySelectorAll('[data-action="recruit-fe-remove"]').length, 0, 'fixed questions cannot be removed');
  assert.doesNotMatch(editor.innerHTML, /<select/);
  assert.ok(f.app.querySelector('[data-action="recruit-fe-save"]').disabled, 'nothing to save yet');
  const click = async (action, i, j) => {
    const el = f.app.querySelector(`[data-action="${action}"]${i === undefined ? '' : `[data-i="${i}"]`}${j === undefined ? '' : `[data-j="${j}"]`}`);
    assert.ok(el, `${action} ${i ?? ''} ${j ?? ''} exists`);
    assert.equal(await f.run('RECRUIT.click.bind(RECRUIT)')(action, el, { stopPropagation() {} }, () => {}), true);
    return el;
  };
  const type = (m, value, i, j) => {
    const el = f.app.querySelector(`[data-m="${m}"]${i === undefined ? '' : `[data-i="${i}"]`}${j === undefined ? '' : `[data-j="${j}"]`}`);
    assert.ok(el, `${m} exists`);
    el.value = value;
    assert.equal(f.run('RECRUIT.input.bind(RECRUIT)')(el, { type: 'input' }), true);
  };
  await click('recruit-fe-add');
  assert.equal(f.app.querySelectorAll('.fe-q').length, 3, 'Add question appends a card');
  assert.ok(f.document.activeElement === f.app.querySelector('[data-m="recruit-fe-label"][data-i="2"]'), 'the new label takes focus');
  type('recruit-fe-label', 'Which day works for you?', 2);
  assert.ok(!f.app.querySelector('[data-action="recruit-fe-save"]').disabled, 'typing enables Save');
  assert.match(f.app.querySelector('[data-rc="fe-foot"]').innerHTML, /Unsaved changes/);
  // The type menu is the app's own dd; picking "Choose one" seeds an option row.
  const typeHost = f.app.querySelector('[data-m="recruit-fe-type"][data-i="2"]');
  f.run('RECRUIT.dd.bind(RECRUIT)')(typeHost);
  f.menus.at(-1).items.find((it) => it.label === 'Choose one').run();
  assert.equal(f.app.querySelectorAll('[data-m="recruit-fe-option"][data-i="2"]').length, 1, 'a choice question starts with one option row');
  type('recruit-fe-option', 'Monday', 2, 0);
  await click('recruit-fe-option-add', 2);
  type('recruit-fe-option', 'Friday', 2, 1);
  await click('recruit-fe-option-add', 2);
  await click('recruit-fe-option-remove', 2, 2);
  assert.equal(f.app.querySelectorAll('[data-m="recruit-fe-option"][data-i="2"]').length, 2, 'options add and remove in place');
  f.app.querySelector('[data-action="recruit-fe-required"][data-i="2"]').checked = true;
  await click('recruit-fe-required', 2);
  await click('recruit-fe-up', 2);
  assert.equal(f.app.querySelector('.fe-q[data-i="1"] [data-m="recruit-fe-label"]').value, 'Which day works for you?', 'Move up swaps the cards');
  await click('recruit-fe-down', 1);
  const open = f.app.querySelector('[data-action="recruit-fe-open"]'); open.checked = true; await click('recruit-fe-open');
  type('recruit-fe-desc', 'Grab a coffee.');
  const saving = click('recruit-fe-save');
  await f.settle();
  const put = f.requests.at(-1);
  assert.equal(put.url, '/recruit/cycles/cy-a/settings/site'); assert.equal(put.method, 'PUT'); assert.equal(put.body.version, 3);
  const saved = put.body.settings.sections.coffee;
  assert.equal(saved.open, true); assert.equal(saved.description, 'Grab a coffee.');
  same(saved.form.questions.map((q) => q.key), ['name', 'email', 'which_day_works_for_you'], 'a new question gets a key from its label');
  same(saved.form.questions[2], { key: 'which_day_works_for_you', type: 'single', label: 'Which day works for you?', help: '', required: true, options: ['Monday', 'Friday'] });
  assert.match(f.app.querySelector('[data-rc="fe-foot"]').innerHTML, /Saving…/);
  put.resolve({ cycle: { ...cycleRow(), version: 4 } }); await saving; await f.settle();
  assert.ok(f.app.querySelector('[data-action="recruit-fe-save"]').disabled, 'Save settles');
  assert.equal(f.toasts.at(-1), 'Coffee chats saved · live on the website');
  assert.match(f.app.innerHTML, /Open on the website/, 'the tab bar shows the saved state');
  assert.equal(f.run('recruitSections(recruitCycleRow()).coffee.form.questions.length'), 3, 'the saved section is what the cycle now reports');
  assert.equal(f.run('recruitCycleRow().version'), 4, 'the next save uses the new version');
  assert.equal(f.renders.length, 0, 'the editor never re-renders the route');
  // Validation happens before any request.
  await click('recruit-fe-add'); type('recruit-fe-label', '', 3);
  const before = f.requests.length;
  await click('recruit-fe-save');
  assert.equal(f.requests.length, before, 'an unlabelled question never reaches the server');
  assert.match(f.app.querySelector('[data-rc="fe-foot"]').innerHTML, /Question 4 needs a label/);
  await click('recruit-fe-remove', 3);
  await click('recruit-fe-discard');
  assert.equal(f.app.querySelectorAll('.fe-q').length, 3);
  // Reviewers get the responses only.
  const r = fixture({ admin: false });
  const rst = loadCycle(r, { role: 'reviewer', roles: ['reviewer'] });
  rst.cycle.sections = sections();
  r.ctx.UI.route.params.edit = '1';
  r.mount();
  assert.ok(!r.app.querySelector('[data-rc="form-editor"]') && r.app.querySelector('.sheet--recruit'), 'reviewers cannot open the editor');
  assert.doesNotMatch(r.app.innerHTML, /class="rc-seg"/);
  console.log('PASS: the form editor lives in the section tab, edits a model in place, saves one PUT with derived keys, validates first, and is leads-only');
}

/* ------------------------------- stepping -------------------------------- */
{
  const f = fixture();
  const st = loadCycle(f);
  f.mount();
  f.ctx.st = st;
  st.detail['in-1'] = { application: { id: 'in-1', name: 'One', email: 'one@cornell.edu', section: 'interest', answers: {}, files: [], review: { comments: [] } }, form: null, history: [], audit: [] };
  f.run("recruitOpenApp('in-1')");
  assert.equal(f.renders.length, 1, 'opening renders the dialog once');
  f.mountModal();
  const dialog = f.document.querySelector('.rc-app');
  assert.equal(dialog.dataset.app, 'in-1');
  assert.match(dialog.querySelector('[data-rc="app-nav"]').innerHTML, /1 of 2/);
  assert.ok(f.requests.some((r) => r.url.endsWith('/applications/in-2')), 'the neighbour loads ahead of time');
  const next = dialog.querySelector('[data-action="recruit-app-next"]');
  next.focus();
  f.run('recruitStepApp(1)');
  assert.equal(f.renders.length, 1, 'stepping never re-renders: the window stays');
  assert.equal(f.ctx.UI.modal.id, 'in-2');
  assert.equal(dialog.dataset.app, 'in-2');
  assert.match(dialog.querySelector('[data-rc="app-identity"]').innerHTML, /two@cornell\.edu/, 'the head repaints in place');
  assert.match(dialog.querySelector('[data-rc="app-nav"]').innerHTML, /2 of 2/);
  assert.ok(dialog.querySelector('[data-action="recruit-app-next"]').disabled, 'Next stays drawn, disabled at the end');
  assert.ok(dialog.contains(f.document.activeElement), 'focus stays in the dialog');
  f.run('recruitStepApp(1)');
  assert.equal(f.ctx.UI.modal.id, 'in-2', 'a spare click at the end is harmless');
  f.run('recruitStepApp(-1)');
  assert.equal(f.ctx.UI.modal.id, 'in-1'); assert.equal(f.renders.length, 1);
  console.log('PASS: Previous and Next swap the application inside the open dialog without a render, prefetch neighbours, and keep focus');
}

/* ------------------------------- loaders --------------------------------- */
{
  const f = fixture();
  f.run("RECRUIT.mount({ name: 'recruit', params: {} })");
  assert.equal(f.requests[0].url, '/recruit/me'); assert.ok(f.requests[0].signal instanceof AbortSignal);
  f.requests[0].resolve({ admin: true, cycles: [] }); await f.settle();
  same(f.backgrounds, ['recruit']); assert.equal(f.renders.length, 0, 'completions never render() directly');
  f.run("RECRUIT.mount({ name: 'recruit', params: {} })");
  assert.equal(f.requests[1].url, '/recruit/cycles?all=1');
  f.requests[1].resolve({ cycles: [{ id: 'cy-a', name: 'A', status: 'open', counts: { total: 1 } }, { id: 'cy-b', name: 'B', status: 'open', counts: { total: 0 } }], intakeCycleId: null, migration: { done: true } }); await f.settle();
  same(f.backgrounds, ['recruit', 'recruit']);
  f.run("RECRUIT.mount({ name: 'recruit', params: {} })");
  assert.equal(f.navs.length, 0, 'two live cycles keep the index');
  f.run("RECRUIT.mount({ name: 'recruit', params: { id: 'cy-a' } })");
  const cycleReq = f.requests.find((r) => r.url === '/recruit/cycles/cy-a');
  assert.ok(cycleReq); assert.ok(cycleReq.signal instanceof AbortSignal);
  f.run("RECRUIT.mount({ name: 'recruit', params: { id: 'cy-b' } })");   // switched before the answer
  cycleReq.resolve({ cycle: cycleRow(), counts: { total: 1, byStage: {} }, me: { roles: ['admin'] } }); await f.settle();
  const st = f.run('recruitState()');
  assert.equal(st.cycleId, 'cy-b'); assert.equal(st.cycle?.loading, true, 'a late cycle answer after a switch is dropped');
  const bReq = f.requests.find((r) => r.url === '/recruit/cycles/cy-b');
  bReq.resolve({ cycle: cycleRow({ id: 'cy-b', name: 'B' }), counts: { total: 0, byStage: {} }, me: { roles: ['admin'] } }); await f.settle();
  assert.equal(st.cycle.data.id, 'cy-b'); assert.equal(st.cycle.role, 'admin');
  f.run("RECRUIT.mount({ name: 'recruit', params: { id: 'cy-b' } })");
  const listReq = f.requests.find((r) => r.url.startsWith('/recruit/cycles/cy-b/applications?'));
  assert.ok(listReq, 'the panel mount loads the first page');
  f.run("RECRUIT.reset('cy-a')");
  listReq.resolve({ rows: [{ id: 'in-9', name: 'Late', email: 'l@x.y', ts: 1 }], next: null, total: 1 }); await f.settle();
  assert.equal(st.apps, undefined, 'a late list answer after a cycle switch is dropped');
  assert.ok(f.requests.every((r) => r.signal instanceof AbortSignal), 'every fetch carries an AbortSignal');
  assert.equal(f.renders.length, 0);
  // A signed-in member on another route still learns about their cycles once.
  const g = fixture({ admin: false }); g.ctx.UI.route = { name: 'home', params: {} };
  g.run("RECRUIT.mount({ name: 'home', params: {} })");
  assert.equal(g.requests[0].url, '/recruit/me');
  g.requests[0].resolve({ admin: false, cycles: [{ id: 'cy-a', roles: ['reviewer'] }] }); await g.settle();
  same(g.backgrounds, ['home'], 'the sidebar link appears through a background repaint');
  g.run("RECRUIT.mount({ name: 'home', params: {} })");
  assert.equal(g.requests.length, 1, '/recruit/me is fetched once per session');
  // Timeouts read as one sentence and keep their name.
  const h = fixture();
  const p = h.run("RECRUIT.api('/recruit/x')");
  h.requests[0].reject(Object.assign(new Error('Timed out'), { name: 'TimeoutError' }));
  await assert.rejects(p, (e) => e.message === 'The request timed out. Try again.' && e.name === 'TimeoutError');
  h.run("RECRUIT.api('/cycles')"); assert.equal(h.requests[1].url, '/recruit/cycles', 'paths without the prefix get it');
  console.log('PASS: loaders complete through renderBackground, every fetch is bounded, late answers after a cycle switch are dropped, and /recruit/me loads once');
}

/* ------------------------------- sync ------------------------------------ */
{
  const f = fixture();
  const st = loadCycle(f);
  f.mount();
  assert.equal(f.app.querySelector('[data-rc-count="interest"]').textContent, '2');
  const tick = f.run('recruitSyncTick()');
  assert.equal(f.requests[0].url, '/recruit/cycles?all=1');
  f.requests[0].resolve({ cycles: [{ id: 'cy-a', name: 'Fall 2026', status: 'open', counts: { total: 7, bySection: { interest: 4, coffee: 3 } }, version: 3 }], intakeCycleId: 'cy-a', migration: { done: true } });
  await tick;
  assert.equal(f.app.querySelector('[data-rc-count="interest"]').textContent, '4', 'counts repaint in place');
  assert.equal(f.renders.length, 0); assert.equal(f.backgrounds.length, 0, 'the sync loop never repaints the whole route');
  assert.ok(st._syncTimer, 'the loop rescheduled itself'); f.run('clearTimeout(recruitState()._syncTimer)');
  f.ctx.UI.modal = { kind: 'confirm' };
  const quiet = f.run('recruitSyncTick()'); await quiet;
  assert.equal(f.requests.length, 1, 'no fetch while a dialog is open'); f.run('clearTimeout(recruitState()._syncTimer)');
  f.ctx.UI.modal = null; f.ctx.UI.route = { name: 'home', params: {} };
  f.run('RECRUIT.sync()'); assert.equal(st._syncTimer, null, 'leaving the route stops the loop');
  console.log('PASS: the sync loop repaints counts in place and stays quiet behind dialogs');
}

/* ------------------------------- detail dialog --------------------------- */
{
  const f = fixture();
  const st = loadCycle(f);
  const first = { id: 'ic-first', text: 'Existing <comment>', name: 'Reviewer', by: 'r@cornell.edu', ts: 1 };
  st.detail['in-1'] = { application: { id: 'in-1', name: '<img src=x onerror=alert(1)>', email: '"x"@cornell.edu', ts: 1, stage: 'applied', answers: { project: 'A <robot>' }, files: [{ id: 'int-1', name: 'cv.pdf', size: 2048 }], review: { comments: [first] }, reviewVersion: 1, editVersion: 2, tags: ['<b>'] }, form: { questions: [{ key: 'project', type: 'long', label: 'Coolest project' }] }, scores: [], history: [{ cycleId: 'cy-old', cycleName: 'Spring 2025', outcome: 'rejected' }], audit: [{ id: 'au-1', ts: 1, actor: 'r@cornell.edu', kind: 'stage', detail: { to: 'applied' } }] };
  f.ctx.UI.modal = { kind: 'recruit-app', id: 'in-1' };
  f.mount();
  const veil = f.mountModal();
  const html = veil.innerHTML;
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /A &lt;robot&gt;/); assert.match(html, /Existing &lt;comment&gt;/);
  assert.match(html, /href="\/api\/recruit\/files\/int-1" download="cv\.pdf"/, 'files link only the authenticated route');
  assert.match(html, /Also sent Spring 2025/); assert.doesNotMatch(html, /<select/);
  assert.match(html, /1 of 2<\/span>/); assert.match(html, /data-action="modal-close"/);
  const field = veil.querySelector('.interest-compose textarea');
  field.value = 'New <comment>';
  assert.equal(f.run('RECRUIT.input.bind(RECRUIT)')(field, { type: 'input' }), true);
  const draft = st.drafts['in-1'];
  assert.equal(draft.text, 'New <comment>');
  const existingNode = veil.querySelector('[data-comment-id="ic-first"]');
  // A background refresh brings a second comment and a changed answer.
  const second = { id: 'ic-second', text: 'Later', name: 'Lead', ts: 2 };
  f.run('recruitLoadDetail')('in-1', { quiet: true });
  const req = f.requests.find((r) => r.url === '/recruit/cycles/cy-a/applications/in-1');
  assert.ok(req.signal instanceof AbortSignal);
  req.resolve({ application: { ...st.detail['in-1'].application, review: { comments: [first, second] }, reviewVersion: 2, answers: { project: 'Changed' } }, form: st.detail['in-1'].form, history: [], audit: [] });
  await f.settle();
  assert.equal(field.value, 'New <comment>', 'the composer keeps its unsent text across a background refresh');
  assert.equal(field.isConnected, true, 'the composer node is never replaced');
  assert.equal(draft.text, 'New <comment>');
  assert.ok(veil.querySelector('[data-comment-id="ic-first"]') === existingNode, 'existing comments keep their DOM identity');
  assert.ok(veil.querySelector('[data-comment-id="ic-second"]'), 'new comments are appended');
  assert.equal(veil.querySelector('.interest-subhead .count').textContent, '2');
  assert.match(veil.querySelector('[data-rc="app-main"]').innerHTML, /Changed/, 'answers repaint in place');
  assert.equal(f.renders.length, 0); assert.equal(f.backgrounds.length, 0, 'the open dialog is never remounted');
  // Posting keeps its id across a timeout, then succeeds.
  const posting = f.run("recruitPostComment('in-1')");
  assert.equal(field.readOnly, true);
  const post = f.requests.find((r) => r.method === 'POST' && r.url.endsWith('/in-1/comments'));
  assert.match(post.body.id, /^ic-/); assert.equal(post.body.text, 'New <comment>'); assert.ok(post.signal instanceof AbortSignal);
  post.reject(Object.assign(new Error('Timed out'), { name: 'TimeoutError' })); await posting;
  assert.match(veil.querySelector('[data-comment-error]').textContent, /retrying will not post it twice/);
  assert.equal(field.value, 'New <comment>'); assert.equal(field.readOnly, false);
  const retry = f.run("recruitPostComment('in-1')");
  const post2 = f.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/in-1/comments'))[1];
  assert.equal(post2.body.id, post.body.id, 'a lost response is retried with the same ic- id');
  const saved = { id: post2.body.id, text: 'New <comment>', name: 'Lead', ts: 3 };
  post2.resolve({ application: { id: 'in-1', reviewVersion: 3, review: { comments: [first, second, saved] } } }); await retry;
  assert.equal(f.toasts.at(-1), 'Comment posted'); assert.equal(field.value, '');
  assert.match(veil.querySelector('.interest-thread').innerHTML, /New &lt;comment&gt;/);
  assert.equal(st.apps.byId['in-1'].comments, 3, 'the row mirrors the thread size'); assert.equal(f.renders.length, 0);
  // Deleting confirms inline and toasts.
  f.run("recruitConfirmCommentRemoval('in-1', 'ic-first')");
  assert.match(existingNode.innerHTML, /Delete this comment\?/);
  const deleting = f.run("recruitDeleteComment('in-1', 'ic-first')");
  const del = f.requests.find((r) => r.method === 'DELETE');
  assert.equal(del.url, '/recruit/cycles/cy-a/applications/in-1/comments/ic-first');
  del.resolve({ application: { id: 'in-1', reviewVersion: 4, review: { comments: [second, saved] } } }); await deleting;
  assert.equal(f.toasts.at(-1), 'Comment deleted'); assert.equal(veil.querySelector('[data-comment-id="ic-first"]'), null);
  // Flag round trip.
  const flagging = f.run("recruitToggleFlag('in-1')");
  const patch = f.requests.find((r) => r.method === 'PATCH');
  same(patch.body, { flagged: true });
  patch.resolve({ application: { id: 'in-1', reviewVersion: 5, review: { flagged: true, comments: [second, saved] } } }); await flagging;
  assert.equal(st.apps.byId['in-1'].flagged, true); assert.equal(f.toasts.at(-1), 'Flagged for follow-up');
  // Previous / Next walk the visible list.
  f.run('recruitStepApp(1)'); assert.equal(f.ctx.UI.modal.id, 'in-2'); assert.equal(f.renders.length, 0, 'stepping swaps the application in place; the dialog never remounts');
  console.log('PASS: the application dialog escapes everything, keeps a dirty comment draft across background refreshes, retries with the same ic- id, and never remounts while open');
}

/* ------------------------------- merges + toasts ------------------------- */
{
  const f = fixture();
  const st = loadCycle(f);
  assert.equal(f.run('recruitAcceptRow')({ id: 'in-1', editVersion: 0, name: 'Old' }), false, 'an older edit version is refused');
  assert.equal(st.apps.byId['in-1'].name, '<img src=x onerror=alert(1)>');
  assert.equal(f.requests[0]?.url, '/recruit/cycles/cy-a/applications/in-1', 'the row is fetched again instead');
  assert.equal(f.run('recruitAcceptRow')({ id: 'in-1', editVersion: 2, name: 'Same' }), true, 'an equal edit version merges');
  assert.equal(f.run('recruitAcceptRow')({ id: 'in-1', editVersion: 5, name: 'Newer' }), true);
  assert.equal(st.apps.byId['in-1'].name, 'Newer'); assert.equal(st.apps.rows[0].name, 'Newer');
  f.mount();
  st.selected = new Set(['in-1', 'in-2']);
  await f.run("RECRUIT.click('recruit-copy-emails', document.querySelector('[data-action=\"recruit-copy-emails\"]') || document.createElement('button'), { preventDefault() {}, stopPropagation() {} }, () => {})");
  assert.equal(f.toasts.at(-1), 'Copied 2 emails as CSV');
  // Bulk delete: a typed confirm, one DELETE per id, rows drop, dialog on a removed row closes.
  f.run("recruitConfirmRemoval(['in-1', 'in-2'])");
  assert.equal(f.ctx.UI.modal.kind, 'confirm'); assert.equal(f.ctx.UI.modal.typed, 'delete applications'); assert.equal(f.ctx.UI.modal.danger, true);
  const go = f.ctx.UI.modal.onGo; f.ctx.UI.modal = { kind: 'recruit-app', id: 'in-1' };
  const removing = go();
  const dels = f.requests.filter((r) => r.method === 'DELETE');
  assert.equal(dels.length, 2); dels.forEach((r) => r.resolve({ ok: true })); await removing;
  assert.equal(st.apps.rows.length, 0); assert.equal(f.closes.length, 1, 'the dialog of a deleted application closes');
  assert.equal(f.toasts.at(-1), 'Deleted 2 applications');
  console.log('PASS: rows merge only when editVersion is not older, copy and delete toast their counts, and removal closes the open dialog');
}

console.log('PASS: recruit UI — registry, cycle index, sheet, dialog, sync and merges');
