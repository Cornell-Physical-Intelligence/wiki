/* ============================================================================
   Boot + events. One delegated click handler routes data-action attributes;
   submit/input/keydown are wired here too. Drafts survive accidental
   navigation; nothing is ever lost silently.
   ========================================================================== */

'use strict';

// Drafts survive reloads: mirrored to localStorage on every autosave tick.
// Keyed per account — a shared lab machine must never show one member's
// unpublished text to the next member who signs in.
const draftKey = () => 'cupi-wiki-drafts:' + (Store.session?.() || 'anon');
const draftStash = new Map(); // pageId|'new' -> {title, body, section, tags, origBody}
const draftDeleted = new Set(); // keys this tab consumed — don't resurrect from disk

function hydrateDrafts() {
  draftStash.clear();
  draftDeleted.clear();
  try {
    for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(draftKey()) || '{}'))) draftStash.set(k, v);
  } catch (e) { /* fresh start */ }
}


function persistDrafts() {
  // Merge with what's on disk so a draft in another tab is never clobbered:
  // our keys win, keys we consumed are dropped, everything else is preserved.
  try {
    const disk = JSON.parse(localStorage.getItem(draftKey()) || '{}');
    for (const k of draftDeleted) delete disk[k];
    localStorage.setItem(draftKey(), JSON.stringify({ ...disk, ...Object.fromEntries(draftStash) }));
  } catch (e) {}
}

function stashDraftIfDirty(silent) {
  const e = UI.editor;
  if (e && e.dirty) {
    draftStash.set(e.pageId || 'new', editorDraft(e));
    draftDeleted.delete(e.pageId || 'new');
    persistDrafts();
    if (!silent) toast('Draft kept', { label: 'Resume', run: () => nav(e.pageId ? '#/edit/' + e.pageId : '#/new') });
  }
  UI.editor = null;
}

// Autosave the open editor into the stash so a crash or reload loses nothing.
let draftTimer = null;
function autosaveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const e = UI.editor;
    if (!e || !e.dirty) return;
    draftStash.set(e.pageId || 'new', editorDraft(e));
    persistDrafts();
  }, 900);
}

/* ------------------------------ bug reports ------------------------------ */

// Screenshots are recompressed client-side so a report with several full-res
// captures still fits the serverless request ceiling.
const BUG_MAX_IMAGES = 4;
const BUG_MAX_EDGE = 1600;

function bugSyncFields() {
  const d = UI.bugDraft;
  if (!d) return;
  const t = $('.modal [data-m="bug-title"]');
  const b = $('.modal [data-m="bug-body"]');
  if (t) d.title = t.value;
  if (b) d.body = b.value;
}

function bugAddFiles(files) {
  const d = UI.bugDraft;
  if (!d) return;
  bugSyncFields();
  const images = [...files].filter((f) => /^image\//.test(f.type));
  if (!images.length) { toast('Screenshots only: PNG, JPG, GIF, or WebP'); return; }
  const room = BUG_MAX_IMAGES - d.images.length;
  if (room <= 0) { toast(`${BUG_MAX_IMAGES} screenshots is the cap`); return; }
  if (images.length > room) toast(`Keeping the first ${room}; ${BUG_MAX_IMAGES} screenshots is the cap`);
  Promise.all(images.slice(0, room).map(bugCompress)).then((out) => {
    for (const im of out) if (im) d.images.push(im);
    render();
  });
}

function bugCompress(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, BUG_MAX_EDGE / Math.max(img.width, img.height));
      const small = file.size < 400 * 1024 && scale === 1;
      if (small) {
        const r = new FileReader();
        r.onload = () => resolve({ name: file.name, type: file.type, dataUri: r.result });
        r.onerror = () => resolve(null);
        r.readAsDataURL(file);
        return;
      }
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve({ name: file.name.replace(/\.[^.]*$/, '') + '.jpg', type: 'image/jpeg', dataUri: c.toDataURL('image/jpeg', 0.85) });
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast(`Couldn't read ${file.name}`); resolve(null); };
    img.src = url;
  });
}

function mountBugDrop() {
  const zone = $('[data-bug-drop]');
  const input = $('[data-bug-file]');
  if (!zone || zone.dataset.wired) return;
  zone.dataset.wired = '1';
  const pick = () => input.click();
  zone.addEventListener('click', pick);
  zone.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
  input.addEventListener('change', () => { bugAddFiles(input.files); input.value = ''; });
  for (const t of ['dragover', 'dragenter']) zone.addEventListener(t, (ev) => { ev.preventDefault(); zone.classList.add('is-over'); });
  for (const t of ['dragleave', 'drop']) zone.addEventListener(t, (ev) => { ev.preventDefault(); zone.classList.remove('is-over'); });
  zone.addEventListener('drop', (ev) => bugAddFiles(ev.dataTransfer?.files || []));
}

// Pasting a screenshot anywhere in the open bug dialog attaches it.
document.addEventListener('paste', (ev) => {
  if (UI.modal?.kind !== 'bug') return;
  const files = [...(ev.clipboardData?.files || [])].filter((f) => /^image\//.test(f.type));
  if (files.length) { ev.preventDefault(); bugAddFiles(files); }
});

function openBugReport() {
  if (!UI.bugDraft) UI.bugDraft = { title: '', body: '', images: [] };
  UI.bugDraft.error = null;
  UI.modal = { kind: 'bug' };
  render();
}

async function submitBug() {
  const d = UI.bugDraft;
  if (!d || d.sending) return;
  bugSyncFields();
  if (!d.title.trim()) { d.error = 'Give the bug a one-line title.'; render(); return; }
  if (!d.body.trim()) { d.error = 'Add a sentence or two so it can be reproduced.'; render(); return; }
  if (typeof REMOTE === 'undefined') { d.error = 'Preview build: bug reports file from the live wiki.'; render(); return; }
  d.error = null;
  d.sending = true;
  render();
  try {
    const out = await api('/bug', {
      method: 'POST',
      body: JSON.stringify({
        title: d.title.trim(),
        body: d.body.trim(),
        images: d.images.map((im, i) => ({ name: im.name || `shot-${i + 1}.png`, type: im.type, data: im.dataUri.split(',')[1] || '' })),
        context: {
          page: location.hash || '#/',
          ua: navigator.userAgent,
          viewport: `${innerWidth}x${innerHeight}`,
        },
      }),
    });
    d.sending = false;
    d.sentUrl = out.url;
    d.sentNumber = out.number;
    render();
  } catch (e) {
    d.sending = false;
    d.error = e.message || 'Filing failed. Your report is still here; try again.';
    render();
  }
}

let modalFocusState = null;

// Renders replace the shell, so keep enough identity to find a dialog's
// trigger (or active field) again without retaining a detached focus target.
function focusReference(element) {
  if (!element || element === document.body) return null;
  return { element, id: element.id, tag: element.tagName, data: { ...element.dataset },
    name: element.getAttribute('name'), label: element.getAttribute('aria-label'),
    text: element.textContent, className: element.className };
}

function resolveFocus(reference, scope = document) {
  if (!reference) return null;
  if (reference.element.isConnected && scope.contains(reference.element)) return reference.element;
  return [...scope.querySelectorAll('button, a[href], input, textarea, summary, [tabindex]')].find((element) => {
    if (element.tagName !== reference.tag) return false;
    if (reference.id) return element.id === reference.id;
    const entries = Object.entries(reference.data);
    if (entries.length) return entries.every(([key, value]) => element.dataset[key] === value);
    if (reference.name) return element.getAttribute('name') === reference.name;
    if (reference.label) return element.getAttribute('aria-label') === reference.label;
    return element.className === reference.className && element.textContent === reference.text;
  }) || null;
}

function modalFocusables(dialog) {
  return [...dialog.querySelectorAll('button, input, a[href], textarea, summary, [tabindex], [contenteditable="true"]')]
    .filter((element) => !element.disabled && element.tabIndex >= 0 && element.offsetParent !== null);
}

function captureModalFocus() {
  if (!UI.modal) { modalFocusState = null; return; }
  const active = document.activeElement;
  if (modalFocusState?.model !== UI.modal) {
    const opener = active?.closest?.('.modal') ? modalFocusState?.opener : focusReference(active);
    modalFocusState = { model: UI.modal, opener, current: null };
  } else if (active?.closest?.('.modal')) {
    modalFocusState.current = focusReference(active);
    modalFocusState.selection = typeof active.selectionStart === 'number'
      ? [active.selectionStart, active.selectionEnd] : null;
  }
}

function mountModalFocus() {
  const dialog = $('.modal');
  if (!UI.modal || !dialog) return;
  anchorSaveDialog(dialog);
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('tabindex', '-1');
  const focusables = modalFocusables(dialog);
  const prior = resolveFocus(modalFocusState?.current, dialog);
  const target = (focusables.includes(prior) ? prior : null)
    || focusables.find((element) => element.matches('[data-m], .btn--primary'))
    || focusables[0] || dialog;
  syncSidebarInteraction();
  target.focus({ preventScroll: true });
  if (target === prior && modalFocusState?.selection) target.setSelectionRange?.(...modalFocusState.selection);
}

function anchorSaveDialog(dialog = $('.save-summary')) {
  if (UI.modal?.kind !== 'save-summary' || !dialog) return;
  const veil = dialog.closest('.modal-veil');
  if (!veil) return;
  // Measure layout, not the entry animation's temporary transform.
  const top = UI.modal._top ?? Math.max(20, (veil.clientHeight - dialog.offsetHeight) / 2);
  UI.modal._top = top;
  veil.style.alignItems = 'flex-start';
  veil.style.paddingTop = top + 'px';
  dialog.style.maxHeight = Math.max(120, innerHeight - top - 20) + 'px';
}

function closeModal(after) {
  if (UI.editor?.saving) return;
  const closing = UI.modal;
  const opener = modalFocusState?.opener;
  const pendingId = UI.modal?.kind === 'interest-pending' ? UI.modal.id : null;
  const restoreFocus = () => {
    if (!after && !UI.editor && !UI.modal) resolveFocus(opener)?.focus({ preventScroll: true });
    if (pendingId) $$('[data-action="interest-pending-open"]').find((el) => el.dataset.id === pendingId)?.focus();
  };
  const veil = document.querySelector('.modal-veil');
  if (!veil) { UI.modal = null; syncSidebarInteraction(); after ? after() : render(); restoreFocus(); return; }
  if (veil.classList.contains('leaving')) return; // second click during the exit
  veil.classList.add('leaving');
  setTimeout(() => {
    veil.remove();
    if (UI.modal !== closing) return;
    UI.modal = null;
    syncSidebarInteraction();
    if (after) after();
    // Keep-editing paths must not rebuild the textarea — a full render would
    // wipe the native undo stack the editor is built around.
    else if (UI.editor) { (resolveFocus(opener) || $('[data-ed="body"]'))?.focus({ preventScroll: true }); }
    else render();
    restoreFocus();
  }, 120);
}

// Opening a dialog over the editor appends it in place, same reason.
function showModal(m) {
  UI.modal = m;
  if (UI.editor && $('#app .editor')) {
    captureModalFocus();
    document.querySelector('.modal-veil')?.remove();
    document.body.insertAdjacentHTML('beforeend', viewModal());
    mountModalFocus();
  } else render();
}

function requestEditorClose() {
  const e = UI.editor;
  if (!e || e.saving) return;
  if (!e.dirty) {
    const pid = e.pageId;
    UI.editor = null;
    nav(pid ? '#/page/' + pid : '#/home');
    route(); render();
    return;
  }
  showModal({ kind: 'close-editor' });
}

// Keep offscreen navigation out of keyboard and screen-reader order. The
// original sidebar layout stays unchanged; only its interaction state changes.
function syncSidebarInteraction(moveFocus = false) {
  const sidebar = $('.sidebar'), shell = $('.shell'), main = $('.main');
  if (!sidebar) return;
  const mobile = innerWidth <= 860, drawer = mobile && UI.navOpen;
  const hidden = mobile ? !UI.navOpen : UI.navHidden;
  const modal = Boolean(UI.modal || UI.palette || $('.lightbox'));
  if (shell) shell.inert = modal;
  sidebar.inert = Boolean(hidden);
  if (main) main.inert = Boolean(drawer);
  sidebar.setAttribute('aria-label', 'Wiki navigation');
  sidebar.querySelectorAll('.tree-section').forEach((section) => {
    const body = section.querySelector('.tree-section__body');
    if (body) body.inert = section.classList.contains('collapsed');
  });
  const trigger = $('[data-action="nav-toggle"]');
  trigger?.setAttribute('aria-expanded', String(mobile ? UI.navOpen : !UI.navHidden));
  if (!modal && moveFocus) {
    if (drawer) sidebar.querySelector('a, button')?.focus({ preventScroll: true });
    else trigger?.focus({ preventScroll: true });
  }
}

function mountMenu(host, anchor) {
  document.body.appendChild(host);
  const r = anchor.getBoundingClientRect();
  // Option menus open at least as wide as the control they belong to.
  if (anchor.classList.contains('dd')) host.style.minWidth = Math.min(r.width, innerWidth - 20) + 'px';
  if (anchor.classList.contains('sidebar__user')) {
    host.classList.add('menu--account');
    host.style.minWidth = '0';
    host.style.width = Math.min(r.width, innerWidth - 20) + 'px';
  }
  const mw = host.offsetWidth, mh = host.offsetHeight;
  host.style.left = Math.max(10, Math.min(r.left, innerWidth - mw - 10)) + 'px';
  const top = r.bottom + mh + 10 > innerHeight ? r.top - mh - 6 : r.bottom + 6;
  host.style.top = Math.max(10, Math.min(top, innerHeight - mh - 10)) + 'px';
  anchor.setAttribute('aria-expanded', 'true');
  let closed = false;
  const close = (restoreFocus = true) => {
    if (closed) return;
    closed = true;
    host.remove(); UI.menu = null;
    document.removeEventListener('pointerdown', onAway, true);
    document.removeEventListener('focusin', onFocusAway);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
    anchor.setAttribute('aria-expanded', 'false');
    window.__closeMenu = null;
    if (restoreFocus && anchor.isConnected) anchor.focus?.();
    setTimeout(() => { if (UI._backgroundRoute) renderBackground(UI._backgroundRoute); }, 0);
  };
  window.__closeMenu = close; // render() and Esc both close through this
  const onAway = (ev) => {
    if (anchor.contains(ev.target)) return; // The trigger's click toggles it closed.
    if (!host.contains(ev.target)) close(false);
  };
  const onFocusAway = (ev) => { if (!host.contains(ev.target) && ev.target !== anchor) close(false); };
  const onScroll = (ev) => { if (!host.contains(ev.target)) close(false); };
  const onResize = () => close(false);
  document.addEventListener('pointerdown', onAway, true);
  document.addEventListener('focusin', onFocusAway);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  window.__menuAnchor = anchor;
  // Menus are keyboard-first like everything else: focus lands inside,
  // arrows move it, Escape (global) hands it back to the trigger.
  host.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); return; }
    if (ev.key === 'Tab') { close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const btns = [...host.querySelectorAll('button')].filter((button) => !button.disabled);
    const cur = btns.indexOf(document.activeElement);
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? btns.length - 1 :
      ((cur < 0 ? 0 : cur) + (ev.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length;
    btns[next]?.focus();
    btns[next]?.scrollIntoView({ block: 'nearest' });
  });
  host.querySelector('button:not(:disabled)')?.focus();
  return close;
}

