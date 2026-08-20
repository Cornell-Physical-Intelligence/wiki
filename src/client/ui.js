/* ============================================================================
   UI — router, views, editor, palette, admin. No framework: views are
   template strings re-rendered on navigation; one delegated click handler
   routes data-action attributes; the editor and 3D viewer manage their own
   DOM inside mounted containers.
   ========================================================================== */

'use strict';

/* ------------------------------- icons ----------------------------------- */

const I = {
  smilePlus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M22 11.5V12a10 10 0 1 1-9.5-9.99"/><path d="M8 14.5s1.5 2 4 2 4-2 4-2"/><path d="M9 9.5h.01M15 9.5h.01"/><path d="M16 5h6M19 2v6"/></svg>',
  logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 6.5A2.5 2.5 0 016.5 4H20v13.5a2.5 2.5 0 01-2.5 2.5H4z"/><path d="M4 17.5A2.5 2.5 0 016.5 15H20"/><path d="M8.5 8h7M8.5 11h4"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 10.5L12 4l8 6.5V20h-5.5v-5h-5v5H4z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.2 2"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3.6l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.2 6.9 19l1.1-5.6L3.8 9.5l5.7-.7z"/></svg>',
  starFill: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.6l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.2 6.9 19l1.1-5.6L3.8 9.5l5.7-.7z"/></svg>',
  page: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4M9.5 12h5M9.5 15.5h5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 9l6 6 6-6"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 20h4.5L20 8.5a2.1 2.1 0 00-3-3L5.5 17z"/><path d="M14.5 8l3 3"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 12a8 8 0 108-8 8.3 8.3 0 00-6 2.7L4 8.5"/><path d="M4 4v4.5H8.5M12 8v4l3 2"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 7h14M10 7V5h4v2m-7.5 0l.8 13h9.4l.8-13M10 11v6m4-6v6"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="9" cy="8.5" r="3.5"/><path d="M3.5 20a5.5 5.5 0 0111 0M16 5.5a3.5 3.5 0 010 6.4M17.5 14.5a5.5 5.5 0 013 5.5"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 14a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7M14 10a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7"/></svg>',
  arrowL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M15 5l-7 7 7 7"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.3a2.6 2.6 0 115.1.8c-.6 1.1-2.1 1.5-2.1 2.9M12 16.8h.01"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M21 3L10.5 13.5M21 3l-6.8 18-3.7-7.5L3 9.8z"/></svg>',
  google: '<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.46a5.53 5.53 0 01-2.4 3.62v3h3.87c2.27-2.09 3.57-5.17 3.57-8.81z"/><path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.1A12 12 0 0012 24z"/><path fill="#FBBC05" d="M5.27 14.28a7.2 7.2 0 010-4.56v-3.1H1.29a12 12 0 000 10.76z"/><path fill="#EA4335" d="M12 4.76c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 001.29 6.62l3.98 3.1C6.22 6.87 8.87 4.76 12 4.76z"/></svg>',
  cube: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2.5l8 4.6v9.3l-8 4.6-8-4.6V7.1z"/><path d="M12 21V11.7m0 0L4 7.1m8 4.6l8-4.6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M13 2.5L4.5 13.5H11l-1 8 8.5-11H12z"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M4 17.5l5-4.5 4 3.5 3.5-3 3.5 3"/></svg>',
  paperclip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20 11.5l-8.2 8.2a5.2 5.2 0 01-7.4-7.4l8.6-8.6a3.5 3.5 0 015 5l-8.3 8.2a1.8 1.8 0 01-2.5-2.5L14.5 7"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 7.7h.01" stroke-width="2.4"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 2.8l7.5 3v6c0 4.6-3 8.3-7.5 9.7-4.5-1.4-7.5-5.1-7.5-9.7v-6z"/><path d="M8.8 12l2.2 2.2 4.2-4.2"/></svg>',
};

