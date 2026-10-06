/* ============================================================================
   Applications — stage module (client). A stage's page, opened from its card
   on the flow chart: People (everyone who reached it, with its checklist
   ticked right in the list), Form (the questions applicants answer on the
   website, drawn as they will see them, and how the website treats them),
   Checklist (what the team records for each person here) and Settings (its
   name, kind and where it leads). Form, Checklist and Settings edit one
   draft of the stage; nothing changes until Save.
   ========================================================================== */

'use strict';

// recruit:stage:start

const RECRUIT_QUESTION_TYPES = [
  { value: 'short', label: 'Short text' }, { value: 'long', label: 'Long text' }, { value: 'longfile', label: 'Long text + file' }, { value: 'email', label: 'Email' },
  { value: 'single', label: 'Choose one' }, { value: 'multi', label: 'Choose many' }, { value: 'checkbox', label: 'Checkbox' },
  { value: 'link', label: 'Link' }, { value: 'file', label: 'File' },
];
const RECRUIT_FILE_ACCEPT = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'];
// What the note under a question does on the website, by type.
const RECRUIT_HELP_HINT = {
  short: 'Short answer', long: 'Long answer', longfile: 'Long answer', email: 'netid@cornell.edu', link: 'https://',
  checkbox: 'Text next to the box', single: 'Note under the question (optional)', multi: 'Note under the question (optional)', file: 'Note under the question (optional)',
};
const RECRUIT_FIELD_TYPES = [
  { value: 'check', label: 'Checkbox', icon: 'check' }, { value: 'rating', label: 'Rating', icon: 'rating' }, { value: 'choice', label: 'Choice', icon: 'choice' },
  { value: 'text', label: 'Short text', icon: 'text' }, { value: 'note', label: 'Note', icon: 'note' }, { value: 'number', label: 'Number', icon: 'number' },
  { value: 'date', label: 'Date', icon: 'date' }, { value: 'member', label: 'Team member', icon: 'member' },
];
const RECRUIT_EACH_TYPES = ['rating', 'choice', 'text', 'note', 'number'];
const recruitFieldTypeLabel = (type) => (RECRUIT_FIELD_TYPES.find((t) => t.value === type) || RECRUIT_FIELD_TYPES[0]).label;
const recruitFieldIcon = (type) => RC_ICONS[(RECRUIT_FIELD_TYPES.find((t) => t.value === type) || RECRUIT_FIELD_TYPES[0]).icon];
const recruitQuestionKey = (label) => { const k = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40); return /^[a-z]/.test(k) ? k : 'q_' + k; };
const recruitTypeLabel = (type) => (RECRUIT_QUESTION_TYPES.find((t) => t.value === type) || RECRUIT_QUESTION_TYPES[0]).label;
const recruitIsChoice = (type) => type === 'single' || type === 'multi';
const recruitIsText = (type) => type === 'short' || type === 'long' || type === 'longfile' || type === 'email' || type === 'link';
const recruitTakesFile = (type) => type === 'file' || type === 'longfile';

const RECRUIT_SITE_URL = 'https://cornellphysicalintelligence.com';
const RECRUIT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RECRUIT_NOTIFY_MAX = 10;
const RECRUIT_STAGE_TABS = [
  { id: 'people', label: 'People', lead: false },
  { id: 'form', label: 'Form', lead: false },
  { id: 'checklist', label: 'Checklist', lead: false },
  { id: 'settings', label: 'Settings', lead: true },
];

// A custom dropdown (the app's own menu) with extra data attributes.
const recruitDd = (m, options, value, attrs = '', opts = {}) => dd(m, options, value, opts).replace(`data-m="${m}"`, `data-m="${m}" ${attrs}`);
// The forms marked for /apply (one key before several could be marked).
const recruitApplyKeys = (cycle) => { const v = cycle?.doc?.site?.landing; return [...new Set((Array.isArray(v) ? v : v ? [v] : []).map(String))]; };
const RECRUIT_APPLY_QUESTION = 'What are you applying for?';

/* ------------------------------- the draft ------------------------------- */

let recruitItemSeq = 0;
// Cards keep an identity across repaints so a move can be animated.
const recruitItemId = () => `i${++recruitItemSeq}`;

function recruitStageModel(sec, key, cycle) {
  const fixed = new Set(Array.isArray(sec?.required) && sec.required.length ? sec.required : ['name', 'email']);
  const questions = sec?.form ? (sec.form.questions || []).map((q) => {
    const out = { _id: recruitItemId(), key: q.key || '', type: RECRUIT_QUESTION_TYPES.some((t) => t.value === q.type) ? q.type : 'short', label: q.label || '', help: q.help || '', required: q.required === true, fixed: fixed.has(q.key) };
    if (Array.isArray(q.options)) out.options = q.options.map(String);
    if (q.max) out.max = Number(q.max);
    if (Array.isArray(q.accept)) out.accept = [...q.accept];
    if (q.maxBytes) out.maxBytes = Number(q.maxBytes);
    return out;
  }) : null;
  const fields = (sec?.fields || []).map((f) => ({ _id: recruitItemId(), key: f.key, type: f.type, label: f.label || '', help: f.help || '', ...(Array.isArray(f.options) ? { options: [...f.options] } : {}), ...(f.type === 'rating' ? { max: Number(f.max) || 5 } : {}), each: f.each === true, saved: true }));
  const flow = recruitFlow(cycle);
  return {
    title: sec?.title || key, kind: sec?.kind || 'form', description: sec?.description || '', thanks: sec?.thanks || '',
    submitLabel: sec?.submitLabel || 'Send', successLabel: sec?.successLabel || 'Sent', open: sec?.open === true, atApply: recruitApplyKeys(cycle).includes(key), choiceLabel: sec?.choiceLabel || '', question: cycle?.doc?.site?.question || '',
    notify: sec?.notify !== false, notifyTo: Array.isArray(sec?.notifyTo) ? sec.notifyTo.map(String) : [], capacity: Number(sec?.capacity) > 0 ? Number(sec.capacity) : 0,
    form: questions ? { questions } : null, fields, done: sec?.done || null, next: [...(flow.edges.get(key) || [])],
  };
}

// One draft per cycle and stage. A clean draft follows the cycle (a save
// elsewhere, a connection made on the chart); an edited one waits for Save.
function recruitStageDraft(cycle, key) {
  const st = recruitState();
  st.stageDrafts ||= {};
  const id = `${cycle.id}:${key}`;
  const have = st.stageDrafts[id];
  if (have && (recruitStageDirty(have) || have.saving)) {
    if (!have.saving) recruitRebaseNext(have, cycle, key);
    return have;
  }
  const sec = recruitSections(cycle)[key];
  const model = recruitStageModel(sec, key, cycle);
  const fresh = JSON.stringify(model);
  if (have && JSON.stringify(recruitStageComparable(JSON.parse(have.saved))) === JSON.stringify(recruitStageComparable(model))) return have;
  st.stageDrafts[id] = { id, key, cycleId: cycle.id, model, saved: fresh, saving: false, error: '', savedAt: have?.savedAt || 0, preview: have?.preview || false };
  return st.stageDrafts[id];
}
// Connections changed elsewhere (the chart, a split) land under the draft's
// own ticks and unticks; the split's stages stay connected.
function recruitRebaseNext(d, cycle, key) {
  const saved = JSON.parse(d.saved);
  const flow = recruitFlow(cycle);
  const now = [...(flow.edges.get(key) || [])];
  if (JSON.stringify(saved.next) === JSON.stringify(now)) return;
  const routed = recruitSplitTargets(flow.splits.get(key) || null);
  const added = d.model.next.filter((k) => !saved.next.includes(k) && flow.sections[k]);
  const dropped = new Set(saved.next.filter((k) => !d.model.next.includes(k) && !routed.has(k)));
  d.model.next = [...now.filter((k) => !dropped.has(k)), ...added.filter((k) => !now.includes(k))];
  d.saved = JSON.stringify({ ...saved, next: now });
}
// Card identities differ between two drafts of the same stage; the rest is the stage.
const recruitStageComparable = (m) => JSON.parse(JSON.stringify(m, (k, v) => (k === '_id' ? undefined : v)));
const recruitStageDirty = (d) => Boolean(d) && JSON.stringify(recruitStageComparable(d.model)) !== JSON.stringify(recruitStageComparable(JSON.parse(d.saved)));

function recruitStageCtx(el) {
  const cycle = recruitCycleRow();
  const key = el?.closest?.('[data-stage]')?.dataset.stage || recruitStageKey();
  if (!cycle || !key || !recruitSections(cycle)[key]) return null;
  const d = recruitStageDraft(cycle, key);
  const i = Number(el?.dataset?.i), j = Number(el?.dataset?.j);
  return { cycle, key, d, m: d.model, i, j, q: d.model.form?.questions?.[i], f: d.model.fields[i], host: $('[data-rc="stage"]') };
}

/* ------------------------------- the panel ------------------------------- */

const recruitStageTab = () => { const t = UI.route?.params?.tab; return RECRUIT_STAGE_TABS.some((x) => x.id === t) ? t : UI.route?.params?.edit === '1' ? 'form' : 'people'; };

// A stage opens in a panel over the flow chart. The chart stays behind it,
// the stage's card lit and slid clear of the panel where there is room.
function recruitStageView(cycle) {
  return recruitFlowView(cycle) + recruitStageDrawerHtml(cycle, recruitStageKey());
}

const recruitStageCloseHtml = () => `<button type="button" class="icon-btn sd-close" data-action="recruit-stage-close" aria-label="Close" title="Close (Esc)">${I.x}</button>`;

function recruitStageDrawerHtml(cycle, key) {
  const st = recruitState();
  // The panel slides in when it opens, not each time it is drawn again.
  const enter = st.mod.drawer ? '' : 'is-entering';
  const veil = `<div class="sd-veil ${enter}" data-action="recruit-stage-close" aria-hidden="true"></div>`;
  const s = key ? recruitSections(cycle)[key] : null;
  if (!s) return `${veil}<aside class="sd ${enter}" role="dialog" aria-label="Stage" data-rc="stage" tabindex="-1"><div class="sd-head"><div class="sd-head__bar"><span></span><span class="sd-head__tools">${recruitStageCloseHtml()}</span></div></div><div class="sd-body"><div class="sd-empty"><b>No such stage</b><p>It may have been removed.</p></div></div></aside>`;
  const lead = recruitCanEdit(cycle);
  const active = recruitStageActiveTab(cycle);
  const nav = `<nav class="sd-tabs" role="tablist" aria-label="${MD.esc(s.title)}">${recruitStageTabsHtml(cycle, key)}</nav>`;
  let body = '';
  if (active === 'people') body = recruitStagePeopleHtml(cycle, key);
  else if (active === 'form') body = recruitStageFormHtml(cycle, key);
  else if (active === 'checklist') body = recruitStageChecklistHtml(cycle, key);
  else body = recruitStageSettingsHtml(cycle, key);
  const d = lead && active !== 'people' ? recruitStageDraft(cycle, key) : null;
  return `${veil}<aside class="sd ${enter}" role="dialog" aria-labelledby="sd-title" data-rc="stage" data-stage="${MD.esc(key)}" tabindex="-1">
    <header class="sd-head" data-rc="stage-head">${recruitStageHeadHtml(cycle, key)}</header>
    ${nav}
    <div class="sd-body" data-rc="stage-tab" data-tab="${active}">${body}</div>
    ${d ? `<div class="rs-save" data-rc="stage-save" ${recruitStageDirty(d) || d.saving || d.error ? '' : 'hidden'}>${recruitStageSaveHtml(d)}</div>` : ''}
  </aside>`;
}

