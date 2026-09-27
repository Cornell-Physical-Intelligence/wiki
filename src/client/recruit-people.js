/* ============================================================================
   Applications — people module (client). Everyone in the cycle, as a table
   (where each person stands, their progress through every stage, their flag
   and thread) or as a board (a column per stage; leads drag people between
   columns). Filters, sorting and moves for a whole selection.
   ========================================================================== */

'use strict';

// recruit:people:start

const RECRUIT_PEOPLE_SORTS = [{ value: 'last', label: 'Latest activity' }, { value: 'name', label: 'Name' }, { value: 'stage', label: 'Stage' }];
const RECRUIT_FILTER_KEYS = ['stage', 'status', 'review', 'section', 'subteam', 'year'];
const RECRUIT_VIEW_KEY = 'cupi-recruit-people-view';

function recruitPeopleState(cycle = recruitCycleRow()) {
  const st = recruitState();
  const id = `${st.key}:${cycle?.id}`;
  if (st.people?.id !== id) {
    let view = 'table';
    try { view = localStorage.getItem(RECRUIT_VIEW_KEY) === 'board' ? 'board' : 'table'; } catch { /* a remembered view is a nicety */ }
    st.people = { id, rows: [], byEmail: {}, next: null, total: 0, counts: null, loading: false, loaded: false, error: null, q: '', filters: {}, sort: 'last', view, selected: new Set(), appliedParams: '' };
  }
  return st.people;
}

// Links from the chart and the numbers above it arrive with a filter.
function recruitApplyRouteFilters(p) {
  const params = UI.route?.params || {};
  const given = Object.fromEntries(RECRUIT_FILTER_KEYS.filter((k) => params[k]).map((k) => [k, params[k]]));
  const sig = JSON.stringify(given);
  if (!Object.keys(given).length || p.appliedParams === sig) return false;
  p.appliedParams = sig;
  p.filters = given;
  p.selected = new Set();
  return true;
}

function recruitPeopleParams(p, { csv = false } = {}) {
  const params = new URLSearchParams();
  if (p.q.trim()) params.set('q', p.q.trim());
  const f = p.filters;
  if (f.stage) params.set('stage', f.stage);
  if (f.status) params.set('status', f.status);
  if (f.review === 'flagged') params.set('flagged', '1');
  if (f.review === 'comments') params.set('comments', '1');
  if (f.section) params.set('section', f.section);
  if (f.subteam) params.set('subteam', f.subteam);
  if (f.year) params.set('year', f.year);
  params.set('sort', p.sort);
  if (csv) params.set('columns', 'full');
  return params;
}

let recruitPeopleSeq = 0;
async function recruitLoadPeople({ more = false, quiet = false } = {}) {
  const st = recruitState(), cycle = recruitCycleRow();
  if (!cycle) return;
  const p = recruitPeopleState(cycle);
  if (more && (!p.next || p.loading)) return;
  const params = recruitPeopleParams(p);
  params.set('limit', '100');
  if (more) params.set('cursor', p.next);
  const seq = ++recruitPeopleSeq;
  p.loading = true; p.error = null;
  if (!quiet && !more) recruitPaintPeople();
  const key = st.key;
  try {
    let out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/people?${params}`);
    // A quiet refresh keeps as many rows as the reader had loaded.
    if (quiet && !more) {
      while (out.next && out.rows.length < p.rows.length && seq === recruitPeopleSeq) {
        params.set('cursor', out.next);
        const page = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/people?${params}`);
        out = { ...page, rows: [...out.rows, ...page.rows] };
      }
    }
    if (st.key !== key || seq !== recruitPeopleSeq || st.people !== p) return;
    const rows = Array.isArray(out.rows) ? out.rows : [];
    p.rows = more ? p.rows.concat(rows) : rows;
    p.byEmail = Object.fromEntries(p.rows.map((r) => [r.email, r]));
    p.next = out.next || null;
    p.total = Number(out.total ?? p.rows.length);
    p.counts = out.counts || p.counts;
    p.loaded = true;
    for (const e of [...p.selected]) if (!p.byEmail[e]) p.selected.delete(e);
  } catch (e) {
    if (st.key !== key || seq !== recruitPeopleSeq || st.people !== p) return;
    p.error = recruitError(e);
  }
  p.loading = false;
  if (!recruitPaintPeople()) renderBackground('recruit');
}

