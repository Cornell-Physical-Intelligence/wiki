/* ============================================================================
   Applications — applications module (client). The Applications panel for a
   cycle: stage strip, sheet (server-side search, filters, sort, keyset
   paging), selection toolbar, the application dialog (answers, files, tags,
   decision, module sections, comments, activity), the saved-submission
   queue, and Add / Import / Copy.
   ========================================================================== */

'use strict';

// recruit:applications:start

/* ------------------------------- filters --------------------------------- */

const RECRUIT_FILTER_DEFAULTS = { q: '', stage: '', subteam: '', year: '', tag: '', review: '', source: '', sort: 'ts', dir: 'desc' };

function recruitFilters(cycleId = recruitCycleRow()?.id) {
  const st = recruitState();
  return st.filters[cycleId] ||= { ...RECRUIT_FILTER_DEFAULTS };
}

// Every filter entry: group (one pick per group), value, label, and either a
// server query fragment or a client test on the loaded rows.
function recruitCoreFilters(cycle) {
  const st = recruitState();
  const rows = st.apps?.rows || [];
  const teams = recruitSubteams(cycle).map((t) => t.name).filter(Boolean);
  const rowTeams = [...new Set(rows.map((r) => String(r.subteam || '').trim()).filter((t) => t && !teams.includes(t)))].sort();
  const tags = [...new Set(rows.flatMap((r) => (Array.isArray(r.tags) ? r.tags : [])))].sort((a, b) => a.localeCompare(b));
  const sources = [...new Set(rows.map((r) => r.source).filter(Boolean))].sort();
  const sourceLabel = { form: 'Website form', apply: 'Website form', admin: 'Added by hand', import: 'Imported', migrated: 'Old list', orphan: 'Adopted' };
  return [
    { group: 'review', value: '', label: 'All people' },
    { group: 'review', value: 'flagged', label: 'Flagged', query: { flagged: 1 } },
    { group: 'review', value: 'comments', label: 'Has comments', test: (r) => (r.comments || 0) > 0 },
    { group: 'subteam', value: '', label: 'All subteams' },
    ...[...teams, ...rowTeams].map((name) => ({ group: 'subteam', value: name, label: name, query: { subteam: name } })),
    { group: 'subteam', value: '__undecided', label: 'Undecided', test: (r) => !String(r.subteam || '').trim() },
    { group: 'year', value: '', label: 'All years' },
    ...RECRUIT_YEARS.map((y) => ({ group: 'year', value: y, label: y, query: { year: y } })),
    ...(tags.length ? [{ group: 'tag', value: '', label: 'All tags' }, ...tags.map((t) => ({ group: 'tag', value: t, label: t, query: { tag: t } }))] : []),
    ...(sources.length > 1 ? [{ group: 'source', value: '', label: 'Any source' }, ...sources.map((s) => ({ group: 'source', value: s, label: sourceLabel[s] || s, test: (r) => r.source === s }))] : []),
  ];
}

const RECRUIT_FILTER_GROUPS = ['review', 'subteam', 'year', 'tag', 'source'];

function recruitFilterLabel(cycle = recruitCycleRow()) {
  const f = recruitFilters(cycle?.id);
  const entries = RECRUIT.filters(cycle, recruitRole());
  const groups = [...new Set([...RECRUIT_FILTER_GROUPS, ...entries.map((e) => e.group)])];
  const parts = groups.map((g) => {
    const v = f[g];
    if (!v) return '';
    if (g === 'subteam' && v === '__undecided') return 'Undecided';
    const e = entries.find((x) => x.group === g && x.value === v);
    return e ? e.label : String(v);
  }).filter(Boolean);
  return parts.join(' · ') || 'All people';
}

function recruitOpenFilter(host) {
  const cycle = recruitCycleRow();
  if (!cycle) return [];
  const f = recruitFilters(cycle.id);
  const entries = RECRUIT.filters(cycle, recruitRole());
  const groups = [...new Set(entries.map((e) => e.group))];
  const items = [];
  groups.forEach((g, i) => {
    if (i) items.push('-');
    for (const e of entries.filter((x) => x.group === g)) {
      const selected = (f[g] || '') === e.value;
      items.push({ label: e.label, selected, icon: selected ? I.check : '<span style="width:14px;flex:none"></span>', run: () => {
        f[g] = e.value;
        const label = host?.querySelector?.('.dd__label');
        if (label) label.textContent = recruitFilterLabel(cycle);
        recruitLoadApps();
      } });
    }
  });
  return items;
}

function recruitListParams(cycle, f, cursor) {
  const p = new URLSearchParams();
  if (f.q?.trim()) p.set('q', f.q.trim());
  if (f.stage) p.set('stage', f.stage);
  for (const e of RECRUIT.filters(cycle, recruitRole())) {
    if (e.query && (f[e.group] || '') === e.value && e.value !== '') for (const [k, v] of Object.entries(e.query)) p.set(k, String(v));
  }
  p.set('sort', f.sort || 'ts');
  p.set('dir', f.dir || 'desc');
  p.set('limit', '200');
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

// Client-side tests apply on top of what the server returned (a page).
function recruitVisibleRows(cycle = recruitCycleRow()) {
  const st = recruitState();
  const rows = st.apps?.rows || [];
  if (!cycle) return rows;
  const f = recruitFilters(cycle.id);
  const tests = RECRUIT.filters(cycle, recruitRole()).filter((e) => e.test && e.value !== '' && (f[e.group] || '') === e.value);
  return tests.length ? rows.filter((r) => tests.every((e) => e.test(r))) : rows;
}

/* ------------------------------- list loading ---------------------------- */

let recruitListSeq = 0;
let recruitSearchTimer = null;

async function recruitLoadApps(more = false) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  if (!cycle) return;
  const f = recruitFilters(cycle.id);
  const cursor = more ? st.apps?.next : null;
  if (more && (!st.apps || st.apps.loading || !cursor)) return;
  if (!more) st.apps = { key: st.key + ':' + cycle.id, rows: [], byId: {}, next: null, total: 0, counts: st.apps?.counts || null, loading: true, error: null };
  const apps = st.apps;
  apps.loading = true;
  apps.error = null;
  const seq = ++recruitListSeq;
  const key = st.key;
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/applications?${recruitListParams(cycle, f, cursor)}`);
    if (st.key !== key || st.apps !== apps || seq !== recruitListSeq) return;   // a later request or another cycle owns the sheet now
    const rows = Array.isArray(out.rows) ? out.rows : [];
    apps.rows = more ? apps.rows.concat(rows) : rows;
    apps.byId = Object.fromEntries(apps.rows.map((r) => [r.id, r]));
    apps.next = out.next || null;
    apps.total = Number(out.total ?? apps.rows.length);
    if (out.counts) { apps.counts = out.counts; if (st.cycle) st.cycle.counts = { ...(st.cycle.counts || {}), byStage: out.counts.byStage || st.cycle.counts?.byStage || {}, total: st.cycle.counts?.total ?? apps.total }; }
    apps.loading = false;
  } catch (e) {
    if (st.key !== key || st.apps !== apps || seq !== recruitListSeq) return;
    apps.loading = false;
    apps.error = recruitError(e);
  }
  if (!recruitPaintRows()) renderBackground('recruit');
}

// Cached rows accept a server row only when its edit version is not older;
// otherwise the row is fetched again so a stale answer never wins.
function recruitAcceptRow(row) {
  const st = recruitState();
  const apps = st.apps;
  if (!row?.id || !apps?.byId) return false;
  const cached = apps.byId[row.id];
  if (!cached) return false;
  const next = Number(row.editVersion ?? cached.editVersion ?? 0), cur = Number(cached.editVersion ?? 0);
  if (next < cur) { recruitRefetchRow(row.id); return false; }
  const merged = { ...cached, ...row };
  apps.byId[row.id] = merged;
  const i = apps.rows.findIndex((r) => r.id === row.id);
  if (i >= 0) apps.rows[i] = merged;
  return true;
}

function recruitRefetchRow(id) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  if (!cycle || st.busy.has('refetch:' + id)) return;
  st.busy.add('refetch:' + id);
  const key = st.key;
  RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/applications/${encodeURIComponent(id)}`)
    .then((out) => {
      if (st.key !== key) return;
      if (st.detail[id] && !st.detail[id].loading) st.detail[id] = recruitDetailData(out);
      const row = recruitRowFromApplication(out.application);
      if (row && st.apps?.byId?.[id]) { st.apps.byId[id] = { ...st.apps.byId[id], ...row }; const i = st.apps.rows.findIndex((r) => r.id === id); if (i >= 0) st.apps.rows[i] = st.apps.byId[id]; recruitPaintRow(id); }
    })
    .catch(() => {})
    .finally(() => st.busy.delete('refetch:' + id));
}

// A ListRow projected from a full application, for merges after a detail load.
function recruitRowFromApplication(a) {
  if (!a?.id) return null;
  const review = a.review || {};
  return {
    id: a.id, cycleId: a.cycleId, email: a.email, name: a.name, ts: a.ts, updated: a.updated, cornell: a.cornell, subteam: a.subteam, year: a.year, source: a.source,
    stage: a.stage, stageAt: a.stageAt, outcome: a.outcome, tags: a.tags || [], flagged: Boolean(review.flagged), comments: (review.comments || []).length,
    files: (a.files || []).map((f) => ({ id: f.id, name: f.name, size: f.size, type: f.type })),
    editVersion: a.editVersion, reviewVersion: a.reviewVersion,
  };
}

/* ------------------------------- selection ------------------------------- */

function recruitSelection() {
  const st = recruitState();
  const scope = recruitCycleRow()?.id || null;
  if (st.selectionScope !== scope) { st.selectionScope = scope; st.selected = new Set(); }
  const ids = new Set((st.apps?.rows || []).map((r) => r.id));
  for (const id of st.selected) if (!ids.has(id)) st.selected.delete(id);
  return st.selected;
}

function recruitSelectedEmails() {
  const selected = recruitSelection();
  return [...new Set((recruitState().apps?.rows || []).filter((r) => selected.has(r.id)).map((r) => String(r.email || '').trim()).filter(Boolean))];
}

