/* ============================================================================
   UI part 3 — the maintenance and cross-subteam layer: reactions, health,
   wiki health, tag browsing, hover previews, sortable tables, shortcuts.
   ========================================================================== */

'use strict';

/* --------------------------- store extensions ----------------------------- */

Object.assign(Store, {

  duplicatePage(id) {
    const p = Store.page(id);
    if (!p) return null;
    let title = p.title + ' (copy)';
    let n = 2;
    while (Store.pageByTitle(title)) title = `${p.title} (copy ${n++})`;
    return Store.createPage({ title, section: p.section, parent: p.parent, body: p.body, tags: [...p.tags] });
  },

  movePage(id, { section }) {
    const p = Store.page(id);
    if (!p) return;
    p.section = String(section || p.section);
    p.parent = null;
    Store.log({ kind: 'move', by: Store.me().email, pageId: id });
    Store.persist();
    Store.reindex();
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


/* --------------------------- health view ---------------------------------- */

function viewHealth() {
  const { broken, orphans, stale } = Store.health();
  const attMb = (Store.attTotal() / 1048576).toFixed(1);
  const rows = (list, empty, row) => list.length ? list.map(row).join('') : `<div class="audit__row"><span class="audit__what" style="color:var(--faint)">${empty}</span></div>`;
  return topbar(`<a href="#/page/welcome">Wiki</a><span class="crumbs__sep">/</span><span class="crumbs__here">Wiki health</span>`) + `
  <div class="content"><div class="page-wrap"><div class="page-col">
    <div class="plain-head"><h1>Wiki health</h1></div>
    <div class="admin-grid">
      <section class="admin-block">
        <div class="admin-block__head"><h2>Broken links</h2><span class="count">${broken.length}</span></div>
        <p class="admin-block__sub">Wiki links whose target page doesn't exist yet. Click through and create the page, or fix the spelling.</p>
        <div class="audit">${rows(broken, 'Every wiki link resolves. Nice.', (b) => {
          const rx = new RegExp('\\[\\[(' + b.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?=[|#\\]])', 'i');
          const raw = (b.page.body.match(rx) || [])[1] || b.target;
          return `
          <div class="audit__row"><span class="audit__what"><a href="#/page/${b.page.id}" style="color:var(--fg)"><b>${MD.esc(b.page.title)}</b></a> links to <b style="color:var(--accent)">[[${MD.esc(raw)}]]</b></span>
          <button class="btn btn--sm" style="margin-left:auto" data-action="new-page" data-title="${MD.esc(raw)}" data-sec="${b.page.section}">Create</button></div>`;
        })}
        </div>
      </section>
      <section class="admin-block">
        <div class="admin-block__head"><h2>Orphan pages</h2><span class="count">${orphans.length}</span></div>
        <p class="admin-block__sub">No other page links here. Orphans are where knowledge goes to be forgotten. Link them from a hub page.</p>
        <div class="audit">${rows(orphans, 'No orphans. Everything is reachable.', (p) => `
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
      ['⌘K', 'Search everything <span style="color:var(--faint)">· inserts a link while editing</span>'], ['N', 'New page'],
      ['⌘S / ⌘↵', 'Save (in editor)'], ['⌘F', 'Find in the editor'], ['⌘B · ⌘I', 'Bold · italic (in editor)'],
      ['[[', 'Link a page (autocompletes)'], ['Esc', 'Close (your draft is kept)'], ['?', 'Keyboard shortcuts'],
    ];
    return `<div class="modal" role="dialog" aria-label="Keyboard shortcuts">
      <div class="modal__head"><h3>Keyboard shortcuts</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
      <div class="modal__body"><div class="audit">
        ${rows.map(([k, d]) => `<div class="audit__row"><span class="audit__when"><span class="kbd">${k}</span></span><span class="audit__what">${d}</span></div>`).join('')}
      </div></div>
    </div>`;
  }
  if (m.kind === 'bug') {
    const d = UI.bugDraft || (UI.bugDraft = { title: '', body: '', images: [] });
    if (d.sentUrl) {
      return `<div class="modal" role="dialog" aria-label="Bug reported">
        <div class="modal__head"><h3>Bug reported</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
        <div class="modal__body">
          <p style="margin:0;font-size:14px;color:var(--muted)">Filed as a pull request. The team sees it with your screenshots attached.</p>
          <p style="margin:0"><a class="btn" style="text-decoration:none" href="${MD.esc(d.sentUrl)}" target="_blank" rel="noreferrer">Open PR #${d.sentNumber} &#8599;</a></p>
        </div>
        <div class="modal__foot"><button class="btn btn--primary" data-action="bug-done">Done</button></div>
      </div>`;
    }
    return `<div class="modal" role="dialog" aria-label="Report a bug">
      <div class="modal__head"><h3>Report a bug</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
      <div class="modal__body">
        ${d.error ? `<div class="login__error">${MD.esc(d.error)}</div>` : ''}
        <label>What broke? <input class="text-input" data-m="bug-title" placeholder="e.g. Saving a page loses the last line" maxlength="120" value="${MD.esc(d.title)}"></label>
        <label>Details <span class="sub">What you did, what you expected, what happened instead.</span>
        <textarea class="text-input" data-m="bug-body" rows="5" maxlength="10000" placeholder="Steps to reproduce help the most.">${MD.esc(d.body)}</textarea></label>
        <div class="bug-drop" data-bug-drop tabindex="0" role="button" aria-label="Add screenshots">
          ${I.imageIcon} Drop screenshots here, paste them, or <span class="linklike">browse</span>
          <input type="file" data-bug-file hidden multiple accept="image/*">
        </div>
        ${d.images.length ? `<div class="bug-shots">${d.images.map((im, i) => `<span class="bug-shot"><img src="${im.dataUri}" alt=""><button class="icon-btn bug-shot__x" data-action="bug-remove-img" data-i="${i}" aria-label="Remove screenshot">${I.x}</button></span>`).join('')}</div>` : ''}
        <p class="admin-block__sub" style="margin:0">Sent with your name, the page you're on, and your browser details.</p>
      </div>
      <div class="modal__foot">
        <button class="btn" data-action="modal-close">Close</button>
        <button class="btn btn--primary" data-action="bug-submit"${d.sending ? ' disabled' : ''}>${d.sending ? 'Filing…' : 'File the bug'}</button>
      </div>
    </div>`;
  }
  if (m.kind === 'profile') {
    const me = Store.me();
    return `<div class="modal" role="dialog" aria-label="Edit profile">
      <div class="modal__head"><h3>Your profile</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
      <div class="modal__body">
        <label>Name<input class="text-input" data-m="pname" value="${MD.esc(me.name)}" maxlength="60" autocomplete="name"></label>
        <label>Subteam <span class="sub">Optional. Shows on the members roster.</span>
        <input class="text-input" data-m="psub" value="${MD.esc(me.subteam || '')}" maxlength="40" placeholder="e.g. Electrical"></label>
        <p class="admin-block__sub" style="margin:0">Signed in as ${me.email}. Your name starts as your Google account's name; set it to whatever the team actually calls you.</p>
      </div>
      <div class="modal__foot"><button class="btn" data-action="modal-close">Cancel</button><button class="btn btn--primary" data-action="profile-save">Save</button></div>
    </div>`;
  }
  if (m.kind === 'move') {
    const p = Store.page(m.id);
    return `<div class="modal" role="dialog" aria-label="Move page">
      <div class="modal__head"><h3>Move “${MD.esc(p.title)}”</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
      <div class="modal__body">
        <label>Section${ddSections(p.section)}</label>
      </div>
      <div class="modal__foot"><button class="btn" data-action="modal-close">Cancel</button><button class="btn btn--primary" data-action="move-go" data-id="${m.id}">Move</button></div>
    </div>`;
  }
  return '';
}