function openMenu(items, anchor) {
  if (UI.menu && window.__menuAnchor === anchor) { window.__closeMenu?.(); return; }
  window.__closeMenu?.();
  UI.menu = { items };
  const host = document.createElement('div');
  host.className = 'menu';
  host.setAttribute('role', 'menu');
  host.innerHTML = items.map((it, i) => it === '-' ? '<hr>' :
    `<button type="button" role="${typeof it.selected === 'boolean' ? 'menuitemradio' : 'menuitem'}" ${typeof it.selected === 'boolean' ? `aria-checked="${it.selected}"` : ''} data-menu-i="${i}" class="${it.danger ? 'danger' : ''}">${it.icon ? `<span class="menu__icon" aria-hidden="true">${it.icon}</span>` : ''}<span class="menu__label">${MD.esc(it.label)}</span>${it.hint ? `<span class="menu__hint">${it.hint}</span>` : ''}</button>`).join('');
  const close = mountMenu(host, anchor);
  host.querySelector('[aria-checked="true"]')?.focus();
  host.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-menu-i]');
    if (!b) return;
    close();
    items[+b.dataset.menuI].run();
  });
}

function openEmojiPop(anchor, pageId) {
  if (UI.menu && window.__menuAnchor === anchor) { window.__closeMenu?.(); return; }
  window.__closeMenu?.();
  UI.menu = { emoji: true };
  const mine = Store.page(pageId)?.reactions || {};
  const me = Store.me().email;
  const host = document.createElement('div');
  host.className = 'menu emoji-pop';
  host.setAttribute('role', 'menu');
  host.innerHTML = REACTION_SET.map(([emoji, label]) =>
    `<button role="menuitem" data-emoji="${MD.esc(emoji)}" title="${MD.esc(label)}" aria-label="${MD.esc(label)}" aria-pressed="${(mine[emoji] || []).includes(me)}">${MD.esc(emoji)}</button>`).join('');
  const close = mountMenu(host, anchor);
  host.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-emoji]');
    if (!b) return;
    close();
    Store.toggleReaction(pageId, b.dataset.emoji);
    render();
  });
}

/* ------------------------------- find in editor --------------------------- */

// Imperative overlay: re-rendering the editor would destroy the undo stack.
function edFindOpen() {
  const ed = $('.editor');
  const ta = $('[data-ed="body"]');
  if (!ed || !ta) return;
  let bar = $('.findbar');
  if (bar) { $('.findbar input').select(); return; }
  bar = document.createElement('div');
  bar.className = 'findbar';
  bar.innerHTML = `<input type="text" placeholder="Find in page…" spellcheck="false" aria-label="Find in page">
    <span class="findbar__count"></span>
    <button class="icon-btn" data-find="prev" aria-label="Previous match">${lucide('h2', 2).replace(/<svg[^>]*>[\s\S]*<\/svg>/, '')}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m18 15-6-6-6 6"/></svg></button>
    <button class="icon-btn" data-find="next" aria-label="Next match"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg></button>
    <button class="icon-btn" data-find="close" aria-label="Close find">${I.x}</button>`;
  ed.insertBefore(bar, ed.querySelector('.editor__panes'));
  const input = bar.querySelector('input');
  const count = bar.querySelector('.findbar__count');
  let at = -1;

  const jump = (dir) => {
    const q = input.value;
    if (!q) { count.textContent = ''; return; }
    const hay = ta.value.toLowerCase();
    const needle = q.toLowerCase();
    const all = [];
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) all.push(i);
    if (!all.length) { count.textContent = '0 results'; return; }
    if (dir === 'next') at = (at + 1) % all.length;
    else if (dir === 'prev') at = (at - 1 + all.length) % all.length;
    else at = 0;
    count.textContent = (at + 1) + ' of ' + all.length;
    const pos = all[at];
    ta.focus();
    ta.setSelectionRange(pos, pos + q.length);
    const lines = ta.value.slice(0, pos).split('\n').length;
    ta.scrollTop = Math.max(0, lines * 21.6 - ta.clientHeight / 2);
    input.focus();
  };

  input.addEventListener('input', () => { at = -1; jump('next'); });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); jump(e.shiftKey ? 'prev' : 'next'); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); bar.remove(); ta.focus(); }
  });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-find]');
    if (!b) return;
    if (b.dataset.find === 'close') { bar.remove(); ta.focus(); }
    else jump(b.dataset.find);
  });
  input.focus();
}

/* ------------------------------- click delegation ------------------------ */

function acceptInterestReview(row) {
  const rows = UI.interest?.rows;
  const index = rows?.findIndex((r) => r.id === row.id) ?? -1;
  if (index >= 0 && (row.reviewVersion || 0) >= (rows[index].reviewVersion || 0)) rows[index] = row;
}

async function toggleInterestFlag(id) {
  if (!Store.isAdmin() || UI.interestArchiveView) return;
  const row = UI.interest?.rows?.find((r) => r.id === id);
  UI.interestFlagBusy ||= new Set();
  if (!row || UI.interestFlagBusy.has(id)) return;
  UI.interestFlagBusy.add(id);
  const paint = () => {
    renderInterestRows(id);
    const button = $('.interest-detail-flag');
    if (button?.dataset.id === id) {
      const focused = document.activeElement === button;
      const current = UI.interest?.rows?.find((r) => r.id === id) || row;
      button.outerHTML = interestFlagButton(current, { detail: true });
      if (focused) $('.interest-detail-flag')?.focus();
    }
  };
  paint();
  try {
    const out = await api(`/interest/${id}/review`, { method: 'PATCH', body: JSON.stringify({ flagged: !row.review?.flagged }), signal: AbortSignal.timeout(20000) });
    acceptInterestReview(out.row);
    toast(out.row.review.flagged ? 'Flagged for follow-up' : 'Flag removed');
  } catch (e) { toast(e.name === 'TimeoutError' ? 'The flag request timed out. You can retry.' : `Could not update flag: ${e.message}`); }
  finally { UI.interestFlagBusy.delete(id); paint(); }
}

async function postInterestComment(id) {
  if (!Store.isAdmin() || UI.interestArchiveView) return;
  const draft = interestDraft(id);
  if (draft.sending || !draft.text.trim()) return;
  // Keep the same ID when retrying a lost response so a comment is never
  // duplicated. Editing after a failed attempt starts a new submission.
  draft.id ||= 'ic-' + crypto.randomUUID();
  draft.sending = true;
  draft.error = '';
  paintInterestDiscussion(id);
  let posted = false;
  try {
    const out = await api(`/interest/${id}/comments`, { method: 'POST', body: JSON.stringify({ id: draft.id, text: draft.text }), signal: AbortSignal.timeout(20000) });
    acceptInterestReview(out.row);
    draft.text = ''; draft.id = null;
    posted = true;
    renderInterestRows(id);
    toast('Comment posted');
  } catch (e) { draft.error = e.name === 'TimeoutError'
    ? 'The request timed out. Your comment is still here; retrying will not post it twice.'
    : `Could not post: ${e.message}. Your comment is still here.`; }
  finally { draft.sending = false; paintInterestDiscussion(id, { posted }); }
}

function confirmInterestCommentRemoval(id, commentId, cancel = false) {
  if (!Store.isAdmin() || UI.interestArchiveView || UI.modal?.kind !== 'interest-row' || UI.modal.id !== id) return;
  const row = UI.interest?.rows?.find((r) => r.id === id);
  if (!row?.review?.comments?.some((c) => c.id === commentId)) return;
  UI.interestCommentRemovals ||= {};
  const key = id + '/' + commentId;
  const removal = UI.interestCommentRemovals[key] ||= {};
  if (removal.busy) return;
  if (cancel) delete UI.interestCommentRemovals[key];
  else { removal.confirming = true; removal.error = ''; }
  paintInterestDiscussion(id);
  const node = $$('[data-comment-id]', $('.interest-thread')).find((el) => el.dataset.commentId === commentId);
  $(cancel ? '[data-action="interest-comment-delete"]' : '[data-action="interest-comment-delete-cancel"]', node)?.focus({ preventScroll: true });
}

