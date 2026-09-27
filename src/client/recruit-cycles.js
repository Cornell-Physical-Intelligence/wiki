/* ============================================================================
   Applications — cycles module (client). The cycle index, the New cycle
   dialog, the migration and adopt actions, held website responses, the cycle
   tools menu, and the Settings dialog: about, status, subteams, who can review.
   ========================================================================== */

'use strict';

// recruit:cycles:start

/* ------------------------------- index ----------------------------------- */

// One card per cycle: name, status, deadline, and how many people each of
// its stages has heard from.
function recruitCycleRowHtml(c, intakeCycleId) {
  const by = c.counts?.bySection || {};
  const receiving = intakeCycleId && c.id === intakeCycleId && c.status === 'open';
  const stages = recruitSectionKeys(c).map((key) => ({ key, title: recruitSectionTitle(key, c), n: Number(by[key] || 0) }));
  const max = Math.max(1, ...stages.map((s) => s.n));
  const meta = [
    c.term && c.term !== c.name ? c.term : '',
    c.status !== 'archived' && c.closesAt ? 'Deadline ' + recruitDay(Number(c.closesAt)) : '',
    c.updated ? 'Updated ' + recruitAgo(Number(c.updated)) : '',
  ].filter(Boolean).join(' · ');
  return `<a class="rc-cycle-card" href="${recruitPanelHref(c.id, '')}" data-id="${MD.esc(c.id)}">
    <span class="rc-cycle-card__head"><span class="rc-cycle-card__name">${MD.esc(c.name)}</span>
      <span class="rc-cycle-state rc-cycle-state--${MD.esc(c.status)}"><span class="rc-cycle-state__dot"></span>${MD.esc(recruitStatusText(c, intakeCycleId).replace(" · receives the website's forms", ''))}</span>
      ${receiving ? `<span class="rc-cycle-card__live">${RC_ICONS.globe}Website</span>` : ''}</span>
    ${meta ? `<span class="rc-cycle-card__meta">${MD.esc(meta)}</span>` : ''}
    <span class="rc-cycle-card__stages">${stages.map((s) => `<span class="rc-cycle-card__stage"><span class="rc-cycle-card__bar"><span style="width:${Math.round((s.n / max) * 100)}%"></span></span><span class="rc-cycle-card__label">${MD.esc(s.title)}</span><span class="rc-cycle-card__n">${recruitNum(s.n)}</span></span>`).join('')}</span>
  </a>`;
}

function recruitIndexHtml() {
  const st = recruitState();
  const admin = recruitIsAdmin();
  const head = `<div class="plain-head rc-index__head"><h1>Applications</h1>${admin ? `<button class="btn btn--primary" data-action="recruit-cycle-new">${I.plus} New cycle</button>` : ''}</div>`;
  const cy = st.cycles;
  if (!cy || cy.loading) return head + '<p class="sheet__note">Loading…</p>';
  if (cy.error) return head + `<p class="sheet__note">Could not load: ${MD.esc(cy.error)}. <button class="linklike" data-action="recruit-refresh">Retry</button></p>`;
  const list = cy.list || [];
  const live = list.filter((c) => c.status !== 'archived');
  const archived = list.filter((c) => c.status === 'archived');
  const liveBlock = live.length
    ? `<div class="rc-cycle-grid">${live.map((c) => recruitCycleRowHtml(c, cy.intakeCycleId)).join('')}</div>`
    : `<div class="rc-empty-card"><b>${admin ? 'No cycle yet' : 'No open cycle'}</b>${admin ? '<p>A cycle holds one season of recruiting: its forms, its flow, and the people in it.</p><button class="btn btn--primary" data-action="recruit-cycle-new">New cycle</button>' : ''}</div>`;
  const archivedBlock = archived.length
    ? `<h2 class="sheet__heading">Archived</h2><div class="rc-cycle-grid rc-cycle-grid--archived">${archived.map((c) => recruitCycleRowHtml(c, cy.intakeCycleId)).join('')}</div>`
    : '';
  return head + `<div data-rc="queue">${recruitAttentionHtml()}</div>` + liveBlock + archivedBlock;
}

// Shown only when something needs an admin: the one-time import, orphaned
// website submissions, and saved submissions still waiting in the queue.
function recruitAttentionHtml() {
  const st = recruitState();
  if (!recruitIsAdmin()) return '';
  const mig = st.cycles?.migration || null;
  const items = [];
  if (mig && !mig.done) {
    const parts = [recruitPlural(mig.legacyLive || 0, 'submission'), recruitPlural((mig.legacyArchives || []).length, 'archive')].join(' and ');
    const busy = st.busy.has('migrate');
    items.push(`<div class="sheet__archive"><span class="sheet__archivemeta" data-rc="migrate">${busy ? 'Importing…' : MD.esc(parts) + ' on the old list'}</span>
      <button class="btn" data-action="recruit-migrate" ${busy ? 'disabled' : ''}>Import the current list and archives</button></div>`);
  }
  if (mig?.done && mig.orphans > 0) {
    items.push(`<div class="sheet__archive"><span class="sheet__archivemeta">${MD.esc(recruitPlural(mig.orphans, 'submission'))} arrived while no cycle was receiving the form</span>
      <button class="btn" data-action="recruit-adopt" aria-haspopup="menu" ${st.busy.has('adopt') ? 'disabled' : ''}>Adopt into…</button></div>`);
  }
  if (st.queue?.queueUnavailable || st.queue?.error) items.push(`<div class="sheet__archive"><span class="sheet__archivemeta">Could not check the saved-submission queue.</span><button class="btn" data-action="recruit-queue-sync">Retry</button></div>`);
  const pending = recruitPendingHtml();
  if (!items.length && !pending) return '';
  return `${items.length ? `<h2 class="sheet__heading">Needs attention</h2><div class="sheet sheet--list">${items.join('')}</div>` : ''}${pending}`;
}