// Standardize the chrome on Lucide (the star keeps its filled variant, the
// Google mark and CUPI logo stay brand-exact).
Object.assign(I, {
  search: lucide('search', 1.8),
  home: lucide('home', 1.8),
  clock: lucide('clock', 1.8),
  star: lucide('star', 1.8),
  page: lucide('page', 1.8),
  plus: lucide('plus', 2),
  edit: lucide('edit', 1.8),
  dots: lucide('dots', 1.8),
  menu: lucide('menu', 1.8),
  history: lucide('historyIcon', 1.8),
  trash: lucide('trash', 1.8),
  users: lucide('users', 1.8),
  link: lucide('wikilink', 1.8),
  x: lucide('x', 2),
  help: lucide('help', 1.8),
  mail: lucide('mail', 1.8),
  send: lucide('send', 1.8),
  copy: lucide('copy', 1.8),
  image: lucide('image', 1.8),
  paperclip: lucide('attach', 1.8),
  shield: lucide('shield', 1.8),
  check: lucide('check', 2.2),
  info: lucide('info', 1.8),
  cube: lucide('cube', 1.8),
});

/* ------------------------------- ui state -------------------------------- */

const UI = {
  route: { name: 'login', params: {} },
  navOpen: false,
  navHidden: false,
  palette: null,          // {q, sel, results}
  modal: null,            // {kind, ...}
  menu: null,             // {items, x, y}
  toasts: [],
  editor: null,           // live editor state
  chooser: false,         // login account chooser
  loginError: null,
};

const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => [...(el || document).querySelectorAll(sel)];

const mdCtx = (extra) => ({
  att: (id) => Store.att(id),
  pageByTitle: (t) => Store.pageByTitle(t),
  readonly: false,
  ...extra,
});

let toastSeq = 0;

function toast(msg, action) {
  const t = { id: 't' + (++toastSeq), msg, action };
  UI.toasts.push(t);
  renderToasts();
  setTimeout(() => dismissToast(t), action ? 6500 : 3200);
}

function dismissToast(t) {
  if (!UI.toasts.includes(t)) return;
  UI.toasts = UI.toasts.filter((x) => x !== t);
  const node = document.querySelector(`.toast[data-tid="${t.id}"]`);
  if (!node) return;
  // Play the exit in place, then drop the node — settled neighbours never
  // re-render, so they don't replay their own entrance.
  node.classList.add('leaving');
  setTimeout(() => node.remove(), 160);
}

function renderToasts() {
  let host = $('.toasts');
  if (!host) { host = document.createElement('div'); host.className = 'toasts'; document.body.appendChild(host); }
  const live = new Set(UI.toasts.map((t) => t.id));
  for (const node of [...host.children]) {
    if (!live.has(node.dataset.tid) && !node.classList.contains('leaving')) node.remove();
  }
  for (const t of UI.toasts) {
    if (host.querySelector(`.toast[data-tid="${t.id}"]`)) continue;
    const node = document.createElement('div');
    node.className = 'toast';
    node.dataset.tid = t.id;
    node.innerHTML = `${MD.esc(t.msg)}${t.action ? `<button data-action="toast-act" data-tid="${t.id}">${MD.esc(t.action.label)}</button>` : ''}`;
    host.appendChild(node);
  }
}

/* ------------------------------- router ---------------------------------- */