const recruitEmailsCsv = (emails) => emails.map((e) => (/[",\r\n]/.test(e) ? '"' + e.replace(/"/g, '""') + '"' : e)).join(',');

function recruitSelectionBarHtml() {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const selected = recruitSelection();
  const ids = [...selected];
  const visible = recruitVisibleRows(cycle);
  const hidden = ids.filter((id) => !visible.some((r) => r.id === id)).length;
  const actions = cycle ? RECRUIT.selectionActions(ids, cycle, recruitRole()) : [];
  return `<span data-rc-selection-count role="status">${ids.length} selected${hidden ? ` · ${hidden} hidden by filter` : ''}</span>
    ${actions.map((a) => `<button class="btn btn--sm ${a.danger ? 'btn--danger' : ''}" data-action="recruit-selection-act" data-sel="${MD.esc(a.id)}" ${a.disabled ? 'disabled' : ''}>${a.icon || ''}${MD.esc(a.label)}</button>`).join('')}
    <button class="btn btn--sm" data-action="recruit-copy-emails">${I.copy} Copy emails</button>
    ${recruitCan('admin') && cycle?.status !== 'archived' ? `<button class="btn btn--sm btn--danger" data-action="recruit-remove-selected">${I.trash} Delete</button>` : ''}
    <button class="icon-btn" data-action="recruit-clear-selection" aria-label="Clear selection" title="Clear selection">${I.x}</button>`;
}

function recruitPaintSelection() {
  const selected = recruitSelection();
  const visible = recruitVisibleRows();
  const visibleSelected = visible.filter((r) => selected.has(r.id)).length;
  const all = $('[data-action="recruit-select-visible"]');
  if (all) { all.checked = visible.length > 0 && visibleSelected === visible.length; all.indeterminate = visibleSelected > 0 && visibleSelected < visible.length; all.disabled = !visible.length; }
  for (const input of $$('[data-action="recruit-select"]')) {
    input.checked = selected.has(input.dataset.id);
    input.closest('tr')?.classList.toggle('is-selected', input.checked);
  }
  const bar = $('[data-recruit-selection]');
  if (bar) {
    const active = document.activeElement;
    if (selected.size) recruitRepaint(bar, recruitSelectionBarHtml());
    for (const group of $$('[data-recruit-tools]')) group.hidden = Boolean(selected.size);
    bar.hidden = !selected.size;
    if (active?.closest?.('[hidden]')) $('[data-m="recruit-q"]')?.focus();
  }
}

/* ------------------------------- sheet ----------------------------------- */

function recruitBaseColumns(cycle) {
  return [
    { id: 'year', label: 'Year', sortKey: null, cell: (r) => (r.year ? MD.esc(r.year) : '<span class="faint">—</span>') },
    { id: 'subteam', label: 'Subteam', sortKey: null, cell: (r) => MD.esc(r.subteam || 'Undecided') },
    { id: 'stage', label: 'Stage', sortKey: 'stage_at', cell: (r) => MD.esc(recruitStageName(cycle, r.stage)) },
  ];
}

function recruitAllColumns(cycle, role) {
  const base = recruitBaseColumns(cycle);
  const extra = RECRUIT.columns(cycle, role).filter((c) => !base.some((b) => b.id === c.id) && !['check', 'person', 'received', 'review'].includes(c.id));
  return [...base, ...extra];
}

function recruitFlagButton(r, { detail = false } = {}) {
  const flagged = Boolean(r.flagged ?? r.review?.flagged);
  const readOnly = !recruitCan('reviewer') || recruitCycleRow()?.status === 'archived';
  const label = `${flagged ? 'Unflag' : 'Flag'} ${r.name}`;
  if (readOnly) return flagged ? `<span class="interest-flag-readonly" title="Flagged">${RC_ICONS.flag}${detail ? 'Flagged' : ''}</span>` : '';
  return `<button class="${detail ? 'btn interest-detail-flag' : 'icon-btn'} interest-flag ${flagged ? 'is-flagged' : ''}" data-action="recruit-flag" data-id="${MD.esc(r.id)}" aria-pressed="${flagged}" aria-label="${MD.esc(label)}" title="${MD.esc(label)}" aria-disabled="${recruitState().busy.has('flag:' + r.id)}">${RC_ICONS.flag}${detail ? `<span>${flagged ? 'Flagged' : 'Flag'}</span>` : ''}</button>`;
}

function recruitRowHtml(r, cycle, cols, selected) {
  const comments = Number(r.comments || 0);
  return `<tr data-id="${MD.esc(r.id)}" class="${selected.has(r.id) ? 'is-selected' : ''}">
    <td class="sheet__check-cell" data-col="check"><label class="sheet__check"><input type="checkbox" data-action="recruit-select" data-id="${MD.esc(r.id)}" aria-label="Select ${MD.esc(r.name)} (${MD.esc(r.email)})" ${selected.has(r.id) ? 'checked' : ''}></label></td>
    <td data-col="person"><button class="interest-person" data-action="recruit-app-open" data-id="${MD.esc(r.id)}" aria-label="Open ${MD.esc(r.name)}"><b>${MD.esc(r.name)}</b><span class="mail">${MD.esc(r.email)}</span></button></td>
    ${cols.map((c) => { let cell = ''; try { cell = String(c.cell?.(r, cycle) ?? ''); } catch (e) { cell = ''; } return `<td data-col="${MD.esc(c.id)}">${cell}</td>`; }).join('')}
    <td class="interest-when" data-col="received" title="${MD.esc(new Date(Number(r.ts)).toLocaleString())}">${recruitDate(Number(r.ts))}</td>
    <td class="sheet__review-cell" data-col="review"><div class="interest-row-actions">
      ${recruitFlagButton(r)}
      <button class="icon-btn interest-comments ${comments ? 'has-comments' : ''}" data-action="recruit-app-open" data-id="${MD.esc(r.id)}" data-comments="true" aria-label="${comments ? `${comments} ${comments === 1 ? 'comment' : 'comments'} on` : 'Comment on'} ${MD.esc(r.name)}" title="${comments ? `${comments} ${comments === 1 ? 'comment' : 'comments'}` : 'Add comment'}">${RC_ICONS.comment}${comments ? `<span>${comments}</span>` : ''}</button>
    </div></td>
  </tr>`;
}

function recruitRowsHtml(rows, cycle) {
  const st = recruitState();
  const cols = recruitAllColumns(cycle, recruitRole());
  const span = cols.length + 4;
  if (!st.apps || (st.apps.loading && !st.apps.rows.length)) return `<tr class="sheet__empty"><td colspan="${span}">Loading…</td></tr>`;
  if (st.apps?.error && !st.apps.rows.length) return `<tr class="sheet__empty"><td colspan="${span}">Could not load: ${MD.esc(st.apps.error)}. <button class="linklike" data-action="recruit-apps-refresh">Retry</button></td></tr>`;
  if (!rows.length) return `<tr class="sheet__empty"><td colspan="${span}">${st.apps?.rows?.length || recruitHasFilter(cycle) ? 'No people match these filters.' : 'No applications yet.'}</td></tr>`;
  const selected = recruitSelection();
  return rows.map((r) => recruitRowHtml(r, cycle, cols, selected)).join('');
}

function recruitHasFilter(cycle) {
  const f = recruitFilters(cycle?.id);
  return Object.entries(f).some(([k, v]) => !['sort', 'dir'].includes(k) && v);
}

function recruitFootText(shown) {
  const st = recruitState();
  const total = Number(st.apps?.total || 0);
  const loaded = st.apps?.rows?.length || 0;
  const noun = shown === 1 ? 'person' : 'people';
  const base = shown === total ? `${total.toLocaleString('en-US')} ${noun}` : `${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} shown`;
  return loaded < total && st.apps?.next ? `${base} · ` : base;
}

function recruitFootHtml() {
  const st = recruitState();
  const shown = recruitVisibleRows().length;
  const more = st.apps?.next && !st.apps.loading ? `<button class="linklike" data-action="recruit-load-more">Load more</button>` : st.apps?.loading && st.apps.rows.length ? '<span class="faint">Loading…</span>' : '';
  return `<span data-rc="foot-text">${MD.esc(recruitFootText(shown))}</span>${more}`;
}

// Rows and the footer repaint alone, so the search box keeps its caret.
function recruitPaintRows(updatedId) {
  const body = $('.sheet--recruit tbody');
  if (!body) return false;
  const cycle = recruitCycleRow();
  const rows = recruitVisibleRows(cycle);
  const focus = focusReference(document.activeElement);
  const had = body.contains(document.activeElement);
  const current = [...(body.children || [])];
  const sameOrder = current.length === rows.length && current.every((el, i) => el.dataset?.id === rows[i].id);
  if (updatedId && sameOrder) {
    const index = rows.findIndex((r) => r.id === updatedId);
    if (index >= 0) {
      const fragment = document.createElement('tbody');
      fragment.innerHTML = recruitRowsHtml([rows[index]], cycle);
      const cell = $('.sheet__review-cell', current[index]), fresh = $('.sheet__review-cell', fragment);
      if (cell && fresh) cell.innerHTML = fresh.innerHTML;
      for (const c of recruitAllColumns(cycle, recruitRole())) {
        const a = $(`td[data-col="${c.id}"]`, current[index]), b = $(`td[data-col="${c.id}"]`, fragment);
        if (a && b && a.innerHTML !== b.innerHTML) a.innerHTML = b.innerHTML;
      }
    }
  } else body.innerHTML = recruitRowsHtml(rows, cycle);
  if (had) (resolveFocus(focus, body) || $('[data-m="recruit-q"]'))?.focus({ preventScroll: true });
  const foot = $('.sheet--recruit .sheet__foot');
  if (foot) foot.innerHTML = recruitFootHtml();
  recruitPaintSelection();
  recruitPaintCounts();
  return true;
}

const recruitPaintRow = (id) => recruitPaintRows(id);

function recruitStripHtml(cycle) {
  const st = recruitState();
  const f = recruitFilters(cycle.id);
  const counts = st.cycle?.counts || { total: 0, byStage: {} };
  const btn = (key, name, n) => `<button class="rc-strip__stage" data-action="recruit-stage" data-stage="${MD.esc(key)}" aria-pressed="${(f.stage || '') === key}">${MD.esc(name)}<span class="rc-strip__n" data-rc-count="${MD.esc(key || 'all')}">${Number(n || 0).toLocaleString('en-US')}</span></button>`;
  return `<div class="rc-strip" role="group" aria-label="Stages">${btn('', 'All', counts.total)}${recruitStages(cycle).map((s) => btn(s.key, s.name, counts.byStage?.[s.key])).join('')}</div>`;
}

function recruitViewOptions(cycle) {
  const views = Array.isArray(cycle.doc?.pipeline?.views) ? cycle.doc.pipeline.views : [];
  return [{ value: '', label: 'Views' }, ...views.map((v) => ({ value: v.key, label: v.name })), { value: '__save', label: 'Save current view…' }, ...(views.length && recruitCan('lead') ? [{ value: '__manage', label: 'Manage views…' }] : [])];
}

function recruitSheetHtml(cycle) {
  const st = recruitState();
  const f = recruitFilters(cycle.id);
  const rows = recruitVisibleRows(cycle);
  const selected = recruitSelection();
  const visibleSelected = rows.filter((r) => selected.has(r.id)).length;
  const cols = recruitAllColumns(cycle, recruitRole());
  const th = (key, label, id) => key
    ? `<th data-col="${MD.esc(id)}" aria-sort="${f.sort === key ? (f.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button class="sheet__sort ${f.sort === key ? 'on' : ''}" data-action="recruit-sort" data-key="${MD.esc(key)}">${MD.esc(label)}<span class="sheet__caret">${f.sort === key ? (f.dir === 'asc' ? '↑' : '↓') : ''}</span></button></th>`
    : `<th data-col="${MD.esc(id)}"><span class="sheet__sort sheet__sort--static">${MD.esc(label)}</span></th>`;
  const lead = recruitCan('lead');
  const archived = cycle.status === 'archived';
  const exportHref = `/api/recruit/cycles/${encodeURIComponent(cycle.id)}/export.csv?${recruitListParams(cycle, f, null)}`;
  return `<div class="sheet sheet--recruit ${archived ? 'sheet--archived' : ''}">
    <div class="sheet__bar">
      <div class="sheet__search-wrap">${I.search}<input class="text-input sheet__search" data-m="recruit-q" type="search" placeholder="Search people…" value="${MD.esc(f.q || '')}" aria-label="Search by name or email" autocomplete="off" spellcheck="false"></div>
      <div class="sheet__actions" data-recruit-tools ${selected.size ? 'hidden' : ''}>
        ${dd('recruit-filter', [{ value: 'combined', label: recruitFilterLabel(cycle) }], 'combined')}
        ${dd('recruit-view', recruitViewOptions(cycle), '', { small: false })}
        ${lead ? `<a class="btn btn--sm" href="${MD.esc(exportHref)}" download>${RC_ICONS.download} Export</a>` : ''}
        <button class="icon-btn" data-action="recruit-tools" aria-label="List options" title="List options" aria-haspopup="menu">${I.dots}</button>
      </div>
      <div class="sheet__actions sheet__selection" data-recruit-selection ${selected.size ? '' : 'hidden'}>${selected.size ? recruitSelectionBarHtml() : ''}</div>
    </div>
    <div class="sheet__scroll"><table aria-label="Applications in ${MD.esc(cycle.name)}">
      <thead><tr>
        <th class="sheet__check-cell" data-col="check"><label class="sheet__check"><input type="checkbox" data-action="recruit-select-visible" aria-label="Select all visible people" ${rows.length && visibleSelected === rows.length ? 'checked' : ''} ${rows.length ? '' : 'disabled'}></label></th>
        ${th('name', 'Person', 'person')}${cols.map((c) => th(c.sortKey, c.label, c.id)).join('')}${th('ts', 'Received', 'received')}
        <th class="sheet__review-cell" data-col="review"><span class="sheet__sort sheet__sort--static">Review</span></th>
      </tr></thead>
      <tbody>${recruitRowsHtml(rows, cycle)}</tbody>
    </table></div>
    <div class="sheet__foot" role="status">${recruitFootHtml()}</div>
  </div>`;
}

function recruitApplicationsView(cycle, role) {
  const st = recruitState();
  const pending = st.cycles?.intakeCycleId === cycle.id && recruitIsAdmin() ? `<div data-rc="queue">${recruitPendingHtml()}</div>` : '';
  return recruitStripHtml(cycle) + recruitSheetHtml(cycle) + pending;
}

/* ------------------------------- queue block ----------------------------- */

function recruitPendingReason(reason) {
  if (reason === 'duplicate') return 'Existing application needs review';
  if (reason === 'capacity') return 'Cycle is full';
  if (reason === 'replay_failed') return 'Could not add to the cycle yet';
  if (reason === 'no_cycle') return 'No cycle was receiving the form';
  return 'Waiting to join the cycle';
}

function recruitPendingHtml() {
  const st = recruitState();
  if (!recruitIsAdmin()) return '';
  const q = st.queue;
  if (!q || q.loading) return '';
  const unavailable = q.error || q.queueUnavailable
    ? `<p class="sheet__note" role="status">Could not check for saved submissions waiting to join the cycle. <button class="linklike" data-action="recruit-queue-sync">Retry</button></p>` : '';
  const pending = q.pending || [];
  if (!pending.length) return unavailable;
  return `<section aria-labelledby="recruit-pending-heading">
    <h2 class="sheet__heading" id="recruit-pending-heading">Saved submissions awaiting review <span class="count" style="font-variant-numeric:tabular-nums">${pending.length}</span></h2>
    <p class="sheet__note">These responses are saved separately and are not in any cycle or its CSV.</p>
    ${unavailable}
    <div class="sheet sheet--list">${pending.map((r) => `<div class="sheet__archive" style="height:auto;min-height:60px;flex-wrap:wrap;padding-top:4px;padding-bottom:4px">
      <button class="interest-person" style="flex:1 1 180px" data-action="recruit-queue-open" data-id="${MD.esc(r.id)}" aria-label="Review saved submission from ${MD.esc(r.name)}"><b>${MD.esc(r.name)}</b><span class="mail">${MD.esc(r.email)}</span></button>
      <span class="sheet__archivemeta" style="flex:1 1 180px">${MD.esc(recruitPendingReason(r.reason))}</span>
      <span class="interest-when" title="${MD.esc(new Date(Number(r.receivedAt)).toLocaleString())}">${recruitDate(Number(r.receivedAt))}</span>
      <button class="btn btn--sm" data-action="recruit-queue-place" data-id="${MD.esc(r.id)}" aria-haspopup="menu">Place in…</button>
    </div>`).join('')}</div>
  </section>`;
}

function recruitQueueModalHtml(m) {
  const r = (recruitState().queue?.pending || []).find((row) => row.id === m.id);
  if (!r) return `<div class="modal" role="dialog" aria-label="Saved submission"><div class="modal__head"><h3>Saved submission</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div><div class="modal__body"><p>This submission has already joined a cycle. Close this window to refresh.</p></div></div>`;
  const fileUrl = `/api/recruit/queue/${encodeURIComponent(r.id)}/file`;
  return `<div class="modal modal--wide" role="dialog" aria-label="Saved submission">
    <div class="modal__head"><h3>${MD.esc(r.name)}</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body">
      <p class="sheet__note">${MD.esc(recruitPendingReason(r.reason))}. Placing it copies the answers into a cycle; the saved record stays.</p>
      <dl class="interest-detail">
        <dt>Email</dt><dd>${MD.esc(r.email)}</dd>
        <dt>Subteam</dt><dd>${MD.esc(r.subteam || 'Not sure yet')}</dd>
        <dt>Year</dt><dd>${MD.esc(r.year || 'Not provided')}</dd>
        <dt>Received</dt><dd>${MD.esc(new Date(Number(r.receivedAt)).toLocaleString())}</dd>
        <dt>Receipt</dt><dd>${MD.esc(r.id)}</dd>
        ${r.fileName ? `<dt>File</dt><dd>${r.fileUrl ? `<a class="interest-download" href="${MD.esc(fileUrl)}" download="${MD.esc(r.fileName)}">${MD.esc(r.fileName)}</a>` : MD.esc(r.fileName)} <span class="faint">${Math.max(1, Math.round((r.fileSize || 0) / 1024))} KB</span></dd>` : ''}
      </dl>
      <h4 class="interest-subhead">Coolest project they've done</h4>
      <p class="interest-project">${r.project ? MD.esc(r.project) : '<span class="faint">They left this blank.</span>'}</p>
    </div>
    <div class="modal__foot"><button class="btn" data-action="modal-close">Close</button><button class="btn btn--primary" data-action="recruit-queue-place" data-id="${MD.esc(r.id)}" aria-haspopup="menu">Place in…</button></div>
  </div>`;
}

function recruitOpenQueuePlace(anchor, receipt) {
  const st = recruitState();
  const cycles = (st.cycles?.list || []).filter((c) => c.status === 'open' || c.status === 'draft');
  if (!cycles.length) { toast('Open a cycle first'); return; }
  openMenu(cycles.map((c) => ({ label: c.name, run: () => recruitPlaceQueued(receipt, c) })), anchor);
}

async function recruitPlaceQueued(receipt, cycle) {
  const st = recruitState();
  const key = 'place:' + receipt;
  if (st.busy.has(key)) return;
  st.busy.add(key);
  try {
    await RECRUIT.api(`/recruit/queue/${encodeURIComponent(receipt)}/place`, { method: 'POST', body: JSON.stringify({ requestId: recruitId('rq'), cycleId: cycle.id, confirmUpdate: true }) });
    if (st.queue?.pending) st.queue.pending = st.queue.pending.filter((r) => r.id !== receipt);
    st.cycles = undefined;
    if (recruitCycleRow()?.id === cycle.id) recruitLoadApps();
    toast(`Placed in ${cycle.name}`);
    if (UI.modal?.kind === 'recruit-queue' && UI.modal.id === receipt) closeModal(() => renderBackground('recruit'));
    else if (!recruitPaintQueue()) renderBackground('recruit');
  } catch (e) { toast(`Could not place: ${recruitError(e)}`); }
  finally { st.busy.delete(key); }
}

/* ------------------------------- detail dialog --------------------------- */

function recruitDetailData(out) {
  return { application: out.application || null, form: out.form || null, scores: out.scores || [], assignments: out.assignments || [], bookings: out.bookings || [], mail: out.mail || [], history: out.history || [], audit: out.audit || [] };
}

function recruitLoadDetail(id, { quiet = false } = {}) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  if (!cycle || !id) return;
  if (st.detail[id]?.loading) return;
  const prior = st.detail[id];
  st.detail[id] = quiet && prior && !prior.error ? { ...prior, loading: true, refreshing: true } : { loading: true };
  const key = st.key;
  RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/applications/${encodeURIComponent(id)}`)
    .then((out) => {
      if (st.key !== key) return;
      st.detail[id] = recruitDetailData(out);
      const row = recruitRowFromApplication(out.application);
      if (row && st.apps?.byId?.[id]) {
        const cached = st.apps.byId[id];
        if (Number(row.editVersion ?? 0) >= Number(cached.editVersion ?? 0)) { st.apps.byId[id] = { ...cached, ...row }; const i = st.apps.rows.findIndex((r) => r.id === id); if (i >= 0) st.apps.rows[i] = st.apps.byId[id]; recruitPaintRow(id); }
      }
      recruitPaintDetail(id);
    })
    .catch((e) => { if (st.key !== key) return; st.detail[id] = { error: recruitError(e), status: e.status }; recruitPaintDetail(id); });
}

function recruitDraft(id) {
  const st = recruitState();
  return st.drafts[id] ||= { text: '', id: null, sending: false, error: '' };
}

function recruitApp(id) {
  const st = recruitState();
  return st.detail[id]?.application || st.apps?.byId?.[id] || null;
}

function recruitAnswersHtml(d, cycle) {
  const a = d.application;
  const questions = Array.isArray(d.form?.questions) ? d.form.questions : (Array.isArray(d.form?.doc?.questions) ? d.form.doc.questions : []);
  const answers = a.answers || {};
  const system = new Set(['name', 'email', 'subteam', 'year', 'file']);
  const shown = new Set();
  const blocks = [];
  for (const q of questions) {
    if (system.has(q.key) || q.type === 'file') continue;
    shown.add(q.key);
    const v = answers[q.key];
    const text = Array.isArray(v) ? v.join(', ') : v == null ? '' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
    blocks.push(`<h4 class="interest-subhead">${MD.esc(q.label || q.key)}</h4><p class="interest-project">${text ? (q.type === 'link' && /^https?:\/\//.test(text) ? `<a href="${MD.esc(text)}" target="_blank" rel="noopener noreferrer">${MD.esc(text)}</a>` : MD.esc(text)) : '<span class="faint">Left blank.</span>'}</p>`);
  }
  for (const [k, v] of Object.entries(answers)) {
    if (shown.has(k) || system.has(k)) continue;
    const text = Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v);
    blocks.push(`<h4 class="interest-subhead">${MD.esc(k === 'project' ? 'Coolest project' : k)}</h4><p class="interest-project">${text ? MD.esc(text) : '<span class="faint">Left blank.</span>'}</p>`);
  }
  if (!blocks.length) blocks.push('<p class="interest-project"><span class="faint">No answers beyond the basics.</span></p>');
  const files = (a.files || []).map((f) => `<a class="interest-attachment" href="/api/recruit/files/${MD.esc(f.id)}" download="${MD.esc(f.name || 'file')}">${RC_ICONS.download}<span>${MD.esc(f.name || 'Attachment')}<small>${Math.max(1, Math.round((f.size || 0) / 1024))} KB</small></span></a>`).join('');
  return blocks.join('') + files;
}

function recruitDetailMainHtml(id) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const d = st.detail[id];
  const row = recruitApp(id);
  if (!row) return '<p class="faint">This application was removed. Close this window to refresh the list.</p>';
  const basics = `<dl class="interest-detail">
    <dt>Subteam</dt><dd>${MD.esc(row.subteam || 'Undecided')}</dd>
    <dt>Year</dt><dd>${MD.esc(row.year || 'Not provided')}</dd>
    <dt>Stage</dt><dd>${MD.esc(recruitStageName(cycle, row.stage))}${row.stageAt ? ` <span class="faint">since ${MD.esc(recruitDate(Number(row.stageAt)))}</span>` : ''}</dd>
    <dt>Received</dt><dd>${MD.esc(recruitDate(Number(row.ts)))}${row.updated && row.updated !== row.ts ? ` <span class="faint">updated ${MD.esc(recruitDate(Number(row.updated)))}</span>` : ''}</dd>
    ${row.cornell === false ? '<dt>Address</dt><dd><span class="interest-outside">Outside cornell.edu</span></dd>' : ''}
  </dl>`;
  if (!d || d.loading && !d.application) return basics + '<p class="sheet__note">Loading…</p>';
  if (d.error) return basics + `<p class="sheet__note">Could not load: ${MD.esc(d.error)}. <button class="linklike" data-action="recruit-detail-retry" data-id="${MD.esc(id)}">Retry</button></p>`;
  const a = d.application;
  const others = (d.history || []).filter((h) => h.cycleId !== cycle?.id);
  const history = others.length ? `<p class="rc-history">Also applied ${others.map((h) => `${MD.esc(h.cycleName || h.cycleId)}${h.outcome ? ' · ' + MD.esc(recruitStageName(cycle, h.outcome)) : ''}`).join(', ')}</p>` : '';
  const lead = recruitCan('lead') && cycle?.status !== 'archived';
  const tags = Array.isArray(a.tags) ? a.tags : [];
  const tagsHtml = `<h4 class="interest-subhead">Tags</h4><div class="rc-tags" data-rc="tags">${tags.map((t) => `<span class="rc-tag">${MD.esc(t)}${lead ? `<button type="button" class="rc-tag__x" data-action="recruit-tag-remove" data-id="${MD.esc(id)}" data-tag="${MD.esc(t)}" aria-label="Remove tag ${MD.esc(t)}">${I.x}</button>` : ''}</span>`).join('')}${tags.length ? '' : '<span class="faint">None</span>'}</div>
    ${lead ? `<form class="rc-tag-form" data-action="recruit-tag-form" data-id="${MD.esc(id)}"><input class="text-input" data-m="recruit-tag-new" name="tag" placeholder="Add a tag" maxlength="30" autocomplete="off" spellcheck="false" aria-label="Add a tag"><button type="submit" class="btn btn--sm">Add</button></form>` : ''}`;
  const dec = a.decision || {};
  const decision = a.outcome || dec.outcome ? `<h4 class="interest-subhead">Decision</h4><dl class="interest-detail">
      <dt>Outcome</dt><dd>${MD.esc(recruitStageName(cycle, a.outcome || dec.outcome))}</dd>
      ${dec.subteam ? `<dt>Subteam</dt><dd>${MD.esc(dec.subteam)}</dd>` : ''}
      ${dec.reason ? `<dt>Reason</dt><dd>${MD.esc(dec.reason)}</dd>` : ''}
      ${dec.at ? `<dt>Decided</dt><dd>${MD.esc(recruitDate(Number(dec.at)))}${dec.by ? ` · ${MD.esc(Store.userName?.(dec.by) || dec.by)}` : ''}</dd>` : ''}
    </dl>` : '';
  return basics + history + recruitAnswersHtml(d, cycle) + tagsHtml + decision;
}

function recruitDetailSideHtml(id) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const d = st.detail[id];
  if (!d || !d.application || d.error) return '';
  const app = { ...d.application, scores: d.scores, assignments: d.assignments, bookings: d.bookings, mail: d.mail, audit: d.audit, history: d.history };
  return RECRUIT.detailSections(app, cycle, recruitRole()).map((s) => `<section class="rc-section" data-rc-section="${MD.esc(s.id)}">${s.title ? `<h4 class="interest-subhead">${MD.esc(s.title)}</h4>` : ''}${s.html}</section>`).join('');
}

