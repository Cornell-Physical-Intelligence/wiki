/* ============================================================================
   UI part 2 — editor, history, admin, palette, overlays, event wiring.
   ========================================================================== */

'use strict';

/* ------------------------------- editor ---------------------------------- */

function openEditor(pageId, isNew, draft) {
  const p = pageId ? Store.page(pageId) : null;
  UI.editor = {
    pageId, isNew: !!isNew,
    title: draft?.title ?? p?.title ?? '',
    body: draft?.body ?? p?.body ?? '',
    section: draft?.section ?? p?.section ?? 'projects',
    parent: p?.parent ?? draft?.parent ?? null,
    tags: draft?.tags ?? (p?.tags ? [...p.tags] : []),
    mode: Store.prefs().editorMode || 'split',
    dirty: false,
    origTitle: p?.title ?? '', origBody: draft?.origBody ?? p?.body ?? '',
  };
}

function viewEditor() {
  const e = UI.editor;
  const tools = [
    ['bold', '<b style="font-size:13px">B</b>', 'Bold ⌘B'],
    ['italic', '<i style="font-size:13px;font-family:serif">I</i>', 'Italic ⌘I'],
    ['strike', '<s style="font-size:12px">S</s>', 'Strikethrough'],
    ['code', '<span style="font-family:var(--font-mono);font-size:11px">&lt;/&gt;</span>', 'Code'],
    null,
    ['h2', '<span style="font-size:11px;font-weight:700">H2</span>', 'Heading'],
    ['h3', '<span style="font-size:11px;font-weight:600">H3</span>', 'Subheading'],
    null,
    ['ul', '<span style="font-size:13px">•≡</span>', 'Bullet list'],
    ['task', '<span style="font-size:11px">☑</span>', 'Task list'],
    ['table', '<span style="font-size:11px">⊞</span>', 'Table'],
    ['quote', '<span style="font-size:13px">"</span>', 'Quote'],
    ['callout', '<span style="font-size:12px">!</span>', 'Callout'],
    ['fence', '<span style="font-family:var(--font-mono);font-size:10px">```</span>', 'Code block'],
    null,
    ['wikilink', I.link, 'Link a page — [['],
    ['image', I.image, 'Insert image'],
    ['attach', I.paperclip, 'Attach file (CAD, PDF, anything)'],
  ];
  return `<div class="editor mode-${e.mode}">
    ${topbar(
      `<span class="crumbs__here">${e.isNew ? 'New page' : 'Editing'}</span>${e.dirty ? '<span class="crumbs__draft"><span class="dot dot--accent"></span>unsaved</span>' : ''}`,
      `<div class="editor__mode" role="tablist" aria-label="Editor mode">
        <button role="tab" data-action="ed-mode" data-mode="write" class="${e.mode === 'write' ? 'active' : ''}">Write</button>
        <button role="tab" data-action="ed-mode" data-mode="split" class="${e.mode === 'split' ? 'active' : ''}">Split</button>
        <button role="tab" data-action="ed-mode" data-mode="preview" class="${e.mode === 'preview' ? 'active' : ''}">Preview</button>
      </div>
      <button class="btn btn--ghost" data-action="ed-cancel">Cancel</button>
      <button class="btn btn--primary" data-action="ed-save">Save ${e.isNew ? 'page' : ''}<span class="kbd" style="background:transparent;border-color:currentColor;color:inherit;opacity:.6;margin-left:2px">⌘S</span></button>`
    )}
    <div class="editor__tools" role="toolbar" aria-label="Formatting">
      ${tools.map((t) => t === null ? '<span class="sep"></span>' :
        `<button class="icon-btn" data-action="ed-tool" data-tool="${t[0]}" title="${t[2]}" aria-label="${t[2]}">${t[1]}</button>`).join('')}
      <span class="spacer"></span>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)">Tags
        <input class="text-input" data-ed-tags style="height:26px;width:150px;font-size:12px" value="${MD.esc(e.tags.join(', '))}" placeholder="comma, separated" aria-label="Tags">
      </label>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)">Section
        <select class="select" data-action="ed-section" style="height:26px;width:auto;font-size:12px">
          ${SECTIONS.map((s) => `<option value="${s.id}" ${s.id === e.section ? 'selected' : ''}>${s.name}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="editor__panes">
      <div class="editor__pane editor__pane--src">
        <input class="editor__title" data-ed="title" placeholder="Page title" value="${MD.esc(e.title)}" maxlength="90">
        <textarea data-ed="body" placeholder="Write. Drop images or CAD files anywhere. [[ links a page." spellcheck="false">${MD.esc(e.body)}</textarea>
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
  host.innerHTML = (e.title ? `<h1 style="font-size:28px;font-weight:400;margin:0 0 18px">${MD.esc(e.title)}</h1>` : '') + html;
  $$('.cad-embed', host).forEach(mountCadViewer);
}