async function deleteInterestComment(id, commentId) {
  if (!Store.isAdmin() || UI.interestArchiveView) return;
  const key = id + '/' + commentId;
  const removal = UI.interestCommentRemovals?.[key];
  if (!removal?.confirming || removal.busy) return;
  const originalNode = $$('[data-comment-id]', $('.interest-thread')).find((el) => el.dataset.commentId === commentId);
  const restoreFocus = originalNode?.contains(document.activeElement);
  removal.busy = true; removal.error = '';
  paintInterestDiscussion(id);
  try {
    const out = await api(`/interest/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE', signal: AbortSignal.timeout(20000) });
    acceptInterestReview(out.row);
    delete UI.interestCommentRemovals[key];
    renderInterestRows(id);
    toast('Comment deleted');
  } catch (e) {
    removal.error = e.name === 'TimeoutError' ? 'The request timed out. Retry to confirm deletion.' : `Could not delete: ${e.message}`;
  } finally {
    removal.busy = false;
    paintInterestDiscussion(id);
    if (restoreFocus && UI.modal?.kind === 'interest-row' && UI.modal.id === id && document.activeElement === document.body) {
      const node = $$('[data-comment-id]', $('.interest-thread')).find((el) => el.dataset.commentId === commentId);
      (removal.error ? $('[data-action="interest-comment-delete-confirm"]', node) : $('.interest-compose textarea'))?.focus({ preventScroll: true });
    }
  }
}

function refreshInterestAfterRemoval(ids) {
  const removedOpenRow = !UI.interestArchiveView && UI.modal?.kind === 'interest-row' && ids.has(UI.modal.id);
  if (removedOpenRow) closeModal(() => renderBackground('interest'));
  else renderBackground('interest');
}

function confirmInterestRemoval(ids) {
  if (!Store.isAdmin() || UI.interestArchiveView) return;
  const rows = (UI.interest?.rows || []).filter((r) => ids.includes(r.id) && !UI.interestDeleting?.has(r.id));
  if (!rows.length) { if (ids.length) toast('Deletion is already in progress'); return; }
  const visible = new Set(interestVisible().map((r) => r.id));
  const hidden = rows.filter((r) => !visible.has(r.id)).length;
  UI.modal = {
    kind: 'confirm', title: rows.length === 1 ? `Delete ${rows[0].name}?` : `Delete ${rows.length} submissions?`,
    text: `${rows.slice(0, 5).map((r) => `<b>${MD.esc(r.name)}</b>`).join(', ')}${rows.length > 5 ? ` and ${rows.length - 5} more` : ''} will be removed, including their comments and attachments. This cannot be undone.${hidden ? ` <b>${hidden} selected ${hidden === 1 ? 'person is' : 'people are'} hidden by your filters.</b>` : ''}`,
    confirm: rows.length === 1 ? 'Delete submission' : `Delete ${rows.length} submissions`, danger: true,
    onGo: async () => {
      UI.interestDeleting ||= new Set();
      const pending = rows.filter((r) => !UI.interestDeleting.has(r.id));
      if (!pending.length) return;
      pending.forEach((r) => UI.interestDeleting.add(r.id));
      const results = await Promise.allSettled(pending.map((r) => api(`/interest/${r.id}`, { method: 'DELETE', signal: AbortSignal.timeout(20000) })));
      pending.forEach((r) => UI.interestDeleting.delete(r.id));
      const deleted = new Set(pending.filter((r, i) => results[i].status === 'fulfilled' || results[i].reason?.status === 404).map((r) => r.id));
      if (UI.interest?.rows) UI.interest.rows = UI.interest.rows.filter((r) => !deleted.has(r.id));
      for (const id of deleted) { UI.interestSelected?.delete(id); if (UI.interestDrafts) delete UI.interestDrafts[id]; }
      refreshInterestAfterRemoval(deleted);
      const failed = pending.length - deleted.size;
      toast(failed ? `${deleted.size} deleted; ${failed} could not be deleted. Try again.` : `Deleted ${deleted.size} ${deleted.size === 1 ? 'submission' : 'submissions'}`);
    },
  };
  render();
}

async function checkInterestStorage() {
  try {
    await api('/interest/storage-check', { method: 'POST', body: '{}' });
    toast('Submission backup storage is working');
  } catch (e) { toast(`Storage check failed: ${e.message}`); }
}

function archiveInterestList() {
  if (UI.interestArchiving) { toast('Archiving is already in progress'); return; }
  const n = (UI.interest?.rows || []).length;
  if (!n) { toast('There is nothing to archive'); return; }
  const year = new Date().getFullYear();
  const season = new Date().getMonth() >= 6 ? 'Fall' : 'Spring';
  UI.modal = {
    kind: 'confirm', title: 'Archive these applications?',
    text: `Save all <b>${n}</b> submissions, comments, flags, and attachments in an archive for this recruiting cycle.`,
    confirm: 'Archive list',
    field: { label: 'Archive name', value: `${season} ${year} recruiting`, placeholder: 'e.g. Fall 2026 recruiting', maxlength: 80 },
    onGo: (value) => {
      const name = String(value ?? '').trim();
      if (!name) { toast('An archive needs a name'); return; }
      if (UI.interestArchiving) return;
      UI.interestArchiving = true;
      const ids = new Set((UI.interest?.rows || []).map((r) => r.id));
      api('/interest/archive', { method: 'POST', body: JSON.stringify({ name }), signal: AbortSignal.timeout(30000) })
        .then(() => { UI.interest = undefined; UI.interestArchives = undefined; refreshInterestAfterRemoval(ids); toast(`Archived as “${name}”`); })
        .catch((e) => toast(`Could not archive: ${e.message}`))
        .finally(() => { UI.interestArchiving = false; });
    },
  };
  render();
}

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const act = el.dataset.action;
  const stop = () => { ev.preventDefault(); ev.stopPropagation(); };
  if (UI.editor?.saving) { stop(); return; }

  switch (act) {
    /* ---- login ---- */
    case 'login-google': stop(); UI.chooser = true; UI.loginError = null; render(); break;
    case 'login-back': stop(); UI.chooser = false; render(); break;
    case 'login-as': {
      stop();
      const email = el.dataset.email;
      const res = Store.login(email);
      UI.chooser = false;
      if (res.ok) { UI.loginError = null; hydrateDrafts(); nav('#/home'); route(); render(); toast(`Signed in as ${res.user.name}`); }
      else { nav('#/denied?email=' + encodeURIComponent(email)); }
      break;
    }

    /* ---- shell ---- */
    case 'nav-toggle': stop(); { if (innerWidth <= 860) UI.navOpen = !UI.navOpen; else { UI.navHidden = !UI.navHidden; Store.prefs().navHidden = UI.navHidden; Store.persist(); } const sh = $('.shell'); if (sh) { sh.classList.toggle('nav-open', UI.navOpen); sh.classList.toggle('nav-hidden', UI.navHidden); } else render(); syncSidebarInteraction(true); } break;
    case 'nav-close': stop(); UI.navOpen = false; $('.shell')?.classList.remove('nav-open'); syncSidebarInteraction(true); break;
    case 'sec-toggle': {
      if (ev.target.closest('[data-action="new-page"]')) break;
      stop();
      const c = Store.prefs().collapsed;
      const i = c.indexOf(el.dataset.sec);
      if (i >= 0) c.splice(i, 1); else c.push(el.dataset.sec);
      Store.persist();
      el.closest('.tree-section')?.classList.toggle('collapsed', i < 0);
      el.setAttribute('aria-expanded', String(i >= 0));
      syncSidebarInteraction();
      el.setAttribute('aria-label', (i >= 0 ? 'Collapse ' : 'Expand ') + (SECTIONS.find((s) => s.id === el.dataset.sec)?.name || 'section'));
      break;
    }
    case 'settings-menu': stop(); openMenu([
      { icon: I.clock, label: 'Activity', run: () => nav('#/activity') },
      { icon: I.shield, label: 'Wiki health', run: () => nav('#/health') },
      ...(Store.isAdmin() ? [{ icon: I.users, label: 'Members & access', run: () => nav('#/admin') }] : []),
      { icon: I.trash, label: 'Trash', run: () => nav('#/trash') },
      '-',
      { icon: I.bug, label: 'Report a bug', run: openBugReport },
      { icon: I.help, label: 'Keyboard shortcuts', run: () => { UI.modal = { kind: 'shortcuts' }; render(); } },
    ], el); break;
    case 'user-menu': stop(); openMenu([
      { icon: I.edit, label: 'Edit profile', run: () => { UI.modal = { kind: 'profile' }; render(); } },
      { icon: I.copy, label: 'Export wiki as Markdown', run: async () => {
        const doc = Store.s.pages.map((p) => `# ${p.title}\n\n${p.body}`).join('\n\n---\n\n');
        try { await navigator.clipboard.writeText(doc); toast(`Copied ${Store.s.pages.length} pages as Markdown`); }
        catch (e) { toast("Couldn't copy: your browser blocked clipboard access"); }
      } },
      ...(typeof REMOTE === 'undefined' ? [
        { icon: I.shield, label: 'About this preview', run: () => { UI.modal = { kind: 'confirm', title: 'Preview build', text: 'Sign-in is simulated and changes are stored in this browser.', confirm: 'Got it' }; UI.modal.onGo = () => {}; render(); } },
        '-',
        { icon: I.history, label: 'Restore sample content', danger: true, run: () => { UI.modal = { kind: 'confirm', title: 'Restore sample content?', text: 'Every page, member, and attachment returns to the sample content this preview ships with. Anything you changed in this browser is erased.', confirm: 'Restore', danger: true }; UI.modal.onGo = () => { Store.reset(); UI.editor = null; nav('#/home'); route(); render(); toast('Sample content restored'); }; render(); } },
      ] : ['-']),
      { icon: I.x, label: 'Sign out', run: () => { Store.logout(); UI.editor = null; hydrateDrafts(); nav('#/login'); route(); render(); } },
    ], el); break;

    /* ---- page ---- */
    case 'edit': stop(); nav('#/edit/' + el.dataset.id); break;
    case 'ed-spell': stop(); {
      const p = Store.prefs();
      const on = p.spellcheck === false;
      p.spellcheck = on;
      Store.persist();
      for (const fld of $$('[data-ed="title"], [data-ed="body"]')) fld.spellcheck = on;
      el.setAttribute('aria-pressed', String(on));
      el.classList.toggle('active', on);
      toast(on ? 'Spell check on' : 'Spell check off');
    } break;
    case 'toc-menu': {
      stop();
      const p = Store.page(el.dataset.id);
      if (!p) break;
      const { toc } = MD.render(p.body, mdCtx({ pageId: p.id, readonly: true }));
      openMenu(toc.map((h) => ({
        icon: '<span style="width:14px;flex:none"></span>',
        label: (h.lvl === 3 ? '   ' : '') + h.text,
        run: () => { document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth' }); },
      })), el);
      break;
    }
    case 'page-info': stop(); UI.pageInfo = UI.pageInfo === el.dataset.id ? null : el.dataset.id; render(); break;

    // The global custom dropdown: opens the app's styled menu, never the OS picker.
    case 'dd': {
      stop();
      const host = el;
      if (host.dataset.m === 'interest-filter') { openInterestFilter(host); break; }
      const options = JSON.parse(host.dataset.opts);
      openMenu(options.map((o) => ({
        selected: o.value === host.dataset.value,
        icon: o.value === host.dataset.value ? I.check : '<span style="width:14px;flex:none"></span>',
        label: o.label,
        run: () => {
          host.dataset.value = o.value;
          if (UI.route.name === 'admin' && host.closest('form')) host.closest('form').dataset.adminDirty = 'true';
          host.querySelector('.dd__label').textContent = o.label;
          if (host.dataset.m === 'ed-section' && UI.editor) { UI.editor.section = o.value; markDirty(); autosaveDraft(); }
          if (host.dataset.m === 'ai-model') {
            const form = host.closest('form'), current = $('[data-m="ai-effort"]', form);
            const efforts = aiEffortOptions(o.value);
            const effort = efforts.some((e) => e.value === current.dataset.value) ? current.dataset.value : efforts[0].value;
            current.outerHTML = dd('ai-effort', efforts, effort);
            $('[data-m="ai-effort"]', form).setAttribute('aria-labelledby', 'ai-effort-label');
            UI.aiDraft = { model: o.value, effort };
          }
          if (host.dataset.m === 'ai-effort') UI.aiDraft = { model: $('[data-m="ai-model"]', host.closest('form')).dataset.value, effort: o.value };
          if (host.dataset.m === 'section' && UI.modal) UI.modal.sectionTouched = true;
          if (host.dataset.m === 'email-from') {
            const form = host.closest('form');
            form.dataset.adminDirty = 'true';
            const field = form.elements.from;
            if (o.value === '__custom') {
              UI.emailFromCustom = true;
              field.type = 'text';
              field.className = 'text-input';
              field.placeholder = 'wiki@yourdomain.com';
              field.setAttribute('aria-label', 'From address');
              field.autocomplete = 'off';
              field.spellcheck = false;
              host.remove();
              field.focus();
            } else field.value = o.value;
          }
        },
      })), host);
      break;
    }
    case 'star': stop(); { const on = Store.toggleStar(el.dataset.id); toast(on ? 'Starred' : 'Unstarred'); render(); } break;
    case 'page-menu': {
      stop();
      const id = el.dataset.id;
      openMenu([
        { icon: I.edit, label: 'Edit', run: () => nav('#/edit/' + id) },
        { icon: I.history, label: 'History', run: () => nav('#/history/' + id) },
        '-',
        { icon: I.copy, label: 'Duplicate', run: async () => { try { const c = await Store.duplicatePage(id); nav('#/page/' + c.id); toast('Page duplicated'); } catch (e) { toast(e.message || 'Could not duplicate this page'); } } },
        { icon: I.arrowL, label: 'Move…', run: () => { UI.modal = { kind: 'move', id }; render(); } },
        { icon: I.copy, label: 'Copy as Markdown', run: async () => { try { await navigator.clipboard.writeText(Store.page(id).body); toast('Markdown copied'); } catch (e) { toast("Couldn't copy: your browser blocked clipboard access"); } } },
        { icon: I.page, label: 'Print / PDF', run: () => window.print() },
        '-',
        { icon: I.trash, label: 'Move to Trash', danger: true, run: () => {
          UI.modal = { kind: 'confirm', title: 'Move to Trash?', text: `“${MD.esc(Store.page(id).title)}” will sit in Trash for 30 days before it's gone for good.`, confirm: 'Move to Trash', danger: true };
          UI.modal.onGo = () => { Store.deletePage(id); nav('#/home'); route(); render(); toast('Moved to Trash', { label: 'Undo', run: () => { Store.restorePage(id); render(); } }); };
          render();
        } },
      ], el);
      break;
    }
    case 'video-play': stop(); {
      const wrap = el.closest('.video-embed');
      const provider = el.dataset.provider, id = el.dataset.vid || '';
      if (!wrap || !/^[\w-]{6,40}$/.test(id)) break;
      const watch = provider === 'youtube' ? `https://www.youtube.com/watch?v=${id}`
        : provider === 'vimeo' ? `https://vimeo.com/${id}`
        : `https://www.loom.com/share/${id}`;
      if (window.__FRAME_PREAMBLE) { window.open(watch, '_blank', 'noopener'); break; } // artifact sandbox blocks third-party frames
      const src = provider === 'youtube' ? `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`
        : provider === 'vimeo' ? `https://player.vimeo.com/video/${id}?autoplay=1`
        : `https://www.loom.com/embed/${id}?autoplay=1`;
      const meta = videoMeta.get(`${provider}:${id}`); // may still be a pending fetch — fall back
      wrap.innerHTML = `<iframe src="${src}" title="${meta && typeof meta.title === 'string' && meta.title ? MD.esc(meta.title) : 'Video player'}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
      break;
    }
    case 'lightbox': stop(); openLightbox(ev.target.src, ev.target.alt); break;
    case 'att-open': {
      stop();
      const att = Store.att(el.dataset.id);
      if (att && /^image\//.test(att.type)) openLightbox(att.dataUri || att.url, att.name);
      else if (att && att.url) window.open(att.url, '_blank');
      else toast("Downloads aren't available in the preview; the live wiki serves the original file.");
      break;
    }

    /* ---- reactions ---- */
    case 'react': stop(); Store.toggleReaction(el.dataset.id, el.dataset.emoji); render(); break;
    case 'react-add': stop(); openEmojiPop(el, el.dataset.id); break;

    case 'resume-new-draft': stop(); nav('#/new'); break;
    case 'email-edit': stop(); if (!UI.emailBusy) { UI.emailEdit = !UI.emailEdit; render(); } break;
    case 'resend-disconnect': stop(); runEmailIntegrationAction('disconnect'); break;
    case 'profile-save': stop(); {
      const name = ($('.modal [data-m="pname"]')?.value || '').trim();
      const subteam = ($('.modal [data-m="psub"]')?.value || '').trim();
      if (!name) { toast("Your name can't be empty."); break; }
      Store.setProfile(name, subteam);
      closeModal();
      toast('Profile updated');
      break;
    }

    case 'ai-usage-refresh': stop(); loadAiUsage(); break;
    case 'ai-configure': stop(); setAiConfiguration(true); break;
    case 'ai-cancel': stop(); setAiConfiguration(false); break;
    case 'ai-test': stop(); changeAiSettings(el.closest('form'), 'test'); break;
    case 'ai-disconnect': stop(); changeAiSettings(el.closest('form'), 'disconnect'); break;

    case 'email-test': stop(); runEmailIntegrationAction('test'); break;

    case 'help-menu': stop(); UI.modal = { kind: 'shortcuts' }; render(); break;

    /* ---- bug reports ---- */
    case 'bug-open': stop(); openBugReport(); break;
    case 'bug-done': stop(); UI.bugDraft = null; closeModal(); break;
    case 'bug-remove-img': stop(); { bugSyncFields(); UI.bugDraft.images.splice(+el.dataset.i, 1); render(); } break;
    case 'bug-submit': stop(); submitBug(); break;

    /* ---- new page ---- */
    case 'new-page': stop(); UI.modal = { kind: 'new-page', section: el.dataset.sec, title: el.dataset.title || '', tpl: 'blank' }; render(); break;
    case 'tpl-pick': stop(); {
      UI.modal.tpl = el.dataset.tpl;
      $$('.tpl').forEach((b) => b.classList.toggle('sel', b.dataset.tpl === el.dataset.tpl));
      // A meeting belongs in Operations, a bring-up log in Electrical — follow
      // the template's home section until the person picks one themselves.
      const tpl = TEMPLATES.find((t) => t.id === el.dataset.tpl);
      if (tpl?.section && !UI.modal.sectionTouched) {
        UI.modal.section = tpl.section;
        const host = $('.modal [data-m="section"]');
        if (host) {
          host.dataset.value = tpl.section;
          host.querySelector('.dd__label').textContent = SECTIONS.find((s) => s.id === tpl.section)?.name || tpl.section;
        }
      }
      break;
    }
    case 'new-page-go': {
      stop();
      const title = ($('.modal [data-m="title"]')?.value || '').trim();
      const section = $('.modal [data-m="section"]')?.dataset.value || 'projects';
      
      UI.modal.title = title;
      UI.modal.section = section;
      if (!title) { UI.modal.error = 'Every page needs a title.'; render(); break; }
      if (Store.pageByTitle(title)) { UI.modal.error = `“${title}” already exists. Titles are how pages link, so they have to be unique.`; render(); break; }
      const tpl = TEMPLATES.find((t) => t.id === (UI.modal.tpl || 'blank'));
      UI.modal = null;
      openEditor(null, true, { title, body: tpl.body, section });
      UI.editor.dirty = true;
      render();
      break;
    }

    /* ---- editor ---- */
    case 'ed-mode': stop(); {
      UI.editor.mode = el.dataset.mode;
      Store.prefs().editorMode = el.dataset.mode;
      Store.persist();
      const ed = $('.editor');
      if (ed) ed.className = ed.className.replace(/mode-\w+/, 'mode-' + el.dataset.mode);
      $$('.editor__mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === el.dataset.mode));
      edUpdatePreview();
      break;
    }
    case 'ed-tool': stop(); ED_TOOLS[el.dataset.tool]?.(); break;
    case 'ed-discard-draft': {
      stop();
      const pid = UI.editor.pageId;
      draftStash.delete(pid || 'new');
      draftDeleted.add(pid || 'new');
      persistDrafts();
      UI.editor = null;
      openEditor(pid, !pid);
      render();
      toast('Draft discarded. Editing the current version');
      break;
    }
    case 'ed-cancel': stop(); requestEditorClose(); break;
    case 'editor-keep-draft': stop(); { UI.modal = null; const pid = UI.editor.pageId; stashDraftIfDirty(true); nav(pid ? '#/page/' + pid : '#/home'); route(); render(); toast('Draft kept. It will be waiting when you come back'); } break;
    case 'editor-discard-close': stop(); { UI.modal = null; const pid = UI.editor.pageId; draftStash.delete(pid || 'new'); draftDeleted.add(pid || 'new'); persistDrafts(); UI.editor = null; nav(pid ? '#/page/' + pid : '#/home'); route(); render(); } break;
    case 'copy-mine': stop(); { try { await navigator.clipboard.writeText(UI.editor?.body || ''); toast('Your version copied'); } catch (e) { toast("Couldn't copy: your browser blocked clipboard access"); } } break;
    case 'ed-save': stop(); edSave(); break;
    case 'page-review-dismiss': {
      stop();
      const m = UI.modal;
      if (m?.kind !== 'save-summary') return;
      (m.reviewDismissed ||= new Set()).add(el.dataset.kind);
      paintPageReview(m);
      $('.modal [data-action="save-commit"]')?.focus();
      break;
    }
    case 'page-review-section': {
      stop();
      const m = UI.modal;
      if (m?.kind !== 'save-summary' || !UI.editor || !SECTIONS.some((s) => s.id === el.dataset.section)) return;
      const manualSummary = m.summaryEdited ? m.summary : null;
      UI.editor.section = el.dataset.section;
      markDirty(); autosaveDraft();
      UI.modal = null;
      edSave();
      if (manualSummary !== null && UI.modal?.kind === 'save-summary') {
        UI.modal.summary = manualSummary; UI.modal.summaryEdited = true;
        $('.modal [data-m="summary"]').value = manualSummary;
        $('.modal [data-action="save-commit"]').disabled = false;
      }
      break;
    }
    case 'ed-ac': stop(); edAcceptAc(el.dataset.title); break;
    case 'save-commit': stop(); if (!el.disabled) edCommit(edSummaryValue($('.modal [data-m="summary"]')?.value)); break;

    /* ---- history ---- */
    case 'rev-restore': stop(); Store.restoreRev(el.dataset.id, +el.dataset.ts); nav('#/page/' + el.dataset.id); route(); render(); toast('Version restored'); break;

    /* ---- palette ---- */
    case 'palette': stop(); openPalette(); break;
    case 'palette-close': if (ev.target === el) { stop(); UI.palette = null; render(); } break;
    case 'palette-go': stop(); { const id = el.dataset.id; UI.palette = null; nav('#/page/' + id); route(); render(); } break;
    case 'palette-create': stop(); { const t = UI.palette.q.trim(); UI.palette = null; UI.modal = { kind: 'new-page', title: t, tpl: 'blank' }; render(); } break;

    /* ---- admin ---- */
    case 'members-add': {
      stop();
      if (!Store.isAdmin()) break;
      UI.memberInviteOpen = true;
      const panel = $('[data-member-invite]');
      if (panel) panel.hidden = false;
      el.setAttribute('aria-expanded', 'true');
      $('form[data-action="invite-form"] [name="emails"]')?.focus();
      break;
    }
    case 'members-add-close': {
      stop();
      if (UI.adminFormPending?.has('invite-form')) break;
      UI.memberInviteOpen = false;
      const panel = $('[data-member-invite]');
      if (panel) panel.hidden = true;
      const trigger = $('[data-action="members-add"]');
      trigger?.setAttribute('aria-expanded', 'false');
      trigger?.focus({ preventScroll: true });
      break;
    }
    case 'invite-view': stop(); UI.modal = { kind: 'invite-mail', email: el.dataset.email }; render(); break;
    case 'role-toggle': {
      stop();
      const u = Store.user(el.dataset.email);
      if (u) updateAdminMember(u.email, u.role === 'admin' ? 'member' : 'admin');
      break;
    }
    case 'user-remove': {
      stop();
      const email = el.dataset.email;
      if (!Store.isAdmin() || !Store.user(email) || email === Store.me()?.email || UI.memberPending?.has(email)) break;
      UI.modal = { kind: 'confirm', title: 'Remove member?', text: `<b>${MD.esc(email)}</b> loses access immediately. Their pages and edits stay.`, confirm: 'Remove', danger: true };
      const returnFocus = focusReference(el);
      UI.modal.onGo = () => updateAdminMember(email, null, returnFocus);
      render();
      break;
    }

    /* ---- interest list (self-contained component; talks to its own API) ---- */
    case 'interest-select': {
      ev.stopPropagation(); // Keep the checkbox's native click/Space behavior.
      const selected = interestSelection();
      if (el.checked) selected.add(el.dataset.id); else selected.delete(el.dataset.id);
      renderInterestSelection();
      break;
    }
    case 'interest-select-visible': {
      ev.stopPropagation();
      const selected = interestSelection();
      for (const row of interestVisible()) {
        if (el.checked) selected.add(row.id); else selected.delete(row.id);
      }
      renderInterestSelection();
      break;
    }
    case 'interest-clear-selection': {
      stop();
      interestSelection().clear();
      renderInterestSelection();
      break;
    }
    case 'interest-copy-emails': {
      stop();
      const emails = interestSelectedEmails();
      if (!emails.length) return;
      const csv = interestEmailsCsv(emails);
      try {
        await navigator.clipboard.writeText(csv);
        toast(`Copied ${emails.length} ${emails.length === 1 ? 'email' : 'emails'} as CSV`);
      } catch {
        UI.modal = { kind: 'interest-email-copy', csv };
        render();
        const text = $('.modal textarea');
        text?.focus();
        text?.select();
      }
      break;
    }
    case 'interest-refresh': {
      stop();
      UI.interest = undefined; // the route loader refetches
      UI.interestArchives = undefined;
      render();
      break;
    }
    case 'interest-tools': {
      stop();
      openMenu([
        { label: 'Refresh list', run: () => { UI.interest = undefined; UI.interestArchives = undefined; render(); } },
        { label: 'Archive list…', run: archiveInterestList },
        '-',
        { label: 'Check storage', run: checkInterestStorage },
      ], el);
      break;
    }
    case 'interest-storage-check': stop(); await checkInterestStorage(); break;
    case 'interest-flag': stop(); await toggleInterestFlag(el.dataset.id); break;
    case 'interest-comment-delete': stop(); confirmInterestCommentRemoval(el.dataset.id, el.dataset.cid); break;
    case 'interest-comment-delete-cancel': stop(); confirmInterestCommentRemoval(el.dataset.id, el.dataset.cid, true); break;
    case 'interest-comment-delete-confirm': stop(); await deleteInterestComment(el.dataset.id, el.dataset.cid); break;
    case 'interest-remove-selected': stop(); confirmInterestRemoval([...interestSelection()]); break;
    case 'interest-open': {
      stop();
      if (!UI.interestArchiveView && UI.interestDeleting?.has(el.dataset.id)) { toast('Deletion is in progress'); break; }
      UI.modal = { kind: 'interest-row', id: el.dataset.id };
      render();
      if (el.dataset.comments) $('.interest-compose textarea')?.focus();
      else $('.interest-review [data-action="modal-close"]')?.focus();
      break;
    }
    case 'interest-pending-open': {
      stop();
      if (!Store.isAdmin() || !interestPendingReview().some((row) => row.id === el.dataset.id)) return;
      UI.modal = { kind: 'interest-pending', id: el.dataset.id };
      render();
      break;
    }
    case 'interest-sort': {
      stop();
      const key = el.dataset.key;
      const cur = UI.interestSort || { key: 'ts', dir: 'desc' };
      // Text reads best ascending first; dates start at the newest.
      const firstDir = key === 'ts' ? 'desc' : 'asc';
      UI.interestSort = cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: firstDir };
      // Headers and rows update in place: sorting must never flash the page
      // or drop focus from the header you just clicked.
      const { key: sk, dir } = UI.interestSort;
      for (const btn of $$('.sheet__sort[data-key]')) {
        const on = btn.dataset.key === sk;
        btn.classList.toggle('on', on);
        btn.closest('th').setAttribute('aria-sort', on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
        const caret = btn.querySelector('.sheet__caret');
        if (caret) caret.textContent = on ? (dir === 'asc' ? '↑' : '↓') : '';
      }
      renderInterestRows();
      break;
    }
    case 'interest-remove': stop(); confirmInterestRemoval([el.dataset.id]); break;
    case 'interest-archive': stop(); archiveInterestList(); break;
    case 'interest-archive-open': {
      stop();
      UI.interestArchiveView = { id: el.dataset.id, loading: true };
      UI.interestQuery = '';
      UI.interestFilter = 'all';
      UI.interestSubteam = '';
      render();
      break;
    }
    case 'interest-archive-back': {
      stop();
      UI.interestArchiveView = null;
      UI.interestQuery = '';
      UI.interestFilter = 'all';
      UI.interestSubteam = '';
      render();
      break;
    }
    case 'interest-archive-remove': {
      stop();
      const id = el.dataset.id;
      const name = el.dataset.name || 'this archive';
      UI.modal = {
        kind: 'confirm',
        title: 'Delete this archive?',
        text: `<b>${MD.esc(name)}</b> and its attachments are erased for good. Download its CSV first if you want a record.`,
        confirm: 'Delete archive',
        danger: true,
        typed: 'delete archive',
      };
      UI.modal.onGo = () => {
        api(`/interest/archives/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(20000) })
          .then(() => {
            const removedView = UI.interestArchiveView?.id === id;
            if (removedView) UI.interestArchiveView = null;
            UI.interestArchives = undefined;
            if (removedView && UI.modal?.kind === 'interest-row') closeModal(() => renderBackground('interest'));
            else renderBackground('interest');
            toast('Archive deleted');
          })
          .catch((e) => { toast(`Could not delete: ${e.message}`); });
      };
      render();
      break;
    }

    /* ---- trash ---- */
    case 'trash-restore': stop(); { const p = Store.restorePage(el.dataset.id); render(); toast(`Restored “${p.title}”`); } break;
    case 'trash-purge': {
      stop();
      const id = el.dataset.id;
      UI.modal = { kind: 'confirm', title: 'Delete forever?', text: 'This page and its whole history are permanently erased. There is no undo after this one.', confirm: 'Delete forever', danger: true };
      UI.modal.onGo = () => { Store.purgePage(id); render(); toast('Deleted forever'); };
      render();
      break;
    }

    case 'move-go': {
      stop();
      Store.movePage(el.dataset.id, { section: $('.modal [data-m="section"]').dataset.value });
      UI.modal = null;
      render(); toast('Moved');
      break;
    }

    /* ---- modal plumbing ---- */
    case 'modal-close': stop(); if (UI.modal?.kind === 'bug') bugSyncFields(); closeModal(); break;
    case 'modal-veil': if (ev.target === el) { stop(); closeModal(); } break;
    case 'confirm-go': stop(); { const go = UI.modal?.onGo; const v = document.querySelector('.modal [data-m="modal-field"]')?.value; if (UI.modal) UI.modal.onGo = null; closeModal(go ? () => go(v) : null); } break;

    case 'toast-act': stop(); { const t = UI.toasts.find((x) => x.id === el.dataset.tid); if (t?.action) { const run = t.action.run; dismissToast(t); run(); } } break;
  }
});

