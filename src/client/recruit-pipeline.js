// recruit:pipeline:start
'use strict';

/* Pipeline (client): the Stage column, the Move / Decide / Tag dialogs,
   saved views and the Stages settings section. The stage strip and the
   per-application stage control belong to the Applications panel.
   Everything is data-action wiring through RECRUIT; nothing here attaches
   listeners or calls render() from an async completion. */

const RC_PIPE_QUERY_KEYS = ['q', 'stage', 'subteam', 'year', 'tag', 'flagged', 'assigned', 'unscored', 'sort', 'dir'];
const RC_PIPE_KINDS = [{ value: 'open', label: 'Open' }, { value: 'hold', label: 'Hold' }, { value: 'closed', label: 'Closed' }];
const RC_PIPE_OUTCOMES = [{ value: '', label: 'No outcome' }, { value: 'accepted', label: 'Accepted' }, { value: 'declined', label: 'Declined' }, { value: 'rejected', label: 'Rejected' }, { value: 'waitlisted', label: 'Waitlisted' }];

function rcPipeCycle() { return UI.recruit?.cycle?.data || null; }
function rcPipeRole() { return UI.recruit?.cycle?.role || null; }
function rcPipeLead(role = rcPipeRole()) { return role === 'admin' || role === 'lead'; }
function rcPipeSettings(cycle) {
  const s = cycle?.doc?.pipeline || {};
  return { stages: Array.isArray(s.stages) ? s.stages : [], views: Array.isArray(s.views) ? s.views : [], reviewersMayMove: s.reviewersMayMove === true };
}
function rcPipeStages(cycle) { return rcPipeSettings(cycle).stages; }
function rcPipeStageName(cycle, key) { return rcPipeStages(cycle).find((s) => s.key === key)?.name || key || '—'; }
function rcPipeOutcome(cycle, key) { const s = rcPipeStages(cycle).find((x) => x.key === key); return s && s.kind !== 'open' ? s.outcome || null : null; }
function rcPipeStageOptions(cycle, { openOnly = false } = {}) {
  return rcPipeStages(cycle).filter((s) => !openOnly || s.kind === 'open').map((s) => ({ value: s.key, label: s.name }));
}
function rcPipeState() {
  UI.recruit ||= {};
  UI.recruit.mod ||= {};
  return (UI.recruit.mod.pipeline ||= { stageDraft: null });
}
function rcPipeFilters(cycleId = UI.recruit?.cycleId) {
  UI.recruit ||= {};
  UI.recruit.filters ||= {};
  return (UI.recruit.filters[cycleId] ||= {});
}

// Filters become the list query; empty values are left out.
function rcPipeQuery(filters) {
  const parts = [];
  for (const key of RC_PIPE_QUERY_KEYS) {
    const value = filters?.[key];
    if (value === undefined || value === null || value === '' || value === false) continue;
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value === true ? '1' : String(value)));
  }
  return parts.length ? '?' + parts.join('&') : '';
}
// The list keeps its filters by group (review: 'unscored'); a saved view
// stores the server query those groups stand for, so it survives renames.
function rcPipeQueryOf(filters, cycle = rcPipeCycle()) {
  const query = {};
  const f = filters || {};
  for (const key of ['q', 'stage', 'sort', 'dir']) if (f[key]) query[key] = String(f[key]);
  const entries = typeof RECRUIT?.filters === 'function' ? RECRUIT.filters(cycle, rcPipeRole()) : [];
  for (const [group, value] of Object.entries(f)) {
    if (['q', 'stage', 'sort', 'dir', 'view'].includes(group) || value === undefined || value === null || value === '' || value === false) continue;
    const entry = entries.find((e) => e.group === group && e.value === value);
    if (entry?.query) for (const [k, v] of Object.entries(entry.query)) query[k] = String(v);
    else if (RC_PIPE_QUERY_KEYS.includes(group)) query[group] = value === true ? '1' : String(value);
  }
  return query;
}
function rcPipeFilterSummary(cycle, filters) {
  const parts = [];
  if (filters?.stage) parts.push(rcPipeStageName(cycle, filters.stage));
  if (filters?.subteam) parts.push(filters.subteam === '__undecided' ? 'Undecided' : filters.subteam);
  if (filters?.year) parts.push(filters.year);
  if (filters?.tag) parts.push('#' + filters.tag);
  if (filters?.flagged) parts.push('Flagged');
  if (filters?.unscored) parts.push('Unscored');
  if (filters?.assigned) parts.push(filters.assigned === 'me' ? 'Assigned to me' : filters.assigned === 'none' ? 'Unassigned' : 'Assigned to ' + filters.assigned);
  if (filters?.q) parts.push('“' + filters.q + '”');
  return parts.join(' · ') || 'All people';
}