// The index's queue block and the flow's repaint through the same hook.
function recruitQueueHtml() {
  return recruitCycleRow() ? recruitPendingHtml() : recruitAttentionHtml();
}

/* ------------------------------- held responses -------------------------- */

function recruitPendingReason(reason) {
  if (reason === 'duplicate') return 'A repeat from an email that had already sent this form, never confirmed';
  if (reason === 'capacity') return 'Arrived after the form was full';
  if (reason === 'replay_failed') return 'Could not be written to its form yet';
  if (reason === 'unsynced') return 'Not yet written to its form';
  if (reason === 'legacy') return 'Sent to the old list';
  return 'Not on its form yet';
}

// Responses the website took but did not put on a form (admins).
function recruitPendingHtml() {
  const st = recruitState();
  if (!recruitIsAdmin()) return '';
  const pending = st.queue?.pending || [];
  if (!pending.length) return '';
  return `<section class="rc-held" aria-labelledby="recruit-pending-heading">
    <h2 class="sheet__heading" id="recruit-pending-heading">Held responses <span class="count">${pending.length}</span></h2>
    <p class="sheet__note">The website took these but did not put them on a form: a repeat that was never confirmed, or a form that was full. Place one on its form, or leave it.</p>
    <div class="sheet sheet--list">${pending.map((r) => `<div class="sheet__archive rc-pending">
      <button class="interest-person" data-action="recruit-queue-open" data-id="${MD.esc(r.id)}" aria-label="Review the held response from ${MD.esc(r.name)}"><b>${MD.esc(r.name)}</b><span class="mail">${MD.esc(r.email)}</span></button>
      <span class="sheet__archivemeta">${r.sectionTitle ? MD.esc(r.sectionTitle) + ' · ' : ''}${MD.esc(recruitPendingReason(r.reason))}</span>
      <span class="interest-when" title="${MD.esc(new Date(Number(r.receivedAt)).toLocaleString())}">${recruitDate(Number(r.receivedAt))}</span>
      <button class="btn" data-action="recruit-queue-place" data-id="${MD.esc(r.id)}" aria-haspopup="menu">Place in…</button>
    </div>`).join('')}</div>
  </section>`;
}

function recruitQueueModalHtml(m) {
  const r = (recruitState().queue?.pending || []).find((row) => row.id === m.id);
  if (!r) return `<div class="modal" role="dialog" aria-label="Held response"><div class="modal__head"><h3>Held response</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div><div class="modal__body"><p>This entry is no longer waiting. Close this window to refresh.</p></div></div>`;
  const fileUrl = `/api/recruit/queue/${encodeURIComponent(r.id)}/file`;
  const questions = Array.isArray(r.questions) ? r.questions : [];
  const has = (key) => questions.some((q) => q.key === key);
  return `<div class="modal modal--wide" role="dialog" aria-label="Held response">
    <div class="modal__head"><h3>${MD.esc(r.name)}</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body">
      <p class="sheet__note">${MD.esc(recruitPendingReason(r.reason))}. Placing it puts these answers on the form${r.reason === 'duplicate' ? ', replacing what that email sent before' : ''}.</p>
      <dl class="interest-detail">
        <dt>Email</dt><dd>${MD.esc(r.email)}</dd>
        ${r.sectionTitle ? `<dt>Form</dt><dd>${MD.esc(r.sectionTitle)}</dd>` : ''}
        ${has('subteam') || r.subteam ? `<dt>Subteam</dt><dd>${MD.esc(r.subteam || 'Undecided')}</dd>` : ''}
        ${has('year') || r.year ? `<dt>Year</dt><dd>${MD.esc(r.year || 'Not provided')}</dd>` : ''}
        <dt>Received</dt><dd>${MD.esc(new Date(Number(r.receivedAt)).toLocaleString())}</dd>
        <dt>Receipt</dt><dd>${MD.esc(r.id)}</dd>
        ${(r.files || []).map((f) => `<dt>${MD.esc(questions.find((q) => q.key === f.question)?.label || f.question || 'File')}</dt><dd><a class="interest-download" href="${MD.esc(f.url)}" download="${MD.esc(f.name)}">${MD.esc(f.name)}</a></dd>`).join('')}
        ${r.fileName ? `<dt>File</dt><dd>${r.fileUrl ? `<a class="interest-download" href="${MD.esc(fileUrl)}" download="${MD.esc(r.fileName)}">${MD.esc(r.fileName)}</a>` : MD.esc(r.fileName)} <span class="faint">${Math.max(1, Math.round((r.fileSize || 0) / 1024))} KB</span></dd>` : ''}
      </dl>
      ${recruitAnswersHtml({ application: { answers: r.answers || {}, files: [], section: r.section }, form: { questions } })}
    </div>
    <div class="modal__foot"><button class="btn" data-action="modal-close">Close</button><button class="btn btn--primary" data-action="recruit-queue-place" data-id="${MD.esc(r.id)}" aria-haspopup="menu">Place in…</button></div>
  </div>`;
}

function recruitOpenQueuePlace(anchor, receipt) {
  const st = recruitState();
  const cycles = (st.cycles?.list || []).filter((c) => c.status === 'open' || c.status === 'draft');
  if (!cycles.length) { toast('Open a cycle first'); return; }
  openMenu(cycles.map((c) => ({ label: c.name, run: () => recruitPlaceQueued(receipt, c) })), anchor);
}

