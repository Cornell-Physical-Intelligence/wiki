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
    origTitle: draft?.origTitle ?? p?.title ?? '', origBody: draft?.origBody ?? p?.body ?? '',
    origSection: draft?.origSection ?? p?.section ?? '',
    baseUpdated: draft?.baseUpdated ?? p?.updated ?? null,
    createRequestId: draft?.createRequestId ?? null,
    createRequestDraft: draft?.createRequestId ? draft : null,
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
      `${e.isNew ? '<span class="crumbs__here">New page</span>' : (() => { const p = Store.page(e.pageId); return p ? crumbsFor(p) : '<span class="crumbs__here">Editing</span>'; })()}${e.dirty ? '<span class="crumbs__draft">unsaved</span>' : ''}`,
      `<div class="editor__mode" role="tablist" aria-label="Editor mode">
        <button role="tab" data-action="ed-mode" data-mode="write" class="${e.mode === 'write' ? 'active' : ''}">Write</button>
        <button role="tab" data-action="ed-mode" data-mode="split" class="${e.mode === 'split' ? 'active' : ''}">Split</button>
        <button role="tab" data-action="ed-mode" data-mode="preview" class="${e.mode === 'preview' ? 'active' : ''}">Preview</button>
      </div>
      <button class="btn btn--ghost" data-action="ed-cancel">Close</button>
      <button class="btn btn--primary" data-action="ed-save">Save${e.isNew ? ' page' : ''}…<span class="kbd" style="background:transparent;border-color:currentColor;color:inherit;opacity:.6;margin-left:2px">⌘S</span></button>`
    )}
    <div class="editor__toolbar" role="toolbar" aria-label="Formatting">
      <div class="editor__tools">
        ${tools.map((t) => t === null ? '<span class="sep"></span>' :
          `<button class="icon-btn" data-action="ed-tool" data-tool="${t[0]}" title="${t[2]}" aria-label="${t[2]}">${t[1]}</button>`).join('')}
      </div>
      <div class="editor__toolend">
        <button class="icon-btn${spell ? ' active' : ''}" data-action="ed-spell" aria-pressed="${spell}" title="Spell check" aria-label="Spell check">${lucide('spellcheck')}</button>
        <span class="editor__count" data-ed-count>${e.body.trim() ? e.body.trim().split(/\s+/).length : 0} words</span>
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
  if (!e || !host) return;
  const previous = $$('.cad-embed', host);
  const viewers = new Map();
  for (const viewer of previous) {
    const key = viewer.dataset.att;
    if (!viewers.has(key)) viewers.set(key, []);
    viewers.get(key).push(viewer);
  }
  const { html } = MD.render(e.body, mdCtx({ readonly: true }));
  const next = document.createElement('template');
  next.innerHTML = (e.title ? `<h1 class="preview-title">${MD.esc(e.title)}</h1>` : '') + html;
  const retained = new Set();
  for (const placeholder of $$('.cad-embed', next.content)) {
    const viewer = viewers.get(placeholder.dataset.att)?.shift();
    if (viewer) { retained.add(viewer); placeholder.replaceWith(viewer); }
  }
  for (const viewer of previous) {
    if (retained.has(viewer)) continue;
    viewer._cadCleanup?.();
    cadCleanups = cadCleanups.filter((cleanup) => cleanup !== viewer._cadCleanup);
  }
  const scroll = host.parentElement?.scrollTop;
  host.replaceChildren(next.content);
  if (scroll !== undefined) host.parentElement.scrollTop = scroll;
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

function editorDraft(e) {
  const sameCreate = e.createRequestDraft && e.createRequestDraft.title.trim() === e.title.trim()
    && e.createRequestDraft.body === e.body && e.createRequestDraft.section === e.section;
  return { title: e.title, body: e.body, section: e.section, parent: e.parent, tags: e.tags,
    origBody: e.origBody, origTitle: e.origTitle, origSection: e.origSection, baseUpdated: e.baseUpdated,
    ...(sameCreate && e.createRequestId ? { createRequestId: e.createRequestId } : {}) };
}

function keepEditorDraft(e) {
  const draft = editorDraft(e);
  draftStash.set(e.pageId || 'new', draft);
  draftDeleted.delete(e.pageId || 'new');
  persistDrafts();
  return draft;
}

// Locate the original insertion point after intervening typing. Existing text
// is never replaced by an asynchronous upload completion.
function uploadInsertPosition(before, after, position) {
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  if (position <= prefix) return position;
  if (position >= before.length - suffix) return Math.max(0, after.length - (before.length - position));
  return after.length - suffix;
}

async function edHandleFiles(files) {
  const e = UI.editor;
  if (!e || e.saving || !files.length) return;
  const originalField = $('[data-ed="body"]');
  let baseline = e.body, position = originalField?.selectionStart ?? e.body.length;
  e.uploads = (e.uploads || 0) + files.length;
  e.dirty = true;
  keepEditorDraft(e);
  for (const f of files) {
    try {
      const att = await Store.addAttachment(f);
      const label = f.name.replace(/\.[^.]+$/, '').replace(/[\[\]\\\r\n]/g, '');
      const markup = /^image\//.test(att.type) ? `![${label}](att:${att.id} "")\n` : `!file[${label}](att:${att.id})\n`;
      const draft = draftStash.get(e.pageId || 'new');
      // Navigation can stash this editor, but a replacement or discarded draft
      // must never receive a late upload intended for a different document.
      if (UI.editor !== e && ((UI.editor && (UI.editor.pageId || 'new') === (e.pageId || 'new')) || !draft || draft.body !== e.body || draft.title !== e.title)) {
        toast(`Upload finished for ${f.name}, but its draft changed. Attach the file again.`);
        continue;
      }
      position = uploadInsertPosition(baseline, e.body, position);
      const text = (position && e.body[position - 1] !== '\n' ? '\n' : '') + markup;
      const field = UI.editor === e ? $('[data-ed="body"]') : null;
      if (field) {
        const active = document.activeElement, start = field.selectionStart, end = field.selectionEnd, scroll = field.scrollTop;
        field.setSelectionRange(position, position);
        edType(field, text);
        // Restore the author's focus and selection after the insertion. The
        // same textarea retains its native undo history.
        field.setSelectionRange(start + (start >= position ? text.length : 0), end + (end >= position ? text.length : 0));
        field.scrollTop = scroll;
        if (active && active !== field && active.isConnected) active.focus({ preventScroll: true });
        e.body = field.value;
      } else e.body = e.body.slice(0, position) + text + e.body.slice(position);
      baseline = e.body;
      position += text.length;
      keepEditorDraft(e);
      toast(`Attached ${f.name} (${MD.fmtSize(att.size)})`);
    } catch (err) { toast(err.message || 'Upload failed'); }
    finally { e.uploads--; }
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
  // Measure the wrapped caret line and the rendered list. Long page names and
  // a software keyboard can change both; fixed size guesses clip the choices.
  const r = ta.getBoundingClientRect(), style = getComputedStyle(ta);
  const caret = taTextY(ta, ta.selectionStart);
  const viewport = window.visualViewport;
  const edge = 10, gap = 6;
  const left = (viewport?.offsetLeft || 0) + edge, top = (viewport?.offsetTop || 0) + edge;
  const width = Math.max(1, (viewport?.width || innerWidth) - edge * 2);
  const height = Math.max(1, (viewport?.height || innerHeight) - edge * 2);
  const right = left + width, bottom = top + height;
  const textTop = r.top + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.paddingTop) || 0) - ta.scrollTop;
  const caretTop = Math.max(top, Math.min(textTop + caret.top, bottom));
  const caretBottom = Math.max(caretTop, Math.min(textTop + caret.bottom, bottom));
  pop.style.visibility = 'hidden';
  pop.style.minWidth = Math.min(230, width) + 'px';
  pop.style.maxWidth = width + 'px';
  pop.style.maxHeight = height + 'px';
  pop.style.overflowY = 'auto';
  pop.style.left = left + 'px';
  pop.hidden = false;
  const below = Math.max(0, bottom - caretBottom - gap), above = Math.max(0, caretTop - gap - top);
  const opensAbove = pop.offsetHeight > below && above > below;
  pop.style.maxHeight = Math.min(height, Math.max(40, opensAbove ? above : below)) + 'px';
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = Math.max(left, Math.min(r.left + (parseFloat(style.paddingLeft) || 0), right - w)) + 'px';
  pop.style.top = Math.max(top, Math.min(opensAbove ? caretTop - gap - h : caretBottom + gap, bottom - h)) + 'px';
  pop.style.visibility = '';
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

