/* ============================================================================
   Search — member-visible pages, tags, and filenames referenced by those pages.
   No separate index is persisted, so edits, deleted pages, and permission changes
   are reflected on the next query. File contents are not indexed.
   ========================================================================== */

'use strict';

const WikiSearch = (() => {
  const types = [
    { id: 'project', label: 'Projects', single: 'Project', tags: ['project', 'platform', 'competition'] },
    { id: 'procedure', label: 'Procedures', single: 'Procedure', tags: ['procedure', 'standard', 'checklist', 'runbook'] },
    { id: 'test', label: 'Test records', single: 'Test record', tags: ['test', 'test-record', 'test-results'] },
    { id: 'decision', label: 'Decisions', single: 'Decision', tags: ['decision', 'adr'] },
    { id: 'configuration', label: 'Configurations', single: 'Configuration', tags: ['configuration'] },
    { id: 'design', label: 'Design documents', single: 'Design document', tags: ['design', 'design-doc', 'board'] },
    { id: 'meeting', label: 'Meeting notes', single: 'Meeting notes', tags: ['meeting'] },
    { id: 'page', label: 'Other pages', single: 'Page', tags: [] },
  ];
  const statuses = [
    { id: 'reviewed', label: 'Reviewed' },
    { id: 'needs-review', label: 'Needs review' },
    { id: 'draft', label: 'Draft' },
    { id: 'superseded', label: 'Superseded' },
    { id: 'unreviewed', label: 'No review label' },
  ];
  const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const words = (value) => normalize(value).match(/[\p{L}\p{N}]+/gu) || [];
  const terms = (value) => [...new Set(words(String(value || '').slice(0, 300)))].slice(0, 12);
  const tagsOf = (page) => (Array.isArray(page.tags) ? page.tags : []).map(normalize);
  const typeOf = (page) => {
    const tags = tagsOf(page);
    return types.find((type) => type.tags.some((tag) => tags.includes(tag))) || types[types.length - 1];
  };
  // A recent edit is not evidence of review. Only explicit tags set a status.
  const statusOf = (page) => {
    const tags = tagsOf(page);
    const status = ['superseded', 'needs-review', 'draft', 'reviewed'].find((tag) => tags.includes(tag)) || 'unreviewed';
    return statuses.find((item) => item.id === status);
  };
  const projectRoots = (pages) => pages.filter((page) => tagsOf(page).includes('project')
    || (page.section === 'projects' && !page.parent && ['project', 'page'].includes(typeOf(page).id)));
  const projectIds = (page, roots, byId) => {
    const rootIds = new Set(roots.map((root) => root.id));
    if (rootIds.has(page.id)) return [page.id];
    const ancestors = new Set([page.id]);
    let parent = page.parent;
    while (parent && !ancestors.has(parent)) {
      // The nearest project ancestor wins over a stale or broad project tag.
      if (rootIds.has(parent)) return [parent];
      ancestors.add(parent);
      parent = byId.get(parent)?.parent;
    }
    const tags = tagsOf(page);
    const explicit = roots.filter((root) => tags.includes(normalize(root.id)));
    if (explicit.length) return explicit.map((root) => root.id);
    return roots.filter((root) => {
      const uniqueTags = tagsOf(root).filter((tag) => !types.some((type) => type.tags.includes(tag))
        && !statuses.some((status) => status.id === tag)
        && !roots.some((other) => other.id !== root.id && tagsOf(other).includes(tag)));
      return uniqueTags.some((tag) => tags.includes(tag));
    }).map((root) => root.id);
  };
  function documents(pages, getAttachment, plainText) {
    const roots = projectRoots(pages), byId = new Map(pages.map((page) => [page.id, page]));
    return pages.map((page) => {
      const body = String(page.body || '');
      // Resolve references only; never enumerate files from an intake or archive.
      const attachments = [...new Set([...body.matchAll(/att:([A-Za-z0-9-]+)/g)].map((match) => match[1]))]
        .map((id) => getAttachment(id)).filter((file) => file && typeof file.name === 'string');
      const text = plainText(body).replace(/\s*\|\s*/g, ' · ').replace(/\s+/g, ' ').trim();
      const fields = [
        { kind: 'title', value: String(page.title || ''), weight: 12 },
        { kind: 'tag', value: (page.tags || []).join(' '), weight: 8 },
        ...attachments.map((file) => ({ kind: 'file', value: file.name, weight: 9, file })),
        { kind: 'body', value: text, weight: 2 },
      ].map((field) => ({ ...field, normalized: normalize(field.value), words: words(field.value) }));
      return { page, text, fields, attachments, type: typeOf(page), status: statusOf(page), projects: projectIds(page, roots, byId) };
    });
  }
  // One mistyped, missing, extra, or transposed character. Restrict to words of
  // four characters or more so short part numbers never become broad guesses.
  function nearWord(a, b) {
    if (a.length < 4 || Math.abs(a.length - b.length) > 1) return false;
    if (a === b) return true;
    if (a.length === b.length) {
      const differences = [];
      for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) differences.push(index);
      return differences.length === 1 || (differences.length === 2 && differences[1] === differences[0] + 1 && a[differences[0]] === b[differences[1]] && a[differences[1]] === b[differences[0]]);
    }
    const short = a.length < b.length ? a : b, long = a.length < b.length ? b : a;
    let index = 0;
    while (index < short.length && short[index] === long[index]) index++;
    return short.slice(index) === long.slice(index + 1);
  }
  function snippet(text, queryTerms) {
    const normalized = normalize(text);
    const positions = queryTerms.map((term) => normalized.indexOf(term)).filter((position) => position >= 0);
    let start = positions.length ? Math.max(0, Math.min(...positions) - 42) : 0;
    if (start) {
      const boundary = text.indexOf(' ', start);
      if (boundary !== -1 && boundary - start < 20) start = boundary + 1;
    }
    const end = Math.min(text.length, start + 180);
    return (start ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
  }
  function run(docs, query = '', filters = {}, recents = [], limit = 30) {
    const queryTerms = terms(query), phrase = normalize(query).trim();
    const eligible = docs.filter((doc) => (!filters.section || doc.page.section === filters.section)
      && (!filters.project || doc.projects.includes(filters.project))
      && (!filters.type || doc.type.id === filters.type)
      && (!filters.status || doc.status.id === filters.status));
    let items = eligible.map((doc) => {
      let score = 0, hits = 0, approximate = 0;
      const matchKinds = new Set(), matchedFiles = new Set();
      for (const term of queryTerms) {
        let best = 0, guessed = false;
        for (const field of doc.fields) {
          let strength = 0;
          if (field.words.includes(term)) strength = 4;
          else if (field.normalized.includes(term)) strength = 2;
          if (strength) {
            best = Math.max(best, strength * field.weight);
            matchKinds.add(field.kind);
            if (field.file) matchedFiles.add(field.file.name);
          }
        }
        if (!best) {
          for (const field of doc.fields.filter((field) => field.kind !== 'body')) {
            if (field.words.some((word) => nearWord(term, word))) {
              best = Math.max(best, field.weight);
              guessed = true;
              matchKinds.add(field.kind);
              if (field.file) matchedFiles.add(field.file.name);
            }
          }
        }
        if (best) { hits++; score += best; if (guessed) approximate++; }
      }
      if (phrase && doc.fields[0].normalized === phrase) score += 150;
      else if (phrase && doc.fields[0].normalized.includes(phrase)) score += 55;
      if (queryTerms.length && hits === queryTerms.length) score += 120;
      return { ...doc, score, hits, approximate, matchKinds: [...matchKinds], matchedFiles: [...matchedFiles], snip: snippet(doc.text, queryTerms) };
    }).filter((item) => !queryTerms.length || item.hits > 0);
    // Prefer a complete answer over a long list of pages matching one word.
    const complete = items.filter((item) => item.hits === queryTerms.length);
    const partial = !!queryTerms.length && !complete.length && !!items.length;
    if (queryTerms.length && complete.length) items = complete;
    const recentOrder = new Map(recents.map((id, index) => [id, index]));
    items.sort((a, b) => {
      if (queryTerms.length) return b.hits - a.hits || a.approximate - b.approximate || b.score - a.score || Number(b.page.updated || 0) - Number(a.page.updated || 0) || a.page.title.localeCompare(b.page.title);
      return (recentOrder.get(a.page.id) ?? Infinity) - (recentOrder.get(b.page.id) ?? Infinity) || Number(b.page.updated || 0) - Number(a.page.updated || 0) || a.page.title.localeCompare(b.page.title);
    });
    return { items: items.slice(0, limit), total: items.length, partial, kind: queryTerms.length ? 'search' : 'browse' };
  }
  function highlight(value, query, escape) {
    const parts = terms(query).sort((a, b) => b.length - a.length);
    if (!parts.length) return escape(value);
    // Terms are letters and numbers only; none can inject a regex or markup.
    const pattern = new RegExp('(' + parts.join('|') + ')', 'giu');
    return String(value || '').split(pattern).map((part, index) => index % 2 ? '<mark>' + escape(part) + '</mark>' : escape(part)).join('');
  }
  return { types, statuses, terms, normalize, typeOf, statusOf, projectRoots, documents, run, nearWord, highlight };
})();

