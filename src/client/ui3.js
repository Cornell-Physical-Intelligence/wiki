/* ============================================================================
   UI part 3 — the maintenance and cross-subteam layer: watch + inbox,
   wiki health, tag browsing, hover previews, sortable tables, shortcuts.
   ========================================================================== */

'use strict';

/* --------------------------- store extensions ----------------------------- */

Object.assign(Store, {
  isWatching(id) { const p = Store.prefs(); return (p.watched || (p.watched = [])).includes(id); },
  toggleWatch(id) {
    const p = Store.prefs();
    const w = p.watched || (p.watched = []);
    const i = w.indexOf(id);
    if (i >= 0) w.splice(i, 1);
    else {
      w.push(id);
      // Watching starts now — the page's past shouldn't flood in as "unread".
      if (!p.inboxReadAt) p.inboxReadAt = Date.now();
    }
    Store.persist();
    return i < 0;
  },
  inbox() {
    const p = Store.prefs();
    const watched = new Set(p.watched || []);
    const me = Store.me()?.email;
    return Store.activity().filter((a) =>
      a.by !== me && ((a.pageId && watched.has(a.pageId)) || (a.kind === 'mention' && a.who === me))
    ).slice(0, 60);
  },
  inboxUnread() {
    const readAt = Store.prefs().inboxReadAt || 0;
    return Store.inbox().filter((a) => a.ts > readAt).length;
  },
  markInboxRead() { Store.prefs().inboxReadAt = Date.now(); Store.persist(); },

  duplicatePage(id) {
    const p = Store.page(id);
    if (!p) return null;
    let title = p.title + ' (copy)';
    let n = 2;
    while (Store.pageByTitle(title)) title = `${p.title} (copy ${n++})`;
    return Store.createPage({ title, section: p.section, parent: p.parent, body: p.body, tags: [...p.tags] });
  },

  movePage(id, { section, parent }) {
    const p = Store.page(id);
    if (!p) return;
    p.section = section;
    p.parent = parent || null;
    Store.persist();
    Store.reindex();
  },

  pagesByTag(tag) { return Store.s.pages.filter((p) => p.tags?.includes(tag)); },
  allTags() {
    const m = new Map();
    for (const p of Store.s.pages) for (const t of p.tags || []) m.set(t, (m.get(t) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  },

  health() {
    const broken = [];   // {page, target}
    const orphans = [];  // pages nothing links to and no children
    const stale = [];    // not touched in 90 days
    const linkedTo = new Set();
    for (const p of Store.s.pages) {
      for (const t of Store.linkIndex.get(p.id) || []) {
        const target = Store.titleIndex.get(t);
        if (target) linkedTo.add(target.id);
        else broken.push({ page: p, target: t });
      }
    }
    for (const p of Store.s.pages) {
      if (p.id === 'welcome') continue;
      if (!linkedTo.has(p.id) && !Store.childrenOf(p.id).length && !p.parent) orphans.push(p);
      if (Date.now() - p.updated > 90 * 864e5) stale.push(p);
    }
    return { broken, orphans, stale: stale.sort((a, b) => a.updated - b.updated) };
  },
});

/* --------------------------- inbox view ----------------------------------- */

function viewInbox() {
  const items = Store.inbox();
  const readAt = Store.prefs().inboxReadAt || 0;
  const watched = (Store.prefs().watched || []).map((id) => Store.page(id)).filter(Boolean);
  // Items count as read when you *leave* the inbox (see the hashchange handler).
  return topbar(`<a href="#/page/welcome">Wiki</a><span class="crumbs__sep">/</span><span class="crumbs__here">Inbox</span>`) + `
  <div class="content"><div class="page-wrap"><div class="page-col">
    <div class="plain-head"><span class="eyebrow">Changes on pages you watch</span><h1>Inbox</h1>
    <p>Watch any page from its ••• menu — edits and comments by others land here${watched.length ? `. Watching: ${watched.map((w) => `<b>${MD.esc(w.title)}</b>`).join(', ')}.` : '.'}</p></div>
    ${items.length ? `<div class="feed">${items.map((a) => `
      <a class="feed__row ${a.ts > readAt ? 'feed__row--new' : ''}" href="#/page/${a.pageId}">
        <span class="avatar">${Store.initials(a.by)}</span>
        <span class="feed__what">${activityLine(a)}</span>
        ${a.ts > readAt ? '<span class="dot dot--accent"></span>' : ''}
        <span class="feed__when">${relTime(a.ts)}</span>
      </a>`).join('')}</div>`
    : `<div class="empty">${I.mail}<b>Nothing yet</b><p>Watch the pages your subteam depends on — like another team's pinout or BOM — and their changes show up here.</p></div>`}
  </div></div></div>`;
}

/* --------------------------- health view ---------------------------------- */

function viewHealth() {
  const { broken, orphans, stale } = Store.health();
  const attMb = (Store.attTotal() / 1048576).toFixed(1);
  const rows = (list, empty, row) => list.length ? list.map(row).join('') : `<div class="audit__row"><span class="audit__what" style="color:var(--faint)">${empty}</span></div>`;
  return topbar(`<a href="#/page/welcome">Wiki</a><span class="crumbs__sep">/</span><span class="crumbs__here">Wiki health</span>`) + `
  <div class="content"><div class="page-wrap"><div class="page-col">
    <div class="plain-head"><span class="eyebrow">Gardening</span><h1>Wiki health</h1>
    <p>A knowledge base rots quietly. This page makes the rot visible: links to pages that don't exist, pages nothing points to, and pages nobody has touched in a season.</p></div>
    <div class="admin-grid">
      <section class="admin-block">
        <div class="admin-block__head"><h2>Broken links</h2><span class="count">${broken.length}</span></div>
        <p class="admin-block__sub">Wiki links whose target page doesn't exist yet. Click through and create the page, or fix the spelling.</p>
        <div class="audit">${rows(broken, 'Every wiki link resolves. Nice.', (b) => `
          <div class="audit__row"><span class="audit__what"><a href="#/page/${b.page.id}" style="color:var(--fg)"><b>${MD.esc(b.page.title)}</b></a> links to <b style="color:var(--accent)">[[${MD.esc(b.target)}]]</b></span>
          <a class="btn btn--sm" style="margin-left:auto;text-decoration:none" href="#/new?title=${encodeURIComponent(b.target)}">Create</a></div>`)}
        </div>
      </section>
      <section class="admin-block">
        <div class="admin-block__head"><h2>Orphan pages</h2><span class="count">${orphans.length}</span></div>
        <p class="admin-block__sub">No other page links here. Orphans are where knowledge goes to be forgotten — link them from a hub page.</p>
        <div class="audit">${rows(orphans, 'No orphans — everything is reachable.', (p) => `
          <div class="audit__row"><span class="audit__what"><a href="#/page/${p.id}" style="color:var(--fg)"><b>${MD.esc(p.title)}</b></a> · ${SECTIONS.find((s) => s.id === p.section)?.name || ''}</span></div>`)}
        </div>
      </section>
      <section class="admin-block">
        <div class="admin-block__head"><h2>Stale pages</h2><span class="count">${stale.length}</span></div>
        <p class="admin-block__sub">Untouched for 90+ days. Either it's stable reference material (fine) or it's quietly wrong (not fine). Someone should look.</p>
        <div class="audit">${rows(stale, 'Everything has been touched this quarter.', (p) => `
          <div class="audit__row"><span class="audit__when">${relTime(p.updated)}</span><span class="audit__what"><a href="#/page/${p.id}" style="color:var(--fg)"><b>${MD.esc(p.title)}</b></a> · last by ${MD.esc(Store.userName(p.updatedBy))}</span></div>`)}
        </div>
      </section>
      <section class="admin-block">
        <div class="admin-block__head"><h2>Numbers</h2></div>
        <div class="audit">
          <div class="audit__row"><span class="audit__when">Pages</span><span class="audit__what"><b>${Store.s.pages.length}</b> live · ${Store.s.trash.length} in trash</span></div>
          <div class="audit__row"><span class="audit__when">Revisions</span><span class="audit__what"><b>${Store.s.pages.reduce((s, p) => s + p.revs.length, 0)}</b> saved versions</span></div>
          <div class="audit__row"><span class="audit__when">Attachments</span><span class="audit__what"><b>${attMb} MB</b> in this browser's store</span></div>
          <div class="audit__row"><span class="audit__when">Members</span><span class="audit__what"><b>${Store.s.users.filter((u) => u.status === 'active').length}</b> active · ${Store.s.users.filter((u) => u.status === 'invited').length} invited</span></div>
        </div>
      </section>
    </div>
  </div></div></div>`;
}

/* --------------------------- tag view ------------------------------------- */

function viewTag(tag) {
  const pages = Store.pagesByTag(tag);
  const all = Store.allTags();
  return topbar(`<a href="#/page/welcome">Wiki</a><span class="crumbs__sep">/</span><span class="crumbs__here">#${MD.esc(tag)}</span>`) + `
  <div class="content"><div class="page-wrap"><div class="page-col">
    <div class="plain-head"><span class="eyebrow">Tag</span><h1>#${MD.esc(tag)}</h1>
    <p>${all.map(([t, n]) => `<a href="#/tag/${encodeURIComponent(t)}" class="chip" style="text-decoration:none;margin-right:6px;${t === tag ? 'border-color:var(--fg);color:var(--fg)' : ''}">${MD.esc(t)} · ${n}</a>`).join('')}</p></div>
    <div class="cardlist">
      ${pages.map((p) => `<a class="pagecard" href="#/page/${p.id}"><b>${MD.esc(p.title)}</b><span class="snip">${MD.esc(MD.mdToText(p.body).slice(0, 130))}</span><span class="meta">${MD.esc(Store.userName(p.updatedBy))} · ${relTime(p.updated)}</span></a>`).join('')}
    </div>
  </div></div></div>`;
}

/* --------------------------- hover previews ------------------------------- */

let previewPop = null, previewTmr = null;

function killPreview() {
  clearTimeout(previewTmr);
  previewTmr = null;
  previewPop?.remove();
  previewPop = null;
}

document.addEventListener('pointerover', (ev) => {
  if (!matchMedia('(hover: hover)').matches) return; // touch devices: taps navigate
  if (UI.modal || UI.palette) return;
  const a = ev.target.closest('a.wikilink:not(.wikilink--missing)');
  if (!a || a.closest('.ed-autocomplete')) { return; }
  clearTimeout(previewTmr);
  previewTmr = setTimeout(() => {
    const m = (a.getAttribute('href') || '').match(/#\/page\/([^#]+)/);
    const p = m && Store.page(m[1]);
    if (!p) return;
    killPreview();
    previewPop = document.createElement('div');
    previewPop.className = 'linkpreview';
    const txt = MD.mdToText(p.body).slice(0, 220);
    previewPop.innerHTML = `<b>${MD.esc(p.title)}</b><span class="linkpreview__meta">${SECTIONS.find((s) => s.id === p.section)?.name || ''} · ${MD.esc(Store.userName(p.updatedBy))} · ${relTime(p.updated)}</span><p>${MD.esc(txt)}${txt.length >= 220 ? '…' : ''}</p>`;
    document.body.appendChild(previewPop);
    const r = a.getBoundingClientRect(), w = previewPop.offsetWidth, h = previewPop.offsetHeight;
    previewPop.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    previewPop.style.top = (r.bottom + h + 12 > innerHeight ? r.top - h - 8 : r.bottom + 8) + 'px';
  }, 420);
}, true);

document.addEventListener('pointerout', (ev) => {
  if (ev.target.closest && ev.target.closest('a.wikilink')) killPreview();
}, true);
document.addEventListener('pointerdown', killPreview, true);

/* --------------------------- sortable tables ------------------------------ */

document.addEventListener('click', (ev) => {
  const th = ev.target.closest('.prose th');
  if (!th || UI.editor) return;
  const table = th.closest('table');
  const idx = [...th.parentNode.children].indexOf(th);
  const tbody = table.tBodies[0];
  const rows = [...tbody.rows];
  const dir = th.dataset.sort === 'asc' ? -1 : 1;
  table.querySelectorAll('th').forEach((h) => { delete h.dataset.sort; h.removeAttribute('aria-sort'); });
  th.dataset.sort = dir === 1 ? 'asc' : 'desc';
  th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
  const num = (s) => { const n = parseFloat(String(s).replace(/[^0-9.eE-]/g, '')); return isNaN(n) ? null : n; };
  rows.sort((a, b) => {
    const av = a.cells[idx]?.textContent.trim() ?? '', bv = b.cells[idx]?.textContent.trim() ?? '';
    const an = num(av), bn = num(bv);
    if (an !== null && bn !== null) return (an - bn) * dir;
    return av.localeCompare(bv) * dir;
  });
  rows.forEach((r) => tbody.appendChild(r));
});

/* --------------------------- shortcuts + move modal ------------------------ */

function viewExtraModal(m) {
  if (m.kind === 'shortcuts') {
    const rows = [
      ['⌘K', 'Search everything'], ['N', 'New page'], ['E', 'Edit current page'],
      ['⌘S / ⌘↵', 'Save (in editor)'], ['⌘B · ⌘I', 'Bold · italic (in editor)'],
      ['[[', 'Link a page (autocompletes)'], ['Esc', 'Close / stash draft'], ['?', 'This overlay'],
    ];
    return `<div class="modal" role="dialog" aria-label="Keyboard shortcuts">
      <div class="modal__head"><h3>Keyboard shortcuts</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
      <div class="modal__body"><div class="audit">
        ${rows.map(([k, d]) => `<div class="audit__row"><span class="audit__when"><span class="kbd">${k}</span></span><span class="audit__what">${d}</span></div>`).join('')}
      </div></div>
    </div>`;
  }
  if (m.kind === 'move') {
    const p = Store.page(m.id);
    // Any page can be a parent — except this page and its own descendants.
    const isDescendant = (q) => { let x = q; while (x) { if (x.id === m.id) return true; x = x.parent ? Store.page(x.parent) : null; } return false; };
    const parents = [...Store.s.pages].filter((q) => !isDescendant(q)).sort((a, b) => a.title.localeCompare(b.title));
    return `<div class="modal" role="dialog" aria-label="Move page">
      <div class="modal__head"><h3>Move “${MD.esc(p.title)}”</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
      <div class="modal__body">
        <label>Section<select class="select" data-m="section">${SECTIONS.map((s) => `<option value="${s.id}" ${s.id === p.section ? 'selected' : ''}>${s.name}</option>`).join('')}</select></label>
        <label>Nest under <span class="sub">Optional — makes this a subpage.</span>
        <select class="select" data-m="parent"><option value="">— top level —</option>${parents.map((q) => `<option value="${q.id}" ${q.id === p.parent ? 'selected' : ''}>${MD.esc(q.title)}</option>`).join('')}</select></label>
      </div>
      <div class="modal__foot"><button class="btn" data-action="modal-close">Cancel</button><button class="btn btn--primary" data-action="move-go" data-id="${m.id}">Move</button></div>
    </div>`;
  }
  return '';
}
