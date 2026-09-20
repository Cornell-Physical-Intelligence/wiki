/* ============================================================================
   Applications (code name: recruit) — client core. The module registry, the
   route shell, the per-cycle state, the sync loop, and the helpers every
   recruit-*.js file shares. Each module file calls RECRUIT.register once;
   scripts/assemble.mjs concatenates them after this file and before main.js.
   Nothing here touches the shared Store; every fact lives on UI.recruit.
   ========================================================================== */

'use strict';

// recruit:core:start

/* ------------------------------- registry -------------------------------- */

function validateRecruitModule(m) {
  if (!m || typeof m !== 'object') throw new Error('A recruit module must be an object');
  if (!/^[a-z]+$/.test(String(m.name || ''))) throw new Error('A recruit module needs a lowercase name');
  if (typeof m.order !== 'number' || Number.isNaN(m.order)) throw new Error(`Recruit module "${m.name}" needs an order`);
  if (RECRUIT.modules.some((x) => x.name === m.name)) throw new Error(`Recruit module "${m.name}" is already registered`);
  for (const group of ['actions', 'inputs', 'dd', 'modals']) {
    for (const key of Object.keys(m[group] || {})) {
      if (!key.startsWith('recruit-')) throw new Error(`Recruit module "${m.name}": ${group} key "${key}" must start with recruit-`);
    }
  }
  if (m.panel && (!m.panel.id || !m.panel.label)) throw new Error(`Recruit module "${m.name}": panel needs id and label`);
}

