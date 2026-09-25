// The recruit client (registry, shell, cycle index, Applications panel,
// sections) run whole inside vm against a small tree-based DOM fixture. No
// network, browser, production data or credentials are used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const files = { core: 'recruit-core.js', cycles: 'recruit-cycles.js', forms: 'recruit-forms.js', people: 'recruit-people.js', applications: 'recruit-applications.js' };
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
    // The shell's dialog helpers: a veil appended to the body, no route render.
    viewModal() { return `<div class="modal-veil" data-action="modal-veil">${run('RECRUIT.modal(UI.modal)')}</div>`; },
    captureModalFocus() {},
    mountModalFocus() { document.body.querySelector('.modal [data-action="modal-close"]')?.focus(); },
  };
  if (remote) base.REMOTE = { pending: 0 };
  const ctx = vm.createContext(base);
  const run = (code) => vm.runInContext(code, ctx);
  vm.runInContext(ddSource + '\n' + focusSource + '\n' + src.core + '\n' + src.cycles + '\n' + src.forms + '\n' + src.people + '\n' + src.applications, ctx, { filename: 'recruit-client.js' });
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
// The forms the server merges for a fresh cycle: the interest form keeps its
// six fixed questions, the other two ask only for a name and an email.
const q = (key, type, label, extra = {}) => ({ key, type, label, required: false, ...extra });
const defaultSections = () => ({
  interest: { title: 'Interest form', description: '', open: true, required: ['name', 'email', 'subteam', 'year', 'project', 'file'], form: { questions: [q('name', 'short', 'Name', { required: true }), q('email', 'email', 'Email', { required: true }), q('subteam', 'single', 'Subteam', { options: ['Electrical', 'Software'] }), q('year', 'single', 'Year', { options: ['Freshman', 'Sophomore', 'Junior', 'Senior', 'Grad'] }), q('project', 'long', 'Coolest project'), q('file', 'file', 'Photo or PDF')] } },
  coffee: { title: 'Coffee chats', description: '', open: false, required: ['name', 'email'], form: { questions: [q('name', 'short', 'Name', { required: true }), q('email', 'email', 'Email', { required: true })] } },
  application: { title: 'Application form', description: '', open: false, required: ['name', 'email'], form: { questions: [q('name', 'short', 'Name', { required: true }), q('email', 'email', 'Email', { required: true })] } },
});
function loadCycle(f, { role = 'admin', roles = ['admin'], counts = { total: 2, bySection: { interest: 2 } } } = {}) {
  const st = f.run('recruitState()');
  st.me = { admin: roles.includes('admin'), cycles: [{ id: 'cy-a', name: 'Fall 2026', term: 'Fall 2026', status: 'open', roles }] };
  f.ctx.UI.recruitMe = st.me;
  st.cycles = { list: [{ id: 'cy-a', name: 'Fall 2026', term: 'Fall 2026', status: 'open', counts, updated: 1, version: 3 }], intakeCycleId: 'cy-a', migration: { done: true, orphans: 0 } };
  st.cycleId = 'cy-a';
  st.cycle = { data: cycleRow(), role, roles, counts, sections: defaultSections(), grants: [] };
  st.apps = { key: st.key + ':cy-a:interest', rows: rows(), byId: Object.fromEntries(rows().map((r) => [r.id, r])), next: 'cursor-1', total: 200, counts, loading: false, error: null };
  f.ctx.UI.route = { name: 'recruit', params: { id: 'cy-a', sub: 'interest' } };
  return st;
}