/* ------------------------------- toolbar --------------------------------- */

function recruitFilterChoices(cycle, p) {
  const flow = recruitFlow(cycle);
  const teams = [...new Set([...recruitSubteams(cycle).map((t) => t.name), ...p.rows.map((r) => r.subteam).filter(Boolean)])];
  const years = [...new Set(p.rows.map((r) => r.year).filter(Boolean))].sort();
  return {
    stage: { label: 'Stage', options: flow.keys.map((k) => ({ value: k, label: recruitSectionTitle(k, cycle) })) },
    status: { label: 'Status', options: RECRUIT_STATUSES },
    review: { label: 'Review', options: [{ value: 'flagged', label: 'Flagged' }, { value: 'comments', label: 'Has comments' }] },
    section: { label: 'Sent a form', options: flow.keys.filter((k) => flow.sections[k].form).map((k) => ({ value: k, label: recruitSectionTitle(k, cycle) })) },
    subteam: { label: 'Subteam', options: [...teams.map((t) => ({ value: t, label: t })), { value: 'none', label: 'Undecided' }] },
    year: { label: 'Year', options: [...years.map((y) => ({ value: y, label: y })), { value: 'none', label: 'Not given' }] },
  };
}

// Filters come in groups; the menu lists the groups with what each is set
// to, and a group opens its own choices in the same place.
function recruitFilterMenu(host) {
  const cycle = recruitCycleRow();
  const p = recruitPeopleState(cycle);
  const choices = recruitFilterChoices(cycle, p);
  return Object.entries(choices).filter(([, c]) => c.options.length).map(([group, c]) => {
    const current = c.options.find((o) => o.value === p.filters[group])?.label || '';
    return {
      label: c.label, hint: current ? MD.esc(current) : '', icon: current ? I.check : '<span style="width:14px;flex:none"></span>',
      run: () => setTimeout(() => openMenu([
        recruitMenuItem(`Any ${c.label.toLowerCase()}`, !p.filters[group], () => recruitSetPeopleFilter(group, '')), '-',
        ...c.options.map((o) => recruitMenuItem(o.label, p.filters[group] === o.value, () => recruitSetPeopleFilter(group, o.value))),
      ], host), 0),
    };
  });
}

function recruitSetPeopleFilter(group, value) {
  const p = recruitPeopleState();
  if (value) p.filters = { ...p.filters, [group]: value }; else { const { [group]: _, ...rest } = p.filters; p.filters = rest; }
  p.selected = new Set();
  const bar = $('[data-rc="people-filters"]');
  if (bar) recruitRepaint(bar, recruitPeopleFilterChipsHtml(recruitCycleRow(), p));
  if (p.view === 'board') recruitLoadBoard(); else recruitLoadPeople();
}

function recruitPeopleFilterChipsHtml(cycle, p) {
  const choices = recruitFilterChoices(cycle, p);
  const chips = Object.entries(p.filters).filter(([, v]) => v).map(([group, v]) => {
    const label = choices[group]?.options.find((o) => o.value === v)?.label || v;
    return `<button type="button" class="rc-chip rc-chip--on" data-action="recruit-people-unfilter" data-group="${MD.esc(group)}" aria-label="Remove the filter ${MD.esc(choices[group]?.label || group)}: ${MD.esc(label)}"><span class="rc-chip__group">${MD.esc(choices[group]?.label || group)}</span>${MD.esc(label)}${I.x}</button>`;
  });
  return chips.length ? `${chips.join('')}<button type="button" class="linklike" data-action="recruit-people-unfilter-all">Clear</button>` : '';
}