function recruitCommentHtml(c, id) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const mine = c.by && Store.me?.()?.email === c.by;
  const removable = cycle?.status !== 'archived' && (recruitCan('lead') || mine);
  const removal = st.mod.commentRemovals?.[id + '/' + c.id];
  return `<article class="interest-comment" data-comment-id="${MD.esc(c.id)}"><div class="interest-comment__meta"><b>${MD.esc(c.name || c.by || 'Member')}</b><time title="${MD.esc(new Date(Number(c.ts)).toLocaleString())}" datetime="${new Date(Number(c.ts)).toISOString()}">${recruitDate(Number(c.ts))}</time>${removable ? `<button type="button" class="btn btn--ghost btn--sm interest-comment__delete" data-action="recruit-comment-delete" data-id="${MD.esc(id)}" data-cid="${MD.esc(c.id)}" aria-label="Delete comment by ${MD.esc(c.name || c.by || 'member')}" ${removal?.confirming ? 'disabled' : ''}>Delete</button>` : ''}</div><p>${MD.esc(c.text)}</p>${removable ? `<div data-comment-controls>${recruitCommentDeleteHtml(id, c.id)}</div>` : ''}</article>`;
}

function recruitCommentDeleteHtml(id, commentId) {
  const removal = recruitState().mod.commentRemovals?.[id + '/' + commentId];
  if (!removal?.confirming) return '';
  return `<div class="interest-comment__confirm" role="group" aria-label="Delete comment confirmation"><span>Delete this comment?</span><button type="button" class="btn btn--sm" data-action="recruit-comment-delete-cancel" data-id="${MD.esc(id)}" data-cid="${MD.esc(commentId)}" ${removal.busy ? 'disabled' : ''}>Cancel</button><button type="button" class="btn btn--sm btn--danger" data-action="recruit-comment-delete-confirm" data-id="${MD.esc(id)}" data-cid="${MD.esc(commentId)}" ${removal.busy ? 'disabled' : ''}>${removal.busy ? 'Deleting…' : 'Delete'}</button></div>${removal.error ? `<p class="field-error" role="alert">${MD.esc(removal.error)}</p>` : ''}`;
}

