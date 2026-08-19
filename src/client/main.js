/* ============================================================================
   Boot + events. One delegated click handler routes data-action attributes;
   submit/input/keydown are wired here too. Drafts survive accidental
   navigation; nothing is ever lost silently.
   ========================================================================== */

'use strict';

// Drafts survive reloads: mirrored to localStorage on every autosave tick.
const DRAFT_KEY = 'cupi-wiki-drafts';
const draftStash = new Map(); // pageId|'new' -> {title, body, section, tags, origBody}
try {
  for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'))) draftStash.set(k, v);
} catch (e) { /* fresh start */ }

const draftDeleted = new Set(); // keys this tab consumed — don't resurrect from disk

function persistDrafts() {
  // Merge with what's on disk so a draft in another tab is never clobbered:
  // our keys win, keys we consumed are dropped, everything else is preserved.
  try {
    const disk = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
    for (const k of draftDeleted) delete disk[k];
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...disk, ...Object.fromEntries(draftStash) }));
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

function startEdit(pageId, isNew, draftOverride) {
  const key = pageId || 'new';
  const draft = draftOverride || draftStash.get(key);
  openEditor(pageId, isNew, draft);
  if (draft) { UI.editor.dirty = true; draftStash.delete(key); draftDeleted.add(key); persistDrafts(); }
  render();
}