function parseHash() {
  let h = location.hash.replace(/^#\/?/, '');
  // "#/page/leg-design#test-results" → route to the page, remember the anchor.
  let anchor = null;
  const ai = h.indexOf('#');
  if (ai >= 0) { anchor = h.slice(ai + 1); h = h.slice(0, ai); }
  const [path, qs] = h.split('?');
  const seg = path.split('/').filter(Boolean);
  const params = {};
  if (qs) for (const kv of qs.split('&')) { const [k, v] = kv.split('='); params[k] = decodeURIComponent(v || ''); }
  if (anchor) params.anchor = anchor;
  return { seg, params };
}

function nav(hash) { location.hash = hash; }

function route() {
  const { seg, params } = parseHash();
  const me = Store.me();
  const name = seg[0] || (me ? 'page' : 'login');
  if (!me && !['login', 'denied'].includes(name)) { UI.route = { name: 'login', params: {} }; return; }
  if (me && name === 'login') { UI.route = { name: 'page', params: { id: 'welcome' } }; return; }
  // The formatting guide is a real (searchable, editable) page now; keep old links working.
  if (name === 'guide') { UI.route = { name: 'page', params: { id: 'formatting-guide' } }; return; }
  UI.route = { name, params: { id: seg[1], ...params } };
}

/* ------------------------------- login ----------------------------------- */

function viewLogin() {
  const denied = UI.route.name === 'denied';
  return `<div class="login">
    <h1 class="login__wordmark">CUPI</h1>
    <p class="login__sub">Cornell University Physical Intelligence — Internal Wiki</p>
    <div class="login__card">
      ${UI.loginError ? `<div class="login__error">${UI.loginError}</div>` : ''}
      ${denied ? `<div class="login__error"><b>${MD.esc(UI.route.params.email || 'This account')}</b> isn't on the member list yet. Ask any admin to add you — you'll get an invite code by email.</div>` : ''}
      ${UI.chooser ? viewChooser() : `
      <button class="login__google" data-action="login-google">${I.google} Continue with Google</button>
      <p class="login__hint">Use your <b>@cornell.edu</b> account. Access is limited to the CUPI roster — if you've been added, signing in is all it takes.</p>`}
    </div>
    <p class="login__foot">Preview build — sign-in is simulated and data stays in this browser.<br>CUPI is a registered student organization of Cornell University.</p>
  </div>`;
}

function viewChooser() {
  const actives = Store.s.users.filter((u) => u.status === 'active');
  return `<div class="chooser">
    <p class="chooser__head">Choose an account <span style="color:var(--faint)">· preview stand-in for Google sign-in</span></p>
    ${actives.map((u) => `<button class="chooser__item" data-action="login-as" data-email="${u.email}">
      <span class="avatar avatar--lg">${Store.initials(u.email)}</span>
      <span><span class="chooser__name">${MD.esc(u.name)}</span><br><span class="chooser__mail">${u.email}</span></span>
      ${u.role === 'admin' ? '<span class="chooser__note">admin</span>' : ''}
    </button>`).join('')}
    <button class="chooser__item" data-action="login-as" data-email="visitor@cornell.edu">
      <span class="avatar avatar--lg" style="background:var(--hover);color:var(--muted)">?</span>
      <span><span class="chooser__name">Someone not on the roster</span><br><span class="chooser__mail">visitor@cornell.edu</span></span>
      <span class="chooser__note">no access</span>
    </button>
    <button class="btn btn--ghost" data-action="login-back">Back</button>
  </div>`;
}

/* ------------------------------- shell ----------------------------------- */

// Flat by design: one row per page, grouped by section. Nesting was tried
// and removed — it hid pages and confused navigation.
function treeRow(p, cur, prefs) {
  // The Home navlink already marks Welcome; don't double-highlight it here.
  const active = p.id === cur && cur !== 'welcome';
  return `<div class="tree-item">
    <a class="tree-item__row ${active ? 'active' : ''}" href="#/page/${p.id}">
      <span class="tree-item__label">${MD.esc(p.title)}</span>
      ${typeof draftStash !== 'undefined' && draftStash.has(p.id) ? '<span class="tree-item__draftdot" title="You have an unsaved draft here"></span>' : ''}
      ${prefs.starred.includes(p.id) ? `<span class="tree-item__star">${I.starFill}</span>` : ''}
    </a>
  </div>`;
}

function sectionTree(sec) {
  const pages = Store.inSection(sec.id);
  const prefs = Store.prefs();
  const collapsed = prefs.collapsed.includes(sec.id);
  const cur = UI.route.params.id;
  return `<div class="tree-section ${collapsed ? 'collapsed' : ''}" data-sec="${sec.id}">
    <button class="tree-section__head" data-action="sec-toggle" data-sec="${sec.id}" aria-expanded="${!collapsed}">
      <svg class="tree-section__chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
      <span class="eyebrow">${sec.name}</span>
      <span class="tree-section__add" data-action="new-page" data-sec="${sec.id}" role="button" aria-label="New page in ${sec.name}" title="New page in ${sec.name}">${I.plus}</span>
    </button>
    <div class="tree-section__body"><div class="tree-section__rows">
      ${pages.map((p) => treeRow(p, cur, prefs)).join('')}
    </div></div>
  </div>`;
}

function viewSidebar() {
  const me = Store.me();
  const prefs = Store.prefs();
  const starred = prefs.starred.map((id) => Store.page(id)).filter(Boolean);
  const r = UI.route;
  return `<aside class="sidebar">
    <div class="sidebar__head">
      <a class="sidebar__brand" href="#/page/welcome"><img class="sidebar__logo" src="${CUPI_LOGO}" alt="" draggable="false">CUPI <span>Wiki</span></a>
    </div>
    <button class="sidebar__search" data-action="palette">
      ${I.search} <span>Search…</span> <span class="kbd">⌘K</span>
    </button>
    <nav class="sidebar__nav">
      <a class="navlink ${r.name === 'page' && r.params.id === 'welcome' ? 'active' : ''}" href="#/page/welcome">${I.home} Home</a>
      <a class="navlink ${r.name === 'activity' ? 'active' : ''}" href="#/activity" title="Everything that changed, newest first">${I.clock} Activity</a>
      <a class="navlink ${r.name === 'health' ? 'active' : ''}" href="#/health" title="Broken links, orphans, and stale pages">${I.shield} Wiki health</a>
      <button class="navlink" data-action="new-page">${I.plus} New page <span class="kbd">N</span></button>
    </nav>
    <div class="sidebar__scroll">
      ${starred.length ? `<div class="tree-section"><div class="tree-section__head" style="cursor:default"><span class="tree-section__chev" style="width:10px"></span><span class="eyebrow">Starred</span></div><div class="tree-section__body"><div class="tree-section__rows">
        ${starred.map((p) => `<div class="tree-item"><a class="tree-item__row ${p.id === r.params.id ? 'active' : ''}" href="#/page/${p.id}"><span class="tree-item__label">${MD.esc(p.title)}</span><span class="tree-item__star">${I.starFill}</span></a></div>`).join('')}
      </div></div></div>` : ''}
      ${SECTIONS.map(sectionTree).join('')}
    </div>
    <div class="sidebar__foot">
      <button class="sidebar__user" data-action="user-menu" aria-label="Account menu">
        <span class="avatar">${Store.initials(me.email)}</span>
        <span style="min-width:0"><span class="sidebar__user-name">${MD.esc(me.name)}</span><br><span class="sidebar__user-mail">${me.email}</span></span>
      </button>
      ${me.role === 'admin' ? `<a class="icon-btn ${r.name === 'admin' ? 'active' : ''}" href="#/admin" aria-label="Members and access" title="Members &amp; access">${I.users}</a>` : ''}
      <button class="icon-btn" data-action="help-menu" aria-label="Help" title="Help">${I.help}</button>
    </div>
  </aside>`;
}

function topbar(crumbHtml, right) {
  return `<header class="topbar">
    <button class="icon-btn" data-action="nav-toggle" aria-label="Toggle sidebar">${I.menu}</button>
    <nav class="crumbs">${crumbHtml}</nav>
    ${right || ''}
  </header>`;
}

/* ------------------------------- page view ------------------------------- */

function crumbsFor(p) {
  const sec = SECTIONS.find((s) => s.id === p.section);
  return `<a href="#/page/welcome">Wiki</a><span class="crumbs__sep">/</span>` +
    (sec ? `<a href="#/section/${sec.id}">${sec.name}</a><span class="crumbs__sep">/</span>` : '') +
    `<span class="crumbs__here">${MD.esc(p.title)}</span>`;
}

function viewPage(id) {
  const p = Store.page(id);
  if (!p) return viewMissing(id);
  Store.touchRecent(id);
  const { html, toc } = MD.render(p.body, mdCtx({ pageId: id }));
  const starred = Store.prefs().starred.includes(id);
  const backlinks = Store.backlinks(id);
  const me = Store.me();
  const infoOpen = UI.pageInfo === id;

  const right = `
    <button class="btn btn--sm topbar__edit" data-action="edit" data-id="${id}">${I.edit} Edit <span class="kbd">E</span></button>
    ${toc.length > 1 ? `<button class="icon-btn toc-btn" data-action="toc-menu" data-id="${id}" aria-label="Contents" title="Contents">${lucide('ul', 1.8)}</button>` : ''}
    <button class="icon-btn ${starred ? 'active' : ''}" data-action="star" data-id="${id}" aria-label="${starred ? 'Unstar' : 'Star'} page" title="${starred ? 'Unstar' : 'Star'}">${starred ? I.starFill : I.star}</button>
    <a class="icon-btn" href="#/history/${id}" aria-label="Page history" title="History">${I.history}</a>
    <button class="icon-btn" data-action="page-menu" data-id="${id}" aria-label="Page options" title="Page options">${I.dots}</button>`;

  return topbar(crumbsFor(p), right) + `
  <div class="content" data-toc-root>
    <div class="page-wrap">
      <article class="page-col">
        <header class="page-head">
          <div class="page-head__titlerow">
            <h1>${MD.esc(p.title)}</h1>
          </div>
          <div class="page-head__byline">
            <span class="who"><span class="avatar" style="width:20px;height:20px;font-size:9px">${Store.initials(p.owner)}</span> ${MD.esc(Store.userName(p.owner))}</span>
            <button class="page-head__info ${infoOpen ? 'active' : ''}" data-action="page-info" data-id="${id}" aria-label="Page details" aria-expanded="${infoOpen}" title="Page details">${I.info}</button>
            ${typeof draftStash !== 'undefined' && draftStash.has(id) ? `<button class="draft-chip" data-action="edit" data-id="${id}" title="Resume your unsaved draft"><span class="dot dot--accent"></span>Unsaved draft · Resume</button>` : ''}
          </div>
          ${infoOpen ? `<div class="page-head__meta">
            <span>created ${relTime(p.created)}</span>
            <span>last edit ${MD.esc(Store.userName(p.updatedBy))} · ${relTime(p.updated)}</span>
            <span>${p.revs.length} revision${p.revs.length === 1 ? '' : 's'}</span>
            <span>${Math.max(1, Math.round(MD.mdToText(p.body).split(/\s+/).length / 220))} min read</span>
            ${(() => { const { total, done } = MD.countTasks(p.body); if (!total) return ''; return `<span class="taskmeter"><span class="taskmeter__bar"><span style="width:${Math.round(done / total * 100)}%"></span></span>${done}/${total} tasks</span>`; })()}
          </div>` : ''}
        </header>
        <div class="prose" data-page="${id}">${html}</div>
        <footer class="page-foot">
          ${backlinks.length ? `<div class="backlinks"><span class="eyebrow">Linked from</span><div class="backlinks__list">
            ${backlinks.map((b) => `<a class="backlink" href="#/page/${b.id}">${I.link} ${MD.esc(b.title)}</a>`).join('')}
          </div></div>` : ''}
          <div class="reactions">
            ${reactionChips(p)}
            <button class="reaction reaction--add" data-action="react-add" data-id="${id}" aria-label="Add a reaction" title="Add a reaction">${I.smilePlus}</button>
          </div>
        </footer>
      </article>
      ${toc.length > 1 ? `<nav class="toc"><div class="toc__list">${toc.map((t) => `<a href="#/page/${id}#${t.id}" class="${t.lvl === 3 ? 'lvl3' : ''}" data-toc="${t.id}">${MD.esc(t.text)}</a>`).join('')}</div></nav>` : ''}
    </div>
  </div>`;
}

function viewMissing(id) {
  return topbar(`<a href="#/page/welcome">Wiki</a><span class="crumbs__sep">/</span><span class="crumbs__here">Not found</span>`) + `
  <div class="content"><div class="page-wrap"><div class="page-col"><div class="empty">
    ${I.page}<b>No page here</b><p>“${MD.esc(id || '')}” doesn't exist — it may have been moved to Trash.</p>
    <button class="btn" data-action="new-page">${I.plus} New page</button>
  </div></div></div></div>`;
}

function viewSection(secId) {
  const sec = SECTIONS.find((s) => s.id === secId);
  if (!sec) return viewMissing(secId);
  const pages = Store.inSection(secId);
  return topbar(`<a href="#/page/welcome">Wiki</a><span class="crumbs__sep">/</span><span class="crumbs__here">${sec.name}</span>`,
    `<button class="btn" data-action="new-page" data-sec="${secId}">${I.plus} New page</button>`) + `
  <div class="content"><div class="page-wrap"><div class="page-col">
    <div class="plain-head"><span class="eyebrow">Section</span><h1>${sec.name}</h1></div>
    <div class="cardlist">
      ${pages.map((p) => `<a class="pagecard" href="#/page/${p.id}"><b>${MD.esc(p.title)}</b><span class="snip">${MD.esc(MD.mdToText(p.body).slice(0, 130))}</span><span class="meta">${MD.esc(Store.userName(p.updatedBy))} · ${relTime(p.updated)}</span></a>`).join('')}
    </div>
    ${pages.length === 0 ? `<div class="empty">${I.page}<b>Nothing here yet</b><p>Start the first page in ${sec.name}.</p></div>` : ''}
  </div></div></div>`;
}

/* ------------------------------- 3D viewer ------------------------------- */

function parseSTL(buf) {
  if (buf.byteLength < 15) return null; // smaller than the smallest legal ASCII STL
  const dv = new DataView(buf);
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(80, buf.byteLength))).trim();
  // Binary detection tolerates trailing padding, and wins even when the 80-byte
  // header starts with "solid" (SolidWorks exports do this).
  let isBinary = false;
  if (buf.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (n > 0 && buf.byteLength >= 84 + n * 50 && buf.byteLength < 84 + n * 50 + 512) isBinary = true;
  }
  const verts = [];
  if (!isBinary) {
    if (!head.startsWith('solid')) return null;
    const txt = new TextDecoder().decode(buf);
    const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    let m;
    while ((m = re.exec(txt))) verts.push(+m[1], +m[2], +m[3]);
  } else {
    const n = dv.getUint32(80, true);
    let o = 84;
    for (let i = 0; i < n && o + 50 <= buf.byteLength; i++, o += 50) {
      for (let v = 0; v < 3; v++) {
        verts.push(dv.getFloat32(o + 12 + v * 12, true), dv.getFloat32(o + 16 + v * 12, true), dv.getFloat32(o + 20 + v * 12, true));
      }
    }
  }
  if (!verts.length || verts.some((v) => !isFinite(v))) return null;
  return new Float32Array(verts);
}

function parseOBJ(text) {
  const vs = [], out = [];
  for (const line of text.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'v') vs.push([+t[1], +t[2], +t[3]]);
    else if (t[0] === 'f') {
      const idx = t.slice(1).map((s) => { let i = parseInt(s.split('/')[0], 10); return i < 0 ? vs.length + i : i - 1; });
      if (idx.some((j) => !vs[j])) continue; // skip faces with out-of-range indices
      for (let k = 1; k + 1 < idx.length; k++) {
        for (const j of [idx[0], idx[k], idx[k + 1]]) { const v = vs[j]; out.push(v[0], v[1], v[2]); }
      }
    }
  }
  if (!out.length || out.some((v) => !isFinite(v))) return null;
  return new Float32Array(out);
}

async function mountCadViewer(host) {
  const att = Store.att(host.dataset.att);
  const canvas = $('canvas', host);
  if (!att || !canvas) return;
  let buffer;
  if (att.dataUri) {
    const b64 = att.dataUri.slice(att.dataUri.indexOf(',') + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    buffer = bytes.buffer;
  } else if (att.url) {
    try { buffer = await (await fetch(att.url)).arrayBuffer(); } catch (e) { return; }
    if (!canvas.isConnected) return; // page changed while fetching
  } else return;
  let verts = null;
  try { verts = /\.obj$/i.test(att.name) ? parseOBJ(new TextDecoder().decode(buffer)) : parseSTL(buffer); } catch (e) { verts = null; }
  if (!verts) { host.querySelector('.cad-embed__stage').innerHTML = `<div class="empty" style="padding:24px"><b>Couldn't read this model</b><p>${MD.esc(att.name)} doesn't parse as ${/\.obj$/i.test(att.name) ? 'OBJ' : 'STL'} — re-export it and re-attach.</p></div>`; return; }

  // Center + scale.
  let min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  for (let i = 0; i < verts.length; i += 3)
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], verts[i + a]); max[a] = Math.max(max[a], verts[i + a]); }
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;

  const nTri = verts.length / 9;
  const state = { rx: -1.05, rz: 0.7, zoom: 1, spin: true, drag: null };
  const ink = () => getComputedStyle(document.body).color;

  function draw() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = host.clientWidth, hpx = 300;
    if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = hpx * dpr; canvas.style.height = hpx + 'px'; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hpx);
    const s = (Math.min(w, hpx) / span) * 0.62 * state.zoom;
    const cx = w / 2, cy = hpx / 2;
    const cosZ = Math.cos(state.rz), sinZ = Math.sin(state.rz), cosX = Math.cos(state.rx), sinX = Math.sin(state.rx);
    const tris = [];
    for (let i = 0; i < verts.length; i += 9) {
      const pts = [];
      let depth = 0;
      for (let v = 0; v < 3; v++) {
        let x = verts[i + v * 3] - c[0], y = verts[i + v * 3 + 1] - c[1], z = verts[i + v * 3 + 2] - c[2];
        let x1 = x * cosZ - y * sinZ, y1 = x * sinZ + y * cosZ;
        let y2 = y1 * cosX - z * sinX, z2 = y1 * sinX + z * cosX;
        depth += z2;
        pts.push([cx + x1 * s, cy - y2 * s, z2]);
      }
      const ux = pts[1][0] - pts[0][0], uy = pts[1][1] - pts[0][1];
      const vx = pts[2][0] - pts[0][0], vy = pts[2][1] - pts[0][1];
      const nz = ux * vy - uy * vx;
      if (nz >= 0) continue; // backface (screen y is flipped)
      // World normal for lighting.
      const e1 = [verts[i + 3] - verts[i], verts[i + 4] - verts[i + 1], verts[i + 5] - verts[i + 2]];
      const e2 = [verts[i + 6] - verts[i], verts[i + 7] - verts[i + 1], verts[i + 8] - verts[i + 2]];
      let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nzw = e1[0] * e2[1] - e1[1] * e2[0];
      const l = Math.hypot(nx, ny, nzw) || 1;
      // Rotate normal like the verts (z-rot then x-rot) and light from camera-ish.
      let rnx = (nx / l) * cosZ - (ny / l) * sinZ, rny = (nx / l) * sinZ + (ny / l) * cosZ;
      let rny2 = rny * cosX - (nzw / l) * sinX, rnz = rny * sinX + (nzw / l) * cosX;
      const lam = Math.max(0, rnz * 0.85 + rny2 * -0.25 + rnx * 0.2);
      tris.push({ pts, depth: depth / 3, lam });
    }
    tris.sort((a, b) => a.depth - b.depth);
    const dark = document.body.dataset.viewerDark === '1';
    for (const t of tris) {
      const g = dark ? 40 + t.lam * 150 : 235 - t.lam * 150;
      ctx.beginPath();
      ctx.moveTo(t.pts[0][0], t.pts[0][1]);
      ctx.lineTo(t.pts[1][0], t.pts[1][1]);
      ctx.lineTo(t.pts[2][0], t.pts[2][1]);
      ctx.closePath();
      ctx.fillStyle = `rgb(${g | 0},${g | 0},${g | 0})`;
      ctx.fill();
      if (nTri < 4000) { ctx.strokeStyle = dark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.05)'; ctx.stroke(); }
    }
  }

  let raf;
  function loop() {
    if (state.spin) { state.rz += 0.004; draw(); }
    raf = requestAnimationFrame(loop);
  }
  canvas.addEventListener('pointerdown', (e) => {
    state.spin = false; state.drag = { x: e.clientX, y: e.clientY, rx: state.rx, rz: state.rz };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!state.drag) return;
    state.rz = state.drag.rz + (e.clientX - state.drag.x) * 0.011;
    state.rx = state.drag.rx + (e.clientY - state.drag.y) * 0.011;
    draw();
  });
  canvas.addEventListener('pointerup', () => { state.drag = null; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.zoom = Math.min(6, Math.max(0.3, state.zoom * (e.deltaY < 0 ? 1.09 : 0.92)));
    draw();
  }, { passive: false });
  draw();
  loop();
  cadCleanups.push(() => cancelAnimationFrame(raf));
}

let cadCleanups = [];

/* ------------------------------- lightbox -------------------------------- */

function closeLightbox() {
  const veil = document.querySelector('.lightbox');
  if (!veil || veil.classList.contains('leaving')) return;
  veil.classList.add('leaving');
  setTimeout(() => veil.remove(), 130);
}

function openLightbox(src, alt) {
  const veil = document.createElement('div');
  veil.className = 'lightbox';
  veil.innerHTML = `<img src="${src}" alt="${MD.esc(alt || '')}"><button class="icon-btn lightbox__close" aria-label="Close">${I.x}</button>`;
  veil.addEventListener('click', closeLightbox);
  document.body.appendChild(veil);
}

function reactionChips(p) {
  const me = Store.me().email;
  return Object.entries(p.reactions || {}).map(([emoji, who]) => {
    const names = who.map((e) => Store.userName(e)).join(', ');
    return `<button class="reaction ${who.includes(me) ? 'mine' : ''}" data-action="react" data-id="${p.id}" data-emoji="${MD.esc(emoji)}" title="${MD.esc(names)}"><span class="reaction__emoji">${emoji}</span><span class="reaction__n">${who.length}</span></button>`;
  }).join('');
}