function recruitDiscussionHtml(id) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const d = st.detail[id];
  const comments = d?.application?.review?.comments || [];
  const draft = recruitDraft(id);
  const row = recruitApp(id);
  const canComment = recruitCan('reviewer') && cycle?.status !== 'archived';
  return `<h4 class="interest-subhead" id="recruit-comments-heading">Comments <span class="count">${comments.length}</span><span class="interest-private">Team only</span></h4>
    <div class="interest-thread" role="log" aria-label="Comments" aria-live="polite" aria-relevant="additions removals">${d?.loading && !d.application ? '<p class="interest-thread__empty">Loading…</p>' : comments.length ? comments.map((c) => recruitCommentHtml(c, id)).join('') : '<p class="interest-thread__empty">No comments yet.</p>'}</div>
    ${canComment ? `<form class="interest-compose" data-action="recruit-comment-form" data-id="${MD.esc(id)}">
      <textarea class="text-input" data-m="recruit-comment" data-id="${MD.esc(id)}" aria-label="Comment on ${MD.esc(row?.name || 'this application')}" placeholder="Add a comment…" rows="3" maxlength="4000" required ${draft.sending ? 'readonly' : ''}>${MD.esc(draft.text)}</textarea>
      <p class="field-error" data-comment-error role="alert" ${draft.error ? '' : 'hidden'}>${MD.esc(draft.error || '')}</p>
      <div class="interest-compose__foot"><button type="submit" class="btn btn--primary" ${draft.sending || !draft.text.trim() ? 'disabled' : ''}>${draft.sending ? 'Posting…' : 'Post comment'}</button></div>
    </form>` : '<p class="interest-readonly">Read only</p>'}`;
}