let searchReturnFocus = null;
let searchHomeFocus = null;
let searchFilterMenu = null;
let searchFilterDismissedTrigger = null;

function searchHomeState() {
  const user = Store.me()?.email || '';
  if (!UI.searchHome || UI.searchHomeUser !== user) {
    UI.searchHome = { q: '', sel: 0, filters: {}, filtersOpen: false };
    UI.searchHomeUser = user;
  }
  return UI.searchHome;
}

function searchState(mode) { return mode === 'home' ? searchHomeState() : UI.palette; }
function searchSurface(mode) { return $(mode === 'home' ? '.search-home' : '.search-palette'); }
function searchPrefix(mode) { return mode === 'home' ? 'wiki-search-home' : 'wiki-search'; }

function openPalette(query, filters) {
  if (!Store.me()) return;
  const home = $('.search-home');
  if (home && !UI.editor && !UI.modal) {
    const state = searchHomeState();
    if (typeof query === 'string') state.q = query;
    if (filters) { state.filters = { ...filters }; state.filtersOpen = true; }
    const input = $('input', home);
    input.value = state.q;
    searchRefreshFilters('home');
    input.focus();
    return;
  }
  searchReturnFocus = document.activeElement;
  UI.palette = { q: typeof query === 'string' ? query : '', sel: 0, filters: { ...(filters || {}) }, filtersOpen: !!filters };
  render();
  $('.search-palette input')?.focus();
}

