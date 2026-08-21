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
    draftStash.set(e.pageId || 'new', { title: e.title, body: e.body, section: e.section, parent: e.parent, tags: e.tags, origBody: e.origBody });
    draftDeleted.delete(e.pageId || 'new');
    persistDrafts();
    if (!silent) toast('Draft kept', { label: 'Resume', run: () => { const k = e.pageId || 'new'; startEdit(e.pageId, !e.pageId, draftStash.get(k)); } });
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
    draftStash.set(e.pageId || 'new', { title: e.title, body: e.body, section: e.section, parent: e.parent, tags: e.tags, origBody: e.origBody });
    persistDrafts();
  }, 900);
}

function closeModal(after) {
  const veil = document.querySelector('.modal-veil');
  if (!veil) { UI.modal = null; after ? after() : render(); return; }
  if (veil.classList.contains('leaving')) return; // second click during the exit
  veil.classList.add('leaving');
  setTimeout(() => {
    UI.modal = null;
    if (after) after();
    // Keep-editing paths must not rebuild the textarea — a full render would
    // wipe the native undo stack the editor is built around.
    else if (UI.editor) { veil.remove(); $('[data-ed="body"]')?.focus(); }
    else render();
  }, 120);
}

// Opening a dialog over the editor appends it in place, same reason.
function showModal(m) {
  UI.modal = m;
  if (UI.editor && $('#app .editor')) {
    document.querySelector('.modal-veil')?.remove();
    document.body.insertAdjacentHTML('beforeend', viewModal());
    $('.modal [data-m], .modal .btn--primary')?.focus?.();
  } else render();
}

function requestEditorClose() {
  const e = UI.editor;
  if (!e) return;
  if (!e.dirty) {
    const pid = e.pageId;
    UI.editor = null;
    nav(pid ? '#/page/' + pid : '#/page/welcome');
    route(); render();
    return;
  }
  showModal({ kind: 'close-editor' });
}

function startEdit(pageId, isNew, draftOverride) {
  const key = pageId || 'new';
  const draft = draftOverride || draftStash.get(key);
  openEditor(pageId, isNew, draft);
  // The stash entry survives until the draft is saved or explicitly discarded —
  // resuming and immediately reloading must not be the one path that loses work.
  if (draft) { UI.editor.dirty = true; UI.editor.fromDraft = true; }
  render();
}

function mountMenu(host, anchor) {
  document.body.appendChild(host);
  const r = anchor.getBoundingClientRect();
  const mw = host.offsetWidth, mh = host.offsetHeight;
  host.style.left = Math.min(r.left, innerWidth - mw - 10) + 'px';
  host.style.top = (r.bottom + mh + 10 > innerHeight ? r.top - mh - 6 : r.bottom + 6) + 'px';
  const close = () => {
    host.remove(); UI.menu = null;
    document.removeEventListener('pointerdown', onAway, true);
    window.__closeMenu = null;
    if (anchor.isConnected) anchor.focus?.();
  };
  window.__closeMenu = close; // render() and Esc both close through this
  const onAway = (ev) => { if (!host.contains(ev.target)) close(); };
  document.addEventListener('pointerdown', onAway, true);
  // Menus are keyboard-first like everything else: focus lands inside,
  // arrows move it, Escape (global) hands it back to the trigger.
  host.addEventListener('keydown', (ev) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) return;
    ev.preventDefault();
    const btns = [...host.querySelectorAll('button')];
    const cur = btns.indexOf(document.activeElement);
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? btns.length - 1 :
      ((cur < 0 ? 0 : cur) + (ev.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length;
    btns[next]?.focus();
  });
  host.querySelector('button')?.focus();
  return close;
}

function openMenu(items, anchor) {
  window.__closeMenu?.();
  UI.menu = { items };
  const host = document.createElement('div');
  host.className = 'menu';
  host.setAttribute('role', 'menu');
  host.innerHTML = items.map((it, i) => it === '-' ? '<hr>' :
    `<button role="menuitem" data-menu-i="${i}" class="${it.danger ? 'danger' : ''}">${it.icon || ''}${MD.esc(it.label)}${it.hint ? `<span class="menu__hint">${it.hint}</span>` : ''}</button>`).join('');
  const close = mountMenu(host, anchor);
  host.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-menu-i]');
    if (!b) return;
    close();
    items[+b.dataset.menuI].run();
  });
}

