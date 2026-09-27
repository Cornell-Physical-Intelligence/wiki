// The recruit client (registry, cycle shell, cycle index, flow chart, a
// stage's page, People, a person's page, Insights) run whole inside vm
// against a small tree-based DOM fixture. No network, browser, production
// data or credentials are used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const files = { core: 'recruit-core.js', cycles: 'recruit-cycles.js', flow: 'recruit-flow.js', stage: 'recruit-stage.js', people: 'recruit-people.js', person: 'recruit-person.js', insights: 'recruit-insights.js' };
const src = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([k, f]) => [k, await read(`../src/client/${f}`)])));
const ui2 = await read('../src/client/ui2.js');
const main = await read('../src/client/main.js');
const assemble = await read('./assemble.mjs');
const ddSource = ui2.slice(ui2.indexOf('function dd('), ui2.indexOf('const ddSections'));
const focusSource = main.slice(main.indexOf('function focusReference('), main.indexOf('function modalFocusables('));
const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);
const unesc = (s) => String(s).replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&#39;', "'").replaceAll('&amp;', '&');

// Marker comments slice each module; every module registers exactly once,
// the build concatenates them in this order, and no template holds a native
// select or datalist.
for (const [name, text] of Object.entries(src)) {
  assert.ok(text.includes(`// recruit:${name}:start`) && text.includes(`// recruit:${name}:end`), `${name} carries slice markers`);
  assert.equal((text.match(/RECRUIT\.register\(/g) || []).length, name === 'core' ? 0 : 1, `${name} registers once`);
  assert.doesNotMatch(text, /<select|<datalist/i, `${name} has no native select`);
}
assert.match(assemble.replace(/\s+/g, ' '), new RegExp(Object.values(files).map((f) => `read\\('${f.replace('.', '\\.')}'\\)`).join(', ')), 'the build concatenates the modules after the core, in order');

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
      add: (...cs) => { for (const c of cs) if (!self.classList.contains(c)) self.attrs.class = [...self.classList.list(), c].join(' '); },
      remove: (...cs) => { self.attrs.class = self.classList.list().filter((x) => !cs.includes(x)).join(' '); },
      toggle: (c, force) => { (force ?? !self.classList.contains(c)) ? self.classList.add(c) : self.classList.remove(c); },
    };
  }
  get isConnected() { let n = this; while (n) { if (n === this.doc.body) return true; n = n.parentElement; } return false; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  get id() { return this.attrs.id || ''; }
  get className() { return this.attrs.class || ''; } set className(v) { this.attrs.class = v; }
  get hidden() { return this._hidden ?? ('hidden' in this.attrs); } set hidden(v) { this._hidden = Boolean(v); }
  get disabled() { return this._disabled ?? ('disabled' in this.attrs); } set disabled(v) { this._disabled = Boolean(v); }
  get readOnly() { return this._readOnly ?? ('readonly' in this.attrs); } set readOnly(v) { this._readOnly = Boolean(v); }
  get checked() { return this._checked ?? ('checked' in this.attrs); } set checked(v) { this._checked = Boolean(v); }
  get open() { return this._open ?? ('open' in this.attrs); } set open(v) { this._open = Boolean(v); }
  get value() { return this._value ?? (this.tagName === 'TEXTAREA' ? this.textContent : (this.attrs.value || '')); } set value(v) { this._value = String(v); }
  get name() { return this.attrs.name || ''; }
  get tabIndex() { return Number(this.attrs.tabindex ?? 0); }
  get offsetParent() { return this.parentElement; }
  get firstElementChild() { return this.children.find((c) => c.nodeType === 1) || null; }
  get textContent() { return this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { for (const c of this.children) c.parentElement = null; this.children = v === '' ? [] : [Object.assign(new Text(String(v)), { parentElement: this })]; }
  get innerHTML() { return this.children.map((c) => (c.nodeType === 3 ? esc(c.text) : c.outerHTML)).join(''); }
  set innerHTML(h) { if (this.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body; for (const c of this.children) c.parentElement = null; this.children = []; for (const c of parseHtml(h, this.doc)) this.appendChild(c); }
  get outerHTML() { const a = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join(''); const t = this.tagName.toLowerCase(); return VOID.has(t) ? `<${t}${a}>` : `<${t}${a}>${this.innerHTML}</${t}>`; }
  set outerHTML(h) {
    const p = this.parentElement;
    if (!p) return;
    if (this.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body;
    const kids = parseHtml(h, this.doc);
    kids.forEach((k) => { k.parentElement = p; });
    p.children.splice(p.children.indexOf(this), 1, ...kids);
    this.parentElement = null;
  }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  insertAdjacentHTML(pos, h) { const kids = parseHtml(h, this.doc); if (pos === 'afterbegin') { kids.forEach((k) => { k.parentElement = this; }); this.children.unshift(...kids); } else kids.forEach((k) => this.appendChild(k)); }
  remove() { if (this.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body; const p = this.parentElement; if (p) p.children = p.children.filter((c) => c !== this); this.parentElement = null; }
  contains(t) { let n = t; while (n) { if (n === this) return true; n = n.parentElement; } return false; }
  focus() { if (this.isConnected) this.doc.activeElement = this; }
  blur() { if (this.doc.activeElement === this) this.doc.activeElement = this.doc.body; }
  select() {} setSelectionRange() {} addEventListener() {} removeEventListener() {} scrollIntoView() {}
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
    else if (part === ':focus') { if (n.doc.activeElement !== n) return false; }
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
  doc.getElementById = (id) => doc.body.querySelector('#' + id);
  return doc;
}

/* ------------------------------- fixture --------------------------------- */

function fixture({ remote = true, admin = true, me = 'lead@cornell.edu', width = 1440 } = {}) {
  const document = makeDocument();
  const app = document.body.appendChild(new El(document, 'div'));
  app.setAttribute('id', 'app');
  const requests = [], renders = [], backgrounds = [], toasts = [], menus = [], navs = [], closes = [];
  const base = {
    UI: { route: { name: 'recruit', params: {} }, modal: null, menu: null, editor: null, palette: null, toasts: [] },
    Store: { me: () => ({ email: me, name: 'Lead' }), isAdmin: () => admin, userName: (e) => e, relTime: () => 'just now' },
    MD: { esc }, I: new Proxy({}, { get: () => '<svg></svg>' }),
    document, $: (sel, root) => (root || document.body).querySelector(sel), $$: (sel, root) => (root || document.body).querySelectorAll(sel),
    crypto: { randomUUID }, AbortSignal, URLSearchParams, setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clearTimeout, setImmediate, console,
    location: { hash: '' }, window: { open() {}, addEventListener() {}, innerWidth: width },
    localStorage: (() => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) }; })(),
    navigator: { clipboard: { writeText: async () => {} } },
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
    viewModal() { return `<div class="modal-veil" data-action="modal-veil">${run('RECRUIT.modal(UI.modal)')}</div>`; },
    captureModalFocus() {},
    mountModalFocus() { document.body.querySelector('.modal [data-action="modal-close"]')?.focus(); },
  };
  if (remote) base.REMOTE = { pending: 0 };
  const ctx = vm.createContext(base);
  const run = (code) => vm.runInContext(code, ctx);
  vm.runInContext(ddSource + '\n' + focusSource + '\n' + Object.values(src).join('\n'), ctx, { filename: 'recruit-client.js' });
  const settle = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const call = (name) => run(name);
  const click = async (el, ev = {}) => {
    assert.ok(el, 'the control exists');
    return run('RECRUIT.click.bind(RECRUIT)')(el.dataset.action, el, { preventDefault() {}, stopPropagation() {}, ...ev }, () => {});
  };
  const type = (el, value) => { assert.ok(el, 'the field exists'); el.value = value; return run('RECRUIT.input.bind(RECRUIT)')(el, { type: 'input' }); };
  const change = (el, value) => { assert.ok(el, 'the field exists'); el.value = value; return run('RECRUIT.change.bind(RECRUIT)')(el, { type: 'change' }); };
  const pick = (host, label) => { run('RECRUIT.dd.bind(RECRUIT)')(host); const item = menus.at(-1).items.find((i) => i !== '-' && i.label === label); assert.ok(item, `the menu offers ${label}`); item.run(); };
  const pending = async (match, method = 'GET') => { await settle(); const r = requests.find((x) => !x.done && x.method === method && (typeof match === 'string' ? x.url === match : match.test(x.url))); assert.ok(r, `a ${method} request for ${match}`); r.done = true; return r; };
  return { ctx, document, app, requests, renders, backgrounds, toasts, menus, navs, closes, run, call, settle, click, type, change, pick, pending,
    mount() { app.innerHTML = run('viewRecruit()'); return app; },
    mountModal() { document.body.querySelector('.modal-veil')?.remove(); const veil = document.body.appendChild(new El(document, 'div')); veil.setAttribute('class', 'modal-veil'); veil.innerHTML = run('RECRUIT.modal(UI.modal)'); return veil; } };
}

const cycleRow = (over = {}) => ({ id: 'cy-a', version: 3, status: 'open', name: 'Fall 2026', term: 'Fall 2026', updated: 1, closesAt: null, doc: { subteams: [{ key: 'electrical', name: 'Electrical' }, { key: 'software', name: 'Software' }], modules: {}, site: { landing: 'interest' } }, ...over });
const q = (key, type, label, extra = {}) => ({ key, type, label, required: false, ...extra });
const basics = () => [q('name', 'short', 'Name', { required: true, max: 100 }), q('email', 'email', 'Email', { required: true, max: 200 })];
// The stages as GET /recruit/cycles/:id merges them for a cycle saved before
// the flow chart: three forms in order, the coffee chats with their checklist.
const sections = () => ({
  interest: { title: 'Interest form', description: '', open: true, kind: 'form', fields: [], done: null, required: ['name', 'email', 'subteam', 'year', 'project', 'file'], form: { questions: [...basics(), q('subteam', 'single', 'Subteam', { options: ['Electrical', 'Software'] }), q('year', 'single', 'Year', { options: ['Junior', 'Senior'] }), q('project', 'long', 'Coolest project', { max: 1000 }), q('file', 'file', 'Photo or PDF', { accept: ['application/pdf'], maxBytes: 100 })] } },
  coffee: { title: 'Coffee chats', description: 'Grab a coffee.', open: false, kind: 'meeting', done: 'completed', fields: [{ key: 'completed', type: 'check', label: 'Chat completed' }, { key: 'met_with', type: 'text', label: 'Met with' }, { key: 'notes', type: 'note', label: 'Notes' }], required: ['name', 'email'], form: { questions: basics() } },
  application: { title: 'Application form', description: '', open: false, kind: 'form', done: null, fields: [{ key: 'score', type: 'rating', label: 'Score', max: 5, each: true }, { key: 'notes', type: 'note', label: 'Review notes', each: true }], required: ['name', 'email'], form: { questions: basics() } },
});
const insights = () => ({
  people: 3, statuses: { active: 2, accepted: 1, waitlisted: 0, declined: 0, withdrew: 0 }, flagged: 1, commented: 1, medianDays: 4, firstAt: 1700000000000,
  stages: [
    { key: 'interest', title: 'Interest form', kind: 'form', rank: 0, form: true, open: true, doneField: null, here: 1, reached: 3, done: 3, notDone: 0, responses: 3, declined: 0, fields: [] },
    { key: 'coffee', title: 'Coffee chats', kind: 'meeting', rank: 1, form: true, open: false, doneField: 'Chat completed', here: 1, reached: 2, done: 1, notDone: 1, responses: 2, declined: 0, fields: [
      { key: 'completed', label: 'Chat completed', type: 'check', each: false, summary: { yes: 1, of: 2 } },
      { key: 'met_with', label: 'Met with', type: 'text', each: false, summary: { n: 1, top: [{ value: '<Rae>', n: 1 }] } },
      { key: 'notes', label: 'Notes', type: 'note', each: false, summary: { n: 1 } }] },
    { key: 'application', title: 'Application form', kind: 'form', rank: 2, form: true, open: false, doneField: null, here: 0, reached: 1, done: 1, notDone: 0, responses: 1, declined: 0, fields: [
      { key: 'score', label: 'Score', type: 'rating', each: true, max: 5, summary: { n: 2, people: 1, avg: 3.5, max: 5, dist: [0, 0, 1, 1, 0] } },
      { key: 'notes', label: 'Review notes', type: 'note', each: true, summary: { n: 0 } }] },
  ],
  edges: [], daily: [{ day: '2026-09-01', counts: { interest: 2 } }, { day: '2026-09-03', counts: { interest: 1, coffee: 2, application: 1 } }],
  subteams: [{ name: 'Software', n: 2 }, { name: '<b>Bots</b>', n: 1 }], years: [{ name: 'Junior', n: 3 }],
});
// People as GET /recruit/cycles/:id/people lists them.
const people = () => [
  { email: 'ada@cornell.edu', name: 'Ada', cornell: true, subteam: 'Software', year: 'Junior', first: 1, last: 3, latest: 'p-a2', flagged: true, comments: 2, reviewVersion: 3, trackVersion: 2,
    stage: 'coffee', status: 'active', states: { interest: 'done', coffee: 'current', application: 'ahead' }, done: { interest: true, coffee: false }, fields: { coffee: { completed: false, met_with: 'Rae' } },
    sections: { interest: { id: 'p-a1', section: 'interest', ts: 1 }, coffee: { id: 'p-a2', section: 'coffee', ts: 3 } } },
  { email: 'bo@cornell.edu', name: '<b>Bo</b>', cornell: true, subteam: '', year: null, first: 2, last: 2, latest: 'p-b1', flagged: false, comments: 0, reviewVersion: 0, trackVersion: 0,
    stage: 'application', status: 'accepted', states: { interest: 'skipped', coffee: 'skipped', application: 'current' }, done: { application: true }, fields: { application: { score: { n: 2, avg: 3.5, mine: 4 } } },
    sections: { application: { id: 'p-b1', section: 'application', ts: 2 } } },
];
function loadCycle(f, { role = 'admin', roles = ['admin'], sub = 'flow', params = {}, cycle = {}, withInsights = true } = {}) {
  const st = f.run('recruitState()');
  st.me = { admin: roles.includes('admin'), cycles: [{ id: 'cy-a', name: 'Fall 2026', term: 'Fall 2026', status: 'open', roles }] };
  f.ctx.UI.recruitMe = st.me;
  st.cycles = { list: [{ id: 'cy-a', name: 'Fall 2026', term: 'Fall 2026', status: 'open', counts: { total: 3, bySection: { interest: 3, coffee: 2, application: 1 } }, updated: 1, version: 3 }, { id: 'cy-b', name: 'Spring 2027', term: 'Spring 2027', status: 'draft', counts: { total: 0 }, updated: 1, version: 1 }], intakeCycleId: 'cy-a', migration: { done: true, orphans: 0 } };
  st.cycleId = 'cy-a';
  st.cycle = { data: cycleRow(cycle), role, roles, counts: { total: 3, bySection: { interest: 3, coffee: 2, application: 1 } }, sections: sections(), grants: [], team: [{ email: 'lead@cornell.edu', name: 'Lead' }, { email: 'rae@cornell.edu', name: 'Rae' }], email: 'lead@cornell.edu' };
  if (withInsights) st.insights = { key: st.key + ':cy-a', data: insights(), loading: false, error: null, promise: null };
  f.ctx.UI.route = { name: 'recruit', params: { id: 'cy-a', sub, ...params } };
  return st;
}

/* ------------------------------- registry -------------------------------- */
{
  const f = fixture();
  same(f.run('RECRUIT.modules.map((m) => m.name)'), ['cycles', 'flow', 'stage', 'people', 'person', 'insights'], 'modules register in order');
  assert.throws(() => f.run("RECRUIT.register({ name: 'flow', order: 9 })"), /already registered/);
  assert.throws(() => f.run("RECRUIT.register({ name: 'bad', order: 9, actions: { 'nope': () => {} } })"), /must start with recruit-/);
  assert.throws(() => f.run("RECRUIT.register({ name: 'bad', order: 9, changes: { 'nope': () => {} } })"), /must start with recruit-/, 'change handlers are checked like the rest');
  assert.throws(() => f.run("RECRUIT.register({ name: 'noorder' })"), /needs an order/);
  f.ctx.cycle = cycleRow();
  same(f.run("RECRUIT.panels(cycle, 'admin').map((p) => [p.id, p.tab])"), [['flow', true], ['people', true], ['insights', true], ['stage', false], ['person', false]], 'three tabs; a stage and a person are pages of their own');
  f.ctx.zetaCalls = [];
  f.run(`RECRUIT.register({ name: 'zeta', order: 9, panel: { id: 'zeta', label: 'Zeta', order: 4, when: (cycle, role) => role === 'admin' }, view: () => '<p data-zeta>zeta</p>',
    actions: { 'recruit-zeta': (el) => zetaCalls.push(el.dataset.id) }, inputs: { 'recruit-zeta-in': (el) => zetaCalls.push('input:' + el.value) }, changes: { 'recruit-zeta-ch': (el) => zetaCalls.push('change:' + el.value) },
    modals: { 'recruit-zeta': () => '<div class="modal" data-zeta></div>' } })`);
  same(f.run("RECRUIT.panels(cycle, 'admin').filter((p) => p.tab).map((p) => p.id)"), ['flow', 'people', 'insights', 'zeta'], 'a module adds a tab');
  same(f.run("RECRUIT.panels(cycle, 'reviewer').filter((p) => p.tab).map((p) => p.id)"), ['flow', 'people', 'insights'], 'tabs are gated by role');
  f.ctx.cycle = cycleRow({ doc: { modules: { zeta: false } } });
  same(f.run("RECRUIT.panels(cycle, 'admin').filter((p) => p.tab).map((p) => p.id)"), ['flow', 'people', 'insights'], 'a module switched off for the cycle loses its tab');
  assert.match(f.run("RECRUIT.modal({ kind: 'recruit-zeta' })"), /data-zeta/, 'modal kinds resolve through the registry');
  assert.equal(f.run("RECRUIT.modal({ kind: 'recruit-nope' })"), '', 'unknown kinds draw nothing');
  const el = f.run("document.createElement('button')"); el.setAttribute('data-action', 'recruit-zeta'); el.setAttribute('data-id', 'x');
  let stopped = 0, propagation = 0;
  assert.equal(await f.run('RECRUIT.click.bind(RECRUIT)')('recruit-zeta', el, { preventDefault() {}, stopPropagation() {} }, () => { stopped++; }), true);
  same(f.ctx.zetaCalls, ['x']); assert.equal(stopped, 1, 'the dispatcher stops the event for buttons');
  const box = f.run("document.createElement('input')"); box.setAttribute('type', 'checkbox'); box.setAttribute('data-id', 'y');
  await f.run('RECRUIT.click.bind(RECRUIT)')('recruit-zeta', box, { stopPropagation() { propagation++; } }, () => { stopped++; });
  assert.equal(stopped, 1); assert.equal(propagation, 1, 'a checkbox keeps its default: only propagation stops');
  const form = f.run("document.createElement('form')"); form.setAttribute('data-action', 'recruit-zeta');
  assert.equal(await f.run('RECRUIT.click.bind(RECRUIT)')('recruit-zeta', form, {}, () => {}), false, 'a click that lands on a form is not an action');
  assert.equal(await f.run('RECRUIT.click.bind(RECRUIT)')('recruit-unknown', el, {}, () => {}), false);
  const field = f.run("document.createElement('input')");
  field.setAttribute('data-m', 'recruit-zeta-ch'); field.value = 'a';
  assert.equal(f.run('RECRUIT.change.bind(RECRUIT)')(field, {}), true);
  field.setAttribute('data-m', 'recruit-zeta-in'); field.value = 'b';
  assert.equal(f.run('RECRUIT.change.bind(RECRUIT)')(field, {}), true, 'a change without its own handler falls back to the input handler');
  same(f.ctx.zetaCalls, ['x', 'y', 'change:a', 'input:b']);
  console.log('PASS: registry sorts by order, validates every handler group, gates tabs by role and module switch, and dispatches clicks, inputs and changes');
}

/* ------------------------------- the cycle shell ------------------------- */
{
  const f = fixture();
  const st = loadCycle(f, { cycle: { closesAt: Date.UTC(2026, 9, 6, 16) } });
  f.mount();
  const tabs = f.app.querySelectorAll('.rc-tabs [role="tab"]');
  same(tabs.map((t) => t.textContent), ['Flow', 'People', 'Insights']);
  assert.equal(tabs[0].getAttribute('aria-current'), 'page');
  assert.match(f.app.innerHTML, /href="#\/applications\?all=1">Applications<\/a><span class="crumbs__sep">\/<\/span><span class="crumbs__here">Fall 2026</);
  assert.match(f.app.innerHTML, /class="rc-cycle-title" data-action="dd" data-m="recruit-cycle-switch"/, 'the title is the cycle switch');
  assert.ok(f.app.querySelector('.rc-cycle-gear[data-action="recruit-settings-open"]'), 'the gear sits beside the name');
  const meta = f.app.querySelector('.rc-cycle-meta').textContent;
  assert.match(meta, /Open/); assert.match(meta, /Receives the website's forms/); assert.match(meta, /Deadline Oct 6/);
  tabs[0].focus();
  assert.equal(f.run('RECRUIT.keydown.bind(RECRUIT)')({ key: 'ArrowRight', target: tabs[0], preventDefault() {} }), true);
  assert.ok(f.document.activeElement === tabs[1], 'arrow keys rove the tablist');
  assert.equal(f.run('RECRUIT.keydown.bind(RECRUIT)')({ key: 'a', target: tabs[1], preventDefault() {} }), false);
  // A stage's page names itself in the crumbs; the Flow tab stays marked.
  f.ctx.UI.route.params = { id: 'cy-a', sub: 'stage', key: 'coffee' };
  f.mount();
  assert.match(f.app.innerHTML, /<a href="#\/applications\/cy-a">Fall 2026<\/a><span class="crumbs__sep">\/<\/span><span class="crumbs__here">Coffee chats<\/span>/);
  const onStage = f.app.querySelectorAll('.rc-tabs [role="tab"]');
  assert.equal(onStage[0].getAttribute('aria-selected'), 'true'); assert.equal(onStage[0].getAttribute('aria-current'), null, 'the tab is marked but is not the page');
  assert.ok(f.app.querySelector('.rc-wrap--full'), 'a stage uses the whole width');
  // Addresses from before the flow chart open that stage's page.
  f.ctx.UI.route.params = { id: 'cy-a', sub: 'coffee' };
  assert.equal(f.run('recruitActivePanel().id'), 'stage'); assert.equal(f.run('recruitStageKey()'), 'coffee');
  f.ctx.UI.route.params = { id: 'cy-a', sub: 'form:people' };
  assert.equal(f.run('recruitActivePanel().id'), 'flow', 'form:people opens a stage only where one is called people');
  st.cycle.sections.people = { ...sections().coffee, title: 'People intake' };
  assert.equal(f.run('recruitActivePanel().id'), 'stage'); assert.equal(f.run('recruitStageKey()'), 'people');
  delete st.cycle.sections.people;
  f.ctx.UI.route.params = { id: 'cy-a', sub: 'nonsense' };
  assert.equal(f.run('recruitActivePanel().id'), 'flow', 'an unknown view falls back to the first tab');
  // Switching cycles keeps the view where it exists in the other cycle.
  f.ctx.UI.route.params = { id: 'cy-a', sub: 'people' };
  f.mount();
  const sw = f.app.querySelector('[data-m="recruit-cycle-switch"]');
  f.run('RECRUIT.dd.bind(RECRUIT)')(sw, 'cy-b');
  assert.equal(f.navs.at(-1), '#/applications/cy-b/people');
  f.ctx.UI.route.params = { id: 'cy-a', sub: 'stage', key: 'coffee' };
  f.run('RECRUIT.dd.bind(RECRUIT)')(sw, 'cy-b');
  assert.equal(f.navs.at(-1), '#/applications/cy-b', 'a stage of one cycle is not a stage of the other');
  assert.doesNotMatch(f.app.innerHTML, /<select|<datalist/);
  // Reviewers read: no gear, no Add stage, no stage settings.
  const r = fixture({ admin: false });
  loadCycle(r, { role: 'reviewer', roles: ['reviewer'] });
  r.mount();
  assert.ok(!r.app.querySelector('.rc-cycle-gear') && !r.app.querySelector('[data-action="recruit-stage-new"]'), 'reviewers see no gear and cannot add stages');
  r.ctx.UI.route.params = { id: 'cy-a', sub: 'stage', key: 'coffee', tab: 'settings' };
  r.mount();
  same(r.app.querySelectorAll('.rs-tabs [role="tab"]').map((t) => t.textContent.replace(/\d+$/, '')), ['People', 'Form', 'Checklist'], 'a stage has no Settings tab for reviewers');
  assert.equal(r.app.querySelector('[data-rc="stage-tab"]').dataset.tab, 'people', 'asking for settings shows People');
  console.log('PASS: the cycle shell draws Flow, People and Insights, marks the view a stage belongs to, reads old addresses, switches cycles in place and gates editing by role');
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
  st.cycles = { list: [], intakeCycleId: null, migration: { done: true, orphans: 0 } };
  assert.match(f.run('viewRecruit()'), /No cycle yet/);
  st.cycles = { list: [
    { id: 'cy-a', name: '<b>Fall</b> 2026', term: 'Fall 2026', status: 'open', counts: { total: 12, bySection: { interest: 10, coffee: 2 } }, updated: 1 },
    { id: 'cy-old', name: 'Spring 2025', term: 'Spring 2025', status: 'archived', counts: { total: 3 }, updated: 1 },
  ], intakeCycleId: 'cy-a', migration: { done: false, legacyLive: 40, legacyArchives: [{ id: 'ar-1' }], orphans: 0 } };
  f.mount();
  const html = f.app.innerHTML;
  assert.match(html, /&lt;b&gt;Fall&lt;\/b&gt; 2026/, 'cycle names are escaped'); assert.doesNotMatch(html, /<b>Fall<\/b>/);
  const card = f.app.querySelector('.rc-cycle-card[data-id="cy-a"]');
  same(card.querySelectorAll('.rc-cycle-card__stage').map((s) => [s.querySelector('.rc-cycle-card__label').textContent, s.querySelector('.rc-cycle-card__n').textContent]), [['Interest form', '10'], ['Coffee chats', '2'], ['Application form', '0']], 'each card counts its stages');
  assert.ok(card.querySelector('.rc-cycle-card__live'), 'the cycle taking the website\'s forms says so');
  assert.match(html, /Archived<\/h2>/, 'archived cycles sit under a second heading');
  assert.match(html, /Import the current list and archives/); assert.match(html, /40 submissions and 1 archive/);
  assert.match(html, /data-action="recruit-cycle-new"/);
  st.cycles.migration = { done: true, orphans: 5 };
  f.mount();
  assert.match(f.app.innerHTML, /5 submissions arrived while no cycle was receiving the form/);
  st.cycles.migration = { done: false, legacyLive: 40, legacyArchives: [{ id: 'ar-1' }], orphans: 0 };
  f.mount();
  // The import follows the server's next step and repaints from state.
  const migrating = f.run('recruitRunMigration()');
  assert.equal(f.requests[0].url, '/recruit/migrate'); same(f.requests[0].body.step, 'live'); assert.match(f.requests[0].body.requestId, /^rq-/);
  assert.equal(f.app.querySelector('[data-rc="migrate"]').textContent, 'Importing…');
  f.requests[0].resolve({ done: false, next: { step: 'archive', archiveId: 'ar-1' } }); await f.settle();
  assert.equal(f.requests[1].body.archiveId, 'ar-1');
  f.requests[1].resolve({ done: true }); await migrating;
  assert.equal(st.cycles, undefined, 'the index refetches after the import'); same(f.backgrounds, ['recruit']); assert.equal(f.renders.length, 0);
  assert.equal(f.toasts.at(-1), 'Imported the current list and archives');
  // A new cycle starts from the default flow or copies another cycle's.
  st.cycles = { list: [{ id: 'cy-a', name: 'Fall 2026', status: 'open', counts: {} }], intakeCycleId: null, migration: { done: true } };
  f.ctx.UI.modal = { kind: 'recruit-cycle' };
  const veil = f.mountModal();
  const from = veil.querySelector('[data-m="recruit-cycle-copy"]');
  same(JSON.parse(from.dataset.opts).map((o) => o.label), ['The default flow', "Fall 2026's flow"]);
  const creating = f.run('recruitCreateCycle()');
  assert.equal(veil.querySelector('.field-error').textContent, 'A cycle needs a name.');
  await creating;
  veil.querySelector('[data-m="recruit-cycle-name"]').value = 'Spring 2027';
  f.pick(from, "Fall 2026's flow");
  const creating2 = f.run('recruitCreateCycle()');
  const post = await f.pending('/recruit/cycles', 'POST');
  assert.equal(post.body.name, 'Spring 2027'); assert.equal(post.body.copyFrom, 'cy-a'); assert.match(post.body.requestId, /^rq-/);
  post.resolve({ cycle: { id: 'cy-new' } }); await creating2;
  assert.equal(f.navs.at(-1), '#/applications/cy-new/flow', 'a new cycle opens on its flow');
  assert.equal(f.toasts.at(-1), 'Created Spring 2027');
  console.log('PASS: the cycle index renders every sentinel, escapes names, counts each stage, runs the resumable import without render(), and creates a cycle from a flow');
}

/* ------------------------------- settings -------------------------------- */
{
  const f = fixture();
  const st = loadCycle(f);
  f.mount();
  f.run('recruitOpenSettings()');
  assert.equal(f.ctx.UI.modal.kind, 'recruit-settings');
  const settings = f.mountModal();
  assert.equal(settings.querySelector('[data-action="recruit-settings-about"] [name="name"]').value, 'Fall 2026', 'About holds the name');
  const seg = settings.querySelectorAll('.rc-seg--status [data-action="recruit-status-set"]');
  same(seg.map((b) => [b.dataset.status, b.getAttribute('aria-current') === 'page', b.disabled]), [['draft', false, true], ['open', true, false], ['closed', false, false]], 'status is a segmented control: the current one pressed, only real moves enabled');
  assert.equal(settings.querySelector('[data-action="recruit-website-toggle"]').checked, true, 'the receiving checkbox reflects the index');
  assert.equal(settings.querySelectorAll('[data-rc="subteam-rows"] .rc-row').length, 2);
  assert.match(settings.querySelector('#rc-set-review').innerHTML, /Admins only so far/);
  assert.ok(!settings.querySelector('[data-action="recruit-cycle-delete"]'), 'an open cycle cannot be deleted; nothing offers it');
  // Who can review: roster members get a role through the app's own dropdowns.
  st.mod.roles = { key: st.key + ':cy-a', loading: false, error: null, roles: [{ member: 'old@cornell.edu', name: 'Old', roles: ['reviewer'] }], members: [{ email: 'rae@cornell.edu', name: 'Rae' }, { email: 'boss@cornell.edu', name: 'Boss', admin: true }, { email: 'old@cornell.edu', name: 'Old' }] };
  st.cycle.team = [{ email: 'boss@cornell.edu', name: 'Boss' }, { email: 'old@cornell.edu', name: 'Old' }];
  f.ctx.UI.modal = { kind: 'recruit-roles' };
  const roles = f.mountModal();
  const roleDd = roles.querySelector('[data-m="recruit-role-role"]');
  f.pick(roleDd, 'Lead');
  assert.equal(roleDd.dataset.value, 'lead'); assert.equal(roleDd.closest('form').dataset.adminDirty, 'true');
  const adding = f.run('recruitAddRole')(roles.querySelector('[data-action="recruit-role-form"]'));
  const put = await f.pending('/recruit/cycles/cy-a/roles/boss%40cornell.edu', 'PUT');
  same(put.body.roles, ['lead']); assert.match(put.body.requestId, /^rq-/);
  put.resolve({ role: { member: 'boss@cornell.edu', roles: ['lead'], subteams: [], ts: 1 } }); await adding;
  assert.equal(f.toasts.at(-1), 'Lead added');
  assert.equal(st.cycle.grants.length, 2, 'the cycle knows its new grant');
  const removing = f.run('recruitRemoveRole')('old@cornell.edu');
  (await f.pending('/recruit/cycles/cy-a/roles/old%40cornell.edu', 'DELETE')).resolve({ ok: true }); await removing;
  same(st.cycle.team.map((m) => m.email), ['boss@cornell.edu'], 'a member whose grant goes leaves the team');
  const removing2 = f.run('recruitRemoveRole')('boss@cornell.edu');
  (await f.pending('/recruit/cycles/cy-a/roles/boss%40cornell.edu', 'DELETE')).resolve({ ok: true }); await removing2;
  same(st.cycle.team.map((m) => m.email), ['boss@cornell.edu'], 'an admin stays on the team without a grant');
  assert.doesNotMatch(settings.innerHTML + roles.innerHTML, /<select|<datalist/);
  console.log('PASS: settings hold about, status, subteams and reviewers; roles save through the app\'s dropdowns and keep the team in step');
}

/* ------------------------------- the flow chart -------------------------- */
{
  const f = fixture();
  const st = loadCycle(f);
  // The model: implicit edges follow the order; saved connections win.
  const flow = f.run('recruitFlow()');
  same([...flow.edges].map(([k, v]) => [k, v]), [['interest', ['coffee']], ['coffee', ['application']], ['application', []]]);
  same(flow.keys, ['interest', 'coffee', 'application']);
  st.cycle.sections.interest.next = ['coffee', 'application'];
  st.cycle.sections.coffee.next = ['application'];
  const branched = f.run('recruitFlow()');
  same([...branched.ranks], [['interest', 0], ['coffee', 1], ['application', 2]], 'a stage sits one column past the furthest stage leading into it');
  assert.equal(f.run("recruitReaches(recruitFlow(), 'application', 'interest')"), true, 'application → interest would loop');
  assert.equal(f.run("recruitReaches(recruitFlow(), 'interest', 'application')"), false);
  same(f.run("recruitFlowTargets('coffee')"), [], 'coffee already leads everywhere it can without a loop');
  delete st.cycle.sections.interest.next; delete st.cycle.sections.coffee.next;
  // Layout: columns left to right, then the outcomes; rows down a phone.
  const layout = f.run('recruitFlowLayout(recruitFlow())');
  const xs = ['interest', 'coffee', 'application', '__outcome'].map((k) => layout.nodes.get(k).x);
  assert.ok(xs[0] < xs[1] && xs[1] < xs[2] && xs[2] < xs[3], 'columns run left to right');
  assert.equal(layout.edges.filter((e) => e.outcome).length, 1, 'the last stage leads to the outcomes');
  const down = f.run('recruitFlowLayout(recruitFlow(), { vertical: true })');
  assert.ok(down.nodes.get('interest').y < down.nodes.get('coffee').y && down.nodes.get('interest').x === down.nodes.get('coffee').x, 'down a phone the stages stack');
  // The chart: a card per stage with its counts, links and controls.
  f.mount();
  const cards = f.app.querySelectorAll('.fc-node[data-key]');
  same(cards.map((c) => c.dataset.key), ['interest', 'coffee', 'application']);
  const coffee = f.app.querySelector('.fc-node[data-key="coffee"]');
  assert.equal(coffee.querySelector('.fc-node__main').getAttribute('href'), '#/applications/cy-a/stage?key=coffee', 'a card opens its stage');
  assert.match(coffee.querySelector('.fc-node__stats').textContent, /1 here\s*2 reached/);
  assert.match(coffee.querySelector('.fc-node__done').textContent, /1\/2 chat completed/, 'a stage with a done checkbox shows how many are done');
  assert.match(f.app.querySelector('.fc-node[data-key="interest"] .fc-web').textContent, /Open · \/apply/, 'the form at /apply says so');
  assert.equal(f.app.querySelectorAll('.fc-edge:not(.fc-edge--outcome)').length + f.app.querySelectorAll('.fc-edge--outcome').length, 4, 'two connections, one to the outcomes, and the draft line');
  assert.match(f.app.querySelector('.fc-outcome').textContent, /Accepted\s*1/);
  assert.match(f.app.querySelector('[data-rc="flow-summary"]').textContent, /3\s*people\s*2\s*active\s*1\s*accepted\s*1\s*flagged/);
  assert.equal(f.app.querySelectorAll('.fc-cut').length, 2, 'every connection can be cut by a lead');
  assert.equal(f.app.querySelectorAll('.fc-port').length, 3, 'every card has a port to connect from');
  // Connecting saves every connection explicitly, with the order.
  const connecting = f.run("recruitFlowConnect('interest', 'application')");
  const put = await f.pending('/recruit/cycles/cy-a/settings/site', 'PUT');
  assert.equal(put.body.version, 3);
  same(put.body.settings, { sections: { interest: { next: ['coffee', 'application'] }, coffee: { next: ['application'] }, application: { next: [] } }, order: ['interest', 'coffee', 'application'] });
  assert.equal(f.run("recruitFlow().edges.get('interest').length"), 2, 'the chart shows the connection before the save lands');
  const saved = sections(); saved.interest.next = ['coffee', 'application']; saved.coffee.next = ['application']; saved.application.next = [];
  put.resolve({ cycle: cycleRow({ version: 4 }), sections: saved }); await connecting;
  assert.equal(f.toasts.at(-1), 'Interest form now leads to Application form');
  assert.equal(f.run('recruitCycleRow().version'), 4, 'the next save uses the new version');
  assert.equal(f.app.querySelectorAll('.fc-cut').length, 3, 'the chart repainted in place');
  assert.equal(f.renders.length, 0, 'editing the flow never re-renders the route');
  f.run("recruitFlowConnect('application', 'interest')");
  assert.match(f.toasts.at(-1), /comes before Application form; that connection would loop back/, 'a loop is refused before any request');
  // A failed save puts the chart back.
  const unlinking = f.run("recruitFlowUnlink('interest', 'application')");
  const put2 = await f.pending('/recruit/cycles/cy-a/settings/site', 'PUT');
  same(put2.body.settings.sections.interest, { next: ['coffee'] });
  assert.equal(f.run("recruitFlow().edges.get('interest').length"), 1);
  put2.reject(Object.assign(new Error('The cycle changed since you opened it'), { status: 409 })); await unlinking;
  assert.equal(f.run("recruitFlow().edges.get('interest').length"), 2, 'the connection comes back when the save fails');
  // Removing a stage joins what led into it to what it led to.
  f.run("recruitConfirmRemoveStage('coffee')");
  assert.equal(f.ctx.UI.modal.kind, 'confirm'); assert.match(f.ctx.UI.modal.text, /Interest form will lead to Application form/);
  const removing = f.ctx.UI.modal.onGo();
  const put3 = await f.pending('/recruit/cycles/cy-a/settings/site', 'PUT');
  same(put3.body.settings.remove, ['coffee']); same(put3.body.settings.order, ['interest', 'application']);
  same(put3.body.settings.sections.interest, { next: ['application'] }, 'the bridge dedupes');
  put3.resolve({ cycle: cycleRow({ version: 5 }), sections: { interest: { ...saved.interest, next: ['application'] }, application: saved.application } }); await removing;
  assert.equal(f.toasts.at(-1), 'Coffee chats removed');
  // A new stage goes between the stage it follows and what that led to.
  f.run("recruitOpenStageNew('interest')");
  assert.equal(f.ctx.UI.modal.kind, 'recruit-stage-new');
  const dialog = f.mountModal();
  dialog.querySelector('[name="title"]').value = 'Interview';
  const creating = f.run('recruitCreateStage()');
  const put4 = await f.pending('/recruit/cycles/cy-a/settings/site', 'PUT');
  const made = put4.body.settings.sections.interview;
  same([made.title, made.kind, made.form, made.done, made.next], ['Interview', 'meeting', null, 'completed', ['application']], 'a meeting starts with its checklist and no form');
  same(made.fields.map((x) => [x.key, x.type]), [['completed', 'check'], ['with', 'member'], ['notes', 'note']]);
  same(put4.body.settings.sections.interest.next, ['interview']);
  same(put4.body.settings.order, ['interest', 'interview', 'application']);
  put4.resolve({ cycle: cycleRow({ version: 6 }), sections: { interest: { ...saved.interest, next: ['interview'] }, interview: { ...made, open: false, required: [] }, application: saved.application } }); await creating;
  assert.equal(f.navs.at(-1), '#/applications/cy-a/stage?key=interview&tab=checklist', 'it opens on its checklist');
  st.cycle.sections.flow = undefined;
  assert.equal(f.run("recruitStageKeyFor('Flow')"), 'flow');
  // Reviewers see the chart without its controls.
  const r = fixture({ admin: false });
  loadCycle(r, { role: 'reviewer', roles: ['reviewer'] });
  r.mount();
  assert.ok(r.app.querySelector('.fc-node') && !r.app.querySelector('.fc-port, .fc-cut, .fc-node__more'), 'reviewers read the chart');
  console.log('PASS: the flow chart lays out columns, counts each stage, saves connections, removals and new stages as one versioned PUT, refuses loops, and puts itself back when a save fails');
}

/* ------------------------------- a stage's page -------------------------- */
{
  const f = fixture();
  const st = loadCycle(f, { sub: 'stage', params: { key: 'coffee', tab: 'checklist' } });
  f.mount();
  const page = () => f.app.querySelector('[data-rc="stage"]');
  assert.equal(page().dataset.stage, 'coffee');
  same(f.app.querySelectorAll('.rs-strip__stage').map((a) => a.textContent), ['Interest form', 'Coffee chats', 'Application form'], 'the strip lists every stage');
  const numbers = f.app.querySelectorAll('.rs-head__numbers div').map((d) => [d.querySelector('dt').textContent, d.querySelector('dd').textContent]);
  same(numbers, [['here now', '1'], ['reached', '2'], ['chat completed', '1'], ['responses', '2']]);
  same(f.app.querySelectorAll('.rs-tabs [role="tab"]').map((t) => t.textContent), ['People', 'Form2', 'Checklist3', 'Settings']);
  assert.ok(f.app.querySelector('[data-rc="stage-save"]').hidden, 'nothing to save yet');
  // The checklist: add a checkbox that marks the stage done.
  const add = f.app.querySelector('[data-action="recruit-ck-add"]');
  await f.click(add);
  same(f.menus.at(-1).items.map((i) => i.label), ['Checkbox', 'Rating', 'Choice', 'Short text', 'Note', 'Number', 'Date', 'Team member']);
  f.menus.at(-1).items.find((i) => i.label === 'Checkbox').run();
  assert.equal(f.app.querySelectorAll('.ck-f').length, 4, 'the new field is a card');
  assert.ok(f.document.activeElement === f.app.querySelector('[data-m="recruit-ck-label"][data-i="3"]'), 'its label takes focus');
  f.type(f.app.querySelector('[data-m="recruit-ck-label"][data-i="3"]'), 'Showed up');
  assert.ok(!f.app.querySelector('[data-rc="stage-save"]').hidden, 'typing shows the save bar');
  assert.match(f.app.querySelector('[data-rc="stage-save"]').textContent, /Unsaved changes/);
  assert.match(f.app.querySelector('[data-rc="checklist-preview"]').textContent, /Showed up/, 'the preview follows the label');
  const done = f.app.querySelector('[data-action="recruit-ck-done"][data-i="3"]');
  done.checked = true; await f.click(done);
  assert.equal(f.app.querySelector('[data-action="recruit-ck-done"][data-i="3"]').checked, true, 'the new field shows that it marks the stage done');
  assert.equal(f.app.querySelector('[data-action="recruit-ck-done"][data-i="0"]').checked, false, 'only one checkbox marks it done');
  // A rating kept per reviewer, with its scale from the app's dropdown.
  await f.click(add); f.menus.at(-1).items.find((i) => i.label === 'Rating').run();
  f.type(f.app.querySelector('[data-m="recruit-ck-label"][data-i="4"]'), 'Energy');
  f.pick(f.app.querySelector('[data-m="recruit-ck-max"][data-i="4"]'), '10');
  assert.ok(f.app.querySelector('[data-action="recruit-ck-each"][data-i="4"]').checked, 'a rating starts per reviewer');
  // An empty label stops the save before any request.
  await f.click(add); f.menus.at(-1).items.find((i) => i.label === 'Note').run();
  const before = f.requests.length;
  await f.click(f.app.querySelector('[data-action="recruit-stage-save"]'));
  assert.equal(f.requests.length, before, 'an unlabelled field never reaches the server');
  assert.match(f.app.querySelector('[data-rc="stage-save"]').textContent, /Field 6 needs a label/);
  await f.click(f.app.querySelector('[data-action="recruit-ck-remove"][data-i="5"]'));
  // Arrow keys on a grip move a card.
  const grip = f.app.querySelector('[data-sortable="fields"] [data-i="4"] .rc-grip');
  assert.equal(f.run('RECRUIT.keydown.bind(RECRUIT)')({ key: 'ArrowUp', target: grip, preventDefault() {} }), true);
  assert.equal(f.app.querySelector('[data-m="recruit-ck-label"][data-i="3"]').value, 'Energy', 'ArrowUp moves the card up');
  assert.equal(f.run('RECRUIT.keydown.bind(RECRUIT)')({ key: 'ArrowDown', target: f.app.querySelector('[data-sortable="fields"] [data-i="3"] .rc-grip'), preventDefault() {} }), true);
  // Save sends only what changed, with keys for the new fields.
  const saving = f.click(f.app.querySelector('[data-action="recruit-stage-save"]'));
  await f.settle();
  const put = await f.pending('/recruit/cycles/cy-a/settings/site', 'PUT');
  const body = put.body.settings.sections.coffee;
  same(Object.keys(body).sort(), ['done', 'fields'], 'only the checklist changed');
  same(body.fields, [
    { key: 'completed', type: 'check', label: 'Chat completed' }, { key: 'met_with', type: 'text', label: 'Met with' }, { key: 'notes', type: 'note', label: 'Notes' },
    { key: 'showed_up', type: 'check', label: 'Showed up' }, { key: 'energy', type: 'rating', label: 'Energy', max: 10, each: true },
  ], 'new fields get keys from their labels');
  assert.equal(body.done, 'showed_up', 'the new checkbox marks the stage done');
  const savedSections = sections();
  savedSections.coffee.fields = body.fields; savedSections.coffee.done = 'showed_up';
  put.resolve({ cycle: cycleRow({ version: 4 }), sections: savedSections }); await saving;
  assert.equal(f.toasts.at(-1), 'Coffee chats saved');
  assert.ok(f.app.querySelector('[data-rc="stage-save"]').hidden, 'the bar goes once saved');
  assert.match(f.app.querySelector('.fe-q__type--fixed').textContent, /Checkbox/, 'a saved field keeps its type');
  assert.equal(f.renders.length, 0, 'the stage never re-renders the route');
  // The form: a question, its type from the app's dropdown, its options.
  f.ctx.UI.route.params.tab = 'form';
  f.mount();
  const edit = f.app.querySelector('[data-rc="stage-tab"]');
  assert.equal(edit.dataset.tab, 'form');
  assert.equal(f.app.querySelectorAll('.fe-q').length, 2);
  assert.equal(f.app.querySelectorAll('.fe-q__type--fixed').length, 2, 'name and email keep their type');
  assert.equal(f.app.querySelectorAll('[data-action="recruit-sf-remove"]').length, 0, 'and cannot be removed');
  await f.click(f.app.querySelector('[data-action="recruit-sf-add"]'));
  f.type(f.app.querySelector('[data-m="recruit-sf-label"][data-i="2"]'), 'Which day works for you?');
  f.pick(f.app.querySelector('[data-m="recruit-sf-type"][data-i="2"]'), 'Choose one');
  assert.equal(f.app.querySelectorAll('[data-m="recruit-sf-option"][data-i="2"]').length, 1, 'a choice starts with one option');
  f.type(f.app.querySelector('[data-m="recruit-sf-option"][data-i="2"][data-j="0"]'), 'Monday');
  await f.click(f.app.querySelector('[data-action="recruit-sf-option-add"][data-i="2"]'));
  f.type(f.app.querySelector('[data-m="recruit-sf-option"][data-i="2"][data-j="1"]'), 'Friday');
  const req = f.app.querySelector('[data-action="recruit-sf-required"][data-i="2"]'); req.checked = true; await f.click(req);
  // What happens on the website rides with the save.
  const open = f.app.querySelector('[data-action="recruit-sf-open"]'); open.checked = true; await f.click(open);
  f.type(f.app.querySelector('[data-m="recruit-sf-capacity"]'), '40');
  await f.click(f.app.querySelector('[data-action="recruit-sf-recipient-add"]'));
  f.type(f.app.querySelector('[data-m="recruit-sf-recipient"][data-j="0"]'), 'nope');
  const count = f.requests.length;
  await f.click(f.app.querySelector('[data-action="recruit-stage-save"]'));
  assert.equal(f.requests.length, count, 'a bad address stops the save');
  assert.match(f.app.querySelector('[data-rc="stage-save"]').textContent, /"nope" is not an email address/);
  f.type(f.app.querySelector('[data-m="recruit-sf-recipient"][data-j="0"]'), ' Lead@Cornell.edu ');
  const saving2 = f.click(f.app.querySelector('[data-action="recruit-stage-save"]'));
  await f.settle();
  const put2 = await f.pending('/recruit/cycles/cy-a/settings/site', 'PUT');
  assert.equal(put2.body.version, 4, 'the version the last save brought back');
  const b2 = put2.body.settings.sections.coffee;
  assert.equal(b2.open, true); assert.equal(b2.capacity, 40); same(b2.notifyTo, ['lead@cornell.edu'], 'recipients are trimmed and lowercased');
  same(b2.form.questions[2], { key: 'which_day_works_for_you', type: 'single', label: 'Which day works for you?', help: '', required: true, options: ['Monday', 'Friday'] });
  const s2 = { ...savedSections, coffee: { ...savedSections.coffee, open: true, capacity: 40, notifyTo: ['lead@cornell.edu'], form: { questions: b2.form.questions } } };
  put2.resolve({ cycle: cycleRow({ version: 5 }), sections: s2 }); await saving2;
  assert.equal(f.toasts.at(-1), 'Coffee chats saved · live on the website');
  // Settings: a name, a kind, and where it leads; no loops on offer.
  f.ctx.UI.route.params.tab = 'settings';
  f.mount();
  const leads = f.app.querySelectorAll('[data-action="recruit-ss-next"]');
  same(leads.map((b) => [b.dataset.to, b.checked, b.disabled]), [['interest', false, true], ['application', true, false]], 'what comes before this stage cannot follow it');
  f.type(f.app.querySelector('[data-m="recruit-ss-title"]'), 'Coffee chat');
  const kind = f.app.querySelector('[data-action="recruit-ss-kind"][data-kind="step"]');
  await f.click(kind);
  assert.equal(kind.getAttribute('aria-checked'), 'true');
  const saving3 = f.click(f.app.querySelector('[data-action="recruit-stage-save"]'));
  await f.settle();
  const put3 = await f.pending('/recruit/cycles/cy-a/settings/site', 'PUT');
  same(put3.body.settings.sections.coffee, { title: 'Coffee chat', kind: 'step' });
  put3.reject(Object.assign(new Error('Something broke'), { status: 500 })); await saving3;
  assert.match(f.app.querySelector('[data-rc="stage-save"]').textContent, /Something broke/, 'a failed save keeps the draft and says why');
  assert.ok(f.run('RECRUIT.dirty()'), 'unsaved work is reported, so the sync loop leaves the cycle alone');
  await f.click(f.app.querySelector('[data-action="recruit-stage-discard"]'));
  assert.ok(!f.run('RECRUIT.dirty()')); assert.equal(f.toasts.at(-1), 'Changes discarded');
  // Opening the form from the header is one save.
  const toggle = f.app.querySelector('[data-action="recruit-stage-open"]');
  toggle.checked = false;
  const toggling = f.click(toggle);
  const put4 = await f.pending('/recruit/cycles/cy-a/settings/site', 'PUT');
  same(put4.body.settings, { sections: { coffee: { open: false } } });
  put4.resolve({ cycle: cycleRow({ version: 6 }), sections: { ...s2, coffee: { ...s2.coffee, open: false } } }); await toggling;
  assert.equal(f.toasts.at(-1), 'Coffee chats is closed on the website');
  assert.ok(!f.run('RECRUIT.dirty()'), 'the draft learns the saved state without turning dirty');
  assert.doesNotMatch(f.app.innerHTML, /<select|<datalist/);
  // A stage without a form says so; reviewers read the checklist.
  st.cycle.sections.coffee.form = null;
  f.ctx.UI.route.params.tab = 'form';
  f.mount();
  assert.match(f.app.innerHTML, /No form on the website/); assert.ok(f.app.querySelector('[data-action="recruit-sf-add-form"]'), 'a lead can add one');
  const r = fixture({ admin: false });
  loadCycle(r, { role: 'reviewer', roles: ['reviewer'], sub: 'stage', params: { key: 'coffee', tab: 'checklist' } });
  r.mount();
  assert.ok(r.app.querySelector('.ck--read') && !r.app.querySelector('[data-action="recruit-ck-add"]'), 'reviewers read the checklist');
  console.log('PASS: a stage\'s page edits one draft across Form, Checklist and Settings, validates before sending, saves only what changed with derived keys, and keeps the draft when a save fails');
}

/* ------------------------------- a stage's people ------------------------ */
{
  const f = fixture();
  const st = loadCycle(f, { sub: 'stage', params: { key: 'coffee' } });
  f.mount();
  assert.match(f.app.querySelector('[data-rc="stage-people-rows"]').textContent, /Loading…/, 'the list says Loading until it loads');
  f.run("RECRUIT.mount({ name: 'recruit', params: { id: 'cy-a', sub: 'stage', key: 'coffee' } })");
  const list = await f.pending(/\/people\?/);
  assert.match(list.url, /reached=coffee/); assert.match(list.url, /sort=name/);
  same(f.app.querySelectorAll('[data-rc="stage-chips"] .rc-chip').map((c) => c.textContent), ['Everyone who reached it2', 'Here now1', 'Done1', 'Not done1'], 'the chips count each list');
  list.resolve({ rows: people().slice(0, 1), total: 1 }); await f.settle();
  const row = f.app.querySelector('[data-rc="stage-people-rows"] tr[data-email="ada@cornell.edu"]');
  assert.ok(row, 'one row per person');
  same(f.app.querySelectorAll('[data-rc="stage-people-head"] th').map((th) => th.dataset.col), ['check', 'person', 'status', 'sent', 'f-completed', 'f-met_with', 'f-notes', 'review'], 'the checklist joins the list as columns');
  assert.equal(row.querySelector('td[data-col="f-met_with"]').dataset.label, 'Met with', 'each field cell carries its label for the stacked phone layout');
  assert.equal(row.querySelector('[data-action="recruit-field-check"]').checked, false);
  // Ticking the box shows at once, saves, and every list follows.
  const tick = row.querySelector('[data-action="recruit-field-check"]');
  tick.checked = true;
  const setting = f.click(tick);
  const patch = await f.pending('/recruit/cycles/cy-a/people/ada%40cornell.edu/fields', 'PATCH');
  same(patch.body, { stage: 'coffee', field: 'completed', value: true });
  assert.equal(st.stagePeople.rows[0].fields.coffee.completed, true, 'the list shows the change before the save lands');
  patch.resolve({ person: { email: 'ada@cornell.edu', stage: 'coffee', status: 'active', states: { interest: 'done', coffee: 'current', application: 'ahead' }, done: { interest: true, coffee: true }, fields: { coffee: { completed: true, met_with: 'Rae' } }, trackVersion: 3 } }); await setting;
  assert.equal(st.stagePeople.rows[0].done.coffee, true, 'the server\'s answer is kept');
  // A failed save puts the value back.
  f.change(f.app.querySelector('[data-m="recruit-field-text"][data-field="met_with"]'), 'Lee');
  const patch2 = await f.pending('/recruit/cycles/cy-a/people/ada%40cornell.edu/fields', 'PATCH');
  same(patch2.body, { stage: 'coffee', field: 'met_with', value: 'Lee' });
  patch2.reject(Object.assign(new Error('No'), { status: 403 })); await f.settle();
  assert.equal(st.stagePeople.rows[0].fields.coffee.met_with, 'Rae', 'the value comes back when the save fails');
  assert.match(f.toasts.at(-1), /Could not save Met with: No/);
  // Filters load their own list.
  await f.click(f.app.querySelector('[data-action="recruit-stage-filter"][data-filter="notdone"]'));
  assert.match((await f.pending(/\/people\?/)).url, /notdone=coffee/);
  await f.click(f.app.querySelector('[data-action="recruit-stage-filter"][data-filter="here"]'));
  const here = (await f.pending(/\/people\?/)).url;
  assert.match(here, /stage=coffee/); assert.match(here, /status=active/);
  console.log('PASS: a stage\'s people load by filter, show its checklist as columns, save a tick at once and put a failed value back');
}

/* ------------------------------- People ---------------------------------- */
{
  const f = fixture();
  const st = loadCycle(f, { sub: 'people' });
  f.mount();
  f.run("RECRUIT.mount({ name: 'recruit', params: { id: 'cy-a', sub: 'people' } })");
  const req = await f.pending(/\/people\?/);
  assert.match(req.url, /sort=last/); assert.match(req.url, /limit=100/);
  assert.match(f.app.innerHTML, /Loading…/);
  req.resolve({ rows: people(), total: 2, counts: { people: 2, flagged: 1, byStatus: { active: 1, accepted: 1 } } }); await f.settle();
  assert.equal(f.renders.length, 0); assert.equal(f.backgrounds.length, 0, 'people paint in place');
  const body = f.app.querySelector('[data-rc="people-rows"]');
  assert.equal(body.querySelectorAll('tr').length, 2, 'one row per person');
  assert.match(body.innerHTML, /&lt;b&gt;Bo&lt;\/b&gt;/); assert.doesNotMatch(body.innerHTML, /<b>Bo/);
  const ada = body.querySelector('tr[data-email="ada@cornell.edu"]');
  assert.match(ada.querySelector('[data-col="stage"]').textContent, /Coffee chats/);
  assert.match(ada.querySelector('[data-col="status"]').textContent, /Active/);
  same(ada.querySelectorAll('.rc-track__dot').map((d) => d.className.replace('rc-track__dot ', '')), ['rc-track__dot--done', 'rc-track__dot--current', 'rc-track__dot--ahead'], 'progress shows each stage');
  assert.ok(ada.querySelector('.interest-flag.is-flagged'), 'the flag is the person\'s');
  assert.match(ada.querySelector('.interest-comments').innerHTML, /<span>2<\/span>/);
  // Filters: a menu of groups, each opening its own choices.
  const filter = f.app.querySelector('[data-m="recruit-people-filter"]');
  f.run('RECRUIT.dd.bind(RECRUIT)')(filter);
  same(f.menus.at(-1).items.map((i) => i.label), ['Stage', 'Status', 'Review', 'Sent a form', 'Subteam', 'Year']);
  f.menus.at(-1).items.find((i) => i.label === 'Stage').run();
  await new Promise((resolve) => setTimeout(resolve, 5));
  f.menus.at(-1).items.find((i) => i.label === 'Coffee chats').run();
  const filtered = await f.pending(/\/people\?/);
  assert.match(filtered.url, /stage=coffee/);
  assert.match(f.app.querySelector('[data-rc="people-filters"]').textContent, /StageCoffee chats/, 'the filter shows as a chip');
  assert.match(f.app.querySelector('[data-rc="people-export"]').getAttribute('href'), /people\.csv\?stage=coffee&sort=last&columns=full/, 'export follows the filters and carries every column');
  filtered.resolve({ rows: people().slice(0, 1), total: 1 }); await f.settle();
  assert.equal(body.querySelectorAll('tr').length, 1);
  await f.click(f.app.querySelector('[data-action="recruit-people-unfilter"][data-group="stage"]'));
  (await f.pending(/\/people\?/)).resolve({ rows: people(), total: 2 }); await f.settle();
  // Links from the chart arrive with a filter.
  f.ctx.UI.route.params = { id: 'cy-a', sub: 'people', status: 'accepted' };
  f.mount();
  f.run("RECRUIT.mount({ name: 'recruit', params: { id: 'cy-a', sub: 'people', status: 'accepted' } })");
  assert.match((await f.pending(/\/people\?/)).url, /status=accepted/, 'the address filters the list');
  // Moving a selection is one request.
  f.run("recruitState().people.rows = " + JSON.stringify(people()));
  f.run("recruitState().people.loaded = true");
  f.run('recruitPaintPeople()');
  for (const e of ['ada@cornell.edu', 'bo@cornell.edu']) { const box = f.app.querySelector(`[data-action="recruit-people-select"][data-email="${e}"]`); box.checked = true; await f.click(box); }
  assert.ok(!f.app.querySelector('[data-rc="people-bulk"]').hidden); assert.match(f.app.querySelector('[data-rc="people-bulk"]').textContent, /2 selected/);
  await f.click(f.app.querySelector('[data-action="recruit-bulk-move"]'));
  f.menus.at(-1).items.find((i) => i.label === 'Application form').run();
  const moves = await f.pending('/recruit/cycles/cy-a/moves', 'POST');
  same(moves.body.emails, ['ada@cornell.edu', 'bo@cornell.edu']); assert.equal(moves.body.stage, 'application'); assert.match(moves.body.requestId, /^rq-/);
  moves.resolve({ moved: 2, emails: moves.body.emails, missing: [] }); await f.settle();
  assert.equal(f.toasts.at(-1), '2 people moved to Application form');
  assert.equal(f.run('recruitState().people.selected.size'), 0, 'the selection clears after a move');
  // The board: a column per stage, active people by default.
  f.ctx.UI.route.params = { id: 'cy-a', sub: 'people' };
  await f.click(f.app.querySelector('[data-action="recruit-people-unfilter-all"]'));
  same(f.run('recruitState().people.filters'), {}, 'Clear drops every filter');
  await f.click(f.app.querySelector('[data-action="recruit-people-view"][data-view="board"]'));
  assert.equal(f.ctx.localStorage.getItem('cupi-recruit-people-view'), 'board', 'the view is remembered');
  f.mount();
  f.run("RECRUIT.mount({ name: 'recruit', params: { id: 'cy-a', sub: 'people' } })");
  const boardReq = await f.pending(/\/people\?.*status=active/);
  assert.match(boardReq.url, /sort=name/);
  boardReq.resolve({ rows: [people()[0]], total: 1 }); await f.settle();
  same(f.app.querySelectorAll('.pb-col').map((c) => [c.dataset.stage, c.querySelector('.count').textContent]), [['interest', '0'], ['coffee', '1'], ['application', '0']]);
  assert.ok(f.app.querySelector('.pb-card[data-email="ada@cornell.edu"] .pb-card__flag'), 'a card shows the flag');
  assert.doesNotMatch(f.app.innerHTML, /<select|<datalist/);
  console.log('PASS: People lists everyone with their stage, status and progress, filters by group and address, exports what it shows, moves a selection in one request, and draws a board');
}

/* ------------------------------- a person's page ------------------------- */
{
  const f = fixture();
  const st = loadCycle(f, { sub: 'person', params: { email: 'ada@cornell.edu' } });
  const rows = people();
  st.people = { id: `${st.key}:cy-a`, rows, byEmail: Object.fromEntries(rows.map((r) => [r.email, r])), next: null, total: 2, counts: null, loading: false, loaded: true, error: null, q: '', filters: {}, sort: 'last', view: 'table', selected: new Set(), appliedParams: '' };
  st.personNav = { emails: ['ada@cornell.edu', 'bo@cornell.edu'], label: 'People', href: '#/applications/cy-a/people', cycleId: 'cy-a' };
  f.mount();
  assert.match(f.app.querySelector('.pn-head h2').textContent, /Ada/, 'the list row names the person before their detail arrives');
  assert.match(f.app.querySelector('.pn-step').textContent, /1 of 2/, 'Previous and Next walk the list it was opened from');
  f.run("RECRUIT.mount({ name: 'recruit', params: { id: 'cy-a', sub: 'person', email: 'ada@cornell.edu' } })");
  const detail = await f.pending('/recruit/cycles/cy-a/people/ada%40cornell.edu');
  assert.ok(detail.signal instanceof AbortSignal);
  assert.ok(f.requests.some((r) => r.url === '/recruit/cycles/cy-a/people/bo%40cornell.edu'), 'the next person loads ahead of time');
  const first = { id: 'ic-first', text: 'Existing <comment>', name: 'Rae', by: 'rae@cornell.edu', ts: 1, stage: 'coffee' };
  detail.resolve({
    person: { ...people()[0], review: { flagged: true, comments: [first] }, reviewVersion: 3, trackVersion: 2,
      track: { stage: null, fields: { coffee: { completed: { v: false, by: 'rae@cornell.edu', name: 'Rae', at: 5 }, met_with: { v: 'Rae', by: 'rae@cornell.edu', name: 'Rae', at: 6 } } }, moves: [] } },
    submissions: [
      { application: { id: 'p-a1', section: 'interest', name: 'Ada', email: 'ada@cornell.edu', ts: 1, answers: { project: 'A <robot>' }, files: [{ id: 'f-1', question: 'file', name: 'cv.pdf', size: 2048 }] }, form: { questions: sections().interest.form.questions } },
      { application: { id: 'p-a2', section: 'coffee', name: 'Ada', email: 'ada@cornell.edu', ts: 3, answers: { topics: 'Time' }, files: [] }, form: { questions: basics() } },
    ],
    history: [{ cycleId: 'cy-old', cycleName: 'Spring 2025', section: 'interest', sectionTitle: 'Interest form' }],
  });
  await f.settle();
  const html = f.app.innerHTML;
  assert.match(html, /A &lt;robot&gt;/); assert.match(html, /Existing &lt;comment&gt;/); assert.doesNotMatch(html, /<robot>|<comment>/);
  assert.match(html, /href="\/api\/recruit\/files\/f-1" download="cv\.pdf"/, 'files link only the authenticated route');
  same(f.app.querySelectorAll('.pn-journey__step').map((s) => s.querySelector('.pn-journey__state').textContent), ['Done', 'Here now', 'Not yet']);
  same(f.app.querySelectorAll('.pn-stage').map((s) => s.dataset.stage), ['interest', 'coffee', 'application'], 'a card per stage');
  const coffee = f.app.querySelector('.pn-stage[data-stage="coffee"]');
  assert.match(coffee.querySelector('.pn-field--check').textContent, /Rae · /, 'who set a value and when');
  assert.match(coffee.querySelector('.pn-stage__comments').textContent, /1/, 'a stage counts the comments about it');
  assert.match(html, /Also in Spring 2025 · Interest form/);
  assert.match(f.app.querySelector('[data-rc="pn-activity"]').textContent, /Sent the Coffee chats form/);
  assert.match(f.app.querySelector('[data-rc="pn-activity"]').textContent, /Sent the Interest form/, 'a title that already says form is not doubled');
  // A checklist value from the page.
  const tick = coffee.querySelector('[data-action="recruit-field-check"]');
  tick.checked = true;
  const setting = f.click(tick);
  const patch = await f.pending('/recruit/cycles/cy-a/people/ada%40cornell.edu/fields', 'PATCH');
  same(patch.body, { stage: 'coffee', field: 'completed', value: true });
  patch.resolve({ person: { email: 'ada@cornell.edu', stage: 'coffee', status: 'active', states: { interest: 'done', coffee: 'current', application: 'ahead' }, done: { interest: true, coffee: true }, fields: { coffee: { completed: true, met_with: 'Rae' } }, trackVersion: 3, track: { fields: { coffee: { completed: { v: true, by: 'lead@cornell.edu', name: 'Lead', at: 7 } } } } } });
  await setting;
  assert.equal(st.people.byEmail['ada@cornell.edu'].done.coffee, true, 'the People row follows');
  assert.match(f.app.querySelector('.pn-journey__step--current .pn-journey__state').textContent, /Here · done/, 'the journey follows');
  assert.ok(f.app.querySelector('.pn-stage[data-stage="application"]').classList.contains('pn-stage--quiet'), 'a stage they have not reached stays quiet');
  // A per-reviewer rating: mine, with everyone's average beside it.
  const holder = f.app.appendChild(f.document.createElement('div'));
  holder.innerHTML = f.run('recruitFieldControlHtml')({ key: 'score', type: 'rating', label: 'Score', max: 5, each: true }, { n: 2, avg: 3.5, mine: null }, { email: 'ada@cornell.edu', stage: 'application', name: 'Ada' });
  assert.equal(holder.querySelectorAll('[data-action="recruit-field-rate"]').length, 5, 'a rating is a row of stars');
  assert.match(holder.textContent, /avg 3.5 of 2/);
  const rating = f.click(holder.querySelector('[data-action="recruit-field-rate"][data-v="4"]'));
  same((await f.pending('/recruit/cycles/cy-a/people/ada%40cornell.edu/fields', 'PATCH')).body, { stage: 'application', field: 'score', value: 4 });
  // Moving and deciding, from the head.
  await f.click(f.app.querySelector('[data-action="recruit-person-move"]'));
  same(f.menus.at(-1).items.map((i) => [i.label, i.selected]), [['Interest form', false], ['Coffee chats', true], ['Application form', false]], 'the move menu marks where they are');
  f.menus.at(-1).items.find((i) => i.label === 'Application form').run();
  const move = await f.pending('/recruit/cycles/cy-a/people/ada%40cornell.edu/move', 'POST');
  assert.equal(move.body.stage, 'application'); assert.match(move.body.requestId, /^rq-/);
  assert.equal(st.people.byEmail['ada@cornell.edu'].stage, 'application', 'the move shows at once');
  move.reject(Object.assign(new Error('Busy'), { status: 409 })); await f.settle();
  assert.equal(st.people.byEmail['ada@cornell.edu'].stage, 'coffee', 'and goes back when it fails');
  assert.equal(f.toasts.at(-1), 'Could not move: Busy');
  await f.click(f.app.querySelector('[data-action="recruit-person-status"]'));
  f.menus.at(-1).items.find((i) => i.label === 'Accepted').run();
  const status = await f.pending('/recruit/cycles/cy-a/people/ada%40cornell.edu/move', 'POST');
  assert.equal(status.body.status, 'accepted');
  status.resolve({ person: { email: 'ada@cornell.edu', stage: 'coffee', status: 'accepted', states: { interest: 'done', coffee: 'current', application: 'ahead' }, done: { interest: true, coffee: true }, fields: {}, trackVersion: 5 } }); await f.settle(5);
  assert.equal(f.toasts.at(-1), 'Ada marked accepted');
  // A comment about a stage: the draft survives, posts once, keeps its id on retry.
  const field = f.app.querySelector('[data-m="recruit-person-comment"]');
  f.type(field, 'New <comment>');
  f.pick(f.app.querySelector('[data-m="recruit-person-comment-stage"]'), 'Coffee chats');
  const draft = f.run('recruitPersonDraft')('ada@cornell.edu');
  same([draft.text, draft.stage], ['New <comment>', 'coffee']);
  assert.equal(JSON.parse(f.ctx.localStorage.getItem(draft.key)).stage, 'coffee', 'the draft and its stage are kept in storage');
  const posting = f.run('recruitPostPersonComment')('ada@cornell.edu');
  const post = await f.pending('/recruit/cycles/cy-a/people/ada%40cornell.edu/comments', 'POST');
  assert.match(post.body.id, /^ic-/); same([post.body.text, post.body.stage], ['New <comment>', 'coffee']);
  post.reject(Object.assign(new Error('Timed out'), { name: 'TimeoutError' })); await posting;
  assert.match(f.app.querySelector('[data-comment-error]').textContent, /retrying will not post it twice/);
  const retry = f.run('recruitPostPersonComment')('ada@cornell.edu');
  const post2 = await f.pending('/recruit/cycles/cy-a/people/ada%40cornell.edu/comments', 'POST');
  assert.equal(post2.body.id, post.body.id, 'a lost response is retried with the same id');
  post2.resolve({ person: { email: 'ada@cornell.edu', flagged: true, reviewVersion: 4, review: { flagged: true, comments: [first, { id: post2.body.id, text: 'New <comment>', name: 'Lead', by: 'lead@cornell.edu', ts: 9, stage: 'coffee' }] } } }); await retry;
  assert.equal(f.toasts.at(-1), 'Comment posted');
  assert.equal(f.app.querySelector('[data-m="recruit-person-comment"]').value, '');
  assert.equal(f.app.querySelectorAll('.interest-thread [data-comment-id]').length, 2);
  assert.match(f.app.querySelector(`[data-comment-id="${post2.body.id}"] .rc-stage-chip`).textContent, /Coffee chats/, 'a comment shows the stage it is about');
  assert.equal(st.people.byEmail['ada@cornell.edu'].comments, 2, 'the People row counts it');
  // Deleting confirms inline.
  f.run('recruitConfirmPersonCommentRemoval')('ada@cornell.edu', 'ic-first');
  assert.match(f.app.querySelector('[data-comment-id="ic-first"]').innerHTML, /Delete this comment\?/);
  const deleting = f.run('recruitDeletePersonComment')('ada@cornell.edu', 'ic-first');
  (await f.pending('/recruit/cycles/cy-a/people/ada%40cornell.edu/comments/ic-first', 'DELETE')).resolve({ person: { email: 'ada@cornell.edu', flagged: true, reviewVersion: 5, review: { flagged: true, comments: [] } } }); await deleting;
  assert.equal(f.toasts.at(-1), 'Comment deleted'); assert.equal(f.app.querySelector('[data-comment-id="ic-first"]'), null);
  // The flag is the person's.
  const flagging = f.run('recruitTogglePersonFlag')('ada@cornell.edu');
  const flag = await f.pending('/recruit/cycles/cy-a/people/ada%40cornell.edu/review', 'PATCH');
  same(flag.body, { flagged: false });
  flag.resolve({ person: { email: 'ada@cornell.edu', flagged: false, reviewVersion: 6, review: { flagged: false, comments: [] } } }); await flagging;
  assert.equal(f.toasts.at(-1), 'Flag removed'); assert.equal(st.people.byEmail['ada@cornell.edu'].flagged, false);
  assert.equal(f.renders.length, 0, 'the page repaints in place');
  assert.doesNotMatch(f.app.innerHTML, /<select|<datalist/);
  await rating;
  console.log('PASS: a person\'s page shows their journey, answers, checklists, comments and activity; ticks, ratings, moves and decisions show at once and go back on failure; stage comments post once');
}

/* ------------------------------- field values ---------------------------- */
{
  const f = fixture();
  loadCycle(f);
  const val = f.run('recruitFieldValue');
  assert.equal(val({ type: 'number', label: 'Hours' }, ' 3.5 '), 3.5);
  assert.throws(() => val({ type: 'number', label: 'Hours' }, 'lots'), /Hours must be a number/);
  assert.equal(val({ type: 'date', label: 'On' }, '2026-10-03'), '2026-10-03');
  assert.throws(() => val({ type: 'date', label: 'On' }, 'Oct 3'), /a date like 2026-10-03/);
  assert.equal(val({ type: 'text', label: 'Met with' }, '   '), null, 'an emptied field clears the value');
  const summary = f.run('recruitFieldSummaryOf');
  same(summary({ type: 'rating', each: true }, { each: { 'a@x.co': { v: 4 }, 'lead@cornell.edu': { v: 2 } } }, 'lead@cornell.edu'), { n: 2, avg: 3, mine: 2 });
  same(summary({ type: 'check' }, { v: true }, 'lead@cornell.edu'), true);
  console.log('PASS: typed checklist values are parsed with plain errors, and per-reviewer values summarise with the reader\'s own');
}

/* ------------------------------- insights -------------------------------- */
{
  const f = fixture();
  const st = loadCycle(f, { sub: 'insights' });
  f.mount();
  const view = f.app.querySelector('[data-rc="insights"]');
  assert.ok(view, 'the insights view draws');
  same(f.app.querySelectorAll('.ri-kpi').map((k) => k.querySelector('.ri-kpi__label').textContent), ['People', 'Still active', 'Accepted', 'Median time in cycle', 'Flagged']);
  const funnel = f.app.querySelector('[data-chart="funnel"]');
  const coffee = funnel.querySelectorAll('.ri-bar')[1];
  assert.equal(coffee.querySelectorAll('.ri-bar__fill').length, 2, 'a stage with people not done yet stacks done and not done');
  assert.match(coffee.querySelector('.ri-bar__track').getAttribute('data-tip'), /Coffee chats: 2 reached \(67% of everyone\), 1 done/);
  assert.equal(funnel.querySelectorAll('.ri-bar')[0].querySelectorAll('.ri-bar__fill').length, 1, 'where everyone who reached it is done, the bar is all ink');
  assert.match(f.app.querySelector('[data-chart="subteams"]').innerHTML, /&lt;b&gt;Bots&lt;\/b&gt;/); assert.doesNotMatch(f.app.innerHTML, /<b>Bots/);
  assert.match(f.app.querySelector('[data-chart="ck-coffee"]').textContent, /1of 2 · 50%/, 'a checkbox reads as how many of those who reached the stage');
  assert.match(f.app.querySelector('[data-chart="ck-application"]').textContent, /3.5average of 2 answers for 1 person/);
  assert.equal(f.app.querySelectorAll('.ri-daily__row').length, 3, 'forms sent per day, one row per form');
  assert.equal(f.app.querySelector('.ri-daily__cols').getAttribute('style'), '--days:3', 'every day between the first and the last');
  // Every chart has a table.
  const toggle = funnel.querySelector('[data-action="recruit-insight-table"]');
  await f.click(toggle);
  const table = f.app.querySelector('[data-chart="funnel"] .ri-table');
  assert.ok(table, 'the table replaces the chart');
  same(table.querySelectorAll('thead th').map((th) => th.textContent), ['Stage', 'Reached', 'Share of everyone', 'Done', 'Done of reached']);
  same(table.querySelectorAll('tbody tr')[1].querySelectorAll('td').map((td) => td.textContent), ['Coffee chats', '2', '67%', '1', '50%']);
  assert.ok(f.document.activeElement === f.app.querySelector('[data-chart="funnel"] [data-action="recruit-insight-table"]'), 'focus stays on the toggle');
  assert.doesNotMatch(f.app.innerHTML, /NaN|undefined/, 'no missing numbers');
  // No people yet; a failed load offers a retry.
  st.insights.data = { ...insights(), people: 0 };
  f.mount();
  assert.match(f.app.innerHTML, /No one yet/);
  st.insights = { key: st.key + ':cy-a', data: null, loading: false, error: 'boom' };
  f.mount();
  assert.match(f.app.innerHTML, /Could not load: boom/); assert.ok(f.app.querySelector('[data-action="recruit-insights-retry"]'));
  // One request serves the chart, a stage's header and this view.
  st.insights = undefined;
  const loading = f.run('recruitLoadInsights()');
  f.run('recruitLoadInsights()');
  assert.equal(f.requests.filter((r) => r.url === '/recruit/cycles/cy-a/insights').length, 1, 'a load in flight is shared');
  (await f.pending('/recruit/cycles/cy-a/insights')).resolve(insights()); await loading;
  assert.equal(st.insights.data.people, 3);
  console.log('PASS: insights draw KPIs, stacked reach and completion, status, daily forms, who applied and checklist summaries, each with a table, escaped and without gaps');
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
  f.run("RECRUIT.mount({ name: 'recruit', params: {} })");
  assert.equal(f.navs.length, 0, 'two live cycles keep the index');
  f.run("RECRUIT.mount({ name: 'recruit', params: { id: 'cy-a' } })");
  const cycleReq = f.requests.find((r) => r.url === '/recruit/cycles/cy-a');
  f.run("RECRUIT.mount({ name: 'recruit', params: { id: 'cy-b' } })");   // switched before the answer
  cycleReq.resolve({ cycle: cycleRow(), sections: sections(), counts: { total: 1, bySection: {} }, me: { roles: ['admin'] } }); await f.settle();
  const st = f.run('recruitState()');
  assert.equal(st.cycleId, 'cy-b'); assert.equal(st.cycle?.loading, true, 'a late cycle answer after a switch is dropped');
  f.requests.find((r) => r.url === '/recruit/cycles/cy-b').resolve({ cycle: cycleRow({ id: 'cy-b', name: 'B' }), sections: sections(), team: [{ email: 'lead@cornell.edu', name: 'Lead' }], counts: { total: 0, bySection: {} }, me: { email: 'lead@cornell.edu', roles: ['admin'] } }); await f.settle();
  assert.equal(st.cycle.data.id, 'cy-b'); assert.equal(st.cycle.role, 'admin'); same(st.cycle.team.map((m) => m.email), ['lead@cornell.edu'], 'the cycle brings its team for member fields');
  f.run("RECRUIT.mount({ name: 'recruit', params: { id: 'cy-b' } })");
  const insightReq = f.requests.find((r) => r.url === '/recruit/cycles/cy-b/insights');
  assert.ok(insightReq, 'a cycle opens on its flow, which loads the counts');
  f.run("RECRUIT.reset('cy-a')");
  insightReq.resolve(insights()); await f.settle();
  assert.equal(st.insights, undefined, 'a late answer after a cycle switch is dropped');
  assert.ok(f.requests.every((r) => r.signal instanceof AbortSignal), 'every fetch carries an AbortSignal');
  assert.equal(f.renders.length, 0);
  // A signed-in member on another route still learns about their cycles once.
  const g = fixture({ admin: false }); g.ctx.UI.route = { name: 'home', params: {} };
  g.run("RECRUIT.mount({ name: 'home', params: {} })");
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
  const tick = f.run('recruitSyncTick()');
  (await f.pending('/recruit/cycles?all=1')).resolve({ cycles: [{ id: 'cy-a', name: 'Fall 2026', status: 'open', counts: { total: 7, bySection: { interest: 4, coffee: 3 } }, version: 3 }], intakeCycleId: 'cy-a', migration: { done: true } });
  await f.settle();
  const s2 = sections(); s2.coffee.title = 'Coffee, renamed elsewhere';
  (await f.pending('/recruit/cycles/cy-a')).resolve({ cycle: cycleRow({ version: 4 }), sections: s2, counts: { total: 7, bySection: { interest: 4, coffee: 3 } }, me: { roles: ['admin'] } });
  await f.settle();
  (await f.pending('/recruit/cycles/cy-a/insights')).resolve(insights());
  await tick;
  assert.equal(f.run("recruitSectionTitle('coffee')"), 'Coffee, renamed elsewhere', 'a change made elsewhere arrives');
  same(f.backgrounds, ['recruit'], 'a newer cycle repaints in the background');
  assert.equal(f.renders.length, 0, 'the sync loop never renders directly');
  assert.ok(st._syncTimer, 'the loop rescheduled itself'); f.run('clearTimeout(recruitState()._syncTimer)');
  // Unsaved stage work holds the cycle still.
  st.stageDrafts = { 'cy-a:coffee': { id: 'cy-a:coffee', model: { title: 'Draft' }, saved: JSON.stringify({ title: 'Saved' }), saving: false } };
  assert.ok(f.run('RECRUIT.dirty()'));
  const tick2 = f.run('recruitSyncTick()');
  (await f.pending('/recruit/cycles?all=1')).resolve({ cycles: [], intakeCycleId: 'cy-a', migration: { done: true } });
  await tick2;
  assert.ok(!f.requests.some((r) => !r.done && r.url === '/recruit/cycles/cy-a'), 'no cycle refresh over unsaved work');
  f.run('clearTimeout(recruitState()._syncTimer)');
  st.stageDrafts = {};
  f.ctx.UI.modal = { kind: 'confirm' };
  const before = f.requests.length;
  await f.run('recruitSyncTick()');
  assert.equal(f.requests.length, before, 'no fetch while a dialog is open'); f.run('clearTimeout(recruitState()._syncTimer)');
  f.ctx.UI.modal = null; f.ctx.UI.route = { name: 'home', params: {} };
  f.run('RECRUIT.sync()'); assert.equal(st._syncTimer, null, 'leaving the route stops the loop');
  console.log('PASS: the sync loop brings changes made elsewhere, holds still over unsaved work and behind dialogs, and never renders directly');
}

/* ------------------------------- drafts and dates ------------------------ */
{
  const f = fixture(); loadCycle(f);
  const draft = f.run('recruitPersonDraft')('draft@example.test');
  draft.text = 'Survives reload'; draft.id = 'ic-retry-persisted'; draft.stage = 'coffee';
  f.run('recruitSavePersonDraft')(draft);
  f.run('recruitState()').drafts = {};
  const restored = f.run('recruitPersonDraft')('draft@example.test');
  same([restored.text, restored.id, restored.stage], [draft.text, draft.id, 'coffee']);
  f.ctx.Store.me = () => ({ email: 'other@example.test' });
  assert.equal(f.run('recruitPersonDraft')('draft@example.test').text, '', 'another account cannot read this draft');
  f.ctx.Store.me = () => ({ email: 'lead@cornell.edu' });
  f.ctx.localStorage.setItem(draft.key, JSON.stringify({ text: 'Other tab', id: null }));
  restored.text = ''; restored.id = null; f.run('recruitSavePersonDraft')(restored);
  assert.equal(JSON.parse(f.ctx.localStorage.getItem(draft.key)).text, 'Other tab', 'posting does not erase newer work from another tab');
  const savedSet = f.ctx.localStorage.setItem;
  f.ctx.localStorage.setItem = () => { throw new Error('Quota'); };
  restored.text = 'Still here'; f.run('recruitSavePersonDraft')(restored);
  assert.equal(restored.storageError, true);
  assert.match(f.run('recruitPersonDraftError')(restored), /Keep this tab open/);
  f.ctx.localStorage.setItem = savedSet;
  assert.equal(f.run("recruitParseDate('2026-09-26', true)"), Date.parse('2026-09-27T03:59:59.999Z'));
  assert.equal(f.run("recruitParseDate('2026-12-26', true)"), Date.parse('2026-12-27T04:59:59.999Z'));
  assert.equal(f.run("recruitDateInput(recruitParseDate('2026-09-26', true))"), '2026-09-26');
  assert.ok(Number.isNaN(f.run("recruitParseDate('2026-02-30', true)")));
  console.log('PASS: comment drafts survive reloads with their stage, stay per account, never erase another tab\'s work, report storage errors, and deadlines end on Eastern days');
}

console.log('PASS: recruit UI — registry, shell, index, settings, flow chart, stage page, People, person page, insights, loaders and sync');