function searchResults(state) {
  if (!Store.me()) return { items: [], total: 0, kind: 'browse', partial: false };
  const documents = WikiSearch.documents(Store.s.pages, (id) => Store.att(id), (body) => MD.mdToText(body));
  const discovering = !state.q.trim() && !Object.values(state.filters || {}).some(Boolean);
  return WikiSearch.run(documents, state.q, state.filters || {}, Store.prefs().recents || [], discovering ? 4 : 30);
}

function paletteResults() { return searchResults(UI.palette); }

function searchFilterGroups() {
  return [
    { id: 'project', label: 'All projects', options: WikiSearch.projectRoots(Store.s.pages).map((page) => ({ id: page.id, label: page.title })) },
    { id: 'type', label: 'Any document', options: WikiSearch.types },
    { id: 'status', label: 'Any review status', options: WikiSearch.statuses },
    { id: 'section', label: 'All sections', options: SECTIONS.map((section) => ({ id: section.id, label: section.name })) },
  ];
}

function searchFilterLabel(group, value) { return group.options.find((option) => option.id === value)?.label || group.label; }
function searchFilterName(id) { return 'Filter by ' + (id === 'status' ? 'review status' : id); }

function searchFilterHtml(state) {
  const filters = state.filters || {};
  return searchFilterGroups().map((group) => `<button type="button" class="search-filter ${filters[group.id] ? 'is-set' : ''}" data-search-filter="${group.id}" data-value="${MD.esc(filters[group.id] || '')}" aria-label="${searchFilterName(group.id)}" aria-haspopup="menu" aria-expanded="false"><span data-search-filter-label>${MD.esc(searchFilterLabel(group, filters[group.id]))}</span>${I.chev}</button>`).join('');
}

function searchSetFilter(mode, id, value) {
  const group = searchFilterGroups().find((item) => item.id === id);
  if (!group || (value !== '' && !group.options.some((option) => option.id === value))) return false;
  const state = searchState(mode);
  if (!state) return false;
  state.filters ||= {};
  state.filters[id] = value;
  state.sel = 0;
  searchRefreshFilters(mode);
  return true;
}