function rcPipeSelectedIds() { return [...(UI.recruit?.selected || [])]; }
function rcPipeRequestId(m) { m.requestId ||= 'rq-' + crypto.randomUUID(); return m.requestId; }
function rcPipeError(e) { return e?.name === 'TimeoutError' ? 'The request timed out. Try again.' : (e?.message || 'Something went wrong'); }
// Filter changes come from the user, so a full render here is fine.
function rcPipeReload() { UI.recruit.apps = undefined; UI.recruit.selected = new Set(); render(); }
function rcPipeAfterMutation() {
  UI.recruit.selected = new Set();
  if (UI.recruit.mod) UI.recruit.mod.analytics = undefined;
}
// A returned row is merged only when it is at least as new as the cached one.
function rcPipeMerge(id, patch) {
  const apps = UI.recruit?.apps;
  const row = apps?.byId?.[id] || apps?.rows?.find?.((r) => r.id === id);
  if (!row) return false;
  if (patch.editVersion !== undefined && row.editVersion !== undefined && patch.editVersion < row.editVersion) return false;
  Object.assign(row, patch);
  return true;
}
function rcPipeShiftCounts(from, to) {
  for (const counts of [UI.recruit?.cycle?.counts?.byStage, UI.recruit?.apps?.counts?.byStage]) {
    if (!counts) continue;
    if (from) counts[from] = Math.max(0, (counts[from] || 0) - 1);
    if (to) counts[to] = (counts[to] || 0) + 1;
  }
}
/* --------------------------------- markup -------------------------------- */

function rcPipeModalFrame({ label, title, body, foot, wide = false }) {
  return `<div class="modal ${wide ? 'modal--wide' : ''}" role="dialog" aria-label="${MD.esc(label)}">
    <div class="modal__head"><h3>${MD.esc(title)}</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body">${body}<p class="field-error" data-rc-error role="alert" hidden></p></div>
    <div class="modal__foot"><button class="btn" data-action="modal-close">Cancel</button>${foot}</div>
  </div>`;
}
function rcPipeMoveModal(m) {
  const cycle = rcPipeCycle();
  const n = m.ids.length;
  const options = rcPipeStageOptions(cycle, { openOnly: !rcPipeLead() });
  return rcPipeModalFrame({
    label: 'Move applications', title: `Move ${n} ${n === 1 ? 'person' : 'people'} to…`,
    body: `<label>Stage ${dd('recruit-move-stage', options.length ? options : [{ value: '', label: 'No stages' }], m.to || options[0]?.value || '')}</label>
      <label>Note<input class="text-input" data-m="recruit-move-note" maxlength="500" autocomplete="off" value="${MD.esc(m.note || '')}"></label>`,
    foot: `<button class="btn btn--primary" data-action="recruit-move-go">Move</button>`,
  });
}
function rcPipeDecideModal(m) {
  const cycle = rcPipeCycle();
  const n = m.ids.length;
  const outcomes = rcPipeStages(cycle).filter((s) => s.kind !== 'open' && s.outcome).map((s) => ({ value: s.outcome, label: s.name }));
  const subteams = [{ value: '', label: 'Keep subteam' }, ...((cycle?.doc?.subteams || []).map((s) => ({ value: s.key, label: s.name })))];
  return rcPipeModalFrame({
    label: 'Decide', title: `Decide for ${n} ${n === 1 ? 'person' : 'people'}`,
    body: `<label>Outcome ${dd('recruit-decide-outcome', outcomes.length ? outcomes : [{ value: '', label: 'No decision stages' }], m.outcome || outcomes[0]?.value || '')}</label>
      <label>Reason<textarea class="text-input" data-m="recruit-decide-reason" maxlength="2000" rows="3">${MD.esc(m.reason || '')}</textarea></label>
      <label>Subteam ${dd('recruit-decide-subteam', subteams, m.subteam || '')}</label>`,
    foot: `<button class="btn btn--primary" data-action="recruit-decide-go">Record decision</button>`,
  });
}
function rcPipeTagModal(m) {
  const n = m.ids.length;
  return rcPipeModalFrame({
    label: 'Tag applications', title: `Tag ${n} ${n === 1 ? 'person' : 'people'}`,
    body: `<label>Add<input class="text-input" data-m="recruit-tag-add" placeholder="comma separated" autocomplete="off" value="${MD.esc(m.add || '')}"></label>
      <label>Remove<input class="text-input" data-m="recruit-tag-remove" placeholder="comma separated" autocomplete="off" value="${MD.esc(m.remove || '')}"></label>`,
    foot: `<button class="btn btn--primary" data-action="recruit-tag-go">Apply</button>`,
  });
}
function rcPipeViewModal(m) {
  const cycle = rcPipeCycle();
  return rcPipeModalFrame({
    label: 'Save view', title: 'Save current view',
    body: `<p class="faint">${MD.esc(rcPipeFilterSummary(cycle, rcPipeQueryOf(rcPipeFilters(), cycle)))}</p>
      <label>Name<input class="text-input" data-m="recruit-view-name" maxlength="60" autocomplete="off" value="${MD.esc(m.name || '')}"></label>`,
    foot: `<button class="btn btn--primary" data-action="recruit-view-go">Save</button>`,
  });
}
function rcPipeViewsListHtml(cycle) {
  const views = rcPipeSettings(cycle).views;
  if (!views.length) return '<p class="faint">No saved views.</p>';
  return `<ul class="rc-views">${views.map((v) => `<li><b>${MD.esc(v.name)}</b> <span class="faint">${MD.esc(rcPipeFilterSummary(cycle, v.query))}</span> <button class="btn btn--sm" data-action="recruit-view-apply" data-key="${MD.esc(v.key)}">Open</button> <button class="btn btn--sm btn--danger" data-action="recruit-view-delete" data-key="${MD.esc(v.key)}">Delete</button></li>`).join('')}</ul>`;
}
function rcPipeViewsModal() {
  return rcPipeModalFrame({ label: 'Saved views', title: 'Saved views', body: `<div data-rc-views>${rcPipeViewsListHtml(rcPipeCycle())}</div>`, foot: '' });
}