function recruitAppModalHtml(m) {
  const st = recruitState();
  const id = m.id;
  const cycle = recruitCycleRow();
  const row = recruitApp(id);
  if (!row || !cycle) return `<div class="modal" role="dialog" aria-label="Application unavailable"><div class="modal__head"><h3>Application unavailable</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div><div class="modal__body"><p>This application was removed. Close this window to refresh the list.</p></div></div>`;
  const lead = recruitCan('lead') && cycle.status !== 'archived';
  const stageDd = lead ? dd('recruit-app-stage', recruitStages(cycle).map((s) => ({ value: s.key, label: s.name })), row.stage || 'applied', { small: true }) : '';
  const rows = recruitVisibleRows(cycle);
  const index = rows.findIndex((r) => r.id === id);
  const foot = index >= 0 && rows.length > 1 ? `<button class="btn btn--sm" data-action="recruit-app-prev" ${index > 0 ? '' : 'disabled'}>← Previous</button><span class="faint" style="font-size:12px;font-variant-numeric:tabular-nums">${index + 1} of ${rows.length}</span><button class="btn btn--sm" data-action="recruit-app-next" ${index < rows.length - 1 ? '' : 'disabled'}>Next →</button>` : '';
  return `<div class="modal modal--wide interest-review rc-app" role="dialog" aria-label="Application from ${MD.esc(row.name)}" data-app="${MD.esc(id)}">
    <div class="modal__head">
      <div class="interest-review__identity"><h3>${MD.esc(row.name)}</h3><span>${MD.esc(row.email)} · ${MD.esc(cycle.name)}</span></div>
      ${stageDd}
      <span data-rc="app-flag">${recruitFlagButton(row, { detail: true })}</span>
      <button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button>
    </div>
    <div class="modal__body interest-review__body">
      <section class="interest-application" aria-label="Application">
        <h4 class="interest-subhead">Application</h4>
        <div data-rc="app-main">${recruitDetailMainHtml(id)}</div>
      </section>
      <section class="interest-discussion" aria-labelledby="recruit-comments-heading">
        <div data-rc="app-side">${recruitDetailSideHtml(id)}</div>
        <div data-rc="app-comments">${recruitDiscussionHtml(id)}</div>
      </section>
    </div>
    <div class="modal__foot modal__foot--split">${foot}<span style="flex:1"></span><button class="btn" data-action="modal-close">Close</button></div>
  </div>`;
}

// Repaint the open dialog's regions in place; the composer keeps its text.
function recruitPaintDetail(id) {
  if (UI.modal?.kind !== 'recruit-app' || UI.modal.id !== id) return false;
  const dialog = $('.rc-app');
  if (!dialog) return false;
  recruitRepaint($('[data-rc="app-main"]', dialog), recruitDetailMainHtml(id));
  recruitRepaint($('[data-rc="app-side"]', dialog), recruitDetailSideHtml(id));
  const flag = $('[data-rc="app-flag"]', dialog);
  if (flag) recruitRepaint(flag, recruitFlagButton(recruitApp(id) || {}, { detail: true }));
  recruitPaintDiscussion(id);
  return true;
}

// Ported from paintInterestDiscussion: existing comment nodes keep their DOM
// identity, only removed comments and changed controls are touched, and the
// author's unsent composer is never replaced.
function recruitPaintDiscussion(id, { posted = false } = {}) {
  if (UI.modal?.kind !== 'recruit-app' || UI.modal.id !== id) return;
  const dialog = $('.rc-app'), draft = recruitDraft(id);
  const st = recruitState();
  const d = st.detail[id];
  if (!dialog) return;
  const thread = $('.interest-thread', dialog), field = $('.interest-compose textarea', dialog);
  const button = $('.interest-compose [type="submit"]', dialog), error = $('[data-comment-error]', dialog);
  const scroller = $('.interest-review__body', dialog);
  if (!thread) return;
  const scrollTop = scroller?.scrollTop || 0;
  const followBottom = scroller ? scroller.scrollHeight - scroller.clientHeight - scrollTop < 32 : false;
  const comments = d?.application?.review?.comments || [];
  const nodes = $$('[data-comment-id]', thread);
  const active = document.activeElement;
  const removed = nodes.filter((node) => !comments.some((c) => c.id === node.dataset.commentId));
  const restoreAfterRemoval = removed.some((node) => node.contains?.(active));
  const anchor = scroller?.getBoundingClientRect && nodes.find((node) => !removed.includes(node) && node.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top);
  const anchorTop = anchor?.getBoundingClientRect().top;
  removed.forEach((node) => node.remove());
  const existing = new Set(nodes.filter((node) => !removed.includes(node)).map((el) => el.dataset.commentId));
  const added = comments.filter((c) => !existing.has(c.id));
  if (added.length || (d && !d.loading)) $('.interest-thread__empty', thread)?.remove();
  if (added.length) thread.insertAdjacentHTML('beforeend', added.map((c) => recruitCommentHtml(c, id)).join(''));
  if (!comments.length && d && !d.loading && !$('.interest-thread__empty', thread)) thread.insertAdjacentHTML('beforeend', '<p class="interest-thread__empty">No comments yet.</p>');
  for (const node of $$('[data-comment-id]', thread)) {
    const commentId = node.dataset.commentId, controls = $('[data-comment-controls]', node);
    const removal = st.mod.commentRemovals?.[id + '/' + commentId];
    const trigger = $('[data-action="recruit-comment-delete"]', node);
    if (trigger) trigger.disabled = Boolean(removal?.confirming);
    const key = JSON.stringify([!!removal?.confirming, !!removal?.busy, removal?.error || '']);
    if (controls && controls._stateKey !== key) {
      const action = controls.contains(document.activeElement) ? document.activeElement.dataset.action : null;
      controls.innerHTML = recruitCommentDeleteHtml(id, commentId);
      controls._stateKey = key;
      if (action && !removal?.busy) $(`[data-action="${action}"]`, controls)?.focus({ preventScroll: true });
    }
  }
  const count = $('.interest-subhead .count', dialog);
  if (count) count.textContent = comments.length;
  if (field) {
    field.readOnly = draft.sending;
    if (posted) field.value = '';
  }
  if (button) {
    button.disabled = draft.sending || !draft.text.trim();
    button.textContent = draft.sending ? 'Posting…' : 'Post comment';
  }
  if (error) { error.textContent = draft.error || ''; error.hidden = !draft.error; }
  if (scroller) scroller.scrollTop = posted && followBottom ? scroller.scrollHeight : scrollTop + (anchor?.isConnected ? anchor.getBoundingClientRect().top - anchorTop : 0);
  if (restoreAfterRemoval) ($('[data-action="recruit-comment-delete"]', thread) || field)?.focus({ preventScroll: true });
  if (posted && (document.activeElement === document.body || document.activeElement === button || document.activeElement === field)) field?.focus({ preventScroll: true });
}

function recruitOpenApp(id, { comments = false } = {}) {
  const st = recruitState();
  if (st.busy.has('delete:' + id)) { toast('Deletion is in progress'); return; }
  UI.modal = { kind: 'recruit-app', id };
  render();
  if (st.detail[id] === undefined || st.detail[id]?.error) recruitLoadDetail(id);
  if (comments) $('.rc-app .interest-compose textarea')?.focus();
  else $('.rc-app [data-action="modal-close"]')?.focus();
}

function recruitStepApp(delta) {
  const id = UI.modal?.kind === 'recruit-app' ? UI.modal.id : null;
  if (!id) return;
  const rows = recruitVisibleRows();
  const i = rows.findIndex((r) => r.id === id);
  const next = rows[i + delta];
  if (i < 0 || !next) return;
  recruitOpenApp(next.id);
  $(`.rc-app [data-action="${delta > 0 ? 'recruit-app-next' : 'recruit-app-prev'}"]`)?.focus();
}

/* ------------------------------- review mutations ------------------------ */

// The server answers review mutations with the updated application (or the
// legacy { row }); both carry review and reviewVersion.
function recruitAcceptReview(id, out) {
  const st = recruitState();
  const a = out?.application || out?.row;
  if (!a) return;
  const d = st.detail[id];
  if (d?.application && Number(a.reviewVersion ?? 0) >= Number(d.application.reviewVersion ?? 0)) {
    d.application = { ...d.application, review: a.review || d.application.review, reviewVersion: a.reviewVersion ?? d.application.reviewVersion };
  } else if (!d || d.error) st.detail[id] = recruitDetailData({ application: a });
  const cached = st.apps?.byId?.[id];
  if (cached && Number(a.reviewVersion ?? 0) >= Number(cached.reviewVersion ?? 0)) {
    const review = a.review || {};
    recruitAcceptRow({ id, reviewVersion: a.reviewVersion, editVersion: cached.editVersion, flagged: Boolean(review.flagged), comments: (review.comments || []).length });
  }
}

async function recruitToggleFlag(id) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const row = recruitApp(id);
  if (!cycle || !row || !recruitCan('reviewer') || cycle.status === 'archived' || st.busy.has('flag:' + id)) return;
  st.busy.add('flag:' + id);
  const want = !(row.flagged ?? row.review?.flagged);
  const paint = () => {
    recruitPaintRow(id);
    const host = $('.rc-app [data-rc="app-flag"]');
    if (host && UI.modal?.kind === 'recruit-app' && UI.modal.id === id) {
      const focused = host.contains(document.activeElement);
      host.innerHTML = recruitFlagButton(recruitApp(id) || row, { detail: true });
      if (focused) $('.interest-detail-flag', host)?.focus();
    }
  };
  paint();
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/applications/${encodeURIComponent(id)}/review`, { method: 'PATCH', body: JSON.stringify({ flagged: want }) });
    recruitAcceptReview(id, out);
    toast(want ? 'Flagged for follow-up' : 'Flag removed');
  } catch (e) { toast(e.name === 'TimeoutError' ? 'The flag request timed out. You can retry.' : `Could not update flag: ${recruitError(e)}`); }
  finally { st.busy.delete('flag:' + id); paint(); }
}

async function recruitPostComment(id) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  if (!cycle || !recruitCan('reviewer') || cycle.status === 'archived') return;
  const draft = recruitDraft(id);
  if (draft.sending || !draft.text.trim()) return;
  // The same id is kept while retrying a lost response, so a comment can
  // never post twice; editing after a failure starts a new submission.
  draft.id ||= recruitId('ic');
  draft.sending = true;
  draft.error = '';
  recruitPaintDiscussion(id);
  let posted = false;
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/applications/${encodeURIComponent(id)}/comments`, { method: 'POST', body: JSON.stringify({ id: draft.id, text: draft.text }) });
    recruitAcceptReview(id, out);
    draft.text = ''; draft.id = null;
    posted = true;
    toast('Comment posted');
  } catch (e) {
    draft.error = e.name === 'TimeoutError'
      ? 'The request timed out. Your comment is still here; retrying will not post it twice.'
      : `Could not post: ${recruitError(e)}. Your comment is still here.`;
  } finally { draft.sending = false; recruitPaintDiscussion(id, { posted }); }
}

function recruitConfirmCommentRemoval(id, commentId, cancel = false) {
  const st = recruitState();
  if (UI.modal?.kind !== 'recruit-app' || UI.modal.id !== id) return;
  const comments = st.detail[id]?.application?.review?.comments || [];
  if (!comments.some((c) => c.id === commentId)) return;
  st.mod.commentRemovals ||= {};
  const key = id + '/' + commentId;
  const removal = st.mod.commentRemovals[key] ||= {};
  if (removal.busy) return;
  if (cancel) delete st.mod.commentRemovals[key];
  else { removal.confirming = true; removal.error = ''; }
  recruitPaintDiscussion(id);
  const node = $$('[data-comment-id]', $('.rc-app .interest-thread')).find((el) => el.dataset.commentId === commentId);
  $(cancel ? '[data-action="recruit-comment-delete"]' : '[data-action="recruit-comment-delete-cancel"]', node)?.focus({ preventScroll: true });
}