function searchFilterChoices(group) { return [{ id: '', label: group.label }, ...group.options]; }
function searchFilterMenuHtml(choices, value) {
  return choices.map((option, index) => `<button type="button" role="menuitemradio" aria-checked="${option.id === value}" data-search-choice="${index}" tabindex="-1"><span class="search-filter-check" aria-hidden="true">${option.id === value ? I.check : ''}</span><span class="search-filter-option-label">${MD.esc(option.label)}</span></button>`).join('');
}

function searchOpenFilter(anchor) {
  const mode = anchor.closest('[data-search-mode]')?.dataset.searchMode;
  const group = searchFilterGroups().find((item) => item.id === anchor.dataset.searchFilter);
  if (!mode || !group) return;
  if (searchFilterMenu?.anchor === anchor && searchFilterMenu.host.isConnected) { searchFilterMenu.close(); return; }
  window.__closeMenu?.();
  const state = searchState(mode), value = state.filters[group.id] || '', choices = searchFilterChoices(group);
  const host = document.createElement('div');
  host.id = searchPrefix(mode) + '-filter-menu';
  host.className = 'menu search-filter-menu';
  host.setAttribute('role', 'menu');
  host.setAttribute('aria-label', searchFilterName(group.id));
  host.innerHTML = searchFilterMenuHtml(choices, value);
  UI.menu = { searchFilter: group.id };
  const baseClose = mountMenu(host, anchor);
  const close = () => {
    if (searchFilterMenu?.host === host) searchFilterMenu = null;
    anchor.setAttribute('aria-expanded', 'false');
    anchor.removeAttribute('aria-controls');
    baseClose();
  };
  searchFilterMenu = { host, anchor, choices, close, typed: '', typedAt: 0 };
  window.__closeMenu = close;
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', host.id);
  // mountMenu supplies the established surface and lifecycle. Keep its popup
  // inside the viewport even when a long list opens near the screen edge.
  host.style.left = Math.max(8, Math.min(anchor.getBoundingClientRect().left, innerWidth - host.offsetWidth - 8)) + 'px';
  host.style.top = Math.max(8, Math.min(parseFloat(host.style.top) || 8, innerHeight - host.offsetHeight - 8)) + 'px';
  const selected = choices.findIndex((option) => option.id === value);
  const selectedButton = $$('[data-search-choice]', host)[Math.max(0, selected)];
  selectedButton?.focus();
  selectedButton?.scrollIntoView({ block: 'nearest' });
  host.addEventListener('click', (event) => {
    const choice = event.target.closest('[data-search-choice]');
    if (!choice) return;
    const option = choices[Number(choice.dataset.searchChoice)];
    if (!option) return;
    close();
    searchSetFilter(mode, group.id, option.id);
  });
}

function searchControlsHtml(state) {
  const count = Object.values(state.filters || {}).filter(Boolean).length;
  return `<div class="search-controls"><details class="search-filter-disclosure" ${state.filtersOpen ? 'open' : ''}><summary>Filters <span data-search-active>${count || ''}</span>${I.chev}</summary><div class="search-filters">${searchFilterHtml(state)}</div></details><button data-search-reset="all" class="search-reset" ${!state.q && !count ? 'hidden' : ''}>Reset</button></div>`;
}