/* ------------------------------- forms ----------------------------------- */

function adminFormMessage(form, message) {
  let error = $('[data-admin-error]', form);
  if (!error && !message) return;
  if (!error) {
    error = document.createElement('p');
    error.className = 'field-error';
    error.dataset.adminError = '';
    error.setAttribute('role', 'alert');
    error.style.flexBasis = '100%';
    error.style.margin = '0';
    form.style.flexWrap = 'wrap';
    form.append(error);
  }
  error.textContent = message;
  error.hidden = !message;
  if (message && !form.isConnected) toast(message);
}

async function updateAdminMember(email, role, returnFocus = null) {
  const user = Store.user(email);
  if (!Store.isAdmin() || !user || email === Store.me()?.email) return;
  UI.memberPending ||= new Set();
  if (UI.memberPending.has(email)) return;
  const name = user.name || email;
  const focus = returnFocus || ($('[data-member-rows]')?.contains(document.activeElement) ? focusReference(document.activeElement) : null);
  UI.memberPending.add(email);
  renderMemberRows();
  try {
    if (typeof REMOTE === 'undefined') {
      if (role) Store.setRole(email, role);
      else Store.removeUser(email);
    } else await requestMutation(role ? 'setRole' : 'removeUser', role ? { email, role } : { email });
    toast(role ? `${name} is now ${role === 'admin' ? 'an admin' : 'a member'}` : 'Member removed');
  } catch (e) {
    toast(e.name === 'TimeoutError' ? 'The request timed out. Check the current member list before retrying.' : e.message || 'Could not update this member.');
  } finally {
    UI.memberPending.delete(email);
    if (UI.route?.name === 'admin' && !UI.editor) {
      renderMemberRows();
      if (focus && !UI.modal && document.activeElement === document.body) {
        (resolveFocus(focus) || $('[data-m="member-q"]'))?.focus({ preventScroll: true });
      }
    }
  }
}