function openMenu(items, anchor) {
  window.__closeMenu?.();
  const r = anchor.getBoundingClientRect();
  UI.menu = { items };
  const host = document.createElement('div');
  host.className = 'menu';
  host.setAttribute('role', 'menu');
  host.innerHTML = items.map((it, i) => it === '-' ? '<hr>' :
    `<button role="menuitem" data-menu-i="${i}" class="${it.danger ? 'danger' : ''}">${it.icon || ''}${MD.esc(it.label)}${it.hint ? `<span class="menu__hint">${it.hint}</span>` : ''}</button>`).join('');
  document.body.appendChild(host);
  const mw = host.offsetWidth, mh = host.offsetHeight;
  host.style.left = Math.min(r.left, innerWidth - mw - 10) + 'px';
  host.style.top = (r.bottom + mh + 10 > innerHeight ? r.top - mh - 6 : r.bottom + 6) + 'px';
  const close = () => {
    host.remove(); UI.menu = null;
    document.removeEventListener('pointerdown', onAway, true);
    window.__closeMenu = null;
  };
  window.__closeMenu = close; // render() and Esc both close through this
  const onAway = (ev) => { if (!host.contains(ev.target)) close(); };
  document.addEventListener('pointerdown', onAway, true);
  host.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-menu-i]');
    if (!b) return;
    close();
    items[+b.dataset.menuI].run();
  });
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
      if (res.ok) { UI.loginError = null; nav('#/page/welcome'); route(); render(); toast(`Signed in as ${res.user.name}`); }
      else if (res.reason === 'invited') { UI.loginError = `<b>${email}</b> has a pending invite — enter the code from the invite email below.`; render(); }
      else { nav('#/denied?email=' + encodeURIComponent(email)); }
      break;
    }

    /* ---- shell ---- */
    case 'nav-toggle': stop(); if (innerWidth <= 860) UI.navOpen = !UI.navOpen; else UI.navHidden = !UI.navHidden; render(); break;
    case 'nav-close': stop(); UI.navOpen = false; render(); break;
    case 'sec-toggle': {
      if (ev.target.closest('[data-action="new-page"]')) break;
      stop();
      const c = Store.prefs().collapsed;
      const i = c.indexOf(el.dataset.sec);
      if (i >= 0) c.splice(i, 1); else c.push(el.dataset.sec);
      Store.persist(); render(); break;
    }
    case 'node-toggle': stop(); Store.prefs()['open-' + el.dataset.id] = !Store.prefs()['open-' + el.dataset.id]; Store.persist(); render(); break;
    case 'user-menu': stop(); openMenu([
      { icon: I.trash, label: 'Trash', run: () => nav('#/trash') },
      { icon: I.copy, label: 'Export wiki as Markdown', run: async () => {
        const doc = Store.s.pages.map((p) => `# ${p.title}\n\n${p.body}`).join('\n\n---\n\n');
        try { await navigator.clipboard.writeText(doc); toast(`Copied ${Store.s.pages.length} pages as Markdown`); }
        catch (e) { toast('Clipboard unavailable in this sandbox'); }
      } },
      { icon: I.shield, label: 'About this preview', run: () => { UI.modal = { kind: 'confirm', title: 'Preview build', text: 'This is the CUPI wiki preview. Everything works, but data lives in this browser only and sign-in is simulated. The production deployment adds Google OAuth (cornell.edu only), shared storage, real invite emails, and live Onshape/Altium embeds.', confirm: 'Got it' }; UI.modal.onGo = () => {}; render(); } },
      '-',
      { icon: I.history, label: 'Reset demo data', danger: true, run: () => { UI.modal = { kind: 'confirm', title: 'Reset demo data?', text: 'Every page, member, and attachment goes back to the seeded state. Your edits in this browser are erased.', confirm: 'Reset', danger: true }; UI.modal.onGo = () => { Store.reset(); UI.editor = null; nav('#/page/welcome'); route(); render(); toast('Demo data reset'); }; render(); } },
      { icon: I.x, label: 'Sign out', run: () => { Store.logout(); UI.editor = null; nav('#/login'); route(); render(); } },
    ], el); break;

    /* ---- page ---- */
    case 'edit': stop(); startEdit(el.dataset.id, false); break;
    case 'star': stop(); { const on = Store.toggleStar(el.dataset.id); toast(on ? 'Starred' : 'Unstarred'); render(); } break;
    case 'page-menu': {
      stop();
      const id = el.dataset.id;
      openMenu([
        { icon: I.edit, label: 'Edit', hint: 'E', run: () => startEdit(id, false) },
        { icon: I.history, label: 'History', run: () => nav('#/history/' + id) },
        { icon: I.mail, label: Store.isWatching(id) ? 'Stop watching' : 'Watch page', run: () => { const on = Store.toggleWatch(id); toast(on ? 'Watching — changes land in your Inbox' : 'Stopped watching'); render(); } },
        '-',
        { icon: I.copy, label: 'Duplicate', run: () => { const c = Store.duplicatePage(id); nav('#/page/' + c.id); toast('Duplicated — edit away'); } },
        { icon: I.arrowL, label: 'Move…', run: () => { UI.modal = { kind: 'move', id }; render(); } },
        { icon: I.copy, label: 'Copy as Markdown', run: async () => { try { await navigator.clipboard.writeText(Store.page(id).body); toast('Markdown copied'); } catch (e) { toast('Clipboard unavailable in this sandbox'); } } },
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
    case 'comment-del': stop(); Store.deleteComment(el.dataset.id); render(); break;
    case 'lightbox': stop(); openLightbox(ev.target.src, ev.target.alt); break;
    case 'att-open': {
      stop();
      const att = Store.att(el.dataset.id);
      if (att && /^image\//.test(att.type)) openLightbox(att.dataUri || att.url, att.name);
      else if (att && att.url) window.open(att.url, '_blank');
      else toast('File downloads are sandboxed in the preview — production serves the original.');
      break;
    }

    /* ---- new page ---- */
    case 'new-page': stop(); UI.modal = { kind: 'new-page', section: el.dataset.sec, tpl: 'blank' }; render(); break;
    case 'tpl-pick': stop(); UI.modal.tpl = el.dataset.tpl; UI.modal.title = $('.modal [data-m="title"]')?.value || UI.modal.title; UI.modal.section = $('.modal [data-m="section"]')?.value || UI.modal.section; UI.modal.parent = $('.modal [data-m="parent"]')?.value || ''; render(); break;
    case 'new-page-go': {
      stop();
      const title = ($('.modal [data-m="title"]')?.value || '').trim();
      const section = $('.modal [data-m="section"]')?.value || 'projects';
      const parent = $('.modal [data-m="parent"]')?.value || null;
      if (!title) { UI.modal.error = 'Every page needs a title.'; render(); break; }
      if (Store.pageByTitle(title)) { UI.modal.error = `“${title}” already exists — titles are how pages link, so they're unique.`; render(); break; }
      const tpl = TEMPLATES.find((t) => t.id === (UI.modal.tpl || 'blank'));
      UI.modal = null;
      openEditor(null, true, { title, body: tpl.body, section, parent });
      UI.editor.dirty = true;
      render();
      break;
    }

    /* ---- editor ---- */
    case 'ed-mode': stop(); UI.editor.mode = el.dataset.mode; Store.prefs().editorMode = el.dataset.mode; Store.persist(); render(); break;
    case 'ed-tool': stop(); ED_TOOLS[el.dataset.tool]?.(); break;
    case 'ed-cancel': stop(); { const pid = UI.editor.pageId; stashDraftIfDirty(); if (!UI.editor) { nav(pid ? '#/page/' + pid : '#/page/welcome'); route(); render(); } } break;
    case 'ed-save': stop(); edSave(); break;
    case 'ed-ac': stop(); edAcceptAc(el.dataset.title); break;
    case 'save-commit': stop(); edCommit(($('.modal [data-m="summary"]')?.value || '').trim()); break;

    /* ---- history ---- */
    case 'rev-restore': stop(); Store.restoreRev(el.dataset.id, +el.dataset.rev); nav('#/page/' + el.dataset.id); route(); render(); toast('Version restored'); break;

    /* ---- palette ---- */
    case 'palette': stop(); openPalette(); break;
    case 'palette-close': if (ev.target === el) { stop(); UI.palette = null; render(); } break;
    case 'palette-go': stop(); { const id = el.dataset.id; UI.palette = null; nav('#/page/' + id); route(); render(); } break;
    case 'palette-create': stop(); { const t = UI.palette.q.trim(); UI.palette = null; UI.modal = { kind: 'new-page', title: t, tpl: 'blank' }; render(); } break;

    /* ---- admin ---- */
    case 'invite-view': stop(); UI.modal = { kind: 'invite-mail', email: el.dataset.email }; render(); break;
    case 'invite-resend': stop(); Store.resendInvite(el.dataset.email); UI.modal = { kind: 'invite-mail', email: el.dataset.email }; render(); toast('Invite re-sent with a fresh code'); break;
    case 'invite-revoke': stop(); Store.revokeInvite(el.dataset.email); render(); toast('Invite revoked'); break;
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
    case 'copy-code': stop(); try { await navigator.clipboard.writeText(el.dataset.code); toast('Code copied'); } catch (e) { toast('Clipboard unavailable — select the code to copy it'); } break;

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
      Store.movePage(el.dataset.id, { section: $('.modal [data-m="section"]').value, parent: $('.modal [data-m="parent"]').value || null });
      UI.modal = null;
      render(); toast('Moved');
      break;
    }

    /* ---- modal plumbing ---- */
    case 'modal-close': stop(); UI.modal = null; render(); break;
    case 'modal-veil': if (ev.target === el) { UI.modal = null; render(); } break;
    case 'confirm-go': stop(); { const go = UI.modal?.onGo; UI.modal = null; go ? go() : render(); } break;

    case 'toast-act': stop(); { const t = UI.toasts[+el.dataset.i]; if (t?.action) { UI.toasts = UI.toasts.filter((x) => x !== t); renderToasts(); t.action.run(); } } break;
  }
});