async function recruitPlaceQueued(receipt, cycle) {
  const st = recruitState();
  const key = 'place:' + receipt;
  if (st.busy.has(key)) return;
  st.busy.add(key);
  try {
    await RECRUIT.api(`/recruit/queue/${encodeURIComponent(receipt)}/place`, { method: 'POST', body: JSON.stringify({ requestId: recruitId('rq'), cycleId: cycle.id, confirmUpdate: true }) });
    if (st.queue?.pending) st.queue.pending = st.queue.pending.filter((r) => r.id !== receipt);
    st.cycles = undefined;
    toast(`Placed in ${cycle.name}`);
    if (UI.modal?.kind === 'recruit-queue' && UI.modal.id === receipt) closeModal(() => renderBackground('recruit'));
    else if (!recruitPaintQueue()) renderBackground('recruit');
  } catch (e) { toast(`Could not place: ${recruitError(e)}`); }
  finally { st.busy.delete(key); }
}

/* ------------------------------- new cycle ------------------------------- */

function recruitTermOptions(current) {
  const year = new Date().getFullYear();
  const terms = ['Rolling'];
  for (const y of [year, year + 1]) terms.push(`Spring ${y}`, `Fall ${y}`);
  if (current && !terms.includes(current)) terms.unshift(current);
  return terms.map((t) => ({ value: t, label: t }));
}

function recruitDefaultTerm() {
  const d = new Date();
  return `${d.getMonth() >= 6 ? 'Fall' : 'Spring'} ${d.getFullYear() + (d.getMonth() >= 10 ? 1 : 0)}`;
}

function recruitCycleModalHtml(m) {
  const st = recruitState();
  const list = st.cycles?.list || [];
  const copy = [{ value: '', label: 'The default flow' }, ...list.map((c) => ({ value: c.id, label: `${c.name}'s flow` }))];
  return `<div class="modal" role="dialog" aria-label="New cycle">
    <div class="modal__head"><h3>New cycle</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body rc-form">
      <label>Name<input class="text-input" data-m="recruit-cycle-name" value="${MD.esc(m.name || '')}" placeholder="e.g. Fall 2026" maxlength="80" autocomplete="off" spellcheck="false"></label>
      <label>Term${dd('recruit-cycle-term', recruitTermOptions(m.term), m.term || recruitDefaultTerm())}</label>
      <label>Start from${dd('recruit-cycle-copy', copy, m.copyFrom || '')}</label>
      <p class="rc-set__note">A copy takes that cycle's stages, forms and checklists; its people stay behind.</p>
      <p class="field-error" role="alert" ${m.error ? '' : 'hidden'}>${MD.esc(m.error || '')}</p>
    </div>
    <div class="modal__foot"><button class="btn" data-action="modal-close">Cancel</button><button class="btn btn--primary" data-action="recruit-cycle-create" ${m.busy ? 'disabled' : ''}>${m.busy ? 'Creating…' : 'Create cycle'}</button></div>
  </div>`;
}

async function recruitCreateCycle() {
  const m = UI.modal;
  if (m?.kind !== 'recruit-cycle' || m.busy) return;
  const name = String($('.modal [data-m="recruit-cycle-name"]')?.value || '').trim();
  const term = $('.modal [data-m="recruit-cycle-term"]')?.dataset.value || '';
  const copyFrom = $('.modal [data-m="recruit-cycle-copy"]')?.dataset.value || '';
  Object.assign(m, { name, term, copyFrom });
  const error = $('.modal .field-error');
  const say = (text) => { m.error = text; if (error) { error.textContent = text; error.hidden = !text; } };
  if (!name) { say('A cycle needs a name.'); $('.modal [data-m="recruit-cycle-name"]')?.focus(); return; }
  m.requestId ||= recruitId('rq');
  m.busy = true;
  say('');
  const go = $('.modal [data-action="recruit-cycle-create"]');
  if (go) { go.disabled = true; go.textContent = 'Creating…'; }
  try {
    const out = await RECRUIT.api('/recruit/cycles', { method: 'POST', body: JSON.stringify({ requestId: m.requestId, name, term, copyFrom: copyFrom || undefined }) });
    const st = recruitState();
    st.cycles = undefined;
    if (UI.modal === m) closeModal(() => { nav(recruitPanelHref(out.cycle?.id || '', 'flow')); if (!out.cycle?.id) renderBackground('recruit'); });
    toast(`Created ${name}`);
  } catch (e) {
    m.busy = false;
    if (UI.modal === m) { say(recruitError(e)); if (go) { go.disabled = false; go.textContent = 'Create cycle'; } }
  }
}

/* ------------------------------- migration ------------------------------- */

// Explicit, idempotent, resumable: the server answers each step with the
// next one; repeating a finished step changes nothing.
async function recruitRunMigration() {
  const st = recruitState();
  if (!recruitIsAdmin() || st.busy.has('migrate')) return;
  st.busy.add('migrate');
  const note = $('[data-rc="migrate"]');
  const button = $('[data-action="recruit-migrate"]');
  if (button) button.disabled = true;
  const say = (text) => { const el = $('[data-rc="migrate"]') || note; if (el) el.textContent = text; };
  say('Importing…');
  let step = { step: 'live' }, n = 0;
  try {
    for (;;) {
      const out = await RECRUIT.api('/recruit/migrate', { method: 'POST', body: JSON.stringify({ requestId: recruitId('rq'), ...step }), signal: AbortSignal.timeout(60000) });
      if (out.done || !out.next) break;
      step = out.next;
      n += 1;
      say(`Importing… archive ${n}`);
      if (n > 500) throw new Error('Too many steps');
    }
    st.cycles = undefined;
    st.busy.delete('migrate');
    toast('Imported the current list and archives');
    renderBackground('recruit');
  } catch (e) {
    st.busy.delete('migrate');
    say(`Import stopped: ${recruitError(e)} Run it again to resume.`);
    if ($('[data-action="recruit-migrate"]')) $('[data-action="recruit-migrate"]').disabled = false;
    toast(`Import stopped: ${recruitError(e)}`);
  }
}