function syncEmailPending() {
  const busy = Boolean(UI.emailBusy || UI.adminFormPending?.has('email-settings-form'));
  $('.email-integration')?.setAttribute('aria-busy', String(busy));
  $$('.email-integration [data-action="email-test"], .email-integration [data-action="resend-disconnect"], .email-integration [data-action="email-edit"], .email-integration form button[type="submit"]').forEach((el) => { el.disabled = busy; });
}

function paintEmailIntegration() {
  if (UI.route?.name !== 'admin' || UI.editor || UI.modal) return;
  const section = $('.email-integration');
  if (!section) return;
  const forms = $$('form[data-action="email-settings-form"]', section).filter((form) => form.dataset.adminDirty === 'true' || form.dataset.adminPending === 'true');
  const active = document.activeElement;
  if (forms.some((form) => form.classList.contains('integration__editor'))) UI.emailEdit = true;
  section.outerHTML = viewEmailSettings();
  const next = $('.email-integration');
  for (const form of forms) {
    const target = $(form.classList.contains('integration__editor') ? 'form.integration__editor' : 'form:not(.integration__editor)', next);
    if (target) { target.replaceWith(form); const disclosure = form.closest('details'); if (disclosure) disclosure.open = true; }
  }
  if (active?.isConnected && document.activeElement === document.body) active.focus({ preventScroll: true });
}