const RECRUIT = {
  modules: [],
  register(m) { validateRecruitModule(m); this.modules.push(m); this.modules.sort((a, b) => a.order - b.order); },

  // First module (by order) that owns a key in the given group.
  find(group, key) {
    for (const m of this.modules) if (m[group] && Object.prototype.hasOwnProperty.call(m[group], key)) return { module: m, fn: m[group][key] };
    return null;
  },
  active(cycle) { return this.modules.filter((m) => recruitEnabled(m, cycle)); },

  panels(cycle, role) {
    const out = [];
    for (const m of this.active(cycle)) {
      for (const p of (m.panels || (m.panel ? [m.panel] : []))) {
        if (!p || (p.when && !p.when(cycle, role))) continue;
        out.push({ id: p.id, label: p.label, order: p.order ?? m.order, module: m });
      }
    }
    return out.sort((a, b) => a.order - b.order);
  },
  columns(cycle, role) {
    const seen = new Set(), out = [];
    for (const m of this.active(cycle)) {
      const cols = typeof m.columns === 'function' ? m.columns(cycle, role) : m.columns;
      for (const c of cols || []) {
        if (!c || seen.has(c.id) || (c.when && !c.when(cycle, role))) continue;
        seen.add(c.id); out.push(Object.assign({ module: m.name }, c));
      }
    }
    return out;
  },
  filters(cycle, role) {
    const out = [];
    for (const m of this.active(cycle)) {
      const list = typeof m.filters === 'function' ? m.filters(cycle, role) : m.filters;
      for (const f of list || []) if (f && f.group && (!f.when || f.when(cycle, role))) out.push(Object.assign({ module: m.name }, f));
    }
    return out;
  },
  selectionActions(ids, cycle, role) {
    const out = [];
    for (const m of this.active(cycle)) {
      const list = typeof m.selectionActions === 'function' ? m.selectionActions(ids, cycle, role) : m.selectionActions;
      for (const a of list || []) if (a && a.label && typeof a.run === 'function') out.push(Object.assign({ id: a.id || `${m.name}-${out.length}`, module: m.name }, a));
    }
    return out;
  },
  detailSections(app, cycle, role) {
    const out = [];
    for (const m of this.active(cycle)) {
      let list = typeof m.detailSections === 'function' ? m.detailSections(app, cycle, role) : m.detailSections;
      if (!list) continue;
      if (!Array.isArray(list)) list = [list];
      for (const s of list) {
        if (!s) continue;
        if (typeof s === 'string') out.push({ id: m.name, title: '', html: s, module: m.name });
        else if (s.html !== undefined) out.push(Object.assign({ id: m.name, title: '', module: m.name }, s));
      }
    }
    return out;
  },
  settingsSections(cycle, role) {
    const out = [];
    for (const m of this.active(cycle)) {
      let list = typeof m.settings === 'function' ? m.settings(cycle, role) : m.settings;
      if (!list) continue;
      if (!Array.isArray(list)) list = [list];
      for (const s of list) if (s && s.id && (!s.when || s.when(cycle, role))) out.push(Object.assign({ module: m.name }, s));
    }
    return out;
  },

  /* ---- delegated events (one line each in main.js hands these over) ---- */

  async click(act, el, ev, stop) {
    if (!el || el.tagName === 'FORM') return false;            // a click inside a form lands on the form's own data-action
    const hit = this.find('actions', act);
    if (!hit) return false;
    // Checkboxes and real links keep their native behaviour; everything else
    // is a button whose default would only scroll or submit.
    const native = typeof el.matches === 'function' && el.matches('input[type="checkbox"], input[type="radio"], a[href], label');
    if (native) ev?.stopPropagation?.(); else stop?.();
    await hit.fn(el, ev, stop);
    return true;
  },
  async submit(form, ev) {
    ev?.preventDefault?.();
    const act = String(form?.dataset?.action || '');
    if (!act.startsWith('recruit-')) return false;
    if (act.startsWith('recruit-settings-')) {
      const id = act.slice('recruit-settings-'.length);
      const cycle = recruitCycleRow(), role = recruitRole();
      const section = this.settingsSections(cycle, role).find((s) => s.id === id);
      if (!section?.submit) return false;
      await runAdminForm(form, () => section.submit(form, cycle, role));
      return true;
    }
    const hit = this.find('actions', act);
    if (!hit) return false;
    await hit.fn(form, ev, () => {});
    return true;
  },
  input(el, ev) {
    const hit = el?.dataset?.m ? this.find('inputs', el.dataset.m) : null;
    if (!hit) return false;
    hit.fn(el, ev);
    return true;
  },
  change(el, ev) { return this.input(el, ev); },
  keydown(ev) {
    // Tabs are a roving tablist: arrows move focus, Enter follows the link.
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key) && typeof ev.target?.matches === 'function' && ev.target.matches('.rc-tabs [role="tab"]')) {
      const tabs = $$('.rc-tabs [role="tab"]');
      const cur = tabs.indexOf(ev.target);
      if (cur < 0 || !tabs.length) return false;
      const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? tabs.length - 1 : (cur + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      ev.preventDefault();
      tabs[next].focus();
      return true;
    }
    for (const m of this.modules) if (typeof m.keydown === 'function' && m.keydown(ev)) return true;
    return false;
  },
  // dd(host) opens the menu for a recruit dropdown; dd(host, value) reports a
  // pick. A module's dd handler is called with value === undefined to open:
  // return an array of openMenu items for a computed menu, open one yourself
  // (return true), or return nothing to get the default menu from data-opts.
  // It is called again with the chosen value after a default-menu pick.
  dd(host, value) {
    const m = String(host?.dataset?.m || '');
    const hit = this.find('dd', m);
    if (value !== undefined) { hit?.fn(host, value); return true; }
    if (hit) {
      const before = UI.menu;
      const out = hit.fn(host, undefined);
      if (Array.isArray(out)) { openMenu(out, host); return true; }
      if (out === true || (UI.menu && UI.menu !== before)) return true;
    }
    openMenu(recruitDefaultMenu(host, hit?.fn), host);
    return true;
  },
  modal(m) {
    const hit = m?.kind ? this.find('modals', m.kind) : null;
    return hit ? String(hit.fn(m) ?? '') : '';
  },

  /* ---- loaders, sync, reset, api ---- */

  mount(r) {
    if (typeof REMOTE === 'undefined' || !Store.me()) return;
    const st = recruitState();
    // Once per session, for every member: non-admins with a cycle role get
    // the sidebar link from this answer.
    if (UI.recruitMe === undefined) {
      UI.recruitMe = { loading: true };
      this.api('/recruit/me')
        .then((out) => {
          UI.recruitMe = { admin: Boolean(out.admin), cycles: Array.isArray(out.cycles) ? out.cycles : [] };
          if (UI.route.name === 'recruit' || (!UI.recruitMe.admin && UI.recruitMe.cycles.length)) renderBackground(UI.route.name);
        })
        .catch((e) => { UI.recruitMe = { error: recruitError(e) }; if (UI.route.name === 'recruit') renderBackground('recruit'); });
    }
    if (r.name !== 'recruit') { clearTimeout(st._syncTimer); st._syncTimer = null; return; }
    st.me = UI.recruitMe;
    if (!st.me || st.me.loading || st.me.error) return;
    if (!st.me.admin && !st.me.cycles.length) return;
    if (st.cycles === undefined) {
      st.cycles = { loading: true };
      this.api('/recruit/cycles?all=1')
        .then((out) => { recruitAdoptCycles(out); renderBackground('recruit'); })
        .catch((e) => { st.cycles = { error: recruitError(e) }; renderBackground('recruit'); });
    }
    const id = r.params.id || null;
    if (!id) {
      if (st.cycleId) this.reset(null);
      const list = st.cycles?.list;
      if (list && !r.params.all) {
        const live = list.filter((c) => c.status !== 'archived');
        if (live.length === 1) { nav('#/applications/' + live[0].id); return; }
      }
      if (st.me.admin && st.queue === undefined) recruitLoadQueue();
      this.sync();
      return;
    }
    if (st.cycleId !== id) this.reset(id);
    if (st.cycle === undefined) {
      st.cycle = { loading: true };
      const key = st.key;
      this.api(`/recruit/cycles/${encodeURIComponent(id)}`)
        .then((out) => {
          if (st.key !== key) return;                       // switched away meanwhile
          const roles = Array.isArray(out.me?.roles) ? out.me.roles : (st.me.admin ? ['admin'] : []);
          st.cycle = { data: out.cycle, role: recruitRoleOf(roles), roles, counts: out.counts || { total: 0, bySection: {} }, sections: out.sections || null, grants: out.roles || [], notify: out.notify || [] };
          renderBackground('recruit');
        })
        .catch((e) => { if (st.key !== key) return; st.cycle = { error: recruitError(e), status: e.status }; renderBackground('recruit'); });
    }
    if (st.cycle?.data) {
      const panel = recruitActivePanel();
      st.panel = panel?.id || null;
      try { panel?.module.mount?.(st.cycle.data, st.cycle.role, panel.id); } catch (e) { console.error(e); }
    }
    this.sync();
  },

  // 30 s loop while the route is open and the tab visible. Counts and the
  // stage strip repaint in place; list rows never refresh on their own.
  sync() {
    const st = recruitState();
    clearTimeout(st._syncTimer);
    st._syncTimer = null;
    if (typeof REMOTE === 'undefined' || UI.route?.name !== 'recruit' || document.hidden) return;
    st._syncTimer = setTimeout(recruitSyncTick, RECRUIT_SYNC_MS);
  },

  reset(cycleId) {
    const st = recruitState();
    st.cycleId = cycleId || null;
    st.cycle = undefined;
    st.apps = undefined;
    st.queue = undefined;
    st.selected = new Set();
    st.selectionScope = null;
    st.detail = {};
    st.busy = new Set();
    st.mod = {};
    st.panel = null;
    st.key = (st.key || 0) + 1;
    for (const m of this.modules) { try { m.reset?.(cycleId); } catch (e) { console.error(e); } }
  },

  // window api() with a bounded lifetime. A timed-out request reads as one
  // plain sentence and keeps its TimeoutError name for callers that branch.
  async api(path, opts = {}) {
    if (typeof api === 'undefined') throw new Error('This preview has no server.');
    const p = String(path).startsWith('/recruit') ? path : '/recruit' + path;
    try {
      return await api(p, { ...opts, signal: opts.signal || AbortSignal.timeout(RECRUIT_TIMEOUT_MS) });
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw Object.assign(new Error('The request timed out. Try again.'), { name: 'TimeoutError', status: 0 });
      }
      throw e;
    }
  },
};