function recruitOpenAdopt(anchor) {
  const st = recruitState();
  const open = (st.cycles?.list || []).filter((c) => c.status === 'open' || c.status === 'draft');
  if (!open.length) { toast('Create or open a cycle first'); return; }
  openMenu(open.map((c) => ({ label: c.name, run: () => recruitAdopt(c.id, c.name) })), anchor);
}

async function recruitAdopt(cycleId, name) {
  const st = recruitState();
  if (st.busy.has('adopt')) return;
  st.busy.add('adopt');
  try {
    const out = await RECRUIT.api('/recruit/migrate/adopt', { method: 'POST', body: JSON.stringify({ requestId: recruitId('rq'), cycleId }) });
    st.cycles = undefined;
    toast(`Adopted ${recruitPlural(out.adopted || 0, 'submission')} into ${name}`);
  } catch (e) { toast(`Could not adopt: ${recruitError(e)}`); }
  finally { st.busy.delete('adopt'); renderBackground('recruit'); }
}

/* ------------------------------- cycle tools ----------------------------- */

const RECRUIT_STATUS_NEXT = {
  draft: [{ status: 'open', label: 'Open cycle' }],
  open: [{ status: 'closed', label: 'Close cycle…', confirm: true }],
  closed: [{ status: 'open', label: 'Reopen cycle' }, { status: 'archived', label: 'Archive cycle…', confirm: true }],
  archived: [{ status: 'closed', label: 'Unarchive cycle' }],
};

function recruitStatusChoices(cycle, roles = recruitMyRoles()) {
  const admin = roles.includes('admin');
  return (RECRUIT_STATUS_NEXT[cycle?.status] || []).filter((x) => admin || (['open', 'closed'].includes(x.status) && cycle.status !== 'archived'));
}

function recruitOpenCycleTools(anchor) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  if (!cycle) return;
  const roles = recruitMyRoles();
  const admin = recruitCan('admin', roles);
  const items = [{ label: 'Refresh', run: () => { const id = cycle.id; st.cycles = undefined; RECRUIT.reset(id); render(); } }];
  if (recruitCan('lead', roles)) items.push({ label: 'Export people (CSV)', run: () => { location.href = `/api/recruit/cycles/${encodeURIComponent(cycle.id)}/people.csv?columns=full`; } });
  if (admin) items.push({ label: 'Sync queue', run: () => { st.queue = undefined; recruitLoadQueue(true); toast('Checking saved submissions…'); } });
  if (admin) items.push({ label: 'Check storage', run: recruitCheckStorage });
  openMenu(items, anchor);
}

async function recruitCheckStorage() {
  try {
    await RECRUIT.api('/recruit/storage-check', { method: 'POST', body: '{}' });
    toast('Database and submission backup storage are working');
  } catch (e) { toast(`Storage check failed: ${recruitError(e)}`); }
}

function recruitSetStatus(status, confirm) {
  const cycle = recruitCycleRow();
  if (!cycle) return;
  const go = async () => {
    const st = recruitState();
    if (st.busy.has('status')) return;
    st.busy.add('status');
    try {
      const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/status`, { method: 'POST', body: JSON.stringify({ version: cycle.version, status }) });
      if (st.cycle?.data?.id === cycle.id && out.cycle) st.cycle.data = out.cycle;
      if (st.cycles?.list) {
        st.cycles.list = st.cycles.list.map((c) => (c.id === cycle.id && out.cycle ? { ...c, status: out.cycle.status, version: out.cycle.version } : c));
        if (status !== 'open' && st.cycles.intakeCycleId === cycle.id) st.cycles.intakeCycleId = null;
      }
      toast(status === 'open' ? 'Cycle is open' : status === 'closed' ? 'Cycle closed' : status === 'archived' ? 'Cycle archived' : 'Status updated');
    } catch (e) { recruitVersionToast(e, cycle.id); }
    finally { st.busy.delete('status'); recruitAfterSettings(); }
  };
  if (!confirm) { go(); return; }
  const st = recruitState();
  const intake = st.cycles?.intakeCycleId === cycle.id;
  UI.modal = {
    kind: 'confirm',
    title: status === 'archived' ? `Archive ${cycle.name}?` : `Close ${cycle.name}?`,
    text: status === 'archived'
      ? `Archived cycles are read-only. ${intake ? "The website's forms stop landing here. " : ''}You can unarchive it later.`
      : `Closed cycles stop taking responses.${intake ? " The website's forms stop landing here until another cycle receives them." : ''}`,
    confirm: status === 'archived' ? 'Archive cycle' : 'Close cycle',
    onGo: go,
  };
  render();
}

function recruitConfirmDeleteCycle() {
  const cycle = recruitCycleRow();
  if (!cycle || !recruitCan('admin')) return;
  UI.modal = {
    kind: 'confirm', title: `Delete ${cycle.name}?`, danger: true, typed: 'delete cycle', confirm: 'Delete cycle',
    text: `Every response, comment, flag, checklist entry and role in <b>${MD.esc(cycle.name)}</b> is erased for good. Export the CSVs first if you want a record.`,
    onGo: async () => {
      const st = recruitState();
      try {
        await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}`, { method: 'DELETE', signal: AbortSignal.timeout(60000) });
        st.cycles = undefined;
        RECRUIT.reset(null);
        toast(`Deleted ${cycle.name}`);
        nav('#/applications?all=1');
      } catch (e) { toast(`Could not delete: ${recruitError(e)}`); }
    },
  };
  render();
}