async function runEmailIntegrationAction(action) {
  if (!Store.isAdmin() || UI.emailBusy || UI.adminFormPending?.has('email-settings-form')) return;
  if (typeof REMOTE === 'undefined') { toast('Configure email on the live wiki.'); return; }
  const origin = $('.email-integration');
  const active = document.activeElement, recipient = Store.me()?.email;
  UI.emailBusy = action;
  origin?.setAttribute('aria-busy', 'true');
  const controls = $$('[data-action="email-test"], [data-action="resend-disconnect"], [data-action="email-edit"], form button[type="submit"]', origin || document);
  controls.forEach((el) => { el.disabled = true; });
  syncEmailPending();
  try {
    const out = await api(action === 'disconnect' ? '/resend/disconnect' : '/test-email', {
      method: 'POST', body: JSON.stringify({}), signal: AbortSignal.timeout(30000),
    });
    if (action === 'disconnect') {
      adoptServer(out);
      UI.resendDomains = undefined;
      UI.emailBusy = false;
      paintEmailIntegration();
      toast('Resend disconnected');
    } else toast(out.sent ? `Test sent to ${recipient}.` : `Not sent: ${out.reason || 'delivery was not confirmed'}`);
  } catch (e) {
    toast(e.name === 'TimeoutError' ? (action === 'test' ? 'The test timed out. Delivery was not confirmed.' : 'The disconnect timed out. Check the connection before retrying.') : e.message || 'The email request failed.');
  } finally {
    UI.emailBusy = false;
    controls.forEach((el) => { el.disabled = false; });
    syncEmailPending();
    if (!UI.modal && UI.route?.name === 'admin' && !UI.editor && document.activeElement === document.body) {
      if (active?.isConnected) active.focus({ preventScroll: true });
      else if (origin?.isConnected === false) $('.email-integration .integration__actions button, .email-integration .integration__actions a')?.focus({ preventScroll: true });
    }
  }
}

async function runAdminForm(form, submit) {
  UI.adminFormPending ||= new Set();
  const kind = form.dataset.action;
  if (UI.adminFormPending.has(kind)) return;
  UI.adminFormPending.add(kind);
  form.dataset.adminPending = 'true';
  const active = document.activeElement;
  const controls = $$('button, input, textarea', form).map((el) => [el, el.disabled]);
  controls.forEach(([el]) => { el.disabled = true; });
  if (kind === 'email-settings-form') syncEmailPending();
  adminFormMessage(form, '');
  try { await submit(); }
  catch (e) {
    form.dataset.adminDirty = 'true';
    adminFormMessage(form, e.name === 'TimeoutError' ? 'The request timed out. Your entries are still here. Check the saved result before retrying.' : e.message || 'Could not save. Your entries are still here.');
  } finally {
    UI.adminFormPending.delete(kind);
    form.dataset.adminPending = 'false';
    controls.forEach(([el, disabled]) => { el.disabled = disabled; });
    if (kind === 'email-settings-form') syncEmailPending();
    if (form.isConnected && active?.isConnected && document.activeElement === document.body) active.focus({ preventScroll: true });
  }
}

function paintAdminFormSuccess(form) {
  form.dataset.adminDirty = 'false';
  form.dataset.adminPending = 'false';
  if (UI.route?.name === 'admin' && !UI.editor && !UI.modal && form.isConnected) {
    render();
    return $(`form[data-action="${form.dataset.action}"]`);
  }
  return form.isConnected ? form : null;
}

async function submitEmailSettings(form) {
  if (UI.emailBusy) return;
  const values = { from: form.elements.from.value.trim(), key: form.elements.key?.value.trim() || '', name: form.elements.fromname.value.trim() };
  await runAdminForm(form, async () => {
    if (typeof REMOTE === 'undefined') Store.setEmailSettings(values);
    else await requestMutation('setEmailSettings', values);
    if (form.elements.key) form.elements.key.value = '';
    UI.emailFromCustom = false;
    UI.emailEdit = false;
    paintAdminFormSuccess(form);
    toast('Email settings saved');
  });
}

async function submitInvites(form) {
  const emails = [...new Set((form.elements.emails.value.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map((e) => e.toLowerCase()))];
  if (!emails.length) { if (form.elements.emails.value.trim()) adminFormMessage(form, 'No email addresses found in that.'); return; }
  const role = $('[data-m="invite-role"]', form)?.dataset.value || 'member';
  await runAdminForm(form, async () => {
    const preview = typeof REMOTE === 'undefined';
    const out = preview ? { result: Store.addMembers(emails, role), emailed: [] } : await requestMutation('addMembers', { emails, role });
    const results = out.result || [], added = results.filter((r) => r.ok), rejected = results.filter((r) => !r.ok);
    form.elements.emails.value = rejected.map((r) => r.email).join(', ');
    const completedForm = paintAdminFormSuccess(form);
    if (preview && added.length === 1 && UI.route?.name === 'admin' && !UI.editor && !UI.modal) {
      UI.modal = { kind: 'invite-mail', email: added[0].email }; render();
    } else if (added.length) {
      const sent = (out.emailed || []).filter((r) => r.sent).length;
      toast(`Added ${added.length} ${added.length === 1 ? 'member' : 'members'}${sent ? `; ${sent} welcome ${sent === 1 ? 'email' : 'emails'} sent` : ''}`);
    }
    const issues = [
      ...rejected.map((r) => `${r.email}: ${r.reason}`),
      ...(out.emailed || []).filter((r) => !r.sent).map((r) => `${r.email} was added. Welcome email not sent: ${r.reason || 'delivery was not confirmed'}.`),
    ];
    if (issues.length) {
      const current = completedForm;
      if (current) {
        current.elements.emails.value = form.elements.emails.value;
        current.dataset.adminDirty = rejected.length ? 'true' : 'false';
        adminFormMessage(current, issues.join(' '));
      } else toast(issues.join(' '));
    }
  });
}

document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('[data-action]');
  if (!form) return;
  ev.preventDefault();
  const act = form.dataset.action;

  if (act === 'interest-comment-form') { postInterestComment(form.dataset.id); return; }

  if (act === 'ai-settings-form') { changeAiSettings(form); return; }

  if (act === 'email-settings-form') {
    submitEmailSettings(form);
    return;
  }

  if (act === 'invite-form') {
    submitInvites(form);
  }
});

/* ------------------------------- inputs ---------------------------------- */

// Composition and hidden tabs must not spend requests on unfinished input.
document.addEventListener('compositionstart', (ev) => {
  if (UI.editor && ev.target.matches('[data-ed="body"], [data-ed="title"]')) {
    UI.editor.composing = true;
    clearTimeout(UI.editor.summaryTimer); UI.editor.summaryTimer = null;
  }
});
document.addEventListener('compositionend', (ev) => {
  if (UI.editor && ev.target.matches('[data-ed="body"], [data-ed="title"]')) {
    UI.editor.composing = false;
    scheduleChangeSummary();
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { syncChangeSummary(); syncAiUsage(); }
});

let previewTimer = null;
document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (UI.route.name === 'admin' && t.closest('form[data-action]')) t.closest('form[data-action]').dataset.adminDirty = 'true';

  if (t.matches('[data-m="member-q"]')) {
    UI.memberQuery = t.value;
    renderMemberRows();
    return;
  }

  if (t.matches('.palette input')) {
    UI.palette.q = t.value;
    UI.palette.sel = 0;
    renderPaletteList(); // input DOM stays put — the caret never jumps
    return;
  }

  // Type-to-confirm gates: the danger button unlocks only on an exact match,
  // toggled directly on the DOM so the caret never jumps.
  if (t.matches('[data-m="modal-typed"]')) {
    const go = document.querySelector('.modal [data-action="confirm-go"]');
    if (go) go.disabled = t.value.trim() !== t.dataset.phrase;
    return;
  }

  if (t.matches('[data-m="summary"]') && UI.modal?.kind === 'save-summary') {
    UI.modal.summary = t.value;
    UI.modal.summaryEdited = true;
    $('.modal [data-action="save-commit"]').disabled = false;
    return;
  }

  if (t.matches('[data-m="interest-comment"]')) {
    const draft = interestDraft(t.dataset.id);
    draft.text = t.value;
    if (!draft.sending) draft.id = null;
    const button = t.closest('form').querySelector('[type="submit"]');
    button.disabled = draft.sending || !draft.text.trim();
    return;
  }

  // Filtering the interest sheet redraws only its rows, for the same reason.
  if (t.matches('[data-m="interest-q"]')) {
    UI.interestQuery = t.value;
    renderInterestRows();
    return;
  }

  if (!UI.editor) return;

  if (t.matches('[data-ed="title"]')) {
    UI.editor.title = t.value;
    markDirty();
    autosaveDraft();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { edUpdatePreview(); edMirrorSel(); }, 160);
  }
  if (t.matches('[data-ed="body"]')) {
    UI.editor.body = t.value;
    $('.src-mirror')?.remove();
    const wc = $('[data-ed-count]');
    if (wc) wc.textContent = (t.value.trim() ? t.value.trim().split(/\s+/).length : 0) + ' words';
    markDirty();
    autosaveDraft();
    edAutocomplete(t);
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { edUpdatePreview(); edMirrorSel(); }, 160);
  }
});

/* ------------------ source selection mirrored in preview ------------------ */

const MIRROR_BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TR', 'PRE', 'BLOCKQUOTE', 'TABLE', 'FIGURE', 'FIGCAPTION', 'UL', 'OL', 'HR', 'DETAILS', 'SUMMARY', 'ASIDE', 'DIV', 'BR']);

// What the renderer keeps of a selected markdown span: link labels survive,
// syntax marks do not. Only needs to agree with MD.render on visible text.
function mdSelText(s) {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]#|]+)(?:#[^\]|]*)?\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]#|]+)(?:#[^\]|]*)?\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^ {0,3}#{1,6} +/gm, ' ')
    .replace(/^ {0,3}(?:[-*+]|\d+[.)]) +(?:\[[ xX]\] +)?/gm, ' ')
    .replace(/^ {0,3}>+ ?/gm, ' ')
    .replace(/^ *:::.*$/gm, ' ')
    .replace(/^ *(?:-{3,}|_{3,}|\*{3,}) *$/gm, ' ')
    .replace(/^```.*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/[*_~`]+/g, '');
}

const MIRROR_FOLD = { '\u2019': "'", '\u2018': "'", '\u201c': '"', '\u201d': '"', '\u2013': '-', '\u2014': '-', '\u00a0': ' ' };
const foldCh = (c) => MIRROR_FOLD[c] || c.toLowerCase();

function foldCollapse(s) {
  let out = ''; let ws = false;
  for (const ch of s) {
    if (/\s/.test(foldCh(ch))) { ws = out.length > 0; continue; }
    if (ws) { out += ' '; ws = false; }
    out += foldCh(ch);
  }
  return out;
}