function searchListHtml(state, mode = 'modal') {
  const { items, total, partial } = searchResults(state);
  const query = state.q.trim(), filters = state.filters || {};
  const filtered = Object.values(filters).some(Boolean);
  const compact = mode === 'home' && !query && !filtered;
  const mark = (value) => WikiSearch.highlight(value, query, MD.esc);
  const prefix = searchPrefix(mode);
  state.count = items.length;
  state.sel = Math.max(0, Math.min(state.sel || 0, items.length - 1));
  const description = query ? (partial ? 'Partial matches' : 'Search results') : (filtered ? 'Matching pages' : 'Recent pages');
  const status = total ? `${total} ${total === 1 ? 'page' : 'pages'}${total > items.length ? ` · showing ${items.length}` : ''}` : 'No matches';
  state.announcement = `${status}. ${description}.`;
  if (!items.length && !query && !filtered) return `<div id="${prefix}-results" role="listbox" aria-label="Wiki search results"></div>`;
  return `<div class="search-results-head"><span>${description}</span><span>${status}</span></div>
    ${partial ? '<p class="search-partial">No page matches every word. These match part of your search.</p>' : ''}
    <div id="${prefix}-results" role="listbox" aria-label="Wiki search results">${items.map((item, index) => {
      const element = mode === 'home' ? 'a' : 'button';
      const action = mode === 'home' ? `href="#/page/${encodeURIComponent(item.page.id)}"` : `data-action="palette-go" data-id="${MD.esc(item.page.id)}"`;
      return `<${element} id="${prefix}-result-${index}" class="palette__item search-result ${compact ? 'search-result--recent' : ''} ${index === state.sel ? 'sel' : ''}" ${action} role="option" aria-selected="${index === state.sel}" tabindex="${mode === 'home' ? '0' : '-1'}">
      <span class="search-result-icon" aria-hidden="true">${item.type.id === 'project' ? I.cube : item.type.id === 'procedure' ? I.check : item.type.id === 'test' ? I.bolt : item.type.id === 'decision' ? I.link : I.page}</span>
      <span class="search-result-content">${!compact ? `<span class="search-result-meta"><span>${MD.esc(SECTIONS.find((section) => section.id === item.page.section)?.name || 'Wiki')}</span><span aria-hidden="true">/</span><span>${item.type.single}</span>${item.status.id !== 'unreviewed' ? `<span class="search-status search-status--${item.status.id}">${item.status.id === 'reviewed' ? I.check : ''}${item.status.label}</span>` : ''}</span>` : ''}
      <span class="palette__title">${mark(item.page.title)}</span>
      ${item.matchedFiles.length ? `<span class="search-result-file">${I.paperclip}<span>${mark(item.matchedFiles.join(' · '))}</span></span>` : ''}
      ${item.snip && !compact ? `<span class="palette__snip">${mark(item.snip)}</span>` : ''}
      ${item.approximate ? '<span class="search-result-hint">Close spelling match</span>' : ''}</span>
      ${compact ? `<span class="search-recent-section">${MD.esc(SECTIONS.find((section) => section.id === item.page.section)?.name || '')}</span>` : ''}<span class="search-result-enter" aria-hidden="true">↵</span></${element}>`;
    }).join('')}</div>
    ${!items.length ? `<div class="search-empty"><span class="search-empty-icon" aria-hidden="true">${I.search}</span><strong>${query ? `No pages found for “${MD.esc(query)}”` : 'No pages match these filters'}</strong><div class="search-empty-actions">${filtered ? '<button class="btn btn--sm" data-search-reset="filters">Clear filters</button>' : ''}${query ? '<button class="btn btn--sm" data-search-reset="query">Clear search</button>' : ''}</div></div>` : ''}`;
}

function paletteListHtml() { return searchListHtml(UI.palette); }

function searchInputHtml(state, mode) {
  const prefix = searchPrefix(mode);
  return `${I.search}<input type="text" placeholder="Search…" value="${MD.esc(state.q)}" spellcheck="false" autocomplete="off" aria-label="Search wiki" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="${prefix}-results" ${state.count ? `aria-activedescendant="${prefix}-result-${state.sel}"` : ''}>`;
}

function viewSearchHome() {
  const active = document.activeElement;
  searchHomeFocus = !UI.modal && !UI.editor && !UI.palette && active?.matches?.('.search-home input')
    ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection } : null;
  const state = searchHomeState(), list = searchListHtml(state, 'home');
  return `<section class="search-home search-surface" data-search-mode="home" aria-labelledby="wiki-search-home-title"><header class="search-home-heading"><h1 id="wiki-search-home-title">Search the wiki</h1></header><div class="search-home-input">${searchInputHtml(state, 'home')}</div>${searchControlsHtml(state)}<div class="search-list">${list}</div><span class="search-sr" data-search-announcement role="status" aria-live="polite" aria-atomic="true">${MD.esc(state.announcement)}</span></section>`;
}

function mountSearchHome() {
  const surface = $('.search-home'), restore = searchHomeFocus;
  searchHomeFocus = null;
  if (!surface) return;
  searchSyncSelection('home');
  // A remote refresh replaces the input. Preserve an active search without
  // focusing a newly visited page or opening the keyboard on mobile arrival.
  if (restore && !UI.modal && !UI.editor && !UI.palette) {
    const input = $('input', surface);
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(restore.start, restore.end, restore.direction);
  }
}