function recruitPeopleToolbarHtml(cycle, p) {
  const lead = recruitCanEdit(cycle);
  const view = `<div class="rc-seg rc-seg--view" role="group" aria-label="View"><span class="rc-seg__thumb" aria-hidden="true"></span><button type="button" data-action="recruit-people-view" data-view="table" aria-pressed="${p.view === 'table'}">${RC_ICONS.table}<span>Table</span></button><button type="button" data-action="recruit-people-view" data-view="board" aria-pressed="${p.view === 'board'}">${RC_ICONS.board}<span>Board</span></button></div>`;
  const csv = `/api/recruit/cycles/${encodeURIComponent(cycle.id)}/people.csv?${recruitPeopleParams(p, { csv: true })}`;
  return `<div class="rp-bar">
    <div class="sheet__search-wrap">${I.search}<input class="text-input sheet__search" data-m="recruit-people-q" type="search" placeholder="Search people…" value="${MD.esc(p.q)}" aria-label="Search by name or email" autocomplete="off" spellcheck="false"></div>
    <button type="button" class="btn" data-action="dd" data-m="recruit-people-filter" data-value="" data-opts="[]" aria-haspopup="menu">${RC_ICONS.filter}<span class="dd__label">Filter</span></button>
    ${p.view === 'table' ? recruitDd('recruit-people-sort', RECRUIT_PEOPLE_SORTS, p.sort, 'aria-label="Sort"') : ''}
    ${view}
    ${lead ? `<a class="btn" data-rc="people-export" href="${MD.esc(csv)}" download title="Everyone matching these filters, with where they stand and every checklist field">${RC_ICONS.download}<span>Export</span></a>` : ''}
  </div>
  <div class="rc-chips rc-chips--filters" data-rc="people-filters">${recruitPeopleFilterChipsHtml(cycle, p)}</div>`;
}

/* ------------------------------- table ----------------------------------- */

function recruitPeopleRowHtml(cycle, r, p, flow) {
  const picked = p.selected.has(r.email);
  const s = flow.sections[r.stage];
  return `<tr data-email="${MD.esc(r.email)}" class="${picked ? 'is-selected' : ''}">
    ${recruitCanEdit(cycle) ? `<td class="sheet__check-cell" data-col="check"><label class="sheet__check"><input type="checkbox" data-action="recruit-people-select" data-email="${MD.esc(r.email)}" aria-label="Select ${MD.esc(r.name)}" ${picked ? 'checked' : ''}></label></td>` : ''}
    <td data-col="person"><a class="rc-person-link" href="${recruitPersonHref(r.email)}" data-action="recruit-person-go" data-email="${MD.esc(r.email)}" data-list="people"><b>${MD.esc(r.name)}</b><span class="mail" title="${MD.esc(r.email)}">${MD.esc(r.email)}</span></a><span class="rc-mobile-meta">${MD.esc([s?.title, recruitStatusLabel(r.status), r.subteam].filter(Boolean).join(' · '))}</span></td>
    <td data-col="status">${recruitStatusPill(r.status)}</td>
    <td data-col="stage">${s ? `<a class="rc-stage-chip" href="${recruitStageHref(r.stage)}">${recruitKindIcon(s.kind)}${MD.esc(s.title)}</a>` : '<span class="faint">—</span>'}</td>
    <td data-col="progress">${recruitTrackHtml(r, flow)}</td>
    ${recruitPersonReviewCellHtml(r)}
    <td data-col="subteam"${r.subteam ? ` title="${MD.esc(r.subteam)}"` : ''}>${r.subteam ? MD.esc(r.subteam) : '<span class="faint">Undecided</span>'}</td>
    <td data-col="year">${r.year ? MD.esc(r.year) : '<span class="faint">—</span>'}</td>
    <td class="interest-when" data-col="last" title="${MD.esc(new Date(Number(r.last)).toLocaleString())}">${MD.esc(recruitAgo(Number(r.last)))}</td>
  </tr>`;
}

function recruitPeopleRowsHtml(cycle, p) {
  const flow = recruitFlow(cycle);
  const span = 9;
  if (!p.loaded && (p.loading || !p.error)) return `<tr class="sheet__empty"><td colspan="${span}">Loading…</td></tr>`;
  if (p.error && !p.rows.length) return `<tr class="sheet__empty"><td colspan="${span}">Could not load: ${MD.esc(p.error)}. <button class="linklike" data-action="recruit-people-refresh">Retry</button></td></tr>`;
  if (!p.rows.length) return `<tr class="sheet__empty"><td colspan="${span}">${p.q.trim() || Object.keys(p.filters).length ? 'No one matches these filters.' : 'No one yet. People appear here when they send a form.'}</td></tr>`;
  return p.rows.map((r) => recruitPeopleRowHtml(cycle, r, p, flow)).join('');
}