async function recruitDeleteComment(id, commentId) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  if (!cycle || cycle.status === 'archived') return;
  const key = id + '/' + commentId;
  const removal = st.mod.commentRemovals?.[key];
  if (!removal?.confirming || removal.busy) return;
  const originalNode = $$('[data-comment-id]', $('.rc-app .interest-thread')).find((el) => el.dataset.commentId === commentId);
  const restoreFocus = originalNode?.contains(document.activeElement);
  removal.busy = true; removal.error = '';
  recruitPaintDiscussion(id);
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/applications/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' });
    recruitAcceptReview(id, out);
    delete st.mod.commentRemovals[key];
    toast('Comment deleted');
  } catch (e) {
    removal.error = e.name === 'TimeoutError' ? 'The request timed out. Retry to confirm deletion.' : `Could not delete: ${recruitError(e)}`;
  } finally {
    removal.busy = false;
    recruitPaintDiscussion(id);
    if (restoreFocus && UI.modal?.kind === 'recruit-app' && UI.modal.id === id && document.activeElement === document.body) {
      const node = $$('[data-comment-id]', $('.rc-app .interest-thread')).find((el) => el.dataset.commentId === commentId);
      (removal.error ? $('[data-action="recruit-comment-delete-confirm"]', node) : $('.rc-app .interest-compose textarea'))?.focus({ preventScroll: true });
    }
  }
}

/* ------------------------------- lead mutations -------------------------- */

async function recruitPatchApp(id, body) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const row = recruitApp(id);
  if (!cycle || !row) throw new Error('No such application');
  const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/applications/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ requestId: recruitId('rq'), editVersion: row.editVersion ?? st.apps?.byId?.[id]?.editVersion ?? 0, ...body }) });
  if (out.application) {
    if (st.detail[id]?.application) st.detail[id].application = { ...st.detail[id].application, ...out.application };
    recruitAcceptRow(recruitRowFromApplication(out.application) || out.application);
  }
  return out;
}

async function recruitEditTags(id, add, remove) {
  const st = recruitState();
  if (st.busy.has('tags:' + id)) return;
  st.busy.add('tags:' + id);
  try {
    await recruitPatchApp(id, { tags: { add, remove } });
    recruitPaintRow(id);
    recruitPaintDetail(id);
  } catch (e) {
    if (e.status === 409) { recruitRefetchRow(id); toast('This application changed. Reloaded; try again.'); }
    else toast(`Could not update tags: ${recruitError(e)}`);
  } finally { st.busy.delete('tags:' + id); }
}

async function recruitMoveOne(id, to) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const row = recruitApp(id);
  if (!cycle || !row || row.stage === to || st.busy.has('move:' + id)) return;
  st.busy.add('move:' + id);
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/moves`, { method: 'POST', body: JSON.stringify({ requestId: recruitId('rq'), ids: [id], to }) });
    const moved = (out.moved || []).find((m) => m.id === id);
    if (moved) {
      recruitAcceptRow({ id, stage: to, stageAt: Date.now(), editVersion: moved.editVersion });
      if (st.detail[id]?.application) Object.assign(st.detail[id].application, { stage: to, stageAt: Date.now(), editVersion: moved.editVersion });
      if (st.cycle?.counts?.byStage) { const b = st.cycle.counts.byStage; b[row.stage] = Math.max(0, (b[row.stage] || 0) - 1); b[to] = (b[to] || 0) + 1; }
      st.mod.analytics = undefined;
      toast(`Moved ${row.name} to ${recruitStageName(cycle, to)}`);
    } else {
      const reason = (out.skipped || []).find((s) => s.id === id)?.reason;
      toast(reason ? `Not moved: ${reason}` : 'Not moved');
      recruitRefetchRow(id);
    }
    recruitPaintRow(id);
    recruitPaintDetail(id);
    const host = $('.rc-app [data-m="recruit-app-stage"]');
    if (host) { const cur = recruitApp(id)?.stage; host.dataset.value = cur; const label = host.querySelector('.dd__label'); if (label) label.textContent = recruitStageName(cycle, cur); }
  } catch (e) { toast(`Could not move: ${recruitError(e)}`); }
  finally { st.busy.delete('move:' + id); }
}

function recruitRefreshAfterRemoval(ids) {
  const open = UI.modal?.kind === 'recruit-app' && ids.has(UI.modal.id);
  if (open) closeModal(() => renderBackground('recruit'));
  else if (!recruitPaintRows()) renderBackground('recruit');
}

function recruitConfirmRemoval(ids) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  if (!cycle || !recruitCan('admin') || cycle.status === 'archived') return;
  const rows = (st.apps?.rows || []).filter((r) => ids.includes(r.id) && !st.busy.has('delete:' + r.id));
  if (!rows.length) { if (ids.length) toast('Deletion is already in progress'); return; }
  const visible = new Set(recruitVisibleRows(cycle).map((r) => r.id));
  const hidden = rows.filter((r) => !visible.has(r.id)).length;
  UI.modal = {
    kind: 'confirm', title: rows.length === 1 ? `Delete ${rows[0].name}?` : `Delete ${rows.length} applications?`,
    text: `${rows.slice(0, 5).map((r) => `<b>${MD.esc(r.name)}</b>`).join(', ')}${rows.length > 5 ? ` and ${rows.length - 5} more` : ''} will be removed, including comments, scores and attachments. This cannot be undone.${hidden ? ` <b>${hidden} selected ${hidden === 1 ? 'person is' : 'people are'} hidden by your filters.</b>` : ''}`,
    confirm: rows.length === 1 ? 'Delete application' : `Delete ${rows.length} applications`, danger: true, typed: rows.length > 1 ? 'delete applications' : undefined,
    onGo: async () => {
      const pending = rows.filter((r) => !st.busy.has('delete:' + r.id));
      if (!pending.length) return;
      pending.forEach((r) => st.busy.add('delete:' + r.id));
      const results = await Promise.allSettled(pending.map((r) => RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/applications/${encodeURIComponent(r.id)}`, { method: 'DELETE' })));
      pending.forEach((r) => st.busy.delete('delete:' + r.id));
      const deleted = new Set(pending.filter((r, i) => results[i].status === 'fulfilled' || results[i].reason?.status === 404).map((r) => r.id));
      if (st.apps?.rows) { st.apps.rows = st.apps.rows.filter((r) => !deleted.has(r.id)); for (const id of deleted) delete st.apps.byId[id]; st.apps.total = Math.max(0, st.apps.total - deleted.size); }
      for (const id of deleted) { st.selected?.delete(id); delete st.drafts[id]; delete st.detail[id]; }
      if (st.cycle?.counts) st.cycle.counts.total = Math.max(0, (st.cycle.counts.total || 0) - deleted.size);
      st.mod.analytics = undefined;
      recruitRefreshAfterRemoval(deleted);
      const failed = pending.length - deleted.size;
      toast(failed ? `${deleted.size} deleted; ${failed} could not be deleted. Try again.` : `Deleted ${deleted.size} ${deleted.size === 1 ? 'application' : 'applications'}`);
    },
  };
  render();
}

/* ------------------------------- add / import / copy --------------------- */

function recruitPersonFields(m, cycle) {
  const teams = [{ value: '', label: 'Undecided' }, ...recruitSubteams(cycle).map((t) => ({ value: t.name, label: t.name }))];
  const years = [{ value: '', label: 'Not provided' }, ...RECRUIT_YEARS.map((y) => ({ value: y, label: y }))];
  return `<label>Name<input class="text-input" data-m="recruit-add-name" value="${MD.esc(m.name || '')}" maxlength="100" autocomplete="off" spellcheck="false"></label>
    <label>Email<input class="text-input" data-m="recruit-add-email" value="${MD.esc(m.email || '')}" maxlength="200" inputmode="email" autocomplete="off" spellcheck="false"></label>
    <label>Subteam${dd('recruit-add-subteam', teams, m.subteam || '')}</label>
    <label>Year${dd('recruit-add-year', years, m.year || '')}</label>`;
}

function recruitAddModalHtml(m) {
  const cycle = recruitCycleRow();
  return `<div class="modal" role="dialog" aria-label="Add a person">
    <div class="modal__head"><h3>Add a person</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body">${recruitPersonFields(m, cycle)}<p class="field-error" role="alert" ${m.error ? '' : 'hidden'}>${MD.esc(m.error || '')}</p></div>
    <div class="modal__foot"><button class="btn" data-action="modal-close">Cancel</button><button class="btn btn--primary" data-action="recruit-add-go" ${m.busy ? 'disabled' : ''}>${m.busy ? 'Adding…' : 'Add'}</button></div>
  </div>`;
}

function recruitModalSay(m, text, selector = '.modal .field-error') {
  m.error = text;
  const el = $(selector);
  if (el) { el.textContent = text; el.hidden = !text; }
}