function edInsert(before, after, placeholder) {
  const ta = $('[data-ed="body"]');
  if (!ta) return;
  const { selectionStart: s, selectionEnd: epos, value } = ta;
  const sel = value.slice(s, epos) || placeholder || '';
  const insert = before + sel + (after || '');
  ta.setRangeText(insert, s, epos, 'end');
  if (!value.slice(s, epos) && placeholder) ta.setSelectionRange(s + before.length, s + before.length + placeholder.length);
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

const ED_TOOLS = {
  bold: () => edInsert('**', '**', 'bold'),
  italic: () => edInsert('*', '*', 'italic'),
  strike: () => edInsert('~~', '~~', 'text'),
  code: () => edInsert('`', '`', 'code'),
  h2: () => edInsert('\n## ', '', 'Heading'),
  h3: () => edInsert('\n### ', '', 'Subheading'),
  ul: () => edInsert('\n- ', '', 'item'),
  task: () => edInsert('\n- [ ] ', '', 'to do'),
  quote: () => edInsert('\n> ', '', 'quote'),
  fence: () => edInsert('\n~~~\n', '\n~~~\n', 'code'),
  callout: () => edInsert('\n::: note Title\n', '\n:::\n', 'The thing worth calling out.'),
  table: () => edInsert('\n| Column | Column |\n| --- | --- |\n| ', ' |  |\n', 'cell'),
  wikilink: () => edInsert('[[', ']]', 'Page Title'),
  image: () => $('[data-ed-file]')?.click(),
  attach: () => $('[data-ed-file]')?.click(),
};

async function edHandleFiles(files) {
  for (const f of files) {
    try {
      const att = await Store.addAttachment(f);
      if (/^image\//.test(att.type)) edInsert(`\n![${f.name.replace(/\.[^.]+$/, '')}](att:${att.id} "")\n`, '', '');
      else edInsert(`\n!file[${f.name.replace(/\.[^.]+$/, '')}](att:${att.id})\n`, '', '');
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
  const r = ta.getBoundingClientRect();
  pop.style.left = Math.min(r.left + 40, innerWidth - 260) + 'px';
  pop.style.top = Math.min(r.top + 120, innerHeight - 200) + 'px';
  pop.hidden = false;
}

function edAcceptAc(title) {
  const ta = $('[data-ed="body"]');
  const upto = ta.value.slice(0, ta.selectionStart);
  const m = upto.match(/\[\[([^\][\n]*)$/);
  if (!m) return;
  const start = ta.selectionStart - m[1].length;
  ta.setRangeText(title + ']]', start, ta.selectionEnd, 'end');
  $('.ed-autocomplete').hidden = true;
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function edSave() {
  const e = UI.editor;
  if (!e.title.trim()) { toast('Give the page a title first.'); $('[data-ed="title"]')?.focus(); return; }
  const clash = Store.pageByTitle(e.title.trim());
  if (clash && clash.id !== e.pageId) { toast(`A page called “${e.title.trim()}” already exists.`); return; }
  UI.modal = { kind: 'save-summary' };
  render();
}

function edCommit(summary) {
  const e = UI.editor;
  // Someone else (or another tab) may have changed the page while this editor
  // was open — never overwrite silently.
  if (!e.isNew && !e.staleOverride) {
    const cur = Store.page(e.pageId);
    if (cur && cur.body !== e.origBody) {
      UI.modal = {
        kind: 'confirm', title: 'This page changed while you edited',
        text: `<b>${MD.esc(Store.userName(cur.updatedBy))}</b> saved a newer version ${relTime(cur.updated)}. Saving now replaces their text with yours (their version stays in History). Consider copying your changes out first.`,
        confirm: 'Save mine anyway', danger: true,
      };
      UI.modal.onGo = () => { UI.editor.staleOverride = true; edCommit(summary); };
      render();
      return;
    }
  }
  let p;
  if (e.isNew) {
    p = Store.createPage({ title: e.title.trim(), section: e.section, parent: e.parent, body: e.body, summary });
  } else {
    p = Store.savePage(e.pageId, { title: e.title.trim(), body: e.body, section: e.section, tags: e.tags, summary });
  }
  if (!p) { UI.modal = null; render(); return; } // savePage refused (e.g. size cap) and already toasted
  toast(Store.lastPersistOk ? (e.isNew ? 'Page created' : 'Saved') : 'NOT saved — storage is full');
  draftStash.delete(e.pageId || 'new');
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

function viewHistory(id) {
  const p = Store.page(id);
  if (!p) return viewMissing(id);
  const selIdx = UI.route.params.rev !== undefined ? +UI.route.params.rev : p.revs.length - 1;
  const rev = p.revs[selIdx];
  const prev = p.revs[selIdx - 1];
  const d = diffLines(prev ? prev.body : '', rev ? rev.body : '');
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
  for (const [op, line] of d.ops) {
    const h = `<div class="diff__line ${op === 1 ? 'diff__line--add' : op === -1 ? 'diff__line--del' : ''}"><span class="diff__gut">${op === 1 ? '+' : op === -1 ? '−' : ''}</span><span class="diff__txt">${MD.esc(line) || '&nbsp;'}</span></div>`;
    if (op === 0) run.push(h); else { flushRun(); rows += h; }
  }
  flushRun();

  return topbar(
    `<a href="#/page/${id}">${MD.esc(p.title)}</a><span class="crumbs__sep">/</span><span class="crumbs__here">History</span>`,
    selIdx < p.revs.length - 1 ? `<button class="btn" data-action="rev-restore" data-id="${id}" data-rev="${selIdx}">Restore this version</button>` : ''
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
    <div class="plain-head" style="margin-top:28px"><span class="eyebrow">Changes in selected revision</span></div>
    <div class="diff">${rows || '<div class="diff__line"><span class="diff__gut"></span><span class="diff__txt" style="color:var(--faint)">No text changes.</span></div>'}</div>
  </div></div></div>`;
}

/* ------------------------------- activity -------------------------------- */

function activityLine(a) {
  const who = `<b>${MD.esc(Store.userName(a.by))}</b>`;
  const pg = a.pageId && (Store.page(a.pageId) || Store.s.trash.find((p) => p.id === a.pageId));
  const pageRef = pg ? `<b>${MD.esc(pg.title)}</b>` : a.title ? `<b>${MD.esc(a.title)}</b>` : 'a page';
  const map = {
    edit: `${who} edited ${pageRef}${a.summary ? ` — ${MD.esc(a.summary)}` : ''}`,
    create: `${who} created ${pageRef}`,
    comment: `${who} commented on ${pageRef}`,
    delete: `${who} moved ${pageRef} to Trash`,
    restore: `${who} restored ${pageRef}`,
    invite: `${who} invited <b>${MD.esc(a.who || '')}</b>`,
    'invite-resend': `${who} re-sent the invite for <b>${MD.esc(a.who || '')}</b>`,
    'invite-revoke': `${who} revoked the invite for <b>${MD.esc(a.who || '')}</b>`,
    mention: `${who} mentioned <b>${MD.esc(Store.userName(a.who || ''))}</b> in a comment on ${pageRef}`,
    join: `<b>${MD.esc(Store.userName(a.by))}</b> joined the wiki`,
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

function viewAdmin() {
  if (!Store.isAdmin()) return viewMissing('admin');
  const users = Store.s.users;
  const active = users.filter((u) => u.status === 'active');
  const invited = users.filter((u) => u.status === 'invited');
  const audit = Store.activity().filter((a) => ['invite', 'invite-resend', 'invite-revoke', 'join', 'role', 'remove'].includes(a.kind)).slice(0, 14);
  return topbar(`<a href="#/page/welcome">Wiki</a><span class="crumbs__sep">/</span><span class="crumbs__here">Members &amp; access</span>`) + `
  <div class="content"><div class="page-wrap"><div class="page-col" style="max-width:880px">
    <div class="plain-head"><span class="eyebrow">Admin</span><h1>Members &amp; access</h1>
    <p>Who can sign in. Adding an email sends an invite with a one-time code; sign-in itself is Google OAuth restricted to <b>cornell.edu</b>, so the list below is the whole security model.</p></div>
    <div class="admin-grid">
      <section class="admin-block">
        <div class="admin-block__head"><h2>Add members</h2></div>
        <p class="admin-block__sub">Paste one or more <b>@cornell.edu</b> addresses, comma or space separated. Each gets an invite email with their code.</p>
        <form class="invite-add" data-action="invite-form">
          <input class="text-input" name="emails" placeholder="netid@cornell.edu, netid@cornell.edu…" autocomplete="off" spellcheck="false" aria-label="Email addresses to invite">
          <select class="select" name="role" style="width:120px" aria-label="Role for new members"><option value="member">Member</option><option value="admin">Admin</option></select>
          <button class="btn btn--primary" type="submit">${I.send} Send invites</button>
        </form>
      </section>
      ${invited.length ? `<section class="admin-block">
        <div class="admin-block__head"><h2>Pending invites</h2><span class="count">${invited.length}</span></div>
        <div class="roster"><div class="roster__scroll"><table>
          <thead><tr><th>Invited</th><th>Code</th><th>Sent</th><th></th></tr></thead><tbody>
          ${invited.map((u) => `<tr>
            <td><span class="who"><span class="avatar" style="background:var(--hover);color:var(--muted)">${Store.initials(u.email)}</span><span><b>${MD.esc(u.email.split('@')[0])}</b><span class="mail">${u.email}</span></span></span></td>
            <td><span class="mono">${u.inviteCode}</span></td>
            <td><span class="mono">${relTime(u.invitedAt)} · by ${MD.esc(Store.userName(u.invitedBy).split(' ')[0])}</span></td>
            <td><span class="actions">
              <button class="btn btn--sm" data-action="invite-view" data-email="${u.email}">${I.mail} View email</button>
              <button class="btn btn--sm" data-action="invite-resend" data-email="${u.email}">Resend</button>
              <button class="btn btn--sm btn--danger" data-action="invite-revoke" data-email="${u.email}">Revoke</button>
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
        <div class="admin-block__head"><h2>Access log</h2></div>
        <div class="audit">
          ${audit.map((a) => `<div class="audit__row"><span class="audit__when">${fmtDateTime(a.ts)}</span><span class="audit__what">${activityLine(a)}</span></div>`).join('') || '<div class="audit__row"><span class="audit__what">Nothing yet.</span></div>'}
        </div>
      </section>
    </div>
  </div></div></div>`;
}

function inviteEmailHtml(u) {
  return `<div class="mailview">
    <div class="mailview__head">
      <div class="mailview__row"><span class="k">From</span><span>CUPI Wiki &lt;wiki@cornellphysicalintelligence.com&gt;</span></div>
      <div class="mailview__row"><span class="k">To</span><span>${u.email}</span></div>
      <div class="mailview__row"><span class="k">Subject</span><span><b>You're invited to the CUPI wiki</b></span></div>
    </div>
    <div class="mailview__body">
      <p>Hi,</p>
      <p><b>${MD.esc(Store.userName(u.invitedBy))}</b> added you to the Cornell University Physical Intelligence wiki — the team's internal knowledge base for CAD, electronics, software, and everything in between.</p>
      <p>Sign in at <b>wiki.cornellphysicalintelligence.com</b> with this Google account, or enter your invite code:</p>
      <span class="mailview__code">${u.inviteCode}</span>
      <p style="color:var(--muted);font-size:13px">The code is one-time and tied to ${u.email}. If you weren't expecting this, ignore it.</p>
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
  return { kind: 'search', items: Store.search(q) };
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
  return `${items.length ? `<div class="palette__group eyebrow">${kind === 'recents' ? 'Recent' : 'Results'}</div>` : ''}
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
      <div class="palette__head">${I.search}<input placeholder="Search pages, or type to jump…" value="${MD.esc(UI.palette.q)}" aria-label="Search query"><span class="kbd">esc</span></div>
      <div class="palette__list">${paletteListHtml()}</div>
      <div class="palette__foot"><span>↑↓ navigate</span><span>↵ open</span><span>esc close</span></div>
    </div>
  </div>`;
}

/* ------------------------------- modals ---------------------------------- */

function viewModal() {
  const m = UI.modal;
  if (!m) return '';
  let inner = '';
  if (m.kind === 'new-page') {
    inner = `<div class="modal" role="dialog" aria-label="New page">
      <div class="modal__head"><h3>New page</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
      <div class="modal__body">
        <label>Title<input class="text-input" data-m="title" placeholder="e.g. Landing Gear Study" value="${MD.esc(m.title || '')}" maxlength="90"></label>
        <label>Section<select class="select" data-m="section">${SECTIONS.map((s) => `<option value="${s.id}" ${s.id === (m.section || 'projects') ? 'selected' : ''}>${s.name}</option>`).join('')}</select></label>
        <label>Nest under <span class="sub">Optional — makes this a subpage.</span>
        <select class="select" data-m="parent"><option value="">— top level —</option>${[...Store.s.pages].sort((a, b) => a.title.localeCompare(b.title)).map((q) => `<option value="${q.id}" ${q.id === m.parent ? 'selected' : ''}>${MD.esc(q.title)}</option>`).join('')}</select></label>
        <label>Template<span class="sub">Start from a structure the team already uses.</span></label>
        <div class="tpl-grid">${TEMPLATES.map((t) => `<button class="tpl ${(m.tpl || 'blank') === t.id ? 'sel' : ''}" data-action="tpl-pick" data-tpl="${t.id}"><b>${t.name}</b><span>${t.desc}</span></button>`).join('')}</div>
        ${m.error ? `<span class="field-error">${MD.esc(m.error)}</span>` : ''}
      </div>
      <div class="modal__foot"><button class="btn" data-action="modal-close">Cancel</button><button class="btn btn--primary" data-action="new-page-go">Create &amp; edit</button></div>
    </div>`;
  } else if (m.kind === 'save-summary') {
    inner = `<div class="modal" role="dialog" aria-label="Save">
      <div class="modal__head"><h3>${UI.editor?.isNew ? 'Create page' : 'Save changes'}</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
      <div class="modal__body">
        <label>What changed? <span class="sub">One line for the history — future-you will thank you.</span>
        <input class="text-input" data-m="summary" placeholder="${UI.editor?.isNew ? 'Created page' : 'e.g. Added rev D bring-up results'}" maxlength="120"></label>
      </div>
      <div class="modal__foot"><button class="btn" data-action="modal-close">Back</button><button class="btn btn--primary" data-action="save-commit">Save</button></div>
    </div>`;
  } else if (m.kind === 'invite-mail') {
    const u = Store.user(m.email);
    inner = `<div class="modal modal--wide" role="dialog" aria-label="Invite email">
      <div class="modal__head"><h3>Invite email — sent</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
      <div class="modal__body">
        ${u ? inviteEmailHtml(u) : ''}
        <p class="admin-block__sub" style="margin:0">In this preview the email is simulated. Production sends it automatically the moment you add the address.</p>
      </div>
      <div class="modal__foot"><button class="btn" data-action="copy-code" data-code="${u?.inviteCode || ''}">${I.copy} Copy code</button><button class="btn btn--primary" data-action="modal-close">Done</button></div>
    </div>`;
  } else if (m.kind === 'confirm') {
    inner = `<div class="modal" role="dialog" aria-label="Confirm">
      <div class="modal__head"><h3>${MD.esc(m.title)}</h3></div>
      <div class="modal__body"><p style="margin:0;font-size:14px;color:var(--muted)">${m.text}</p></div>
      <div class="modal__foot"><button class="btn" data-action="modal-close">Cancel</button><button class="btn ${m.danger ? 'btn--danger' : 'btn--primary'}" data-action="confirm-go">${MD.esc(m.confirm || 'Confirm')}</button></div>
    </div>`;
  }
  if (!inner) inner = viewExtraModal(m);
  return `<div class="modal-veil" data-action="modal-veil">${inner}</div>`;
}

/* ------------------------------- render ---------------------------------- */

function render() {
  cadCleanups.forEach((fn) => fn());
  cadCleanups = [];
  window.__closeMenu?.();
  const app = $('#app');
  const me = Store.me();
  let view = '';
  const r = UI.route;

  // Re-renders of the same route (checkbox ticks, comments, stars) must not
  // throw the reader back to the top of the page.
  const prevContent = $('.content');
  const keepScroll = prevContent && UI._lastRouteKey === r.name + '/' + (r.params.id || '');
  const scrollTop = keepScroll ? prevContent.scrollTop : 0;
  UI._lastRouteKey = r.name + '/' + (r.params.id || '');

  if (!me) {
    app.innerHTML = viewLogin();
    return;
  }
  if (UI.editor) view = viewEditor();
  else if (r.name === 'page') view = viewPage(r.params.id || 'welcome');
  else if (r.name === 'section') view = viewSection(r.params.id);
  else if (r.name === 'history') view = viewHistory(r.params.id);
  else if (r.name === 'activity') view = viewActivity();
  else if (r.name === 'admin') view = viewAdmin();
  else if (r.name === 'trash') view = viewTrash();
  else if (r.name === 'inbox') view = viewInbox();
  else if (r.name === 'health') view = viewHealth();
  else if (r.name === 'tag') view = viewTag(decodeURIComponent(r.params.id || ''));
  else if (r.name === 'new') { openEditor(null, true, { title: r.params.title || '', section: r.params.section || 'projects' }); view = viewEditor(); }
  else view = viewPage('welcome');

  app.innerHTML = `<div class="shell ${UI.navOpen ? 'nav-open' : ''} ${UI.navHidden ? 'nav-hidden' : ''}">
    ${viewSidebar()}
    <main class="main">${view}</main>
    <div class="shell__scrim" data-action="nav-close"></div>
  </div>${viewPalette()}${viewModal()}`;

  if (keepScroll) { const c = $('.content'); if (c) c.scrollTop = scrollTop; }

  // Mount hooks.
  $$('.cad-embed').forEach(mountCadViewer);
  if (UI.editor) {
    edUpdatePreview();
    const ta = $('[data-ed="body"]');
    if (ta && !UI.editor._focused) { (UI.editor.isNew && !UI.editor.title ? $('[data-ed="title"]') : ta)?.focus(); UI.editor._focused = true; }
  }
  if (UI.palette) { const inp = $('.palette input'); inp?.focus(); inp?.setSelectionRange(inp.value.length, inp.value.length); }
  if (UI.modal) $('.modal [data-m], .modal .btn--primary')?.focus?.();
  if (r.name === 'page' && r.params.anchor) {
    $('#' + CSS.escape(r.params.anchor))?.scrollIntoView();
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
    links.forEach((a) => a.classList.toggle('here', a.dataset.toc === cur?.id));
  };
  content.addEventListener('scroll', spy, { passive: true });
  spy();
}