/* ------------------------------- settings dialog ------------------------- */

// Settings open from the gear beside the cycle's name, in one glass dialog:
// about, status, subteams, who can review; archive and delete in the foot.
function recruitSettingsBodyHtml(cycle, role) {
  const sections = RECRUIT.settingsSections(cycle, role);
  if (!sections.length) return `<div class="empty">${I.info}<b>No settings for your role</b></div>`;
  return sections.map((s) => {
    let inner = '';
    try { inner = String(s.view?.(cycle, role) ?? ''); } catch (e) { console.error(e); inner = `<p class="field-error" role="alert">Could not draw this section.</p>`; }
    const head = s.heading === false ? '' : `<h4 class="rc-set__title" id="rc-set-${MD.esc(s.id)}-h">${MD.esc(s.label || s.id)}</h4>`;
    const named = head ? `aria-labelledby="rc-set-${MD.esc(s.id)}-h"` : `aria-label="${MD.esc(s.label || s.id)}"`;
    return `<section class="rc-set" id="rc-set-${MD.esc(s.id)}" ${named}>${head}${inner}</section>`;
  }).join('');
}

function recruitSettingsModalHtml() {
  const cycle = recruitCycleRow();
  const role = recruitRole();
  if (!cycle) return `<div class="modal" role="dialog" aria-label="Settings unavailable"><div class="modal__head"><h3>Settings unavailable</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div><div class="modal__body"><p>Open a cycle first.</p></div></div>`;
  const admin = recruitCan('admin');
  const foot = [
    admin && (cycle.status === 'archived' || cycle.status === 'draft') ? `<button class="btn btn--ghost rc-settings__delete" data-action="recruit-cycle-delete">Delete cycle…</button>` : '',
    admin && cycle.status === 'closed' ? `<button class="btn btn--ghost" data-action="recruit-status" data-status="archived" data-confirm="1">Archive cycle…</button>` : '',
    admin && cycle.status === 'archived' ? `<button class="btn btn--ghost" data-action="recruit-status" data-status="closed">Unarchive cycle</button>` : '',
  ].filter(Boolean).join('');
  return `<div class="modal modal--wide rc-settings" role="dialog" aria-label="Settings for ${MD.esc(cycle.name)}">
    <div class="modal__head"><h3>${MD.esc(cycle.name)}</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body" data-rc="settings-body">${recruitSettingsBodyHtml(cycle, role)}</div>
    <div class="modal__foot modal__foot--split">${foot}<button class="btn" data-action="modal-close">Close</button></div>
  </div>`;
}

// The open dialog follows every save without a remount.
function recruitPaintSettings() {
  if (UI.modal?.kind !== 'recruit-settings') return false;
  const dialog = $('.rc-settings');
  if (!dialog) return false;
  const fresh = document.createElement('div');
  fresh.innerHTML = recruitSettingsModalHtml();
  const was = [...$$('.rc-seg--status button', dialog)].findIndex((b) => b.getAttribute('aria-current') === 'page');
  recruitRepaint(dialog, fresh.firstElementChild ? fresh.firstElementChild.innerHTML : fresh.innerHTML);
  const seg = $('.rc-seg--status', dialog);
  if (seg && was >= 0) seg.dataset.segFrom = String(was);
  recruitSegSlide(seg);
  return true;
}

// After a change made from the dialog: the dialog repaints now, the page
// behind it when the dialog closes.
function recruitAfterSettings() {
  recruitPaintSettings();
  renderBackground('recruit');
}

function recruitOpenSettings() {
  const cycle = recruitCycleRow(), role = recruitRole();
  if (!cycle || !recruitCan('lead')) return;
  UI.modal = { kind: 'recruit-settings' };
  render();
  recruitSegSlide($('.rc-seg--status'));
  for (const s of RECRUIT.settingsSections(cycle, role)) { try { s.mount?.(cycle, role); } catch (e) { console.error(e); } }
}

/* ------------------------------- who can review -------------------------- */

const RECRUIT_ROLE_LABELS = { lead: 'Lead', reviewer: 'Reviewer', interviewer: 'Interviewer' };

