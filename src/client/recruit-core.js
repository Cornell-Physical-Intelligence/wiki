/* ============================================================================
   Applications (code name: recruit) — client core. The module registry, the
   cycle shell (Flow · People · Insights, plus a stage's page and a person's
   page), the per-cycle state, the sync loop, the flow model the client draws
   from, and the helpers every recruit-*.js file shares. Each module file calls
   RECRUIT.register once; scripts/assemble.mjs concatenates them after this
   file and before main.js. Nothing here touches the shared Store; every fact
   lives on UI.recruit.
   ========================================================================== */

'use strict';

// recruit:core:start

/* ------------------------------- registry -------------------------------- */

function validateRecruitModule(m) {
  if (!m || typeof m !== 'object') throw new Error('A recruit module must be an object');
  if (!/^[a-z]+$/.test(String(m.name || ''))) throw new Error('A recruit module needs a lowercase name');
  if (typeof m.order !== 'number' || Number.isNaN(m.order)) throw new Error(`Recruit module "${m.name}" needs an order`);
  if (RECRUIT.modules.some((x) => x.name === m.name)) throw new Error(`Recruit module "${m.name}" is already registered`);
  for (const group of ['actions', 'inputs', 'changes', 'dd', 'modals']) {
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

  // Every view of a cycle. A panel with `tab: false` is a page of its own (a
  // stage, a person) reached from the others, not a tab.
  panels(cycle, role) {
    const out = [];
    for (const m of this.active(cycle)) {
      const list = typeof m.panels === 'function' ? m.panels(cycle, role) : (m.panels || (m.panel ? [m.panel] : []));
      for (const p of list) {
        if (!p || (p.when && !p.when(cycle, role))) continue;
        out.push({ id: p.id, label: p.label, icon: p.icon || '', tab: p.tab !== false, order: p.order ?? m.order, module: m });
      }
    }
    return out.sort((a, b) => a.order - b.order);
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
  // Whether any module holds unsaved work (a stage draft): the sync loop then
  // leaves the cycle alone and leaving the page asks first.
  dirty() { return this.modules.some((m) => { try { return Boolean(m.dirty?.()); } catch { return false; } }); },

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
  change(el, ev) {
    const hit = el?.dataset?.m ? this.find('changes', el.dataset.m) : null;
    if (hit) { hit.fn(el, ev); return true; }
    return this.input(el, ev);
  },
  keydown(ev) {
    // Tabs are a roving tablist: arrows move focus, Enter follows the link.
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key) && typeof ev.target?.matches === 'function' && ev.target.matches('[role="tablist"] [role="tab"]')) {
      const tabs = $$('[role="tab"]', ev.target.closest('[role="tablist"]'));
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
          st.cycle = recruitCycleState(out, st.me);
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

  // 30 s loop while the route is open and the tab visible. Counts repaint in
  // place; the open view refreshes through its module's refresh hook.
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
    st.queue = undefined;
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

const RECRUIT_TIMEOUT_MS = 20000;
const RECRUIT_SYNC_MS = 30000;
const RECRUIT_ROLES = ['admin', 'lead', 'reviewer', 'interviewer'];

/* ------------------------------- state ----------------------------------- */

function recruitState() {
  return UI.recruit ||= {
    me: undefined, cycles: undefined, cycleId: null, cycle: undefined, panel: null,
    drafts: {}, busy: new Set(), queue: undefined, mod: {}, key: 0, _syncTimer: null,
  };
}

// What GET /recruit/cycles/:id answers, as the client keeps it.
function recruitCycleState(out, me = recruitState().me) {
  const roles = Array.isArray(out.me?.roles) ? out.me.roles : (me?.admin ? ['admin'] : []);
  return {
    data: out.cycle, role: recruitRoleOf(roles), roles, counts: out.counts || { total: 0, bySection: {} },
    sections: out.sections || null, grants: out.roles || [], team: Array.isArray(out.team) ? out.team : [], email: out.me?.email || Store.me?.()?.email || '',
  };
}

const recruitCycleRow = () => recruitState().cycle?.data || null;
const recruitRole = () => recruitState().cycle?.role || null;
const recruitMyRoles = () => recruitState().cycle?.roles || [];
const recruitIsAdmin = () => Boolean(recruitState().me?.admin);
const recruitMyEmail = () => recruitState().cycle?.email || Store.me?.()?.email || '';

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
  return false;
}
// Leads edit the flow and move people; nobody edits an archived cycle.
const recruitCanEdit = (cycle = recruitCycleRow()) => recruitCan('lead') && cycle?.status !== 'archived';
const recruitCanReview = (cycle = recruitCycleRow()) => recruitCan('reviewer') && cycle?.status !== 'archived';

function recruitEnabled(m, cycle) {
  if (!m || m.kernel) return true;
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

function recruitId(prefix) {
  const rnd = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return prefix + '-' + rnd;
}

function recruitError(e) {
  if (!e) return 'Something went wrong';
  if (e.name === 'TimeoutError') return 'The request timed out. Try again.';
  return e.message || 'Something went wrong';
}

// 8/28/26 — the short date used across the sheets.
function recruitDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
}
// "Sep 28" or "Sep 28, 2025" when it is not this year.
function recruitDay(ts) {
  const d = new Date(Number(ts));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}
// "3 days", "5 hours", "just now".
function recruitAgo(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Number(ts)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  const d = Math.round(h / 24); if (d < 45) return `${d} ${d === 1 ? 'day' : 'days'} ago`;
  return recruitDay(ts);
}

const recruitPlural = (n, one, many = one + 's') => `${Number(n || 0).toLocaleString('en-US')} ${n === 1 ? one : many}`;
const recruitNum = (n) => Number(n || 0).toLocaleString('en-US');

const recruitSubteams = (cycle) => (Array.isArray(cycle?.doc?.subteams) ? cycle.doc.subteams : []);

function recruitPanelHref(cycleId, panel, params) {
  const qs = params ? Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : '';
  return `#/applications/${encodeURIComponent(cycleId)}${panel ? '/' + panel : ''}${qs ? '?' + qs : ''}`;
}
const recruitStageHref = (key, tab = '', cycleId = recruitCycleRow()?.id) => recruitPanelHref(cycleId, 'stage', { key, tab });
const recruitPersonHref = (email, cycleId = recruitCycleRow()?.id) => recruitPanelHref(cycleId, 'person', { email });

/* ------------------------------- stages ---------------------------------- */

// A cycle's stages as the server merged them (GET /recruit/cycles/:id).
function recruitSections(cycle = recruitCycleRow()) {
  const st = recruitState();
  return (cycle && st.cycle?.data?.id === cycle.id && st.cycle.sections) || {};
}
const RECRUIT_SECTION_LABELS = { interest: 'Interest form', coffee: 'Coffee chats', application: 'Application form' };
function recruitSectionKeys(cycle = recruitCycleRow()) {
  const merged = recruitSections(cycle);
  if (Object.keys(merged).length) return Object.keys(merged);
  if (Array.isArray(cycle?.sections)) return cycle.sections.map((s) => s.key);
  return Object.keys(RECRUIT_SECTION_LABELS);
}
function recruitSectionTitle(key, cycle = recruitCycleRow()) {
  const merged = recruitSections(cycle)[key];
  const listed = Array.isArray(cycle?.sections) ? cycle.sections.find((s) => s.key === key) : null;
  return merged?.title || listed?.title || RECRUIT_SECTION_LABELS[key] || key;
}

// The flow as the server reads it (lib/recruit/flow.js): a stage with a
// saved `next` leads exactly there, one without leads to the stage after it
// in the cycle's order; columns sit one past the furthest stage leading in;
// stages meet people by column, then by order.
function recruitFlowOf(sections) {
  const keys = Object.keys(sections || {});
  const live = new Set(keys);
  const edges = new Map();
  keys.forEach((key, i) => {
    const s = sections[key];
    const list = Array.isArray(s?.next) ? s.next : i + 1 < keys.length ? [keys[i + 1]] : [];
    edges.set(key, [...new Set(list.map(String))].filter((k) => k !== key && live.has(k)));
  });
  const indegree = new Map(keys.map((k) => [k, 0]));
  for (const to of edges.values()) for (const k of to) indegree.set(k, indegree.get(k) + 1);
  const ranks = new Map(keys.map((k) => [k, 0]));
  const queue = keys.filter((k) => indegree.get(k) === 0);
  const seen = new Set();
  while (queue.length) {
    const k = queue.shift();
    seen.add(k);
    for (const n of edges.get(k)) {
      ranks.set(n, Math.max(ranks.get(n), ranks.get(k) + 1));
      indegree.set(n, indegree.get(n) - 1);
      if (indegree.get(n) === 0) queue.push(n);
    }
  }
  keys.forEach((k, i) => { if (!seen.has(k)) ranks.set(k, Math.max(ranks.get(k), i)); });
  const ordered = keys.map((k, i) => ({ k, i, r: ranks.get(k) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.k);
  const into = new Map(keys.map((k) => [k, []]));
  for (const [from, to] of edges) for (const k of to) into.get(k).push(from);
  return { sections: sections || {}, keys: ordered, order: keys, edges, into, ranks };
}
const recruitFlow = (cycle = recruitCycleRow()) => recruitFlowOf(recruitSections(cycle));

// Whether `to` can already reach `from`: a connection from → to would loop.
function recruitReaches(flow, from, to) {
  const stack = [to], seen = new Set();
  while (stack.length) {
    const k = stack.pop();
    if (k === from) return true;
    if (seen.has(k)) continue;
    seen.add(k);
    stack.push(...(flow.edges.get(k) || []));
  }
  return false;
}

const RECRUIT_STAGE_KINDS = [
  { value: 'form', label: 'Form', note: 'Applicants fill it in on the website' },
  { value: 'meeting', label: 'Meeting', note: 'A coffee chat or an interview' },
  { value: 'review', label: 'Review', note: 'The team scores and decides' },
  { value: 'step', label: 'Step', note: 'Anything else the team tracks' },
];
const recruitKindLabel = (kind) => (RECRUIT_STAGE_KINDS.find((k) => k.value === kind) || RECRUIT_STAGE_KINDS[3]).label;

const RECRUIT_STATUSES = [
  { value: 'active', label: 'Active' }, { value: 'accepted', label: 'Accepted' }, { value: 'waitlisted', label: 'Waitlisted' },
  { value: 'declined', label: 'Declined' }, { value: 'withdrew', label: 'Withdrew' },
];
const recruitStatusLabel = (s) => (RECRUIT_STATUSES.find((x) => x.value === s) || RECRUIT_STATUSES[0]).label;
const recruitStatusPill = (s) => `<span class="rc-status rc-status--${MD.esc(s || 'active')}">${MD.esc(recruitStatusLabel(s))}</span>`;

// Where a person is on each stage, as dots in flow order.
const RECRUIT_STATE_LABELS = { current: 'Here now', done: 'Done', open: 'Not done', skipped: 'Skipped', ahead: 'Not yet' };
function recruitTrackHtml(person, flow = recruitFlow()) {
  const states = person?.states || {};
  return `<span class="rc-track" role="img" aria-label="${MD.esc(flow.keys.map((k) => `${recruitSectionTitle(k)}: ${RECRUIT_STATE_LABELS[states[k]] || 'Not yet'}${states[k] === 'current' && person?.done?.[k] ? ', done' : ''}`).join('; '))}">${flow.keys.map((k) => {
    const state = states[k] || 'ahead';
    return `<span class="rc-track__dot rc-track__dot--${state}${state === 'current' && person?.done?.[k] ? ' is-done' : ''}" title="${MD.esc(recruitSectionTitle(k) + ': ' + (RECRUIT_STATE_LABELS[state] || ''))}"></span>`;
  }).join('')}</span>`;
}

/* ------------------------------- icons ----------------------------------- */

const rcIcon = (inner, sw = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const RC_ICONS = {
  arrowR: rcIcon('<path d="m9 18 6-6-6-6"/>', 1.9),
  arrow: rcIcon('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
  flag: rcIcon('<path d="M4 22V3m0 1c5-4 11 4 16 0v12c-5 4-11-4-16 0"/>'),
  comment: rcIcon('<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 2V11.5A8.5 8.5 0 0 1 9.5 3h3a8.5 8.5 0 0 1 8.5 8.5Z"/>'),
  download: rcIcon('<path d="M12 3v12m-5-5 5 5 5-5"/><path d="M21 21H3"/>', 2),
  form: rcIcon('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
  meeting: rcIcon('<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>'),
  review: rcIcon('<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>'),
  step: rcIcon('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.5"/>'),
  flow: rcIcon('<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>'),
  people: rcIcon('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  insights: rcIcon('<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>'),
  check: rcIcon('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>'),
  rating: rcIcon('<path d="M11.5 2.8a.5.5 0 0 1 1 0l2.3 4.7a2 2 0 0 0 1.5 1.1l5.2.8a.5.5 0 0 1 .3.9l-3.8 3.6a2 2 0 0 0-.6 1.8l.9 5.2a.5.5 0 0 1-.8.6l-4.6-2.5a2 2 0 0 0-1.9 0L4.4 21a.5.5 0 0 1-.8-.6l.9-5.2a2 2 0 0 0-.6-1.8L.1 9.8a.5.5 0 0 1 .3-.9l5.2-.8A2 2 0 0 0 7 7Z"/>'),
  choice: rcIcon('<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>'),
  text: rcIcon('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>'),
  note: rcIcon('<path d="M15 12H3"/><path d="M17 18H3"/><path d="M21 6H3"/>'),
  number: rcIcon('<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>'),
  date: rcIcon('<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>'),
  member: rcIcon('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  board: rcIcon('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 7v7"/><path d="M12 7v4"/><path d="M16 7v9"/>'),
  table: rcIcon('<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>'),
  external: rcIcon('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  globe: rcIcon('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>'),
  eye: rcIcon('<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>'),
  back: rcIcon('<path d="m15 18-6-6 6-6"/>', 1.9),
  sort: rcIcon('<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="m21 8-4-4-4 4"/><path d="M17 4v16"/>'),
  filter: rcIcon('<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>'),
  grip: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
};
const recruitKindIcon = (kind) => RC_ICONS[kind] || RC_ICONS.step;

/* ------------------------------- shell helpers --------------------------- */

function recruitActivePanel() {
  const st = recruitState();
  const cycle = st.cycle?.data;
  if (!cycle) return null;
  const panels = RECRUIT.panels(cycle, st.cycle.role);
  const sub = UI.route?.params?.sub;
  const hit = panels.find((p) => p.id === sub);
  if (hit) return hit;
  // Addresses from before the flow chart named a form's tab: #/…/coffee and
  // #/…/form:people open that stage's page.
  const legacy = sub === 'form:people' ? 'people' : sub;
  if (legacy && recruitSections(cycle)[legacy]) return panels.find((p) => p.id === 'stage') || null;
  return panels.find((p) => p.tab) || panels[0] || null;
}

// The stage a stage page shows: ?key=, or the legacy form tab it replaced.
function recruitStageKey() {
  const p = UI.route?.params || {};
  const sections = recruitSections();
  if (p.key && sections[p.key]) return p.key;
  const legacy = p.sub === 'form:people' ? 'people' : p.sub;
  if (legacy && sections[legacy]) return legacy;
  return null;
}

// Segmented controls carry a thumb that slides to the current item. On a
// fresh paint the thumb starts on the item it came from (data-seg-from, an
// index) and glides over; with nothing to come from it just sits.
function recruitSegSlide(nav) {
  if (!nav || typeof nav.getBoundingClientRect !== 'function') return;
  const items = [...nav.querySelectorAll('a, button')].filter((el) => el.parentElement === nav);
  const thumb = nav.querySelector('.rc-seg__thumb');
  const to = items.findIndex((el) => el.getAttribute('aria-current') === 'page' || el.getAttribute('aria-pressed') === 'true');
  if (!thumb || !thumb.style || to < 0 || typeof items[to].getBoundingClientRect !== 'function') return;
  const box = nav.getBoundingClientRect();
  const raw = nav.offsetWidth > 0 && box.width > 0 ? box.width / nav.offsetWidth : 1;
  const scale = Math.abs(raw - 1) < 0.01 ? 1 : raw;
  const place = (el, animate) => {
    const r = el.getBoundingClientRect();
    thumb.style.transition = animate ? '' : 'none';
    thumb.style.transform = `translate(${(r.left - box.left) / scale - (nav.clientLeft || 0)}px, ${(r.top - box.top) / scale - (nav.clientTop || 0)}px)`;
    thumb.style.width = `${r.width / scale}px`;
    thumb.style.height = `${r.height / scale}px`;
  };
  const from = Number(nav.dataset.segFrom);
  if (Number.isInteger(from) && from !== to && items[from] && !recruitReducedMotion()) {
    place(items[from], false);
    void thumb.offsetWidth;
    place(items[to], true);
  } else place(items[to], false);
  nav.classList.add('is-live');
  delete nav.dataset.segFrom;
}
const recruitReducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

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
// A menu item with the selected-state mark the app's menus use.
const recruitMenuItem = (label, selected, run, extra = {}) => ({ label, selected, icon: selected ? I.check : '<span style="width:14px;flex:none"></span>', run, ...extra });

async function recruitCopy(text, done = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(done); }
  catch { UI.modal = { kind: 'recruit-copy', text }; render(); const t = $('.modal textarea'); t?.focus(); t?.select(); }
}

/* ------------------------------- saving the flow ------------------------- */

// Every stage edit is one PUT of the cycle's site settings, version-matched.
// Saves run one after another so each carries the version the last returned.
function recruitPutSite(settings) {
  const st = recruitState();
  const run = async () => {
    const cycle = recruitCycleRow();
    if (!cycle) throw new Error('Open a cycle first.');
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/settings/site`, { method: 'PUT', body: JSON.stringify({ version: cycle.version, settings }) });
    recruitAdoptCycle(out.cycle, out.sections);
    return out;
  };
  const next = (st.saving || Promise.resolve()).catch(() => {}).then(run);
  st.saving = next;
  return next;
}

function recruitAdoptCycle(row, sections) {
  const st = recruitState();
  if (row && st.cycle?.data?.id === row.id) {
    st.cycle.data = row;
    if (sections) st.cycle.sections = sections;
  }
  if (st.cycles?.list && row) st.cycles.list = st.cycles.list.map((c) => (c.id === row.id ? { ...c, name: row.name, status: row.status, version: row.version, closesAt: row.closesAt } : c));
}

function recruitVersionToast(e, cycleId) {
  if (e?.status === 409 && /changed/i.test(e.message || '')) toast(recruitError(e), { label: 'Reload', run: () => { const st = recruitState(); st.cycles = undefined; RECRUIT.reset(cycleId); render(); } });
  else toast(recruitError(e));
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
    if (st.cycle?.data && !RECRUIT.dirty() && !st.busy.size) {
      try {
        const latest = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(st.cycle.data.id)}`);
        if (st.key === key && !RECRUIT.dirty()) {
          const changed = st.cycle.data.version !== latest.cycle?.version;
          st.cycle = { ...recruitCycleState(latest, st.me), counts: latest.counts || st.cycle.counts };
          if (changed) { for (const m of RECRUIT.modules) { try { m.cycleChanged?.(); } catch (e) { console.error(e); } } renderBackground('recruit'); }
        }
      } catch { /* keep the last readable state */ }
    }
    const panel = recruitActivePanel();
    const m = panel?.module;
    if (m?.refresh?.load && st.cycle?.data && st.key === key && Date.now() - (m._refreshedAt || 0) >= (m.refresh.every || RECRUIT_SYNC_MS)) {
      try {
        await m.refresh.load(st.cycle.data, st.cycle.role, panel.id);
        m._refreshedAt = Date.now();
      } catch { /* best effort */ }
    }
  }
  RECRUIT.sync();
}

function recruitStatusText(cycle, intakeCycleId) {
  if (!cycle) return '';
  if (cycle.status === 'open') return intakeCycleId && cycle.id === intakeCycleId ? "Open · receives the website's forms" : 'Open';
  if (cycle.status === 'draft') return 'Draft';
  if (cycle.status === 'closed') return 'Closed';
  if (cycle.status === 'archived') return 'Archived';
  return cycle.status || '';
}

// Counts repaint in place: every [data-rc-count] node.
function recruitPaintCounts() {
  const st = recruitState();
  const cycle = st.cycle?.data;
  if (!cycle) return;
  const counts = st.cycle.counts || { total: 0, bySection: {} };
  for (const el of $$('[data-rc-count]')) {
    const k = el.dataset.rcCount;
    el.textContent = k === 'all' ? recruitNum(counts.total) : recruitNum(counts.bySection?.[k]);
  }
}

/* ------------------------------- shell ----------------------------------- */

function recruitShellHtml(crumbHtml, inner, right, wide = false) {
  return topbar(crumbHtml, right) + `<div class="content"><div class="page-wrap page-wrap--wide ${wide ? 'rc-wrap--full' : ''}"><div class="page-col page-col--wide ${wide ? 'rc-col--full' : ''}">${inner}</div></div></div>`;
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
    return recruitShellHtml(RECRUIT_CRUMBS_INDEX, `<div class="empty">${I.mail}<b>No access</b>
      <p>Applications carry personal info, so they stay with admins, team leads and the reviewers they assign.</p>
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

// Status, deadline and whether the website sends its forms here, in a line.
function recruitCycleMetaHtml(cycle) {
  const st = recruitState();
  const receiving = st.cycles?.intakeCycleId === cycle.id && cycle.status === 'open';
  const parts = [
    `<span class="rc-cycle-state rc-cycle-state--${MD.esc(cycle.status)}"><span class="rc-cycle-state__dot"></span>${MD.esc(cycle.status.charAt(0).toUpperCase() + cycle.status.slice(1))}</span>`,
    receiving ? `<span>${RC_ICONS.globe}Receives the website's forms</span>` : '',
    cycle.closesAt ? `<span>Deadline ${MD.esc(recruitDay(cycle.closesAt))}</span>` : '',
  ].filter(Boolean);
  return `<div class="rc-cycle-meta">${parts.join('')}</div>`;
}

function recruitCycleShellHtml(id) {
  const st = recruitState();
  const back = `<a href="#/applications?all=1">Applications</a>`;
  const crumbs = (here) => `<a href="#/home">Wiki</a><span class="crumbs__sep">/</span>${back}<span class="crumbs__sep">/</span>${here}`;
  const c = st.cycle;
  if (!c || c.loading) return recruitShellHtml(crumbs('<span class="crumbs__here">Loading…</span>'), '<p class="sheet__note">Loading…</p>');
  if (c.error) {
    const gone = c.status === 404;
    return recruitShellHtml(crumbs('<span class="crumbs__here">Applications</span>'), `<div class="empty">${I.mail}<b>${gone ? 'No such cycle' : 'Could not open this cycle'}</b>
      <p>${gone ? 'It may have been deleted.' : MD.esc(c.error)}</p>
      ${gone ? '<a class="btn" href="#/applications?all=1" style="text-decoration:none">All cycles</a>' : '<button class="btn" data-action="recruit-refresh">Retry</button>'}</div>`);
  }
  const cycle = c.data;
  const role = c.role;
  const panels = RECRUIT.panels(cycle, role);
  const active = recruitActivePanel();
  const tabs = panels.filter((p) => p.tab);
  const list = st.cycles?.list || [];
  const switchOptions = (list.length ? list : [{ id: cycle.id, name: cycle.name, term: cycle.term, status: cycle.status }]).map((x) => ({ value: x.id, label: recruitCycleChoiceLabel(x) }));
  if (!switchOptions.some((o) => o.value === cycle.id)) switchOptions.unshift({ value: cycle.id, label: cycle.name });
  const right = `<button class="icon-btn" data-action="recruit-cycle-tools" aria-label="Cycle options" title="Cycle options" aria-haspopup="menu">${I.dots}</button>`;
  let body = '';
  if (active) {
    let inner = '';
    try { inner = active.module.view ? String(active.module.view(cycle, role, active.id) ?? '') : ''; } catch (e) { console.error(e); inner = `<p class="sheet__note">Could not draw this view: ${MD.esc(e.message || 'error')}</p>`; }
    // The view fades in when it changes, never on a re-render of the same one.
    const where = cycle.id + ':' + active.id + ':' + (UI.route?.params?.key || '') + ':' + (UI.route?.params?.email || '');
    const enter = st.paintedPanel !== where;
    st.paintedPanel = where;
    body = `<div class="rc-panel ${enter ? 'rc-panel--enter' : ''}" id="rc-panel-${MD.esc(active.id)}" ${active.tab ? `role="tabpanel" aria-labelledby="rc-tab-${MD.esc(active.id)}"` : ''}>${inner || `<div class="empty">${I.info}<b>Nothing here yet</b></div>`}</div>`;
  } else body = `<div class="empty">${I.info}<b>Nothing to show</b><p>Your role in this cycle has no view here.</p></div>`;
  // A stage's or a person's page names itself in the crumbs; the tabs mark
  // the view it belongs to.
  const home = active?.tab ? active : panels.find((p) => p.id === (active?.id === 'person' ? 'people' : 'flow')) || tabs[0];
  const nav = tabs.length ? `<nav class="rc-tabs" role="tablist" aria-label="Cycle views">${tabs.map((p) => {
    const on = p.id === home?.id;
    return `<a role="tab" id="rc-tab-${MD.esc(p.id)}" href="${recruitPanelHref(cycle.id, p.id)}" aria-selected="${on}" ${on && active?.tab ? 'aria-current="page"' : ''} tabindex="${on ? 0 : -1}">${p.icon}<span>${MD.esc(p.label)}</span></a>`;
  }).join('')}</nav>` : '';
  const here = active && !active.tab && typeof active.module.crumb === 'function' ? active.module.crumb(cycle, active.id) : '';
  const crumbHtml = here
    ? crumbs(`<a href="${recruitPanelHref(cycle.id, '')}">${MD.esc(cycle.name)}</a><span class="crumbs__sep">/</span><span class="crumbs__here">${here}</span>`)
    : crumbs(`<span class="crumbs__here">${MD.esc(cycle.name)}</span>`);
  const head = `<header class="rc-cycle-head"><div class="plain-head plain-head--cycle"><h1>${recruitCycleTitleHtml(cycle, switchOptions)}</h1></div>${recruitCycleMetaHtml(cycle)}${nav}</header>`;
  return recruitShellHtml(crumbHtml, head + body, right, Boolean(active?.module.wide?.(active.id)));
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', (ev) => {
    try { if (RECRUIT.dirty()) { ev.preventDefault(); ev.returnValue = ''; } } catch { /* nothing to guard */ }
  });
}

// recruit:core:end