/* ------------------------------- registry -------------------------------- */
{
  const f = fixture();
  same(f.run('RECRUIT.modules.map((m) => m.name)'), ['cycles', 'people', 'applications', 'forms'], 'kernel modules register in order');
  f.ctx.zetaCalls = [];
  f.run(`RECRUIT.register({ name: 'zeta', order: 5, panel: { id: 'zeta', label: 'Zeta', when: (cycle, role) => role === 'admin' || role === 'lead' }, view: () => '<p>zeta</p>',
    actions: { 'recruit-zeta': (el, ev, stop) => zetaCalls.push(el.dataset.id) }, modals: { 'recruit-zeta': (m) => '<div class="modal" data-zeta></div>' },
    columns: [{ id: 'score', label: 'Score', sortKey: 'score', cell: (r) => '<b>' + (r.extras?.score?.mean ?? '—') + '</b>' }],
    filters: [{ group: 'review', value: 'unscored', label: 'Unscored', query: { unscored: 1 } }],
    detailSections: (app) => ({ id: 'zeta', title: 'Zeta', html: '<p data-zeta-section>' + app.id + '</p>' }) })`);
  same(f.run('RECRUIT.modules.map((m) => m.name)'), ['cycles', 'zeta', 'people', 'applications', 'forms'], 'registry sorts by order');
  assert.throws(() => f.run("RECRUIT.register({ name: 'zeta', order: 9 })"), /already registered/);
  assert.throws(() => f.run("RECRUIT.register({ name: 'bad', order: 9, actions: { 'nope': () => {} } })"), /must start with recruit-/);
  assert.throws(() => f.run("RECRUIT.register({ name: 'noorder' })"), /needs an order/);
  const cycle = cycleRow();
  f.ctx.cycle = cycle;
  same(f.run("RECRUIT.panels(cycle, 'admin').map((p) => p.id)"), ['people', 'zeta', 'interest', 'coffee', 'application'], 'People leads, the three section tabs follow module tabs by panel order; settings is a dialog, not a tab');
  same(f.run("RECRUIT.panels(cycle, 'reviewer').map((p) => p.id)"), ['people', 'interest', 'coffee', 'application'], 'tabs are gated by role');
  f.ctx.cycle = cycleRow({ doc: { modules: { zeta: false } } });
  same(f.run("RECRUIT.panels(cycle, 'admin').map((p) => p.id)"), ['people', 'interest', 'coffee', 'application'], 'a module switched off for the cycle loses its tab');
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
  same(tabs.map((t) => t.textContent), ['People', 'Zeta', 'Interest form', 'Coffee chats', 'Application form']);
  assert.ok(f.app.querySelector('.rc-tabs .rc-tabs__add[data-action="recruit-form-new"]'), 'a + after the tabs adds a form');
  assert.equal(tabs[2].getAttribute('aria-current'), 'page');
  tabs[2].focus(); f.ctx.evt.target = tabs[2];
  assert.equal(f.run('RECRUIT.keydown(evt)'), true); assert.ok(f.document.activeElement === tabs[3], 'arrow keys rove the tablist');
  f.ctx.evt.key = 'a'; assert.equal(f.run('RECRUIT.keydown(evt)'), false);
  const sheet = f.app.querySelector('.sheet--recruit');
  assert.ok(sheet.querySelector('th[data-col="score"]'), 'module columns join the sheet');
  assert.match(sheet.querySelector('tbody td[data-col="score"]').innerHTML, /—/);
  f.ctx.st = f.run('recruitState()'); f.ctx.st.selected = new Set(['in-1', 'in-2']);
  f.run('recruitPaintSelection()');
  assert.match(f.app.querySelector('[data-recruit-selection]').innerHTML, /2 selected/, 'the selection toolbar counts');
  f.run("UI.modal = { kind: 'recruit-person', email: 'one@cornell.edu' }"); f.ctx.st.persons = { 'one@cornell.edu': { person: { email: 'one@cornell.edu', name: 'One', flagged: false, review: { comments: [] }, reviewVersion: 0, latest: 'in-1' }, submissions: [{ application: { id: 'in-1', name: 'One', email: 'one@cornell.edu', section: 'interest', answers: {}, files: [], tags: [] }, form: { questions: [] } }], history: [] } };
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
  st.me = { admin: false, cycles: [] }; assert.match(f.run('viewRecruit()'), /No access/);
  st.me = { admin: true, cycles: [] }; f.ctx.UI.recruitMe = st.me;
  st.cycles = { loading: true }; assert.match(f.run('viewRecruit()'), /Loading…/);
  st.cycles = { error: 'boom' }; assert.match(f.run('viewRecruit()'), /Could not load: boom/);
  st.cycles = { list: [
    { id: 'cy-a', name: '<b>Fall</b> 2026', term: 'Fall 2026', status: 'open', counts: { total: 12, bySection: { interest: 10, coffee: 2 } }, updated: 1 },
    { id: 'cy-old', name: 'Spring 2025', term: 'Spring 2025', status: 'archived', counts: { total: 3 }, updated: 1 },
  ], intakeCycleId: 'cy-a', migration: { done: false, legacyLive: 40, legacyArchives: [{ id: 'ar-1' }], orphans: 0 } };
  const html = f.run('viewRecruit()');
  assert.match(html, /&lt;b&gt;Fall&lt;\/b&gt; 2026/, 'cycle names are escaped'); assert.doesNotMatch(html, /<b>Fall<\/b>/);
  assert.match(html, /Open · receives the website's forms · Interest form 10 · Coffee chats 2 · Application form 0/);
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
  assert.match(f.app.innerHTML, /data-action="recruit-person-flag"/, 'a response row uses the shared person flag');
  assert.match(f.app.innerHTML, /interest-comments/, 'a response row shows the shared comment count');
  const person = f.app.querySelector('[data-action="recruit-person-open"][data-email="two@cornell.edu"]');
  assert.equal(person.dataset.form, 'interest', 'a row opens its person at this form');
  person.focus();
  f.run("recruitState().apps.rows[1].name = 'Two Renamed'"); f.run("recruitState().apps.byId['in-2'].name = 'Two Renamed'");
  assert.equal(f.run('recruitPaintRows()'), true);
  const again = f.app.querySelector('[data-action="recruit-person-open"][data-email="two@cornell.edu"]');
  assert.ok(again !== person); assert.ok(f.document.activeElement === again, 'focus is restored after the tbody repaint');
  assert.match(f.app.querySelector('tbody').innerHTML, /Two Renamed/);
  // Filters: the combined menu, its label, and the server query.
  const host = f.app.querySelector('[data-m="recruit-filter"]');
  f.run('RECRUIT.dd.bind(RECRUIT)')(host);
  const labels = f.menus[0].items.filter((i) => i !== '-').map((i) => i.label);
  for (const want of ['All subteams', 'Electrical', 'Undecided', 'All years', 'Junior']) assert.ok(labels.includes(want), `filter menu offers ${want}`);
  assert.ok(labels.includes('Flagged') && labels.includes('Has comments'), 'shared review filters work in every form');
  f.menus[0].items.find((i) => i.label === 'Electrical').run();
  assert.equal(host.querySelector('.dd__label').textContent, 'Electrical');
  f.run('RECRUIT.dd.bind(RECRUIT)')(host); f.menus[1].items.find((i) => i.label === 'Junior').run();
  assert.equal(host.querySelector('.dd__label').textContent, 'Electrical · Junior', 'filter labels compose');
  f.run('RECRUIT.dd.bind(RECRUIT)')(host); f.menus[2].items.find((i) => i.label === 'Undecided').run();
  assert.equal(host.querySelector('.dd__label').textContent, 'Undecided · Junior');
  f.run('RECRUIT.dd.bind(RECRUIT)')(host); f.menus[3].items.find((i) => i.label === 'All subteams').run();
  f.run('RECRUIT.dd.bind(RECRUIT)')(host); f.menus[4].items.find((i) => i.label === 'All years').run();
  assert.equal(host.querySelector('.dd__label').textContent, 'All people');
  const listCalls = f.requests.filter((r) => r.url.includes('/applications?'));
  assert.match(listCalls[1].url, /subteam=Electrical/, 'server filters ride the query');
  assert.ok(listCalls.every((r) => r.signal instanceof AbortSignal), 'every list fetch is bounded');
  // Settings is a dialog from the gear beside the name: about, status, subteams, who can review.
  assert.ok(f.app.querySelector('.rc-cycle-gear[data-action="recruit-settings-open"]'), 'the gear sits beside the cycle name');
  f.run('recruitOpenSettings()');
  assert.equal(f.ctx.UI.modal.kind, 'recruit-settings');
  const settings = f.mountModal();
  assert.equal(settings.querySelector('[data-action="recruit-settings-about"] [name="name"]').value, 'Fall 2026', 'About holds the name');
  assert.ok(!settings.querySelector('[data-m="recruit-term"]') && !settings.querySelector('[name="opensAt"]') && !settings.querySelector('[name="capacity"]') && !settings.querySelector('[name="perIpHour"]'), 'term, opens, capacity and rate limits are gone from the dialog');
  const seg = settings.querySelectorAll('.rc-seg--status [data-action="recruit-status-set"]');
  same([...seg].map((b) => [b.dataset.status, b.getAttribute('aria-current') === 'page', b.disabled]), [['draft', false, true], ['open', true, false], ['closed', false, false]], 'status is a segmented control: the current one pressed, only real moves enabled');
  assert.equal(settings.querySelector('[data-action="recruit-website-toggle"]').checked, true, 'the receiving checkbox reflects the index');
  assert.equal(settings.querySelectorAll('[data-rc="subteam-rows"] .rc-row').length, 2); assert.ok(!settings.querySelector('[name="capacity"]'), 'subteam rows are names only');
  assert.match(settings.querySelector('#rc-set-review').innerHTML, /Admins only so far/); assert.ok(settings.querySelector('[data-action="recruit-roles-open"]'));
  assert.ok(!settings.querySelector('[data-action="recruit-cycle-delete"]'), 'an open cycle cannot be deleted; nothing offers it');
  assert.doesNotMatch(f.app.innerHTML + settings.innerHTML, /<select/);
  // A dd without a handler gets the default menu from data-opts and marks its form dirty.
  const st0 = f.run('recruitState()');
  st0.mod.roles = { key: st0.key + ':cy-a', loading: false, error: null, roles: [], members: [{ email: 'r@cornell.edu', name: 'Rae' }] };
  f.ctx.UI.modal = { kind: 'recruit-roles' };
  const rolesVeil = f.mountModal();
  const roleDd = rolesVeil.querySelector('[data-m="recruit-role-role"]');
  assert.ok(roleDd, 'Who can review offers a role dropdown');
  f.run('RECRUIT.dd.bind(RECRUIT)')(roleDd);
  const pick = f.menus.at(-1).items.find((i) => i.label === 'Lead'); pick.run();
  assert.equal(roleDd.dataset.value, 'lead'); assert.equal(roleDd.closest('form').dataset.adminDirty, 'true');
  const adding = f.run('recruitAddRole')(rolesVeil.querySelector('[data-action="recruit-role-form"]'));
  const putRole = f.requests.find((r) => r.method === 'PUT' && r.url === '/recruit/cycles/cy-a/roles/r%40cornell.edu');
  assert.ok(putRole, 'adding sends one PUT for the member'); same(putRole.body.roles, ['lead']); assert.match(putRole.body.requestId, /^rq-/);
  putRole.resolve({ role: { member: 'r@cornell.edu', roles: ['lead'], subteams: [], ts: 1 } }); await adding;
  assert.equal(f.toasts.at(-1), 'Lead added');
  assert.match(rolesVeil.querySelector('[data-rc="roles-body"]').innerHTML, /Rae/, 'the list repaints in place');
  assert.equal(st0.cycle.grants.length, 1, 'the cycle knows its new grant');
  f.ctx.UI.modal = null; f.ctx.UI.route.params.sub = 'coffee';
  const sw = f.app.querySelector('[data-m="recruit-cycle-switch"]');
  f.run('RECRUIT.dd.bind(RECRUIT)')(sw, 'cy-b'); assert.equal(f.navs.at(-1), '#/applications/cy-b/coffee', 'switching cycles keeps the panel');
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
  assert.match(f.app.innerHTML, /class="rc-seg rc-seg--mode"/, 'a lead sees Responses | Edit form on the tab');
  assert.match(f.app.innerHTML, /rc-seg__thumb/, 'with a thumb that slides');
  assert.match(f.app.innerHTML, />Edit form</);
  const barSwitch = f.app.querySelector('[data-action="recruit-mode-open"][data-form="coffee"]');
  assert.ok(barSwitch && !barSwitch.checked, 'the tab bar carries a switch for the form, off while it is closed');
  // Flipping it saves at once; the editor's own switch follows without turning dirty.
  barSwitch.checked = true;
  const flipping = f.run('RECRUIT.click.bind(RECRUIT)')('recruit-mode-open', barSwitch, { stopPropagation() {} }, () => {});
  await f.settle();
  const flip = f.requests.filter((r) => r.method === 'PUT').at(-1);
  assert.equal(flip.url, '/recruit/cycles/cy-a/settings/site'); same(flip.body.settings, { sections: { coffee: { open: true } } });
  flip.resolve({ cycle: { ...cycleRow(), version: 4 } }); await flipping; await f.settle();
  assert.equal(f.toasts.at(-1), 'Coffee chats is open on the website');
  assert.ok(f.app.querySelector('[data-action="recruit-mode-open"][data-form="coffee"]').checked, 'the bar repaints with the saved state');
  assert.equal(f.run("recruitSections(recruitCycleRow()).coffee.open"), true);
  f.ctx.st = st;
  f.run("recruitSections(recruitCycleRow()).coffee.open = false; recruitState().cycle.sections.coffee.open = false");
  assert.match(f.app.innerHTML, /href="#\/applications\/cy-a\/coffee\?edit=1"/, 'the Form view is a link');
  assert.match(f.app.innerHTML, /href="https:\/\/cornellphysicalintelligence\.com\/apply\/coffee\/"[^>]*>\/apply\/coffee</, 'the address of the form is shown even while closed');
  assert.match(f.app.innerHTML, /data-action="recruit-copy-link" data-link="https:\/\/cornellphysicalintelligence\.com\/apply\/coffee\/"/, 'and can be copied');
  assert.doesNotMatch(f.app.innerHTML, /and at/, 'a closed form is not the /apply form');
  f.mount();
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
  assert.equal(f.app.querySelectorAll('[data-action="recruit-fe-up"], [data-action="recruit-fe-down"]').length, 0, 'no arrow buttons; the grip moves a card');
  const grip = f.app.querySelector('.fe-q[data-i="2"] .fe-q__grip');
  assert.ok(grip, 'every card has a grip');
  const keyed = { key: 'ArrowUp', target: grip, preventDefault() {} };
  assert.equal(f.run('RECRUIT.keydown.bind(RECRUIT)')(keyed), true);
  assert.equal(f.app.querySelector('.fe-q[data-i="1"] [data-m="recruit-fe-label"]').value, 'Which day works for you?', 'ArrowUp on the grip moves the card up');
  assert.ok(f.document.activeElement === f.app.querySelector('.fe-q[data-i="1"] .fe-q__grip'), 'the grip keeps focus on its card');
  assert.equal(f.run('RECRUIT.keydown.bind(RECRUIT)')({ key: 'ArrowDown', target: f.app.querySelector('.fe-q[data-i="1"] .fe-q__grip'), preventDefault() {} }), true);
  assert.equal(f.app.querySelector('.fe-q[data-i="2"] [data-m="recruit-fe-label"]').value, 'Which day works for you?', 'ArrowDown moves it back');
  assert.equal(f.run('RECRUIT.keydown.bind(RECRUIT)')({ key: 'a', target: grip, preventDefault() {} }), false);
  const open = f.app.querySelector('[data-action="recruit-fe-open"]'); open.checked = true; await click('recruit-fe-open');
  const landing = f.app.querySelector('[data-action="recruit-fe-landing"]'); landing.checked = true; await click('recruit-fe-landing');
  assert.ok(f.app.querySelector('[data-rc="fe-options"] [data-action="recruit-fe-notify"]').checked, 'emailing the team is on by default');
  const replace = f.app.querySelector('[data-action="recruit-fe-replace"]'); replace.checked = false; await click('recruit-fe-replace');
  const note = f.app.querySelector('[data-rc="fe-notify-default"]');
  assert.ok(!note.hidden && /Nobody is emailed until an address is added/.test(note.textContent), 'with no addresses the row says nobody is emailed');
  await click('recruit-fe-recipient-add');
  const recipient = f.app.querySelector('[data-m="recruit-fe-recipient"][data-j="0"]');
  assert.ok(recipient, 'the email row grows a recipient input');
  type('recruit-fe-recipient', 'nope', undefined, 0);
  assert.ok(f.app.querySelector('[data-rc="fe-notify-default"]').hidden, 'once an address is written the line goes');
  const requestsBefore = f.requests.length;
  await click('recruit-fe-save'); await f.settle();
  assert.match(f.app.querySelector('[data-rc="fe-foot"]').textContent, /"nope" is not an email address/, 'a bad address stops the save');
  assert.equal(f.requests.length, requestsBefore, 'nothing was sent');
  type('recruit-fe-recipient', ' Lead@Cornell.edu ', undefined, 0);
  type('recruit-fe-capacity', '40');
  type('recruit-fe-desc', 'Grab a coffee.');
  type('recruit-fe-thanks', ' A member will write to you. ');
  const saving = click('recruit-fe-save');
  await f.settle();
  const put = f.requests.at(-1);
  assert.equal(put.url, '/recruit/cycles/cy-a/settings/site'); assert.equal(put.method, 'PUT'); assert.equal(put.body.version, 4, 'the version the bar switch brought back');
  const saved = put.body.settings.sections.coffee;
  assert.equal(put.body.settings.landing, 'coffee', 'the /apply choice rides with the save');
  assert.equal(saved.open, true); assert.equal(saved.description, 'Grab a coffee.'); assert.equal(saved.thanks, 'A member will write to you.', 'what applicants read after sending rides along, trimmed');
  assert.deepEqual([saved.notify, saved.replace, saved.capacity], [true, false, 40], 'the form\'s own email, replace and cap settings ride with the save');
  assert.deepEqual(saved.notifyTo, ['lead@cornell.edu'], 'its recipients ride along, trimmed and lowercased');
  same(saved.form.questions.map((q) => q.key), ['name', 'email', 'which_day_works_for_you'], 'a new question gets a key from its label');
  same(saved.form.questions[2], { key: 'which_day_works_for_you', type: 'single', label: 'Which day works for you?', help: '', required: true, options: ['Monday', 'Friday'] });
  assert.match(f.app.querySelector('[data-rc="fe-foot"]').innerHTML, /Saving…/);
  put.resolve({ cycle: { ...cycleRow(), version: 4, doc: { ...cycleRow().doc, site: { landing: 'coffee' } } } }); await saving; await f.settle();
  assert.ok(f.app.querySelector('[data-action="recruit-fe-save"]').disabled, 'Save settles');
  assert.equal(f.toasts.at(-1), 'Coffee chats saved · live on the website');
  assert.ok(f.app.querySelector('[data-action="recruit-mode-open"][data-form="coffee"]').checked, 'the tab bar shows the saved state');
  assert.match(f.app.innerHTML, /and at <a class="rc-mode__link" href="https:\/\/cornellphysicalintelligence\.com\/apply\/"/, 'the tab bar says this form is the one at /apply');
  await click('recruit-copy-link');
  assert.equal(f.toasts.at(-1), 'Link copied');
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
  // The + opens a small dialog; creating a form is one PUT, then the cycle reloads on that form's editor.
  await click('recruit-form-new');
  assert.equal(f.ctx.UI.modal.kind, 'recruit-form-new');
  const newForm = f.mountModal();
  newForm.querySelector('[name="title"]').value = 'Coffee chats, round 2';
  const fromDd = newForm.querySelector('[data-m="recruit-form-from"]');
  f.run('RECRUIT.dd.bind(RECRUIT)')(fromDd); f.menus.at(-1).items.find((i) => i.label === 'A copy of Coffee chats').run();
  const creating = f.run('recruitCreateForm()');
  await f.settle();
  const create = f.requests.filter((r) => r.method === 'PUT').at(-1);
  assert.equal(create.url, '/recruit/cycles/cy-a/settings/site');
  const newKey = Object.keys(create.body.settings.sections)[0];
  assert.equal(newKey, 'coffee-chats-round-2', 'the key comes from the title');
  assert.equal(create.body.settings.sections[newKey].title, 'Coffee chats, round 2');
  assert.equal(create.body.settings.sections[newKey].open, false, 'a new form starts closed');
  assert.deepEqual(create.body.settings.sections[newKey].form.questions.map((q) => q.key), ['name', 'email', 'which_day_works_for_you'], 'a copy takes the source form\'s questions');
  create.resolve({ cycle: { ...cycleRow(), version: 5 } }); await creating; await f.settle();
  assert.equal(f.toasts.at(-1), 'Coffee chats, round 2 added');
  assert.equal(f.navs.at(-1), `#/applications/cy-a/${newKey}?edit=1`, 'it opens on the new form\'s editor');
  // A cycle with its own forms shows them as tabs and columns.
  const g = fixture();
  const gst = loadCycle(g);
  gst.cycle.sections = { ...sections(), 'coffee-2': { title: 'Round 2', description: '', open: true, form: { questions: [{ key: 'name', type: 'short', label: 'Name', required: true }, { key: 'email', type: 'email', label: 'Email', required: true }] } } };
  same(g.run("RECRUIT.panels(recruitCycleRow(), 'admin').map((p) => p.id)"), ['people', 'interest', 'coffee', 'application', 'coffee-2'], 'the tabs are the cycle\'s forms');
  g.ctx.UI.route.params.sub = 'coffee-2'; g.mount();
  assert.match(g.app.innerHTML, /aria-current="page"[^>]*>Round 2</, 'a form of the cycle\'s own is a tab by its title');
  g.ctx.UI.route.params.sub = 'people'; g.mount();
  assert.match(g.app.querySelector('.sheet--people thead').innerHTML, /Forms sent/, 'participation has one scalable column');
  g.ctx.UI.route.params.sub = 'coffee-2'; g.ctx.UI.route.params.edit = '1'; g.mount();
  assert.match(g.app.querySelector('[data-rc="fe-options"]').innerHTML, /Remove this form/, 'a form of the cycle\'s own can be removed from its editor');
  g.ctx.UI.route.params.sub = 'interest'; g.mount();
  assert.match(g.app.querySelector('[data-rc="fe-options"]').innerHTML, /Remove this form/, 'so can the interest form');
  assert.ok(g.app.querySelector('[data-action="recruit-form-remove"][data-form="interest"]').disabled, 'but not while it has responses');
  gst.cycle.sections.people = { title: 'People intake', open: true, form: { questions: gst.cycle.sections['coffee-2'].form.questions } };
  g.ctx.UI.route.params.sub = 'form:people'; g.mount();
  assert.ok(g.app.querySelector('[data-rc="form-editor"][data-section="people"]'), 'an existing form named people has its own editor route');
  assert.match(g.app.innerHTML, /cy-a\/form:people\?edit=1/);
  assert.ok(g.app.querySelector('[data-m="recruit-panel-switch"]'), 'many forms use a custom dropdown');
  const draftPreview = g.run("recruitFormPreviewHtml(recruitFormEditor(recruitCycleRow(), 'people'))");
  assert.match(draftPreview, /Preview · current draft/);
  assert.doesNotMatch(draftPreview, /data-m="recruit-fe-label"|<select|<datalist/);
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
  f.run("recruitOpenPerson('two@cornell.edu', { form: 'interest' })");
  assert.equal(f.renders.length, 0, 'opening appends the dialog in place; the page behind it is not rebuilt');
  assert.ok(f.ctx.UI.modal.inPlace, 'the dialog is marked for an in-place close');
  const dialog = f.document.querySelector('.rc-person');
  assert.ok(dialog, 'the veil is in the document');
  assert.equal(dialog.dataset.person, 'two@cornell.edu');
  assert.match(dialog.querySelector('[data-rc="person-identity"]').innerHTML, /Two<\/h3>/, 'the sheet row names the person before their detail arrives');
  assert.match(dialog.querySelector('[data-rc="person-nav"]').innerHTML, /2 of 2/, 'Previous and Next walk the sheet, one entry per person');
  const detailReq = f.requests.find((r) => r.url === '/recruit/cycles/cy-a/people/two%40cornell.edu');
  assert.ok(detailReq, 'the person loads by email');
  assert.ok(f.requests.some((r) => r.url === '/recruit/cycles/cy-a/people/%22x%22%40cornell.edu'), 'the neighbour loads ahead of time');
  const prev = dialog.querySelector('[data-action="recruit-person-prev"]');
  prev.focus();
  f.run('recruitStepPerson(-1)');
  assert.equal(f.renders.length, 0, 'stepping never re-renders: the window stays');
  assert.equal(f.ctx.UI.modal.email, '"x"@cornell.edu');
  assert.equal(dialog.dataset.person, '"x"@cornell.edu');
  assert.match(dialog.querySelector('[data-rc="person-nav"]').innerHTML, /1 of 2/);
  assert.ok(dialog.querySelector('[data-action="recruit-person-prev"]').disabled, 'Previous stays drawn, disabled at the start');
  assert.ok(dialog.contains(f.document.activeElement), 'focus stays in the dialog');
  f.run('recruitStepPerson(-1)');
  assert.equal(f.ctx.UI.modal.email, '"x"@cornell.edu', 'a spare click at the start is harmless');
  f.run('recruitStepPerson(1)');
  assert.equal(f.ctx.UI.modal.email, 'two@cornell.edu'); assert.equal(f.renders.length, 0);
  console.log('PASS: Previous and Next swap the person inside the open dialog without a render, prefetch neighbours, and keep focus');
}

/* ------------------------------- people ---------------------------------- */
{
  const f = fixture();
  const st = loadCycle(f);
  f.ctx.UI.route.params.sub = 'people';
  f.mount();
  f.run("RECRUIT.mount({ name: 'recruit', params: { id: 'cy-a', sub: 'people' } })");
  const req = f.requests.find((r) => r.url.startsWith('/recruit/cycles/cy-a/people?'));
  assert.ok(req, 'the People tab loads everyone once');
  assert.match(f.app.innerHTML, /Loading…/);
  assert.match(f.app.innerHTML, /data-m="recruit-people-filter"/, 'People filters by flag and comments');
  assert.match(f.app.innerHTML, /people\.csv/, 'a lead can export the people');
  req.resolve({ rows: [
    { email: 'a@cornell.edu', name: 'Ada', cornell: true, subteam: 'Software', year: 'Junior', first: 1, last: 3, latest: 'p-a2', flagged: true, comments: 2, reviewVersion: 3, sections: {
      interest: { id: 'p-a1', section: 'interest', name: 'Ada', email: 'a@cornell.edu', ts: 1 },
      coffee: { id: 'p-a2', section: 'coffee', name: 'Ada', email: 'a@cornell.edu', ts: 3 } } },
    { email: 'b@cornell.edu', name: '<b>Bo</b>', cornell: true, subteam: '', year: null, first: 2, last: 2, latest: 'p-b1', flagged: false, comments: 0, reviewVersion: 0, sections: {
      application: { id: 'p-b1', section: 'application', name: '<b>Bo</b>', email: 'b@cornell.edu', ts: 2 } } },
  ], total: 2, counts: { people: 2, flagged: 1, bySection: { interest: 1, coffee: 1, application: 1 } } });
  await f.settle();
  assert.equal(f.renders.length, 0); assert.equal(f.backgrounds.length, 0, 'people paint in place');
  const body = f.app.querySelector('[data-rc="people-rows"]');
  assert.equal(body.querySelectorAll('tr').length, 2, 'one row per person');
  assert.match(body.innerHTML, /&lt;b&gt;Bo&lt;\/b&gt;/); assert.doesNotMatch(body.innerHTML, /<b>Bo/);
  assert.equal(body.querySelectorAll('[data-action="recruit-person-open"][data-email="a@cornell.edu"]').length, 6, 'identity, desktop and mobile form links, and comments open the person');
  assert.equal(body.querySelector('[data-action="recruit-person-open"][data-email="a@cornell.edu"][data-form="interest"]').dataset.form, 'interest', 'a form cell opens the person at that form');
  const ada = body.querySelector('tr[data-email="a@cornell.edu"]');
  const adaFlag = ada.querySelector('[data-action="recruit-person-flag"][data-email="a@cornell.edu"]');
  assert.ok(adaFlag && adaFlag.classList.contains('is-flagged') && adaFlag.getAttribute('aria-pressed') === 'true', 'the row flags the person with the list\'s own control');
  const adaComments = ada.querySelector('.interest-comments');
  assert.ok(adaComments.classList.contains('has-comments') && adaComments.innerHTML.includes('<span>2</span>') && adaComments.dataset.comments === 'true' && adaComments.dataset.email === 'a@cornell.edu', 'the row shows the thread size and opens the person at the thread');
  const bo = body.querySelector('tr[data-email="b@cornell.edu"]');
  assert.ok(!bo.querySelector('.interest-flag.is-flagged') && !bo.querySelector('.interest-comments.has-comments'), 'an unflagged person without comments shows quiet controls');
  assert.match(f.app.querySelector('.sheet--people thead').innerHTML, /data-col="review"/, 'People has the review column');
  assert.equal(f.app.querySelector('[data-rc="people-counts"]').textContent, '2 people · 1 flagged · Interest form 1 · Coffee chats 1 · Application form 1');
  const q = f.app.querySelector('[data-m="recruit-people-q"]');
  q.value = 'bo'; assert.equal(f.run('RECRUIT.input.bind(RECRUIT)')(q, { type: 'input' }), true);
  const allRows = f.run('recruitState().people.rows');
  f.run('recruitLoadPeople()');
  const searched = f.requests.at(-1);
  assert.match(searched.url, /q=bo/, 'search runs on the server across all pages');
  searched.resolve({rows: [allRows[1]], total: 1}); await f.settle();
  assert.equal(body.querySelectorAll('tr').length, 1);
  q.value = ''; f.run('recruitState().people.q = ""');
  const filter = f.app.querySelector('[data-m="recruit-people-filter"]');
  f.run('RECRUIT.dd.bind(RECRUIT)')(filter); f.menus.at(-1).items.find((i) => i.label === 'Flagged').run();
  assert.match(f.requests.at(-1).url, /flagged=1/);
  f.requests.at(-1).resolve({rows:[allRows[0]],total:1}); await f.settle();
  assert.equal(body.querySelectorAll('tr').length, 1);
  f.run('RECRUIT.dd.bind(RECRUIT)')(filter); f.menus.at(-1).items.find((i) => i.label === 'All people').run();
  f.requests.at(-1).resolve({rows:allRows,total:2}); await f.settle();
  assert.equal(body.querySelectorAll('tr').length, 2);
  f.run("recruitOpenPerson('a@cornell.edu', { form: 'interest' })");
  assert.equal(f.ctx.UI.modal.email, 'a@cornell.edu');
  assert.ok(f.document.querySelector('.rc-person'), 'a person opens from the People tab without the section sheet');
  assert.match(f.document.querySelector('.rc-person [data-rc="person-nav"]').innerHTML, /1 of 2/, 'Previous and Next count people');
  assert.match(f.document.querySelector('.rc-person [data-rc="person-flag"]').innerHTML, /aria-pressed="true"/, 'the flag shows before the detail arrives');
  f.run('recruitStepPerson(1)');
  assert.equal(f.ctx.UI.modal.email, 'b@cornell.edu', 'Next moves to the next person');
  f.run("recruitAcceptPersonReview('a@cornell.edu', { person: { email: 'a@cornell.edu', name: 'Ada', flagged: false, review: { comments: [] }, reviewVersion: 4 } })");
  assert.ok(!f.app.querySelector('tr[data-email="a@cornell.edu"] .interest-flag.is-flagged') && !f.app.querySelector('tr[data-email="a@cornell.edu"] .interest-comments.has-comments'), 'review changes repaint the person\'s row');
  console.log('PASS: People lists everyone across the three forms with their flag and thread, escapes, searches and filters in place, opens any person at any form, and steps by person');
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
  cycleReq.resolve({ cycle: cycleRow(), counts: { total: 1, bySection: {} }, me: { roles: ['admin'] } }); await f.settle();
  const st = f.run('recruitState()');
  assert.equal(st.cycleId, 'cy-b'); assert.equal(st.cycle?.loading, true, 'a late cycle answer after a switch is dropped');
  const bReq = f.requests.find((r) => r.url === '/recruit/cycles/cy-b');
  bReq.resolve({ cycle: cycleRow({ id: 'cy-b', name: 'B' }), counts: { total: 0, bySection: {} }, me: { roles: ['admin'] } }); await f.settle();
  assert.equal(st.cycle.data.id, 'cy-b'); assert.equal(st.cycle.role, 'admin');
  f.run("RECRUIT.mount({ name: 'recruit', params: { id: 'cy-b' } })");
  const peopleReq = f.requests.find((r) => r.url.startsWith('/recruit/cycles/cy-b/people?'));
  assert.ok(peopleReq, 'a cycle opens on People, which loads everyone');
  f.ctx.UI.route = { name: 'recruit', params: { id: 'cy-b', sub: 'interest' } };
  f.run("RECRUIT.mount({ name: 'recruit', params: { id: 'cy-b', sub: 'interest' } })");
  const listReq = f.requests.find((r) => r.url.startsWith('/recruit/cycles/cy-b/applications?'));
  assert.ok(listReq, 'the section panel mount loads the first page');
  f.run("RECRUIT.reset('cy-a')");
  listReq.resolve({ rows: [{ id: 'in-9', name: 'Late', email: 'l@x.y', ts: 1 }], next: null, total: 1 });
  peopleReq.resolve({ rows: [{ email: 'l@x.y', name: 'Late', latest: 'in-9', sections: { interest: { id: 'in-9' } } }], total: 1 }); await f.settle();
  assert.equal(st.apps, undefined, 'a late list answer after a cycle switch is dropped');
  assert.equal(st.people, undefined, 'a late people answer after a cycle switch is dropped');
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
  await f.settle();
  f.requests.at(-1).resolve({ cycle: st.cycle.data, sections: st.cycle.sections, counts: { total: 7, bySection: { interest: 4, coffee: 3 } } });
  await f.settle();
  assert.match(f.requests.at(-1).url, /applications\?/);
  f.requests.at(-1).resolve({ rows: st.apps.rows, total: 4, counts: {bySection:{interest:4,coffee:3}} });
  await tick;
  assert.equal(f.app.querySelector('[data-rc-count="interest"]').textContent, '4', 'counts repaint in place');
  assert.equal(f.renders.length, 0); assert.equal(f.backgrounds.length, 0, 'the sync loop never repaints the whole route');
  assert.ok(st._syncTimer, 'the loop rescheduled itself'); f.run('clearTimeout(recruitState()._syncTimer)');
  f.ctx.UI.modal = { kind: 'confirm' };
  const quiet = f.run('recruitSyncTick()'); await quiet;
  assert.equal(f.requests.length, 3, 'no fetch while a dialog is open'); f.run('clearTimeout(recruitState()._syncTimer)');
  f.ctx.UI.modal = null; f.ctx.UI.route = { name: 'home', params: {} };
  f.run('RECRUIT.sync()'); assert.equal(st._syncTimer, null, 'leaving the route stops the loop');
  console.log('PASS: the sync loop repaints counts in place and stays quiet behind dialogs');
}

/* ------------------------------- person dialog --------------------------- */
{
  const f = fixture();
  const st = loadCycle(f);
  const email = '"x"@cornell.edu';
  const path = '/recruit/cycles/cy-a/people/%22x%22%40cornell.edu';
  const first = { id: 'ic-first', text: 'Existing <comment>', name: 'Reviewer', by: 'r@cornell.edu', ts: 1 };
  st.persons = { [email]: { person: { email, name: '<img src=x onerror=alert(1)>', flagged: false, review: { comments: [first] }, reviewVersion: 1, latest: 'in-1' }, submissions: [
    { application: { id: 'in-1', name: '<img src=x onerror=alert(1)>', email, ts: 1, section: 'interest', subteam: 'Electrical', year: 'Junior', answers: { project: 'A <robot>' }, files: [{ id: 'int-1', name: 'cv.pdf', size: 2048 }] }, form: { questions: [{ key: 'project', type: 'long', label: 'Coolest project' }] } },
    { application: { id: 'in-1c', name: '<img src=x onerror=alert(1)>', email, ts: 5, section: 'coffee', subteam: '', year: null, answers: { availability: 'Tuesdays' }, files: [] }, form: { questions: [{ key: 'availability', type: 'long', label: 'When are you free?' }] } },
  ], history: [{ cycleId: 'cy-old', cycleName: 'Spring 2025', section: 'interest', ts: 1 }] } };
  f.ctx.UI.modal = { kind: 'recruit-person', email, form: 'interest' };
  f.mount();
  const veil = f.mountModal();
  const html = veil.innerHTML;
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /A &lt;robot&gt;/); assert.match(html, /Existing &lt;comment&gt;/);
  assert.match(html, /href="\/api\/recruit\/files\/int-1" download="cv\.pdf"/, 'files link only the authenticated route');
  const imageHtml = f.run('recruitAnswersHtml')({
    application: { answers: { portfolio: '' }, files: [{ id: 'int-image', question: 'portfolio', name: 'robot.png', type: 'image/png', size: 68 }] },
    form: { questions: [{ key: 'portfolio', type: 'longfile', label: 'Portfolio' }] },
  });
  assert.match(imageHtml, /href="\/api\/recruit\/files\/int-image" download="robot\.png"/, 'an image-only answer exposes its download even when its text is empty');
  assert.match(imageHtml, /Portfolio: robot\.png/);
  assert.match(imageHtml, /File attached below\./);
  assert.doesNotMatch(imageHtml, /Left blank\./, 'an image-only answer is not labeled blank');
  assert.match(html, /Also sent Spring 2025/); assert.doesNotMatch(html, /<select/);
  assert.match(html, /1 of 2<\/span>/); assert.match(html, /data-action="modal-close"/);
  assert.equal(veil.querySelectorAll('[data-action="recruit-person-form"]').length, 2, 'both forms they sent are offered');
  assert.equal(veil.querySelector('[data-action="recruit-person-form"][data-form="interest"]').getAttribute('aria-current'), 'page');
  // Switching forms repaints the answers, not the thread.
  const thread = veil.querySelector('.interest-thread');
  await f.run('RECRUIT.click.bind(RECRUIT)')('recruit-person-form', veil.querySelector('[data-action="recruit-person-form"][data-form="coffee"]'), { stopPropagation() {} }, () => {});
  assert.match(veil.querySelector('[data-rc="person-main"]').innerHTML, /Tuesdays/, 'the coffee chat answers show');
  assert.doesNotMatch(veil.querySelector('[data-rc="person-main"]').innerHTML, /A &lt;robot&gt;/);
  assert.ok(veil.querySelector('.interest-thread') === thread, 'the thread is the person\'s, untouched by the form switch');
  const field = veil.querySelector('.interest-compose textarea');
  field.value = 'New <comment>';
  assert.equal(f.run('RECRUIT.input.bind(RECRUIT)')(field, { type: 'input' }), true);
  const draft = st.drafts['person:' + email];
  assert.equal(draft.text, 'New <comment>');
  const existingNode = veil.querySelector('[data-comment-id="ic-first"]');
  // A background refresh brings a second comment and a changed answer.
  const second = { id: 'ic-second', text: 'Later', name: 'Lead', ts: 2 };
  f.run('recruitLoadPerson')(email, { quiet: true });
  const req = f.requests.find((r) => r.url === path);
  assert.ok(req.signal instanceof AbortSignal);
  const before = st.persons[email];
  req.resolve({ person: { ...before.person, review: { comments: [first, second] }, reviewVersion: 2 }, submissions: before.submissions.map((x) => (x.application.section === 'coffee' ? { ...x, application: { ...x.application, answers: { availability: 'Changed' } } } : x)), history: before.history });
  await f.settle();
  assert.equal(field.value, 'New <comment>', 'the composer keeps its unsent text across a background refresh');
  assert.equal(field.isConnected, true, 'the composer node is never replaced');
  assert.equal(draft.text, 'New <comment>');
  assert.ok(veil.querySelector('[data-comment-id="ic-first"]') === existingNode, 'existing comments keep their DOM identity');
  assert.ok(veil.querySelector('[data-comment-id="ic-second"]'), 'new comments are appended');
  assert.equal(veil.querySelector('.interest-subhead .count').textContent, '2');
  assert.match(veil.querySelector('[data-rc="person-main"]').innerHTML, /Changed/, 'answers repaint in place');
  assert.equal(f.renders.length, 0); assert.equal(f.backgrounds.length, 0, 'the open dialog is never remounted');
  // Posting keeps its id across a timeout, then succeeds.
  const posting = f.run('recruitPostPersonComment')(email);
  assert.equal(field.readOnly, true);
  const post = f.requests.find((r) => r.method === 'POST' && r.url === path + '/comments');
  assert.match(post.body.id, /^ic-/); assert.equal(post.body.text, 'New <comment>'); assert.ok(post.signal instanceof AbortSignal);
  post.reject(Object.assign(new Error('Timed out'), { name: 'TimeoutError' })); await posting;
  assert.match(veil.querySelector('[data-comment-error]').textContent, /retrying will not post it twice/);
  assert.equal(field.value, 'New <comment>'); assert.equal(field.readOnly, false);
  const retry = f.run('recruitPostPersonComment')(email);
  const post2 = f.requests.filter((r) => r.method === 'POST' && r.url === path + '/comments')[1];
  assert.equal(post2.body.id, post.body.id, 'a lost response is retried with the same ic- id');
  const saved = { id: post2.body.id, text: 'New <comment>', name: 'Lead', ts: 3 };
  post2.resolve({ person: { email, name: 'X', flagged: false, reviewVersion: 3, review: { comments: [first, second, saved] } } }); await retry;
  assert.equal(f.toasts.at(-1), 'Comment posted'); assert.equal(field.value, '');
  assert.match(veil.querySelector('.interest-thread').innerHTML, /New &lt;comment&gt;/);
  assert.equal(f.renders.length, 0);
  // Deleting confirms inline and toasts.
  f.run('recruitConfirmPersonCommentRemoval')(email, 'ic-first');
  assert.match(existingNode.innerHTML, /Delete this comment\?/);
  const deleting = f.run('recruitDeletePersonComment')(email, 'ic-first');
  const del = f.requests.find((r) => r.method === 'DELETE');
  assert.equal(del.url, path + '/comments/ic-first');
  del.resolve({ person: { email, name: 'X', flagged: false, reviewVersion: 4, review: { comments: [second, saved] } } }); await deleting;
  assert.equal(f.toasts.at(-1), 'Comment deleted'); assert.equal(veil.querySelector('[data-comment-id="ic-first"]'), null);
  // Flag round trip, on the person.
  const flagging = f.run('recruitTogglePersonFlag')(email);
  const patch = f.requests.find((r) => r.method === 'PATCH');
  assert.equal(patch.url, path + '/review'); same(patch.body, { flagged: true });
  patch.resolve({ person: { email, name: 'X', flagged: true, reviewVersion: 5, review: { flagged: true, comments: [second, saved] } } }); await flagging;
  assert.equal(st.persons[email].person.flagged, true); assert.equal(f.toasts.at(-1), 'Flagged for follow-up');
  assert.match(veil.querySelector('[data-rc="person-flag"]').innerHTML, /aria-pressed="true"/);
  // Previous / Next walk the sheet by person.
  f.run('recruitStepPerson(1)'); assert.equal(f.ctx.UI.modal.email, 'two@cornell.edu'); assert.equal(f.renders.length, 0, 'stepping swaps the person in place; the dialog never remounts');
  console.log('PASS: the person dialog escapes everything, switches between the forms they sent, keeps a dirty comment draft across background refreshes, retries with the same ic- id, flags the person, and never remounts while open');
}