async function recruitAddGo() {
  const m = UI.modal;
  const cycle = recruitCycleRow();
  if (m?.kind !== 'recruit-add' || m.busy || !cycle) return;
  Object.assign(m, {
    name: String($('.modal [data-m="recruit-add-name"]')?.value || '').trim(),
    email: String($('.modal [data-m="recruit-add-email"]')?.value || '').trim().toLowerCase(),
    subteam: $('.modal [data-m="recruit-add-subteam"]')?.dataset.value || '',
    year: $('.modal [data-m="recruit-add-year"]')?.dataset.value || '',
  });
  if (!m.name) { recruitModalSay(m, 'A name is needed.'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email)) { recruitModalSay(m, 'That email does not look right.'); return; }
  m.requestId ||= recruitId('rq');
  m.busy = true;
  recruitModalSay(m, '');
  const go = $('.modal [data-action="recruit-add-go"]');
  if (go) { go.disabled = true; go.textContent = 'Adding…'; }
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/applications`, { method: 'POST', body: JSON.stringify({ requestId: m.requestId, name: m.name, email: m.email, subteam: m.subteam || undefined, year: m.year || undefined }) });
    const st = recruitState();
    const row = recruitRowFromApplication(out.application);
    if (row && st.apps?.rows && !st.apps.byId[row.id]) { st.apps.rows.unshift(row); st.apps.byId[row.id] = row; st.apps.total += 1; if (st.cycle?.counts) { st.cycle.counts.total = (st.cycle.counts.total || 0) + 1; st.cycle.counts.byStage ||= {}; st.cycle.counts.byStage[row.stage] = (st.cycle.counts.byStage[row.stage] || 0) + 1; } }
    toast(`Added ${m.name}`);
    if (UI.modal === m) closeModal(() => { if (!recruitPaintRows()) renderBackground('recruit'); });
  } catch (e) {
    m.busy = false;
    if (UI.modal === m) { recruitModalSay(m, e.status === 409 ? 'Someone with that email is already in this cycle.' : recruitError(e)); if (go) { go.disabled = false; go.textContent = 'Add'; } }
  }
}

// A small CSV reader: quoted fields, doubled quotes, CRLF.
function recruitParseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function recruitGuessColumn(headers, names) {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const n of names) { const i = lower.findIndex((h) => h === n || h.includes(n)); if (i >= 0) return String(i); }
  return '';
}

function recruitImportRows(m) {
  const rows = recruitParseCsv(m.text || '');
  if (!rows.length) return { headers: [], rows: [], people: [] };
  const headers = rows[0];
  const body = rows.slice(1);
  const col = (k) => (m.cols?.[k] === '' || m.cols?.[k] === undefined ? -1 : Number(m.cols[k]));
  const people = body.map((r) => ({ name: String(r[col('name')] ?? '').trim(), email: String(r[col('email')] ?? '').trim().toLowerCase(), subteam: col('subteam') >= 0 ? String(r[col('subteam')] ?? '').trim() : '', year: col('year') >= 0 ? String(r[col('year')] ?? '').trim() : '' }))
    .filter((p) => p.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email));
  return { headers, rows: body, people };
}

function recruitImportModalHtml(m) {
  const { headers, rows, people } = recruitImportRows(m);
  m.cols ||= {};
  if (headers.length && !m.guessed) { m.guessed = true; m.cols.name ||= recruitGuessColumn(headers, ['name']); m.cols.email ||= recruitGuessColumn(headers, ['email', 'mail']); m.cols.subteam ||= recruitGuessColumn(headers, ['subteam', 'team']); m.cols.year ||= recruitGuessColumn(headers, ['year', 'class']); }
  const options = [{ value: '', label: 'Skip' }, ...headers.map((h, i) => ({ value: String(i), label: h.trim() || `Column ${i + 1}` }))];
  const map = headers.length ? `<div class="rc-import-cols">
      <label>Name${dd('recruit-import-col-name', options, m.cols.name || '')}</label>
      <label>Email${dd('recruit-import-col-email', options, m.cols.email || '')}</label>
      <label>Subteam${dd('recruit-import-col-subteam', options, m.cols.subteam || '')}</label>
      <label>Year${dd('recruit-import-col-year', options, m.cols.year || '')}</label>
    </div>` : '';
  const n = recruitImportRows(m).people.length;
  return `<div class="modal modal--wide" role="dialog" aria-label="Import CSV">
    <div class="modal__head"><h3>Import CSV</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body">
      <label>Paste a CSV with a header row<textarea class="text-input" data-m="recruit-import-text" rows="8" spellcheck="false" placeholder="Name,Email,Subteam,Year">${MD.esc(m.text || '')}</textarea></label>
      ${map}
      <p class="sheet__note" style="margin:0" data-rc="import-count">${headers.length ? `${MD.esc(recruitPlural(n, 'person', 'people'))} with an email in ${MD.esc(recruitPlural(rows.length, 'row'))}` : 'Columns are matched from the header row.'}</p>
      <p class="field-error" role="alert" ${m.error ? '' : 'hidden'}>${MD.esc(m.error || '')}</p>
    </div>
    <div class="modal__foot"><button class="btn" data-action="modal-close">Cancel</button><button class="btn btn--primary" data-action="recruit-import-go" ${m.busy || !n ? 'disabled' : ''}>${m.busy ? 'Importing…' : n ? `Import ${n}` : 'Import'}</button></div>
  </div>`;
}

function recruitImportRepaint(m) {
  const { headers, rows, people } = recruitImportRows(m);
  const count = $('.modal [data-rc="import-count"]');
  if (count) count.textContent = headers.length ? `${recruitPlural(people.length, 'person', 'people')} with an email in ${recruitPlural(rows.length, 'row')}` : 'Columns are matched from the header row.';
  const go = $('.modal [data-action="recruit-import-go"]');
  if (go && !m.busy) { go.disabled = !people.length; go.textContent = people.length ? `Import ${people.length}` : 'Import'; }
}

async function recruitImportPeople(cycle, people, requestId) {
  let created = 0; const skipped = [];
  for (let i = 0; i < people.length; i += 500) {
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/applications`, { method: 'POST', body: JSON.stringify({ requestId: `${requestId}-${i / 500}`, import: people.slice(i, i + 500).map((p) => ({ name: p.name || p.email, email: p.email, subteam: p.subteam || undefined, year: RECRUIT_YEARS.includes(p.year) ? p.year : undefined })) }), signal: AbortSignal.timeout(60000) });
    created += Number(out.created || 0);
    skipped.push(...(out.skipped || []));
  }
  return { created, skipped };
}

async function recruitImportGo() {
  const m = UI.modal;
  const cycle = recruitCycleRow();
  if (m?.kind !== 'recruit-import' || m.busy || !cycle) return;
  const { people } = recruitImportRows(m);
  if (!people.length) { recruitModalSay(m, 'No rows with an email to import.'); return; }
  if (people.length > 2000) { recruitModalSay(m, 'Import at most 2,000 people at a time.'); return; }
  m.requestId ||= recruitId('rq');
  m.busy = true;
  recruitModalSay(m, '');
  const go = $('.modal [data-action="recruit-import-go"]');
  if (go) { go.disabled = true; go.textContent = 'Importing…'; }
  try {
    const { created, skipped } = await recruitImportPeople(cycle, people, m.requestId);
    const st = recruitState();
    st.cycles = undefined;
    toast(`Imported ${created}${skipped.length ? ` · ${skipped.length} skipped` : ''}`);
    if (UI.modal === m) closeModal(() => { recruitLoadApps(); renderBackground('recruit'); });
  } catch (e) {
    m.busy = false;
    if (UI.modal === m) { recruitModalSay(m, recruitError(e)); if (go) { go.disabled = false; go.textContent = `Import ${people.length}`; } }
  }
}

function recruitCopyModalHtml(m) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const others = (st.cycles?.list || []).filter((c) => c.id !== cycle?.id);
  const options = [{ value: '', label: 'Choose a cycle' }, ...others.map((c) => ({ value: c.id, label: `${c.name} · ${recruitPlural(c.counts?.total || 0, 'application')}` }))];
  return `<div class="modal" role="dialog" aria-label="Copy from another cycle">
    <div class="modal__head"><h3>Copy from another cycle</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body">
      <label>Cycle${dd('recruit-copy-from', options, m.from || '')}</label>
      <p class="sheet__note" style="margin:0">People already in ${MD.esc(cycle?.name || 'this cycle')} are skipped. Only names, emails, subteams and years are copied.</p>
      <p class="field-error" role="alert" ${m.error ? '' : 'hidden'}>${MD.esc(m.error || '')}</p>
    </div>
    <div class="modal__foot"><button class="btn" data-action="modal-close">Cancel</button><button class="btn btn--primary" data-action="recruit-copy-go" ${m.busy ? 'disabled' : ''}>${m.busy ? 'Copying…' : 'Copy'}</button></div>
  </div>`;
}

async function recruitCopyGo() {
  const m = UI.modal;
  const cycle = recruitCycleRow();
  if (m?.kind !== 'recruit-copy' || m.busy || !cycle) return;
  m.from = $('.modal [data-m="recruit-copy-from"]')?.dataset.value || '';
  if (!m.from) { recruitModalSay(m, 'Choose a cycle to copy from.'); return; }
  m.requestId ||= recruitId('rq');
  m.busy = true;
  recruitModalSay(m, '');
  const go = $('.modal [data-action="recruit-copy-go"]');
  if (go) { go.disabled = true; go.textContent = 'Copying…'; }
  try {
    const people = [];
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(m.from)}/applications?limit=200${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
      for (const r of out.rows || []) people.push({ name: r.name, email: r.email, subteam: r.subteam, year: r.year });
      cursor = out.next || null;
      if (!cursor) break;
    }
    const { created, skipped } = await recruitImportPeople(cycle, people, m.requestId);
    const st = recruitState();
    st.cycles = undefined;
    toast(`Copied ${created}${skipped.length ? ` · ${skipped.length} already here` : ''}`);
    if (UI.modal === m) closeModal(() => { recruitLoadApps(); renderBackground('recruit'); });
  } catch (e) {
    m.busy = false;
    if (UI.modal === m) { recruitModalSay(m, recruitError(e)); if (go) { go.disabled = false; go.textContent = 'Copy'; } }
  }
}

/* ------------------------------- saved views ----------------------------- */

function recruitViewModalHtml(m) {
  const cycle = recruitCycleRow();
  const views = Array.isArray(cycle?.doc?.pipeline?.views) ? cycle.doc.pipeline.views : [];
  const manage = m.mode === 'manage';
  return `<div class="modal" role="dialog" aria-label="${manage ? 'Manage views' : 'Save view'}">
    <div class="modal__head"><h3>${manage ? 'Saved views' : 'Save this view'}</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body">
      ${manage ? `<div class="audit">${views.map((v) => `<div class="audit__row"><span class="audit__what"><b>${MD.esc(v.name)}</b></span><button class="btn btn--sm btn--danger" style="margin-left:auto" data-action="recruit-view-delete" data-key="${MD.esc(v.key)}">Delete</button></div>`).join('') || '<div class="audit__row"><span class="audit__what faint">No saved views.</span></div>'}</div>`
        : `<label>Name<input class="text-input" data-m="recruit-view-name" value="${MD.esc(m.name || '')}" maxlength="40" placeholder="e.g. Electrical, unscored" autocomplete="off"></label>
           <p class="sheet__note" style="margin:0">Saves the current search, filters and sort for everyone in this cycle.</p>`}
      <p class="field-error" role="alert" ${m.error ? '' : 'hidden'}>${MD.esc(m.error || '')}</p>
    </div>
    <div class="modal__foot"><button class="btn" data-action="modal-close">${manage ? 'Close' : 'Cancel'}</button>${manage ? '' : `<button class="btn btn--primary" data-action="recruit-view-save" ${m.busy ? 'disabled' : ''}>Save view</button>`}</div>
  </div>`;
}