const RECRUIT_SECTION_KEYS = ['interest', 'coffee', 'application'];
// One row of a section, as a noun: what the dialog is showing.
const RECRUIT_SECTION_NOUNS = { interest: 'Interest form', coffee: 'Coffee chat', application: 'Application' };
const recruitSectionNoun = (key) => RECRUIT_SECTION_NOUNS[key] || 'Application';
const RECRUIT_SECTION_LABELS = { interest: 'Interest form', coffee: 'Coffee chats', application: 'Applications' };
// The section a cycle URL points at; the interest form when it names none.
function recruitSection() { const sub = UI.route?.params?.sub; return RECRUIT_SECTION_KEYS.includes(sub) ? sub : 'interest'; }

const RECRUIT_TIMEOUT_MS = 20000;
const RECRUIT_SYNC_MS = 30000;
const RECRUIT_ROLES = ['admin', 'lead', 'reviewer', 'interviewer'];

/* ------------------------------- state ----------------------------------- */

function recruitState() {
  return UI.recruit ||= {
    me: undefined, cycles: undefined, cycleId: null, cycle: undefined, panel: null,
    apps: undefined, filters: {}, selected: new Set(), selectionScope: null,
    drafts: {}, busy: new Set(), detail: {}, queue: undefined, mod: {}, key: 0, _syncTimer: null,
  };
}