// The tab showing: the one asked for, where this reader may see it.
function recruitStageActiveTab(cycle) {
  const tab = recruitStageTab();
  return RECRUIT_STAGE_TABS.some((t) => t.id === tab && (!t.lead || recruitCanEdit(cycle))) ? tab : 'people';
}

function recruitStageTabsHtml(cycle, key) {
  const s = recruitSections(cycle)[key];
  const active = recruitStageActiveTab(cycle);
  const count = (id) => (id === 'checklist' && s.fields.length ? `<span class="count">${s.fields.length}</span>` : id === 'form' && s.form ? `<span class="count">${s.form.questions.length}</span>` : '');
  return RECRUIT_STAGE_TABS.filter((t) => !t.lead || recruitCanEdit(cycle)).map((t) => `<a role="tab" href="${recruitStageHref(key, t.id === 'people' ? '' : t.id)}" aria-selected="${t.id === active}" ${t.id === active ? 'aria-current="page"' : ''} tabindex="${t.id === active ? 0 : -1}">${t.label}${count(t.id)}</a>`).join('');
}

// The panel's head: the stage's kind, whether its form is on the website,
// its name and numbers, and the stages before and after it.
function recruitStageHeadHtml(cycle, key) {
  const flow = recruitFlow(cycle);
  const s = flow.sections[key];
  const stats = recruitFlowStats(key);
  const lead = recruitCanEdit(cycle);
  const busy = recruitState().busy.has('open:' + key);
  const tab = recruitStageTab();
  const at = flow.keys.indexOf(key);
  const keep = tab === 'people' || (tab === 'settings' && !lead) ? '' : tab;
  const step = (k, label, icon) => (k
    ? `<a class="icon-btn" href="${recruitStageHref(k, keep)}" aria-label="${label}: ${MD.esc(flow.sections[k].title)}" title="${label}: ${MD.esc(flow.sections[k].title)}">${icon}</a>`
    : `<span class="icon-btn is-off" aria-hidden="true">${icon}</span>`);
  const web = !s.form ? ''
    : lead ? `<label class="fe-switch sd-web"><input type="checkbox" data-action="recruit-stage-open" data-stage="${MD.esc(key)}" ${s.open ? 'checked' : ''} ${busy ? 'disabled' : ''}><span class="fe-switch__track"></span><span class="fe-switch__text">On the website</span></label>`
    : `<span class="sd-web ${s.open ? 'is-open' : ''}">${s.open ? 'Open on the website' : 'Closed on the website'}</span>`;
  const doneLabel = (s.fields.find((f) => f.key === s.done)?.label || 'done').toLowerCase();
  const nums = stats ? [
    [stats.here, 'here now'], [stats.reached, 'reached'],
    ...(s.done ? [[stats.done, doneLabel]] : s.form ? [[stats.responses, Number(stats.responses) === 1 ? 'response' : 'responses']] : []),
  ] : [];
  const waiting = !stats && !recruitState().insights?.error;
  return `<div class="sd-head__bar">${recruitKindTagHtml(s.kind)}${web}<span class="sd-head__tools">${step(flow.keys[at - 1], 'Previous stage', RC_ICONS.back)}${step(flow.keys[at + 1], 'Next stage', RC_ICONS.arrowR)}${recruitStageCloseHtml()}</span></div>
    <h2 class="sd-title" id="sd-title">${MD.esc(s.title)}</h2>
    <p class="sd-nums">${nums.map(([n, label]) => `<span><b>${recruitNum(Number(n) || 0)}</b> ${MD.esc(label)}</span>`).join('')}${waiting ? '<span>Loading counts…</span>' : ''}</p>`;
}

function recruitStageSaveHtml(d) {
  const dirty = recruitStageDirty(d);
  const status = d.saving ? 'Saving…' : dirty ? 'Unsaved changes' : d.savedAt ? 'Saved' : '';
  return `<div class="rs-save__inner">${d.error ? `<span class="rs-save__error" role="alert">${MD.esc(d.error)}</span>` : `<span class="rs-save__status" role="status">${status}</span>`}
    <button type="button" class="btn" data-action="recruit-stage-discard" ${dirty && !d.saving ? '' : 'disabled'}>Discard</button>
    <button type="button" class="btn btn--primary" data-action="recruit-stage-save" ${dirty && !d.saving ? '' : 'disabled'}>Save</button></div>`;
}

// Only a changed bar is drawn again: leaving a field fires its change as the
// pointer goes down on Save, and a redrawn button would lose that click.
function recruitPaintStageSave(c) {
  const bar = $('[data-rc="stage-save"]');
  if (!bar || !c?.d) return;
  const html = recruitStageSaveHtml(c.d);
  if (bar.rcHtml !== html) { recruitRepaint(bar, html); bar.rcHtml = html; }
  bar.hidden = !(recruitStageDirty(c.d) || c.d.saving || c.d.error);
}

// The tab's own region, with cards gliding to their new places.
function recruitPaintStageTab(c, { list = null } = {}) {
  if (!c) return;
  const tab = $('[data-rc="stage-tab"]');
  if (!tab) return;
  if (list) {
    const listEl = $(`[data-sortable="${list}"]`, tab);
    const before = recruitCardTops(listEl);
    const html = list === 'questions' ? recruitQuestionCardsHtml(c.d) : recruitFieldCardsHtml(c.d);
    recruitRepaint(listEl, html);
    recruitFlip(listEl, before);
  } else {
    const t = tab.dataset.tab;
    const html = t === 'form' ? recruitStageFormHtml(c.cycle, c.key) : t === 'checklist' ? recruitStageChecklistHtml(c.cycle, c.key) : t === 'settings' ? recruitStageSettingsHtml(c.cycle, c.key) : '';
    recruitRepaint(tab, html);
  }
  recruitPaintStageSave(c);
}

// With a stage open, the chart slides so the stage's card sits clear of the
// panel, where there is room beside it; closed, it slides back.
function recruitStageFocusChart({ animate = false } = {}) {
  const canvas = $('[data-rc="flow-sizer"]');
  if (!canvas?.style) return;
  const key = recruitOpenStage();
  const panel = key ? $('.sd') : null;
  const card = panel ? $$('.fc-node[data-key]', canvas).find((el) => el.dataset.key === key) : null;
  const zone = canvas.closest?.('[data-rc="flow"]');
  const now = Number(canvas.dataset.pan || 0);
  let pan = 0;
  if (card && [card, panel, zone].every((el) => typeof el?.getBoundingClientRect === 'function')) {
    // Where the panel comes to rest, not where its slide has got to.
    const edge = (Number(window.innerWidth) || 0) - (Number(panel.offsetWidth) || 0);
    const box = card.getBoundingClientRect(), area = zone.getBoundingClientRect();
    const left = box.left + now;   // where the card sits unmoved
    const room = edge - area.left;
    if (room >= box.width + 64 && left + box.width > edge - 24) pan = Math.max(0, Math.round(left + box.width / 2 - (area.left + room / 2)));
  }
  if (pan === now) return;
  canvas.dataset.pan = String(pan);
  const set = () => { canvas.style.transform = pan ? `translateX(${-pan}px)` : ''; };
  if (animate && !recruitReducedMotion() && typeof requestAnimationFrame === 'function') { requestAnimationFrame(() => requestAnimationFrame(set)); return; }
  canvas.classList.add('is-still');
  set();
  void canvas.offsetWidth;
  canvas.classList.remove('is-still');
}

// Closing slides the panel away and the chart back, then shows the flow.
// Unsaved changes stay in the stage's draft until they are saved or dropped.
function recruitStageClose() {
  const cycle = recruitCycleRow();
  if (!cycle || UI.route?.params?.sub !== 'stage') return;
  const st = recruitState();
  const key = recruitStageKey();
  const d = key ? st.stageDrafts?.[`${cycle.id}:${key}`] : null;
  if (d && recruitStageDirty(d)) toast(`Unsaved changes to ${recruitSectionTitle(key)} are kept for when you reopen it`);
  st.mod.returnFocus = key;
  const go = () => nav(recruitPanelHref(cycle.id, 'flow'));
  const panel = $('.sd');
  if (!panel?.classList || recruitReducedMotion()) { go(); return; }
  panel.classList.add('is-leaving');
  $('.sd-veil')?.classList.add('is-leaving');
  $('[data-rc="flow-canvas"]')?.classList?.remove('is-focus');
  const sizer = $('[data-rc="flow-sizer"]');
  if (sizer?.style) { sizer.style.transform = ''; sizer.dataset.pan = '0'; }
  setTimeout(go, 170);
}

/* ------------------------------- people here ----------------------------- */

const RECRUIT_STAGE_FILTERS = [
  { id: 'reached', label: 'Everyone who reached it' }, { id: 'here', label: 'Here now' }, { id: 'done', label: 'Done' }, { id: 'notdone', label: 'Not done' }, { id: 'next', label: 'Up next' },
];

let recruitStageSearchTimer = null;

function recruitStagePeopleState(cycle, key) {
  const st = recruitState();
  const id = `${st.key}:${cycle.id}:${key}`;
  if (st.stagePeople?.id !== id) st.stagePeople = { id, key, filter: st.stagePeople?.key === key ? st.stagePeople.filter : 'reached', q: '', rows: [], next: null, total: 0, loading: false, error: null, loaded: false, selected: new Set() };
  return st.stagePeople;
}

function recruitStagePeopleParams(sp) {
  const p = new URLSearchParams();
  if (sp.filter === 'here' || sp.filter === 'next') { p.set(sp.filter === 'here' ? 'stage' : 'next', sp.key); p.set('status', 'active'); }
  else p.set(sp.filter === 'done' ? 'done' : sp.filter === 'notdone' ? 'notdone' : 'reached', sp.key);
  if (sp.q.trim()) p.set('q', sp.q.trim());
  p.set('sort', 'name');
  p.set('limit', '200');
  return p;
}

