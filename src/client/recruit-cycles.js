/* ============================================================================
   Applications — cycles module (client). The cycle index, the New cycle
   dialog, the migration and adopt actions, the cycle tools menu, and the
   Settings panel that hosts every module's settings sections.
   ========================================================================== */

'use strict';

// recruit:cycles:start

/* ------------------------------- index ----------------------------------- */

function recruitCycleRowHtml(c, intakeCycleId) {
  const by = c.counts?.bySection || {};
  const meta = [c.term && c.term !== c.name ? c.term : '', recruitStatusText(c, intakeCycleId), `${Number(by.interest || 0)} interest`, recruitPlural(by.coffee || 0, 'coffee chat'), recruitPlural(by.application || 0, 'application'), c.updated ? 'updated ' + recruitDate(Number(c.updated)) : ''].filter(Boolean).join(' · ');
  return `<div class="sheet__archive">
    <button class="sheet__archivename" data-action="recruit-cycle-open" data-id="${MD.esc(c.id)}"><span class="sheet__archivetitle">${MD.esc(c.name)}</span>
      <span class="sheet__archivemeta">${MD.esc(meta)}</span></button>
  </div>`;
}

function recruitIndexHtml() {
  const st = recruitState();
  const admin = recruitIsAdmin();
  const head = `<div class="plain-head"><h1>Applications</h1></div>`;
  const cy = st.cycles;
  if (!cy || cy.loading) return head + '<p class="sheet__note">Loading…</p>';
  if (cy.error) return head + `<p class="sheet__note">Could not load: ${MD.esc(cy.error)}. <button class="linklike" data-action="recruit-refresh">Retry</button></p>`;
  const list = cy.list || [];
  const live = list.filter((c) => c.status !== 'archived');
  const archived = list.filter((c) => c.status === 'archived');
  const tools = admin ? `<div class="rc-index__tools"><button class="btn btn--sm" data-action="recruit-cycle-new">${I.plus} New cycle</button></div>` : '';
  const liveBlock = live.length
    ? `<div class="sheet sheet--list">${live.map((c) => recruitCycleRowHtml(c, cy.intakeCycleId)).join('')}</div>`
    : `<div class="sheet sheet--list"><div class="sheet__archive"><span class="sheet__archivemeta">${admin ? 'No cycle yet. Create one to start receiving applications.' : 'No open cycle.'}</span></div></div>`;
  const archivedBlock = archived.length
    ? `<h2 class="sheet__heading">Archived</h2><div class="sheet sheet--list">${archived.map((c) => recruitCycleRowHtml(c, cy.intakeCycleId)).join('')}</div>`
    : '';
  return head + tools + liveBlock + archivedBlock + `<div data-rc="queue">${recruitAttentionHtml()}</div>`;
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
      <button class="btn btn--sm" data-action="recruit-migrate" ${busy ? 'disabled' : ''}>Import the current list and archives</button></div>`);
  }
  if (mig?.done && mig.orphans > 0) {
    items.push(`<div class="sheet__archive"><span class="sheet__archivemeta">${MD.esc(recruitPlural(mig.orphans, 'submission'))} arrived while no cycle was receiving the form</span>
      <button class="btn btn--sm" data-action="recruit-adopt" aria-haspopup="menu" ${st.busy.has('adopt') ? 'disabled' : ''}>Adopt into…</button></div>`);
  }
  const pending = st.queue?.pending?.length || 0;
  if (pending) items.push(`<div class="sheet__archive"><span class="sheet__archivemeta">${MD.esc(recruitPlural(pending, 'saved submission'))} waiting to join a list</span>
    <button class="btn btn--sm" data-action="recruit-queue-sync">Sync queue</button></div>`);
  if (st.queue?.queueUnavailable) items.push(`<div class="sheet__archive"><span class="sheet__archivemeta">Could not check the saved-submission queue.</span><button class="btn btn--sm" data-action="recruit-queue-sync">Retry</button></div>`);
  if (!items.length) return '';
  return `<h2 class="sheet__heading">Needs attention</h2><div class="sheet sheet--list">${items.join('')}</div>`;
}

// The index's queue block repaints through the same hook the panel uses.
function recruitQueueHtml() {
  return typeof recruitPendingHtml === 'function' && recruitCycleRow() ? recruitPendingHtml() : recruitAttentionHtml();
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
  const copy = [{ value: '', label: 'Start from the defaults' }, ...list.map((c) => ({ value: c.id, label: c.name }))];
  return `<div class="modal" role="dialog" aria-label="New cycle">
    <div class="modal__head"><h3>New cycle</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body">
      <label>Name<input class="text-input" data-m="recruit-cycle-name" value="${MD.esc(m.name || '')}" placeholder="e.g. Fall 2026" maxlength="80" autocomplete="off" spellcheck="false"></label>
      <label>Term${dd('recruit-cycle-term', recruitTermOptions(m.term), m.term || recruitDefaultTerm())}</label>
      <label>Settings${dd('recruit-cycle-copy', copy, m.copyFrom || '')}</label>
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
    if (UI.modal === m) closeModal(() => { nav(recruitPanelHref(out.cycle?.id || '', 'settings')); if (!out.cycle?.id) renderBackground('recruit'); });
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
  const lead = recruitCan('lead', roles), admin = recruitCan('admin', roles);
  const items = [{ label: 'Refresh', run: () => { const id = cycle.id; st.cycles = undefined; RECRUIT.reset(id); render(); } }];
  if (admin) items.push({ label: 'Sync queue', run: () => { st.queue = undefined; recruitLoadQueue(true); toast('Checking saved submissions…'); } });
  if (admin) items.push({ label: 'Check storage', run: recruitCheckStorage });
  const moves = recruitStatusChoices(cycle, roles);
  if (moves.length) items.push('-', ...moves.map((x) => ({ label: x.label, run: () => recruitSetStatus(x.status, x.confirm) })));
  if (admin && (cycle.status === 'archived' || cycle.status === 'draft')) items.push('-', { label: 'Delete cycle…', danger: true, icon: I.trash, run: recruitConfirmDeleteCycle });
  openMenu(items, anchor);
}