function viewPalette() {
  if (!UI.palette) return '';
  const list = paletteListHtml();
  return `<div class="palette-veil search-veil" data-action="palette-close"><div class="palette search-palette search-surface" data-search-mode="modal" role="dialog" aria-modal="true" aria-labelledby="wiki-search-title">
    <div class="search-palette-caption"><span id="wiki-search-title">Search the wiki</span></div>
    <div class="palette__head">${searchInputHtml(UI.palette, 'modal')}<button class="search-close" data-search-close aria-label="Close search">${I.x}</button></div>
    ${searchControlsHtml(UI.palette)}<div class="palette__list search-list">${list}</div>
    <span class="search-sr" data-search-announcement role="status" aria-live="polite" aria-atomic="true">${MD.esc(UI.palette.announcement)}</span>
    <div class="palette__foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span class="search-foot-end"><kbd>esc</kbd> close</span></div>
  </div></div>`;
}

function searchSyncSelection(mode = 'modal') {
  const state = searchState(mode), surface = searchSurface(mode);
  if (!state || !surface) return;
  const items = $$('.search-result', surface);
  items.forEach((item, index) => {
    item.classList.toggle('sel', index === state.sel);
    item.setAttribute('aria-selected', String(index === state.sel));
  });
  const input = $('input', surface);
  if (items[state.sel]) input?.setAttribute('aria-activedescendant', items[state.sel].id);
  else input?.removeAttribute('aria-activedescendant');
}

function renderSearchList(mode = 'modal') {
  const state = searchState(mode), surface = searchSurface(mode);
  if (!state || !surface) return;
  const list = $('.search-list', surface);
  if (list) list.innerHTML = searchListHtml(state, mode);
  const count = Object.values(state.filters || {}).filter(Boolean).length;
  const clear = $('[data-search-reset="all"]', surface);
  if (clear) clear.hidden = !state.q && !count;
  const active = $('[data-search-active]', surface);
  if (active) active.textContent = count || '';
  const announcement = $('[data-search-announcement]', surface);
  if (announcement) announcement.textContent = state.announcement;
  searchSyncSelection(mode);
}

function renderPaletteList() { if (UI.palette) renderSearchList(); }

function searchClose() {
  UI.palette = null;
  render();
  if (searchReturnFocus?.isConnected) searchReturnFocus.focus();
  else {
    const opener = searchReturnFocus;
    const replacement = opener && $$('button, a[href]').find((element) => element.className === opener.className
      && element.textContent === opener.textContent && element.getAttribute('data-action') === opener.getAttribute('data-action'));
    (replacement || $('.search-home input') || $('.sidebar__search'))?.focus();
  }
  searchReturnFocus = null;
}

function searchRefreshFilters(mode = 'modal') {
  const state = searchState(mode), surface = searchSurface(mode);
  if (!state || !surface) return;
  state.sel = 0;
  const groups = searchFilterGroups();
  $$('[data-search-filter]', surface).forEach((button) => {
    const group = groups.find((item) => item.id === button.dataset.searchFilter);
    const value = state.filters[group.id] || '';
    button.dataset.value = value;
    button.classList.toggle('is-set', !!value);
    $('[data-search-filter-label]', button).textContent = searchFilterLabel(group, value);
  });
  renderSearchList(mode);
}

document.addEventListener('input', (event) => {
  if (!event.target.matches?.('.search-home input')) return;
  const state = searchHomeState();
  state.q = event.target.value;
  state.sel = 0;
  renderSearchList('home');
});

document.addEventListener('toggle', (event) => {
  if (!event.target.matches?.('.search-filter-disclosure')) return;
  const mode = event.target.closest('[data-search-mode]')?.dataset.searchMode;
  if (mode) searchState(mode).filtersOpen = event.target.open;
}, true);

// mountMenu's outside-click close restores focus itself. Also close when focus
// moves out by another route, and clear our reference after its own cleanup.
document.addEventListener('focusin', (event) => {
  const menu = searchFilterMenu;
  if (!menu) return;
  if (!menu.host.isConnected) {
    searchFilterMenu = null;
    menu.anchor.setAttribute('aria-expanded', 'false');
    menu.anchor.removeAttribute('aria-controls');
  } else if (!menu.host.contains(event.target) && event.target !== menu.anchor) {
    const target = event.target;
    menu.close();
    target.focus?.({ preventScroll: true });
  }
});

