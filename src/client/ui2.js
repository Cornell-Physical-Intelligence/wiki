/* ============================================================================
   UI part 2 — editor, history, admin, palette, overlays, event wiring.
   ========================================================================== */

'use strict';

/* ------------------------------- custom dropdown -------------------------- */

// Global rule: no native <select> anywhere — every dropdown uses this control,
// which opens the app's own styled menu instead of the OS picker.
function dd(mName, options, value, opts = {}) {
  const cur = options.find((o) => o.value === value) || options[0];
  return `<button type="button" class="dd ${opts.small ? 'dd--sm' : ''}" data-action="dd" data-m="${mName}"
    data-value="${MD.esc(cur.value)}" data-opts="${MD.esc(JSON.stringify(options))}" ${opts.style ? `style="${opts.style}"` : ''}
    aria-haspopup="menu"><span class="dd__label">${MD.esc(cur.label)}</span>
    <svg class="dd__chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 9l6 6 6-6"/></svg></button>`;
}

const ddSections = (value) => dd('section', SECTIONS.map((s) => ({ value: s.id, label: s.name })), value);

/* ------------------------------- editor ---------------------------------- */

function openEditor(pageId, isNew, draft) {
  const p = pageId ? Store.page(pageId) : null;
  UI.editor = {
    pageId, isNew: !!isNew,
    title: draft?.title ?? p?.title ?? '',
    body: draft?.body ?? p?.body ?? '',
    section: draft?.section ?? p?.section ?? 'projects',
    parent: p?.parent ?? draft?.parent ?? null,
    mode: Store.prefs().editorMode || 'split',
    dirty: false,
    origTitle: p?.title ?? '', origBody: draft?.origBody ?? p?.body ?? '',
    baseUpdated: p?.updated ?? null,
  };
}

function viewEditor() {
  const e = UI.editor;
  const spell = Store.prefs().spellcheck !== false;
  if (innerWidth <= 900 && e.mode === 'split') e.mode = 'write';
  // Standard document-editor toolbar, drawn from Lucide — the same visual
  // vocabulary as Notion/Obsidian-class editors.
  const T = (tool, icon, label) => [tool, lucide(icon), label];
  const tools = [
    T('bold', 'bold', 'Bold ⌘B'),
    T('italic', 'italic', 'Italic ⌘I'),
    T('strike', 'strike', 'Strikethrough'),
    T('code', 'code', 'Inline code'),
    null,
    T('h2', 'h2', 'Heading'),
    T('h3', 'h3', 'Subheading'),
    null,
    T('ul', 'ul', 'Bulleted list'),
    T('ol', 'ol', 'Numbered list'),
    T('task', 'task', 'Task list'),
    null,
    T('quote', 'quote', 'Quote'),
    T('fence', 'fence', 'Code block'),
    T('table', 'table', 'Table'),
    T('callout', 'callout', 'Callout'),
    T('hr', 'hr', 'Divider'),
    null,
    T('wikilink', 'wikilink', 'Link a page [['),
    T('mdlink', 'link2', 'Link a URL ⌘K'),
    T('image', 'image', 'Insert image'),
    T('attach', 'attach', 'Attach file (CAD, PDF, anything)'),
  ];
  return `<div class="editor mode-${e.mode}">
    ${topbar(
      `${e.isNew ? '<span class="crumbs__here">New page</span>' : (() => { const p = Store.page(e.pageId); return p ? crumbsFor(p) : '<span class="crumbs__here">Editing</span>'; })()}<span class="crumbs__mode">Editing</span>${e.dirty ? '<span class="crumbs__draft">unsaved</span>' : ''}`,
      `<div class="editor__mode" role="tablist" aria-label="Editor mode">
        <button role="tab" data-action="ed-mode" data-mode="write" class="${e.mode === 'write' ? 'active' : ''}">Write</button>
        <button role="tab" data-action="ed-mode" data-mode="split" class="${e.mode === 'split' ? 'active' : ''}">Split</button>
        <button role="tab" data-action="ed-mode" data-mode="preview" class="${e.mode === 'preview' ? 'active' : ''}">Preview</button>
      </div>
      <button class="btn btn--ghost" data-action="ed-cancel">Close</button>
      <button class="btn btn--primary" data-action="ed-save">Save${e.isNew ? ' page' : ''}…<span class="kbd" style="background:transparent;border-color:currentColor;color:inherit;opacity:.6;margin-left:2px">⌘S</span></button>`
    )}
    <div class="editor__toolbar">
      <div class="editor__tools" role="toolbar" aria-label="Formatting">
        ${tools.map((t) => t === null ? '<span class="sep"></span>' :
          `<button class="icon-btn" data-action="ed-tool" data-tool="${t[0]}" title="${t[2]}" aria-label="${t[2]}">${t[1]}</button>`).join('')}
      </div>
      <div class="editor__toolend">
        <button class="icon-btn${spell ? ' active' : ''}" data-action="ed-spell" aria-pressed="${spell}" title="Spell check" aria-label="Spell check">${lucide('spellcheck')}</button>
        <span class="editor__count" data-ed-count>${e.body.trim() ? e.body.trim().split(/\s+/).length : 0} words</span>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)">Section
          ${dd('ed-section', SECTIONS.map((s) => ({ value: s.id, label: s.name })), e.section, { small: true })}
        </label>
      </div>
    </div>
    ${e.fromDraft ? `<div class="editor__draftbar">${lucide('info')} Restored your unsaved draft. The page may have moved on since you wrote it. <button class="btn btn--sm" data-action="ed-discard-draft">Discard draft</button></div>` : ''}
    <div class="editor__panes">
      <div class="editor__pane editor__pane--src">
        <div class="preview-tag preview-tag--src"><span class="eyebrow">Source</span></div>
        <input class="editor__title" data-ed="title" placeholder="Page title" value="${MD.esc(e.title)}" maxlength="90" spellcheck="${spell}" autocorrect="off">
        <textarea data-ed="body" placeholder="Write. Drop images or CAD files anywhere. [[ links a page." spellcheck="${spell}" autocorrect="off">${MD.esc(e.body)}</textarea>
      </div>
      <div class="editor__pane editor__pane--preview">
        <div class="preview-tag"><span class="eyebrow">Preview</span></div>
        <div class="prose" data-ed-preview></div>
      </div>
    </div>
    <input type="file" data-ed-file hidden multiple>
    <div class="ed-autocomplete" hidden></div>
  </div>`;
}

function edUpdatePreview() {
  const e = UI.editor;
  const host = $('[data-ed-preview]');
  if (!host) return;
  // Every remount would otherwise orphan the previous viewers' spin loops —
  // in the editor, all mounted viewers belong to this preview, so flush them.
  cadCleanups.forEach((fn) => fn());
  cadCleanups = [];
  const { html } = MD.render(e.body, mdCtx({ readonly: true }));
  host.innerHTML = (e.title ? `<h1 class="preview-title">${MD.esc(e.title)}</h1>` : '') + html;
  $$('.cad-embed', host).forEach(mountCadViewer);
  $$('.video-embed__face', host).forEach(mountVideoMeta);
}