const recruitCycleRow = () => recruitState().cycle?.data || null;
const recruitRole = () => recruitState().cycle?.role || null;
const recruitMyRoles = () => recruitState().cycle?.roles || [];
const recruitIsAdmin = () => Boolean(recruitState().me?.admin);

function recruitRoleOf(roles) {
  const list = Array.isArray(roles) ? roles : [];
  return RECRUIT_ROLES.find((r) => list.includes(r)) || null;
}

// Mirrors permissions.js allowed(access, role) on the client, for UX only.
function recruitCan(access, roles = recruitMyRoles()) {
  const has = (r) => roles.includes(r);
  if (access === 'member') return true;
  if (access === 'role') return roles.length > 0;
  if (access === 'admin') return has('admin');
  if (access === 'lead') return has('admin') || has('lead');
  if (access === 'reviewer') return has('admin') || has('lead') || has('reviewer');
  if (access === 'interviewer') return has('admin') || has('lead') || has('interviewer');
  return false;
}

function recruitEnabled(m, cycle) {
  if (!m || m.kernel) return true;
  if (['cycles', 'applications', 'roles'].includes(m.name)) return true;
  const map = cycle?.doc?.modules;
  return !map || map[m.name] !== false;
}

function recruitAdoptCycles(out) {
  const st = recruitState();
  const list = Array.isArray(out?.cycles) ? out.cycles : [];
  st.cycles = { list, intakeCycleId: out?.intakeCycleId || null, migration: out?.migration || null, settingsVersion: out?.settingsVersion ?? out?.version ?? null };
  if (st.cycle?.data) {
    const mine = list.find((c) => c.id === st.cycle.data.id);
    if (mine?.counts) st.cycle.counts = mine.counts;
  }
}

// Late responses after a cycle switch or Refresh compare this key.
const recruitKey = () => recruitState().key;

function recruitId(prefix) {
  const rnd = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return prefix + '-' + rnd;
}

function recruitError(e) {
  if (!e) return 'Something went wrong';
  if (e.name === 'TimeoutError') return 'The request timed out. Try again.';
  return e.message || 'Something went wrong';
}

// 8/28/26 — the same short form the interest list uses.
function recruitDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
}

const recruitPlural = (n, one, many = one + 's') => `${Number(n || 0).toLocaleString('en-US')} ${n === 1 ? one : many}`;

const recruitSubteams = (cycle) => (Array.isArray(cycle?.doc?.subteams) ? cycle.doc.subteams : []);
const RECRUIT_YEARS = ['Freshman', 'Sophomore', 'Junior', 'Senior', 'Grad'];

function recruitPanelHref(cycleId, panel, params) {
  const qs = params ? Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : '';
  return `#/applications/${encodeURIComponent(cycleId)}${panel ? '/' + panel : ''}${qs ? '?' + qs : ''}`;
}

function recruitActivePanel() {
  const st = recruitState();
  const cycle = st.cycle?.data;
  if (!cycle) return null;
  const panels = RECRUIT.panels(cycle, st.cycle.role);
  const sub = UI.route?.params?.sub;
  return panels.find((p) => p.id === sub) || panels[0] || null;
}