async function recruitLoadStagePeople(more = false) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const sp = st.stagePeople;
  if (!cycle || !sp || (more && !sp.next)) return;
  const params = recruitStagePeopleParams(sp);
  if (more) params.set('cursor', sp.next);
  sp.loading = true; sp.error = null;
  const seq = sp.seq = (sp.seq || 0) + 1;
  if (!more) recruitPaintStagePeople();
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/people?${params}`);
    if (st.stagePeople !== sp || seq !== sp.seq) return;
    const rows = Array.isArray(out.rows) ? out.rows : [];
    sp.rows = more ? sp.rows.concat(rows) : rows;
    sp.next = out.next || null;
    sp.total = Number(out.total ?? sp.rows.length);
    sp.loaded = true;
  } catch (e) {
    if (st.stagePeople !== sp || seq !== sp.seq) return;
    sp.error = recruitError(e);
  }
  sp.loading = false;
  recruitPaintStagePeople();
}

// Who is here, with the stage's checklist right in the list.
function recruitStagePeopleHtml(cycle, key) {
  const sp = recruitStagePeopleState(cycle, key);
  const s = recruitSections(cycle)[key];
  return `<div class="sd-people">
    <div class="sd-bar" data-rc="stage-bar">${recruitStageBarHtml(cycle, key, sp)}</div>
    <div class="sd-scroll"><table class="sd-table" aria-label="People at ${MD.esc(s.title)}">
      <thead data-rc="stage-people-head">${recruitStagePeopleHeadHtml(cycle, key, sp)}</thead>
      <tbody data-rc="stage-people-rows">${recruitStagePeopleRowsHtml(cycle, key, sp)}</tbody>
    </table></div>
    <div class="sd-foot" role="status" data-rc="stage-people-foot">${recruitStagePeopleFootHtml(sp)}</div>
  </div>`;
}

// Which people and a search; with people selected, what to do with them.
function recruitStageBarHtml(cycle, key, sp) {
  if (sp.selected.size) return recruitStageBulkHtml(sp);
  return `${recruitStageShowHtml(cycle, key, sp)}<label class="sd-search">${I.search}<input class="text-input" data-m="recruit-stage-q" type="search" placeholder="Search" value="${MD.esc(sp.q)}" aria-label="Search by name or email" autocomplete="off" spellcheck="false"></label>`;
}

// The list to show, with how many each holds.
function recruitStageShowHtml(cycle, key, sp) {
  const s = recruitSections(cycle)[key];
  const stats = recruitFlowStats(key);
  const counts = stats ? { reached: stats.reached, here: stats.here, done: stats.done, notdone: stats.notDone, next: stats.upNext } : {};
  // Up next: people whose path comes here once they finish where they are.
  const into = (recruitFlow(cycle).into.get(key) || []).length > 0;
  const filters = RECRUIT_STAGE_FILTERS.filter((f) => (f.id === 'next' ? into : (f.id !== 'done' && f.id !== 'notdone') || s.done || s.form));
  const options = filters.map((f) => ({ value: f.id, label: counts[f.id] !== undefined ? `${f.label} · ${recruitNum(counts[f.id])}` : f.label }));
  return recruitDd('recruit-stage-filter', options, filters.some((f) => f.id === sp.filter) ? sp.filter : 'reached', 'aria-label="Show" data-rc="stage-show"');
}

const recruitStageSelectable = () => recruitCanEdit();

function recruitStagePeopleHeadHtml(cycle, key, sp) {
  const s = recruitSections(cycle)[key];
  const th = (id, label, extra = '') => `<th data-col="${MD.esc(id)}" ${extra}>${MD.esc(label)}</th>`;
  const visible = sp.rows.length, picked = sp.rows.filter((r) => sp.selected.has(r.email)).length;
  return `<tr>
    ${recruitStageSelectable() ? `<th class="sd-check" data-col="check"><label class="sheet__check"><input type="checkbox" data-action="recruit-stage-select-all" aria-label="Select everyone listed" ${visible && picked === visible ? 'checked' : ''} ${visible ? '' : 'disabled'}></label></th>` : ''}
    ${th('person', 'Person')}
    ${s.fields.map((f) => th('f-' + f.key, f.label + (f.each ? ' · each' : ''), `class="rs-fieldcol rs-fieldcol--${f.type}"`)).join('')}
  </tr>`;
}

function recruitStagePeopleRowsHtml(cycle, key, sp) {
  const s = recruitSections(cycle)[key];
  const span = 2 + s.fields.length;
  const row = (text) => `<tr class="sd-empty-row"><td colspan="${span}">${text}</td></tr>`;
  if (!sp.loaded && (sp.loading || !sp.error)) return row('Loading…');
  if (sp.error && !sp.rows.length) return row(`Could not load: ${MD.esc(sp.error)}. <button class="linklike" data-action="recruit-stage-people-retry">Retry</button>`);
  if (!sp.rows.length) return row(sp.q.trim() ? 'No one matches.' : sp.filter === 'here' ? 'No one is here now.' : sp.filter === 'next' ? 'No one is on their way here.' : sp.filter === 'done' ? 'No one yet.' : sp.filter === 'notdone' ? 'Everyone here is done.' : 'No one has reached this stage yet.');
  return sp.rows.map((r) => recruitStagePersonRowHtml(cycle, key, r, sp)).join('');
}

// A person: name and email, then only what differs from the usual (another
// status, somewhere else now, a flag, comments), then the checklist.
function recruitStagePersonRowHtml(cycle, key, r, sp) {
  const s = recruitSections(cycle)[key];
  const picked = sp.selected.has(r.email);
  const meta = [
    r.status && r.status !== 'active' ? `<span class="sd-status sd-status--${MD.esc(r.status)}">${MD.esc(recruitStatusLabel(r.status))}</span>` : '',
    r.stage !== key ? `<span>Now at ${MD.esc(r.stage ? recruitSectionTitle(r.stage) : '—')}</span>` : '',
    r.flagged ? `<span class="sd-mark" title="Flagged">${RC_ICONS.flag}</span>` : '',
    r.comments ? `<span class="sd-mark" title="${MD.esc(recruitPlural(r.comments, 'comment'))}">${RC_ICONS.comment}${recruitNum(r.comments)}</span>` : '',
  ].filter(Boolean).join('');
  return `<tr data-email="${MD.esc(r.email)}" class="${picked ? 'is-selected' : ''}">
    ${recruitStageSelectable() ? `<td class="sd-check" data-col="check"><label class="sheet__check"><input type="checkbox" data-action="recruit-stage-select" data-email="${MD.esc(r.email)}" aria-label="Select ${MD.esc(r.name)}" ${picked ? 'checked' : ''}></label></td>` : ''}
    <td data-col="person"><a class="rc-person-link" href="${recruitPersonHref(r.email)}" data-action="recruit-person-go" data-email="${MD.esc(r.email)}" data-list="stage"><b>${MD.esc(r.name)}</b><span class="mail">${MD.esc(r.email)}</span></a>${meta ? `<span class="sd-meta">${meta}</span>` : ''}</td>
    ${s.fields.map((f) => `<td data-col="f-${MD.esc(f.key)}" class="rs-fieldcell" data-label="${MD.esc(f.label)}">${recruitFieldCellHtml(f, r.fields?.[key]?.[f.key], { email: r.email, stage: key, name: r.name })}</td>`).join('')}
  </tr>`;
}

function recruitStagePeopleFootHtml(sp) {
  if (sp.loading && sp.loaded) return 'Loading…';
  if (!sp.loaded) return '';
  const more = sp.next ? ' · <button class="linklike" data-action="recruit-stage-people-more">Load more</button>' : '';
  return `${MD.esc(sp.rows.length === sp.total ? recruitPlural(sp.total, 'person', 'people') : `${recruitNum(sp.rows.length)} of ${recruitPlural(sp.total, 'person', 'people')}`)}${more}`;
}

function recruitStageBulkHtml(sp) {
  const n = sp.selected.size;
  if (!n) return '';
  return `<span class="rc-bulk__count" role="status">${recruitNum(n)} selected</span>
    <button class="btn btn--sm" data-action="recruit-bulk-move" data-list="stage" aria-haspopup="menu">Move to…</button>
    <button class="btn btn--sm" data-action="recruit-bulk-status" data-list="stage" aria-haspopup="menu">Set status…</button>
    <button class="btn btn--sm" data-action="recruit-bulk-copy" data-list="stage">${I.copy} Copy emails</button>
    <button class="icon-btn" data-action="recruit-stage-clear" aria-label="Clear selection" title="Clear selection">${I.x}</button>`;
}

function recruitPaintStageBar() {
  const cycle = recruitCycleRow();
  const sp = recruitState().stagePeople;
  const bar = $('[data-rc="stage-bar"]');
  if (cycle && sp && bar) recruitRepaint(bar, recruitStageBarHtml(cycle, sp.key, sp));
}

function recruitPaintStagePeople() {
  const cycle = recruitCycleRow();
  const sp = recruitState().stagePeople;
  const body = $('[data-rc="stage-people-rows"]');
  if (!cycle || !sp || !body) return false;
  recruitRepaint(body, recruitStagePeopleRowsHtml(cycle, sp.key, sp));
  const head = $('[data-rc="stage-people-head"]');
  if (head) recruitRepaint(head, recruitStagePeopleHeadHtml(cycle, sp.key, sp));
  const foot = $('[data-rc="stage-people-foot"]');
  if (foot) foot.innerHTML = recruitStagePeopleFootHtml(sp);
  // The bar changes only between the filters and the selection's actions.
  const bar = $('[data-rc="stage-bar"]');
  if (bar && Boolean($('[data-action="recruit-stage-clear"]', bar)) !== sp.selected.size > 0) recruitPaintStageBar();
  return true;
}

// One person's row repaints when their checklist or place changes.
function recruitPaintStagePerson(email) {
  const cycle = recruitCycleRow();
  const sp = recruitState().stagePeople;
  if (!cycle || !sp) return;
  const r = sp.rows.find((x) => x.email === email);
  const tr = $$('[data-rc="stage-people-rows"] tr[data-email]').find((el) => el.dataset.email === email);
  if (!r || !tr) return;
  const holder = document.createElement('tbody');
  holder.innerHTML = recruitStagePersonRowHtml(cycle, sp.key, r, sp);
  const fresh = holder.firstElementChild || holder.children?.[0];
  if (!fresh) return;
  // Only cells whose content changed are replaced, so a control in use keeps focus.
  for (const cell of $$('td[data-col]', fresh)) {
    const old = $(`td[data-col="${cell.dataset.col}"]`, tr);
    if (old && old.innerHTML !== cell.innerHTML && !old.contains(document.activeElement)) old.innerHTML = cell.innerHTML;
  }
}

/* ------------------------------- the form -------------------------------- */

function recruitStageFormHtml(cycle, key) {
  const lead = recruitCanEdit(cycle);
  if (!lead) {
    const s = recruitSections(cycle)[key];
    if (!s.form) return `<div class="sd-empty"><b>No form</b><p>People reach this stage when the team moves them here.</p></div>`;
    return recruitFormPreviewHtml(recruitStageModel(s, key, cycle), true);
  }
  const d = recruitStageDraft(cycle, key);
  const m = d.model;
  if (!m.form) {
    return `<div class="sd-empty"><b>No form</b><p>People reach this stage when the team moves them here. A form gives it a page on the website that anyone can fill in.</p><button class="btn" data-action="recruit-sf-add-form">${I.plus} Add a form</button></div>`;
  }
  if (d.preview) return `<div class="sd-toolbar"><span class="sd-toolbar__note">Preview</span><button class="btn btn--sm" type="button" data-action="recruit-sf-preview">${I.edit} Edit</button></div>${recruitFormPreviewHtml(m)}`;
  return `<div class="sd-form">
    <div class="sd-toolbar"><span></span><button class="btn btn--sm" type="button" data-action="recruit-sf-preview">${RC_ICONS.eye} Preview</button></div>
    <div class="sf-paper">
      <input class="sf-paper__title" data-m="recruit-sf-title" value="${MD.esc(m.title)}" placeholder="Form title" maxlength="80" aria-label="Form title" autocomplete="off" spellcheck="false">
      <textarea class="sf-paper__desc" data-m="recruit-sf-desc" rows="2" placeholder="A line or two shown above the questions" maxlength="600" aria-label="Description">${MD.esc(m.description)}</textarea>
    </div>
    <ol class="fe__list" data-sortable="questions">${recruitQuestionCardsHtml(d)}</ol>
    <div class="fe__add"><button type="button" class="btn" data-action="recruit-sf-add">${I.plus} Add question</button></div>
  </div>`;
}

// How the website treats the form (opening and closing it is in the panel's
// head): its address, whether /apply shows it (and, beside other forms there,
// how applicants choose it), its button and closing words, who hears about a
// response, a cap, and taking it away.
function recruitStageWebHtml(d) {
  const m = d.model;
  const sections = recruitSections();
  const others = recruitApplyKeys(recruitCycleRow()).filter((k) => k !== d.key && sections[k]?.form).map((k) => `${sections[k].title}${sections[k].open ? '' : ' (closed)'}`);
  const together = m.atApply && others.length;
  const applyHelp = together
    ? `Where the QR code and the Apply link land. Shown there with ${others.length > 1 ? `${others.slice(0, -1).join(', ')} and ${others.at(-1)}` : others[0]}; applicants choose one first.`
    : 'Where the QR code and the Apply link land. Show more than one form there and applicants choose one first.';
  const url = `${RECRUIT_SITE_URL}/apply/${encodeURIComponent(d.key)}/`;
  const sw = (action, on, text, help = '') => `<label class="fe-switch fe-switch--row"><input type="checkbox" data-action="${action}" ${on ? 'checked' : ''}><span class="fe-switch__track"></span><span class="fe-switch__text">${text}${help ? `<small>${help}</small>` : ''}</span></label>`;
  const responses = Number(recruitFlowStats(d.key)?.responses ?? recruitState().cycle?.counts?.bySection?.[d.key] ?? 0);
  return `<div class="ss-link"><a href="${MD.esc(url)}" target="_blank" rel="noopener">${MD.esc(url.replace(RECRUIT_SITE_URL, '').replace(/\/$/, ''))}</a><button type="button" class="icon-btn" data-action="recruit-copy-link" data-link="${MD.esc(url)}" aria-label="Copy the link to this form" title="Copy link">${I.copy}</button></div>
    ${sw('recruit-sf-landing', m.atApply, 'Shown at /apply', MD.esc(applyHelp))}
    ${together ? `<div class="ss-pair">
      <label class="fe__field"><span class="fe__field-label">Listed at /apply as</span><input class="text-input" data-m="recruit-sf-choice-label" value="${MD.esc(m.choiceLabel)}" placeholder="${MD.esc(m.title)}" maxlength="40"></label>
      <label class="fe__field"><span class="fe__field-label">Question above the choices</span><input class="text-input" data-m="recruit-sf-question" value="${MD.esc(m.question)}" placeholder="${MD.esc(RECRUIT_APPLY_QUESTION)}" maxlength="120"></label>
    </div>` : ''}
    <div class="ss-pair">
      <label class="fe__field"><span class="fe__field-label">Submit button</span><input class="text-input" data-m="recruit-sf-submit-label" value="${MD.esc(m.submitLabel)}" maxlength="80"></label>
      <label class="fe__field"><span class="fe__field-label">Heading after sending</span><input class="text-input" data-m="recruit-sf-success-label" value="${MD.esc(m.successLabel)}" maxlength="80"></label>
    </div>
    <label class="fe__field"><span class="fe__field-label">Message after sending</span><textarea class="text-input" data-m="recruit-sf-thanks" rows="2" maxlength="300" placeholder="Thanks. We read every one of these.">${MD.esc(m.thanks || '')}</textarea></label>
    ${recruitFormNotifyHtml(d)}
    <label class="fe-options__cap"><span class="fe-switch__text">Stop accepting after</span><input class="text-input fe-options__n" data-m="recruit-sf-capacity" value="${m.capacity ? MD.esc(String(m.capacity)) : ''}" inputmode="numeric" maxlength="6" placeholder="no limit" aria-label="Stop accepting after this many responses"><span class="fe-switch__text">responses</span></label>
    <div class="fe-options__remove"><span class="fe-switch__text">Take the form off this stage${responses ? `<small>${MD.esc(recruitPlural(responses, 'response'))} so far. Close it instead; a form with responses stays.</small>` : ''}</span><button type="button" class="btn btn--sm ${responses ? '' : 'btn--danger'}" data-action="recruit-sf-remove-form" ${responses ? 'disabled' : ''}>Remove form</button></div>`;
}

// Who hears about a response: only the addresses the form lists.
function recruitFormNotifyHtml(d) {
  const m = d.model;
  const own = Array.isArray(m.notifyTo) ? m.notifyTo : [];
  const listed = own.some((e) => String(e).trim());
  const small = m.notify && !listed ? 'Nobody is emailed until an address is added.' : '';
  const rows = own.map((e, j) => `<li class="fe-opt"><input class="fe-opt__text" data-m="recruit-sf-recipient" data-j="${j}" value="${MD.esc(e)}" placeholder="name@cornell.edu" inputmode="email" maxlength="120" aria-label="Recipient ${j + 1}" autocomplete="off" spellcheck="false"><button type="button" class="icon-btn" data-action="recruit-sf-recipient-remove" data-j="${j}" aria-label="Remove ${MD.esc(e || 'this address')}">${I.x}</button></li>`).join('');
  const list = m.notify ? `<ul class="fe-opts fe-notify" data-rc="sf-notify">${rows}<li class="fe-opt fe-opt--add"><button type="button" class="linklike" data-action="recruit-sf-recipient-add">${own.length ? 'Add another address' : 'Add an address'}</button></li></ul>` : '';
  return `<label class="fe-switch fe-switch--row"><input type="checkbox" data-action="recruit-sf-notify" ${m.notify ? 'checked' : ''}><span class="fe-switch__track"></span><span class="fe-switch__text">Email the team when someone submits<small data-rc="sf-notify-default" ${small ? '' : 'hidden'}>${small}</small></span></label>${list}`;
}

const recruitQuestionCardsHtml = (d) => (d.model.form?.questions || []).map((q, i, all) => recruitQuestionCardHtml(q, i, all.length)).join('');

function recruitQuestionCardHtml(q, i) {
  const n = i + 1;
  const name = q.label || `question ${n}`;
  const typeControl = q.fixed
    ? `<span class="fe-q__type fe-q__type--fixed">${MD.esc(recruitTypeLabel(q.type))}</span>`
    : recruitDd('recruit-sf-type', RECRUIT_QUESTION_TYPES, q.type, `data-i="${i}" aria-label="Answer type for ${MD.esc(name)}"`, { small: true }).replace('class="dd dd--sm"', 'class="dd dd--sm fe-q__type"');
  return `<li class="fe-q" data-i="${i}" data-qid="${MD.esc(q._id || '')}">
    <div class="fe-q__head">
      <button type="button" class="fe-q__grip rc-grip" data-action="recruit-grip" data-i="${i}" aria-label="Move ${MD.esc(name)}: drag, or press the arrow keys" title="Drag to reorder">${RC_ICONS.grip}</button>
      <input class="fe-q__label" data-m="recruit-sf-label" data-i="${i}" value="${MD.esc(q.label)}" placeholder="Question" maxlength="120" aria-label="Question ${n}" autocomplete="off">
      ${typeControl}
    </div>
    ${recruitIsText(q.type) ? '' : `<input class="fe-q__help" data-m="recruit-sf-help" data-i="${i}" value="${MD.esc(q.help)}" placeholder="${MD.esc(RECRUIT_HELP_HINT[q.type] || '')}" maxlength="300" aria-label="Note for question ${n}" autocomplete="off">`}
    <div class="fe-q__answer" data-rc="fe-answer">${recruitAnswerPreviewHtml(q, i)}</div>
    <div class="fe-q__foot">
      <label class="fe-switch"><input type="checkbox" data-action="recruit-sf-required" data-i="${i}" ${q.required ? 'checked' : ''} ${['name', 'email'].includes(q.key) ? 'disabled' : ''}><span class="fe-switch__track"></span><span class="fe-switch__text">Required</span></label>
      <span class="fe-q__tools">
        ${q.fixed ? '<span class="fe-q__fixed" title="Every form keeps a name and an email">Always asked</span>' : `<button type="button" class="icon-btn" data-action="recruit-sf-duplicate" data-i="${i}" aria-label="Duplicate ${MD.esc(name)}" title="Duplicate">${I.copy}</button><button type="button" class="icon-btn" data-action="recruit-sf-remove" data-i="${i}" aria-label="Remove ${MD.esc(name)}" title="Remove">${I.trash}</button>`}
      </span>
    </div>
  </li>`;
}

// The answer as the applicant will see it. For a typed answer the box is
// the placeholder's own input: what is written here is what they will read.
function recruitAnswerPreviewHtml(q, i) {
  const edit = (cls, hint) => `<input class="fe-ans ${cls} fe-ans--edit" data-m="recruit-sf-help" data-i="${i}" value="${MD.esc(q.help)}" placeholder="${MD.esc(hint)}" maxlength="300" aria-label="Placeholder for question ${i + 1}" autocomplete="off">`;
  switch (q.type) {
    case 'long': return `<textarea class="fe-ans fe-ans--para fe-ans--edit" data-m="recruit-sf-help" data-i="${i}" placeholder="${MD.esc(RECRUIT_HELP_HINT.long)}" maxlength="300" rows="3" aria-label="Placeholder for question ${i + 1}">${MD.esc(q.help)}</textarea>`;
    case 'email': return edit('fe-ans--line', RECRUIT_HELP_HINT.email);
    case 'link': return edit('fe-ans--line', RECRUIT_HELP_HINT.link);
    case 'file': return `<div class="fe-ans fe-ans--file">${I.paperclip}<span>Photo or PDF, up to 2.5 MB</span></div>`;
    case 'longfile': return `<div class="fe-ans-stack"><textarea class="fe-ans fe-ans--para fe-ans--edit" data-m="recruit-sf-help" data-i="${i}" placeholder="${MD.esc(RECRUIT_HELP_HINT.longfile)}" maxlength="300" rows="3" aria-label="Placeholder for question ${i + 1}">${MD.esc(q.help)}</textarea><div class="fe-ans fe-ans--file">${I.paperclip}<span>Attach a photo or PDF, up to 2.5 MB</span></div></div>`;
    case 'checkbox': return `<div class="fe-ans fe-ans--check"><span class="fe-mark"></span><span>${MD.esc(q.help || 'Yes')}</span></div>`;
    case 'single': case 'multi': return recruitOptionsHtml(q, i, 'recruit-sf-option');
    default: return edit('fe-ans--line', RECRUIT_HELP_HINT.short);
  }
}

function recruitOptionsHtml(q, i, m) {
  const mark = q.type === 'single' || q.type === 'choice' ? 'fe-mark fe-mark--radio' : 'fe-mark';
  const options = q.options || [];
  const add = m === 'recruit-sf-option' ? 'recruit-sf-option-add' : 'recruit-ck-option-add';
  const remove = m === 'recruit-sf-option' ? 'recruit-sf-option-remove' : 'recruit-ck-option-remove';
  return `<ul class="fe-opts">${options.map((o, j) => `<li class="fe-opt"><span class="${mark}"></span><input class="fe-opt__text" data-m="${m}" data-i="${i}" data-j="${j}" value="${MD.esc(o)}" placeholder="Option ${j + 1}" maxlength="80" aria-label="Option ${j + 1}" autocomplete="off"><button type="button" class="icon-btn" data-action="${remove}" data-i="${i}" data-j="${j}" aria-label="Remove option ${j + 1}">${I.x}</button></li>`).join('')}
    <li class="fe-opt fe-opt--add"><span class="${mark} fe-mark--ghost"></span><button type="button" class="linklike" data-action="${add}" data-i="${i}">Add option</button></li></ul>`;
}

// The form exactly as applicants meet it, read only.
function recruitFormPreviewHtml(m, published = false) {
  const questions = (m.form?.questions || []).map((q) => {
    const label = `${MD.esc(q.label)}${q.required ? ' <span class="fe-preview__req" aria-label="required">*</span>' : ''}`;
    let field;
    if (recruitIsChoice(q.type)) field = `<ul class="fe-preview__choices">${(q.options || []).map((v) => `<li><span class="fe-mark ${q.type === 'single' ? 'fe-mark--radio' : ''}"></span> ${MD.esc(v)}</li>`).join('')}</ul>`;
    else if (q.type === 'checkbox') field = `<p class="fe-preview__check"><span class="fe-mark"></span> ${MD.esc(q.help || q.label)}</p>`;
    else if (q.type === 'file') field = `<div class="fe-preview__file">${I.paperclip} Attach an image or PDF</div>`;
    else field = `<${['long', 'longfile'].includes(q.type) ? 'textarea rows="3"' : 'input'} class="text-input" disabled aria-label="${MD.esc(q.label)}" placeholder="${MD.esc(q.help || '')}">${['long', 'longfile'].includes(q.type) ? '</textarea>' : ''}${q.type === 'longfile' ? `<div class="fe-preview__file">${I.paperclip} Or attach an image or PDF</div>` : ''}`;
    return `<div class="fe-preview__question"><h3>${label}</h3>${q.help && !['checkbox'].includes(q.type) && !recruitIsText(q.type) ? `<p class="fe-preview__help">${MD.esc(q.help)}</p>` : ''}${field}</div>`;
  }).join('');
  return `<div class="fe-preview ${published ? 'fe-preview--published' : ''}"><h2>${MD.esc(m.title)}</h2>${m.description ? `<p>${MD.esc(m.description)}</p>` : ''}${questions}<button class="btn btn--primary" disabled>${MD.esc(m.submitLabel)}</button></div>`;
}

/* ------------------------------- the checklist --------------------------- */

function recruitStageChecklistHtml(cycle, key) {
  const lead = recruitCanEdit(cycle);
  if (!lead) {
    const s = recruitSections(cycle)[key];
    return s.fields.length
      ? `<div class="ck ck--read"><div class="ck__preview">${recruitChecklistPreviewHtml({ model: recruitStageModel(s, key, cycle) })}</div></div>`
      : `<div class="sd-empty"><b>No checklist</b><p>A lead can add fields the team fills in for each person here.</p></div>`;
  }
  const d = recruitStageDraft(cycle, key);
  return `<div class="ck">
    <ol class="ck__list" data-sortable="fields">${recruitFieldCardsHtml(d)}</ol>
    <div class="ck__add"><button type="button" class="btn" data-action="recruit-ck-add" aria-haspopup="menu">${I.plus} Add field</button></div>
  </div>`;
}

function recruitFieldCardsHtml(d) {
  const fields = d.model.fields;
  if (!fields.length) return `<li class="ck-empty">No fields yet. Add a checkbox for "Chat completed", a rating for interviews, a note for impressions.</li>`;
  return fields.map((f, i) => recruitFieldCardHtml(d, f, i)).join('');
}

function recruitFieldCardHtml(d, f, i) {
  const name = f.label || `field ${i + 1}`;
  const types = RECRUIT_FIELD_TYPES.map((t) => ({ value: t.value, label: t.label }));
  const typeControl = f.saved
    ? `<span class="fe-q__type fe-q__type--fixed" title="Saved fields keep their type; add a new field for a new type">${recruitFieldIcon(f.type)}${MD.esc(recruitFieldTypeLabel(f.type))}</span>`
    : recruitDd('recruit-ck-type', types, f.type, `data-i="${i}" aria-label="Type of ${MD.esc(name)}"`, { small: true }).replace('class="dd dd--sm"', 'class="dd dd--sm fe-q__type"');
  const canEach = RECRUIT_EACH_TYPES.includes(f.type);
  const isDone = (f.key && d.model.done === f.key) || f._markDone === true;
  return `<li class="ck-f" data-i="${i}" data-qid="${MD.esc(f._id)}">
    <div class="ck-f__head">
      <button type="button" class="fe-q__grip rc-grip" data-action="recruit-grip" data-i="${i}" aria-label="Move ${MD.esc(name)}: drag, or press the arrow keys" title="Drag to reorder">${RC_ICONS.grip}</button>
      <span class="ck-f__icon" aria-hidden="true">${recruitFieldIcon(f.type)}</span>
      <input class="fe-q__label" data-m="recruit-ck-label" data-i="${i}" value="${MD.esc(f.label)}" placeholder="Field label" maxlength="80" aria-label="Label of field ${i + 1}" autocomplete="off">
      ${typeControl}
      <button type="button" class="icon-btn" data-action="recruit-ck-remove" data-i="${i}" aria-label="Remove ${MD.esc(name)}" title="Remove">${I.trash}</button>
    </div>
    ${f.type === 'choice' ? `<div class="ck-f__body">${recruitOptionsHtml(f, i, 'recruit-ck-option')}</div>` : ''}
    ${f.type === 'rating' ? `<div class="ck-f__body ck-f__scale"><span>Scale 1 to</span>${recruitDd('recruit-ck-max', [3, 4, 5, 7, 10].map((n) => ({ value: String(n), label: String(n) })), String(f.max || 5), `data-i="${i}" aria-label="Highest rating for ${MD.esc(name)}"`, { small: true })}</div>` : ''}
    <div class="ck-f__foot">
      ${canEach ? `<label class="fe-switch"><input type="checkbox" data-action="recruit-ck-each" data-i="${i}" ${f.each ? 'checked' : ''}><span class="fe-switch__track"></span><span class="fe-switch__text">Each reviewer answers</span></label>` : ''}
      ${f.type === 'check' ? `<label class="fe-switch"><input type="checkbox" data-action="recruit-ck-done" data-i="${i}" ${isDone ? 'checked' : ''}><span class="fe-switch__track"></span><span class="fe-switch__text">Checked means this stage is done</span></label>` : ''}
    </div>
  </li>`;
}

// The checklist as a person's page will show it, with sample controls.
function recruitChecklistPreviewHtml(d) {
  const m = d.model;
  if (!m.fields.length) return '<p class="faint">Fields appear here as you add them.</p>';
  return `<div class="pn-fields pn-fields--sample">${m.fields.map((f) => `<div class="pn-field"><span class="pn-field__label">${recruitFieldIcon(f.type)}${MD.esc(f.label || 'Untitled')}${f.each ? '<span class="pn-field__each">each reviewer</span>' : ''}${(f.key && m.done === f.key) || f._markDone ? '<span class="pn-field__each">marks done</span>' : ''}</span><span class="pn-field__value">${recruitFieldSampleHtml(f)}</span></div>`).join('')}</div>`;
}

function recruitFieldSampleHtml(f) {
  switch (f.type) {
    case 'check': return '<span class="rc-box" aria-hidden="true"></span>';
    case 'rating': return `<span class="rc-stars rc-stars--sample">${Array.from({ length: f.max || 5 }, (_, i) => `<span class="rc-star ${i < 3 ? 'is-on' : ''}">${I.star}</span>`).join('')}</span>`;
    case 'choice': return `<span class="rc-sample-dd">${MD.esc(f.options?.[0] || 'Choose')}${I.chev || ''}</span>`;
    case 'member': return '<span class="rc-sample-dd">Choose someone</span>';
    case 'date': return '<span class="rc-sample-input">YYYY-MM-DD</span>';
    case 'number': return '<span class="rc-sample-input">0</span>';
    case 'note': return '<span class="rc-sample-input rc-sample-input--note">Write a note…</span>';
    default: return '<span class="rc-sample-input">Short answer</span>';
  }
}

const RECRUIT_FIELD_PRESETS = {
  check: { type: 'check', label: '' }, rating: { type: 'rating', label: '', max: 5, each: true }, choice: { type: 'choice', label: '', options: ['', ''], each: true },
  text: { type: 'text', label: '' }, note: { type: 'note', label: '', each: true }, number: { type: 'number', label: '' }, date: { type: 'date', label: '' }, member: { type: 'member', label: '' },
};

/* ------------------------------- settings -------------------------------- */

function recruitStageSettingsHtml(cycle, key) {
  const d = recruitStageDraft(cycle, key);
  const m = d.model;
  const flow = recruitFlow(cycle);
  const others = flow.keys.filter((k) => k !== key);
  const split = flow.splits.get(key) || null;
  const routed = recruitSplitTargets(split);
  // A stage can lead anywhere that does not already lead back to it. Where
  // the split sends people changes in the split.
  const leads = others.map((k) => {
    const when = routed.has(k) ? recruitSplitLabel(split, k) : '';
    const on = m.next.includes(k) || Boolean(when);
    const loops = !on && recruitReaches({ ...flow, edges: new Map([...flow.edges, [key, m.next]]) }, key, k);
    return `<li><label class="rc-check ${loops ? 'is-disabled' : when ? 'is-routed' : ''}"><input type="checkbox" data-action="recruit-ss-next" data-to="${MD.esc(k)}" ${on ? 'checked' : ''} ${loops || when ? 'disabled' : ''}>${recruitKindIcon(flow.sections[k].kind)}<span>${MD.esc(flow.sections[k].title)}</span>${loops ? '<small>comes before this stage</small>' : when ? `<small>${MD.esc(when)}</small>` : ''}</label></li>`;
  }).join('');
  const asked = split ? recruitSplitQuestion(split, flow.sections) : null;
  const splitRow = others.length ? `<div class="ss-split">${split ? `<span>Split by ${MD.esc(asked?.label || split.q)}${split.stage !== key ? ` on ${MD.esc(recruitSectionTitle(split.stage, cycle))}` : ''}</span>` : ''}<button type="button" class="btn btn--sm" data-action="recruit-flow-split" data-key="${MD.esc(key)}">${RC_ICONS.split}${split ? 'Edit split…' : 'Split by an answer…'}</button></div>` : '';
  const from = (flow.into.get(key) || []).map((k) => MD.esc(flow.sections[k].title));
  const group = (title, body, cls = '') => `<section class="ss__group ${cls}"><h3 class="ss__title">${title}</h3>${body}</section>`;
  return `<div class="ss">
    ${group('Name', `<input class="text-input ss__name" data-m="recruit-ss-title" value="${MD.esc(m.title)}" maxlength="80" aria-label="Stage name" autocomplete="off" spellcheck="false">`)}
    ${group('Kind', `<div class="ss-kinds ss-kinds--compact" role="radiogroup" aria-label="Kind">${RECRUIT_STAGE_KINDS.map((k) => `<button type="button" role="radio" class="ss-kind" data-action="recruit-ss-kind" data-kind="${k.value}" aria-checked="${m.kind === k.value}" title="${MD.esc(k.note)}"><span class="ss-kind__icon">${recruitKindIcon(k.value)}</span><b>${k.label}</b></button>`).join('')}</div>`)}
    ${group('On the website', m.form ? recruitStageWebHtml(d) : `<div class="ss-row"><span class="ss-row__text">No form. People reach this stage when the team moves them here.</span><button type="button" class="btn btn--sm" data-action="recruit-sf-add-form">${I.plus} Add a form</button></div>`)}
    ${group('Leads to', `${others.length ? `<ul class="ss-next">${leads}</ul>` : '<p class="faint">Add another stage to connect this one.</p>'}
      ${splitRow}
      <p class="rc-set__note">${from.length ? `Comes after ${from.join(' and ')}.` : 'Nothing leads here; people start at this stage.'} Where nothing is checked, this stage ends the flow.</p>`)}
    ${group('Remove', `<div class="fe-options__remove"><span class="fe-switch__text">Remove ${MD.esc(recruitSectionTitle(key, cycle))}<small>A stage with form responses, people placed there or checklist entries stays until they move.</small></span><button type="button" class="btn btn--sm btn--danger" data-action="recruit-stage-remove">Remove stage…</button></div>`, 'ss__danger')}
  </div>`;
}

/* ------------------------------- saving ---------------------------------- */

// What the server stores for the parts of the stage that changed. Keys for
// new questions and fields come from their labels.
function recruitStagePayload(d) {
  const m = d.model, saved = JSON.parse(d.saved);
  const same = (a, b) => JSON.stringify(recruitStageComparable(a)) === JSON.stringify(recruitStageComparable(b));
  const out = {};
  const title = String(m.title || '').trim();
  if (!title) throw Object.assign(new Error('The stage needs a name.'), { focus: '[data-m="recruit-ss-title"], [data-m="recruit-sf-title"]' });
  if (title !== saved.title) out.title = title;
  for (const k of ['kind', 'submitLabel', 'successLabel']) if (m[k] !== saved[k]) out[k] = m[k];
  if (m.description !== saved.description) out.description = String(m.description || '').trim();
  if (m.thanks !== saved.thanks) out.thanks = String(m.thanks || '').trim().slice(0, 300);
  if (m.choiceLabel !== saved.choiceLabel) out.choiceLabel = String(m.choiceLabel || '').trim().slice(0, 40);
  if (m.open !== saved.open) out.open = m.open === true;
  if (m.capacity !== saved.capacity) {
    if (m.capacity && (!Number.isInteger(m.capacity) || m.capacity < 0 || m.capacity > 100000)) throw Object.assign(new Error('Stop accepting after a whole number of responses, up to 100,000.'), { focus: '[data-m="recruit-sf-capacity"]' });
    out.capacity = m.capacity || 0;
  }
  if (m.notify !== saved.notify) out.notify = m.notify !== false;
  if (!same(m.notifyTo, saved.notifyTo)) {
    const list = [];
    (m.notifyTo || []).forEach((e, j) => {
      const v = String(e || '').trim().toLowerCase();
      if (!v) return;
      if (!RECRUIT_EMAIL.test(v)) throw Object.assign(new Error(`"${v}" is not an email address.`), { focus: `[data-m="recruit-sf-recipient"][data-j="${j}"]` });
      if (!list.includes(v)) list.push(v);
    });
    if (list.length > RECRUIT_NOTIFY_MAX) throw Object.assign(new Error(`Up to ${RECRUIT_NOTIFY_MAX} addresses.`), { focus: '[data-action="recruit-sf-recipient-add"]' });
    out.notifyTo = list;
  }
  if (!same(m.form, saved.form)) out.form = m.form ? { questions: recruitQuestionsPayload(m.form.questions) } : null;
  if (!same(m.fields, saved.fields)) out.fields = recruitFieldsPayload(m.fields);
  if (m.done !== saved.done || out.fields) out.done = out.fields && !out.fields.some((f) => f.key === m.done && f.type === 'check' && !f.each) ? null : m.done || null;
  // The split's stages stay connected whatever the ticks say; the split changes them.
  if (!same(m.next, saved.next)) out.next = [...new Set([...m.next, ...recruitSplitTargets(recruitFlow().splits.get(d.key) || null)])];
  return out;
}

function recruitQuestionsPayload(questions) {
  const used = new Set(questions.map((q) => q.key).filter(Boolean));
  return questions.map((q, i) => {
    const label = String(q.label || '').trim();
    if (!label) throw Object.assign(new Error(`Question ${i + 1} needs a label.`), { focus: `[data-m="recruit-sf-label"][data-i="${i}"]`, tab: 'form' });
    let key = q.key;
    if (!key) {
      const base = recruitQuestionKey(label);
      key = base;
      for (let n = 2; used.has(key); n += 1) key = `${base.slice(0, 37)}_${n}`;
      used.add(key);
    }
    const out = { key, type: q.type, label, help: String(q.help || '').trim(), required: q.required === true };
    if (recruitIsChoice(q.type)) {
      const options = [...new Set((q.options || []).map((o) => String(o).trim()).filter(Boolean))];
      if (!options.length) throw Object.assign(new Error(`"${label}" needs at least one option.`), { focus: `[data-m="recruit-sf-option"][data-i="${i}"], [data-action="recruit-sf-option-add"][data-i="${i}"]`, tab: 'form' });
      out.options = options;
    }
    if (q.max) out.max = q.max;
    if (recruitTakesFile(q.type)) { out.accept = Array.isArray(q.accept) && q.accept.length ? q.accept : RECRUIT_FILE_ACCEPT; out.maxBytes = q.maxBytes || 2621440; }
    return out;
  });
}

function recruitFieldsPayload(fields) {
  const used = new Set(fields.map((f) => f.key).filter(Boolean));
  return fields.map((f, i) => {
    const label = String(f.label || '').trim();
    if (!label) throw Object.assign(new Error(`Field ${i + 1} needs a label.`), { focus: `[data-m="recruit-ck-label"][data-i="${i}"]`, tab: 'checklist' });
    let key = f.key;
    if (!key) {
      const base = recruitQuestionKey(label);
      key = base;
      for (let n = 2; used.has(key); n += 1) key = `${base.slice(0, 37)}_${n}`;
      used.add(key);
      f.key = key;
    }
    const out = { key, type: f.type, label };
    if (f.help) out.help = String(f.help).trim();
    if (f.type === 'choice') {
      const options = [...new Set((f.options || []).map((o) => String(o).trim()).filter(Boolean))];
      if (!options.length) throw Object.assign(new Error(`"${label}" needs at least one choice.`), { focus: `[data-m="recruit-ck-option"][data-i="${i}"], [data-action="recruit-ck-option-add"][data-i="${i}"]`, tab: 'checklist' });
      out.options = options;
    }
    if (f.type === 'rating') out.max = Number(f.max) || 5;
    if (f.each && RECRUIT_EACH_TYPES.includes(f.type)) out.each = true;
    return out;
  });
}

async function recruitSaveStage(el) {
  const c = recruitStageCtx(el);
  if (!c || c.d.saving) return;
  const { d, cycle, key } = c;
  let payload;
  try { payload = recruitStagePayload(d); }
  catch (e) {
    d.error = e.message;
    recruitPaintStageSave(c);
    if (e.tab && recruitStageTab() !== e.tab) nav(recruitStageHref(key, e.tab));
    else if (e.focus) $(e.focus, c.host)?.focus();
    return;
  }
  // A new done checkbox gets its key with the other new fields.
  if (payload.fields && d.model.done === null) {
    const marked = d.model.fields.find((f) => f._markDone);
    if (marked) payload.done = marked.key;
  }
  // /apply's list of forms and its question belong to the cycle: the switch
  // adds or drops this form only, and the question is saved as it reads here.
  const current = recruitApplyKeys(cycle);
  const saved = JSON.parse(d.saved);
  const landing = d.model.atApply !== saved.atApply ? (d.model.atApply ? [...current.filter((k) => k !== key), key] : current.filter((k) => k !== key)) : undefined;
  const question = d.model.question !== saved.question ? String(d.model.question || '').trim().slice(0, 120) : undefined;
  if (!Object.keys(payload).length && landing === undefined && question === undefined) { d.model = JSON.parse(d.saved); recruitPaintStageTab(c); return; }
  d.saving = true; d.error = '';
  recruitPaintStageSave(c);
  try {
    await recruitPutSite({ sections: { [key]: payload }, ...(landing !== undefined ? { landing } : {}), ...(question !== undefined ? { question } : {}) });
    const fresh = recruitStageModel(recruitSections()[key], key, recruitCycleRow());
    d.model = fresh; d.saved = JSON.stringify(fresh); d.savedAt = Date.now();
    toast(`${fresh.title} saved${payload.open === true ? ' · live on the website' : ''}`);
  } catch (e) { d.error = recruitError(e); }
  d.saving = false;
  const host = $('[data-rc="stage"]');
  if (host?.dataset.stage === key) {
    // Repaint from the cycle the save returned, not the one it started from.
    c.host = host;
    c.cycle = recruitCycleRow() || c.cycle;
    recruitPaintStageTab(c);
    const head = $('[data-rc="stage-head"]');
    if (head) recruitRepaint(head, recruitStageHeadHtml(recruitCycleRow(), key));
    // The tabs' counts and the chart's card follow a saved name, form or checklist.
    if (!d.error) {
      const tabs = $('.sd-tabs');
      if (tabs) recruitRepaint(tabs, recruitStageTabsHtml(recruitCycleRow(), key));
      recruitPaintFlow();
    }
  }
}

// Open or close the form from the stage's header: one save, and the draft
// learns the saved state without turning dirty.
async function recruitToggleStageOpen(el) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const key = el.dataset.stage;
  const want = Boolean(el.checked);
  if (!cycle || !recruitCanEdit(cycle) || st.busy.has('open:' + key)) return;
  st.busy.add('open:' + key);
  try {
    await recruitPutSite({ sections: { [key]: { open: want } } });
    const d = st.stageDrafts?.[`${cycle.id}:${key}`];
    if (d) { d.model.open = want; const saved = JSON.parse(d.saved); saved.open = want; d.saved = JSON.stringify(saved); }
    toast(want ? `${recruitSectionTitle(key)} is open on the website` : `${recruitSectionTitle(key)} is closed on the website`);
  } catch (e) { el.checked = !want; toast(`Could not change it: ${recruitError(e)}`); }
  finally {
    st.busy.delete('open:' + key);
    const head = $('[data-rc="stage-head"]');
    if (head) recruitRepaint(head, recruitStageHeadHtml(recruitCycleRow(), key));
    recruitPaintFlow();
  }
}

/* ------------------------------- new stage ------------------------------- */

const RECRUIT_KIND_PRESETS = {
  form: { fields: [], done: null },
  meeting: { fields: [{ key: 'completed', type: 'check', label: 'Completed' }, { key: 'with', type: 'member', label: 'Met with' }, { key: 'notes', type: 'note', label: 'Notes', each: true }], done: 'completed' },
  review: { fields: [{ key: 'score', type: 'rating', label: 'Score', max: 5, each: true }, { key: 'recommend', type: 'choice', label: 'Recommendation', options: ['Strong yes', 'Yes', 'No'], each: true }, { key: 'notes', type: 'note', label: 'Notes', each: true }], done: null },
  step: { fields: [{ key: 'done', type: 'check', label: 'Done' }], done: 'done' },
};

function recruitOpenStageNew(after = null) {
  if (!recruitCanEdit()) return;
  const flow = recruitFlow();
  UI.modal = { kind: 'recruit-stage-new', after: after ?? flow.keys.at(-1) ?? '', stageKind: 'meeting', form: false };
  render();
  $('.rs-new [name="title"]')?.focus();
}

function recruitStageNewModalHtml(m) {
  const flow = recruitFlow();
  const after = [{ value: '', label: 'Nothing: people start here' }, ...flow.keys.map((k) => ({ value: k, label: flow.sections[k].title }))];
  return `<div class="modal rs-new" role="dialog" aria-label="New stage">
    <div class="modal__head"><h3>New stage</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <form class="modal__body rc-form" data-action="recruit-stage-create">
      ${recruitFormField('Name', `<input class="text-input" name="title" placeholder="e.g. Interview" maxlength="80" required autocomplete="off" spellcheck="false" value="${MD.esc(m.title || '')}">`)}
      <div class="rc-label">Kind<div class="ss-kinds ss-kinds--compact" role="radiogroup" aria-label="Kind">${RECRUIT_STAGE_KINDS.map((k) => `<button type="button" role="radio" class="ss-kind" data-action="recruit-stage-new-kind" data-kind="${k.value}" aria-checked="${m.stageKind === k.value}"><span class="ss-kind__icon">${recruitKindIcon(k.value)}</span><b>${k.label}</b></button>`).join('')}</div></div>
      ${recruitFormField('Comes after', recruitDd('recruit-stage-new-after', after, m.after || ''))}
      <label class="fe-switch fe-switch--row"><input type="checkbox" data-action="recruit-stage-new-form" ${m.form ? 'checked' : ''}><span class="fe-switch__track"></span><span class="fe-switch__text">A form on the website<small>Applicants fill it in themselves, like a coffee chat request.</small></span></label>
      <p class="field-error" role="alert" ${m.error ? '' : 'hidden'}>${MD.esc(m.error || '')}</p>
    </form>
    <div class="modal__foot"><button class="btn" data-action="modal-close">Cancel</button><button class="btn btn--primary" data-action="recruit-stage-create-go" ${m.busy ? 'disabled' : ''}>${m.busy ? 'Adding…' : 'Add stage'}</button></div>
  </div>`;
}

const recruitStageKeyFor = (title) => { const k = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); return /^[a-z]/.test(k) ? k : 'stage-' + k; };

async function recruitCreateStage() {
  const m = UI.modal;
  if (m?.kind !== 'recruit-stage-new' || m.busy) return;
  const title = String($('.rs-new [name="title"]')?.value || '').trim();
  const error = $('.rs-new .field-error');
  const say = (text) => { m.error = text; if (error) { error.textContent = text; error.hidden = !text; } };
  if (!title) { say('A stage needs a name.'); $('.rs-new [name="title"]')?.focus(); return; }
  const flow = recruitFlow();
  let key = recruitStageKeyFor(title);
  for (let n = 2; flow.sections[key] || key === 'people' || key === 'flow' || key === 'stage' || key === 'person' || key === 'insights'; n += 1) key = `${recruitStageKeyFor(title).slice(0, 37)}-${n}`;
  const after = $('.rs-new [data-m="recruit-stage-new-after"]')?.dataset.value ?? m.after ?? '';
  const preset = RECRUIT_KIND_PRESETS[m.stageKind] || RECRUIT_KIND_PRESETS.step;
  const stage = {
    title, kind: m.stageKind, open: false, description: '',
    form: m.form ? { questions: [{ key: 'name', type: 'short', label: 'Name', required: true, max: 100 }, { key: 'email', type: 'email', label: 'Email', required: true, max: 200 }] } : null,
    fields: JSON.parse(JSON.stringify(preset.fields)), done: preset.done,
  };
  m.busy = true;
  say('');
  const ok = await recruitFlowEdit((e) => {
    // In between: what followed the stage before now follows the new one.
    const next = after ? [...(e.next.get(after) || [])] : [...flow.keys.filter((k) => !(flow.into.get(k) || []).length)];
    if (after) e.next.set(after, [key]);
    e.next.set(key, next);
    const at = after ? e.order.indexOf(after) + 1 : 0;
    e.order.splice(at, 0, key);
    e.add[key] = stage;
  }, `${title} added`);
  m.busy = false;
  if (!ok) { if (UI.modal === m) render(); return; }
  if (UI.modal === m) closeModal(() => nav(recruitStageHref(key, m.form ? 'form' : 'checklist')));
}

/* ------------------------------- dragging to reorder -------------------- */

const recruitCards = (listEl) => (listEl ? [...listEl.children].filter((el) => el.dataset?.qid) : []);
const recruitMeasurable = (el) => typeof el?.getBoundingClientRect === 'function';

function recruitCardTops(listEl) {
  const tops = new Map();
  for (const el of recruitCards(listEl)) if (recruitMeasurable(el)) tops.set(el.dataset.qid, el.getBoundingClientRect().top);
  return tops;
}

// FLIP: cards start where they were and glide to where they are now.
function recruitFlip(listEl, before) {
  if (!listEl || !before.size || recruitReducedMotion()) return;
  const moved = [];
  for (const el of recruitCards(listEl)) {
    if (!recruitMeasurable(el) || !before.has(el.dataset.qid)) continue;
    const dy = before.get(el.dataset.qid) - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) continue;
    el.style.transition = 'none';
    el.style.transform = `translateY(${dy}px)`;
    moved.push(el);
  }
  if (!moved.length) return;
  void listEl.offsetHeight;
  for (const el of moved) { el.style.transition = 'transform 220ms cubic-bezier(0.2, 0, 0, 1)'; el.style.transform = ''; }
  setTimeout(() => { for (const el of moved) el.style.transition = ''; }, 260);
}

// The list a grip belongs to, as the draft's array and its name.
function recruitSortTarget(grip) {
  const listEl = grip.closest('[data-sortable]');
  const c = recruitStageCtx(grip);
  if (!listEl || !c) return null;
  const list = listEl.dataset.sortable;
  const items = list === 'questions' ? c.m.form?.questions : c.m.fields;
  return items ? { c, list, listEl, items } : null;
}

// Dragging a card by its grip: the card follows the pointer, the others slide
// out of its way, and the drop repaints the list in the new order.
function recruitDragStart(ev, grip) {
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  const t = recruitSortTarget(grip);
  const card = grip.closest('[data-qid]');
  if (!t || !card || !recruitMeasurable(card)) return;
  ev.preventDefault();
  const cards = recruitCards(t.listEl);
  const from = cards.indexOf(card);
  const rects = cards.map((el) => el.getBoundingClientRect());
  const gap = cards.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 12;
  const h = rects[from].height + gap;
  const startY = ev.clientY;
  const others = cards.map((_, j) => j).filter((j) => j !== from);
  let to = from;
  card.classList.add('is-dragging');
  t.listEl.classList.add('is-sorting');
  try { grip.setPointerCapture?.(ev.pointerId); } catch { /* capture is a nicety */ }
  const mine = (e) => e.pointerId === undefined || ev.pointerId === undefined || e.pointerId === ev.pointerId;
  const move = (e) => {
    if (!mine(e)) return;
    const dy = e.clientY - startY;
    card.style.transform = `translateY(${dy}px)`;
    const centre = rects[from].top + rects[from].height / 2 + dy;
    to = others.filter((j) => rects[j].top + rects[j].height / 2 < centre).length;
    for (const j of others) {
      const shift = j < from ? (j >= to ? h : 0) : (j <= to ? -h : 0);
      cards[j].style.transform = shift ? `translateY(${shift}px)` : '';
    }
  };
  const end = (e) => {
    if (e && !mine(e)) return;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', end);
    document.removeEventListener('pointercancel', end);
    card.classList.remove('is-dragging');
    if (to !== from) {
      const [item] = t.items.splice(from, 1);
      t.items.splice(to, 0, item);
      recruitPaintStageTab(t.c, { list: t.list });
      t.listEl.classList.remove('is-sorting');
      $(`[data-sortable="${t.list}"] [data-i="${to}"] .rc-grip`)?.focus({ preventScroll: true });
    } else {
      for (const el of cards) el.style.transform = '';
      setTimeout(() => t.listEl.classList.remove('is-sorting'), 200);
    }
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('pointerdown', (ev) => {
    const grip = typeof ev.target?.closest === 'function' ? ev.target.closest('[data-sortable] .rc-grip') : null;
    if (grip) recruitDragStart(ev, grip);
  });
}

// Arrow keys on a grip move the card one slot.
function recruitMoveCard(grip, delta) {
  const t = recruitSortTarget(grip);
  if (!t) return;
  const i = Number(grip.dataset.i), j = i + delta;
  if (j < 0 || j >= t.items.length) return;
  [t.items[i], t.items[j]] = [t.items[j], t.items[i]];
  recruitPaintStageTab(t.c, { list: t.list });
  $(`[data-sortable="${t.list}"] [data-i="${j}"] .rc-grip`)?.focus({ preventScroll: true });
}

/* ------------------------------- register -------------------------------- */

// Every edit changes the draft, then repaints what it touched.
const recruitEdit = (fn, paint = 'save') => (el, ev) => {
  const c = recruitStageCtx(el);
  if (!c || !recruitCanEdit(c.cycle)) return;
  c.d.error = '';
  if (fn(c, el, ev) === false) return;
  if (paint === 'questions' || paint === 'fields') recruitPaintStageTab(c, { list: paint });
  else if (paint === 'tab') recruitPaintStageTab(c);
  else recruitPaintStageSave(c);
};

RECRUIT.register({
  name: 'stage',
  order: 2,
  kernel: true,
  panels: [{ id: 'stage', label: 'Stage', tab: false, order: 50, when: () => true }],
  view: (cycle) => recruitStageView(cycle),
  crumb: () => MD.esc(recruitSectionTitle(recruitStageKey()) || 'Stage'),
  dirty: () => Object.values(recruitState().stageDrafts || {}).some(recruitStageDirty),
  mount(cycle) {
    const st = recruitState();
    const key = recruitStageKey();
    const entering = !st.mod.drawer;
    st.mod.drawer = key || 'none';
    recruitFlowMounted(cycle, { animate: entering });
    // Opening moves focus into the panel (closing returns it to the card);
    // a tab or a step to the next stage keeps it on the panel's tabs.
    if (entering) $('.sd')?.focus?.({ preventScroll: true });
    else if (!document.activeElement || document.activeElement === document.body) $('.sd-tabs [aria-selected="true"]')?.focus?.({ preventScroll: true });
    if (key && recruitStageTab() === 'people') {
      const sp = recruitStagePeopleState(cycle, key);
      if (!sp.loaded && !sp.loading) recruitLoadStagePeople();
    }
  },
  refresh: { load: async () => { await recruitLoadInsights({ quiet: true }); const sp = recruitState().stagePeople; if (sp?.loaded && recruitStageTab() === 'people' && !sp.selected.size) await recruitLoadStagePeople(); }, every: RECRUIT_SYNC_MS },
  personChanged: (email) => recruitPaintStagePerson(email),
  insightsChanged: () => {
    const cycle = recruitCycleRow(), key = recruitStageKey();
    const head = $('[data-rc="stage-head"]');
    if (head && cycle && key) recruitRepaint(head, recruitStageHeadHtml(cycle, key));
    const show = $('[data-rc="stage-show"]');
    const sp = recruitState().stagePeople;
    if (show && cycle && key && sp?.key === key && !show.contains(document.activeElement)) show.outerHTML = recruitStageShowHtml(cycle, key, sp);
  },
  actions: {
    'recruit-stage-new': () => recruitOpenStageNew(),
    'recruit-stage-new-kind': (el) => {
      const m = UI.modal; if (m?.kind !== 'recruit-stage-new') return;
      m.stageKind = el.dataset.kind; m.form = el.dataset.kind === 'form' ? true : m.form && el.dataset.kind !== 'review' && el.dataset.kind !== 'step';
      m.title = String($('.rs-new [name="title"]')?.value || '');
      m.after = $('.rs-new [data-m="recruit-stage-new-after"]')?.dataset.value ?? m.after;
      for (const b of $$('.rs-new [data-action="recruit-stage-new-kind"]')) b.setAttribute('aria-checked', String(b.dataset.kind === m.stageKind));
      const box = $('.rs-new [data-action="recruit-stage-new-form"]'); if (box) box.checked = m.form;
    },
    'recruit-stage-new-form': (el) => { const m = UI.modal; if (m?.kind === 'recruit-stage-new') m.form = Boolean(el.checked); },
    'recruit-stage-create': () => recruitCreateStage(),
    'recruit-stage-create-go': () => recruitCreateStage(),
    'recruit-stage-remove': () => { const key = recruitStageKey(); if (key) recruitConfirmRemoveStage(key); },
    'recruit-stage-save': (el) => recruitSaveStage(el),
    'recruit-stage-discard': (el) => { const c = recruitStageCtx(el); if (!c) return; c.d.model = JSON.parse(c.d.saved); c.d.error = ''; recruitPaintStageTab(c); toast('Changes discarded'); },
    'recruit-stage-open': (el) => recruitToggleStageOpen(el),
    'recruit-copy-link': (el) => recruitCopy(el.dataset.link || '', 'Link copied'),
    // People here
    'recruit-stage-people-more': () => recruitLoadStagePeople(true),
    'recruit-stage-people-retry': () => recruitLoadStagePeople(),
    'recruit-stage-select': (el) => { const sp = recruitState().stagePeople; if (!sp) return; if (el.checked) sp.selected.add(el.dataset.email); else sp.selected.delete(el.dataset.email); el.closest('tr')?.classList.toggle('is-selected', el.checked); recruitPaintStageBar(); recruitRepaint($('[data-rc="stage-people-head"]'), recruitStagePeopleHeadHtml(recruitCycleRow(), sp.key, sp)); },
    'recruit-stage-select-all': (el) => { const sp = recruitState().stagePeople; if (!sp) return; sp.selected = el.checked ? new Set(sp.rows.map((r) => r.email)) : new Set(); recruitPaintStagePeople(); recruitPaintStageBar(); },
    'recruit-stage-clear': () => { const sp = recruitState().stagePeople; if (!sp) return; sp.selected = new Set(); recruitPaintStagePeople(); recruitPaintStageBar(); },
    'recruit-stage-close': () => recruitStageClose(),
    // The form
    'recruit-sf-preview': recruitEdit((c) => { c.d.preview = !c.d.preview; }, 'tab'),
    'recruit-sf-add-form': recruitEdit((c) => { c.m.form = { questions: [{ _id: recruitItemId(), key: 'name', type: 'short', label: 'Name', help: '', required: true, fixed: true, max: 100 }, { _id: recruitItemId(), key: 'email', type: 'email', label: 'Email', help: '', required: true, fixed: true, max: 200 }] }; }, 'tab'),
    'recruit-sf-remove-form': recruitEdit((c) => { c.m.form = null; c.m.open = false; c.m.atApply = false; }, 'tab'),
    'recruit-sf-add': recruitEdit((c) => {
      c.m.form.questions.push({ _id: recruitItemId(), key: '', type: 'short', label: '', help: '', required: false, fixed: false });
      setTimeout(() => $$('[data-m="recruit-sf-label"]').at(-1)?.focus({ preventScroll: false }), 0);
    }, 'questions'),
    'recruit-sf-duplicate': recruitEdit((c) => { if (!c.q || c.q.fixed) return false; c.m.form.questions.splice(c.i + 1, 0, { ...JSON.parse(JSON.stringify(c.q)), _id: recruitItemId(), key: '', label: c.q.label ? `${c.q.label} (copy)` : '' }); }, 'questions'),
    'recruit-sf-remove': recruitEdit((c) => { if (!c.q || c.q.fixed) return false; c.m.form.questions.splice(c.i, 1); }, 'questions'),
    'recruit-sf-required': recruitEdit((c, el) => { if (!c.q || ['name', 'email'].includes(c.q.key)) return false; c.q.required = Boolean(el.checked); }),
    'recruit-sf-open': recruitEdit((c, el) => { c.m.open = Boolean(el.checked); }),
    'recruit-sf-landing': recruitEdit((c, el) => { c.m.atApply = Boolean(el.checked); }, 'tab'),
    'recruit-sf-notify': recruitEdit((c, el) => { c.m.notify = Boolean(el.checked); }, 'tab'),
    'recruit-sf-recipient-add': recruitEdit((c) => { c.m.notifyTo = [...(c.m.notifyTo || []), '']; setTimeout(() => $$('[data-m="recruit-sf-recipient"]').at(-1)?.focus(), 0); }, 'tab'),
    'recruit-sf-recipient-remove': recruitEdit((c) => { c.m.notifyTo.splice(c.j, 1); }, 'tab'),
    'recruit-sf-option-add': recruitEdit((c) => { if (!c.q) return false; c.q.options = [...(c.q.options || []), '']; setTimeout(() => $$(`[data-m="recruit-sf-option"][data-i="${c.i}"]`).at(-1)?.focus(), 0); }, 'questions'),
    'recruit-sf-option-remove': recruitEdit((c) => { if (!c.q?.options) return false; c.q.options.splice(c.j, 1); }, 'questions'),
    'recruit-grip': () => {},   // a click on the grip does nothing; dragging and the arrow keys move the card
    // The checklist
    'recruit-ck-add': (el) => {
      const c = recruitStageCtx(el);
      if (!c) return;
      openMenu(RECRUIT_FIELD_TYPES.map((t) => ({ label: t.label, icon: RC_ICONS[t.icon], run: () => {
        const c2 = recruitStageCtx(el);
        if (!c2) return;
        c2.m.fields.push({ _id: recruitItemId(), key: '', ...JSON.parse(JSON.stringify(RECRUIT_FIELD_PRESETS[t.value])), saved: false });
        recruitPaintStageTab(c2, { list: 'fields' });
        $$('[data-m="recruit-ck-label"]').at(-1)?.focus();
      } })), el);
    },
    'recruit-ck-remove': recruitEdit((c) => { if (!c.f) return false; if (c.m.done === c.f.key) c.m.done = null; c.m.fields.splice(c.i, 1); }, 'fields'),
    'recruit-ck-each': recruitEdit((c, el) => { if (!c.f) return false; c.f.each = Boolean(el.checked); }, 'fields'),
    'recruit-ck-done': recruitEdit((c, el) => {
      if (!c.f) return false;
      for (const f of c.m.fields) delete f._markDone;
      if (el.checked) { if (c.f.key) c.m.done = c.f.key; else { c.m.done = null; c.f._markDone = true; } } else if (c.m.done === c.f.key) c.m.done = null;
    }, 'fields'),
    'recruit-ck-option-add': recruitEdit((c) => { if (!c.f) return false; c.f.options = [...(c.f.options || []), '']; setTimeout(() => $$(`[data-m="recruit-ck-option"][data-i="${c.i}"]`).at(-1)?.focus(), 0); }, 'fields'),
    'recruit-ck-option-remove': recruitEdit((c) => { if (!c.f?.options) return false; c.f.options.splice(c.j, 1); }, 'fields'),
    // Settings
    'recruit-ss-kind': recruitEdit((c, el) => { c.m.kind = el.dataset.kind; for (const b of $$('[data-action="recruit-ss-kind"]')) b.setAttribute('aria-checked', String(b.dataset.kind === c.m.kind)); }),
    'recruit-ss-next': recruitEdit((c, el) => { const to = el.dataset.to; c.m.next = el.checked ? [...new Set([...c.m.next, to])] : c.m.next.filter((k) => k !== to); }, 'tab'),
  },
  inputs: {
    'recruit-sf-title': recruitEdit((c, el) => { c.m.title = el.value; }),
    'recruit-ss-title': recruitEdit((c, el) => { c.m.title = el.value; }),
    'recruit-sf-desc': recruitEdit((c, el) => { c.m.description = el.value; }),
    'recruit-sf-thanks': recruitEdit((c, el) => { c.m.thanks = el.value; }),
    'recruit-sf-submit-label': recruitEdit((c, el) => { c.m.submitLabel = el.value; }),
    'recruit-sf-success-label': recruitEdit((c, el) => { c.m.successLabel = el.value; }),
    'recruit-sf-choice-label': recruitEdit((c, el) => { c.m.choiceLabel = el.value; }),
    'recruit-sf-question': recruitEdit((c, el) => { c.m.question = el.value; }),
    'recruit-sf-capacity': recruitEdit((c, el) => { const n = Number(String(el.value || '').replace(/[^\d]/g, '')); c.m.capacity = Number.isInteger(n) && n > 0 ? Math.min(n, 100000) : 0; }),
    'recruit-sf-label': recruitEdit((c, el) => { if (!c.q) return false; c.q.label = el.value; }),
    'recruit-sf-help': recruitEdit((c, el) => {
      if (!c.q) return false;
      c.q.help = el.value;
      const box = $(`.fe-q[data-i="${c.i}"] [data-rc="fe-answer"]`, c.host);
      if (box && !recruitIsChoice(c.q.type) && !recruitIsText(c.q.type)) box.innerHTML = recruitAnswerPreviewHtml(c.q, c.i);
    }),
    'recruit-sf-option': recruitEdit((c, el) => { if (!c.q?.options) return false; c.q.options[c.j] = el.value; }),
    'recruit-sf-recipient': recruitEdit((c, el) => {
      c.m.notifyTo[c.j] = el.value;
      const note = $('[data-rc="sf-notify-default"]', c.host);
      if (note) note.hidden = c.m.notifyTo.some((e) => String(e).trim());
    }),
    'recruit-ck-label': recruitEdit((c, el) => {
      if (!c.f) return false;
      c.f.label = el.value;
      const preview = $('[data-rc="checklist-preview"]');
      if (preview) recruitRepaint(preview, recruitChecklistPreviewHtml(c.d));
    }),
    'recruit-ck-option': recruitEdit((c, el) => { if (!c.f?.options) return false; c.f.options[c.j] = el.value; }),
    'recruit-stage-q': (el) => {
      const sp = recruitState().stagePeople; if (!sp) return;
      sp.q = el.value;
      clearTimeout(recruitStageSearchTimer);
      recruitStageSearchTimer = setTimeout(() => recruitLoadStagePeople(), 220);
    },
  },
  dd: {
    'recruit-sf-type': (host, value) => {
      if (value === undefined) return undefined;
      recruitEdit((c) => {
        if (!c.q || c.q.fixed || c.q.type === value) return false;
        const wasChoice = recruitIsChoice(c.q.type), isChoice = recruitIsChoice(value);
        c.q.type = value;
        if (isChoice && !wasChoice) c.q.options = [''];
        if (!isChoice) delete c.q.options;
        if (recruitTakesFile(value)) { c.q.accept = [...RECRUIT_FILE_ACCEPT]; c.q.maxBytes = 2621440; } else { delete c.q.accept; delete c.q.maxBytes; }
        setTimeout(() => $(`[data-m="recruit-sf-type"][data-i="${c.i}"]`)?.focus({ preventScroll: true }), 0);
      }, 'questions')(host);
    },
    'recruit-ck-type': (host, value) => {
      if (value === undefined) return undefined;
      recruitEdit((c) => {
        if (!c.f || c.f.saved || c.f.type === value) return false;
        const label = c.f.label;
        Object.assign(c.f, JSON.parse(JSON.stringify(RECRUIT_FIELD_PRESETS[value])), { label });
        if (value !== 'choice') delete c.f.options;
        if (value !== 'rating') delete c.f.max;
        if (!RECRUIT_EACH_TYPES.includes(value)) c.f.each = false;
        if (value !== 'check' && c.m.done === c.f.key) c.m.done = null;
      }, 'fields')(host);
    },
    'recruit-ck-max': (host, value) => { if (value === undefined) return undefined; recruitEdit((c) => { if (!c.f) return false; c.f.max = Number(value); }, 'fields')(host); },
    'recruit-stage-new-after': (host, value) => { if (value !== undefined && UI.modal?.kind === 'recruit-stage-new') UI.modal.after = value; },
    'recruit-stage-filter': (host, value) => {
      if (value === undefined) return undefined;
      const sp = recruitState().stagePeople;
      if (!sp || value === sp.filter) return;
      sp.filter = value; sp.selected = new Set();
      recruitLoadStagePeople();
    },
  },
  modals: { 'recruit-stage-new': recruitStageNewModalHtml },
  keydown(ev) {
    // Arrow keys move a card by its grip.
    const grip = typeof ev.target?.matches === 'function' && ev.target.matches('[data-sortable] .rc-grip') ? ev.target : null;
    if (grip && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
      ev.preventDefault();
      recruitMoveCard(grip, ev.key === 'ArrowUp' ? -1 : 1);
      return true;
    }
    // Escape leaves a text box first, then closes the panel.
    if (ev.key !== 'Escape' || UI.modal || UI.menu || UI.route?.params?.sub !== 'stage') return false;
    if (typeof ev.target?.matches === 'function' && ev.target.matches('input, textarea') && ev.target.type !== 'checkbox') { ev.target.blur?.(); return true; }
    ev.preventDefault();
    recruitStageClose();
    return true;
  },
  cycleChanged() {
    const sp = recruitState().stagePeople;
    if (sp) { sp.seq = (sp.seq || 0) + 1; Object.assign(sp, { loaded: false, loading: false, rows: [], next: null }); }
  },
  reset() { const st = recruitState(); st.stagePeople = undefined; clearTimeout(recruitStageSearchTimer); },
});

// recruit:stage:end