// All programmatic edits go through execCommand('insertText') so the native
// undo/redo stack survives every toolbar action and list continuation —
// the difference between feeling like GitHub's editor and feeling amateur.
function edType(ta, text) {
  ta.focus();
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
  if (!ok) {
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// Wrap the selection — or unwrap it when it's already wrapped (toggle).
function edWrap(before, after, placeholder) {
  const ta = $('[data-ed="body"]');
  if (!ta) return;
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const sel = value.slice(s, e);
  // Toggle off: marks just outside the selection…
  if (value.slice(s - before.length, s) === before && value.slice(e, e + after.length) === after) {
    ta.setSelectionRange(s - before.length, e + after.length);
    edType(ta, sel);
    ta.setSelectionRange(s - before.length, e - before.length);
    return;
  }
  // …or inside it.
  if (sel.startsWith(before) && sel.endsWith(after) && sel.length >= before.length + after.length) {
    const inner = sel.slice(before.length, sel.length - after.length);
    edType(ta, inner);
    ta.setSelectionRange(s, s + inner.length);
    return;
  }
  const body = sel || placeholder || '';
  edType(ta, before + body + after);
  const base = s + before.length;
  ta.setSelectionRange(base, base + body.length);
}

// Line operations: heading/list/quote buttons act on the current line's
// prefix (GitHub/Docs behavior), never splice into the middle of a sentence.
function edLine(prefix) {
  const ta = $('[data-ed="body"]');
  if (!ta) return;
  const { value, selectionStart: s } = ta;
  const ls = value.lastIndexOf('\n', s - 1) + 1;
  let le = value.indexOf('\n', s);
  if (le < 0) le = value.length;
  const line = value.slice(ls, le);
  const cur = line.match(/^(#{2,4} |[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> )/)?.[1] || '';
  const rest = line.slice(cur.length);
  const next = cur === prefix ? rest : prefix + rest; // same prefix toggles off
  ta.setSelectionRange(ls, le);
  edType(ta, next);
  const caret = Math.min(ls + next.length, ls + Math.max(0, s - ls - cur.length + (cur === prefix ? 0 : prefix.length)));
  ta.setSelectionRange(caret, caret);
}

// Block inserts land on their own line, at a clean boundary.
function edBlock(text, selectFrom, selectLen) {
  const ta = $('[data-ed="body"]');
  if (!ta) return;
  const { value, selectionStart: s } = ta;
  const atLineStart = s === 0 || value[s - 1] === '\n';
  const pre = atLineStart ? '' : '\n';
  edType(ta, pre + text);
  if (selectFrom !== undefined) {
    const base = s + pre.length + selectFrom;
    ta.setSelectionRange(base, base + (selectLen || 0));
  }
}

const ED_TOOLS = {
  bold: () => edWrap('**', '**', 'bold'),
  italic: () => edWrap('*', '*', 'italic'),
  strike: () => edWrap('~~', '~~', 'text'),
  code: () => edWrap('\u0060', '\u0060', 'code'),
  h2: () => edLine('## '),
  h3: () => edLine('### '),
  ul: () => edLine('- '),
  ol: () => edLine('1. '),
  task: () => edLine('- [ ] '),
  quote: () => edLine('> '),
  hr: () => edBlock('\n---\n\n'),
  fence: () => edBlock('~~~\ncode\n~~~\n', 4, 4),
  callout: () => edBlock('::: note Title\nThe thing worth calling out.\n:::\n', 15, 29),
  table: () => edBlock('| Column | Column |\n| --- | --- |\n| cell |  |\n', 2, 4),
  wikilink: () => edWrap('[[', ']]', 'Page Title'),
  mdlink: () => {
    const ta = $('[data-ed="body"]');
    if (!ta) return;
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd) || 'link text';
    const start = ta.selectionStart;
    edType(ta, '[' + sel + '](https://)');
    const urlAt = start + 1 + sel.length + 2;
    ta.setSelectionRange(urlAt, urlAt + 8);
  },
  image: () => $('[data-ed-file]')?.click(),
  attach: () => $('[data-ed-file]')?.click(),
};

async function edHandleFiles(files) {
  for (const f of files) {
    try {
      const att = await Store.addAttachment(f);
      const label = f.name.replace(/\.[^.]+$/, '');
      if (/^image\//.test(att.type)) edBlock(`![${label}](att:${att.id} "")\n`);
      else edBlock(`!file[${label}](att:${att.id})\n`);
      toast(`Attached ${f.name} (${MD.fmtSize(att.size)})`);
    } catch (err) { toast(err.message || 'Upload failed'); }
  }
}

// [[ autocomplete while typing.
function edAutocomplete(ta) {
  const pop = $('.ed-autocomplete');
  if (!pop) return;
  const upto = ta.value.slice(0, ta.selectionStart);
  const m = upto.match(/\[\[([^\][\n]*)$/);
  if (!m) { pop.hidden = true; return; }
  const q = m[1].toLowerCase();
  const hits = Store.s.pages.filter((p) => p.title.toLowerCase().includes(q)).slice(0, 6);
  if (!hits.length) { pop.hidden = true; return; }
  pop.innerHTML = hits.map((p, i) => `<button data-action="ed-ac" data-title="${MD.esc(p.title)}" class="${i === 0 ? 'sel' : ''}">${I.page} ${MD.esc(p.title)}</button>`).join('');
  // Anchor near the caret's line, not the top of the textarea.
  const r = ta.getBoundingClientRect();
  const lineHeight = 21.6; // 13.5px * 1.6, matching the editor face
  const caretLine = upto.split('\n').length;
  const padTop = 26;
  const caretY = r.top + padTop + caretLine * lineHeight - ta.scrollTop;
  pop.style.left = Math.min(r.left + 40, innerWidth - 260) + 'px';
  pop.style.top = Math.max(60, Math.min(caretY + 6, innerHeight - 230)) + 'px';
  pop.hidden = false;
}

function edAcceptAc(title) {
  const ta = $('[data-ed="body"]');
  const upto = ta.value.slice(0, ta.selectionStart);
  const m = upto.match(/\[\[([^\][\n]*)$/);
  if (!m) return;
  const start = ta.selectionStart - m[1].length;
  ta.setSelectionRange(start, ta.selectionEnd);
  edType(ta, title + ']]');
  $('.ed-autocomplete').hidden = true;
}

function edSave() {
  const e = UI.editor;
  if (!e.title.trim()) { toast('Every page needs a title.'); $('[data-ed="title"]')?.focus(); return; }
  const clash = Store.pageByTitle(e.title.trim());
  if (clash && clash.id !== e.pageId) { toast(`“${e.title.trim()}” already exists. Titles are how pages link, so they have to be unique.`); return; }
  showModal({ kind: 'save-summary' });
}

function edCommit(summary) {
  const e = UI.editor;
  // Someone else (or another tab) may have changed the page while this editor
  // was open — never overwrite silently.
  if (!e.isNew && !e.staleOverride) {
    const cur = Store.page(e.pageId);
    if (cur && cur.body !== e.origBody) {
      const m = {
        kind: 'conflict', pageId: e.pageId,
        text: `<b>${MD.esc(Store.userName(cur.updatedBy))}</b> saved a newer version ${relTime(cur.updated)}. Saving now replaces their text with yours. Their version stays in History.`,
      };
      m.onGo = () => { UI.editor.staleOverride = true; edCommit(summary); };
      showModal(m);
      return;
    }
  }
  let p;
  if (e.isNew) {
    p = Store.createPage({ title: e.title.trim(), section: e.section, parent: e.parent, body: e.body, summary });
  } else if (!Store.page(e.pageId)) {
    // The page was trashed by someone else while this editor was open —
    // the work is saved as a fresh page instead of vanishing.
    p = Store.createPage({ title: e.title.trim(), section: e.section, body: e.body, summary });
    toast('The original was deleted while you edited, so your text was saved as a new page');
  } else {
    p = Store.savePage(e.pageId, { title: e.title.trim(), body: e.body, section: e.section, summary, baseUpdated: e.baseUpdated });
  }
  if (!p) { UI.modal = null; render(); return; } // savePage refused (e.g. size cap) and already toasted
  toast(Store.lastPersistOk ? (e.isNew ? 'Page created' : 'Saved') : 'Not saved: this browser is out of storage');
  draftStash.delete(e.pageId || 'new');
  draftDeleted.add(e.pageId || 'new');
  persistDrafts();
  UI.editor = null;
  UI.modal = null;
  // nav() alone is not enough: when editing an existing page the hash is
  // already #/page/<id>, so no hashchange fires — render explicitly.
  nav('#/page/' + p.id);
  route();
  render();
}

/* ------------------------------- history --------------------------------- */

// Word-ish intraline emphasis: common prefix/suffix of a changed del/add pair.
function intraline(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const mark = (t) => `${MD.esc(t.slice(0, p))}<mark>${MD.esc(t.slice(p, t.length - s)) || ' '}</mark>${MD.esc(t.slice(t.length - s))}`;
  return [mark(a), mark(b)];
}

function viewHistory(id) {
  const p = Store.page(id);
  if (!p) return viewMissing(id);
  const selIdx = UI.route.params.rev !== undefined ? +UI.route.params.rev : p.revs.length - 1;
  const rev = p.revs[selIdx];
  const prev = p.revs[selIdx - 1];
  const showRendered = UI.route.params.view === 'rendered';
  const d = diffLines(prev ? prev.body : '', rev ? rev.body : '');
  // Pair adjacent del/add lines for intraline emphasis.
  for (let k = 0; k < d.ops.length - 1; k++) {
    if (d.ops[k][0] === -1 && d.ops[k + 1][0] === 1) {
      const [da, db] = intraline(d.ops[k][1], d.ops[k + 1][1]);
      d.ops[k][2] = da; d.ops[k + 1][2] = db;
      k++;
    }
  }
  // Collapse long unchanged runs.
  let rows = '', run = [];
  const flushRun = () => {
    if (run.length > 8) {
      rows += run.slice(0, 3).join('');
      rows += `<div class="diff__line diff__line--skip">⋯ ${run.length - 6} unchanged lines ⋯</div>`;
      rows += run.slice(-3).join('');
    } else rows += run.join('');
    run = [];
  };
  for (const [op, line, marked] of d.ops) {
    const txt = marked || MD.esc(line) || '&nbsp;';
    const h = `<div class="diff__line ${op === 1 ? 'diff__line--add' : op === -1 ? 'diff__line--del' : ''}"><span class="diff__gut">${op === 1 ? '+' : op === -1 ? '−' : ''}</span><span class="diff__txt">${txt}</span></div>`;
    if (op === 0) run.push(h); else { flushRun(); rows += h; }
  }
  flushRun();

  return topbar(
    `<a href="#/page/${id}">${MD.esc(p.title)}</a><span class="crumbs__sep">/</span><span class="crumbs__here">History</span>`,
    selIdx < p.revs.length - 1 ? `<button class="btn" data-action="rev-restore" data-id="${id}" data-ts="${rev ? rev.ts : 0}">Restore this version</button>` : ''
  ) + `
  <div class="content"><div class="page-wrap"><div class="page-col" style="max-width:860px">
    <div class="plain-head"><span class="eyebrow">Page history</span><h1>${MD.esc(p.title)}</h1>
    <p>${p.revs.length} revisions. Select one to see what changed; anything can be restored.</p></div>
    <div class="history">
      ${p.revs.map((r, i) => {
        const pd = diffLines(p.revs[i - 1] ? p.revs[i - 1].body : '', r.body);
        return `<a class="rev ${i === p.revs.length - 1 ? 'rev--current' : ''}" href="#/history/${id}?rev=${i}" style="${i === selIdx ? 'background:var(--hover)' : ''};text-decoration:none;color:inherit">
        <span class="avatar">${Store.initials(r.by)}</span>
        <span class="rev__meta"><span class="rev__summary">${MD.esc(r.summary || 'Edited')}</span>
        <span class="rev__when">${MD.esc(Store.userName(r.by))} · ${fmtDateTime(r.ts)}</span></span>
        <span class="rev__stats"><span class="add">+${pd.add}</span><span class="del">−${pd.del}</span></span>
      </a>`;
      }).reverse().join('')}
    </div>
    <div class="plain-head" style="margin-top:28px;display:flex;align-items:baseline;gap:14px">
      <span class="eyebrow">Selected revision</span>
      <div class="editor__mode" role="tablist" style="margin-left:auto">
        <a role="tab" class="${!showRendered ? 'active' : ''}" style="padding:4px 12px;font-size:12px;text-decoration:none;color:${!showRendered ? 'var(--fg)' : 'var(--muted)'}" href="#/history/${id}?rev=${selIdx}">Changes</a>
        <a role="tab" class="${showRendered ? 'active' : ''}" style="padding:4px 12px;font-size:12px;text-decoration:none;color:${showRendered ? 'var(--fg)' : 'var(--muted)'}" href="#/history/${id}?rev=${selIdx}&view=rendered">Rendered</a>
      </div>
    </div>
    ${showRendered
      ? `<div class="prose" style="border:1px solid var(--hairline);border-radius:var(--radius);padding:20px 24px">${MD.render(rev ? rev.body : '', mdCtx({ readonly: true })).html}</div>`
      : `<div class="diff">${rows || '<div class="diff__line"><span class="diff__gut"></span><span class="diff__txt" style="color:var(--faint)">No text changes.</span></div>'}</div>`}
  </div></div></div>`;
}

/* ------------------------------- activity -------------------------------- */

function activityLine(a) {
  const who = `<b>${MD.esc(Store.userName(a.by))}</b>`;
  const pg = a.pageId && (Store.page(a.pageId) || Store.s.trash.find((p) => p.id === a.pageId));
  const pageRef = pg ? `<b>${MD.esc(pg.title)}</b>` : a.title ? `<b>${MD.esc(a.title)}</b>` : 'a page';
  const map = {
    edit: `${who} edited ${pageRef}${a.summary ? `: ${MD.esc(a.summary)}` : ''}`,
    create: `${who} created ${pageRef}`,
    delete: `${who} moved ${pageRef} to Trash`,
    restore: `${who} restored ${pageRef}`,
    move: `${who} moved ${pageRef} to another section`,
    purge: `${who} permanently deleted ${pageRef}`,
    invite: `${who} added <b>${MD.esc(a.who || '')}</b> to the roster`,
    join: `<b>${MD.esc(Store.userName(a.by))}</b> joined the wiki`,
    rename: `${who} is now going by <b>${MD.esc(a.who || '')}</b>`,
    role: `${who} made <b>${MD.esc(a.who || '')}</b> ${a.role === 'admin' ? 'an admin' : 'a member'}`,
    remove: `${who} removed <b>${MD.esc(a.who || '')}</b> from the roster`,
  };
  return map[a.kind] || `${who} did something`;
}

function viewActivity() {
  const acts = Store.activity();
  const groups = [];
  for (const a of acts) {
    const day = fmtDay(a.ts);
    if (!groups.length || groups[groups.length - 1].day !== day) groups.push({ day, items: [] });
    groups[groups.length - 1].items.push(a);
  }
  return topbar(`<a href="#/page/welcome">Wiki</a><span class="crumbs__sep">/</span><span class="crumbs__here">Activity</span>`) + `
  <div class="content"><div class="page-wrap"><div class="page-col">
    <div class="plain-head"><span class="eyebrow">Everything, newest first</span><h1>Activity</h1></div>
    <div class="feed">
      ${groups.map((g) => `<div class="feed__day"><span class="eyebrow">${g.day}</span>
        ${g.items.map((a) => {
          const pg = a.pageId && Store.page(a.pageId);
          return `<a class="feed__row" ${pg ? `href="#/page/${a.pageId}"` : ''}>
          <span class="avatar">${Store.initials(a.by)}</span>
          <span class="feed__what">${activityLine(a)}</span>
          <span class="feed__when">${relTime(a.ts)}</span></a>`;
        }).join('')}
      </div>`).join('')}
    </div>
  </div></div></div>`;
}

/* ------------------------------- admin ----------------------------------- */

/* --------------------- interest list (self-contained) ---------------------
   The client half of lib/interest.js: its own route, its own endpoint, its
   own cache (UI.interest). Nothing here touches the shared wiki state, and
   any page can link it with [Interest list](#/interest). */

function viewInterest() {
  const shell = (inner) => topbar(`<a href="#/page/welcome">Wiki</a><span class="crumbs__sep">/</span><span class="crumbs__here">Interest list</span>`) +
    `<div class="content"><div class="page-wrap page-wrap--wide"><div class="page-col page-col--wide">${inner}</div></div></div>`;
  if (!Store.isAdmin()) {
    return shell(`<div class="empty">${I.mail}<b>Only admins can read the interest list</b>
      <p>Apply-page submissions carry personal info, so they stay with team leads.</p>
      <a class="btn" href="#/page/welcome" style="text-decoration:none">Back to the wiki</a></div>`);
  }
  if (typeof REMOTE === 'undefined') {
    return shell(`<div class="empty">${I.mail}<b>Live on the deployed wiki</b>
      <p>This preview has no server. The real wiki lists Apply-page submissions here, with CSV download.</p></div>`);
  }
  const st = UI.interest || { loading: true };
  const rows = st.rows || [];
  const flaggedCount = rows.filter((r) => r.flag).length;
  const head = `<div class="plain-head"><span class="eyebrow">Recruiting</span><h1>Interest list</h1>
    <p>People who filled the form on the site's Apply page. Flagged people stay pinned on top; resubmits update in place. Link this screen from any doc as <code>[Interest list](#/interest)</code>.</p></div>
    <div class="admin-block__head"><h2>Submissions</h2><span class="count">${rows.length}${flaggedCount ? ` · ${flaggedCount} flagged` : ''}</span><span class="admin-block__grow"></span>
      <button class="btn btn--sm" data-action="interest-refresh">Refresh</button>
      ${rows.length ? `<a class="btn btn--sm" href="/api/interest.csv" download>Download CSV</a>
      <button class="btn btn--sm btn--danger" data-action="interest-clear">Clear list…</button>` : ''}
    </div>`;
  if (st.loading) return shell(head + '<p class="admin-block__sub">Loading…</p>');
  if (st.error) return shell(head + `<p class="admin-block__sub">Could not load: ${MD.esc(st.error)}. <button class="linklike" data-action="interest-refresh">Retry</button></p>`);
  if (!rows.length) return shell(head + '<p class="admin-block__sub">No submissions yet. The Apply page feeds this list; the CSV reflects the moment you download it.</p>');
  const when = (ts) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const FLAG_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/></svg>';
  const DL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m-5-5 5 5 5-5"/><path d="M21 21H3"/></svg>';
  return shell(head + `<div class="roster roster--interest"><div class="roster__scroll"><table>
    <thead><tr><th></th><th>Person</th><th>Subteam</th><th>Coolest project</th><th>Note</th><th>File</th><th>When</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="${r.flag ? 'is-flagged' : ''}">
      <td class="interest-flagcell"><button class="icon-btn interest-flagbtn ${r.flag ? 'on' : ''}" data-action="interest-flag" data-id="${r.id}" data-flag="${r.flag ? '1' : ''}" aria-pressed="${r.flag ? 'true' : 'false'}" aria-label="${r.flag ? 'Unflag' : 'Flag'} ${MD.esc(r.name)}" title="${r.flag ? 'Unflag' : 'Flag for follow-up'}">${FLAG_ICON}</button></td>
      <td><span class="who"><span class="avatar" style="background:var(--hover);color:var(--muted)">${Store.initials(r.email)}</span><span><b>${MD.esc(r.name)}</b><span class="mail">${MD.esc(r.email)}${r.cornell ? '' : ' <span class="interest-notcornell">not cornell.edu</span>'}</span></span></span></td>
      <td>${MD.esc(r.subteam || 'Not sure yet')}</td>
      <td><div class="interest-note" title="${MD.esc(r.project || '')}">${MD.esc(r.project || '')}</div></td>
      <td><button class="linklike interest-notebtn ${r.note ? '' : 'interest-notebtn--empty'}" data-action="interest-note" data-id="${r.id}" data-name="${MD.esc(r.name)}" data-note="${MD.esc(r.note || '')}" title="${MD.esc(r.note || 'Add a note')}">${r.note ? MD.esc(r.note) : 'Add note'}</button></td>
      <td><span class="interest-filecell">${r.fileId ? `<button class="linklike" data-action="interest-file" data-id="${r.id}" aria-expanded="${UI.interestFile === r.id ? 'true' : 'false'}">${MD.esc(r.fileName || 'file')}</button>${UI.interestFile === r.id ? `<a class="icon-btn interest-dl" href="/api/interest/file/${MD.esc(r.fileId)}" download="${MD.esc(r.fileName || 'file')}" aria-label="Download ${MD.esc(r.fileName || 'file')}" title="Download">${DL_ICON}</a>` : ''}` : ''}</span></td>
      <td><span class="mono" title="${new Date(r.ts).toLocaleString()}">${when(r.ts)}</span></td>
      <td><span class="actions actions--show"><button class="btn btn--sm btn--danger" data-action="interest-remove" data-id="${r.id}" data-email="${MD.esc(r.email)}">Remove</button></span></td>
    </tr>`).join('')}
    </tbody></table></div></div>
    <p class="interest-foot">${rows.length} ${rows.length === 1 ? 'person' : 'people'} on the list${flaggedCount ? `, ${flaggedCount} flagged` : ''}</p>`);
}

function viewAdmin() {
  if (!Store.isAdmin()) {
    return topbar(`<a href="#/page/welcome">Wiki</a><span class="crumbs__sep">/</span><span class="crumbs__here">Members</span>`) + `
    <div class="content"><div class="page-wrap"><div class="page-col"><div class="empty">
      ${I.users}<b>Only admins can manage members</b>
      <p>Ask a team lead if you need someone added to the roster.</p>
      <a class="btn" href="#/page/welcome" style="text-decoration:none">Back to the wiki</a>
    </div></div></div></div>`;
  }
  const users = Store.s.users;
  const active = users.filter((u) => u.status === 'active');
  const invited = users.filter((u) => u.status === 'invited');
  const audit = Store.activity().filter((a) => ['invite', 'join', 'role', 'remove', 'rename'].includes(a.kind)).slice(0, 14);
  return topbar(`<a href="#/page/welcome">Wiki</a><span class="crumbs__sep">/</span><span class="crumbs__here">Members &amp; access</span>`) + `
  <div class="content"><div class="page-wrap"><div class="page-col">
    <div class="plain-head"><span class="eyebrow">Admin</span><h1>Members &amp; access</h1>
    <p>Everyone below can sign in with their <b>cornell.edu</b> Google account. Nobody else can.</p></div>
    <div class="admin-grid">
      <section class="admin-block">
        <div class="admin-block__head"><h2>Add members</h2></div>
        <form class="invite-add" data-action="invite-form">
          <input class="text-input" name="emails" placeholder="netid@cornell.edu, netid@cornell.edu…" autocomplete="off" spellcheck="false" aria-label="Email addresses to invite">
          ${dd('invite-role', [{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }], 'member', { style: 'width:120px' })}
          <button class="btn btn--primary" type="submit">${I.send} Add members</button>
        </form>
      </section>
      ${invited.length ? `<section class="admin-block">
        <div class="admin-block__head"><h2>Added, awaiting first sign-in</h2><span class="count">${invited.length}</span></div>
        <div class="roster"><div class="roster__scroll"><table>
          <thead><tr><th>Person</th><th>Added</th><th></th></tr></thead><tbody>
          ${invited.map((u) => `<tr>
            <td><span class="who"><span class="avatar" style="background:var(--hover);color:var(--muted)">${Store.initials(u.email)}</span><span><b>${MD.esc(u.email.split('@')[0])}</b><span class="mail">${u.email}</span></span></span></td>
            <td><span class="mono">${relTime(u.invitedAt)} · by ${MD.esc(Store.userName(u.invitedBy).split(' ')[0])}</span></td>
            <td><span class="actions actions--show">
              ${typeof REMOTE === 'undefined' ? `<button class="btn btn--sm" data-action="invite-view" data-email="${u.email}">${I.mail} View email</button>` : ''}
              <button class="btn btn--sm btn--danger" data-action="user-remove" data-email="${u.email}">Remove</button>
            </span></td>
          </tr>`).join('')}
          </tbody></table></div></div>
      </section>` : ''}
      <section class="admin-block">
        <div class="admin-block__head"><h2>Members</h2><span class="count">${active.length}</span></div>
        <div class="roster"><div class="roster__scroll"><table>
          <thead><tr><th>Member</th><th>Subteam</th><th>Role</th><th>Joined</th><th></th></tr></thead><tbody>
          ${active.map((u) => `<tr>
            <td><span class="who"><span class="avatar">${Store.initials(u.email)}</span><span><b>${MD.esc(u.name)}</b><span class="mail">${u.email}</span></span></span></td>
            <td>${MD.esc(u.subteam || '—')}</td>
            <td>${u.role === 'admin' ? '<span class="chip chip--admin">admin</span>' : '<span class="chip">member</span>'}</td>
            <td><span class="mono">${u.joined ? relTime(u.joined) : '—'}</span></td>
            <td><span class="actions">
              ${u.email !== Store.me().email ? `
                <button class="btn btn--sm" data-action="role-toggle" data-email="${u.email}">${u.role === 'admin' ? 'Make member' : 'Make admin'}</button>
                <button class="btn btn--sm btn--danger" data-action="user-remove" data-email="${u.email}">Remove</button>` : '<span class="mono">you</span>'}
            </span></td>
          </tr>`).join('')}
          </tbody></table></div></div>
      </section>
      <section class="admin-block">
        <div class="admin-block__head"><h2>Email</h2></div>
        ${(() => {
          const es = Store.emailSettings();
          const connected = es.oauthConnected;
          const manual = !connected && (es.from || es.envFrom);
          const sender = es.from ? `${es.name} · ${es.from}` : es.envFrom ? es.envFrom : '';
          const editOpen = UI.emailEdit || (connected && !es.from);
          const doms = typeof REMOTE === 'undefined'
            ? [{ name: 'mail.cornellphysicalintelligence.com', status: 'verified' }]
            : (Array.isArray(UI.resendDomains) ? UI.resendDomains : null);
          const verified = (doms || []).filter((d) => d.status === 'verified');
          const useDd = verified.length > 0 && !UI.emailFromCustom;
          const opts = verified.map((d) => ({ value: `wiki@${d.name}`, label: `wiki@${d.name}` }));
          if (es.from && !opts.some((o) => o.value === es.from)) opts.unshift({ value: es.from, label: `${es.from} (unverified domain)` });
          opts.push({ value: '__custom', label: 'Custom address…' });
          const current = es.from || (opts[0] && opts[0].value !== '__custom' ? opts[0].value : '');
          const editor = `<form class="invite-add integration__editor" data-action="email-settings-form">
              <input class="text-input" name="fromname" placeholder="From name" value="${MD.esc(es.name || '')}" style="width:150px;flex:none" spellcheck="false" aria-label="From name">
              ${useDd
                ? `${dd('email-from', opts, current, {})}<input type="hidden" name="from" value="${MD.esc(current)}">`
                : `<input class="text-input" name="from" placeholder="wiki@yourdomain.com" value="${MD.esc(es.from)}" autocomplete="off" spellcheck="false" aria-label="From address">`}
              <button class="btn" type="submit">Save</button>
            </form>`;
          return `<div class="integration">
            <span class="integration__tile${connected ? '' : ' integration__tile--off'}">${RESEND_MARK}</span>
            <span class="integration__meta">
              <span class="integration__name">Resend
                ${connected ? '<span class="integration__status integration__status--on">Connected</span>'
                  : manual ? '<span class="integration__status">Manual</span>'
                  : '<span class="integration__status integration__status--off">Not connected</span>'}
              </span>
              <span class="integration__sub">${sender
                ? `Sends as ${MD.esc(sender)} <button class="linklike" data-action="email-edit">change</button>`
                : connected ? 'Pick a sender address to finish.'
                : 'Welcome emails for new members.'}</span>
            </span>
            <span class="integration__actions">
              ${(connected || manual || es.keySet || es.envKeySet) ? `<button class="btn btn--sm" data-action="email-test">Send test</button>` : ''}
              ${connected
                ? `<button class="btn btn--sm" data-action="resend-disconnect">Disconnect</button>`
                : `<a class="btn btn--sm btn--primary" style="text-decoration:none" href="/api/resend/connect" data-action-preview="resend-connect">Connect</a>`}
            </span>
          </div>
          ${editOpen ? editor : ''}
          ${connected ? '' : `<details class="email-adv"${UI.emailFromCustom ? ' open' : ''}>
            <summary>Use an API key instead</summary>
            <form class="invite-add" data-action="email-settings-form">
              <input class="text-input" name="fromname" placeholder="From name" value="${MD.esc(es.name || '')}" style="width:150px;flex:none" spellcheck="false" aria-label="From name">
              <input class="text-input" name="from" placeholder="wiki@yourdomain.com" value="${MD.esc(es.from)}" autocomplete="off" spellcheck="false" aria-label="From address">
              <input class="text-input" name="key" type="password" placeholder="${es.keySet ? `Key ends in …${MD.esc(es.keyTail)} (blank keeps it)` : 'Resend API key (re_…)'}" autocomplete="new-password" aria-label="Resend API key">
              <button class="btn" type="submit">Save</button>
            </form>
          </details>`}`;
        })()}
      </section>
      <section class="admin-block">
        <div class="admin-block__head"><h2>Access log</h2></div>
        <div class="audit">
          ${audit.map((a) => `<div class="audit__row"><span class="audit__when">${fmtDateTime(a.ts)}</span><span class="audit__what">${activityLine(a)}</span></div>`).join('') || '<div class="audit__row"><span class="audit__what">Nothing yet.</span></div>'}
        </div>
      </section>
    </div>
  </div></div></div>`;
}

function welcomeEmailHtml(u) {
  return `<div class="mailview">
    <div class="mailview__head">
      <div class="mailview__row"><span class="k">From</span><span>CUPI Wiki &lt;wiki@cornellphysicalintelligence.com&gt;</span></div>
      <div class="mailview__row"><span class="k">To</span><span>${u.email}</span></div>
      <div class="mailview__row"><span class="k">Subject</span><span><b>You're on the CUPI wiki</b></span></div>
    </div>
    <div class="mailview__body">
      <div class="mailview__wordmark">CUPI</div>
      <div class="mailview__eyebrow">Cornell Physical Intelligence &middot; Internal Wiki</div>
      <img class="mailview__crab" src="${CRAB_URI}" alt="The CUPI crab, on a beach">
      <p>Hi,</p>
      <p><b>${MD.esc(Store.userName(u.invitedBy))}</b> added you to the CUPI wiki, the team's internal knowledge base for CAD, electronics, software, and everything in between.</p>
      <p><a class="mailview__btn" href="https://wiki.cornellphysicalintelligence.com">Open the wiki</a></p>
      <p style="color:var(--muted);font-size:13px">Sign in with your ${u.email} Google account. You're already on the list. If you weren't expecting this, ignore it.</p>
    </div>
  </div>`;
}

/* ------------------------------- trash / guide --------------------------- */

function viewTrash() {
  const items = [...Store.s.trash].sort((a, b) => b.deletedAt - a.deletedAt);
  return topbar(`<a href="#/page/welcome">Wiki</a><span class="crumbs__sep">/</span><span class="crumbs__here">Trash</span>`) + `
  <div class="content"><div class="page-wrap"><div class="page-col">
    <div class="plain-head"><span class="eyebrow">Deleted pages</span><h1>Trash</h1><p>Pages stay here for 30 days, then they're gone for good.</p></div>
    ${items.length ? `<div class="history">${items.map((p) => `<div class="rev">
      <span class="avatar">${Store.initials(p.deletedBy)}</span>
      <span class="rev__meta"><span class="rev__summary">${MD.esc(p.title)}</span><span class="rev__when">deleted by ${MD.esc(Store.userName(p.deletedBy))} · ${relTime(p.deletedAt)}</span></span>
      <button class="btn btn--sm" data-action="trash-restore" data-id="${p.id}">Restore</button>
      <button class="btn btn--sm btn--danger" data-action="trash-purge" data-id="${p.id}">Delete forever</button>
    </div>`).join('')}</div>` : `<div class="empty">${I.trash}<b>Trash is empty</b><p>Deleted pages will wait here for 30 days.</p></div>`}
  </div></div></div>`;
}

/* ------------------------------- palette --------------------------------- */

function openPalette() {
  UI.palette = { q: '', sel: 0 };
  render();
  $('.palette input')?.focus();
}

function paletteResults() {
  const q = UI.palette.q;
  if (!q.trim()) {
    const recents = Store.quick('');
    return { kind: 'recents', items: recents };
  }
  const exact = Store.search(q);
  if (exact.length) return { kind: 'search', items: exact };
  // Typo forgiveness: fall back to fuzzy title matches ("hexpod" → Hexapod).
  return { kind: 'fuzzy', items: Store.quick(q) };
}

function paletteListHtml() {
  const { kind, items } = paletteResults();
  const q = UI.palette.q.trim().toLowerCase();
  const mark = (text) => {
    if (!q) return MD.esc(text);
    const i = text.toLowerCase().indexOf(q.split(/\s+/)[0]);
    if (i < 0) return MD.esc(text);
    const t0 = q.split(/\s+/)[0];
    return MD.esc(text.slice(0, i)) + '<mark>' + MD.esc(text.slice(i, i + t0.length)) + '</mark>' + MD.esc(text.slice(i + t0.length));
  };
  UI.palette.count = items.length;
  return `${items.length ? `<div class="palette__group eyebrow">${kind === 'recents' ? 'Recent' : kind === 'fuzzy' ? 'Closest matches' : 'Results'}</div>` : ''}
    ${items.map((r, i) => `<button class="palette__item ${i === UI.palette.sel ? 'sel' : ''}" data-action="palette-go" data-id="${r.page.id}">
      ${I.page}<span style="min-width:0"><span class="palette__title">${mark(r.page.title)}</span>
      ${r.snip ? `<br><span class="palette__snip">${mark(r.snip)}</span>` : ''}</span>
      <span class="palette__where">${SECTIONS.find((s) => s.id === r.page.section)?.name || ''}</span>
    </button>`).join('')}
    ${!items.length && q ? `<div class="palette__empty">Nothing matches “${MD.esc(UI.palette.q)}”.<br><button class="btn btn--sm" style="margin-top:10px" data-action="palette-create">${I.plus} Create “${MD.esc(UI.palette.q)}”</button></div>` : ''}`;
}

// Only the list re-renders while typing — the input (and its caret) stay put.
function renderPaletteList() {
  const list = $('.palette__list');
  if (list) list.innerHTML = paletteListHtml();
}

function viewPalette() {
  if (!UI.palette) return '';
  return `<div class="palette-veil" data-action="palette-close">
    <div class="palette" role="dialog" aria-label="Search">
      <div class="palette__head">${I.search}<input placeholder="Search every page by title or text…" value="${MD.esc(UI.palette.q)}" spellcheck="false" aria-label="Search query"><span class="kbd">esc</span></div>
      <div class="palette__list">${paletteListHtml()}</div>
      <div class="palette__foot"><span>↑↓ navigate</span><span>↵ open</span><span>esc close</span></div>
    </div>
  </div>`;
}

const RESEND_MARK = '<svg viewBox="0 0 1800 1800" fill="currentColor" aria-hidden="true"><path d="M1000.46 450C1174.77 450 1278.43 553.669 1278.43 691.282C1278.43 828.896 1174.77 932.563 1000.46 932.563H912.382L1350 1350H1040.82L707.794 1033.48C683.944 1011.47 672.936 985.781 672.935 963.765C672.935 932.572 694.959 905.049 737.161 893.122L908.712 847.244C973.85 829.812 1018.81 779.353 1018.81 713.298C1018.8 632.567 952.745 585.78 871.095 585.78H450V450H1000.46Z"/></svg>';

/* ------------------------------- modals ---------------------------------- */

function viewModal() {
  const m = UI.modal;
  if (!m) return '';
  let inner = '';
  if (m.kind === 'new-page') {
    // Each template card shows a live-rendered snapshot of the template itself,
    // so you see the structure you're choosing, not just its name.
    const thumb = (t) => {
      if (!t.body) return `<div class="tpl__thumb tpl__thumb--blank"><span>Blank page</span></div>`;
      const { html } = MD.render(t.body, mdCtx({ readonly: true }));
      return `<div class="tpl__thumb"><div class="prose">${html.replace(/<a /g, '<a tabindex="-1" ')}</div></div>`;
    };
    inner = `<div class="modal modal--wide" role="dialog" aria-label="New page">
      <div class="modal__head"><h3>New page</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
      <div class="modal__body">
        <label>Title<input class="text-input" data-m="title" placeholder="e.g. Landing Gear Study" value="${MD.esc(m.title || '')}" maxlength="90" spellcheck="true" autocorrect="off"></label>
        <label>Section${ddSections(m.section || 'projects')}</label>
        <label>Template<span class="sub">Start from a structure the team already uses.</span></label>
        <div class="tpl-grid">${TEMPLATES.map((t) => `<button class="tpl ${(m.tpl || 'blank') === t.id ? 'sel' : ''}" data-action="tpl-pick" data-tpl="${t.id}" aria-label="${MD.esc(t.name)}">${thumb(t)}<b>${t.name}</b><span class="tpl__desc">${MD.esc(t.desc)}</span></button>`).join('')}</div>
        ${m.error ? `<span class="field-error">${MD.esc(m.error)}</span>` : ''}
      </div>
      <div class="modal__foot"><button class="btn" data-action="modal-close">Cancel</button><button class="btn btn--primary" data-action="new-page-go">Create &amp; edit</button></div>
    </div>`;
  } else if (m.kind === 'save-summary') {
    inner = `<div class="modal" role="dialog" aria-label="Save">
      <div class="modal__head"><h3>${UI.editor?.isNew ? 'Create page' : 'Save changes'}</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
      <div class="modal__body">
        <label>What changed? <span class="sub">Optional: one line for the history, so anyone can find this change later.</span>
        <input class="text-input" data-m="summary" placeholder="${UI.editor?.isNew ? 'Created page' : 'e.g. Added rev D bring-up results'}" maxlength="120" spellcheck="true" autocorrect="off"></label>
      </div>
      <div class="modal__foot"><button class="btn" data-action="modal-close">Keep editing</button><button class="btn btn--primary" data-action="save-commit">Save</button></div>
    </div>`;
  } else if (m.kind === 'invite-mail') {
    const u = Store.user(m.email);
    inner = `<div class="modal modal--wide" role="dialog" aria-label="Welcome email">
      <div class="modal__head"><h3>Welcome email sent</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
      <div class="modal__body">
        ${u ? welcomeEmailHtml(u) : ''}
        <p class="admin-block__sub" style="margin:0">In this preview the email is simulated. Production sends it automatically the moment you add the address. Access works the moment they sign in, email or not.</p>
      </div>
      <div class="modal__foot"><button class="btn btn--primary" data-action="modal-close">Done</button></div>
    </div>`;
  } else if (m.kind === 'confirm') {
    // Optional extras: a free-text field handed to onGo, and a GitHub-style
    // type-to-confirm phrase that keeps the danger button locked until it
    // matches exactly.
    const field = m.field
      ? `<label class="modal-typed">${MD.esc(m.field.label || 'Note')}
          <input class="text-input" data-m="modal-field" value="${MD.esc(m.field.value || '')}" placeholder="${MD.esc(m.field.placeholder || '')}" maxlength="${m.field.maxlength || 280}" autocomplete="off" spellcheck="true"></label>`
      : '';
    const typed = m.typed
      ? `<label class="modal-typed">Type <b class="modal-typed__phrase">${MD.esc(m.typed)}</b> to confirm
          <input class="text-input" data-m="modal-typed" data-phrase="${MD.esc(m.typed)}" placeholder="${MD.esc(m.typed)}" autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="off"></label>`
      : '';
    inner = `<div class="modal" role="dialog" aria-label="Confirm">
      <div class="modal__head"><h3>${MD.esc(m.title)}</h3></div>
      <div class="modal__body"><p style="margin:0;font-size:14px;color:var(--muted)">${m.text}</p>${field}${typed}</div>
      <div class="modal__foot"><button class="btn" data-action="modal-close">Cancel</button><button class="btn ${m.danger ? 'btn--danger' : 'btn--primary'}" data-action="confirm-go" ${m.typed ? 'disabled' : ''}>${MD.esc(m.confirm || 'Confirm')}</button></div>
    </div>`;
  }
  if (m.kind === 'conflict') {
    inner = `<div class="modal" role="dialog" aria-label="Edit conflict">
      <div class="modal__head"><h3>This page changed while you edited</h3></div>
      <div class="modal__body"><p style="margin:0;font-size:14px;color:var(--muted)">${m.text}</p></div>
      <div class="modal__foot modal__foot--split">
        <button class="btn" data-action="copy-mine">${I.copy} Copy my text</button>
        <a class="btn" href="#/history/${m.pageId}" target="_blank" rel="noopener" style="text-decoration:none">See what changed</a>
        <span style="flex:1"></span>
        <button class="btn" data-action="modal-close">Cancel</button>
        <button class="btn btn--danger" data-action="confirm-go">Save mine anyway</button>
      </div>
    </div>`;
  }
  if (m.kind === 'close-editor') {
    inner = `<div class="modal" role="dialog" aria-label="Unsaved changes">
      <div class="modal__head"><h3>You have unsaved changes</h3></div>
      <div class="modal__body"><p style="margin:0;font-size:14px;color:var(--muted)">Keep the draft and it will be waiting the next time you open this page. Discard throws away everything you wrote in this session.</p></div>
      <div class="modal__foot modal__foot--split">
        <button class="btn btn--ghost" data-action="modal-close">Keep editing</button>
        <span style="flex:1"></span>
        <button class="btn btn--danger" data-action="editor-discard-close">Discard changes</button>
        <button class="btn btn--primary" data-action="editor-keep-draft">Keep draft</button>
      </div>
    </div>`;
  }
  if (!inner) inner = viewExtraModal(m);
  return `<div class="modal-veil" data-action="modal-veil">${inner}</div>`;
}

/* ------------------------------- video hydration -------------------------- */

// The markdown renderer is synchronous, so video facades come out with a
// generic provider label; the real title arrives here from each provider's
// oEmbed endpoint after render. Session caches, because renders happen
// constantly and must never refetch: "provider:id" → { title, thumb } (either
// may be null), null after a failed fetch, or a Promise while one is in
// flight. Every failure path stays silent — the facade keeps its provider
// label and dark ground, which is all the artifact preview's CSP ever shows.
const videoMeta = new Map();
// "provider:id" → the thumbnail URL that actually loaded, '' when every
// candidate failed — re-renders neither re-probe dead URLs nor re-walk chains.
const videoThumbSrc = new Map();

// All three endpoints answer browser CORS: youtube.com/oembed echoes any
// Origin (including the null of a file:// preview), vimeo.com and loom.com
// send access-control-allow-origin: *.
const VIDEO_OEMBED = {
  youtube: (id) => `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}&format=json`,
  vimeo: (id) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent('https://vimeo.com/' + id)}`,
  loom: (id) => `https://www.loom.com/v1/oembed?url=${encodeURIComponent('https://www.loom.com/share/' + id)}`,
};

// Walk a facade thumbnail down its candidate list. onerror alone is not
// enough: YouTube answers maxresdefault/sddefault requests for videos that
// lack them with a gray 120×90 placeholder the browser loads as a success,
// so the onload check steps past anything placeholder-sized. A dead end
// removes the img and leaves the clean dark facade.
function wireVideoThumb(img, key, chain, i) {
  const next = () => {
    if (i + 1 < chain.length) wireVideoThumb(img, key, chain, i + 1);
    else { videoThumbSrc.set(key, ''); img.remove(); }
  };
  img.onload = () => { if (img.naturalWidth <= 120) next(); else videoThumbSrc.set(key, chain[i]); };
  img.onerror = next;
  if (img.getAttribute('src') !== chain[i]) img.src = chain[i];
}

function applyVideoMeta(face, meta) {
  const tag = $('.video-embed__tag', face);
  if (tag && meta.title && tag.textContent !== meta.title) {
    tag.title = tag.textContent; // the provider label stays, one hover away
    tag.textContent = meta.title; // textContent, so the title can't inject markup
    face.setAttribute('aria-label', `Play ${meta.title} (${tag.title})`);
  }
  // Vimeo and Loom have no guessable thumbnail URL — backfill from oEmbed.
  const key = `${face.dataset.provider}:${face.dataset.vid}`;
  const known = videoThumbSrc.get(key);
  if (!$('.video-embed__thumb', face) && known !== '' && /^https:\/\//.test(known || meta.thumb || '')) {
    const img = document.createElement('img');
    img.className = 'video-embed__thumb';
    img.alt = '';
    img.loading = 'lazy';
    face.prepend(img);
    wireVideoThumb(img, key, [known || meta.thumb], 0);
  }
}

function mountVideoMeta(face) {
  const provider = face.dataset.provider, id = face.dataset.vid || '';
  const oembed = VIDEO_OEMBED[provider];
  if (face._videoMounted || !oembed || !/^[\w-]{6,40}$/.test(id)) return;
  face._videoMounted = true;
  const key = `${provider}:${id}`;

  const img = $('.video-embed__thumb', face);
  if (img) {
    const known = videoThumbSrc.get(key);
    if (known !== undefined) {
      if (known) wireVideoThumb(img, key, [known], 0); else img.remove();
    } else if (provider === 'youtube') {
      wireVideoThumb(img, key, ['maxresdefault', 'sddefault', 'hqdefault'].map((n) => `https://i.ytimg.com/vi/${id}/${n}.jpg`), 0);
    }
  }

  const cached = videoMeta.get(key);
  if (cached === undefined) {
    videoMeta.set(key, fetch(oembed(id))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && typeof j.title === 'string' ? { title: j.title, thumb: typeof j.thumbnail_url === 'string' ? j.thumbnail_url : null } : null))
      .catch(() => null)
      .then((meta) => {
        videoMeta.set(key, meta);
        // The render that queued this fetch may be gone — hydrate whatever
        // facades for this video are on screen now; later renders read the cache.
        if (meta) $$(`.video-embed__face[data-provider="${provider}"][data-vid="${id}"]`).forEach((f) => applyVideoMeta(f, meta));
      }));
  } else if (cached && !(cached instanceof Promise)) {
    applyVideoMeta(face, cached);
  }
}

/* ------------------------------- render ---------------------------------- */

function render() {
  cadCleanups.forEach((fn) => fn());
  cadCleanups = [];
  window.__closeMenu?.();
  document.querySelectorAll('body > .modal-veil').forEach((v) => v.remove());
  killPreview(); // a hover preview must not outlive the page it points into
  const app = $('#app');
  const me = Store.me();
  let view = '';
  const r = UI.route;

  // Re-renders of the same route (checkbox ticks, comments, stars) must not
  // throw the reader back to the top of the page.
  const prevSidebar = $('.sidebar__scroll');
  const sidebarScroll = prevSidebar ? prevSidebar.scrollTop : 0;
  const prevContent = $('.content');
  const keepScroll = prevContent && UI._lastRouteKey === r.name + '/' + (r.params.id || '');
  const scrollTop = keepScroll ? prevContent.scrollTop : 0;
  UI._lastRouteKey = r.name + '/' + (r.params.id || '');

  if (!me) {
    app.innerHTML = viewLogin();
    const vt = $('.login .vt-title');
    if (vt) mountHeroTitle(vt);
    mountLoginCard($('.login__card'));
    return;
  }
  if (UI.editor) view = viewEditor();
  else if (r.name === 'page') view = viewPage(r.params.id || 'welcome');
  else if (r.name === 'section') view = viewSection(r.params.id);
  else if (r.name === 'history') view = viewHistory(r.params.id);
  else if (r.name === 'activity') view = viewActivity();
  else if (r.name === 'admin') view = viewAdmin();
  else if (r.name === 'interest') view = viewInterest();
  else if (r.name === 'trash') view = viewTrash();
  else if (r.name === 'health') view = viewHealth();
  else if (r.name === 'new') {
    // Re-renders while typing must not rebuild editor state from the stash:
    // the autosave is debounced, so the stash can trail the textarea by 900ms.
    if (!UI.editor || !UI.editor.isNew) {
      const draft = draftStash.get('new');
      openEditor(null, true, draft || { title: r.params.title || '', section: r.params.section || 'projects' });
      if (draft) { UI.editor.dirty = true; UI.editor.fromDraft = true; }
    }
    view = viewEditor();
  }
  else if (r.name === 'edit' && Store.page(r.params.id)) {
    if (!UI.editor || UI.editor.pageId !== r.params.id) {
      const draft = draftStash.get(r.params.id);
      openEditor(r.params.id, false, draft);
      if (draft) { UI.editor.dirty = true; UI.editor.fromDraft = true; }
    }
    view = viewEditor();
  }
  else view = viewPage('welcome');

  app.innerHTML = `<div class="shell ${UI.navOpen ? 'nav-open' : ''} ${UI.navHidden ? 'nav-hidden' : ''}">
    ${viewSidebar()}
    <main class="main">${view}</main>
    <div class="shell__scrim" data-action="nav-close"></div>
  </div>${viewPalette()}${viewModal()}`;

  const editorToggled = UI._hadEditor !== !!UI.editor;
  UI._hadEditor = !!UI.editor;
  if (UI.editor && editorToggled) $('.editor')?.classList.add('editor-in');
  else if (!UI.editor && (!keepScroll || editorToggled)) $('.content')?.classList.add('route-in');

  if (keepScroll) { const c = $('.content'); if (c) c.scrollTop = scrollTop; }
  { const sb = $('.sidebar__scroll'); if (sb) sb.scrollTop = sidebarScroll; }

  // Mount hooks.
  $$('.cad-embed').forEach(mountCadViewer);
  { const vt = $('.login .vt-title'); if (vt) mountHeroTitle(vt); }
  if (typeof REMOTE !== 'undefined' && r.name === 'admin' && !UI.editor && UI.resendDomains === undefined && Store.isAdmin()) {
    const es = Store.emailSettings();
    if (es.oauthConnected || es.keySet || es.envKeySet) {
      UI.resendDomains = 'pending';
      api('/resend/domains').then((out) => { UI.resendDomains = out.domains; render(); }).catch(() => { UI.resendDomains = null; });
    }
  }
  // The interest component loads from its own endpoint the first time its
  // screen opens; Refresh clears the cache to refetch.
  if (typeof REMOTE !== 'undefined' && r.name === 'interest' && UI.interest === undefined && Store.isAdmin()) {
    UI.interest = { loading: true };
    api('/interest')
      .then((out) => { UI.interest = { rows: out.rows || [] }; render(); })
      .catch((e) => { UI.interest = { error: e.message || 'load failed' }; render(); });
  }
  // The sidebar badge only needs counts, fetched once per session for admins
  // so flagged candidates are visible from anywhere in the wiki.
  if (typeof REMOTE !== 'undefined' && Store.isAdmin() && UI.interestSummary === undefined) {
    UI.interestSummary = { flagged: 0 };
    api('/interest/summary')
      .then((out) => { UI.interestSummary = out; render(); })
      .catch(() => { /* the badge is a courtesy */ });
  }
  $$('.video-embed__face').forEach(mountVideoMeta);
  if (UI.editor) {
    edUpdatePreview();
    const src = $('[data-ed="body"]');
    const prev = $('.editor__pane--preview');
    if (src && prev && !src._syncBound) {
      src._syncBound = true;
      src.addEventListener('scroll', () => {
        const ratio = src.scrollTop / Math.max(1, src.scrollHeight - src.clientHeight);
        prev.scrollTop = ratio * (prev.scrollHeight - prev.clientHeight);
      }, { passive: true });
    }
    const ta = $('[data-ed="body"]');
    if (ta && !UI.editor._focused) { (UI.editor.isNew && !UI.editor.title ? $('[data-ed="title"]') : ta)?.focus(); UI.editor._focused = true; }
  }
  if (UI.palette) { const inp = $('.palette input'); inp?.focus(); inp?.setSelectionRange(inp.value.length, inp.value.length); }
  if (UI.modal) $('.modal [data-m], .modal .btn--primary')?.focus?.();
  if (UI.modal?.kind === 'bug') mountBugDrop();
  if (r.name === 'page' && r.params.anchor) {
    const el = $('#' + CSS.escape(r.params.anchor));
    const c = $('.content');
    if (el && c) {
      const land = () => { c.scrollTop = c.scrollTop + el.getBoundingClientRect().top - c.getBoundingClientRect().top - 68; };
      land();
      // media above the heading can size in after the first paint and push it
      requestAnimationFrame(land);
      UI._tocPin = el.id;
    }
  }
  mountTocSpy();
}

function mountTocSpy() {
  const content = $('[data-toc-root]');
  const links = $$('.toc a');
  if (!content || !links.length) return;
  const heads = links.map((a) => document.getElementById(a.dataset.toc)).filter(Boolean);
  const spy = () => {
    let cur = heads[0];
    for (const h of heads) if (h.getBoundingClientRect().top < 120) cur = h;
    // At the very bottom the last section may be too short to cross the line,
    // yet it is where the reader was taken — highlight it, not its neighbor.
    if (content.scrollTop + content.clientHeight >= content.scrollHeight - 2) cur = heads[heads.length - 1];
    const pin = UI._tocPin && heads.find((h) => h.id === UI._tocPin);
    if (pin) cur = pin;
    links.forEach((a) => a.classList.toggle('here', a.dataset.toc === cur?.id));
  };
  const unpin = () => { if (UI._tocPin) { UI._tocPin = null; spy(); } };
  content.addEventListener('wheel', unpin, { passive: true });
  content.addEventListener('touchmove', unpin, { passive: true });
  content.addEventListener('scroll', spy, { passive: true });
  spy();
}