function recruitLoadRoles() {
  const st = recruitState();
  const cycle = recruitCycleRow();
  if (!cycle) return;
  st.mod.roles = { key: st.key + ':' + cycle.id, loading: true, error: null, roles: [], members: [] };
  const box = st.mod.roles, key = st.key;
  RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/roles`)
    .then((out) => { if (st.key !== key || st.mod.roles !== box) return; box.roles = Array.isArray(out.roles) ? out.roles : []; box.members = Array.isArray(out.members) ? out.members : []; box.loading = false; recruitPaintRoles(); })
    .catch((e) => { if (st.key !== key || st.mod.roles !== box) return; box.loading = false; box.error = recruitError(e); recruitPaintRoles(); });
}

function recruitRolesBodyHtml() {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const box = st.mod.roles;
  const admin = recruitCan('admin');
  if (!box || box.loading) return '<p class="sheet__note">Loading…</p>';
  if (box.error) return `<p class="sheet__note">Could not load: ${MD.esc(box.error)}. <button class="linklike" data-action="recruit-roles-retry">Retry</button></p>`;
  const rows = box.roles.map((g) => `<div class="rc-role" data-member="${MD.esc(g.member)}">
      <div><b>${MD.esc(g.name || g.member)}</b>${g.name ? `<span class="mail">${MD.esc(g.member)}</span>` : ''}</div>
      <span class="rc-role__roles">${MD.esc((g.roles || []).map((r) => RECRUIT_ROLE_LABELS[r] || r).join(', '))}</span>
      ${admin ? `<button type="button" class="icon-btn" data-action="recruit-role-remove" data-member="${MD.esc(g.member)}" aria-label="Remove ${MD.esc(g.name || g.member)}">${I.x}</button>` : ''}
    </div>`).join('');
  const taken = new Set(box.roles.map((g) => g.member));
  const members = box.members.filter((m) => !taken.has(m.email)).sort((x, y) => String(x.name || x.email).localeCompare(String(y.name || y.email)))
    .map((m) => ({ value: m.email, label: m.name ? `${m.name} · ${m.email}` : m.email }));
  const roleChoices = [{ value: 'reviewer', label: 'Reviewer' }, ...(admin ? [{ value: 'lead', label: 'Lead' }] : [])];
  const add = cycle?.status === 'archived' ? '' : members.length
    ? `<form class="rc-roles__add" data-action="recruit-role-form" aria-label="Add a reviewer">${dd('recruit-role-member', members, members[0].value)}${dd('recruit-role-role', roleChoices, 'reviewer')}<button type="submit" class="btn btn--primary">Add</button></form>`
    : '<p class="rc-set__note">Everyone on the wiki roster already has a role here.</p>';
  return `<p class="rc-set__note">Admins can do everything in every cycle. Leads edit the flow and move people; reviewers read, comment and fill in checklists.</p>
    <div class="rc-roles__list">${rows || '<p class="rc-set__note">Nobody yet besides admins.</p>'}</div>${add}`;
}

function recruitRolesModalHtml() {
  const cycle = recruitCycleRow();
  return `<div class="modal rc-roles" role="dialog" aria-label="Who can review ${MD.esc(cycle?.name || '')}">
    <div class="modal__head"><h3>Who can review</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body" data-rc="roles-body">${recruitRolesBodyHtml()}</div>
    <div class="modal__foot modal__foot--split"><button class="btn btn--ghost" data-action="recruit-settings-open">Back to settings</button><button class="btn" data-action="modal-close">Close</button></div>
  </div>`;
}

function recruitPaintRoles() {
  if (UI.modal?.kind !== 'recruit-roles') return false;
  const body = $('.rc-roles [data-rc="roles-body"]');
  if (!body) return false;
  recruitRepaint(body, recruitRolesBodyHtml());
  return true;
}

// The cycle's grants and team follow the dialog.
function recruitSyncGrants() {
  const st = recruitState();
  if (!st.cycle || !st.mod.roles) return;
  st.cycle.grants = st.mod.roles.roles.map((g) => ({ member: g.member, roles: g.roles, subteams: g.subteams || [] }));
  const team = new Map((st.cycle.team || []).map((m) => [m.email, m]));
  for (const g of st.mod.roles.roles) if (!team.has(g.member)) team.set(g.member, { email: g.member, name: g.name || '' });
  st.cycle.team = [...team.values()].sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
}

async function recruitAddRole(form) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const member = $('[data-m="recruit-role-member"]', form)?.dataset.value;
  const role = $('[data-m="recruit-role-role"]', form)?.dataset.value || 'reviewer';
  if (!cycle || !member || st.busy.has('role')) return;
  st.busy.add('role');
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/roles/${encodeURIComponent(member)}`, { method: 'PUT', body: JSON.stringify({ requestId: recruitId('rq'), roles: [role], subteams: [] }) });
    const box = st.mod.roles;
    if (box && out.role) {
      const name = box.members.find((m) => m.email === member)?.name || '';
      box.roles = [...box.roles.filter((g) => g.member !== member), { ...out.role, name }];
      recruitSyncGrants();
    }
    form.dataset.adminDirty = 'false';
    toast(`${RECRUIT_ROLE_LABELS[role] || role} added`);
  } catch (e) { toast(`Could not add: ${recruitError(e)}`); }
  finally { st.busy.delete('role'); recruitPaintRoles(); }
}