document.addEventListener('pointerdown', (event) => {
  const trigger = event.target.closest?.('[data-search-filter]');
  if (searchFilterMenu?.anchor === trigger && searchFilterMenu?.host.isConnected) {
    searchFilterMenu.close();
    searchFilterDismissedTrigger = trigger;
  }
}, true);

document.addEventListener('click', (event) => {
  if (UI.palette && event.target.classList?.contains('search-veil')) {
    event.preventDefault(); event.stopImmediatePropagation(); searchClose(); return;
  }
  const trigger = event.target.closest?.('[data-search-filter]');
  const dismissed = searchFilterDismissedTrigger;
  searchFilterDismissedTrigger = null;
  if (trigger && trigger === dismissed) { event.preventDefault(); event.stopImmediatePropagation(); return; }
  if (trigger) { event.preventDefault(); event.stopImmediatePropagation(); searchOpenFilter(trigger); return; }
  const target = event.target.closest?.('[data-search-close], [data-search-reset]');
  const mode = target?.closest('[data-search-mode]')?.dataset.searchMode;
  if (!mode) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (target.hasAttribute('data-search-close')) return searchClose();
  const state = searchState(mode), reset = target.dataset.searchReset;
  if (reset === 'filters' || reset === 'all') state.filters = {};
  if (reset === 'query' || reset === 'all') {
    state.q = '';
    $('input', searchSurface(mode)).value = '';
  }
  searchRefreshFilters(mode);
  $('input', searchSurface(mode))?.focus();
}, true);

// A filter menu owns navigation before the palette. Closing it with Escape
// returns to its trigger; a second Escape can close the search dialog.
document.addEventListener('keydown', (event) => {
  if (UI.modal || UI.editor) return;
  const menu = searchFilterMenu?.host.isConnected ? searchFilterMenu : null;
  const trigger = event.target.closest?.('[data-search-filter]');
  if (!menu && trigger && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault(); event.stopImmediatePropagation(); searchOpenFilter(trigger); return;
  }
  if (menu) {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); menu.close(); return;
    }
    if (event.key === 'Tab') menu.close();
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') menu.close();
    else {
      const buttons = $$('[data-search-choice]', menu.host);
      const current = buttons.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
          ((current < 0 ? 0 : current) + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
        buttons[next]?.focus(); buttons[next]?.scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); event.stopImmediatePropagation(); buttons[current]?.click();
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); event.stopImmediatePropagation();
        const letter = event.key.toLowerCase(), now = Date.now();
        menu.typed = now - menu.typedAt < 700 && menu.typed !== letter ? menu.typed + letter : letter;
        menu.typedAt = now;
        const start = menu.typed.length === 1 ? current + 1 : Math.max(0, current);
        for (let offset = 0; offset < buttons.length; offset++) {
          const index = (start + offset) % buttons.length;
          if (WikiSearch.normalize(menu.choices[index].label).startsWith(menu.typed)) {
            buttons[index]?.focus(); buttons[index]?.scrollIntoView({ block: 'nearest' }); break;
          }
        }
      }
      return;
    }
  } else if (UI.menu) return;
  const dialog = UI.palette && $('.search-palette');
  const home = !dialog && $('.search-home');
  const surface = dialog || home;
  if (!surface) return;
  const mode = dialog ? 'modal' : 'home';
  const state = searchState(mode);
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault(); event.stopImmediatePropagation();
    if (dialog) searchClose();
    else $('input', home)?.focus();
    return;
  }
  if (dialog && event.key === 'Escape') {
    event.preventDefault(); event.stopImmediatePropagation(); searchClose(); return;
  }
  if (event.key === 'Tab' && dialog) {
    const focusable = $$('input, summary, button:not([tabindex="-1"])', dialog).filter((element) => !element.disabled && !element.hidden && element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    event.stopImmediatePropagation();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
  if (dialog) event.stopImmediatePropagation();
  if (!event.target.matches?.('.search-surface input')) return;
  if (event.isComposing) return;
  event.preventDefault(); event.stopImmediatePropagation();
  const count = state.count || 0;
  if (event.key === 'Enter') { $$('.search-result', surface)[state.sel]?.click(); return; }
  if (!count) return;
  state.sel = (state.sel + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
  searchSyncSelection(mode);
  $$('.search-result', surface)[state.sel]?.scrollIntoView({ block: 'nearest' });
}, true);