function recruitPeopleTableHtml(cycle, p) {
  const lead = recruitCanEdit(cycle);
  const th = (id, label) => `<th data-col="${id}"><span class="sheet__sort sheet__sort--static">${MD.esc(label)}</span></th>`;
  const all = p.rows.length && p.rows.every((r) => p.selected.has(r.email));
  return `<div class="sheet sheet--recruit sheet--people">
    <div class="sheet__bar rp-bulk" data-rc="people-bulk" ${p.selected.size ? '' : 'hidden'}>${recruitPeopleBulkHtml(p)}</div>
    <div class="sheet__scroll"><table aria-label="People in ${MD.esc(cycle.name)}">
      <thead><tr>${lead ? `<th class="sheet__check-cell" data-col="check"><label class="sheet__check"><input type="checkbox" data-action="recruit-people-select-all" aria-label="Select everyone listed" ${all ? 'checked' : ''} ${p.rows.length ? '' : 'disabled'}></label></th>` : ''}${th('person', 'Person')}${th('status', 'Status')}${th('stage', 'Stage')}${th('progress', 'Progress')}${th('review', 'Review')}${th('subteam', 'Subteam')}${th('year', 'Year')}${th('last', 'Latest')}</tr></thead>
      <tbody data-rc="people-rows">${recruitPeopleRowsHtml(cycle, p)}</tbody>
    </table></div>
    <div class="sheet__foot" role="status" data-rc="people-foot">${recruitPeopleFootHtml(p)}</div>
  </div>`;
}

function recruitPeopleBulkHtml(p) {
  if (!p.selected.size) return '';
  return `<span class="rc-bulk__count" role="status">${recruitNum(p.selected.size)} selected</span>
    <button class="btn" data-action="recruit-bulk-move" data-list="people" aria-haspopup="menu">Move to…</button>
    <button class="btn" data-action="recruit-bulk-status" data-list="people" aria-haspopup="menu">Set status…</button>
    <button class="btn" data-action="recruit-bulk-copy" data-list="people">${I.copy} Copy emails</button>
    <button class="icon-btn" data-action="recruit-people-clear" aria-label="Clear selection" title="Clear selection">${I.x}</button>`;
}

function recruitPeopleFootHtml(p) {
  if (p.loading && p.loaded) return 'Loading…';
  if (!p.loaded) return '';
  const shown = p.rows.length === p.total ? recruitPlural(p.total, 'person', 'people') : `${recruitNum(p.rows.length)} of ${recruitPlural(p.total, 'person', 'people')}`;
  return `${MD.esc(shown)}${p.next ? ' · <button class="linklike" data-action="recruit-people-more">Load more</button>' : ''}`;
}

function recruitPaintPeople() {
  const cycle = recruitCycleRow();
  const p = recruitState().people;
  if (!cycle || !p) return false;
  if (p.view === 'board') return recruitPaintBoard();
  const body = $('[data-rc="people-rows"]');
  if (!body) return false;
  recruitRepaint(body, recruitPeopleRowsHtml(cycle, p));
  const foot = $('[data-rc="people-foot"]');
  if (foot) foot.innerHTML = recruitPeopleFootHtml(p);
  recruitPaintPeopleSelection();
  const exporter = $('[data-rc="people-export"]');
  if (exporter) exporter.setAttribute('href', `/api/recruit/cycles/${encodeURIComponent(cycle.id)}/people.csv?${recruitPeopleParams(p, { csv: true })}`);
  return true;
}

function recruitPaintPeopleSelection() {
  const p = recruitState().people;
  if (!p) return;
  const bar = $('[data-rc="people-bulk"]');
  if (bar) { recruitRepaint(bar, recruitPeopleBulkHtml(p)); bar.hidden = !p.selected.size; }
  for (const input of $$('[data-action="recruit-people-select"]')) { input.checked = p.selected.has(input.dataset.email); input.closest('tr')?.classList.toggle('is-selected', input.checked); }
  const all = $('[data-action="recruit-people-select-all"]');
  if (all) { all.checked = p.rows.length > 0 && p.rows.every((r) => p.selected.has(r.email)); all.indeterminate = p.selected.size > 0 && !all.checked; }
}

function recruitPaintPeoplePerson(email) {
  const cycle = recruitCycleRow();
  const p = recruitState().people;
  if (!cycle || !p) return;
  if (p.view === 'board') { recruitPaintBoard(); return; }
  const r = p.byEmail[email];
  const tr = $$('[data-rc="people-rows"] tr[data-email]').find((el) => el.dataset.email === email);
  if (!r || !tr) return;
  const holder = document.createElement('tbody');
  holder.innerHTML = recruitPeopleRowHtml(cycle, r, p, recruitFlow(cycle));
  const fresh = holder.firstElementChild || holder.children?.[0];
  if (fresh) for (const cell of $$('td[data-col]', fresh)) { const old = $(`td[data-col="${cell.dataset.col}"]`, tr); if (old && old.innerHTML !== cell.innerHTML && !old.contains(document.activeElement)) old.innerHTML = cell.innerHTML; }
}