async function recruitRemoveRole(member) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  if (!cycle || !member || !recruitCan('admin') || st.busy.has('role')) return;
  st.busy.add('role');
  try {
    await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/roles/${encodeURIComponent(member)}`, { method: 'DELETE' });
    // Admins stay on the team without a grant.
    const admin = Boolean(st.mod.roles?.members.find((m) => m.email === member)?.admin);
    if (st.mod.roles) { st.mod.roles.roles = st.mod.roles.roles.filter((g) => g.member !== member); recruitSyncGrants(); }
    if (st.cycle?.team && !admin) st.cycle.team = st.cycle.team.filter((m) => m.email !== member);
    toast('Removed');
  } catch (e) { toast(`Could not remove: ${recruitError(e)}`); }
  finally { st.busy.delete('role'); recruitPaintRoles(); }
}

const recruitDateInput = (ts) => ts ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Number(ts))) : '';

function recruitParseDate(text, endOfDay = false) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return NaN;
  const date = new Date(t + 'T12:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== t) return NaN;
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(date).find((part) => part.type === 'timeZoneName').value;
  const hours = Number(offset.replace('GMT', ''));
  return Date.parse(t + (endOfDay ? 'T23:59:59.999Z' : 'T00:00:00Z')) - hours * 3600000;
}

function recruitFormField(label, inner, note) {
  return `<label class="rc-field">${MD.esc(label)}${inner}${note ? `<span class="sub">${MD.esc(note)}</span>` : ''}</label>`;
}

const RECRUIT_SETTINGS = [
  {
    id: 'about', label: 'About', heading: false, when: () => recruitCan('lead'),
    view: (cycle) => `<form class="rc-form" data-action="recruit-settings-about">
      ${recruitFormField('Name', `<input class="text-input" name="name" value="${MD.esc(cycle.name || '')}" maxlength="80" required autocomplete="off" spellcheck="false">`)}
      ${recruitFormField('Deadline (11:59 PM Eastern)', `<input class="text-input" name="closesAt" value="${MD.esc(recruitDateInput(cycle.closesAt))}" placeholder="YYYY-MM-DD" maxlength="10" autocomplete="off" spellcheck="false">`)}
      <div class="rc-form__foot"><button type="submit" class="btn btn--primary">Save</button></div>
    </form>`,
    submit: async (form, cycle) => {
      const closesAt = recruitParseDate(form.elements.closesAt?.value, true);
      if (Number.isNaN(closesAt)) throw new Error('The deadline is a date, YYYY-MM-DD.');
      const name = String(form.elements.name.value || '').trim();
      if (!name) throw new Error('A cycle needs a name.');
      const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}`, { method: 'PATCH', body: JSON.stringify({ version: cycle.version, name, closesAt }) });
      recruitAdoptCycle(out.cycle);
      form.dataset.adminDirty = 'false';
      toast('Saved');
      recruitAfterSettings();
    },
  },
  {
    id: 'status', label: 'Status', when: () => recruitCan('lead'),
    view: (cycle) => {
      const st = recruitState();
      const roles = recruitMyRoles();
      const choices = recruitStatusChoices(cycle, roles);
      const seg = [['draft', 'Draft'], ['open', 'Open'], ['closed', 'Closed']].map(([status, label]) => {
        const current = cycle.status === status;
        const move = choices.find((x) => x.status === status);
        return `<button type="button" data-action="recruit-status-set" data-status="${status}" data-confirm="${move?.confirm ? '1' : ''}" aria-current="${current ? 'page' : 'false'}" ${current || move ? '' : 'disabled'}>${label}</button>`;
      }).join('');
      const current = st.cycles?.intakeCycleId || null;
      const receiving = current === cycle.id;
      const holder = current && !receiving ? (st.cycles?.list || []).find((c) => c.id === current) : null;
      const canToggle = recruitCan('admin') && (receiving || cycle.status === 'open');
      // A note only when the box cannot simply be ticked.
      const note = receiving ? ''
        : holder ? `${holder.name} receives them now. Only one cycle can.`
        : cycle.status !== 'open' ? 'Open the cycle first.'
        : '';
      return `<nav class="rc-seg rc-seg--status" aria-label="Status"><span class="rc-seg__thumb" aria-hidden="true"></span>${seg}</nav>
        ${cycle.status === 'archived' ? `<p class="rc-set__note">Archived and read only${cycle.closedAt ? `, closed ${MD.esc(recruitDate(Number(cycle.closedAt)))}` : ''}. Unarchive it below to change anything.</p>` : ''}
        <label class="rc-check rc-set__website"><input type="checkbox" data-action="recruit-website-toggle" ${receiving ? 'checked' : ''} ${canToggle ? '' : 'disabled'}> This cycle receives the forms on the website</label>
        ${note ? `<p class="rc-set__note">${MD.esc(note)}</p>` : ''}`;
    },
  },
  {
    id: 'subteams', label: 'Subteams', when: () => recruitCan('lead'),
    view: (cycle) => {
      const teams = recruitSubteams(cycle);
      return `<form class="rc-form rc-form--rows" data-action="recruit-settings-subteams">
        <div class="rc-rows" data-rc="subteam-rows">${teams.map((t) => recruitSubteamRowHtml(t)).join('')}</div>
        <div class="rc-form__foot"><button type="button" class="btn" data-action="recruit-subteam-add">${I.plus} Add subteam</button><button type="submit" class="btn btn--primary">Save</button></div>
      </form>`;
    },
    submit: async (form, cycle) => {
      const rows = $$('.rc-row', form);
      const settings = [], seen = new Set();
      for (const row of rows) {
        const name = String($('[name="name"]', row)?.value || '').trim();
        if (!name) continue;
        const key = row.dataset.key || recruitSlug(name);
        if (!key || seen.has(key)) throw new Error(`Two subteams share the key "${key}".`);
        seen.add(key);
        settings.push({ key, name });
      }
      await recruitPutSettings(cycle, 'subteams', settings);
      form.dataset.adminDirty = 'false';
      toast('Subteams saved');
      recruitAfterSettings();
    },
  },
  {
    id: 'review', label: 'Who can review', when: () => recruitCan('lead'),
    view: () => {
      const grants = recruitState().cycle?.grants || [];
      const n = grants.length;
      return `<div class="rc-set__row"><span>${n ? `${MD.esc(recruitPlural(n, 'person', 'people'))} besides admins` : 'Admins only so far'}</span><button type="button" class="btn" data-action="recruit-roles-open">Manage</button></div>`;
    },
  },
];