// Region repaint that keeps the reader's focus (the caret's element is found
// again by its data attributes after the HTML is replaced).
function recruitRepaint(node, html) {
  if (!node) return false;
  const focus = focusReference(document.activeElement);
  const had = node.contains(document.activeElement);
  node.innerHTML = html;
  if (had) resolveFocus(focus, node)?.focus({ preventScroll: true });
  return true;
}

// Default dropdown menu from data-opts (the same as main.js's dd case), plus
// the admin-dirty mark on settings forms and the module's pick callback.
function recruitDefaultMenu(host, fn) {
  let options = [];
  try { options = JSON.parse(host.dataset.opts || '[]'); } catch { options = []; }
  return options.map((o) => ({
    selected: o.value === host.dataset.value,
    icon: o.value === host.dataset.value ? I.check : '<span style="width:14px;flex:none"></span>',
    label: o.label,
    run: () => {
      host.dataset.value = o.value;
      const label = host.querySelector?.('.dd__label');
      if (label) label.textContent = o.label;
      const form = host.closest?.('form');
      if (form) form.dataset.adminDirty = 'true';
      fn?.(host, o.value);
    },
  }));
}

/* ------------------------------- queue ----------------------------------- */

// Saved submissions still waiting to join a list (admin). One fetch per
// visit; Sync queue forces a replay.
function recruitLoadQueue(force = false) {
  const st = recruitState();
  if (!st.me?.admin) return;
  if (st.queue?.loading) return;
  st.queue = { loading: true };
  const key = st.key;
  RECRUIT.api(`/recruit/queue${force ? '?force=1' : ''}`)
    .then((out) => {
      if (st.key !== key) return;
      st.queue = { pending: Array.isArray(out.pending) ? out.pending : [], queueUnavailable: Boolean(out.queueUnavailable) };
      if (!recruitPaintQueue()) renderBackground('recruit');
    })
    .catch((e) => { if (st.key !== key) return; st.queue = { error: recruitError(e) }; if (!recruitPaintQueue()) renderBackground('recruit'); });
}

function recruitPaintQueue() {
  const host = $('[data-rc="queue"]');
  if (!host || typeof recruitQueueHtml !== 'function') return false;
  return recruitRepaint(host, recruitQueueHtml());
}

/* ------------------------------- sync loop ------------------------------- */

async function recruitSyncTick() {
  const st = recruitState();
  st._syncTimer = null;
  if (typeof REMOTE === 'undefined' || UI.route?.name !== 'recruit' || document.hidden) return;
  const quiet = !UI.editor && !UI.modal && !UI.menu && !UI.palette && !(REMOTE.pending > 0);
  if (quiet && st.cycles?.list) {
    const key = st.key;
    try {
      const out = await RECRUIT.api('/recruit/cycles?all=1');
      if (st.key === key && UI.route?.name === 'recruit') { recruitAdoptCycles(out); recruitPaintCounts(); }
    } catch { /* the next tick tries again */ }
    const panel = recruitActivePanel();
    const m = panel?.module;
    if (m?.refresh?.load && st.cycle?.data && st.key === key && Date.now() - (m._refreshedAt || 0) >= (m.refresh.every || RECRUIT_SYNC_MS)) {
      try {
        const data = await m.refresh.load(st.cycle.data, st.cycle.role);
        m._refreshedAt = Date.now();
        if (st.key === key && UI.route?.name === 'recruit' && !UI.modal && !UI.menu && !UI.editor) m.refresh.paint?.(data, st.cycle.data, st.cycle.role);
      } catch { /* best effort */ }
    }
  }
  RECRUIT.sync();
}