function openEmojiPop(anchor, pageId) {
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
  bar.innerHTML = `<input type="text" placeholder="Find in page…" aria-label="Find in page">
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
    if (e.key === 'Enter') { e.preventDefault(); jump(e.shiftKey ? 'prev' : 'next'); }
    if (e.key === 'Escape') { e.preventDefault(); bar.remove(); ta.focus(); }
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

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const act = el.dataset.action;
  const stop = () => { ev.preventDefault(); ev.stopPropagation(); };

  switch (act) {
    /* ---- login ---- */
    case 'login-google': stop(); UI.chooser = true; UI.loginError = null; render(); break;
    case 'login-back': stop(); UI.chooser = false; render(); break;
    case 'login-as': {
      stop();
      const email = el.dataset.email;
      const res = Store.login(email);
      UI.chooser = false;
      if (res.ok) { UI.loginError = null; hydrateDrafts(); nav('#/page/welcome'); route(); render(); toast(`Signed in as ${res.user.name}`); }
      else { nav('#/denied?email=' + encodeURIComponent(email)); }
      break;
    }

    /* ---- shell ---- */
    case 'nav-toggle': stop(); { if (innerWidth <= 860) UI.navOpen = !UI.navOpen; else { UI.navHidden = !UI.navHidden; Store.prefs().navHidden = UI.navHidden; Store.persist(); } const sh = $('.shell'); if (sh) { sh.classList.toggle('nav-open', UI.navOpen); sh.classList.toggle('nav-hidden', UI.navHidden); } else render(); } break;
    case 'nav-close': stop(); UI.navOpen = false; $('.shell')?.classList.remove('nav-open'); break;
    case 'sec-toggle': {
      if (ev.target.closest('[data-action="new-page"]')) break;
      stop();
      const c = Store.prefs().collapsed;
      const i = c.indexOf(el.dataset.sec);
      if (i >= 0) c.splice(i, 1); else c.push(el.dataset.sec);
      Store.persist();
      el.closest('.tree-section')?.classList.toggle('collapsed', i < 0);
      el.setAttribute('aria-expanded', String(i >= 0));
      break;
    }
    case 'user-menu': stop(); openMenu([
      { icon: I.edit, label: 'Edit profile', run: () => { UI.modal = { kind: 'profile' }; render(); } },
      { icon: I.trash, label: 'Trash', run: () => nav('#/trash') },
      { icon: I.copy, label: 'Export wiki as Markdown', run: async () => {
        const doc = Store.s.pages.map((p) => `# ${p.title}\n\n${p.body}`).join('\n\n---\n\n');
        try { await navigator.clipboard.writeText(doc); toast(`Copied ${Store.s.pages.length} pages as Markdown`); }
        catch (e) { toast("Couldn't copy: your browser blocked clipboard access"); }
      } },
      ...(typeof REMOTE === 'undefined' ? [
        { icon: I.shield, label: 'About this preview', run: () => { UI.modal = { kind: 'confirm', title: 'Preview build', text: 'This is the CUPI wiki preview. Everything works, but data lives in this browser only and sign-in is simulated. The production deployment adds Google OAuth (cornell.edu only), shared storage, real emails, and live Onshape/Altium embeds.', confirm: 'Got it' }; UI.modal.onGo = () => {}; render(); } },
        '-',
        { icon: I.history, label: 'Restore sample content', danger: true, run: () => { UI.modal = { kind: 'confirm', title: 'Restore sample content?', text: 'Every page, member, and attachment returns to the sample content this preview ships with. Anything you changed in this browser is erased.', confirm: 'Restore', danger: true }; UI.modal.onGo = () => { Store.reset(); UI.editor = null; nav('#/page/welcome'); route(); render(); toast('Sample content restored'); }; render(); } },
      ] : ['-']),
      { icon: I.x, label: 'Sign out', run: () => { Store.logout(); UI.editor = null; hydrateDrafts(); nav('#/login'); route(); render(); } },
    ], el); break;

    /* ---- page ---- */
    case 'edit': stop(); startEdit(el.dataset.id, false); break;
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
      const options = JSON.parse(host.dataset.opts);
      openMenu(options.map((o) => ({
        icon: o.value === host.dataset.value ? I.check : '<span style="width:14px;flex:none"></span>',
        label: o.label,
        run: () => {
          host.dataset.value = o.value;
          host.querySelector('.dd__label').textContent = o.label;
          if (host.dataset.m === 'ed-section' && UI.editor) { UI.editor.section = o.value; markDirty(); autosaveDraft(); }
          if (host.dataset.m === 'section' && UI.modal) UI.modal.sectionTouched = true;
        },
      })), host);
      break;
    }
    case 'star': stop(); { const on = Store.toggleStar(el.dataset.id); toast(on ? 'Starred' : 'Unstarred'); render(); } break;
    case 'page-menu': {
      stop();
      const id = el.dataset.id;
      openMenu([
        { icon: I.edit, label: 'Edit', run: () => startEdit(id, false) },
        { icon: I.history, label: 'History', run: () => nav('#/history/' + id) },
        '-',
        { icon: I.copy, label: 'Duplicate', run: () => { const c = Store.duplicatePage(id); nav('#/page/' + c.id); toast('Duplicated. Edit away'); } },
        { icon: I.arrowL, label: 'Move…', run: () => { UI.modal = { kind: 'move', id }; render(); } },
        { icon: I.copy, label: 'Copy as Markdown', run: async () => { try { await navigator.clipboard.writeText(Store.page(id).body); toast('Markdown copied'); } catch (e) { toast("Couldn't copy: your browser blocked clipboard access"); } } },
        { icon: I.page, label: 'Print / PDF', run: () => window.print() },
        '-',
        { icon: I.trash, label: 'Move to Trash', danger: true, run: () => {
          UI.modal = { kind: 'confirm', title: 'Move to Trash?', text: `“${MD.esc(Store.page(id).title)}” will sit in Trash for 30 days before it's gone for good.`, confirm: 'Move to Trash', danger: true };
          UI.modal.onGo = () => { Store.deletePage(id); nav('#/page/welcome'); route(); render(); toast('Moved to Trash', { label: 'Undo', run: () => { Store.restorePage(id); render(); } }); };
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

    case 'resume-new-draft': stop(); startEdit(null, true); break;
    case 'profile-save': stop(); {
      const name = ($('.modal [data-m="pname"]')?.value || '').trim();
      const subteam = ($('.modal [data-m="psub"]')?.value || '').trim();
      if (!name) { toast("Your name can't be empty."); break; }
      Store.setProfile(name, subteam);
      closeModal();
      toast('Profile updated');
      break;
    }

    case 'email-test': stop(); {
      if (typeof REMOTE === 'undefined') { toast('Preview build: emails only send from the live wiki.'); break; }
      el.disabled = true;
      try {
        const out = await api('/test-email', { method: 'POST', body: JSON.stringify({}) });
        toast(out.sent ? `Test sent to ${Store.me().email}. Check your inbox (and spam).` : `Not sent: ${out.reason || 'unknown reason'}`);
      } catch (e) { toast(`Not sent: ${e.message}`); }
      el.disabled = false;
      break;
    }

    case 'help-menu': stop(); openMenu([
      { icon: I.help, label: 'Keyboard shortcuts', hint: '?', run: () => { UI.modal = { kind: 'shortcuts' }; render(); } },
      { icon: I.page, label: 'Formatting guide', run: () => nav('#/page/formatting-guide') },
    ], el); break;

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
    case 'editor-keep-draft': stop(); { UI.modal = null; const pid = UI.editor.pageId; stashDraftIfDirty(true); nav(pid ? '#/page/' + pid : '#/page/welcome'); route(); render(); toast('Draft kept. It will be waiting when you come back'); } break;
    case 'editor-discard-close': stop(); { UI.modal = null; const pid = UI.editor.pageId; draftStash.delete(pid || 'new'); draftDeleted.add(pid || 'new'); persistDrafts(); UI.editor = null; nav(pid ? '#/page/' + pid : '#/page/welcome'); route(); render(); } break;
    case 'copy-mine': stop(); { try { await navigator.clipboard.writeText(UI.editor?.body || ''); toast('Your version copied'); } catch (e) { toast("Couldn't copy: your browser blocked clipboard access"); } } break;
    case 'ed-save': stop(); edSave(); break;
    case 'ed-ac': stop(); edAcceptAc(el.dataset.title); break;
    case 'save-commit': stop(); edCommit(($('.modal [data-m="summary"]')?.value || '').trim()); break;

    /* ---- history ---- */
    case 'rev-restore': stop(); Store.restoreRev(el.dataset.id, +el.dataset.ts); nav('#/page/' + el.dataset.id); route(); render(); toast('Version restored'); break;

    /* ---- palette ---- */
    case 'palette': stop(); openPalette(); break;
    case 'palette-close': if (ev.target === el) { stop(); UI.palette = null; render(); } break;
    case 'palette-go': stop(); { const id = el.dataset.id; UI.palette = null; nav('#/page/' + id); route(); render(); } break;
    case 'palette-create': stop(); { const t = UI.palette.q.trim(); UI.palette = null; UI.modal = { kind: 'new-page', title: t, tpl: 'blank' }; render(); } break;

    /* ---- admin ---- */
    case 'invite-view': stop(); UI.modal = { kind: 'invite-mail', email: el.dataset.email }; render(); break;
    case 'role-toggle': {
      stop();
      const u = Store.user(el.dataset.email);
      Store.setRole(u.email, u.role === 'admin' ? 'member' : 'admin');
      render(); toast(`${u.name} is now ${u.role === 'admin' ? 'an admin' : 'a member'}`);
      break;
    }
    case 'user-remove': {
      stop();
      const email = el.dataset.email;
      UI.modal = { kind: 'confirm', title: 'Remove member?', text: `<b>${email}</b> loses access immediately. Their pages and edits stay.`, confirm: 'Remove', danger: true };
      UI.modal.onGo = () => { Store.removeUser(email); render(); toast('Removed from roster'); };
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
    case 'modal-close': stop(); closeModal(); break;
    case 'modal-veil': if (ev.target === el) { stop(); closeModal(); } break;
    case 'confirm-go': stop(); { const go = UI.modal?.onGo; if (UI.modal) UI.modal.onGo = null; closeModal(go ? () => go() : null); } break;

    case 'toast-act': stop(); { const t = UI.toasts.find((x) => x.id === el.dataset.tid); if (t?.action) { const run = t.action.run; dismissToast(t); run(); } } break;
  }
});

/* ------------------------------- forms ----------------------------------- */

document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('[data-action]');
  if (!form) return;
  ev.preventDefault();
  const act = form.dataset.action;

  if (act === 'email-settings-form') {
    const from = form.from.value.trim();
    const key = form.key.value.trim();
    const name = form.fromname.value.trim();
    const ok = Store.setEmailSettings({ key, from, name });
    if (ok !== false) { render(); toast('Email settings saved'); }
    return;
  }

  if (act === 'invite-form') {
    const emails = form.emails.value.split(/[\s,;]+/).filter(Boolean);
    if (!emails.length) return;
    const results = Store.addMembers(emails, form.querySelector('[data-m="invite-role"]')?.dataset.value || 'member');
    const ok = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);
    render();
    if (typeof REMOTE === 'undefined') {
      // Preview only: show the simulated email so the flow can be judged.
      if (ok.length === 1) { UI.modal = { kind: 'invite-mail', email: ok[0].email }; render(); }
      else if (ok.length > 1) toast(`Added ${ok.length} members; each gets a welcome email`);
    } else if (ok.length) {
      toast(ok.length === 1 ? `Added ${ok[0].email}; welcome email sent` : `Added ${ok.length} members; welcome emails sent`);
    }
    bad.forEach((b) => toast(`${b.email}: ${b.reason}`));
  }
});