/* ------------------------------ mutations ------------------------------- */

function rcPipeModalError(message) {
  const box = $('.modal [data-rc-error]');
  if (!box) return;
  box.textContent = message || '';
  box.hidden = !message;
}
function rcPipeModalBusy(action, busy, label) {
  const button = $(`.modal [data-action="${action}"]`);
  if (!button) return;
  button.disabled = busy;
  if (label) button.textContent = label;
}
function rcPipePost(cycle, path, body) {
  return RECRUIT.api(`/recruit/cycles/${cycle.id}/${path}`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
}
async function rcPipeSaveSettings(cycle, patch) {
  const settings = { ...rcPipeSettings(cycle), ...patch };
  const out = await RECRUIT.api(`/recruit/cycles/${cycle.id}/settings/pipeline`, { method: 'PUT', body: JSON.stringify({ version: cycle.version, settings }), signal: AbortSignal.timeout(20000) });
  if (out?.cycle && UI.recruit?.cycle?.data?.id === out.cycle.id) UI.recruit.cycle.data = out.cycle;
  return out;
}

// One request id per dialog: a retry after a timeout replays, never repeats.
async function rcPipeMove(m) {
  const cycle = rcPipeCycle();
  if (!cycle || m.busy) return;
  const to = $('.modal [data-m="recruit-move-stage"]')?.dataset.value || m.to || '';
  const note = $('.modal [data-m="recruit-move-note"]')?.value || '';
  if (!to) { rcPipeModalError('Choose a stage'); return; }
  m.busy = true;
  rcPipeModalError('');
  rcPipeModalBusy('recruit-move-go', true, 'Moving…');
  try {
    const out = await rcPipePost(cycle, 'moves', { requestId: rcPipeRequestId(m), ids: m.ids, to, note });
    const moved = out.moved || [], skipped = out.skipped || [];
    for (const row of moved) {
      rcPipeMerge(row.id, { stage: to, stageAt: Date.now(), outcome: rcPipeOutcome(cycle, to), editVersion: row.editVersion });
      rcPipeShiftCounts(row.from, to);
    }
    rcPipeAfterMutation();
    m.busy = false;
    closeModal(() => renderBackground('recruit'));
    toast(`Moved ${moved.length} to ${rcPipeStageName(cycle, to)}${skipped.length ? ` · ${skipped.length} skipped` : ''}`);
  } catch (e) {
    m.busy = false;
    rcPipeModalError(rcPipeError(e));
    rcPipeModalBusy('recruit-move-go', false, 'Move');
  }
}

async function rcPipeDecide(m) {
  const cycle = rcPipeCycle();
  if (!cycle || m.busy) return;
  const outcome = $('.modal [data-m="recruit-decide-outcome"]')?.dataset.value || '';
  const reason = $('.modal [data-m="recruit-decide-reason"]')?.value || '';
  const subteam = $('.modal [data-m="recruit-decide-subteam"]')?.dataset.value || '';
  if (!outcome) { rcPipeModalError('Choose an outcome'); return; }
  const stage = rcPipeStages(cycle).find((s) => s.kind !== 'open' && s.outcome === outcome);
  m.busy = true;
  rcPipeModalError('');
  rcPipeModalBusy('recruit-decide-go', true, 'Recording…');
  try {
    const out = await rcPipePost(cycle, 'decisions', { requestId: rcPipeRequestId(m), ids: m.ids, outcome, reason, subteam });
    const decided = out.decided || [];
    for (const row of decided) {
      rcPipeMerge(row.id, { stage: stage?.key || outcome, stageAt: Date.now(), outcome, decision: { outcome, reason, subteam, at: Date.now() }, editVersion: row.editVersion });
      if (stage && row.from !== stage.key) rcPipeShiftCounts(row.from, stage.key);
    }
    rcPipeAfterMutation();
    m.busy = false;
    closeModal(() => renderBackground('recruit'));
    toast(`Marked ${decided.length} ${stage ? stage.name.toLowerCase() : outcome}${(out.skipped || []).length ? ` · ${out.skipped.length} skipped` : ''}`);
  } catch (e) {
    m.busy = false;
    rcPipeModalError(rcPipeError(e));
    rcPipeModalBusy('recruit-decide-go', false, 'Record decision');
  }
}

const rcPipeTagList = (text) => [...new Set(String(text || '').split(',').map((t) => t.trim()).filter(Boolean))];
async function rcPipeTag(m) {
  const cycle = rcPipeCycle();
  if (!cycle || m.busy) return;
  const add = rcPipeTagList($('.modal [data-m="recruit-tag-add"]')?.value);
  const remove = rcPipeTagList($('.modal [data-m="recruit-tag-remove"]')?.value);
  if (!add.length && !remove.length) { rcPipeModalError('Nothing to change'); return; }
  m.busy = true;
  rcPipeModalError('');
  rcPipeModalBusy('recruit-tag-go', true, 'Applying…');
  try {
    const out = await rcPipePost(cycle, 'tags', { requestId: rcPipeRequestId(m), ids: m.ids, add, remove });
    for (const row of out.tagged || []) rcPipeMerge(row.id, { tags: row.tags, editVersion: row.editVersion });
    rcPipeAfterMutation();
    m.busy = false;
    closeModal(() => renderBackground('recruit'));
    toast(`Tagged ${(out.tagged || []).length}`);
  } catch (e) {
    m.busy = false;
    rcPipeModalError(rcPipeError(e));
    rcPipeModalBusy('recruit-tag-go', false, 'Apply');
  }
}

const rcPipeSlug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'view';
function rcPipeApplyView(view) {
  const cycle = rcPipeCycle();
  const f = rcPipeFilters();
  for (const key of Object.keys(f)) delete f[key];
  const query = view.query || {};
  for (const key of ['q', 'stage', 'sort', 'dir']) if (query[key]) f[key] = query[key];
  const rest = Object.fromEntries(Object.entries(query).filter(([k]) => !['q', 'stage', 'sort', 'dir'].includes(k)));
  const entries = typeof RECRUIT?.filters === 'function' ? RECRUIT.filters(cycle, rcPipeRole()) : [];
  for (const e of entries) {
    if (!e.query || !Object.keys(e.query).length) continue;
    if (Object.entries(e.query).every(([k, v]) => String(rest[k] ?? '') === String(v))) f[e.group] = e.value;
  }
  if (!entries.length) Object.assign(f, rest);
  f.view = view.key;
  rcPipeReload();
}
async function rcPipeSaveView(m) {
  const cycle = rcPipeCycle();
  if (!cycle || m.busy) return;
  const name = ($('.modal [data-m="recruit-view-name"]')?.value || '').trim();
  if (!name) { rcPipeModalError('Give the view a name'); return; }
  const views = rcPipeSettings(cycle).views;
  let key = rcPipeSlug(name);
  while (views.some((v) => v.key === key && v.name !== name)) key += '-2';
  m.busy = true;
  rcPipeModalError('');
  rcPipeModalBusy('recruit-view-go', true, 'Saving…');
  try {
    await rcPipeSaveSettings(cycle, { views: [...views.filter((v) => v.key !== key), { key, name, query: rcPipeQueryOf(rcPipeFilters(), cycle) }] });
    rcPipeFilters().view = key;
    m.busy = false;
    closeModal(() => renderBackground('recruit'));
    toast('View saved');
  } catch (e) {
    m.busy = false;
    rcPipeModalError(rcPipeError(e));
    rcPipeModalBusy('recruit-view-go', false, 'Save');
  }
}
async function rcPipeDeleteView(key) {
  const cycle = rcPipeCycle();
  if (!cycle) return;
  const button = $(`.modal [data-action="recruit-view-delete"][data-key="${key}"]`);
  if (button) button.disabled = true;
  try {
    await rcPipeSaveSettings(cycle, { views: rcPipeSettings(cycle).views.filter((v) => v.key !== key) });
    if (rcPipeFilters().view === key) delete rcPipeFilters().view;
    const list = $('.modal [data-rc-views]');
    if (list) {
      list.innerHTML = rcPipeViewsListHtml(rcPipeCycle());
      ($('[data-action="recruit-view-delete"]', list) || $('.modal [data-action="modal-close"]'))?.focus({ preventScroll: true });
    }
    toast('View deleted');
  } catch (e) {
    if (button) button.disabled = false;
    rcPipeModalError(rcPipeError(e));
  }
}
// Computed menu items for the views control; RECRUIT.dd opens them.
function rcPipeViewMenu() {
  const cycle = rcPipeCycle();
  const views = rcPipeSettings(cycle).views;
  const current = rcPipeFilters().view;
  const blank = '<span style="width:14px;flex:none"></span>';
  const items = views.map((v) => ({ label: v.name, selected: v.key === current, icon: v.key === current ? I.check : blank, run: () => rcPipeApplyView(v) }));
  if (rcPipeLead()) {
    if (items.length) items.push('-');
    items.push({ label: 'Save current view…', run: () => showModal({ kind: 'recruit-view' }) });
    if (views.length) items.push({ label: 'Manage views…', run: () => showModal({ kind: 'recruit-views' }) });
  } else if (!items.length) items.push({ label: 'No saved views', run: () => {} });
  return items;
}

/* ------------------------- Stages settings section ---------------------- */

function rcPipeStageRows(cycle) {
  const st = rcPipeState();
  return st.stageDraft || rcPipeStages(cycle).map((s) => ({ ...s }));
}
function rcPipeStageRowsHtml(cycle) {
  const rows = rcPipeStageRows(cycle);
  return rows.map((s, i) => `<div class="rc-stage" data-rc-stage="${MD.esc(s.key)}">
    <span class="kbd">${MD.esc(s.key)}</span>
    <input class="text-input" name="stage-name-${MD.esc(s.key)}" value="${MD.esc(s.name)}" maxlength="40" aria-label="Stage name" autocomplete="off">
    ${dd('recruit-stage-kind', RC_PIPE_KINDS, s.kind || 'open', { small: true })}
    ${dd('recruit-stage-outcome', RC_PIPE_OUTCOMES, s.outcome || '', { small: true })}
    <button type="button" class="icon-btn" data-action="recruit-stage-up" data-key="${MD.esc(s.key)}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
    <button type="button" class="icon-btn" data-action="recruit-stage-down" data-key="${MD.esc(s.key)}" aria-label="Move down" ${i === rows.length - 1 ? 'disabled' : ''}>↓</button>
    <button type="button" class="icon-btn" data-action="recruit-stage-remove" data-key="${MD.esc(s.key)}" aria-label="Remove stage" ${s.key === 'applied' ? 'disabled' : ''}>${I.x}</button>
  </div>`).join('');
}
function rcPipeReadStageRows(form) {
  const rows = [];
  for (const row of $$('[data-rc-stage]', form)) {
    const key = row.dataset.rcStage;
    const kind = $('[data-m="recruit-stage-kind"]', row)?.dataset.value || 'open';
    const outcome = $('[data-m="recruit-stage-outcome"]', row)?.dataset.value || '';
    const stage = { key, name: ($(`[name="stage-name-${key}"]`, row)?.value || '').trim(), kind };
    if (kind !== 'open' && outcome) stage.outcome = outcome;
    rows.push(stage);
  }
  return rows;
}
// The cycles panel draws the section and its heading; this is the form.
function rcPipeStagesSettingsHtml(cycle) {
  const settings = rcPipeSettings(cycle);
  return `<form data-action="recruit-settings-pipeline">
      <div data-rc-stages>${rcPipeStageRowsHtml(cycle)}</div>
      <div class="rc-stage rc-stage--new"><input class="text-input" data-m="recruit-stage-new" placeholder="New stage" maxlength="40" aria-label="New stage name" autocomplete="off"><button type="button" class="btn btn--sm" data-action="recruit-stage-add">Add stage</button></div>
      <label class="check"><input type="checkbox" name="reviewersMayMove" ${settings.reviewersMayMove ? 'checked' : ''}> Reviewers may move people between open stages</label>
      <p class="field-error" data-rc-error role="alert" hidden></p>
      <div class="admin-form__actions"><button class="btn btn--primary" type="submit">Save stages</button></div>
    </form>`;
}
function rcPipePaintStageRows(form, focus) {
  const host = $('[data-rc-stages]', form);
  if (!host) return;
  host.innerHTML = rcPipeStageRowsHtml(rcPipeCycle());
  const target = focus ? $(`[data-action="${focus.action}"][data-key="${focus.key}"]`, host) : null;
  (target && !target.disabled ? target : $('[data-m="recruit-stage-new"]', form))?.focus({ preventScroll: true });
  if (form) form.dataset.adminDirty = 'true';
}
function rcPipeStageEdit(el, mutate) {
  const form = el.closest('form');
  if (!form) return;
  const st = rcPipeState();
  st.stageDraft = rcPipeReadStageRows(form);
  const focus = mutate(st.stageDraft);
  rcPipePaintStageRows(form, focus);
}
const rcPipeStageKey = (name, taken) => {
  let key = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  if (!/^[a-z]/.test(key)) key = ('s_' + key).slice(0, 24);
  let out = key, n = 2;
  while (taken.includes(out)) out = (key.slice(0, 21) + '_' + n++);
  return out;
};

/* -------------------------------- module -------------------------------- */

RECRUIT.register({
  name: 'pipeline',
  order: 30,
  query: rcPipeQuery,
  stageOptions: rcPipeStageOptions,
  columns: [
    { id: 'stage', label: 'Stage', sortKey: 'stage_at', cell: (app, cycle) => MD.esc(rcPipeStageName(cycle, app.stage)) },
  ],
  selectionActions(ids, cycle, role) {
    const lead = rcPipeLead(role);
    const items = [];
    if (lead || rcPipeSettings(cycle).reviewersMayMove) items.push({ id: 'recruit-move-open', action: 'recruit-move-open', label: 'Move to…', run: () => showModal({ kind: 'recruit-move', ids: [...ids] }) });
    if (lead) {
      items.push({ id: 'recruit-decide-open', action: 'recruit-decide-open', label: 'Decide…', run: () => showModal({ kind: 'recruit-decide', ids: [...ids] }) });
      items.push({ id: 'recruit-tag-open', action: 'recruit-tag-open', label: 'Tag…', run: () => showModal({ kind: 'recruit-tag', ids: [...ids] }) });
    }
    return items;
  },
  detailSections(app, cycle, role) {
    const stage = rcPipeStages(cycle).find((s) => s.key === app.stage);
    const closed = stage && stage.kind !== 'open';
    const d = app.decision || {};
    const showReason = rcPipeLead(role) || closed;
    const body = d.outcome
      ? `<p>${MD.esc(rcPipeStageName(cycle, rcPipeStages(cycle).find((s) => s.outcome === d.outcome)?.key) || d.outcome)}${d.subteam ? ` · ${MD.esc((cycle?.doc?.subteams || []).find((s) => s.key === d.subteam)?.name || d.subteam)}` : ''}${d.at ? ` · ${recruitDate(d.at)}` : ''}</p>${showReason && d.reason ? `<p class="faint">${MD.esc(d.reason)}</p>` : ''}`
      : '<p class="faint">No decision yet.</p>';
    return [{ id: 'decision', title: 'Decision', html: body }];
  },
  settings: {
    id: 'pipeline',
    label: 'Stages',
    view: (cycle) => rcPipeStagesSettingsHtml(cycle),
    async submit(form, cycle) {
      const stages = rcPipeReadStageRows(form);
      if (stages.some((s) => !s.name)) throw new Error('Every stage needs a name');
      const reviewersMayMove = Boolean(form.elements?.reviewersMayMove?.checked);
      await rcPipeSaveSettings(cycle, { stages, reviewersMayMove });
      rcPipeState().stageDraft = null;
    },
  },
  actions: {
    'recruit-move-open': (el) => { const ids = el.dataset.id ? [el.dataset.id] : rcPipeSelectedIds(); if (ids.length) showModal({ kind: 'recruit-move', ids, to: el.dataset.stage || '' }); },
    'recruit-decide-open': (el) => { const ids = el.dataset.id ? [el.dataset.id] : rcPipeSelectedIds(); if (ids.length) showModal({ kind: 'recruit-decide', ids }); },
    'recruit-tag-open': (el) => { const ids = el.dataset.id ? [el.dataset.id] : rcPipeSelectedIds(); if (ids.length) showModal({ kind: 'recruit-tag', ids }); },
    'recruit-move-go': () => { if (UI.modal?.kind === 'recruit-move') rcPipeMove(UI.modal); },
    'recruit-decide-go': () => { if (UI.modal?.kind === 'recruit-decide') rcPipeDecide(UI.modal); },
    'recruit-tag-go': () => { if (UI.modal?.kind === 'recruit-tag') rcPipeTag(UI.modal); },
    'recruit-view-save-open': () => showModal({ kind: 'recruit-view' }),
    'recruit-view-go': () => { if (UI.modal?.kind === 'recruit-view') rcPipeSaveView(UI.modal); },
    'recruit-view-apply': (el) => { const view = rcPipeSettings(rcPipeCycle()).views.find((v) => v.key === el.dataset.key); if (view) closeModal(() => rcPipeApplyView(view)); },
    'recruit-view-delete': (el) => rcPipeDeleteView(el.dataset.key),
    'recruit-stage-add': (el) => {
      const form = el.closest('form');
      const input = form && $('[data-m="recruit-stage-new"]', form);
      const name = (input?.value || '').trim();
      if (!name) { input?.focus(); return; }
      rcPipeStageEdit(el, (rows) => { const key = rcPipeStageKey(name, rows.map((r) => r.key)); rows.push({ key, name, kind: 'open' }); return { action: 'recruit-stage-remove', key }; });
      if (input) input.value = '';
    },
    'recruit-stage-remove': (el) => rcPipeStageEdit(el, (rows) => { const i = rows.findIndex((r) => r.key === el.dataset.key); if (i > 0) rows.splice(i, 1); return { action: 'recruit-stage-remove', key: rows[Math.min(i, rows.length - 1)]?.key }; }),
    'recruit-stage-up': (el) => rcPipeStageEdit(el, (rows) => { const i = rows.findIndex((r) => r.key === el.dataset.key); if (i > 0) [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; return { action: 'recruit-stage-up', key: el.dataset.key }; }),
    'recruit-stage-down': (el) => rcPipeStageEdit(el, (rows) => { const i = rows.findIndex((r) => r.key === el.dataset.key); if (i >= 0 && i < rows.length - 1) [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; return { action: 'recruit-stage-down', key: el.dataset.key }; }),
  },
  inputs: {},
  dd: {
    // Computed menu: saved views plus the save/manage entries.
    'recruit-view': (host, value) => (value === undefined ? rcPipeViewMenu() : undefined),
  },
  modals: {
    'recruit-move': rcPipeMoveModal,
    'recruit-decide': rcPipeDecideModal,
    'recruit-tag': rcPipeTagModal,
    'recruit-view': rcPipeViewModal,
    'recruit-views': rcPipeViewsModal,
  },
  reset() { const st = rcPipeState(); st.stageDraft = null; },
});

// recruit:pipeline:end