function recruitSubteamRowHtml(t = {}) {
  return `<div class="rc-row" data-key="${MD.esc(t.key || '')}">
    <input class="text-input" name="name" value="${MD.esc(t.name || '')}" placeholder="Subteam" maxlength="40" aria-label="Subteam name" autocomplete="off" spellcheck="false">
    <button type="button" class="icon-btn" data-action="recruit-subteam-remove" aria-label="Remove ${MD.esc(t.name || 'subteam')}">${I.x}</button>
  </div>`;
}

const recruitSlug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);

async function recruitPutSettings(cycle, module, settings) {
  const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/settings/${module}`, { method: 'PUT', body: JSON.stringify({ version: cycle.version, settings }) });
  recruitAdoptCycle(out.cycle, out.sections);
  return out;
}

async function recruitToggleIntake(on) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  if (!cycle || !recruitCan('admin') || st.busy.has('intake')) return;
  st.busy.add('intake');
  try {
    const body = { on: Boolean(on) };
    if (st.cycles?.settingsVersion !== null && st.cycles?.settingsVersion !== undefined) body.version = st.cycles.settingsVersion;
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/intake`, { method: 'POST', body: JSON.stringify(body) });
    if (st.cycles) { st.cycles.intakeCycleId = out.intakeCycleId || null; if (out.settingsVersion !== undefined) st.cycles.settingsVersion = out.settingsVersion; }
    toast(on ? `${cycle.name} receives the website's forms` : 'No cycle receives the website\'s forms now');
  } catch (e) { recruitVersionToast(e, cycle.id); }
  finally { st.busy.delete('intake'); recruitAfterSettings(); }
}

/* ------------------------------- register -------------------------------- */

RECRUIT.register({
  name: 'cycles',
  order: 0,
  kernel: true,
  actions: {
    'recruit-settings-open': recruitOpenSettings,
    'recruit-status-set': (el) => { if (el.getAttribute('aria-current') === 'page' || el.disabled) return; recruitSetStatus(el.dataset.status, Boolean(el.dataset.confirm)); },
    'recruit-website-toggle': (el) => recruitToggleIntake(Boolean(el.checked)),
    'recruit-roles-open': () => { const st = recruitState(); UI.modal = { kind: 'recruit-roles' }; render(); if (!st.mod.roles || st.mod.roles.key !== st.key + ':' + recruitCycleRow()?.id) recruitLoadRoles(); },
    'recruit-roles-retry': () => recruitLoadRoles(),
    'recruit-role-form': (form) => recruitAddRole(form),
    'recruit-role-remove': (el) => recruitRemoveRole(el.dataset.member),
    'recruit-refresh': () => { const st = recruitState(); UI.recruitMe = undefined; st.me = undefined; st.cycles = undefined; RECRUIT.reset(st.cycleId); render(); },
    'recruit-cycle-new': () => { UI.modal = { kind: 'recruit-cycle' }; render(); $('.modal [data-m="recruit-cycle-name"]')?.focus(); },
    'recruit-cycle-create': recruitCreateCycle,
    'recruit-migrate': recruitRunMigration,
    'recruit-adopt': (el) => recruitOpenAdopt(el),
    'recruit-queue-sync': () => { const st = recruitState(); st.queue = undefined; recruitLoadQueue(true); },
    'recruit-queue-open': (el) => { UI.modal = { kind: 'recruit-queue', id: el.dataset.id }; render(); },
    'recruit-queue-place': (el) => recruitOpenQueuePlace(el, el.dataset.id),
    'recruit-cycle-tools': (el) => recruitOpenCycleTools(el),
    'recruit-status': (el) => recruitSetStatus(el.dataset.status, Boolean(el.dataset.confirm)),
    'recruit-cycle-delete': recruitConfirmDeleteCycle,
    'recruit-subteam-add': (el) => {
      const rows = $('[data-rc="subteam-rows"]', el.closest('form'));
      if (!rows) return;
      rows.insertAdjacentHTML('beforeend', recruitSubteamRowHtml());
      el.closest('form').dataset.adminDirty = 'true';
      $$('.rc-row [name="name"]', rows).at(-1)?.focus();
    },
    'recruit-subteam-remove': (el) => {
      const form = el.closest('form'), row = el.closest('.rc-row');
      if (!row) return;
      const rows = row.parentElement;
      row.remove();
      if (form) form.dataset.adminDirty = 'true';
      ($$('.rc-row [name="name"]', rows).at(-1) || $('[data-action="recruit-subteam-add"]', form))?.focus();
    },
  },
  dd: {
    'recruit-cycle-switch': (host, value) => { if (value !== undefined && value !== recruitCycleRow()?.id) { const sub = UI.route?.params?.sub; nav(recruitPanelHref(value, ['flow', 'people', 'insights'].includes(sub) ? sub : '')); } },
  },
  modals: {
    'recruit-cycle': recruitCycleModalHtml, 'recruit-settings': recruitSettingsModalHtml, 'recruit-roles': recruitRolesModalHtml, 'recruit-queue': recruitQueueModalHtml,
    'recruit-copy': (m) => `<div class="modal" role="dialog" aria-label="Copy">
      <div class="modal__head"><h3>Copy</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
      <div class="modal__body"><p>Clipboard access was blocked. Select and copy the text.</p>
        <textarea class="text-input" rows="6" readonly aria-label="Text to copy">${MD.esc(m.text || '')}</textarea>
      </div><div class="modal__foot"><button class="btn" data-action="modal-close">Close</button></div>
    </div>`,
  },
  settings: RECRUIT_SETTINGS,
  reset() {},
});

// recruit:cycles:end