/* ------------------------------- inputs ---------------------------------- */

let previewTimer = null;
document.addEventListener('input', (ev) => {
  const t = ev.target;

  if (t.matches('.palette input')) {
    UI.palette.q = t.value;
    UI.palette.sel = 0;
    renderPaletteList(); // input DOM stays put — the caret never jumps
    return;
  }

  if (!UI.editor) return;

  if (t.matches('[data-ed="title"]')) {
    UI.editor.title = t.value;
    markDirty();
    autosaveDraft();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(edUpdatePreview, 160);
  }
  if (t.matches('[data-ed="body"]')) {
    UI.editor.body = t.value;
    const wc = $('[data-ed-count]');
    if (wc) wc.textContent = (t.value.trim() ? t.value.trim().split(/\s+/).length : 0) + ' words';
    markDirty();
    autosaveDraft();
    edAutocomplete(t);
    clearTimeout(previewTimer);
    previewTimer = setTimeout(edUpdatePreview, 160);
  }
});

document.addEventListener('click', (ev) => {
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
      toast(`${checked ? 'Checked' : 'Unchecked'} on “${title}”, saved for everyone`, { label: 'Undo', run: () => { Store.toggleTask(pageId, n); render(); } });
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
  if (!UI.editor || UI.editor.dirty) return;
  UI.editor.dirty = true;
  const crumb = $('.crumbs');
  if (crumb && !$('.crumbs__draft')) crumb.insertAdjacentHTML('beforeend', '<span class="crumbs__draft"><span class="dot dot--accent"></span>unsaved</span>');
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
  const mod = ev.metaKey || ev.ctrlKey;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName) || ev.target.isContentEditable;

  // Focus trap: Tab stays inside an open modal (Linear/Notion behavior).
  if (ev.key === 'Tab' && UI.modal && $('.modal')) {
    const focusables = $$('.modal button, .modal input, .modal a[href], .modal textarea').filter((el) => !el.disabled && el.offsetParent !== null);
    if (focusables.length) {
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && (document.activeElement === last || !$('.modal').contains(document.activeElement))) { ev.preventDefault(); first.focus(); }
    }
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
    if (UI.modal) { closeModal(); return; }
    if ($('.lightbox')) { closeLightbox(); return; }
    const ac = $('.ed-autocomplete');
    if (ac && !ac.hidden) { ac.hidden = true; return; }
    // Esc asks before leaving a dirty editor; a clean one closes straight away.
    if (UI.editor) { requestEditorClose(); return; }
    if (UI.navOpen) { UI.navOpen = false; $('.shell')?.classList.remove('nav-open'); return; }
  }

  // Save-summary dialog: Enter saves (checked before the editor block, which
  // otherwise swallows plain Enter for list continuation).
  if (UI.modal?.kind === 'save-summary' && ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    $('.modal [data-action="save-commit"]')?.click();
    return;
  }

  if (UI.editor) {
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

  if (UI.modal?.kind === 'save-summary' && ev.key === 'Enter' && typing) { ev.preventDefault(); $('.modal [data-action="save-commit"]')?.click(); return; }
  if (UI.modal || typing || mod || ev.altKey) return;

  if (ev.key === '?') { ev.preventDefault(); UI.modal = { kind: 'shortcuts' }; render(); return; }
  if (ev.key === 'n' || ev.key === 'N') { ev.preventDefault(); UI.modal = { kind: 'new-page', tpl: 'blank' }; render(); }
});

window.addEventListener('beforeunload', (ev) => {
  if (UI.editor?.dirty) { ev.preventDefault(); ev.returnValue = ''; }
});

/* ------------------------------- routing + boot -------------------------- */

window.addEventListener('hashchange', () => {
  // A bare "#heading" hash is an in-page anchor (TOC, heading permalinks) —
  // scroll to it without re-routing.
  if (location.hash && !location.hash.startsWith('#/')) {
    const el = document.getElementById(location.hash.slice(1));
    if (el) { el.scrollIntoView({ behavior: 'smooth' }); return; }
  }
  const wasEditing = !!UI.editor;
  if (wasEditing) stashDraftIfDirty();
  UI.navOpen = false;
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

(async function boot() {
  Store.onError = (msg) => toast(msg);
  await Store.boot();
  hydrateDrafts();
  if (Store.me()) UI.navHidden = !!Store.prefs().navHidden;
  syncViewerTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { syncViewerTheme(); });
  new MutationObserver(() => { syncViewerTheme(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  route();
  render();
  if (Store.me() && !sessionStorage.getItem('cupi-tip')) {
    sessionStorage.setItem('cupi-tip', '1');
    setTimeout(() => toast('Press ⌘K to search everything'), 1200);
  }
})();