/* ------------------------------- merges + toasts ------------------------- */
{
  const f = fixture();
  const st = loadCycle(f);
  f.mount();
  st.selected = new Set(['in-1', 'in-2']);
  await f.run("RECRUIT.click('recruit-copy-emails', document.querySelector('[data-action=\"recruit-copy-emails\"]') || document.createElement('button'), { preventDefault() {}, stopPropagation() {} }, () => {})");
  assert.equal(f.toasts.at(-1), 'Copied 2 emails as CSV');
  // Bulk delete: a typed confirm, one DELETE per id, rows drop, dialog on a removed row closes.
  f.run("recruitConfirmRemoval(['in-1', 'in-2'])");
  assert.equal(f.ctx.UI.modal.kind, 'confirm'); assert.equal(f.ctx.UI.modal.typed, 'delete responses'); assert.equal(f.ctx.UI.modal.danger, true);
  const go = f.ctx.UI.modal.onGo; f.ctx.UI.modal = { kind: 'recruit-person', email: '"x"@cornell.edu' };
  const removing = go();
  const dels = f.requests.filter((r) => r.method === 'DELETE');
  assert.equal(dels.length, 2); dels.forEach((r) => r.resolve({ ok: true })); await removing;
  assert.equal(st.apps.rows.length, 0); assert.equal(f.closes.length, 1, 'an open person dialog closes when submissions are deleted');
  assert.equal(f.toasts.at(-1), 'Deleted 2 responses');
  console.log('PASS: copy and delete toast their counts, and removal closes the open dialog');
}

console.log('PASS: recruit UI — registry, cycle index, sheet, dialog, sync and merges');