/* ------------------------------- forms ----------------------------------- */

document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('[data-action]');
  if (!form) return;
  ev.preventDefault();
  const act = form.dataset.action;

  if (act === 'redeem-form') {
    const code = form.code.value.trim();
    if (!code) return;
    const res = Store.redeem(code);
    if (res.ok) { UI.loginError = null; nav('#/page/welcome'); route(); render(); toast(`Welcome to CUPI, ${res.user.name}!`); }
    else { UI.loginError = 'That code doesn’t match any pending invite. Codes look like CUPI-XXXX-XXXX and are one-time.'; render(); }
  }

  if (act === 'comment-form') {
    const text = form.text.value.trim();
    if (!text) return;
    Store.addComment(form.dataset.id, text);
    render();
  }

  if (act === 'invite-form') {
    const emails = form.emails.value.split(/[\s,;]+/).filter(Boolean);
    if (!emails.length) return;
    const results = Store.addMembers(emails, form.role.value);
    const ok = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);
    render();
    if (ok.length === 1) { UI.modal = { kind: 'invite-mail', email: ok[0].email }; render(); }
    else if (ok.length > 1) toast(`${ok.length} invites sent`);
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
    markDirty();
    autosaveDraft();
    edAutocomplete(t);
    clearTimeout(previewTimer);
    previewTimer = setTimeout(edUpdatePreview, 160);
  }
  if (t.matches('[data-ed-tags]')) {
    UI.editor.tags = t.value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8);
    markDirty();
    autosaveDraft();
  }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.matches('input[data-task]')) {
    const pageId = t.closest('[data-page]')?.dataset.page;
    if (pageId) { Store.toggleTask(pageId, +t.dataset.task); render(); }
    return;
  }
  if (t.matches('[data-action="ed-section"] , select[data-action="ed-section"]') || (UI.editor && t.closest('.editor__tools') && t.tagName === 'SELECT')) {
    UI.editor.section = t.value;
    markDirty();
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

  // Palette navigation.
  if (UI.palette) {
    if (ev.key === 'Escape') { ev.preventDefault(); UI.palette = null; render(); return; }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const n = UI.palette.count || 0;
      if (n) UI.palette.sel = (UI.palette.sel + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n;
      renderPaletteList();
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

  if (mod && ev.key.toLowerCase() === 'k') { ev.preventDefault(); UI.palette ? (UI.palette = null, render()) : openPalette(); return; }

  // Post a comment with ⌘Enter from its textarea.
  if (mod && ev.key === 'Enter' && ev.target.matches('.comment-form textarea')) {
    ev.preventDefault();
    ev.target.closest('form').querySelector('button[type="submit"]').click();
    return;
  }

  if (ev.key === 'Escape') {
    if (UI.menu) { ev.preventDefault(); window.__closeMenu?.(); return; }
    if (UI.modal) { UI.modal = null; render(); return; }
    if ($('.lightbox')) { $('.lightbox').remove(); return; }
    const ac = $('.ed-autocomplete');
    if (ac && !ac.hidden) { ac.hidden = true; return; }
    // Esc closes the editor from anywhere in it — including the textarea,
    // which is where you always are. The draft is kept.
    if (UI.editor) { const pid = UI.editor.pageId; stashDraftIfDirty(); nav(pid ? '#/page/' + pid : '#/page/welcome'); route(); render(); return; }
    if (UI.navOpen) { UI.navOpen = false; render(); return; }
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
    if (mod && (ev.key === 's' || ev.key === 'Enter')) { ev.preventDefault(); UI.modal?.kind === 'save-summary' ? $('.modal [data-action="save-commit"]')?.click() : edSave(); return; }
    if (mod && ev.key.toLowerCase() === 'b' && inBody) { ev.preventDefault(); ED_TOOLS.bold(); return; }
    if (mod && ev.key.toLowerCase() === 'i' && inBody) { ev.preventDefault(); ED_TOOLS.italic(); return; }
    // Tab indents instead of leaving the editor.
    if (ev.key === 'Tab' && inBody && !ev.shiftKey) {
      ev.preventDefault();
      ev.target.setRangeText('  ', ev.target.selectionStart, ev.target.selectionEnd, 'end');
      ev.target.dispatchEvent(new Event('input', { bubbles: true }));
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
          ta.setRangeText('\n', lineStart, ta.selectionEnd, 'end');
        } else {
          const num = /\d/.test(m[2][0]) ? (parseInt(m[2], 10) + 1) + m[2].slice(-1) : m[2];
          ta.setRangeText('\n' + m[1] + num + (m[3] ? ' [ ]' : '') + ' ', ta.selectionStart, ta.selectionEnd, 'end');
        }
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
    }
    return;
  }

  if (UI.modal?.kind === 'save-summary' && ev.key === 'Enter' && typing) { ev.preventDefault(); $('.modal [data-action="save-commit"]')?.click(); return; }
  if (UI.modal || typing || mod || ev.altKey) return;

  if (ev.key === '?') { ev.preventDefault(); UI.modal = { kind: 'shortcuts' }; render(); return; }
  if (ev.key === 'n' || ev.key === 'N') { ev.preventDefault(); UI.modal = { kind: 'new-page', tpl: 'blank' }; render(); }
  if ((ev.key === 'e' || ev.key === 'E') && UI.route.name === 'page') {
    const p = Store.page(UI.route.params.id || 'welcome');
    if (p) { ev.preventDefault(); startEdit(p.id, false); }
  }
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
  // Leaving the inbox is the moment its items count as read.
  if (UI.route.name === 'inbox') Store.markInboxRead();
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
      toast('This wiki changed in another tab — your editor still has your text.');
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
  syncViewerTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { syncViewerTheme(); render(); });
  new MutationObserver(() => { syncViewerTheme(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  route();
  render();
  if (Store.me() && !sessionStorage.getItem('cupi-tip')) {
    sessionStorage.setItem('cupi-tip', '1');
    setTimeout(() => toast('Press ⌘K to search everything'), 1200);
  }
})();