/* ------------------------------- board ----------------------------------- */

const RECRUIT_BOARD_MAX = 2000;

function recruitBoardState(cycle = recruitCycleRow()) {
  const st = recruitState();
  const p = recruitPeopleState(cycle);
  const sig = JSON.stringify([p.filters, p.q]);
  if (st.board?.id !== p.id || st.board.sig !== sig) st.board = { id: p.id, sig, rows: [], loading: false, loaded: false, error: null, truncated: false };
  return st.board;
}

// The board shows everyone who matches, a column per stage. Status defaults
// to active: the people still moving.
async function recruitLoadBoard() {
  const st = recruitState(), cycle = recruitCycleRow();
  if (!cycle) return;
  const p = recruitPeopleState(cycle);
  const b = recruitBoardState(cycle);
  const params = recruitPeopleParams({ ...p, sort: 'name', filters: { status: 'active', ...p.filters } });
  params.set('limit', '200');
  b.loading = true; b.error = null;
  const key = st.key;
  const seq = b.seq = (b.seq || 0) + 1;
  if (!b.loaded) recruitPaintBoard();
  try {
    const rows = [];
    let cursor = null;
    do {
      if (cursor) params.set('cursor', cursor);
      const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/people?${params}`);
      rows.push(...(out.rows || []));
      cursor = out.next || null;
    } while (cursor && rows.length < RECRUIT_BOARD_MAX);
    if (st.key !== key || st.board !== b || seq !== b.seq) return;
    b.rows = rows; b.truncated = Boolean(cursor); b.loaded = true;
  } catch (e) {
    if (st.key !== key || st.board !== b || seq !== b.seq) return;
    b.error = recruitError(e);
  }
  b.loading = false;
  if (!recruitPaintBoard()) renderBackground('recruit');
}

function recruitBoardCardHtml(r, cycle) {
  const lead = recruitCanEdit(cycle);
  const done = r.stage && r.done?.[r.stage];
  return `<li class="pb-card ${done ? 'is-done' : ''}" data-email="${MD.esc(r.email)}" data-stage="${MD.esc(r.stage || '')}">
    <a class="pb-card__main" href="${recruitPersonHref(r.email)}" data-action="recruit-person-go" data-email="${MD.esc(r.email)}" data-list="board" draggable="false">
      <span class="pb-card__name">${MD.esc(r.name)}</span>
      <span class="pb-card__mail">${MD.esc(r.email)}</span>
      <span class="pb-card__meta">${r.status !== 'active' ? recruitStatusPill(r.status) : ''}${r.subteam ? `<span>${MD.esc(r.subteam)}</span>` : ''}${r.year ? `<span>${MD.esc(r.year)}</span>` : ''}${done ? `<span class="pb-card__done">${I.check}Done</span>` : ''}${r.flagged ? `<span class="pb-card__flag" title="Flagged">${RC_ICONS.flag}</span>` : ''}${r.comments ? `<span class="pb-card__comments" title="${recruitPlural(r.comments, 'comment')}">${RC_ICONS.comment}${r.comments}</span>` : ''}</span>
    </a>
    ${lead ? `<button type="button" class="icon-btn pb-card__more" data-action="recruit-board-card" data-email="${MD.esc(r.email)}" aria-label="Move ${MD.esc(r.name)}" aria-haspopup="menu" title="Move">${I.dots}</button>` : ''}
  </li>`;
}

function recruitBoardHtml(cycle) {
  const b = recruitBoardState(cycle);
  const flow = recruitFlow(cycle);
  if (!b.loaded && !b.error) return '<p class="sheet__note">Loading…</p>';
  if (b.error && !b.loaded) return `<p class="sheet__note">Could not load: ${MD.esc(b.error)}. <button class="linklike" data-action="recruit-people-refresh">Retry</button></p>`;
  const by = new Map(flow.keys.map((k) => [k, []]));
  for (const r of b.rows) if (by.has(r.stage)) by.get(r.stage).push(r);
  const status = recruitPeopleState(cycle).filters.status || 'active';
  return `${b.truncated ? `<p class="sheet__note">Showing the first ${recruitNum(RECRUIT_BOARD_MAX)}; filter to see the rest.</p>` : ''}
    <div class="pb" data-rc="board" aria-label="People by stage, ${MD.esc(recruitStatusLabel(status).toLowerCase())}">${flow.keys.map((k) => {
      const s = flow.sections[k];
      const cards = by.get(k);
      return `<section class="pb-col" data-stage="${MD.esc(k)}" aria-labelledby="pb-col-${MD.esc(k)}">
        <header class="pb-col__head"><span class="pb-col__icon">${recruitKindIcon(s.kind)}</span><a id="pb-col-${MD.esc(k)}" href="${recruitStageHref(k)}">${MD.esc(s.title)}</a><span class="count">${recruitNum(cards.length)}</span></header>
        <ol class="pb-col__cards">${cards.length ? cards.map((r) => recruitBoardCardHtml(r, cycle)).join('') : '<li class="pb-col__empty">No one</li>'}</ol>
      </section>`;
    }).join('')}</div>`;
}

function recruitPaintBoard() {
  const host = $('[data-rc="people-body"]');
  const cycle = recruitCycleRow();
  if (!host || !cycle || recruitState().people?.view !== 'board') return false;
  const scroll = $('[data-rc="board"]', host)?.scrollLeft || 0;
  recruitRepaint(host, recruitBoardHtml(cycle));
  const board = $('[data-rc="board"]', host);
  if (board) board.scrollLeft = scroll;
  return true;
}

// Dragging a card to another column moves the person there.
function recruitBoardDragStart(ev, card) {
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  if (!recruitCanEdit() || ev.target.closest?.('.pb-card__more')) return;
  const board = card.closest('[data-rc="board"]');
  if (!board || typeof card.getBoundingClientRect !== 'function') return;
  const startX = ev.clientX, startY = ev.clientY;
  const from = card.dataset.stage;
  let ghost = null, target = null, moved = false;
  const move = (e) => {
    if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
    if (!moved) {
      moved = true;
      const r = card.getBoundingClientRect();
      ghost = card.cloneNode(true);
      ghost.classList.add('pb-card--ghost');
      Object.assign(ghost.style, { width: `${r.width}px`, left: `${r.left}px`, top: `${r.top}px` });
      document.body.appendChild(ghost);
      card.classList.add('is-lifted');
      board.classList.add('is-dragging');
    }
    e.preventDefault();
    ghost.style.transform = `translate(${e.clientX - startX}px, ${e.clientY - startY}px) rotate(1.5deg)`;
    const col = document.elementFromPoint?.(e.clientX, e.clientY)?.closest?.('.pb-col');
    const key = col?.dataset.stage || null;
    if (key !== target) { $('.pb-col.is-target', board)?.classList.remove('is-target'); target = key && key !== from ? key : null; if (target) col.classList.add('is-target'); }
  };
  const end = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', end);
    document.removeEventListener('pointercancel', end);
    if (!moved) return;
    ghost?.remove();
    card.classList.remove('is-lifted');
    board.classList.remove('is-dragging');
    $('.pb-col.is-target', board)?.classList.remove('is-target');
    // The click that ends a drag must not open the person.
    const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
    card.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => card.removeEventListener('click', swallow, { capture: true }), 0);
    if (target) recruitMovePerson(card.dataset.email, { stage: target });
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('pointerdown', (ev) => {
    const card = typeof ev.target?.closest === 'function' ? ev.target.closest('[data-rc="board"] .pb-card') : null;
    if (card) recruitBoardDragStart(ev, card);
  });
}

/* ------------------------------- the view -------------------------------- */

function recruitPeopleView(cycle) {
  const p = recruitPeopleState(cycle);
  recruitApplyRouteFilters(p);
  const c = p.counts;
  const line = c ? [recruitPlural(c.people || 0, 'person', 'people'), ...RECRUIT_STATUSES.filter((s) => c.byStatus?.[s.value]).map((s) => `${recruitNum(c.byStatus[s.value])} ${s.label.toLowerCase()}`)].join(' · ') : '';
  return `<div class="rp">
    ${recruitPeopleToolbarHtml(cycle, p)}
    <p class="rp-counts" data-rc="people-counts">${MD.esc(line)}</p>
    <div data-rc="people-body">${p.view === 'board' ? recruitBoardHtml(cycle) : recruitPeopleTableHtml(cycle, p)}</div>
  </div>`;
}

let recruitPeopleSearchTimer = null;

RECRUIT.register({
  name: 'people',
  order: 3,
  kernel: true,
  panels: [{ id: 'people', label: 'People', icon: RC_ICONS.people, order: 2, when: () => true }],
  view: (cycle) => recruitPeopleView(cycle),
  wide: () => recruitState().people?.view === 'board',
  mount(cycle) {
    const p = recruitPeopleState(cycle);
    const changed = recruitApplyRouteFilters(p);
    recruitSegSlide($('.rc-seg--view'));
    if (p.view === 'board') { const b = recruitBoardState(cycle); if (!b.loaded && !b.loading) recruitLoadBoard(); }
    else if ((!p.loaded && !p.loading) || changed) recruitLoadPeople();
  },
  refresh: { load: () => { const p = recruitState().people; if (!p) return null; return p.view === 'board' ? recruitLoadBoard() : p.selected.size ? null : recruitLoadPeople({ quiet: true }); }, every: RECRUIT_SYNC_MS },
  personChanged: (email) => recruitPaintPeoplePerson(email),
  peopleMoved() { const p = recruitState().people; if (!p) return; p.selected = new Set(); if (UI.route?.params?.sub === 'people') { if (p.view === 'board') recruitLoadBoard(); else recruitLoadPeople({ quiet: true }); } else { p.loaded = false; if (recruitState().board) recruitState().board.loaded = false; } const sp = recruitState().stagePeople; if (sp) { sp.selected = new Set(); recruitLoadStagePeople(); } },
  cycleChanged() { const p = recruitState().people; if (p) p.loaded = false; },
  actions: {
    'recruit-people-more': () => recruitLoadPeople({ more: true }),
    'recruit-people-refresh': () => { const p = recruitState().people; if (p?.view === 'board') recruitLoadBoard(); else recruitLoadPeople(); },
    'recruit-people-view': (el) => {
      const p = recruitPeopleState();
      const view = el.dataset.view === 'board' ? 'board' : 'table';
      if (p.view === view) return;
      p.view = view;
      try { localStorage.setItem(RECRUIT_VIEW_KEY, view); } catch { /* a remembered view is a nicety */ }
      renderBackground('recruit');
    },
    'recruit-people-select': (el) => { const p = recruitPeopleState(); if (el.checked) p.selected.add(el.dataset.email); else p.selected.delete(el.dataset.email); recruitPaintPeopleSelection(); },
    'recruit-people-select-all': (el) => { const p = recruitPeopleState(); p.selected = el.checked ? new Set(p.rows.map((r) => r.email)) : new Set(); recruitPaintPeopleSelection(); },
    'recruit-people-clear': () => { const p = recruitPeopleState(); p.selected = new Set(); recruitPaintPeopleSelection(); },
    'recruit-people-unfilter': (el) => recruitSetPeopleFilter(el.dataset.group, ''),
    'recruit-people-unfilter-all': () => { const p = recruitPeopleState(); p.filters = {}; p.selected = new Set(); p.appliedParams = ''; const bar = $('[data-rc="people-filters"]'); if (bar) bar.innerHTML = ''; if (p.view === 'board') recruitLoadBoard(); else recruitLoadPeople(); },
    'recruit-board-card': (el) => { const r = recruitState().board?.rows.find((x) => x.email === el.dataset.email); recruitMoveMenu(el, [el.dataset.email], r?.stage); },
  },
  inputs: {
    'recruit-people-q': (el) => {
      const p = recruitPeopleState();
      p.q = el.value;
      clearTimeout(recruitPeopleSearchTimer);
      recruitPeopleSearchTimer = setTimeout(() => (p.view === 'board' ? recruitLoadBoard() : recruitLoadPeople()), 220);
    },
  },
  dd: {
    'recruit-people-filter': (host, value) => (value === undefined ? recruitFilterMenu(host) : undefined),
    'recruit-people-sort': (host, value) => { if (value === undefined) return undefined; const p = recruitPeopleState(); p.sort = value; recruitLoadPeople(); },
  },
  reset() { const st = recruitState(); st.people = undefined; st.board = undefined; clearTimeout(recruitPeopleSearchTimer); },
});

// recruit:people:end