// Fold the preview's visible text the same way, keeping a per-character map
// back to (text node, offset) so a match can become a live Range.
function previewIndex(host) {
  const chars = []; const locs = []; let boundary = false;
  (function walk(n) {
    if (n.nodeType === 3) {
      const s = n.nodeValue;
      for (let i = 0; i < s.length; i++) {
        const f = foldCh(s[i]);
        if (/\s/.test(f)) { boundary = chars.length > 0; continue; }
        if (boundary) { chars.push(' '); locs.push(null); boundary = false; }
        chars.push(f); locs.push({ node: n, off: i });
      }
      return;
    }
    if (n.nodeType !== 1 || n.hidden || n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return;
    if (MIRROR_BLOCKS.has(n.tagName) && chars.length) boundary = true;
    for (const c of n.childNodes) walk(c);
    if (MIRROR_BLOCKS.has(n.tagName) && chars.length) boundary = true;
  })(host);
  return { text: chars.join(''), locs };
}

function edMirrorSel() {
  const clear = () => window.CSS?.highlights?.delete('wiki-sync');
  const ta = $('[data-ed="body"]'); const host = $('[data-ed-preview]');
  if (!ta || !host || !UI.editor) { clear(); return; }
  const a = ta.selectionStart; const b = ta.selectionEnd;
  if (document.activeElement !== ta || a === b) { clear(); return; }
  const needle = foldCollapse(mdSelText(ta.value.slice(a, b)));
  if (needle.length < 2) { clear(); return; }
  const { text, locs } = previewIndex(host);
  const hits = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) hits.push(i);
  if (!hits.length) { clear(); return; }
  // several matches: take the one sitting at about the same depth into the page
  const want = a / Math.max(1, ta.value.length);
  const best = hits.reduce((p, c) => (Math.abs(c / text.length - want) < Math.abs(p / text.length - want) ? c : p));
  let s = best; let e = best + needle.length - 1;
  while (s <= e && !locs[s]) s++;
  while (e >= s && !locs[e]) e--;
  if (s > e) { clear(); return; }
  const range = document.createRange();
  range.setStart(locs[s].node, locs[s].off);
  range.setEnd(locs[e].node, locs[e].off + 1);
  if (window.CSS?.highlights) CSS.highlights.set('wiki-sync', new Highlight(range));
  const pane = host.closest('.editor__pane--preview');
  if (pane && pane.clientWidth) {
    const r = range.getBoundingClientRect(); const pr = pane.getBoundingClientRect();
    if (r.top < pr.top + 40 || r.bottom > pr.bottom - 40) {
      pane.scrollTo({ top: pane.scrollTop + (r.top - pr.top) - pane.clientHeight * 0.35 });
    }
  }
}

/* ---- and the reverse: a preview selection finds its markdown ---- */

// Strip each source line to its rendered text and remember raw offsets, so a
// phrase copied from the preview can be located back in the markdown.
function sourceFind(raw, needle, wantRatio) {
  const lines = raw.split('\n');
  let concat = ''; const lineMap = []; let rawPos = 0;
  for (const ln of lines) {
    const stripped = foldCollapse(mdSelText(ln));
    if (stripped) {
      if (concat) concat += ' ';
      lineMap.push({ cStart: concat.length, cEnd: concat.length + stripped.length, rawStart: rawPos, rawEnd: rawPos + ln.length });
      concat += stripped;
    }
    rawPos += ln.length + 1;
  }
  const hits = [];
  for (let i = concat.indexOf(needle); i !== -1; i = concat.indexOf(needle, i + 1)) hits.push(i);
  if (!hits.length) return null;
  const best = hits.reduce((p, c) => (Math.abs(c / concat.length - wantRatio) < Math.abs(p / concat.length - wantRatio) ? c : p));
  const endC = best + needle.length;
  const first = lineMap.find((l) => l.cEnd > best);
  const last = [...lineMap].reverse().find((l) => l.cStart < endC);
  return first && last ? { start: first.rawStart, end: last.rawEnd } : null;
}

// y of a source offset inside the soft-wrapped textarea, via a matching ghost.
function taTextY(ta, idx) {
  const d = document.createElement('div');
  const cs = getComputedStyle(ta);
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize', 'overflowWrap', 'wordBreak']) d.style[p] = cs[p];
  d.style.cssText += ';position:absolute;visibility:hidden;white-space:pre-wrap;padding:0;border:0;';
  d.style.width = (ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) + 'px';
  d.textContent = ta.value.slice(0, idx) + 'x';
  document.body.appendChild(d);
  const h = d.offsetHeight;
  d.remove();
  const lineH = parseFloat(cs.lineHeight) || 20;
  return { top: h - lineH, bottom: h };
}

function srcMirrorMark(ta, y0, y1) {
  $('.src-mirror')?.remove();
  const pane = ta.closest('.editor__pane--src');
  if (!pane) return;
  const m = document.createElement('div');
  m.className = 'src-mirror';
  m.dataset.top = y0; m.dataset.height = Math.max(y1 - y0, 4);
  pane.appendChild(m);
  srcMirrorPlace(ta);
}

function srcMirrorPlace(ta) {
  const m = $('.src-mirror');
  if (!m || !ta) return;
  const padTop = parseFloat(getComputedStyle(ta).paddingTop) || 0;
  const y = ta.offsetTop + padTop + (+m.dataset.top) - ta.scrollTop;
  m.style.top = y + 'px';
  m.style.height = m.dataset.height + 'px';
  m.hidden = y + +m.dataset.height < ta.offsetTop || y > ta.offsetTop + ta.clientHeight;
}

document.addEventListener('scroll', (ev) => {
  if (ev.target instanceof Element && ev.target.matches('[data-ed="body"]')) srcMirrorPlace(ev.target);
}, true);

function edReverseMirror() {
  const host = $('[data-ed-preview]'); const ta = $('[data-ed="body"]');
  const clear = () => $('.src-mirror')?.remove();
  if (!host || !ta || !UI.editor || UI.editor.mode !== 'split') { clear(); return; }
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) { clear(); return; }
  const range = sel.getRangeAt(0);
  if (!host.contains(range.commonAncestorContainer)) { clear(); return; }
  const needle = foldCollapse(sel.toString());
  if (needle.length < 2) { clear(); return; }
  // rank duplicate matches by how deep into the page the selection sits
  const { text, locs } = previewIndex(host);
  let pos = 0;
  for (let i = 0; i < locs.length; i++) {
    const L = locs[i];
    if (L && L.node === range.startContainer && L.off >= range.startOffset) { pos = i; break; }
  }
  const found = sourceFind(ta.value, needle, pos / Math.max(1, text.length));
  if (!found) { clear(); return; }
  const a = taTextY(ta, found.start); const b = taTextY(ta, found.end);
  const padTop = parseFloat(getComputedStyle(ta).paddingTop) || 0;
  const want = a.top + padTop - ta.clientHeight * 0.35;
  if (a.top + padTop < ta.scrollTop + 40 || b.bottom + padTop > ta.scrollTop + ta.clientHeight - 40) ta.scrollTop = Math.max(0, want);
  srcMirrorMark(ta, a.top, b.bottom);
}

let mirrorTimer = null;
document.addEventListener('selectionchange', () => {
  if (!UI.editor) return;
  clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(() => { edMirrorSel(); edReverseMirror(); }, 120);
});

document.addEventListener('click', (ev) => {
  const pc = ev.target instanceof Element && ev.target.closest('[data-action-preview="resend-connect"]');
  if (pc && typeof REMOTE === 'undefined') { ev.preventDefault(); ev.stopPropagation(); toast('Preview build: connect on the live wiki.'); return; }
  const miss = ev.target instanceof Element && ev.target.closest('a.wikilink--missing');
  if (!miss) return;
  ev.preventDefault();
  ev.stopPropagation();
  const q = (miss.getAttribute('href') || '').split('?')[1] || '';
  const title = decodeURIComponent((q.match(/title=([^&]*)/) || [])[1] || '');
  const sec = UI.route.name === 'page' ? Store.page(UI.route.params.id || 'welcome')?.section : null;
  UI.modal = { kind: 'new-page', title, section: sec || 'projects', tpl: 'blank' };
  render();
}, true);

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.matches('input[data-task]')) {
    const pageId = t.closest('[data-page]')?.dataset.page;
    if (pageId) {
      const n = +t.dataset.task;
      const checked = t.checked;
      Store.toggleTask(pageId, n);
      const title = Store.page(pageId)?.title || 'this page';
      toast('Saved', { label: 'Undo', run: () => { Store.toggleTask(pageId, n); render(); } });
      render();
    }
    return;
  }
  if (t.matches('[data-ed-file]')) {
    edHandleFiles([...t.files]);
    t.value = '';
  }
});

function markDirty() {
  schedulePageReview();
  scheduleChangeSummary();
  if (!UI.editor || UI.editor.dirty) return;
  UI.editor.dirty = true;
  const crumb = $('.crumbs');
  if (crumb && !$('.crumbs__draft')) crumb.insertAdjacentHTML('beforeend', '<span class="crumbs__draft">unsaved</span>');
}

/* ------------------------------- drag/drop + paste ----------------------- */

document.addEventListener('dragover', (ev) => {
  if (UI.editor && ev.dataTransfer?.types.includes('Files')) { ev.preventDefault(); $('.editor')?.classList.add('dropping'); }
});
document.addEventListener('dragleave', (ev) => {
  if (ev.target === document.documentElement || !ev.relatedTarget) $('.editor')?.classList.remove('dropping');
});
document.addEventListener('drop', (ev) => {
  if (UI.editor && ev.dataTransfer?.files.length) {
    ev.preventDefault();
    $('.editor')?.classList.remove('dropping');
    edHandleFiles([...ev.dataTransfer.files]);
  }
});
document.addEventListener('paste', (ev) => {
  if (!UI.editor || !ev.target.matches('[data-ed="body"]')) return;
  const files = [...(ev.clipboardData?.files || [])];
  if (files.length) { ev.preventDefault(); edHandleFiles(files); }
});

/* ------------------------------- keyboard -------------------------------- */