async function recruitCheckStorage() {
  try {
    await RECRUIT.api('/recruit/storage-check', { method: 'POST', body: '{}' });
    toast('Submission backup storage is working');
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
      st.cycles = undefined;
      toast(status === 'open' ? 'Cycle is open' : status === 'closed' ? 'Cycle closed' : status === 'archived' ? 'Cycle archived' : 'Status updated');
    } catch (e) { recruitVersionToast(e, cycle.id); }
    finally { st.busy.delete('status'); renderBackground('recruit'); }
  };
  if (!confirm) { go(); return; }
  const st = recruitState();
  const intake = st.cycles?.intakeCycleId === cycle.id;
  UI.modal = {
    kind: 'confirm',
    title: status === 'archived' ? `Archive ${cycle.name}?` : `Close ${cycle.name}?`,
    text: status === 'archived'
      ? `Archived cycles are read-only. ${intake ? 'The website form stops landing here. ' : ''}You can unarchive it later.`
      : `Closed cycles stop taking applications.${intake ? ' The website form stops landing here until another cycle receives it.' : ''}`,
    confirm: status === 'archived' ? 'Archive cycle' : 'Close cycle',
    onGo: go,
  };
  render();
}

function recruitVersionToast(e, cycleId) {
  if (e?.status === 409) toast(recruitError(e), { label: 'Reload', run: () => { const st = recruitState(); st.cycles = undefined; RECRUIT.reset(cycleId); render(); } });
  else toast(recruitError(e));
}