function edChangePreview(e) {
  // Trim unchanged edges before the bounded line diff. Small edits to long
  // documents should not become a whole-document replacement in the preview.
  const before = (e.origBody || '').split('\n'), after = e.body.split('\n');
  let first = 0, oldEnd = before.length, newEnd = after.length;
  while (first < oldEnd && first < newEnd && before[first] === after[first]) first++;
  while (oldEnd > first && newEnd > first && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  const oldLines = before.slice(first, oldEnd), newLines = after.slice(first, newEnd);
  const ops = !oldLines.length ? newLines.map((line) => [1, line])
    : !newLines.length ? oldLines.map((line) => [-1, line])
    : diffLines(oldLines.join('\n'), newLines.join('\n')).ops;
  const changes = ops.filter(([op, line]) => op && !(e.isNew && op === -1 && !line));
  const add = changes.filter(([op]) => op === 1).length, del = changes.length - add;
  const selected = changes.length <= 80 ? changes : Array.from({ length: 80 }, (_, i) => changes[Math.floor(i * (changes.length - 1) / 79)]);
  const budget = Math.min(1000, Math.floor(11500 / Math.max(1, selected.length)));
  let truncated = selected.length < changes.length;
  const lines = selected.map(([op, line]) => {
    const safe = line.replace(/data:[^\s)"']+/g, '[embedded file]');
    if (safe.length > budget) truncated = true;
    return `${op === 1 ? '+' : '-'} ${safe.slice(0, budget)}${safe.length > budget ? '…' : ''}`;
  });
  const title = e.title.trim();
  const sectionName = (id) => SECTIONS.find((s) => s.id === id)?.name || id || '';
  const titleChanged = !e.isNew && title !== e.origTitle;
  const sectionChanged = !e.isNew && e.section !== e.origSection;
  const fallback = (e.isNew ? `Created ${title}` : titleChanged ? `Renamed ${e.origTitle} to ${title}`
    : sectionChanged && !changes.length ? `Moved ${title} to ${sectionName(e.section)}`
    : changes.length ? `Updated ${title}` : 'No changes').slice(0, 120);
  return { add, del, lines, truncated, fallback, titleChanged, sectionChanged,
    hasChanges: e.isNew || titleChanged || sectionChanged || changes.length > 0,
    input: { title, beforeTitle: e.origTitle, section: sectionName(e.section), beforeSection: sectionName(e.origSection),
      isNew: e.isNew, truncated, diff: lines.join('\n') } };
}

function pageReviewHtml(m) {
  const suggestions = (m.reviewSuggestions || []).filter((item) => !m.reviewDismissed?.has(item.kind + (item.pageId ? ':' + item.pageId : '')));
  if (!suggestions.length) return '';
  return `<div class="page-review__title">Before you save</div>${suggestions.map((item) => {
    const section = SECTIONS.find((s) => s.id === item.section);
    const related = item.kind === 'impact' && m.reviewRelated?.find((p) => p.id === item.pageId);
    const text = item.kind === 'section' && section ? `This page may fit better in ${section.name}.`
      : item.kind === 'unfinished' ? 'Some draft placeholders may still need details.'
      : item.kind === 'unowned' ? 'Some follow-up tasks may need an owner.'
      : related ? 'This change may also need an update in ' : '';
    if (!text) return '';
    return `<div class="page-review__item"><span>${MD.esc(text)}${related ? `<a href="#/page/${encodeURIComponent(related.id)}" target="_blank" rel="noopener" aria-label="${MD.esc(related.title)} (opens in a new tab)">${MD.esc(related.title)}</a>.` : ''}</span>${item.kind === 'section' ? `<button type="button" class="btn btn--sm" data-action="page-review-section" data-section="${MD.esc(section.id)}">Use ${MD.esc(section.name)}</button>` : ''}<button type="button" class="icon-btn" data-action="page-review-dismiss" data-kind="${MD.esc(item.kind + (item.pageId ? ':' + item.pageId : ''))}" aria-label="Dismiss ${item.kind === 'section' ? 'section' : item.kind === 'unfinished' ? 'placeholder' : item.kind === 'impact' ? 'related page' : 'owner'} suggestion">${I.x}</button></div>`;
  }).join('')}`;
}

function paintPageReview(m) {
  const host = $('[data-page-review]');
  if (!host || UI.modal !== m || UI.editor?.saving) return;
  host.innerHTML = pageReviewHtml(m);
  host.hidden = !host.innerHTML;
}

let pageReviewEditor = null;
function cancelPageReview(e) {
  if (!e) return;
  clearTimeout(e.reviewTimer);
  e.reviewTimer = null;
  e.reviewRequest?.controller.abort();
  if (e.reviewRequest && !e.reviewRequest.result) e.reviewRequest = null;
}

function pageReviewInput(e, preview = edChangePreview(e)) {
  const body = e.body.replace(/data:[^\s)"']+/g, '[embedded file]');
  const linked = MD.extractWikiLinks(e.body).map((title) => Store.pageByTitle(title));
  const related = [...new Map([...linked, ...Store.backlinks(e.pageId)].filter((p) => p && p.id !== e.pageId).map((p) => [p.id, p])).values()]
    .slice(0, 8).map((p) => ({ id: p.id, title: p.title, excerpt: MD.mdToText(p.body.replace(/data:[^\s)"']+/g, '[embedded file]')).slice(0, 1000) }));
  return { title: e.title.trim(), section: e.section, truncated: body.length > 18000,
    body: body.length > 18000 ? body.slice(0, 11950) + '\n[Middle of page omitted]\n' + body.slice(-6000) : body,
    diff: preview.input.diff, related };
}

function requestPageReview(e, input) {
  const key = JSON.stringify(input);
  if (e.reviewRequest?.key === key) return e.reviewRequest;
  e.reviewRequest?.controller.abort();
  const request = { key, controller: new AbortController() };
  request.promise = api('/page-review', { method: 'POST', body: key,
    signal: AbortSignal.any([request.controller.signal, AbortSignal.timeout(8000)]) })
    .catch(() => ({ available: false }))
    .then((result) => { request.result = result; return result; });
  return e.reviewRequest = request;
}

function schedulePageReview() {
  const e = UI.editor;
  if (typeof REMOTE === 'undefined' || !e) return;
  cancelPageReview(e);
  e.reviewRequest = null;
  if (!e.title.trim()) return;
  e.reviewTimer = setTimeout(() => {
    e.reviewTimer = null;
    if (UI.editor !== e || UI.modal || document.hidden) return;
    requestPageReview(e, pageReviewInput(e));
  }, 1600);
}

function syncPageReview() {
  if (pageReviewEditor !== UI.editor) cancelPageReview(pageReviewEditor);
  pageReviewEditor = UI.editor;
  const e = UI.editor;
  if (e?.dirty && !UI.modal && !e.reviewRequest && !e.reviewTimer) schedulePageReview();
}

async function loadPageReview(e, m) {
  clearTimeout(e.reviewTimer); e.reviewTimer = null;
  const input = pageReviewInput(e, m.preview);
  m.reviewRelated = input.related;
  const request = requestPageReview(e, input);
  const result = request.result || await request.promise;
  if (UI.modal !== m || UI.editor !== e || e.reviewRequest !== request) return;
  m.reviewSuggestions = result.available && Array.isArray(result.suggestions) ? result.suggestions : [];
  paintPageReview(m);
}

// Generate quietly while editing. A pause groups keystrokes into one edit;
// the interval prevents repeated pauses from billing a request per sentence.
const SUMMARY_IDLE_MS = 1600;
const SUMMARY_INTERVAL_MS = 10000;
let summaryEditor = null;

function changeSummaryKey(preview) {
  const ai = Store.s?.settings?.ai || {};
  return JSON.stringify([preview.input, ai.revision || 0, ai.model, ai.effort, ai.connected]);
}

function cancelChangeSummary(e) {
  if (!e) return;
  clearTimeout(e.summaryTimer);
  e.summaryTimer = null;
  for (const request of e.summaryRequests?.values() || []) {
    if (!request.result) request.controller.abort();
  }
}

function requestChangeSummary(e, preview) {
  const key = changeSummaryKey(preview), now = Date.now();
  e.summaryRequests ||= new Map();
  const cached = e.summaryRequests.get(key);
  if (cached && (!cached.result || cached.result.available || cached.retryAt > now)) return cached;
  const request = { key, controller: new AbortController(),
    title: e.title, body: e.body, section: e.section };
  e.summaryRequest = request;
  e.summaryLastStartedAt = now;
  e.summaryRequests.set(key, request);
  // Keep a few recent drafts for Undo and reopening Save, only in memory.
  while (e.summaryRequests.size > 4) {
    const oldest = [...e.summaryRequests].find(([, item]) => item.result);
    if (!oldest) break;
    e.summaryRequests.delete(oldest[0]);
  }
  request.promise = api('/change-summary', { method: 'POST', body: JSON.stringify(preview.input),
    signal: AbortSignal.any([request.controller.signal, AbortSignal.timeout(28000)]) })
    .catch(() => ({ available: false }))
    .then((result) => {
      request.result = result?.available && typeof result.summary === 'string' && result.summary.trim()
        ? { available: true, summary: result.summary.trim().slice(0, 120) } : { available: false };
      request.retryAt = Date.now() + 30000;
      if (!request.result.available && !request.controller.signal.aborted) e.summaryRetryAt = request.retryAt;
      if (UI.editor === e && !request.controller.signal.aborted
        && (e.title !== request.title || e.body !== request.body || e.section !== request.section)) scheduleChangeSummary(false);
      return request.result;
    });
  return request;
}

function scheduleChangeSummary(edited = true) {
  const e = UI.editor;
  if (!e) return;
  clearTimeout(e.summaryTimer);
  e.summaryTimer = null;
  if (edited) e.summaryEditedAt = Date.now();
  if (typeof REMOTE === 'undefined' || Store.s?.settings?.ai?.connected === false
    || e.saving || e.composing || e.uploads || !e.title.trim() || UI.modal || document.hidden) return;
  const now = Date.now();
  const delay = Math.max(0, SUMMARY_IDLE_MS - (now - (e.summaryEditedAt ?? now)),
    SUMMARY_INTERVAL_MS - (now - (e.summaryLastStartedAt ?? -Infinity)), (e.summaryRetryAt || 0) - now);
  e.summaryTimer = setTimeout(() => {
    e.summaryTimer = null;
    if (UI.editor !== e || e.saving || e.composing || e.uploads || UI.modal || document.hidden
      || !e.title.trim() || Store.s?.settings?.ai?.connected === false) return;
    const preview = edChangePreview(e), key = changeSummaryKey(preview);
    if (!preview.hasChanges || e.summaryRequest?.key === key || e.summaryRequests?.get(key)?.result?.available) return;
    // Let an existing request finish; its completion schedules the latest draft.
    if ([...e.summaryRequests?.values() || []].some((request) => !request.result)) return;
    requestChangeSummary(e, preview);
  }, delay);
}

function syncChangeSummary() {
  if (summaryEditor !== UI.editor) cancelChangeSummary(summaryEditor);
  summaryEditor = UI.editor;
  if (UI.editor?.dirty && !UI.editor.summaryTimer) scheduleChangeSummary(false);
}

async function edSave() {
  const e = UI.editor;
  if (!e || e.saving || UI.modal?.kind === 'save-summary') return;
  if (e.uploads) { toast('Wait for attachments to finish uploading.'); return; }
  if (!e.title.trim()) { toast('Every page needs a title.'); $('[data-ed="title"]')?.focus(); return; }
  const clash = Store.pageByTitle(e.title.trim());
  if (clash && clash.id !== e.pageId && (!e.createRequestId || clash.createRequestId !== e.createRequestId)) { toast(`“${e.title.trim()}” already exists. Titles are how pages link, so they have to be unique.`); return; }
  clearTimeout(e.summaryTimer); e.summaryTimer = null;
  const preview = edChangePreview(e);
  const remote = typeof REMOTE !== 'undefined' && preview.hasChanges;
  const request = remote && Store.s?.settings?.ai?.connected !== false ? requestChangeSummary(e, preview) : null;
  const m = { kind: 'save-summary', preview, summary: '',
    suggestedSummary: request?.result?.available ? request.result.summary : preview.fallback,
    loading: Boolean(request && !request.result), summaryEdited: false };
  showModal(m);
  if (remote) loadPageReview(e, m);
  if (!m.loading) return;
  const result = await request.promise;
  if (UI.modal !== m || UI.editor !== e || e.saving || changeSummaryKey(edChangePreview(e)) !== request.key) return;
  m.loading = false;
  if (result.available) m.suggestedSummary = result.summary;
  // Update only the placeholder: no remount, focus change, or save gating.
  const field = $('.modal [data-m="summary"]');
  if (field) field.placeholder = m.suggestedSummary;
}

function edSummaryValue(value, m = UI.modal) {
  return String(value || '').trim() || m?.suggestedSummary || m?.preview?.fallback || 'Edited';
}

function setEditorSaving(e, saving) {
  e.saving = saving;
  if (saving) {
    if (UI.modal?.kind === 'save-summary') UI.modal.error = null;
    const status = $('.save-summary__status');
    if (status) { status.textContent = ''; status.hidden = true; }
    e.savingControls = $$('.editor button, .editor input, .editor textarea, .modal button, .modal input')
      .map((control) => ({ control, disabled: control.disabled }));
    for (const { control } of e.savingControls) control.disabled = true;
    const button = $('.modal [data-action="save-commit"]');
    if (button) { e.saveButtonLabel = button.textContent; button.textContent = 'Saving…'; }
  } else {
    for (const { control, disabled } of e.savingControls || []) control.disabled = disabled;
    e.savingControls = null;
    const button = $('.modal [data-action="save-commit"]');
    if (button && e.saveButtonLabel) button.textContent = e.saveButtonLabel;
  }
  $('.editor')?.setAttribute('aria-busy', String(saving));
  $('.modal')?.setAttribute('aria-busy', String(saving));
}

async function edCommit(summary) {
  const e = UI.editor;
  if (!e || e.saving) return;
  if (e.uploads) { toast('Wait for attachments to finish uploading.'); return; }
  if (e.body.length > 2 * 1024 * 1024) { toast('That page is over the 2 MB text limit. Attach big content as files instead.'); return; }
  // Someone else (or another tab) may have changed the page while this editor
  // was open. An explicit overwrite acknowledges only the displayed revision;
  // another intervening save must still get a fresh conflict check.
  if (!e.isNew) {
    const cur = Store.page(e.pageId);
    if (cur && e.confirmedBaseUpdated !== cur.updated &&
      (cur.body !== e.origBody || cur.title !== e.origTitle || cur.section !== e.origSection)) {
      const m = {
        kind: 'conflict', pageId: e.pageId,
        text: `<b>${MD.esc(Store.userName(cur.updatedBy))}</b> saved a newer version ${relTime(cur.updated)}. Saving now replaces their text with yours. Their version stays in History.`,
      };
      m.onGo = () => { if (UI.editor === e) { e.confirmedBaseUpdated = cur.updated; edCommit(summary); } };
      showModal(m);
      return;
    }
  }
  const create = e.isNew || !Store.page(e.pageId);
  if (create && typeof REMOTE !== 'undefined') {
    const prior = e.createRequestDraft;
    if (!e.createRequestId || !prior || prior.title.trim() !== e.title.trim() || prior.body !== e.body || prior.section !== e.section) {
      e.createRequestId = uid('page');
      e.createRequestDraft = { title: e.title, body: e.body, section: e.section };
    }
  }
  const draft = keepEditorDraft(e);
  setEditorSaving(e, true);
  try {
    const values = { title: e.title.trim(), section: e.section, parent: e.parent, body: e.body, summary };
    const p = await (create ? Store.createPage({ ...values, ...(e.createRequestId ? { requestId: e.createRequestId } : {}) })
      : Store.savePage(e.pageId, { ...values, baseUpdated: e.confirmedBaseUpdated ?? e.baseUpdated }));
    if (!p) throw new Error('The page was not saved. Your draft is still available.');
    if (typeof REMOTE === 'undefined' && Store.lastPersistOk === false) throw new Error('This browser is out of storage. Your draft is still open.');
    const key = e.pageId || 'new';
    const currentDraft = draftStash.get(key);
    if (currentDraft === draft || (currentDraft?.body === draft.body && currentDraft?.title === draft.title && currentDraft?.section === draft.section)) {
      draftStash.delete(key);
      draftDeleted.add(key);
      persistDrafts();
    }
    setEditorSaving(e, false);
    toast(create ? (e.isNew ? 'Page created' : 'Saved as a new page because the original was deleted') : 'Saved');
    if (UI.editor !== e) { if (typeof paintRemoteUpdate === 'function') paintRemoteUpdate(); return; }
    UI.editor = null;
    UI.modal = null;
    nav('#/page/' + p.id);
    route();
    render();
  } catch (err) {
    setEditorSaving(e, false);
    e.confirmedBaseUpdated = null;
    if (UI.editor === e) keepEditorDraft(e);
    const message = err.status === 400 || err.status === 503 ? err.message : 'Could not save. Your draft is kept; check your connection and retry.';
    if (UI.editor === e && UI.modal?.kind === 'save-summary') UI.modal.error = message;
    const status = UI.editor === e && $('.save-summary__status');
    if (status) { status.textContent = message; status.hidden = false; }
    toast(message, { label: 'Open draft', run: () => { if (UI.editor !== e) nav(e.pageId ? '#/edit/' + e.pageId : '#/new'); } });
  }
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
    </div>
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
  return topbar(`<a href="#/home">Wiki</a><span class="crumbs__sep">/</span><span class="crumbs__here">Activity</span>`) + `
  <div class="content"><div class="page-wrap"><div class="page-col">
    <div class="plain-head"><h1>Activity</h1></div>
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
   any page can link it with [Applications](#/applications). */

const INTEREST_ICONS = {
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 22V3m0 1c5-4 11 4 16 0v12c-5 4-11-4-16 0"/></svg>',
  comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 2V11.5A8.5 8.5 0 0 1 9.5 3h3a8.5 8.5 0 0 1 8.5 8.5Z"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m-5-5 5 5 5-5"/><path d="M21 21H3"/></svg>',
};

// 8/28/26 — short, sortable-looking, and unambiguous next to a full title.
const interestDate = (ts) =>
  new Date(ts).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });

const interestSource = () => UI.interestArchiveView?.archive?.rows || UI.interest?.rows || [];
const interestYears = ['Freshman', 'Sophomore', 'Junior', 'Senior', 'Grad'];

// Selections belong to one list and survive filtering, sorting, and refresh.
// Prune stale IDs so removed submissions can never be copied accidentally.
function interestSelection() {
  const scope = UI.interestArchiveView?.id || 'live';
  if (UI.interestSelectionScope !== scope) {
    UI.interestSelectionScope = scope;
    UI.interestSelected = new Set();
  }
  const ids = new Set(interestSource().map((r) => r.id));
  for (const id of UI.interestSelected) if (!ids.has(id)) UI.interestSelected.delete(id);
  return UI.interestSelected;
}

function interestSelectedEmails() {
  const selected = interestSelection();
  return [...new Set(interestSource().filter((r) => selected.has(r.id))
    .map((r) => String(r.email || '').trim()).filter(Boolean))];
}

function interestEmailsCsv(emails) {
  return emails.map((email) => /[",\r\n]/.test(email) ? '"' + email.replace(/"/g, '""') + '"' : email).join(',');
}

function renderInterestSelection() {
  const selected = interestSelection();
  const visible = interestVisible();
  const visibleSelected = visible.filter((r) => selected.has(r.id)).length;
  const all = $('[data-action="interest-select-visible"]');
  if (all) {
    all.checked = visible.length > 0 && visibleSelected === visible.length;
    all.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
    all.disabled = !visible.length;
  }
  for (const input of $$('[data-action="interest-select"]')) {
    input.checked = selected.has(input.dataset.id);
    input.closest('tr').classList.toggle('is-selected', input.checked);
  }
  const count = $('[data-interest-selection-count]');
  const hidden = selected.size - visibleSelected;
  if (count) count.textContent = `${selected.size} selected${hidden ? ` · ${hidden} hidden by filter` : ''}`;
  const active = document.activeElement;
  for (const group of $$('[data-interest-tools]')) group.hidden = Boolean(selected.size);
  for (const group of $$('[data-interest-selection]')) group.hidden = !selected.size;
  if (active?.closest('[hidden]')) $('[data-m="interest-q"]')?.focus();
}

// Filter and sort live in the UI only: the endpoint always returns the whole
// list, so a huge roster stays one fetch and every view of it is instant.
function interestFilterOptions() {
  const teams = [...new Set(interestSource().map((r) => String(r.subteam || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return [
    { group: 'review', value: 'all', label: 'All people' },
    { group: 'review', value: 'flagged', label: 'Flagged' },
    { group: 'review', value: 'comments', label: 'With comments' },
    '-',
    { group: 'subteam', value: '', label: 'All subteams' },
    ...teams.map((value) => ({ group: 'subteam', value, label: value })),
    ...(interestSource().some((r) => !String(r.subteam || '').trim()) ? [{ group: 'subteam', value: '__undecided', label: 'Undecided' }] : []),
  ];
}

function interestFilterLabel() {
  const review = UI.interestFilter === 'flagged' ? 'Flagged' : UI.interestFilter === 'comments' ? 'With comments' : '';
  const team = UI.interestSubteam === '__undecided' ? 'Undecided' : UI.interestSubteam || '';
  return [review, team].filter(Boolean).join(' · ') || 'All people';
}

function openInterestFilter(host) {
  openMenu(interestFilterOptions().map((option) => {
    if (option === '-') return option;
    const selected = option.group === 'review' ? option.value === (UI.interestFilter || 'all') : option.value === (UI.interestSubteam || '');
    return { label: option.label, selected, icon: selected ? I.check : '<span style="width:14px;flex:none"></span>', run: () => {
      if (option.group === 'review') UI.interestFilter = option.value;
      else UI.interestSubteam = option.value;
      host.querySelector('.dd__label').textContent = interestFilterLabel();
      renderInterestRows();
    } };
  }), host);
}

function interestVisible() {
  const rows = interestSource().filter((r) => {
    if (UI.interestFilter === 'flagged' && !r.review?.flagged) return false;
    if (UI.interestFilter === 'comments' && !r.review?.comments?.length) return false;
    if (!UI.interestSubteam) return true;
    const team = String(r.subteam || '').trim();
    return UI.interestSubteam === '__undecided' ? !team : team === UI.interestSubteam;
  });
  const q = (UI.interestQuery || '').trim().toLowerCase();
  const filtered = q
    ? rows.filter((r) => `${r.name} ${r.email} ${r.subteam || ''} ${r.project || ''} ${r.year || 'Not provided'}`.toLowerCase().includes(q))
    : rows;
  const { key, dir } = UI.interestSort || { key: 'ts', dir: 'desc' };
  const val = (r) => {
    if (key === 'name') return r.name.toLowerCase();
    if (key === 'subteam') return (r.subteam || '~').toLowerCase(); // blanks sort last
    if (key === 'year') return interestYears.indexOf(r.year);
    return r.ts;
  };
  const sorted = [...filtered].sort((a, b) => {
    if (key === 'year' && Boolean(a.year) !== Boolean(b.year)) return a.year ? -1 : 1;
    const x = val(a);
    const y = val(b);
    if (x === y) return b.ts - a.ts;
    return (x > y ? 1 : -1) * (dir === 'asc' ? 1 : -1);
  });
  return sorted;
}

// Compact columns, every cell clipping to the same rhythm. The
// full answer, the file, and the thread live in the row's detail view.
function interestFlagButton(r, { detail = false, archived = false } = {}) {
  const flagged = Boolean(r.review?.flagged);
  const label = `${flagged ? 'Unflag' : 'Flag'} ${r.name}`;
  if (archived) return flagged ? `<span class="interest-flag-readonly" title="Flagged">${INTEREST_ICONS.flag}${detail ? 'Flagged' : ''}</span>` : '';
  return `<button class="${detail ? 'btn interest-detail-flag' : 'icon-btn'} interest-flag ${flagged ? 'is-flagged' : ''}" data-action="interest-flag" data-id="${MD.esc(r.id)}" aria-pressed="${flagged}" aria-label="${MD.esc(label)}" title="${MD.esc(label)}" aria-disabled="${Boolean(UI.interestFlagBusy?.has(r.id))}">${INTEREST_ICONS.flag}${detail ? `<span>${flagged ? 'Flagged' : 'Flag'}</span>` : ''}</button>`;
}

function interestRowsHtml(rows) {
  if (!rows.length) return `<tr class="sheet__empty"><td colspan="6">${interestSource().length ? 'No people match these filters.' : 'No submissions yet.'}</td></tr>`;
  const selected = interestSelection();
  const archived = Boolean(UI.interestArchiveView);
  return rows.map((r) => {
    const comments = r.review?.comments?.length || 0;
    return `<tr data-id="${MD.esc(r.id)}" class="${selected.has(r.id) ? 'is-selected' : ''}">
      <td class="sheet__check-cell"><label class="sheet__check"><input type="checkbox" data-action="interest-select" data-id="${MD.esc(r.id)}" aria-label="Select ${MD.esc(r.name)} (${MD.esc(r.email)})" ${selected.has(r.id) ? 'checked' : ''}></label></td>
      <td><button class="interest-person" data-action="interest-open" data-id="${MD.esc(r.id)}" aria-label="Open ${MD.esc(r.name)}"><b>${MD.esc(r.name)}</b><span class="mail">${MD.esc(r.email)}</span></button></td>
      <td>${r.year ? MD.esc(r.year) : '<span class="faint">—</span>'}</td>
      <td>${MD.esc(r.subteam || 'Undecided')}</td>
      <td class="interest-when" title="${MD.esc(new Date(r.ts).toLocaleString())}">${interestDate(r.ts)}</td>
      <td class="sheet__review-cell"><div class="interest-row-actions">
        ${interestFlagButton(r, { archived })}
        <button class="icon-btn interest-comments ${comments ? 'has-comments' : ''}" data-action="interest-open" data-id="${MD.esc(r.id)}" data-comments="true" aria-label="${comments ? `${comments} ${comments === 1 ? 'comment' : 'comments'} on` : 'Comment on'} ${MD.esc(r.name)}" title="${comments ? `${comments} ${comments === 1 ? 'comment' : 'comments'}` : 'Add comment'}">${INTEREST_ICONS.comment}${comments ? `<span>${comments}</span>` : ''}</button>
        ${archived ? '' : `<button class="icon-btn interest-delete" data-action="interest-remove" data-id="${MD.esc(r.id)}" aria-label="Delete ${MD.esc(r.name)}" title="Delete submission">${I.trash}</button>`}
      </div></td>
    </tr>`;
  }).join('');
}

// Filtering re-renders only the body, so the search box keeps its caret.
function renderInterestRows(updatedId) {
  const body = $('.sheet tbody');
  if (!body) return;
  const rows = interestVisible();
  const focus = focusReference(document.activeElement);
  const hadFocus = body.contains(document.activeElement);
  const currentRows = [...body.children];
  const sameOrder = currentRows.length === rows.length && currentRows.every((el, i) => el.dataset.id === rows[i].id);
  if (updatedId && sameOrder) {
    const index = rows.findIndex((r) => r.id === updatedId);
    if (index >= 0) {
      const fragment = document.createElement('tbody');
      fragment.innerHTML = interestRowsHtml([rows[index]]);
      // The applicant, checkbox, and every other row keep their DOM identity.
      $('.sheet__review-cell', currentRows[index]).innerHTML = $('.sheet__review-cell', fragment).innerHTML;
    }
  } else body.innerHTML = interestRowsHtml(rows);
  if (hadFocus) (resolveFocus(focus, body) || $('[data-m="interest-q"]'))?.focus({ preventScroll: true });
  const foot = $('.sheet__foot');
  if (foot) foot.textContent = interestFootText(rows.length);
  renderInterestSelection();
}

function interestFootText(shown) {
  const total = (UI.interestArchiveView?.archive?.rows || UI.interest?.rows || []).length;
  const noun = shown === 1 ? 'person' : 'people';
  return shown === total
    ? `${total} ${noun} on the list`
    : `${shown} of ${total} shown`;
}

function interestPendingReview() {
  return Store.isAdmin() && Array.isArray(UI.interest?.pendingReview) ? UI.interest.pendingReview : [];
}

function interestPendingReason(reason) {
  if (reason === 'duplicate') return 'Existing submission needs review';
  if (reason === 'capacity') return 'Live list is full';
  if (reason === 'replay_failed') return 'Could not add to the list yet';
  return 'Waiting to join the list';
}

function interestPendingHtml() {
  if (!Store.isAdmin()) return '';
  const pending = interestPendingReview();
  const unavailable = UI.interest?.queueUnavailable
    ? `<p class="sheet__note" role="status">Could not check for saved submissions waiting to join the list. <button class="linklike" data-action="interest-refresh">Retry</button></p>`
    : '';
  if (!pending.length) return unavailable;
  return `<section aria-labelledby="interest-pending-heading">
    <h2 class="sheet__heading" id="interest-pending-heading">Saved submissions awaiting review <span class="count" style="font-variant-numeric:tabular-nums">${pending.length}</span></h2>
    <p class="sheet__note">These responses are saved separately and are not included in the live list or its CSV.</p>
    ${unavailable}
    <div class="sheet sheet--list">
      ${pending.map((r) => `<div class="sheet__archive" style="height:auto;min-height:60px;flex-wrap:wrap;padding-top:4px;padding-bottom:4px">
        <button class="interest-person" style="flex:1 1 180px" data-action="interest-pending-open" data-id="${MD.esc(r.id)}" aria-label="Review saved submission from ${MD.esc(r.name)}">
          <b>${MD.esc(r.name)}</b><span class="mail">${MD.esc(r.email)}</span>
        </button>
        <span class="sheet__archivemeta" style="flex:1 1 180px">${interestPendingReason(r.reason)}</span>
        <span class="interest-when" title="${MD.esc(new Date(r.receivedAt).toLocaleString())}">${interestDate(r.receivedAt)}</span>
      </div>`).join('')}
    </div>
  </section>`;
}

function interestPendingModalHtml(id) {
  const r = interestPendingReview().find((row) => row.id === id);
  if (!r) return '';
  // Only link the authenticated attachment route, never an arbitrary URL
  // carried in a submission's payload.
  const fileUrl = `/api/interest/queue/${encodeURIComponent(r.id)}/file`;
  return `<div class="modal modal--wide" role="dialog" aria-label="Saved submission">
    <div class="modal__head"><h3>${MD.esc(r.name)}</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body">
      <p class="sheet__note">${r.reason === 'duplicate'
        ? 'This response is saved, but the same email already has a submission. The existing response has not been changed.'
        : r.reason === 'capacity'
          ? 'The live list is full. Review this application separately.'
          : 'This response is saved separately and has not yet joined the live list. Refresh the list to retry syncing.'}</p>
      <dl class="interest-detail">
        <dt>Status</dt><dd>${interestPendingReason(r.reason)}</dd>
        <dt>Email</dt><dd>${MD.esc(r.email)}</dd>
        <dt>Subteam</dt><dd>${MD.esc(r.subteam || 'Not sure yet')}</dd>
        <dt>Year</dt><dd>${MD.esc(r.year || 'Not provided')}</dd>
        <dt>Received</dt><dd>${MD.esc(new Date(r.receivedAt).toLocaleString())}</dd>
        <dt>Receipt</dt><dd>${MD.esc(r.id)}</dd>
        ${r.fileName ? `<dt>File</dt><dd>${r.fileUrl
          ? `<a class="interest-download" href="${MD.esc(fileUrl)}" download="${MD.esc(r.fileName)}">${MD.esc(r.fileName)}</a>`
          : MD.esc(r.fileName)} <span class="faint">${Math.max(1, Math.round((r.fileSize || 0) / 1024))} KB</span></dd>` : ''}
      </dl>
      <h4 class="interest-subhead">Coolest project they've done</h4>
      <p class="interest-project">${r.project ? MD.esc(r.project) : '<span class="faint">They left this blank.</span>'}</p>
    </div>
    <div class="modal__foot"><button class="btn btn--primary" data-action="modal-close">Close</button></div>
  </div>`;
}

function viewInterest() {
  const shell = (inner) => topbar(`<a href="#/home">Wiki</a><span class="crumbs__sep">/</span><span class="crumbs__here">Applications</span>`) +
    `<div class="content"><div class="page-wrap page-wrap--wide"><div class="page-col page-col--wide">${inner}</div></div></div>`;
  if (!Store.isAdmin()) {
    return shell(`<div class="empty">${I.mail}<b>Only admins can read applications</b>
      <p>Apply-page submissions carry personal info, so they stay with team leads.</p>
      <a class="btn" href="#/home" style="text-decoration:none">Back to the wiki</a></div>`);
  }
  if (typeof REMOTE === 'undefined') {
    return shell(`<div class="empty">${I.mail}<b>Live on the deployed wiki</b>
      <p>This preview has no server. The real wiki lists Apply-page submissions here, with CSV download.</p></div>`);
  }
  /* ---- viewing a past cycle ---- */
  const av = UI.interestArchiveView;
  if (av) {
    const back = `<button class="sheet__back" data-action="interest-archive-back">← Back to the live list</button>`;
    if (av.loading) return shell(back + '<p class="sheet__note">Loading archive…</p>');
    if (av.error || !av.archive) return shell(back + '<p class="sheet__note">Could not open that archive.</p>');
    const a = av.archive;
    const ahead = `${back}<div class="plain-head"><h1>${MD.esc(a.name)} <span class="sheet__archivedtag">[archived ${interestDate(a.ts)}]</span></h1>
      <p>Read-only snapshot, including comments and flags.</p></div>`;
    const actions = `<a class="btn btn--sm btn--icon" href="/api/interest/archives/${MD.esc(a.id)}.csv" download>Download CSV${INTEREST_ICONS.download}</a>
      <button class="btn btn--sm btn--danger" data-action="interest-archive-remove" data-id="${MD.esc(a.id)}" data-name="${MD.esc(a.name)}">Delete archive…</button>`;
    return shell(ahead + interestSheet(interestVisible(), { archived: true, actions }));
  }

  const st = UI.interest || { loading: true };
  const archives = UI.interestArchives?.list || [];
  const archivesBlock = archives.length ? `
    <h2 class="sheet__heading">Archives</h2>
    <div class="sheet sheet--list">
      ${archives.map((a) => `<div class="sheet__archive">
        <button class="sheet__archivename" data-action="interest-archive-open" data-id="${MD.esc(a.id)}"><span class="sheet__archivetitle">${MD.esc(a.name)}</span>
          <span class="sheet__archivemeta">${a.count} ${a.count === 1 ? 'person' : 'people'} · archived ${interestDate(a.ts)}</span></button>
        <a class="btn btn--sm btn--icon" href="/api/interest/archives/${MD.esc(a.id)}.csv" download>CSV${INTEREST_ICONS.download}</a>
      </div>`).join('')}
    </div>` : '';
  const head = `<div class="plain-head"><h1>Applications</h1>
    </div>`;
  if (st.loading) return shell(head + '<p class="sheet__note">Loading…</p>');
  if (st.error) return shell(head + `<p class="sheet__note">Could not load: ${MD.esc(st.error)}. <button class="linklike" data-action="interest-refresh">Retry</button></p>`);
  const pendingBlock = interestPendingHtml();
  return shell(head + interestSheet(interestVisible()) + pendingBlock + archivesBlock);
}

function interestSheet(visible, { archived = false, actions = '' } = {}) {
  const sort = UI.interestSort || { key: 'ts', dir: 'desc' };
  const selected = interestSelection();
  const visibleSelected = visible.filter((r) => selected.has(r.id)).length;
  const th = (key, label) =>
    `<th aria-sort="${sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button class="sheet__sort ${sort.key === key ? 'on' : ''}" data-action="interest-sort" data-key="${key}">${label}<span class="sheet__caret">${sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : ''}</span></button></th>`;
  const filters = [{ value: 'combined', label: interestFilterLabel() }];
  return `<div class="sheet ${archived ? 'sheet--archived' : ''}">
    <div class="sheet__bar">
      <div class="sheet__search-wrap">${I.search}<input class="text-input sheet__search" data-m="interest-q" type="search" placeholder="Search people…" value="${MD.esc(UI.interestQuery || '')}" aria-label="Search by name, email, year, subteam, or project" autocomplete="off" spellcheck="false"></div>
      <div class="sheet__actions" data-interest-tools ${selected.size ? 'hidden' : ''}>
        ${dd('interest-filter', filters, 'combined')}
        ${archived ? actions : `<a class="btn btn--sm" href="/api/interest.csv" download>${INTEREST_ICONS.download} Export</a><button class="icon-btn" data-action="interest-tools" aria-label="List options" title="List options" aria-haspopup="menu">${I.dots}</button>`}
      </div>
      <div class="sheet__actions sheet__selection" data-interest-selection ${selected.size ? '' : 'hidden'}>
        <span data-interest-selection-count role="status"></span>
        <button class="btn btn--sm" data-action="interest-copy-emails">${I.copy} Copy emails</button>
        ${archived ? '' : `<button class="btn btn--sm btn--danger" data-action="interest-remove-selected">${I.trash} Delete</button>`}
        <button class="icon-btn" data-action="interest-clear-selection" aria-label="Clear selection" title="Clear selection">${I.x}</button>
      </div>
    </div>
    <div class="sheet__scroll"><table aria-label="${archived ? 'Archived' : 'Current'} interest submissions">
      <thead><tr>
        <th class="sheet__check-cell"><label class="sheet__check"><input type="checkbox" data-action="interest-select-visible" aria-label="Select all visible people" ${visible.length && visibleSelected === visible.length ? 'checked' : ''} ${visible.length ? '' : 'disabled'}></label></th>
        ${th('name', 'Person')}${th('year', 'Year')}${th('subteam', 'Subteam')}${th('ts', 'Received')}
        <th class="sheet__review-cell"><span class="sheet__sort sheet__sort--static">Review</span></th>
      </tr></thead>
      <tbody>${interestRowsHtml(visible)}</tbody>
    </table></div>
    <div class="sheet__foot" role="status">${interestFootText(visible.length)}</div>
  </div>`;
}

function interestDraft(id) {
  UI.interestDrafts ||= {};
  return UI.interestDrafts[id] ||= { text: '', id: null, sending: false, error: '' };
}

function interestCommentHtml(c, id = UI.modal?.id, archived = Boolean(UI.interestArchiveView)) {
  const removable = !archived && Store.isAdmin();
  const removal = UI.interestCommentRemovals?.[id + '/' + c.id];
  return `<article class="interest-comment" data-comment-id="${MD.esc(c.id)}"><div class="interest-comment__meta"><b>${MD.esc(c.name || c.by || 'Admin')}</b><time title="${MD.esc(new Date(c.ts).toLocaleString())}" datetime="${new Date(c.ts).toISOString()}">${interestDate(c.ts)}</time>${removable ? `<button type="button" class="btn btn--ghost btn--sm interest-comment__delete" data-action="interest-comment-delete" data-id="${MD.esc(id)}" data-cid="${MD.esc(c.id)}" aria-label="Delete comment by ${MD.esc(c.name || c.by || 'admin')}" ${removal?.confirming ? 'disabled' : ''}>Delete</button>` : ''}</div><p>${MD.esc(c.text)}</p>${removable ? `<div data-comment-controls>${interestCommentDeleteHtml(id, c.id)}</div>` : ''}</article>`;
}

function interestCommentDeleteHtml(id, commentId) {
  const removal = UI.interestCommentRemovals?.[id + '/' + commentId];
  if (!removal?.confirming) return '';
  return `<div class="interest-comment__confirm" role="group" aria-label="Delete comment confirmation"><span>Delete this comment?</span><button type="button" class="btn btn--sm" data-action="interest-comment-delete-cancel" data-id="${MD.esc(id)}" data-cid="${MD.esc(commentId)}" ${removal.busy ? 'disabled' : ''}>Cancel</button><button type="button" class="btn btn--sm btn--danger" data-action="interest-comment-delete-confirm" data-id="${MD.esc(id)}" data-cid="${MD.esc(commentId)}" ${removal.busy ? 'disabled' : ''}>${removal.busy ? 'Deleting…' : 'Delete'}</button></div>${removal.error ? `<p class="field-error" role="alert">${MD.esc(removal.error)}</p>` : ''}`;
}

// Update a discussion without remounting its dialog, backdrop or composer.
// Existing comment nodes stay put; only removed comments and changed controls
// are touched. The author's unsent composer is never replaced.
function paintInterestDiscussion(id, { posted = false } = {}) {
  if (UI.modal?.kind !== 'interest-row' || UI.modal.id !== id) return;
  const dialog = $('.interest-review'), draft = interestDraft(id);
  const row = interestSource().find((r) => r.id === id);
  if (!dialog || !row) return;
  const thread = $('.interest-thread', dialog), field = $('.interest-compose textarea', dialog);
  const button = $('.interest-compose [type="submit"]', dialog), error = $('[data-comment-error]', dialog);
  const scroller = $('.interest-review__body', dialog);
  const scrollTop = scroller.scrollTop;
  const followBottom = scroller.scrollHeight - scroller.clientHeight - scrollTop < 32;
  const comments = row.review?.comments || [];
  const nodes = $$('[data-comment-id]', thread);
  const active = document.activeElement;
  const removed = nodes.filter((node) => !comments.some((c) => c.id === node.dataset.commentId));
  const restoreAfterRemoval = removed.some((node) => node.contains?.(active));
  const anchor = scroller.getBoundingClientRect && nodes.find((node) => !removed.includes(node) && node.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top);
  const anchorTop = anchor?.getBoundingClientRect().top;
  removed.forEach((node) => node.remove());
  const existing = new Set(nodes.filter((node) => !removed.includes(node)).map((el) => el.dataset.commentId));
  const added = comments.filter((c) => !existing.has(c.id));
  if (added.length) {
    $('.interest-thread__empty', thread)?.remove();
    thread.insertAdjacentHTML('beforeend', added.map((c) => interestCommentHtml(c, id)).join(''));
  }
  if (!comments.length && !$('.interest-thread__empty', thread)) thread.insertAdjacentHTML('beforeend', '<p class="interest-thread__empty">No comments yet.</p>');
  for (const node of $$('[data-comment-id]', thread)) {
    const commentId = node.dataset.commentId, controls = $('[data-comment-controls]', node);
    const removal = UI.interestCommentRemovals?.[id + '/' + commentId];
    const trigger = $('[data-action="interest-comment-delete"]', node);
    if (trigger) trigger.disabled = Boolean(removal?.confirming);
    const key = JSON.stringify([!!removal?.confirming, !!removal?.busy, removal?.error || '']);
    if (controls && controls._stateKey !== key) {
      const action = controls.contains(document.activeElement) ? document.activeElement.dataset.action : null;
      controls.innerHTML = interestCommentDeleteHtml(id, commentId);
      controls._stateKey = key;
      if (action && !removal?.busy) $(`[data-action="${action}"]`, controls)?.focus({ preventScroll: true });
    }
  }
  $('.interest-subhead .count', dialog).textContent = comments.length;
  if (field) {
    field.readOnly = draft.sending;
    if (posted) field.value = '';
  }
  if (button) {
    button.disabled = draft.sending || !draft.text.trim();
    button.textContent = draft.sending ? 'Posting…' : 'Post comment';
  }
  if (error) { error.textContent = draft.error || ''; error.hidden = !draft.error; }
  // Keep the reader's location; follow a new reply only when already at bottom.
  scroller.scrollTop = posted && followBottom ? scroller.scrollHeight : scrollTop + (anchor?.isConnected ? anchor.getBoundingClientRect().top - anchorTop : 0);
  if (restoreAfterRemoval) ($('[data-action="interest-comment-delete"]', thread) || field)?.focus({ preventScroll: true });
  if (posted && (document.activeElement === document.body || document.activeElement === button || document.activeElement === field)) field?.focus({ preventScroll: true });
}

function interestRowModalHtml(id) {
  const r = interestSource().find((row) => row.id === id);
  if (!r) return `<div class="modal" role="dialog" aria-label="Submission unavailable"><div class="modal__head"><h3>Submission unavailable</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div><div class="modal__body"><p>This submission was removed or archived. Close this window to refresh the list.</p></div></div>`;
  const archived = Boolean(UI.interestArchiveView);
  const comments = r.review?.comments || [];
  const draft = interestDraft(id);
  return `<div class="modal modal--wide interest-review" role="dialog" aria-label="Review ${MD.esc(r.name)}">
    <div class="modal__head">
      <div class="interest-review__identity"><h3>${MD.esc(r.name)}</h3><span>${MD.esc(r.email)}</span></div>
      ${interestFlagButton(r, { detail: true, archived })}
      <button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button>
    </div>
    <div class="modal__body interest-review__body">
      <section class="interest-application" aria-label="Application">
        <h4 class="interest-subhead">Application</h4>
        <dl class="interest-detail">
          <dt>Subteam</dt><dd>${MD.esc(r.subteam || 'Undecided')}</dd>
          <dt>Year</dt><dd>${MD.esc(r.year || 'Not provided')}</dd>
          <dt>Received</dt><dd>${interestDate(r.ts)}</dd>
          ${r.updated && r.updated !== r.ts ? `<dt>Updated</dt><dd>${interestDate(r.updated)}</dd>` : ''}
        </dl>
        <h4 class="interest-subhead">Coolest project</h4>
        <p class="interest-project">${r.project ? MD.esc(r.project) : '<span class="faint">No project provided.</span>'}</p>
        ${r.fileId ? `<a class="interest-attachment" href="/api/interest/file/${MD.esc(r.fileId)}" download="${MD.esc(r.fileName || 'file')}">${INTEREST_ICONS.download}<span>${MD.esc(r.fileName || 'Attachment')}<small>${Math.max(1, Math.round((r.fileSize || 0) / 1024))} KB</small></span></a>` : ''}
      </section>
      <section class="interest-discussion" aria-labelledby="interest-comments-heading">
        <h4 class="interest-subhead" id="interest-comments-heading">Comments <span class="count">${comments.length}</span><span class="interest-private">Admins only</span></h4>
        <div class="interest-thread" role="log" aria-label="Comments" aria-live="polite" aria-relevant="additions removals">${comments.length ? comments.map((c) => interestCommentHtml(c, id, archived)).join('') : '<p class="interest-thread__empty">No comments yet.</p>'}</div>
        ${archived ? '<p class="interest-readonly">Archived · Read only</p>' : `<form class="interest-compose" data-action="interest-comment-form" data-id="${MD.esc(id)}">
          <textarea class="text-input" data-m="interest-comment" data-id="${MD.esc(id)}" aria-label="Comment on ${MD.esc(r.name)}" placeholder="Add a comment…" rows="3" maxlength="4000" required ${draft.sending ? 'readonly' : ''}>${MD.esc(draft.text)}</textarea>
          <p class="field-error" data-comment-error role="alert" ${draft.error ? '' : 'hidden'}>${MD.esc(draft.error || '')}</p>
          <div class="interest-compose__foot"><button type="submit" class="btn btn--primary" ${draft.sending || !draft.text.trim() ? 'disabled' : ''}>${draft.sending ? 'Posting…' : 'Post comment'}</button></div>
        </form>`}
      </section>
    </div>
  </div>`;
}

function memberListUsers() {
  const words = (UI.memberQuery || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return Store.s.users.filter((u) => u.status === 'active' || u.status === 'invited')
    .filter((u) => words.every((word) => `${u.name || ''} ${u.email} ${u.subteam || ''} ${u.role} ${u.status}`.toLowerCase().includes(word)))
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, undefined, { sensitivity: 'base' }) || a.email.localeCompare(b.email));
}

function memberRowsHtml(users) {
  if (!users.length) return '<tr class="member-empty"><td colspan="5">No people match this search.</td></tr>';
  const me = Store.me();
  return users.map((u) => {
    const invited = u.status === 'invited', name = u.name || u.email.split('@')[0];
    const ts = invited ? u.invitedAt : u.joined;
    const roleAction = u.role === 'admin' ? 'Make member' : 'Make admin';
    const pending = UI.memberPending?.has(u.email);
    const dateLabel = ts ? `${invited ? 'Added' : 'Joined'} ${new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : '';
    return `<tr data-member-email="${MD.esc(u.email)}" aria-busy="${Boolean(pending)}">
      <td class="member-person"><span class="member-name"><b>${MD.esc(name)}</b>${invited ? '<span class="member-invited">Invited</span>' : ''}</span><span class="member-email">${MD.esc(u.email)}</span></td>
      <td class="member-subteam">${MD.esc(u.subteam || '—')}</td>
      <td class="member-role">${u.role === 'admin' ? 'Admin' : 'Member'}</td>
      <td class="member-date" title="${MD.esc(dateLabel + (invited && u.invitedBy ? ' by ' + Store.userName(u.invitedBy) : ''))}">${ts ? `${invited ? '<span class="member-date-label">Added </span>' : ''}${interestDate(ts)}` : '—'}</td>
      <td class="member-controls"><div class="member-actions">${u.email === me.email ? '<span class="member-you">You</span>' : `
        ${invited && typeof REMOTE === 'undefined' ? `<button class="icon-btn" data-action="invite-view" data-email="${MD.esc(u.email)}" aria-label="View invitation for ${MD.esc(name)}" title="View invitation">${I.mail}</button>` : ''}
        <button class="member-role-change" data-action="role-toggle" data-email="${MD.esc(u.email)}" aria-label="${MD.esc(roleAction + ': ' + name)}" title="${roleAction}"${pending ? ' disabled' : ''}>${roleAction}</button>
        <button class="icon-btn member-remove" data-action="user-remove" data-email="${MD.esc(u.email)}" aria-label="Remove ${MD.esc(name)}" title="Remove member"${pending ? ' disabled' : ''}>${I.trash}</button>`}</div></td>
    </tr>`;
  }).join('');
}

function memberCountText(shown) {
  const total = Store.s.users.filter((u) => u.status === 'active' || u.status === 'invited').length;
  return shown === total ? `${total} ${total === 1 ? 'person' : 'people'}` : `${shown} of ${total} people shown`;
}

function memberAuditHtml() {
  return Store.activity().filter((a) => ['invite', 'join', 'role', 'remove', 'rename'].includes(a.kind)).slice(0, 14)
    .map((a) => `<div class="audit__row"><span class="audit__when">${fmtDateTime(a.ts)}</span><span class="audit__what">${activityLine(a)}</span></div>`).join('') || '<div class="audit__row"><span class="audit__what">Nothing yet.</span></div>';
}

function renderMemberRows() {
  const body = $('[data-member-rows]');
  if (!body || !Store.isAdmin()) return;
  const users = memberListUsers();
  const focus = body.contains(document.activeElement) ? focusReference(document.activeElement) : null;
  body.innerHTML = memberRowsHtml(users);
  if (focus) resolveFocus(focus, body)?.focus({ preventScroll: true });
  const count = $('[data-member-count]');
  if (count) count.textContent = memberCountText(users.length);
  const audit = $('[data-member-audit]');
  if (audit) audit.innerHTML = memberAuditHtml();
}

function viewEmailSettings() {
  const busy = UI.emailBusy || UI.adminFormPending?.has('email-settings-form') ? ' disabled' : '';
  return `<section class="admin-block email-integration" aria-busy="${Boolean(busy)}">
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
          const editor = `<form class="invite-add integration__editor integration-card__editor" data-action="email-settings-form">
              <input class="text-input" name="fromname" placeholder="From name" value="${MD.esc(es.name || '')}" style="width:150px;flex:none" spellcheck="false" aria-label="From name">
              ${useDd
                ? `${dd('email-from', opts, current, {})}<input type="hidden" name="from" value="${MD.esc(current)}">`
                : `<input class="text-input" name="from" placeholder="wiki@yourdomain.com" value="${MD.esc(es.from)}" autocomplete="off" spellcheck="false" aria-label="From address">`}
              <button class="btn" type="submit"${busy}>Save</button>
            </form>`;
          return `<div class="integration-card"><div class="integration">
            <span class="integration__tile${connected ? '' : ' integration__tile--off'}">${RESEND_MARK}</span>
            <span class="integration__meta">
              <span class="integration__name">Resend
                ${connected ? '<span class="integration__status integration__status--on">Connected</span>'
                  : manual ? '<span class="integration__status">Manual</span>'
                  : '<span class="integration__status integration__status--off">Not connected</span>'}
              </span>
              ${sender || connected ? `<span class="integration__sub">${sender
                ? `Sends as ${MD.esc(sender)} <button class="linklike" data-action="email-edit"${busy}>change</button>`
                : 'Pick a sender address to finish.'}</span>` : ''}
            </span>
            <span class="integration__actions">
              ${(connected || manual || es.keySet || es.envKeySet) ? `<button class="btn btn--sm" data-action="email-test"${busy}>Send test</button>` : ''}
              ${connected
                ? `<button class="btn btn--sm" data-action="resend-disconnect"${busy}>Disconnect</button>`
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
              <button class="btn" type="submit"${busy}>Save</button>
            </form>
          </details>`}</div>`;
        })()}
      </section>`;
}

function viewAdmin() {
  if (!Store.isAdmin()) {
    return topbar(`<a href="#/home">Wiki</a><span class="crumbs__sep">/</span><span class="crumbs__here">Members</span>`) + `
    <div class="content"><div class="page-wrap"><div class="page-col"><div class="empty">
      ${I.users}<b>Only admins can manage members</b>
      <p>Ask a team lead if you need someone added to the roster.</p>
      <a class="btn" href="#/home" style="text-decoration:none">Back to the wiki</a>
    </div></div></div></div>`;
  }
  const users = memberListUsers();
  return topbar(`<a href="#/home">Wiki</a><span class="crumbs__sep">/</span><span class="crumbs__here">Members &amp; access</span>`) + `
  <div class="content"><div class="page-wrap page-wrap--wide"><div class="page-col page-col--wide">
    <div class="plain-head"><h1>Members &amp; access</h1></div>
    <div class="admin-grid">
      <section class="member-sheet" aria-label="Members">
        <div class="sheet__bar">
          <div class="sheet__search-wrap">${I.search}<input class="text-input sheet__search" data-m="member-q" type="search" placeholder="Search people…" value="${MD.esc(UI.memberQuery || '')}" aria-label="Search members by name, email, subteam, role, or status" autocomplete="off" spellcheck="false"></div>
          <div class="sheet__actions"><button class="btn btn--primary" data-action="members-add" aria-expanded="${Boolean(UI.memberInviteOpen)}" aria-controls="member-invite">${I.plus} Add members</button></div>
        </div>
        <div class="member-invite" id="member-invite" data-member-invite ${UI.memberInviteOpen ? '' : 'hidden'}>
          <form class="invite-add" data-action="invite-form">
            <input class="text-input" name="emails" placeholder="netid@cornell.edu, netid@cornell.edu…" autocomplete="off" spellcheck="false" aria-label="Email addresses to invite">
            ${dd('invite-role', [{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }], 'member', { style: 'width:120px' })}
            <button class="btn btn--primary" type="submit">${I.send} Add</button>
            <button class="icon-btn" type="button" data-action="members-add-close" aria-label="Close add members">${I.x}</button>
          </form>
        </div>
        <div class="member-scroll"><table aria-label="Wiki members">
          <thead><tr><th scope="col" class="member-person">Person</th><th scope="col" class="member-subteam">Subteam</th><th scope="col" class="member-role">Role</th><th scope="col" class="member-date">Joined / added</th><th scope="col" class="member-controls"><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody data-member-rows>${memberRowsHtml(users)}</tbody>
        </table></div>
        <div class="sheet__foot" data-member-count role="status">${memberCountText(users.length)}</div>
      </section>
      ${viewAiSettings()}
      ${viewEmailSettings()}
      <section class="admin-block">
        <div class="admin-block__head"><h2>Access log</h2></div>
        <div class="audit" data-member-audit>${memberAuditHtml()}</div>
      </section>
    </div>
  </div></div></div>`;
}

function welcomeEmailHtml(u) {
  return `<div class="mailview">
    <div class="mailview__head">
      <div class="mailview__row"><span class="k">From</span><span>CUPI Wiki &lt;wiki@cornellphysicalintelligence.com&gt;</span></div>
      <div class="mailview__row"><span class="k">To</span><span>${MD.esc(u.email)}</span></div>
      <div class="mailview__row"><span class="k">Subject</span><span><b>You're on the CUPI wiki</b></span></div>
    </div>
    <div class="mailview__body">
      <div class="mailview__wordmark">CUPI</div>
      <div class="mailview__eyebrow">Cornell Physical Intelligence &middot; Internal Wiki</div>
      <img class="mailview__crab" src="${CRAB_URI}" alt="The CUPI crab, on a beach">
      <p>Hi,</p>
      <p><b>${MD.esc(Store.userName(u.invitedBy))}</b> added you to the CUPI wiki.</p>
      <p><a class="mailview__btn" href="https://wiki.cornellphysicalintelligence.com">Open the wiki</a></p>
      <p style="color:var(--muted);font-size:13px">Sign in with your ${MD.esc(u.email)} Google account. If you weren't expecting this, ignore it.</p>
    </div>
  </div>`;
}

/* ------------------------------- trash / guide --------------------------- */

function viewTrash() {
  const items = [...Store.s.trash].sort((a, b) => b.deletedAt - a.deletedAt);
  return topbar(`<a href="#/home">Wiki</a><span class="crumbs__sep">/</span><span class="crumbs__here">Trash</span>`) + `
  <div class="content"><div class="page-wrap"><div class="page-col">
    <div class="plain-head"><h1>Trash</h1><p>Deleted pages are permanently removed after 30 days.</p></div>
    ${items.length ? `<div class="history">${items.map((p) => `<div class="rev">
      <span class="avatar">${Store.initials(p.deletedBy)}</span>
      <span class="rev__meta"><span class="rev__summary">${MD.esc(p.title)}</span><span class="rev__when">deleted by ${MD.esc(Store.userName(p.deletedBy))} · ${relTime(p.deletedAt)}</span></span>
      <button class="btn btn--sm" data-action="trash-restore" data-id="${p.id}">Restore</button>
      <button class="btn btn--sm btn--danger" data-action="trash-purge" data-id="${p.id}">Delete forever</button>
    </div>`).join('')}</div>` : `<div class="empty">${I.trash}<b>Trash is empty</b></div>`}
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
  if (!m) { UI._shownModal = null; return ''; }
  const continuing = UI._shownModal === m;
  UI._shownModal = m;
  let inner = '';
  if (m.kind === 'new-page') {
    // Each template card shows a live-rendered snapshot of the template itself,
    // so you see the structure you're choosing, not just its name.
    const thumb = (t) => {
      if (!t.body) return `<div class="tpl__thumb tpl__thumb--blank" aria-hidden="true" inert><span>Blank page</span></div>`;
      const { html } = MD.render(t.body, mdCtx({ readonly: true }));
      // These trusted, rendered templates are illustrations inside a button.
      // Keep their typography without nesting links/controls or duplicating
      // heading IDs from the article behind the dialog.
      const passiveHtml = html.replace(/<(\/?)(a|button)\b([^>]*)>/gi, (_tag, closing, _name, attrs) =>
        closing ? '</span>' : `<span${attrs.match(/\sclass=(?:"[^"]*"|'[^']*')/i)?.[0] || ''}>`)
        .replace(/<[a-z][^>]*>/gi, (tag) => tag.replace(/\sid=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ''));
      return `<div class="tpl__thumb" aria-hidden="true" inert><div class="prose">${passiveHtml}</div></div>`;
    };
    inner = `<div class="modal modal--wide" role="dialog" aria-label="New page">
      <div class="modal__head"><h3>New page</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
      <div class="modal__body">
        <label>Title<input class="text-input" data-m="title" placeholder="e.g. Landing Gear Study" value="${MD.esc(m.title || '')}" maxlength="90" spellcheck="true" autocorrect="off"></label>
        <label>Section${ddSections(m.section || 'projects')}</label>
        <label>Template</label>
        <div class="tpl-grid">${TEMPLATES.map((t) => `<button class="tpl ${(m.tpl || 'blank') === t.id ? 'sel' : ''}" data-action="tpl-pick" data-tpl="${t.id}" aria-label="${MD.esc(t.name)}" aria-pressed="${(m.tpl || 'blank') === t.id}">${thumb(t)}<b>${t.name}</b>${t.body ? `<span class="tpl__desc">${MD.esc(t.desc)}</span>` : ''}</button>`).join('')}</div>
        ${m.error ? `<span class="field-error">${MD.esc(m.error)}</span>` : ''}
      </div>
      <div class="modal__foot"><button class="btn" data-action="modal-close">Cancel</button><button class="btn btn--primary" data-action="new-page-go">Create &amp; edit</button></div>
    </div>`;
  } else if (m.kind === 'save-summary') {
    const p = m.preview;
    inner = `<div class="modal save-summary" role="dialog" aria-label="Save changes">
      <div class="modal__head"><h3>${UI.editor?.isNew ? 'Create page' : 'Save changes'}</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
      <div class="modal__body">
        <label>Change summary<input class="text-input" data-m="summary" value="${MD.esc(m.summary || '')}" placeholder="${MD.esc(m.suggestedSummary || p?.fallback || '')}" maxlength="120" spellcheck="true" autocorrect="off"></label>
        <p class="save-summary__status" role="alert" ${m.error ? '' : 'hidden'}>${MD.esc(m.error || '')}</p>
        ${p ? `<details class="save-summary__changes"><summary>View changes <span class="save-summary__counts"><span>+${p.add}</span><span>−${p.del}</span></span></summary>
          ${p.titleChanged ? `<p class="save-summary__metadata">Title: ${MD.esc(UI.editor.origTitle)} → ${MD.esc(UI.editor.title.trim())}</p>` : ''}
          ${p.sectionChanged ? `<p class="save-summary__metadata">Section: ${MD.esc(p.input.beforeSection)} → ${MD.esc(p.input.section)}</p>` : ''}
          ${p.lines.length ? `<div class="save-summary__diff">${p.lines.map((line) => `<div class="${line[0] === '+' ? 'diff__line--add' : 'diff__line--del'}">${MD.esc(line)}</div>`).join('')}</div>` : ''}
          ${p.truncated ? '<p class="save-summary__metadata">Showing an excerpt of this edit.</p>' : ''}
          ${!p.hasChanges ? '<p class="save-summary__metadata">No changes to save.</p>' : ''}
        </details>` : ''}
        <div class="page-review" data-page-review ${m.reviewSuggestions?.length ? '' : 'hidden'}>${pageReviewHtml(m)}</div>
      </div>
      <div class="modal__foot"><button class="btn" data-action="modal-close">Keep editing</button><button class="btn btn--primary" data-action="save-commit">Save</button></div>
    </div>`;
  } else if (m.kind === 'invite-mail') {
    const u = Store.user(m.email);
    inner = `<div class="modal modal--wide" role="dialog" aria-label="Welcome email">
      <div class="modal__head"><h3>Welcome email preview</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
      <div class="modal__body">
        ${u ? welcomeEmailHtml(u) : ''}
        <p class="admin-block__sub" style="margin:0">No email is sent in this preview.</p>
      </div>
      <div class="modal__foot"><button class="btn btn--primary" data-action="modal-close">Done</button></div>
    </div>`;
  } else if (m.kind === 'interest-pending') {
    inner = interestPendingModalHtml(m.id);
  } else if (m.kind === 'interest-row') {
    inner = interestRowModalHtml(m.id);
  } else if (m.kind === 'interest-email-copy') {
    inner = `<div class="modal" role="dialog" aria-label="Copy selected emails">
      <div class="modal__head"><h3>Selected emails</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
      <div class="modal__body"><p>Clipboard access was blocked. Select and copy this comma-separated list.</p>
        <textarea class="text-input" rows="6" readonly aria-label="Selected emails as CSV">${MD.esc(m.csv)}</textarea>
      </div><div class="modal__foot"><button class="btn" data-action="modal-close">Close</button></div>
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
      <div class="modal__body"><p style="margin:0;font-size:14px;color:var(--muted)">Keep the draft to resume later. Discard permanently removes these unsaved changes.</p></div>
      <div class="modal__foot modal__foot--split">
        <button class="btn btn--ghost" data-action="modal-close">Keep editing</button>
        <span style="flex:1"></span>
        <button class="btn btn--danger" data-action="editor-discard-close">Discard changes</button>
        <button class="btn btn--primary" data-action="editor-keep-draft">Keep draft</button>
      </div>
    </div>`;
  }
  if (!inner) inner = viewExtraModal(m);
  return `<div class="modal-veil ${continuing ? 'modal-veil--steady' : ''}" data-action="modal-veil">${inner}</div>`;
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

function renderBackground(routeName) {
  if (UI.route.name !== routeName) return;
  if (UI.editor || UI.modal || UI.palette || UI.menu) { UI._backgroundRoute = routeName; return; }
  UI._backgroundRoute = null;
  render();
}

function render() {
  const modalScroll = UI.modal && UI._shownModal === UI.modal ? $('.modal__body')?.scrollTop : undefined;
  // Dialogs and late callbacks must not replace a mounted editor's textarea.
  // Its native undo history cannot be reconstructed from a string snapshot.
  if (Store.me() && UI.editor && UI._mountedEditor === UI.editor && $('.editor')) {
    captureModalFocus();
    document.querySelector('.modal-veil')?.remove();
    if (UI.modal) document.body.insertAdjacentHTML('beforeend', viewModal());
    const oldPalette = $('.palette-veil');
    const samePalette = UI.palette && UI._mountedPalette === UI.palette && oldPalette;
    if (!samePalette) {
      oldPalette?.remove();
      if (UI.palette) document.body.insertAdjacentHTML('beforeend', viewPalette());
    }
    UI._mountedPalette = UI.palette;
    syncSidebarInteraction();
    if (UI.modal) mountModalFocus();
    if (modalScroll !== undefined && $('.modal__body')) $('.modal__body').scrollTop = modalScroll;
    if (UI.palette && !samePalette) $('.palette input')?.focus();
    syncMeaningSearch();
    syncPageReview();
    syncChangeSummary();
    syncAiUsage();
    return;
  }
  cadCleanups.forEach((fn) => fn());
  cadCleanups = [];
  window.__closeMenu?.();
  captureModalFocus();
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
    stopMeaningSearch('home'); stopMeaningSearch('modal');
    cancelPageReview(pageReviewEditor);
    cancelChangeSummary(summaryEditor);
    const vt = $('.login .vt-title');
    if (vt) mountHeroTitle(vt);
    mountLoginCard($('.login__card'));
    return;
  }
  if (UI.editor) view = viewEditor();
  else if (r.name === 'home') view = topbar('<span class="crumbs__here">Home</span>') + `<div class="content search-home-content">${viewSearchHome()}</div>`;
  else if (r.name === 'page') view = viewPage(r.params.id || 'welcome');
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
  else view = topbar('<span class="crumbs__here">Home</span>') + `<div class="content search-home-content">${viewSearchHome()}</div>`;

  const adminForms = r.name === 'admin' && UI._mountedRoute === 'admin' && !UI.editor && Store.isAdmin()
    ? [...document.querySelectorAll('form[data-action]')].filter((form) => form.dataset.adminDirty === 'true' || form.dataset.adminPending === 'true') : [];
  const adminFocus = adminForms.some((form) => form.contains(document.activeElement)) ? document.activeElement : null;
  const palette = UI.palette && UI._mountedPalette === UI.palette ? $('.palette-veil') : null;
  const paletteFocus = palette?.contains(document.activeElement) ? document.activeElement : null;
  app.innerHTML = `<div class="shell ${UI.navOpen ? 'nav-open' : ''} ${UI.navHidden ? 'nav-hidden' : ''}">
    ${viewSidebar()}
    <main class="main">${view}</main>
    <div class="shell__scrim" data-action="nav-close"></div>
  </div>${viewPalette()}${viewModal()}`;

  for (const form of adminForms) {
    const selector = `form[data-action="${form.dataset.action}"]${form.classList.contains('integration__editor') ? '.integration__editor' : ':not(.integration__editor)'}`;
    const next = document.querySelector(selector);
    if (next) { next.replaceWith(form); const disclosure = form.closest('details'); if (disclosure) disclosure.open = true; }
  }
  if (palette) $('.palette-veil')?.replaceWith(palette);
  UI._mountedPalette = UI.palette;
  UI._mountedRoute = r.name;
  UI._mountedEditor = UI.editor;
  if (UI.editor) UI._editorLocation = location.pathname + location.search + location.hash;
  syncSidebarInteraction();
  adminFocus?.focus({ preventScroll: true });
  paletteFocus?.focus({ preventScroll: true });
  if (palette && !UI.palette.composing) renderSearchList('modal');
  $$('.ai-settings [data-m]').forEach((el) => el.setAttribute('aria-labelledby', el.dataset.m + '-label'));

  const editorToggled = UI._hadEditor !== !!UI.editor;
  UI._hadEditor = !!UI.editor;
  if (UI.editor && editorToggled) $('.editor')?.classList.add('editor-in');

  if (keepScroll) { const c = $('.content'); if (c) c.scrollTop = scrollTop; }
  { const sb = $('.sidebar__scroll'); if (sb) sb.scrollTop = sidebarScroll; }

  // Mount hooks.
  if (r.name === 'interest' && $('.sheet')) renderInterestSelection();
  mountSearchHome();
  syncMeaningSearch();
  syncPageReview();
  syncChangeSummary();
  syncAiUsage();
  $$('.cad-embed').forEach(mountCadViewer);
  mountTableSort();
  { const vt = $('.login .vt-title'); if (vt) mountHeroTitle(vt); }
  if (typeof REMOTE !== 'undefined' && r.name === 'admin' && !UI.editor && UI.resendDomains === undefined && Store.isAdmin()) {
    const es = Store.emailSettings();
    if (es.oauthConnected || es.keySet || es.envKeySet) {
      UI.resendDomains = 'pending';
      api('/resend/domains').then((out) => { UI.resendDomains = out.domains; renderBackground('admin'); }).catch(() => { UI.resendDomains = null; });
    }
  }
  // The interest component loads from its own endpoint the first time its
  // screen opens; Refresh clears the cache to refetch.
  if (typeof REMOTE !== 'undefined' && r.name === 'interest' && UI.interest === undefined && Store.isAdmin()) {
    UI.interest = { loading: true };
    api('/interest')
      .then((out) => {
        UI.interest = {
          rows: out.rows || [],
          pendingReview: Array.isArray(out.pendingReview) ? out.pendingReview : [],
          queueUnavailable: Boolean(out.queueUnavailable),
        };
        renderBackground('interest');
      })
      .catch((e) => { UI.interest = { error: e.message || 'load failed' }; renderBackground('interest'); });
  }
  if (typeof REMOTE !== 'undefined' && r.name === 'interest' && UI.interestArchives === undefined && Store.isAdmin()) {
    UI.interestArchives = { list: [] };
    api('/interest/archives')
      .then((out) => { UI.interestArchives = { list: out.archives || [] }; renderBackground('interest'); })
      .catch(() => { /* the archive shelf is a courtesy */ });
  }
  // Opening one archive pulls its rows once.
  if (typeof REMOTE !== 'undefined' && UI.interestArchiveView?.loading === true && UI.interestArchiveView.id) {
    const id = UI.interestArchiveView.id;
    api(`/interest/archives/${id}`)
      .then((out) => {
        if (UI.interestArchiveView?.id === id) { UI.interestArchiveView = { id, archive: out.archive }; renderBackground('interest'); }
      })
      .catch(() => {
        if (UI.interestArchiveView?.id === id) { UI.interestArchiveView = { id, error: true }; renderBackground('interest'); }
      });
    UI.interestArchiveView.loading = 'pending';
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
  if (UI.palette && !palette) { const inp = $('.palette input'); inp?.focus(); inp?.setSelectionRange(inp.value.length, inp.value.length); }
  if (UI.modal) mountModalFocus();
  if (modalScroll !== undefined && $('.modal__body')) $('.modal__body').scrollTop = modalScroll;
  if (UI.modal?.kind === 'bug') mountBugDrop();
  const anchorKey = r.name === 'page' && r.params.anchor ? r.params.id + '#' + r.params.anchor : null;
  const landAnchor = anchorKey && UI._landedAnchor !== anchorKey;
  UI._landedAnchor = anchorKey;
  if (landAnchor) {
    const el = $('#' + CSS.escape(r.params.anchor));
    const c = $('.content');
    if (el && c) {
      const land = () => { if (!c.isConnected || UI._landedAnchor !== anchorKey) return; c.scrollTop = c.scrollTop + el.getBoundingClientRect().top - c.getBoundingClientRect().top - 68; };
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
