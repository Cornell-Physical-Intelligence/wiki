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
    draftStash.set(e.pageId || 'new', { title: e.title, body: e.body, section: e.section, parent: e.parent, tags: e.tags, origBody: e.origBody });
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

// Sheet rows are buttons: keyboard users open them the same way.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const row = ev.target.closest?.('[data-action="interest-open"]');
  if (!row || ev.target !== row) return;
  ev.preventDefault();
  UI.modal = { kind: 'interest-row', id: row.dataset.id };
  render();
});

// The interest endpoints answer with the whole updated row; swapping it into
// the cache keeps the open detail view alive instead of blanking it on a
// refetch.
function replaceInterestRow(row) {
  if (!row || !UI.interest?.rows) return;
  const i = UI.interest.rows.findIndex((r) => r.id === row.id);
  if (i >= 0) UI.interest.rows[i] = row;
}

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
      const options = JSON.parse(host.dataset.opts);
      openMenu(options.map((o) => ({
        icon: o.value === host.dataset.value ? I.check : '<span style="width:14px;flex:none"></span>',
        label: o.label,
        run: () => {
          host.dataset.value = o.value;
          host.querySelector('.dd__label').textContent = o.label;
          if (host.dataset.m === 'ed-section' && UI.editor) { UI.editor.section = o.value; markDirty(); autosaveDraft(); }
          if (host.dataset.m === 'section' && UI.modal) UI.modal.sectionTouched = true;
          if (host.dataset.m === 'email-from') {
            if (o.value === '__custom') { UI.emailFromCustom = true; render(); }
            else {
              const nm = $('form[data-action="email-settings-form"] [name="fromname"]')?.value || '';
              Store.setEmailSettings({ key: '', from: o.value, name: nm });
              UI.emailFromCustom = false;
              render();
              toast('Sender updated');
            }
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

    case 'resume-new-draft': stop(); nav('#/new'); break;
    case 'email-edit': stop(); UI.emailEdit = !UI.emailEdit; render(); break;
    case 'resend-disconnect': stop(); {
      if (typeof REMOTE === 'undefined') { toast('Preview build: connect and disconnect on the live wiki.'); break; }
      el.disabled = true;
      try { adoptServer(await api('/resend/disconnect', { method: 'POST', body: JSON.stringify({}) })); UI.resendDomains = undefined; toast('Resend disconnected'); }
      catch (e) { toast(`Couldn't disconnect: ${e.message}`); }
      render();
      break;
    }
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

    case 'help-menu': stop(); UI.modal = { kind: 'shortcuts' }; render(); break;

    /* ---- bug reports ---- */
    case 'bug-open': stop(); {
      if (!UI.bugDraft) UI.bugDraft = { title: '', body: '', images: [] };
      UI.bugDraft.error = null;
      UI.modal = { kind: 'bug' };
      render();
      break;
    }
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

    /* ---- interest list (self-contained component; talks to its own API) ---- */
    case 'interest-refresh': {
      stop();
      UI.interest = undefined; // the route loader refetches
      UI.interestArchives = undefined;
      render();
      break;
    }
    case 'interest-open': {
      // The file link inside the row keeps its own job.
      if (ev.target.closest('[data-stop]')) return;
      stop();
      UI.modal = { kind: 'interest-row', id: el.dataset.id };
      render();
      break;
    }
    case 'interest-sort': {
      stop();
      const key = el.dataset.key;
      const cur = UI.interestSort || { key: 'ts', dir: 'desc' };
      // Text reads best ascending first; dates and counts start at the top.
      const firstDir = key === 'name' || key === 'subteam' ? 'asc' : 'desc';
      UI.interestSort = cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: firstDir };
      render();
      break;
    }
    case 'interest-comment-remove': {
      stop();
      const { id, cid } = el.dataset;
      api(`/interest/${id}/comments/${cid}`, { method: 'DELETE' })
        .then((out) => { replaceInterestRow(out.row); render(); })
        .catch((e) => { toast(`Could not delete the comment: ${e.message}`); });
      break;
    }
    case 'interest-remove': {
      stop();
      const id = el.dataset.id;
      UI.modal = { kind: 'confirm', title: 'Remove this submission?', text: `<b>${el.dataset.email}</b> comes off the interest list, along with any file they attached.`, confirm: 'Remove', danger: true };
      UI.modal.onGo = () => {
        api(`/interest/${id}`, { method: 'DELETE' })
          .then(() => { UI.interest = undefined; render(); toast('Removed from the interest list'); })
          .catch((e) => { toast(`Could not remove: ${e.message}`); });
      };
      render();
      break;
    }
    case 'interest-archive': {
      stop();
      const n = (UI.interest?.rows || []).length;
      const year = new Date().getFullYear();
      const season = new Date().getMonth() >= 6 ? 'Fall' : 'Spring';
      UI.modal = {
        kind: 'confirm',
        title: 'Archive the interest list?',
        text: `All <b>${n}</b> submissions move into a named archive you can reopen and export any time, and the live list starts empty for the next cycle. Files and comments come along.`,
        confirm: 'Archive list',
        field: { label: 'Archive name', value: `${season} ${year} recruiting`, placeholder: 'e.g. Fall 2026 recruiting', maxlength: 80 },
      };
      UI.modal.onGo = (value) => {
        const name = String(value ?? '').trim();
        if (!name) { toast('An archive needs a name'); return; }
        api('/interest/archive', { method: 'POST', body: JSON.stringify({ name }) })
          .then(() => { UI.interest = undefined; UI.interestArchives = undefined; render(); toast(`Archived as “${name}”`); })
          .catch((e) => { toast(`Could not archive: ${e.message}`); });
      };
      render();
      break;
    }
    case 'interest-archive-open': {
      stop();
      UI.interestArchiveView = { id: el.dataset.id, loading: true };
      UI.interestQuery = '';
      render();
      break;
    }
    case 'interest-archive-back': {
      stop();
      UI.interestArchiveView = null;
      UI.interestQuery = '';
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
        api(`/interest/archives/${id}`, { method: 'DELETE' })
          .then(() => { UI.interestArchiveView = null; UI.interestArchives = undefined; render(); toast('Archive deleted'); })
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

document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('[data-action]');
  if (!form) return;
  ev.preventDefault();
  const act = form.dataset.action;

  if (act === 'interest-comment-form') {
    const input = form.querySelector('[data-m="interest-comment"]');
    const text = (input?.value || '').trim();
    if (!text) return;
    input.value = '';
    api(`/interest/${form.dataset.id}/comments`, { method: 'POST', body: JSON.stringify({ text }) })
      .then((out) => { replaceInterestRow(out.row); render(); })
      .catch((e) => { toast(`Could not add the comment: ${e.message}`); });
    return;
  }

  if (act === 'email-settings-form') {
    UI.emailFromCustom = false;
    UI.emailEdit = false;
    const from = form.from.value.trim();
    const key = form.key ? form.key.value.trim() : '';
    const name = form.fromname.value.trim();
    const ok = Store.setEmailSettings({ key, from, name });
    if (ok !== false) { render(); toast('Email settings saved'); }
    return;
  }

  if (act === 'invite-form') {
    // Take whatever was pasted: bare addresses, "Name <addr>" To: lines,
    // spreadsheet columns, mailto: links. Every email-shaped token counts,
    // everything else is ignored, duplicates collapse.
    const seen = new Set();
    const emails = (form.emails.value.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [])
      .map((e) => e.toLowerCase())
      .filter((e) => !seen.has(e) && seen.add(e));
    if (!emails.length) { if (form.emails.value.trim()) toast('No email addresses found in that'); return; }
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

  // Type-to-confirm gates: the danger button unlocks only on an exact match,
  // toggled directly on the DOM so the caret never jumps.
  if (t.matches('[data-m="modal-typed"]')) {
    const go = document.querySelector('.modal [data-action="confirm-go"]');
    if (go) go.disabled = t.value.trim() !== t.dataset.phrase;
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
  if (!c) { el.scrollIntoView({ behavior: 'smooth' }); return; }
  const from = c.scrollTop;
  const d = Math.max(0, Math.min(from + el.getBoundingClientRect().top - c.getBoundingClientRect().top - 68, c.scrollHeight - c.clientHeight)) - from;
  if (Math.abs(d) < 2) return;
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
});

window.addEventListener('hashchange', () => {
  // A bare "#heading" hash is an in-page anchor (TOC, heading permalinks) —
  // scroll to it without re-routing.
  if (location.hash && !location.hash.startsWith('#/')) {
    const el = document.getElementById(location.hash.slice(1));
    if (el) { smoothAnchor(el); return; }
  }
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