function recruitConfirmDeleteCycle() {
  const cycle = recruitCycleRow();
  if (!cycle || !recruitCan('admin')) return;
  UI.modal = {
    kind: 'confirm', title: `Delete ${cycle.name}?`, danger: true, typed: 'delete cycle', confirm: 'Delete cycle',
    text: `Every application, score, interview, email record and role in <b>${MD.esc(cycle.name)}</b> is erased for good. Export the CSV first if you want a record.`,
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

/* ------------------------------- settings panel -------------------------- */

function recruitSettingsPanelHtml(cycle, role) {
  const sections = RECRUIT.settingsSections(cycle, role);
  if (!sections.length) return `<div class="empty">${I.info}<b>No settings for your role</b></div>`;
  return `<div class="admin-grid rc-settings">${sections.map((s) => {
    let inner = '';
    try { inner = String(s.view?.(cycle, role) ?? ''); } catch (e) { console.error(e); inner = `<p class="field-error" role="alert">Could not draw this section.</p>`; }
    return `<section class="admin-block" id="rc-settings-${MD.esc(s.id)}" aria-labelledby="rc-settings-${MD.esc(s.id)}-h">
      <div class="admin-block__head"><h2 id="rc-settings-${MD.esc(s.id)}-h">${MD.esc(s.label || s.id)}</h2></div>${inner}</section>`;
  }).join('')}</div>`;
}

const recruitDateInput = (ts) => (ts ? new Date(Number(ts)).toISOString().slice(0, 10) : '');

// 'YYYY-MM-DD' text → epoch ms at local midnight, null when blank, NaN when bad.
function recruitParseDate(text, endOfDay = false) {
  const t = String(text || '').trim();
  if (!t) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return NaN;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  return d.getMonth() === Number(m[2]) - 1 ? d.getTime() : NaN;
}

function recruitFormField(label, inner, note) {
  return `<label class="rc-field">${MD.esc(label)}${inner}${note ? `<span class="sub">${MD.esc(note)}</span>` : ''}</label>`;
}

const RECRUIT_SETTINGS = [
  {
    id: 'cycle', label: 'Cycle', when: (c, role) => recruitCan('lead'),
    view: (cycle) => `<form class="rc-form" data-action="recruit-settings-cycle">
      ${recruitFormField('Name', `<input class="text-input" name="name" value="${MD.esc(cycle.name || '')}" maxlength="80" required autocomplete="off" spellcheck="false">`)}
      ${recruitFormField('Term', dd('recruit-term', recruitTermOptions(cycle.term), cycle.term || 'Rolling'))}
      ${recruitFormField('Opens', `<input class="text-input" name="opensAt" value="${MD.esc(recruitDateInput(cycle.opensAt))}" placeholder="YYYY-MM-DD" maxlength="10" autocomplete="off" spellcheck="false">`)}
      ${recruitFormField('Closes', `<input class="text-input" name="closesAt" value="${MD.esc(recruitDateInput(cycle.closesAt))}" placeholder="YYYY-MM-DD" maxlength="10" autocomplete="off" spellcheck="false">`)}
      ${recruitCan('admin') ? recruitFormField('Capacity', `<input class="text-input" name="capacity" value="${MD.esc(String(cycle.doc?.capacity || 0))}" inputmode="numeric" maxlength="6" autocomplete="off">`, '0 = unlimited') : ''}
      <div class="rc-form__foot"><button type="submit" class="btn btn--primary">Save</button></div>
    </form>`,
    submit: async (form, cycle) => {
      const opensAt = recruitParseDate(form.elements.opensAt?.value), closesAt = recruitParseDate(form.elements.closesAt?.value, true);
      if (Number.isNaN(opensAt) || Number.isNaN(closesAt)) throw new Error('Dates are YYYY-MM-DD.');
      if (opensAt && closesAt && closesAt < opensAt) throw new Error('Closes before it opens.');
      const body = { version: cycle.version, name: String(form.elements.name.value || '').trim(), term: $('[data-m="recruit-term"]', form)?.dataset.value || cycle.term, opensAt, closesAt };
      if (!body.name) throw new Error('A cycle needs a name.');
      if (form.elements.capacity) {
        const cap = Number(String(form.elements.capacity.value || '0').trim());
        if (!Number.isInteger(cap) || cap < 0) throw new Error('Capacity is a whole number.');
        body.capacity = cap;
      }
      const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
      recruitAdoptCycle(out.cycle);
      form.dataset.adminDirty = 'false';
      toast('Saved');
      renderBackground('recruit');
    },
  },
  {
    id: 'status', label: 'Status', when: () => recruitCan('lead'),
    view: (cycle) => {
      const st = recruitState();
      const moves = recruitStatusChoices(cycle);
      return `<p class="admin-block__sub">${MD.esc(recruitStatusText(cycle, st.cycles?.intakeCycleId))}${cycle.closedAt ? ` · closed ${MD.esc(recruitDate(Number(cycle.closedAt)))}` : ''}</p>
      <div class="rc-actions">${moves.map((x) => `<button class="btn" data-action="recruit-status" data-status="${MD.esc(x.status)}" data-confirm="${x.confirm ? '1' : ''}">${MD.esc(x.label)}</button>`).join('') || '<span class="faint">Nothing to change.</span>'}</div>`;
    },
  },
  {
    id: 'website', label: 'Website form', when: () => recruitCan('admin'),
    view: (cycle) => {
      const st = recruitState();
      const current = st.cycles?.intakeCycleId || null;
      const receiving = current === cycle.id;
      const other = current && !receiving ? (st.cycles?.list || []).find((c) => c.id === current) : null;
      const note = receiving ? 'This cycle receives the website form.' : other ? `${other.name} receives the website form.` : st.cycles?.migration?.done ? 'No cycle receives the website form. Submissions wait as orphans.' : 'The old list receives the website form until the import runs.';
      return `<p class="admin-block__sub">${MD.esc(note)}</p>
      <div class="rc-actions"><button class="btn ${receiving ? '' : 'btn--primary'}" data-action="recruit-intake" data-on="${receiving ? '' : '1'}" ${cycle.status !== 'open' && !receiving ? 'disabled title="Open the cycle first"' : ''} aria-pressed="${receiving}">${receiving ? 'Stop receiving the website form' : 'Receive the website form'}</button></div>`;
    },
  },
  {
    id: 'subteams', label: 'Subteams', when: () => recruitCan('lead'),
    view: (cycle) => {
      const teams = recruitSubteams(cycle);
      return `<form class="rc-form rc-form--rows" data-action="recruit-settings-subteams">
        <div class="rc-rows" data-rc="subteam-rows">${teams.map((t) => recruitSubteamRowHtml(t)).join('')}</div>
        <div class="rc-form__foot"><button type="button" class="btn btn--sm" data-action="recruit-subteam-add">${I.plus} Add subteam</button><span style="flex:1"></span><button type="submit" class="btn btn--primary">Save</button></div>
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
        const capacity = Number(String($('[name="capacity"]', row)?.value || '0').trim());
        if (!Number.isInteger(capacity) || capacity < 0) throw new Error(`Capacity for ${name} is a whole number.`);
        const prior = recruitSubteams(cycle).find((t) => t.key === key);
        settings.push({ key, name, capacity, leads: prior?.leads || [] });
      }
      await recruitPutSettings(cycle, 'subteams', settings);
      form.dataset.adminDirty = 'false';
      toast('Subteams saved');
      renderBackground('recruit');
    },
  },
  {
    id: 'intake', label: 'Intake', when: () => recruitCan('admin'),
    view: (cycle) => {
      const it = cycle.doc?.intake || {};
      return `<form class="rc-form" data-action="recruit-settings-intake">
        ${recruitFormField('Per address per hour', `<input class="text-input" name="perIpHour" value="${MD.esc(String(it.perIpHour ?? 5))}" inputmode="numeric" maxlength="4">`)}
        ${recruitFormField('Per day', `<input class="text-input" name="perDay" value="${MD.esc(String(it.perDay ?? 2000))}" inputmode="numeric" maxlength="6">`)}
        <div class="rc-checks">
          <label class="rc-check"><input type="checkbox" name="notify" ${it.notify !== false ? 'checked' : ''}> Email the team on each new application</label>
          <label class="rc-check"><input type="checkbox" name="confirmUpdate" ${it.confirmUpdate !== false ? 'checked' : ''}> Let a returning applicant update their answers</label>
        </div>
        <div class="rc-form__foot"><button type="submit" class="btn btn--primary">Save</button></div>
      </form>`;
    },
    submit: async (form, cycle) => {
      const perIpHour = Number(form.elements.perIpHour.value), perDay = Number(form.elements.perDay.value);
      if (!Number.isInteger(perIpHour) || perIpHour < 1 || !Number.isInteger(perDay) || perDay < 1) throw new Error('Limits are whole numbers of at least 1.');
      await recruitPutSettings(cycle, 'intake', { ...(cycle.doc?.intake || {}), perIpHour, perDay, notify: form.elements.notify.checked, confirmUpdate: form.elements.confirmUpdate.checked });
      form.dataset.adminDirty = 'false';
      toast('Intake saved');
      renderBackground('recruit');
    },
  },
  {
    id: 'danger', label: 'Danger', when: (cycle) => recruitCan('admin'),
    view: (cycle) => `<p class="admin-block__sub">${cycle.status === 'archived' || cycle.status === 'draft' ? 'Deleting erases every record in this cycle.' : 'Only draft and archived cycles can be deleted.'}</p>
      <div class="rc-actions"><button class="btn btn--danger" data-action="recruit-cycle-delete" ${cycle.status === 'archived' || cycle.status === 'draft' ? '' : 'disabled'}>Delete cycle…</button></div>`,
  },
];

// A cycle's sections as the server reports them (GET /recruit/cycles/:id
// carries `sections` merged over the defaults).
function recruitSections(cycle) {
  const st = recruitState();
  return (st.cycle?.data?.id === cycle?.id && st.cycle.sections) || cycle?.doc?.site?.sections || {};
}

function recruitSubteamRowHtml(t = {}) {
  return `<div class="rc-row" data-key="${MD.esc(t.key || '')}">
    <input class="text-input" name="name" value="${MD.esc(t.name || '')}" placeholder="Subteam" maxlength="40" aria-label="Subteam name" autocomplete="off" spellcheck="false">
    <input class="text-input rc-row__num" name="capacity" value="${MD.esc(String(t.capacity || 0))}" inputmode="numeric" maxlength="4" aria-label="Capacity" title="0 = unlimited">
    <button type="button" class="icon-btn" data-action="recruit-subteam-remove" aria-label="Remove ${MD.esc(t.name || 'subteam')}">${I.x}</button>
  </div>`;
}

const recruitSlug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);

async function recruitPutSettings(cycle, module, settings) {
  const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/settings/${module}`, { method: 'PUT', body: JSON.stringify({ version: cycle.version, settings }) });
  recruitAdoptCycle(out.cycle);
  return out;
}

function recruitAdoptCycle(row) {
  const st = recruitState();
  if (row && st.cycle?.data?.id === row.id) st.cycle.data = row;
  st.cycles = undefined;
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
    if (st.cycles?.list) st.cycles.intakeCycleId = out.intakeCycleId || null;
    st.cycles = undefined;
    toast(on ? `${cycle.name} receives the website form` : 'The website form has no cycle now');
  } catch (e) { recruitVersionToast(e, cycle.id); }
  finally { st.busy.delete('intake'); renderBackground('recruit'); }
}

/* ------------------------------- register -------------------------------- */

RECRUIT.register({
  name: 'cycles',
  order: 0,
  kernel: true,
  panel: { id: 'settings', label: 'Settings', order: 100, when: (cycle, role) => role === 'admin' || role === 'lead' },
  view: recruitSettingsPanelHtml,
  actions: {
    'recruit-refresh': () => { const st = recruitState(); UI.recruitMe = undefined; st.me = undefined; st.cycles = undefined; RECRUIT.reset(st.cycleId); render(); },
    'recruit-cycle-open': (el) => { nav(recruitPanelHref(el.dataset.id)); },
    'recruit-cycle-new': () => { UI.modal = { kind: 'recruit-cycle' }; render(); },
    'recruit-cycle-create': recruitCreateCycle,
    'recruit-migrate': recruitRunMigration,
    'recruit-adopt': (el) => recruitOpenAdopt(el),
    'recruit-queue-sync': () => { const st = recruitState(); st.queue = undefined; recruitLoadQueue(true); },
    'recruit-cycle-tools': (el) => recruitOpenCycleTools(el),
    'recruit-status': (el) => recruitSetStatus(el.dataset.status, Boolean(el.dataset.confirm)),
    'recruit-intake': (el) => recruitToggleIntake(Boolean(el.dataset.on)),
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
    'recruit-cycle-switch': (host, value) => { if (value !== undefined && value !== recruitCycleRow()?.id) nav(recruitPanelHref(value, UI.route?.params?.sub || '')); },
  },
  modals: { 'recruit-cycle': recruitCycleModalHtml },
  settings: RECRUIT_SETTINGS,
  mount: (cycle, role) => {
    for (const s of RECRUIT.settingsSections(cycle, role)) { try { s.mount?.(cycle, role); } catch (e) { console.error(e); } }
  },
  reset() {},
});

// recruit:cycles:end