document.addEventListener('keydown', (ev) => {
  if (ev.isComposing || ev.keyCode === 229) return;
  const mod = ev.metaKey || ev.ctrlKey;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName) || ev.target.isContentEditable;

  if (UI.menu) {
    if (ev.key === 'Escape') { ev.preventDefault(); window.__closeMenu?.(); }
    return; // A popup owns keys until selection, Tab, or dismissal.
  }

  // Focus trap: Tab stays inside an open modal (Linear/Notion behavior).
  if (ev.key === 'Tab' && UI.modal && $('.modal')) {
    const focusables = modalFocusables($('.modal'));
    if (focusables.length) {
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (ev.shiftKey && (document.activeElement === first || !$('.modal').contains(document.activeElement))) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && (document.activeElement === last || !$('.modal').contains(document.activeElement))) { ev.preventDefault(); first.focus(); }
    } else { ev.preventDefault(); $('.modal').focus(); }
    return;
  }

  if (ev.key === 'Tab' && UI.navOpen && innerWidth <= 860 && !UI.modal && !UI.palette) {
    const sidebar = $('.sidebar');
    const controls = modalFocusables(sidebar).filter((el) => !el.closest('[inert]'));
    const first = controls[0], last = controls[controls.length - 1];
    if (ev.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) { ev.preventDefault(); last?.focus(); }
    else if (!ev.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) { ev.preventDefault(); first?.focus(); }
    return;
  }

  // Palette navigation.
  if (UI.palette) {
    if (ev.key === 'Escape') { ev.preventDefault(); UI.palette = null; render(); return; }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const n = UI.palette.count || 0;
      if (n) {
        UI.palette.sel = (UI.palette.sel + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n;
        const items = $$('.palette__item');
        items.forEach((b, i) => b.classList.toggle('sel', i === UI.palette.sel));
        items[UI.palette.sel]?.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const btn = $$('.palette__item')[UI.palette.sel];
      if (btn) btn.click();
      else $('.palette [data-action="palette-create"]')?.click();
      return;
    }
  }

  if (mod && ev.key.toLowerCase() === 'k') {
    ev.preventDefault();
    if (UI.modal) return; // a modal owns the keyboard
    if (UI.editor && ev.target.matches('[data-ed="body"]')) { ED_TOOLS.mdlink(); return; } // editors mean "insert link" here
    UI.palette ? (UI.palette = null, render()) : openPalette();
    return;
  }

  if (ev.key === 'Escape') {
    if (UI.menu) { ev.preventDefault(); window.__closeMenu?.(); return; }
    if (UI.modal) { ev.preventDefault(); closeModal(); return; }
    if ($('.lightbox')) { closeLightbox(); return; }
    const ac = $('.ed-autocomplete');
    if (ac && !ac.hidden) { ac.hidden = true; return; }
    // Esc asks before leaving a dirty editor; a clean one closes straight away.
    if (UI.editor) { requestEditorClose(); return; }
    if (UI.navOpen) { UI.navOpen = false; $('.shell')?.classList.remove('nav-open'); syncSidebarInteraction(true); return; }
  }

  // Save-summary dialog: Enter saves (checked before the editor block, which
  // otherwise swallows plain Enter for list continuation).
  if (UI.modal?.kind === 'save-summary' && ev.key === 'Enter' && !ev.shiftKey && (ev.target.matches('[data-m="summary"]') || mod)) {
    ev.preventDefault();
    $('.modal [data-action="save-commit"]')?.click();
    return;
  }

  if (UI.modal) return; // Editor shortcuts must not steal focus from a dialog.

  if (UI.editor) {
    if (UI.editor.saving) return;
    const inBody = ev.target.matches('[data-ed="body"]');
    // The [[ autocomplete is keyboard-first: arrows move, Enter/Tab accept.
    const acPop = $('.ed-autocomplete');
    if (acPop && !acPop.hidden && inBody) {
      const items = $$('.ed-autocomplete button');
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const cur = items.findIndex((b) => b.classList.contains('sel'));
        const next = (cur + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        items.forEach((b, i) => b.classList.toggle('sel', i === next));
        return;
      }
      if (ev.key === 'Enter' || ev.key === 'Tab') {
        ev.preventDefault();
        const sel = items.find((b) => b.classList.contains('sel')) || items[0];
        if (sel) edAcceptAc(sel.dataset.title);
        return;
      }
    }
    if (mod && ev.key.toLowerCase() === 'f') { ev.preventDefault(); edFindOpen(); return; }
    if (mod && (ev.key === 's' || ev.key === 'Enter')) { ev.preventDefault(); UI.modal?.kind === 'save-summary' ? $('.modal [data-action="save-commit"]')?.click() : edSave(); return; }
    if (mod && ev.key.toLowerCase() === 'b' && inBody) { ev.preventDefault(); ED_TOOLS.bold(); return; }
    if (mod && ev.key.toLowerCase() === 'i' && inBody) { ev.preventDefault(); ED_TOOLS.italic(); return; }
    // Tab indents instead of leaving the editor.
    if (ev.key === 'Tab' && inBody && !ev.shiftKey) {
      ev.preventDefault();
      edType(ev.target, '  ');
      return;
    }
    // Enter continues lists; Enter on an empty item ends the list.
    if (ev.key === 'Enter' && inBody && !ev.shiftKey && !mod && $('.ed-autocomplete')?.hidden !== false) {
      const ta = ev.target;
      const before = ta.value.slice(0, ta.selectionStart);
      const line = before.slice(before.lastIndexOf('\n') + 1);
      const m = line.match(/^(\s*)([-*]|\d+[.)])(\s+\[[ xX]\])?\s+(.*)$/);
      if (m) {
        ev.preventDefault();
        if (!m[4].trim()) {
          // empty item — remove the marker and end the list
          const lineStart = ta.selectionStart - line.length;
          ta.setSelectionRange(lineStart, ta.selectionEnd);
          edType(ta, '\n');
        } else {
          const num = /\d/.test(m[2][0]) ? (parseInt(m[2], 10) + 1) + m[2].slice(-1) : m[2];
          edType(ta, '\n' + m[1] + num + (m[3] ? ' [ ]' : '') + ' ');
        }
        return;
      }
    }
    return;
  }

  if (UI.modal || typing || mod || ev.altKey) return;

  if (ev.key === '?') { ev.preventDefault(); UI.modal = { kind: 'shortcuts' }; render(); return; }
  if (ev.key === 'n' || ev.key === 'N') { ev.preventDefault(); UI.modal = { kind: 'new-page', tpl: 'blank' }; render(); }
});

window.addEventListener('beforeunload', (ev) => {
  if (UI.editor?.dirty || UI.editor?.saving || UI.editor?.uploads) { ev.preventDefault(); ev.returnValue = ''; }
});

/* ------------------------------- routing + boot -------------------------- */

// Snappy in-page scroll: the content pane animates to just below the topbar,
// distance-scaled so nearby jumps feel immediate and long ones stay readable.
let anchorAnim = 0;
function smoothAnchor(el) {
  const my = ++anchorAnim; // a newer jump owns the scroll from its first frame
  // The pulse answers every click, including targets the scroll can't reach:
  // a heading near the end of the page bottoms out before the 68px line.
  el.classList.remove('anchor-flash');
  void el.offsetWidth;
  el.classList.add('anchor-flash');
  setTimeout(() => { if (el.isConnected) el.classList.remove('anchor-flash'); }, 950);
  const c = $('.content');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!c) { el.scrollIntoView({ behavior: reduced ? 'instant' : 'smooth' }); return; }
  const from = c.scrollTop;
  const d = Math.max(0, Math.min(from + el.getBoundingClientRect().top - c.getBoundingClientRect().top - 68, c.scrollHeight - c.clientHeight)) - from;
  if (Math.abs(d) < 2) return;
  if (reduced) { c.scrollTop = from + d; return; }
  const t0 = performance.now();
  const dur = Math.min(420, 180 + Math.abs(d) * 0.08);
  const step = (now) => {
    if (my !== anchorAnim) return;
    const k = Math.min(1, (now - t0) / dur);
    c.scrollTop = from + d * (1 - Math.pow(1 - k, 3));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// A link to a heading on the page already open skips the router entirely:
// no re-render (which shifts layout under the jump), just the scroll, with
// the fragment pushed into the URL the way a plain anchor would be.
document.addEventListener('click', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
  const a = ev.target instanceof Element && ev.target.closest('a[href^="#/page/"]');
  if (!a) return;
  const href = a.getAttribute('href');
  const hi = href.indexOf('#', 2);
  if (hi === -1) return;
  if (UI.route.name !== 'page' || href.slice(0, hi) !== '#/page/' + (UI.route.params.id || 'welcome')) return;
  const el = document.getElementById(href.slice(hi + 1));
  if (!el) return;
  ev.preventDefault();
  ev.stopPropagation();
  smoothAnchor(el);
  UI._tocPin = el.id; // the clicked entry stays lit even if the scroll clamps
  history.pushState(null, '', location.pathname + location.search + href);
  UI.route.params.anchor = href.slice(hi + 1);
  UI._landedAnchor = UI.route.params.id + '#' + UI.route.params.anchor;
});

document.addEventListener('click', (ev) => {
  const link = ev.target.closest?.('.sidebar a[href]');
  if (!link || !UI.navOpen || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  UI.navOpen = false;
  $('.shell')?.classList.remove('nav-open');
  syncSidebarInteraction(true);
});
window.addEventListener('resize', () => {
  syncSidebarInteraction();
  if (UI.modal?.kind === 'save-summary') {
    const dialog = $('.save-summary'), veil = dialog?.closest('.modal-veil');
    if (veil) { veil.style.alignItems = ''; veil.style.paddingTop = ''; dialog.style.maxHeight = ''; }
    UI.modal._top = undefined;
    anchorSaveDialog(dialog);
  }
});
for (const type of ['wheel', 'touchstart']) document.addEventListener(type, () => { anchorAnim++; }, { passive: true });
document.addEventListener('keydown', (ev) => {
  if (['PageDown', 'PageUp', 'Home', 'End', 'ArrowDown', 'ArrowUp', ' '].includes(ev.key) && !/^(INPUT|TEXTAREA)$/.test(ev.target.tagName)) {
    anchorAnim++;
    UI._tocPin = null;
  }
});

window.addEventListener('hashchange', () => {
  // A bare "#heading" hash is an in-page anchor (TOC, heading permalinks) —
  // scroll to it without re-routing.
  if (location.hash && !location.hash.startsWith('#/')) {
    const el = document.getElementById(location.hash.slice(1));
    if (el) { smoothAnchor(el); return; }
  }
  if (UI.editor?.saving) { history.replaceState(null, '', UI._editorLocation || location.pathname); return; }
  anchorAnim++;
  const wasEditing = !!UI.editor;
  if (wasEditing) stashDraftIfDirty();
  UI.navOpen = false;
  UI._tocPin = null;
  route();
  render();
});

// Another tab wrote — adopt its state so two tabs can't clobber each other.
// The adoption render must NOT write back (touchRecent etc. persist), or two
// open tabs ping-pong storage events forever and echo stale state over fresh
// saves. Store.persist() is a no-op while _adopting is set.
window.addEventListener('storage', (ev) => {
  if (ev.key !== 'cupi-wiki-v2' || !ev.newValue) return;
  try {
    Store.s = JSON.parse(ev.newValue);
    Store.reindex();
    if (!UI.editor) {
      Store._adopting = true;
      try { render(); } finally { Store._adopting = false; }
    } else {
      toast('This wiki changed in another tab. Your editor still has your text.');
    }
  } catch (e) { /* ignore malformed */ }
});

function syncViewerTheme() {
  const forced = document.documentElement.dataset.theme;
  const dark = forced ? forced === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.body.dataset.viewerDark = dark ? '1' : '0';
}

// Fades the boot splash out over the rendered app. The mark stays put while
// it fades; it does not travel to the sidebar brand.
function settleBoot(el) {
  if (!el) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.classList.add('is-done');
  setTimeout(() => el.remove(), reduced ? 0 : 400);
}

(async function boot() {
  Store.onError = (msg) => toast(msg);
  const splash = document.getElementById('boot');
  // Let the mark finish drawing even when the store boots instantly.
  const drawn = new Promise((r) => setTimeout(r, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1250));
  await Promise.all([Store.boot(), drawn]);
  hydrateDrafts();
  if (Store.me()) UI.navHidden = !!Store.prefs().navHidden;
  syncViewerTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { syncViewerTheme(); });
  new MutationObserver(() => { syncViewerTheme(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  route();
  render();
  settleBoot(splash);
  {
    const flag = UI.route.params.resend;
    if (flag) {
      UI.resendDomains = undefined;
      toast(flag === 'connected' ? 'Resend connected. Check the sender identity and send yourself a test.'
        : flag === 'denied' ? 'Resend connection was declined.'
        : 'Resend connection failed. Try again.');
    }
  }
  if (Store.me() && !sessionStorage.getItem('cupi-tip')) {
    sessionStorage.setItem('cupi-tip', '1');
    setTimeout(() => toast('Press ⌘K to search everything'), 1200);
  }
})();