async function recruitPutViews(views) {
  const cycle = recruitCycleRow();
  const pipeline = { ...(cycle.doc?.pipeline || {}), stages: recruitStages(cycle), views };
  const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/settings/pipeline`, { method: 'PUT', body: JSON.stringify({ version: cycle.version, settings: pipeline }) });
  recruitAdoptCycle(out.cycle);
}

async function recruitViewSave() {
  const m = UI.modal;
  const cycle = recruitCycleRow();
  if (m?.kind !== 'recruit-view' || m.busy || !cycle) return;
  const name = String($('.modal [data-m="recruit-view-name"]')?.value || '').trim();
  if (!name) { recruitModalSay(m, 'A view needs a name.'); return; }
  m.busy = true;
  const f = recruitFilters(cycle.id);
  const key = recruitSlug(name) || 'view';
  const views = (cycle.doc?.pipeline?.views || []).filter((v) => v.key !== key);
  views.push({ key, name, query: { ...f } });
  try {
    await recruitPutViews(views);
    toast(`Saved view ${name}`);
    if (UI.modal === m) closeModal(() => renderBackground('recruit'));
  } catch (e) { m.busy = false; if (UI.modal === m) recruitModalSay(m, e.status === 409 ? 'This cycle changed. Reload and try again.' : recruitError(e)); }
}

function recruitApplyView(key) {
  const cycle = recruitCycleRow();
  const v = (cycle?.doc?.pipeline?.views || []).find((x) => x.key === key);
  if (!v) return;
  const f = recruitFilters(cycle.id);
  Object.assign(f, { ...RECRUIT_FILTER_DEFAULTS, ...(v.query || {}) });
  render();
  recruitLoadApps();
}

/* ------------------------------- register -------------------------------- */

RECRUIT.register({
  name: 'applications',
  order: 10,
  kernel: true,
  panel: { id: 'applications', label: 'Applications', order: 10, when: () => true },
  view: recruitApplicationsView,
  mount(cycle) {
    const st = recruitState();
    if (st.apps === undefined || st.apps.key !== st.key + ':' + cycle.id) recruitLoadApps();
    if (st.cycles?.intakeCycleId === cycle.id && recruitIsAdmin() && st.queue === undefined) recruitLoadQueue();
  },
  filters: (cycle) => recruitCoreFilters(cycle),
  actions: {
    'recruit-apps-refresh': () => { recruitLoadApps(); },
    'recruit-load-more': () => { recruitLoadApps(true); },
    'recruit-stage': (el) => {
      const cycle = recruitCycleRow();
      if (!cycle) return;
      recruitFilters(cycle.id).stage = el.dataset.stage || '';
      for (const b of $$('.rc-strip__stage')) b.setAttribute('aria-pressed', String((b.dataset.stage || '') === (el.dataset.stage || '')));
      recruitLoadApps();
    },
    'recruit-sort': (el) => {
      const cycle = recruitCycleRow();
      if (!cycle) return;
      const f = recruitFilters(cycle.id);
      const key = el.dataset.key;
      const firstDir = key === 'ts' || key === 'updated' || key === 'stage_at' || key === 'score' ? 'desc' : 'asc';
      if (f.sort === key) f.dir = f.dir === 'asc' ? 'desc' : 'asc'; else { f.sort = key; f.dir = firstDir; }
      for (const btn of $$('.sheet--recruit .sheet__sort[data-key]')) {
        const on = btn.dataset.key === f.sort;
        btn.classList.toggle('on', on);
        btn.closest('th')?.setAttribute('aria-sort', on ? (f.dir === 'asc' ? 'ascending' : 'descending') : 'none');
        const caret = btn.querySelector('.sheet__caret');
        if (caret) caret.textContent = on ? (f.dir === 'asc' ? '↑' : '↓') : '';
      }
      recruitLoadApps();
    },
    'recruit-select': (el) => { const s = recruitSelection(); if (el.checked) s.add(el.dataset.id); else s.delete(el.dataset.id); recruitPaintSelection(); },
    'recruit-select-visible': (el) => { const s = recruitSelection(); for (const r of recruitVisibleRows()) { if (el.checked) s.add(r.id); else s.delete(r.id); } recruitPaintSelection(); },
    'recruit-clear-selection': () => { recruitSelection().clear(); recruitPaintSelection(); },
    'recruit-selection-act': async (el) => {
      const cycle = recruitCycleRow();
      const ids = [...recruitSelection()];
      const action = RECRUIT.selectionActions(ids, cycle, recruitRole()).find((a) => a.id === el.dataset.sel);
      if (action) await action.run(ids, cycle, el);
    },
    'recruit-copy-emails': async () => {
      const emails = recruitSelectedEmails();
      if (!emails.length) return;
      const csv = recruitEmailsCsv(emails);
      try {
        await navigator.clipboard.writeText(csv);
        toast(`Copied ${emails.length} ${emails.length === 1 ? 'email' : 'emails'} as CSV`);
      } catch {
        UI.modal = { kind: 'recruit-email-copy', csv };
        render();
        const text = $('.modal textarea');
        text?.focus(); text?.select();
      }
    },
    'recruit-remove-selected': () => recruitConfirmRemoval([...recruitSelection()]),
    'recruit-tools': (el) => {
      const st = recruitState();
      const cycle = recruitCycleRow();
      const lead = recruitCan('lead') && cycle?.status !== 'archived';
      openMenu([
        { label: 'Refresh', run: () => { st.apps = undefined; st.detail = {}; render(); } },
        ...(lead ? ['-', { label: 'Add person…', run: () => { UI.modal = { kind: 'recruit-add' }; render(); } },
          { label: 'Import CSV…', run: () => { UI.modal = { kind: 'recruit-import', text: '', cols: {} }; render(); } },
          { label: 'Copy from cycle…', run: () => { UI.modal = { kind: 'recruit-copy' }; render(); } }] : []),
      ], el);
    },
    'recruit-app-open': (el) => recruitOpenApp(el.dataset.id, { comments: Boolean(el.dataset.comments) }),
    'recruit-app-prev': () => recruitStepApp(-1),
    'recruit-app-next': () => recruitStepApp(1),
    'recruit-detail-retry': (el) => { const st = recruitState(); st.detail[el.dataset.id] = undefined; recruitLoadDetail(el.dataset.id); recruitPaintDetail(el.dataset.id); },
    'recruit-flag': (el) => recruitToggleFlag(el.dataset.id),
    'recruit-comment-form': (form) => recruitPostComment(form.dataset.id),
    'recruit-comment-delete': (el) => recruitConfirmCommentRemoval(el.dataset.id, el.dataset.cid),
    'recruit-comment-delete-cancel': (el) => recruitConfirmCommentRemoval(el.dataset.id, el.dataset.cid, true),
    'recruit-comment-delete-confirm': (el) => recruitDeleteComment(el.dataset.id, el.dataset.cid),
    'recruit-tag-form': (form) => {
      const input = $('[data-m="recruit-tag-new"]', form);
      const tag = String(input?.value || '').trim().slice(0, 30);
      if (!tag) return;
      if (input) input.value = '';
      recruitEditTags(form.dataset.id, [tag], []);
    },
    'recruit-tag-remove': (el) => recruitEditTags(el.dataset.id, [], [el.dataset.tag]),
    'recruit-queue-open': (el) => { UI.modal = { kind: 'recruit-queue', id: el.dataset.id }; render(); },
    'recruit-queue-place': (el) => recruitOpenQueuePlace(el, el.dataset.id),
    'recruit-add-go': recruitAddGo,
    'recruit-import-go': recruitImportGo,
    'recruit-copy-go': recruitCopyGo,
    'recruit-view-save': recruitViewSave,
    'recruit-view-delete': async (el) => {
      const cycle = recruitCycleRow();
      if (!cycle) return;
      try { await recruitPutViews((cycle.doc?.pipeline?.views || []).filter((v) => v.key !== el.dataset.key)); toast('View deleted'); renderBackground('recruit'); const row = el.closest('.audit__row'); row?.remove(); }
      catch (e) { toast(`Could not delete: ${recruitError(e)}`); }
    },
  },
  inputs: {
    'recruit-q': (el) => {
      const cycle = recruitCycleRow();
      if (!cycle) return;
      recruitFilters(cycle.id).q = el.value;
      clearTimeout(recruitSearchTimer);
      recruitSearchTimer = setTimeout(() => recruitLoadApps(), 250);
    },
    'recruit-comment': (el) => {
      const draft = recruitDraft(el.dataset.id);
      draft.text = el.value;
      if (!draft.sending) draft.id = null;
      const button = el.closest('form')?.querySelector('[type="submit"]');
      if (button) button.disabled = draft.sending || !draft.text.trim();
    },
    'recruit-import-text': (el) => { const m = UI.modal; if (m?.kind !== 'recruit-import') return; m.text = el.value; if (!m.guessed) { render(); $('.modal [data-m="recruit-import-text"]')?.focus(); } else recruitImportRepaint(m); },
  },
  dd: {
    'recruit-filter': (host, value) => (value === undefined ? recruitOpenFilter(host) : undefined),
    'recruit-view': (host, value) => {
      if (value === undefined) return undefined;             // the default menu from data-opts
      const cycle = recruitCycleRow();
      host.dataset.value = ''; const label = host.querySelector?.('.dd__label'); if (label) label.textContent = 'Views';
      if (value === '__save') { UI.modal = { kind: 'recruit-view', mode: 'save' }; render(); }
      else if (value === '__manage') { UI.modal = { kind: 'recruit-view', mode: 'manage' }; render(); }
      else if (value && cycle) recruitApplyView(value);
    },
    'recruit-app-stage': (host, value) => { if (value !== undefined && UI.modal?.kind === 'recruit-app') recruitMoveOne(UI.modal.id, value); },
    'recruit-import-col-name': (host, value) => { if (value !== undefined && UI.modal?.kind === 'recruit-import') { UI.modal.cols.name = value; recruitImportRepaint(UI.modal); } },
    'recruit-import-col-email': (host, value) => { if (value !== undefined && UI.modal?.kind === 'recruit-import') { UI.modal.cols.email = value; recruitImportRepaint(UI.modal); } },
    'recruit-import-col-subteam': (host, value) => { if (value !== undefined && UI.modal?.kind === 'recruit-import') { UI.modal.cols.subteam = value; recruitImportRepaint(UI.modal); } },
    'recruit-import-col-year': (host, value) => { if (value !== undefined && UI.modal?.kind === 'recruit-import') { UI.modal.cols.year = value; recruitImportRepaint(UI.modal); } },
  },
  modals: {
    'recruit-app': recruitAppModalHtml,
    'recruit-queue': recruitQueueModalHtml,
    'recruit-add': recruitAddModalHtml,
    'recruit-import': recruitImportModalHtml,
    'recruit-copy': recruitCopyModalHtml,
    'recruit-view': recruitViewModalHtml,
    'recruit-email-copy': (m) => `<div class="modal" role="dialog" aria-label="Copy selected emails">
      <div class="modal__head"><h3>Selected emails</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
      <div class="modal__body"><p>Clipboard access was blocked. Select and copy this comma-separated list.</p>
        <textarea class="text-input" rows="6" readonly aria-label="Selected emails as CSV">${MD.esc(m.csv || '')}</textarea>
      </div><div class="modal__foot"><button class="btn" data-action="modal-close">Close</button></div>
    </div>`,
  },
  reset() { clearTimeout(recruitSearchTimer); recruitSearchTimer = null; },
});

// recruit:applications:end
