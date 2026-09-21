/* ============================================================================
   Applications — applications module (client). One tab per form of the
   cycle: the mode bar (open on the website, address, Responses | Edit form),
   the response sheet (server-side search, filters, sort, keyset paging), the
   selection bar (copy emails, delete), and the held-responses queue.
   ========================================================================== */

'use strict';

// recruit:applications:start

/* ------------------------------- filters --------------------------------- */

const RECRUIT_FILTER_DEFAULTS = { q: '', subteam: '', year: '', sort: 'ts', dir: 'desc' };

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
  return [
    ...(recruitFormAsks(cycle, 'subteam') ? [
      { group: 'subteam', value: '', label: 'All subteams' },
      ...[...teams, ...rowTeams].map((name) => ({ group: 'subteam', value: name, label: name, query: { subteam: name } })),
      { group: 'subteam', value: '__undecided', label: 'Undecided', test: (r) => !String(r.subteam || '').trim() },
    ] : []),
    ...(recruitFormAsks(cycle, 'year') ? [
      { group: 'year', value: '', label: 'All years' },
      ...RECRUIT_YEARS.map((y) => ({ group: 'year', value: y, label: y, query: { year: y } })),
    ] : []),
  ];
}

const RECRUIT_FILTER_GROUPS = ['subteam', 'year'];

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
  p.set('section', recruitSection());
  if (f.q?.trim()) p.set('q', f.q.trim());
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
  if (!more) st.apps = { key: st.key + ':' + cycle.id + ':' + recruitSection(), rows: [], byId: {}, next: null, total: 0, counts: st.apps?.counts || null, loading: true, error: null };
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
    if (out.counts) { apps.counts = out.counts; if (st.cycle) st.cycle.counts = { ...(st.cycle.counts || {}), bySection: out.counts.bySection || st.cycle.counts?.bySection || {} }; }
    apps.loading = false;
  } catch (e) {
    if (st.key !== key || st.apps !== apps || seq !== recruitListSeq) return;
    apps.loading = false;
    apps.error = recruitError(e);
  }
  if (!recruitPaintRows()) renderBackground('recruit');
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
  return `<span data-rc-selection-count role="status">${ids.length} selected${hidden ? ` · ${hidden} hidden by filter` : ''}</span>
    <button class="btn" data-action="recruit-copy-emails">${I.copy} Copy emails</button>
    ${recruitCan('admin') && cycle?.status !== 'archived' ? `<button class="btn btn--danger" data-action="recruit-remove-selected">${I.trash} Delete</button>` : ''}
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

// Year and Subteam are columns only when this form asks for them.
const recruitFormAsks = (cycle, key) => (recruitSections(cycle)[recruitSection()]?.form?.questions || []).some((q) => q.key === key);
function recruitBaseColumns(cycle) {
  return [
    ...(recruitFormAsks(cycle, 'year') ? [{ id: 'year', label: 'Year', sortKey: null, cell: (r) => (r.year ? MD.esc(r.year) : '<span class="faint">—</span>') }] : []),
    ...(recruitFormAsks(cycle, 'subteam') ? [{ id: 'subteam', label: 'Subteam', sortKey: null, cell: (r) => MD.esc(r.subteam || 'Undecided') }] : []),
  ];
}

function recruitAllColumns(cycle, role) {
  const base = recruitBaseColumns(cycle);
  const extra = RECRUIT.columns(cycle, role).filter((c) => !base.some((b) => b.id === c.id) && !['check', 'person', 'received'].includes(c.id));
  return [...base, ...extra];
}

function recruitRowHtml(r, cycle, cols, selected) {
  return `<tr data-id="${MD.esc(r.id)}" class="${selected.has(r.id) ? 'is-selected' : ''}">
    <td class="sheet__check-cell" data-col="check"><label class="sheet__check"><input type="checkbox" data-action="recruit-select" data-id="${MD.esc(r.id)}" aria-label="Select ${MD.esc(r.name)} (${MD.esc(r.email)})" ${selected.has(r.id) ? 'checked' : ''}></label></td>
    <td data-col="person"><button class="interest-person" data-action="recruit-person-open" data-email="${MD.esc(r.email)}" data-form="${MD.esc(r.section || recruitSection())}" aria-label="Open ${MD.esc(r.name)}"><b>${MD.esc(r.name)}</b><span class="mail">${MD.esc(r.email)}</span></button></td>
    ${cols.map((c) => { let cell = ''; try { cell = String(c.cell?.(r, cycle) ?? ''); } catch (e) { cell = ''; } return `<td data-col="${MD.esc(c.id)}">${cell}</td>`; }).join('')}
    <td class="interest-when" data-col="received" title="${MD.esc(new Date(Number(r.ts)).toLocaleString())}">${recruitDate(Number(r.ts))}</td>
  </tr>`;
}

function recruitRowsHtml(rows, cycle) {
  const st = recruitState();
  const cols = recruitAllColumns(cycle, recruitRole());
  const span = cols.length + 3;
  if (!st.apps || (st.apps.loading && !st.apps.rows.length)) return `<tr class="sheet__empty"><td colspan="${span}">Loading…</td></tr>`;
  if (st.apps?.error && !st.apps.rows.length) return `<tr class="sheet__empty"><td colspan="${span}">Could not load: ${MD.esc(st.apps.error)}. <button class="linklike" data-action="recruit-apps-refresh">Retry</button></td></tr>`;
  if (!rows.length) return `<tr class="sheet__empty"><td colspan="${span}">${st.apps?.rows?.length || recruitHasFilter(cycle) ? 'No one matches.' : 'No one yet.'}</td></tr>`;
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
  const section = recruitSection();
  const exportHref = `/api/recruit/cycles/${encodeURIComponent(cycle.id)}/applications.csv?section=${section}`;
  return `<div class="sheet sheet--recruit ${archived ? 'sheet--archived' : ''}">
    <div class="sheet__bar">
      <div class="sheet__search-wrap">${I.search}<input class="text-input sheet__search" data-m="recruit-q" type="search" placeholder="Search people…" value="${MD.esc(f.q || '')}" aria-label="Search by name or email" autocomplete="off" spellcheck="false"></div>
      <div class="sheet__actions" data-recruit-tools ${selected.size ? 'hidden' : ''}>
        ${dd('recruit-filter', [{ value: 'combined', label: recruitFilterLabel(cycle) }], 'combined')}
        ${lead ? `<a class="btn" href="${MD.esc(exportHref)}" download>${RC_ICONS.download} Export</a>` : ''}
      </div>
      <div class="sheet__actions sheet__selection" data-recruit-selection ${selected.size ? '' : 'hidden'}>${selected.size ? recruitSelectionBarHtml() : ''}</div>
    </div>
    <div class="sheet__scroll"><table aria-label="${MD.esc(recruitSectionTitle(section, cycle))} in ${MD.esc(cycle.name)}">
      <thead><tr>
        <th class="sheet__check-cell" data-col="check"><label class="sheet__check"><input type="checkbox" data-action="recruit-select-visible" aria-label="Select all visible people" ${rows.length && visibleSelected === rows.length ? 'checked' : ''} ${rows.length ? '' : 'disabled'}></label></th>
        ${th('name', 'Person', 'person')}${cols.map((c) => th(c.sortKey, c.label, c.id)).join('')}${th('ts', 'Received', 'received')}
      </tr></thead>
      <tbody>${recruitRowsHtml(rows, cycle)}</tbody>
    </table></div>
    <div class="sheet__foot" role="status">${recruitFootHtml()}</div>
  </div>`;
}

// A section tab: Responses (the sheet) or Form (the editor), behind one bar.
function recruitApplicationsView(cycle, role, panel) {
  const st = recruitState();
  const editing = recruitEditingForm();
  const bar = recruitModeBarHtml(cycle, panel, editing);
  if (editing) return bar + recruitFormEditorHtml(cycle, panel);
  // Held responses belong to the cycle receiving the website, whichever form they name.
  const pending = st.cycles?.intakeCycleId === cycle.id && recruitIsAdmin() ? `<div data-rc="queue">${recruitPendingHtml()}</div>` : '';
  return bar + recruitSheetHtml(cycle) + pending;
}

/* ------------------------------- queue block ----------------------------- */

function recruitPendingReason(reason) {
  if (reason === 'duplicate') return 'Same email as an earlier response';
  if (reason === 'capacity') return 'The form was full';
  if (reason === 'replay_failed') return 'Could not be written to its form yet';
  if (reason === 'unsynced') return 'Not yet written to its form';
  if (reason === 'legacy') return 'Sent to the old list';
  return 'Waiting to join its form';
}

function recruitPendingHtml() {
  const st = recruitState();
  if (!recruitIsAdmin()) return '';
  const q = st.queue;
  if (!q || q.loading) return '';
  const unavailable = q.error || q.queueUnavailable
    ? `<p class="sheet__note" role="status">Could not check for held responses. <button class="linklike" data-action="recruit-queue-sync">Retry</button></p>` : '';
  const pending = q.pending || [];
  if (!pending.length) return unavailable;
  return `<section aria-labelledby="recruit-pending-heading">
    <h2 class="sheet__heading" id="recruit-pending-heading">Held responses <span class="count">${pending.length}</span></h2>
    <p class="sheet__note">Saved in the receipt journal; not yet on a form's list or in its CSV.</p>
    ${unavailable}
    <div class="sheet sheet--list">${pending.map((r) => `<div class="sheet__archive rc-pending">
      <button class="interest-person" data-action="recruit-queue-open" data-id="${MD.esc(r.id)}" aria-label="Review the held response from ${MD.esc(r.name)}"><b>${MD.esc(r.name)}</b><span class="mail">${MD.esc(r.email)}</span></button>
      <span class="sheet__archivemeta">${r.sectionTitle ? MD.esc(r.sectionTitle) + ' · ' : ''}${MD.esc(recruitPendingReason(r.reason))}</span>
      <span class="interest-when" title="${MD.esc(new Date(Number(r.receivedAt)).toLocaleString())}">${recruitDate(Number(r.receivedAt))}</span>
      <button class="btn" data-action="recruit-queue-place" data-id="${MD.esc(r.id)}" aria-haspopup="menu">Place in…</button>
    </div>`).join('')}</div>
  </section>`;
}

function recruitQueueModalHtml(m) {
  const r = (recruitState().queue?.pending || []).find((row) => row.id === m.id);
  if (!r) return `<div class="modal" role="dialog" aria-label="Held response"><div class="modal__head"><h3>Held response</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div><div class="modal__body"><p>This entry is no longer waiting. Close this window to refresh.</p></div></div>`;
  const fileUrl = `/api/recruit/queue/${encodeURIComponent(r.id)}/file`;
  const questions = Array.isArray(r.questions) ? r.questions : [];
  const has = (key) => questions.some((q) => q.key === key);
  return `<div class="modal modal--wide" role="dialog" aria-label="Held response">
    <div class="modal__head"><h3>${MD.esc(r.name)}</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body">
      <p class="sheet__note">${MD.esc(recruitPendingReason(r.reason))}. Placing it copies the answers onto a form; the saved record stays.</p>
      <dl class="interest-detail">
        <dt>Email</dt><dd>${MD.esc(r.email)}</dd>
        ${r.sectionTitle ? `<dt>Form</dt><dd>${MD.esc(r.sectionTitle)}</dd>` : ''}
        ${has('subteam') || r.subteam ? `<dt>Subteam</dt><dd>${MD.esc(r.subteam || 'Undecided')}</dd>` : ''}
        ${has('year') || r.year ? `<dt>Year</dt><dd>${MD.esc(r.year || 'Not provided')}</dd>` : ''}
        <dt>Received</dt><dd>${MD.esc(new Date(Number(r.receivedAt)).toLocaleString())}</dd>
        <dt>Receipt</dt><dd>${MD.esc(r.id)}</dd>
        ${r.fileName ? `<dt>File</dt><dd>${r.fileUrl ? `<a class="interest-download" href="${MD.esc(fileUrl)}" download="${MD.esc(r.fileName)}">${MD.esc(r.fileName)}</a>` : MD.esc(r.fileName)} <span class="faint">${Math.max(1, Math.round((r.fileSize || 0) / 1024))} KB</span></dd>` : ''}
      </dl>
      ${recruitAnswersHtml({ application: { answers: r.answers || {}, files: [], section: r.section }, form: { questions } })}
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