function recruitCountsLine(cycle = recruitCycleRow(), counts = recruitState().cycle?.counts) {
  if (!cycle) return '';
  const st = recruitState();
  const parts = [recruitStatusText(cycle, st.cycles?.intakeCycleId)];
  if (cycle.status === 'open' && cycle.closesAt) parts.push('closes ' + new Date(Number(cycle.closesAt)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  const by = counts?.bySection || {};
  parts.push(`${Number(by.interest || 0).toLocaleString('en-US')} interest`, recruitPlural(by.coffee || 0, 'coffee chat'), recruitPlural(by.application || 0, 'application'));
  return parts.filter(Boolean).join(' · ');
}

function recruitStatusText(cycle, intakeCycleId) {
  if (!cycle) return '';
  if (cycle.status === 'open') return intakeCycleId && cycle.id === intakeCycleId ? 'Open · receives the website form' : 'Open';
  if (cycle.status === 'draft') return 'Draft';
  if (cycle.status === 'closed') return 'Closed';
  if (cycle.status === 'archived') return 'Archived';
  return cycle.status || '';
}

// Counts repaint in place: every [data-rc-count] node (the index rows, the
// section tab's Responses count).
function recruitPaintCounts() {
  const st = recruitState();
  const cycle = st.cycle?.data;
  if (!cycle) return;
  const counts = st.cycle.counts || { total: 0, bySection: {} };
  for (const el of $$('[data-rc="counts"]')) el.textContent = recruitCountsLine(cycle, counts);
  for (const el of $$('[data-rc-count]')) {
    const k = el.dataset.rcCount;
    el.textContent = k === 'all' ? Number(counts.total || 0).toLocaleString('en-US') : Number(counts.bySection?.[k] || 0).toLocaleString('en-US');
  }
}

/* ------------------------------- shell ----------------------------------- */

const RC_ICONS = {
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 22V3m0 1c5-4 11 4 16 0v12c-5 4-11-4-16 0"/></svg>',
  comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 2V11.5A8.5 8.5 0 0 1 9.5 3h3a8.5 8.5 0 0 1 8.5 8.5Z"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5"/><path d="M21 21H3"/></svg>',
};

function recruitShellHtml(crumbHtml, inner, right) {
  return topbar(crumbHtml, right) + `<div class="content"><div class="page-wrap page-wrap--wide"><div class="page-col page-col--wide">${inner}</div></div></div>`;
}

const RECRUIT_CRUMBS_INDEX = `<a href="#/home">Wiki</a><span class="crumbs__sep">/</span><span class="crumbs__here">Applications</span>`;

function viewRecruit() {
  if (typeof REMOTE === 'undefined') {
    return recruitShellHtml(RECRUIT_CRUMBS_INDEX, `<div class="empty">${I.mail}<b>Live on the deployed wiki</b>
      <p>This preview has no server. The real wiki manages applications here, by recruiting cycle.</p></div>`);
  }
  const st = recruitState();
  const me = st.me;
  const head = `<div class="plain-head"><h1>Applications</h1></div>`;
  if (!me || me.loading) return recruitShellHtml(RECRUIT_CRUMBS_INDEX, head + '<p class="sheet__note">Loading…</p>');
  if (me.error) return recruitShellHtml(RECRUIT_CRUMBS_INDEX, head + `<p class="sheet__note">Could not load: ${MD.esc(me.error)}. <button class="linklike" data-action="recruit-refresh">Retry</button></p>`);
  if (!me.admin && !me.cycles?.length) {
    return recruitShellHtml(RECRUIT_CRUMBS_INDEX, `<div class="empty">${I.mail}<b>Only admins and cycle reviewers can read applications</b>
      <p>Applications carry personal info, so they stay with team leads and the people they assign.</p>
      <a class="btn" href="#/home" style="text-decoration:none">Back to the wiki</a></div>`);
  }
  const id = UI.route?.params?.id;
  if (!id) return recruitShellHtml(RECRUIT_CRUMBS_INDEX, typeof recruitIndexHtml === 'function' ? recruitIndexHtml() : head);
  return recruitCycleShellHtml(id);
}

// Open a dialog over the route as it stands. The page behind the veil is not
// rebuilt, so nothing behind it moves or fades; render() is the fallback
// where the shell helpers are missing (tests, previews).
function recruitShowModal(m) {
  UI.modal = m;
  const inPlace = typeof viewModal === 'function' && typeof mountModalFocus === 'function' && Boolean($('#app .rc-panel'));
  if (!inPlace) { render(); return; }
  if (typeof captureModalFocus === 'function') captureModalFocus();
  document.querySelector('.modal-veil')?.remove();
  document.body.insertAdjacentHTML('beforeend', viewModal());
  mountModalFocus();
}

// The cycle's name is the switch: the big title opens the list of cycles.
// The gear beside it opens the cycle's settings.
function recruitCycleTitleHtml(cycle, options) {
  return `<button type="button" class="rc-cycle-title" data-action="dd" data-m="recruit-cycle-switch" data-value="${MD.esc(cycle.id)}" data-opts="${MD.esc(JSON.stringify(options))}" aria-haspopup="menu" title="Switch cycle"><span class="dd__label">${MD.esc(cycle.name)}</span><svg class="dd__chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>${recruitCan('lead') ? `<button type="button" class="icon-btn rc-cycle-gear" data-action="recruit-settings-open" aria-label="Settings for ${MD.esc(cycle.name)}" title="Settings">${I.settings}</button>` : ''}`;
}
const recruitCycleChoiceLabel = (x) => {
  const name = x.term && x.term !== x.name ? `${x.name} · ${x.term}` : x.name;
  return x.status && x.status !== 'open' ? `${name} · ${x.status}` : name;
};

function recruitCycleShellHtml(id) {
  const st = recruitState();
  const back = `<a href="#/applications?all=1">Applications</a>`;
  const crumbs = (here) => `<a href="#/home">Wiki</a><span class="crumbs__sep">/</span>${back}<span class="crumbs__sep">/</span><span class="crumbs__here">${here}</span>`;
  const c = st.cycle;
  if (!c || c.loading) return recruitShellHtml(crumbs('Loading…'), '<p class="sheet__note">Loading…</p>');
  if (c.error) {
    const gone = c.status === 404;
    return recruitShellHtml(crumbs('Applications'), `<div class="empty">${I.mail}<b>${gone ? 'No such cycle' : 'Could not open this cycle'}</b>
      <p>${gone ? 'It may have been deleted.' : MD.esc(c.error)}</p>
      ${gone ? '<a class="btn" href="#/applications?all=1" style="text-decoration:none">All cycles</a>' : '<button class="btn" data-action="recruit-refresh">Retry</button>'}</div>`);
  }
  const cycle = c.data;
  const role = c.role;
  const panels = RECRUIT.panels(cycle, role);
  const active = recruitActivePanel();
  const tabs = panels.length ? `<nav class="rc-tabs" role="tablist" aria-label="Cycle sections">${panels.map((p) => `<a role="tab" id="rc-tab-${MD.esc(p.id)}" href="${recruitPanelHref(cycle.id, p.id)}" aria-selected="${p.id === active?.id}" ${p.id === active?.id ? 'aria-current="page"' : ''} tabindex="${p.id === active?.id ? 0 : -1}">${MD.esc(p.label)}</a>`).join('')}</nav>` : '';
  const list = st.cycles?.list || [];
  const switchOptions = (list.length ? list : [{ id: cycle.id, name: cycle.name, term: cycle.term, status: cycle.status }])
    .map((x) => ({ value: x.id, label: recruitCycleChoiceLabel(x) }));
  if (!switchOptions.some((o) => o.value === cycle.id)) switchOptions.unshift({ value: cycle.id, label: cycle.name });
  const right = `<button class="icon-btn" data-action="recruit-cycle-tools" aria-label="Cycle options" title="Cycle options" aria-haspopup="menu">${I.dots}</button>`;
  let body = '';
  if (active) {
    let inner = '';
    try { inner = active.module.view ? String(active.module.view(cycle, role, active.id) ?? '') : ''; } catch (e) { console.error(e); inner = `<p class="sheet__note">Could not draw this section: ${MD.esc(e.message || 'error')}</p>`; }
    // The panel fades in when it changes, never on a re-render of the same one.
    const enter = st.paintedPanel !== cycle.id + ':' + active.id;
    st.paintedPanel = cycle.id + ':' + active.id;
    body = `<div class="rc-panel ${enter ? 'rc-panel--enter' : ''}" id="rc-panel-${MD.esc(active.id)}" role="tabpanel" aria-labelledby="rc-tab-${MD.esc(active.id)}">${inner || `<div class="empty">${I.info}<b>Nothing here yet</b></div>`}</div>`;
  } else body = `<div class="empty">${I.info}<b>Nothing to show for your role in this cycle</b></div>`;
  const head = `<div class="plain-head plain-head--cycle"><h1>${recruitCycleTitleHtml(cycle, switchOptions)}</h1></div>`;
  return recruitShellHtml(crumbs(MD.esc(cycle.name)), head + tabs + body, right);
}

// recruit:core:end