/* ------------------------------- removal --------------------------------- */

function recruitRefreshAfterRemoval(ids) {
  const st = recruitState();
  if (st.people) recruitLoadPeople();
  st.persons = {};
  const open = UI.modal?.kind === 'recruit-person';
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
    kind: 'confirm', title: rows.length === 1 ? `Delete ${rows[0].name}?` : `Delete ${rows.length} responses?`,
    text: `${rows.slice(0, 5).map((r) => `<b>${MD.esc(r.name)}</b>`).join(', ')}${rows.length > 5 ? ` and ${rows.length - 5} more` : ''} will be removed, including comments and attachments. This cannot be undone.${hidden ? ` <b>${hidden} selected ${hidden === 1 ? 'person is' : 'people are'} hidden by your filters.</b>` : ''}`,
    confirm: rows.length === 1 ? 'Delete response' : `Delete ${rows.length} responses`, danger: true, typed: rows.length > 1 ? 'delete responses' : undefined,
    onGo: async () => {
      const pending = rows.filter((r) => !st.busy.has('delete:' + r.id));
      if (!pending.length) return;
      pending.forEach((r) => st.busy.add('delete:' + r.id));
      const results = await Promise.allSettled(pending.map((r) => RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/applications/${encodeURIComponent(r.id)}`, { method: 'DELETE' })));
      pending.forEach((r) => st.busy.delete('delete:' + r.id));
      const deleted = new Set(pending.filter((r, i) => results[i].status === 'fulfilled' || results[i].reason?.status === 404).map((r) => r.id));
      if (st.apps?.rows) { st.apps.rows = st.apps.rows.filter((r) => !deleted.has(r.id)); for (const id of deleted) delete st.apps.byId[id]; st.apps.total = Math.max(0, st.apps.total - deleted.size); }
      for (const id of deleted) st.selected?.delete(id);
      if (st.cycle?.counts) st.cycle.counts.total = Math.max(0, (st.cycle.counts.total || 0) - deleted.size);
      recruitRefreshAfterRemoval(deleted);
      const failed = pending.length - deleted.size;
      toast(failed ? `${deleted.size} deleted; ${failed} could not be deleted. Try again.` : `Deleted ${deleted.size} ${deleted.size === 1 ? 'response' : 'responses'}`);
    },
  };
  render();
}

/* ------------------------------- register -------------------------------- */

RECRUIT.register({
  name: 'applications',
  order: 10,
  kernel: true,
  panels: (cycle) => recruitSectionKeys(cycle).map((key, i) => ({ id: key, label: recruitSectionTitle(key, cycle), order: 10 + i, when: () => true })),
  view: recruitApplicationsView,
  mount(cycle) {
    const st = recruitState();
    // Placed now, in the same task as the paint: a frame callback waits for
    // a visible tab, and a background tab would show the bare fallback.
    recruitSegSlide($('.rc-seg--mode'));
    if (st.apps === undefined || st.apps.key !== st.key + ':' + cycle.id + ':' + recruitSection()) recruitLoadApps();
    if (st.cycles?.intakeCycleId === cycle.id && recruitIsAdmin() && st.queue === undefined) recruitLoadQueue();
  },
  filters: (cycle) => recruitCoreFilters(cycle),
  actions: {
    'recruit-apps-refresh': () => { recruitLoadApps(); },
    'recruit-load-more': () => { recruitLoadApps(true); },
    'recruit-sort': (el) => {
      const cycle = recruitCycleRow();
      if (!cycle) return;
      const f = recruitFilters(cycle.id);
      const key = el.dataset.key;
      const firstDir = key === 'ts' || key === 'updated' ? 'desc' : 'asc';
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
    'recruit-queue-open': (el) => { UI.modal = { kind: 'recruit-queue', id: el.dataset.id }; render(); },
    'recruit-queue-place': (el) => recruitOpenQueuePlace(el, el.dataset.id),
  },
  inputs: {
    'recruit-q': (el) => {
      const cycle = recruitCycleRow();
      if (!cycle) return;
      recruitFilters(cycle.id).q = el.value;
      clearTimeout(recruitSearchTimer);
      recruitSearchTimer = setTimeout(() => recruitLoadApps(), 250);
    },
  },
  dd: {
    'recruit-filter': (host, value) => (value === undefined ? recruitOpenFilter(host) : undefined),
  },
  modals: {
    'recruit-queue': recruitQueueModalHtml,
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
