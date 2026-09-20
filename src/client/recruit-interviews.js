/* ---------------------- recruit: interviews (self-contained) ----------------
   Client half of lib/recruit/modules/interviews.js. Rounds, slots, invitations,
   and each interviewer's own list. State lives on UI.recruit.mod.interviews as
   undefined | {loading:true} | {error} | data, keyed by cycle so a late
   response after a cycle switch is dropped. Nothing here calls render() from
   an async path. */

// recruit:interviews:start
'use strict';

const RC_IV_STATUS = { invited: 'Invited', confirmed: 'Confirmed', declined: 'Declined', no_show: 'No-show', done: 'Done', cancelled: 'Cancelled' };
const RC_IV_TIMEOUT = 20000;

function rcIvState() { UI.recruit.mod ||= {}; return UI.recruit.mod.interviews; }
function rcIvSet(v) { UI.recruit.mod ||= {}; UI.recruit.mod.interviews = v; }
function rcIvRole() { return UI.recruit?.cycle?.role || null; }
function rcIvLead() { return rcIvRole() === 'admin' || rcIvRole() === 'lead'; }
function rcIvBusy() { return (UI.recruit.busy ||= new Set()); }
function rcIvVal(form, m) { return $(`[data-m="${m}"]`, form)?.value ?? ''; }
function rcIvDd(form, m) { return $(`[data-m="${m}"]`, form)?.dataset.value ?? ''; }
function rcIvMsg(e) { return e?.name === 'TimeoutError' ? 'The request timed out. Try again.' : e?.message || 'Something went wrong'; }
function rcIvError(scope, text) {
  const el = $('[data-iv-error]', scope) || $('[data-iv-error]');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}
function rcIvTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function rcIvWhen(ts, ends) { return `${recruitDate(ts)} · ${rcIvTime(ts)}${ends ? `–${rcIvTime(ends)}` : ''}`; }
function rcIvRoundName(key) { return (rcIvState()?.rounds || UI.recruit?.cycle?.data?.doc?.interviews?.rounds || []).find((r) => r.key === key)?.name || key || ''; }
function rcIvRounds(cycle) { return (cycle?.doc?.interviews?.rounds || []).map((r) => ({ value: r.key, label: r.name })); }
function rcIvRoundFor(cycle) {
  const st = rcIvState();
  const rounds = rcIvRounds(cycle);
  return rounds.some((r) => r.value === st?.round) ? st.round : rounds[0]?.value || '';
}
/* ------------------------------- loading ---------------------------------- */

async function rcIvLoad(cycle, round) {
  const key = cycle.id;
  round = round || rcIvRoundFor(cycle);
  rcIvSet({ loading: true, key, round });
  const lead = rcIvLead();
  const q = round ? `?round=${encodeURIComponent(round)}` : '';
  const fresh = () => UI.recruit?.cycleId === key && rcIvState()?.key === key;
  try {
    const [slots, bookings, mine] = await Promise.all([
      RECRUIT.api(`/recruit/cycles/${key}/slots${q}`, { signal: AbortSignal.timeout(RC_IV_TIMEOUT) }),
      lead ? RECRUIT.api(`/recruit/cycles/${key}/bookings${q}`, { signal: AbortSignal.timeout(RC_IV_TIMEOUT) }) : Promise.resolve({ bookings: [] }),
      RECRUIT.api(`/recruit/cycles/${key}/my-interviews`, { signal: AbortSignal.timeout(RC_IV_TIMEOUT) }),
    ]);
    if (!fresh()) return;
    rcIvSet({ key, round, slots: slots.slots || [], rounds: slots.rounds || [], selfSchedule: !!slots.selfSchedule, members: slots.members || [], bookings: bookings.bookings || [], mine: mine.upcoming || [] });
  } catch (e) {
    if (!fresh()) return;
    rcIvSet({ key, round, error: rcIvMsg(e) });
  }
  renderBackground('recruit');
}

function rcIvRefresh(round) {
  const cycle = UI.recruit?.cycle?.data;
  if (!cycle) return;
  rcIvLoad(cycle, round || rcIvState()?.round);
}

/* -------------------------------- views ----------------------------------- */

function rcIvSlotsHtml(st) {
  const lead = rcIvLead();
  const rows = (st.slots || []).map((s) => `<tr data-slot-id="${MD.esc(s.id)}">
      <td>${MD.esc(rcIvWhen(s.starts, s.ends))}</td>
      <td>${MD.esc(s.place || '—')}</td>
      <td>${s.interviewers.length ? s.interviewers.map((e) => MD.esc(typeof Store !== 'undefined' && Store.userName ? Store.userName(e) : e)).join(', ') : '<span class="faint">Unassigned</span>'}</td>
      <td class="font-mono">${s.booked}/${s.capacity}</td>
      <td>${lead ? `<button class="icon-btn" data-action="recruit-iv-slot-menu" data-id="${MD.esc(s.id)}" data-version="${s.version}" data-booked="${s.booked}" aria-label="Slot options" aria-haspopup="menu">${I.dots}</button>` : ''}</td>
    </tr>`).join('');
  return `<div class="sheet">
    <div class="sheet__scroll"><table aria-label="Interview slots">
      <thead><tr><th>When</th><th>Where</th><th>Interviewers</th><th>Booked</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="faint">No slots for this round yet.</td></tr>`}</tbody>
    </table></div>
    <div class="sheet__foot" role="status">${st.slots?.length || 0} ${st.slots?.length === 1 ? 'slot' : 'slots'}</div>
  </div>`;
}

function rcIvBookingsHtml(st) {
  const rows = (st.bookings || []).map((b) => `<tr data-booking-id="${MD.esc(b.id)}">
      <td><button class="interest-person" data-action="recruit-app-open" data-id="${MD.esc(b.applicationId)}"><b>${MD.esc(b.name)}</b><span class="mail">${MD.esc(b.email || '')}</span></button></td>
      <td>${MD.esc(RC_IV_STATUS[b.status] || b.status)}</td>
      <td>${b.starts ? MD.esc(rcIvWhen(b.starts)) : '<span class="faint">No time yet</span>'}</td>
      <td>${(b.interviewers || []).map((e) => MD.esc(typeof Store !== 'undefined' && Store.userName ? Store.userName(e) : e)).join(', ')}</td>
      <td><button class="icon-btn" data-action="recruit-iv-booking-menu" data-id="${MD.esc(b.id)}" data-app="${MD.esc(b.applicationId)}" data-status="${MD.esc(b.status)}" data-version="${b.version}" data-slot="${MD.esc(b.slotId || '')}" aria-label="Invitation options" aria-haspopup="menu">${I.dots}</button></td>
    </tr>`).join('');
  return `<div class="sheet">
    <div class="sheet__scroll"><table aria-label="Interview invitations">
      <thead><tr><th>Applicant</th><th>State</th><th>Slot</th><th>Interviewers</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="faint">Nobody is invited to this round yet. Select people on the Applications tab and choose Invite to interview.</td></tr>`}</tbody>
    </table></div>
    <div class="sheet__foot" role="status">${st.bookings?.length || 0} invited</div>
  </div>`;
}

function rcIvMineHtml(st) {
  const groups = new Map();
  for (const g of st.mine || []) {
    const day = recruitDate(g.slot.starts);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(g);
  }
  if (!groups.size) return `<p class="sheet__note">No interviews scheduled with you.</p>`;
  return [...groups.entries()].map(([day, list]) => `<h4 class="interest-subhead">${MD.esc(day)}</h4>
    <div class="sheet sheet--list">${list.map((g) => `<div class="sheet__archive">
      <div><span class="sheet__archivetitle">${MD.esc(rcIvTime(g.slot.starts))}${g.slot.place ? ` · ${MD.esc(g.slot.place)}` : ''} · ${MD.esc(rcIvRoundName(g.slot.round))}</span>
        <span class="sheet__archivemeta">${g.bookings.length ? g.bookings.map((b) => `${MD.esc(b.name)} (${MD.esc(RC_IV_STATUS[b.status] || b.status)}${b.scored ? ', scored' : ''})`).join(' · ') : 'Nobody booked'}</span></div>
      ${g.bookings.map((b) => `<button class="btn btn--sm" data-action="recruit-iv-scorecard" data-id="${MD.esc(b.applicationId)}" data-round="${MD.esc(g.slot.round)}">${b.scored ? 'Edit scorecard' : 'Open scorecard'}</button>`).join('')}
    </div>`).join('')}</div>`).join('');
}

function rcIvView(cycle, role) {
  const st = rcIvState();
  const lead = role === 'admin' || role === 'lead';
  const rounds = rcIvRounds(cycle);
  const round = rcIvRoundFor(cycle);
  const head = `<div class="admin-block__head"><h2>Interviews</h2>
      ${rounds.length ? dd('recruit-round', rounds, round, { small: true }) : ''}
      ${lead ? `<button class="btn btn--sm" data-action="recruit-iv-add-slots">${I.plus} Add slots…</button>` : ''}
      <button class="icon-btn" data-action="recruit-iv-refresh" aria-label="Refresh" title="Refresh">${I.history}</button>
    </div>`;
  if (!rounds.length) return `<section class="admin-block">${head}<div class="empty">${I.clock}<b>No interview rounds</b><p>Add a round under Settings → Interviews.</p></div></section>`;
  if (!st || st.loading || st.key !== cycle.id) return `<section class="admin-block">${head}<p class="sheet__note">Loading…</p></section>`;
  if (st.error) return `<section class="admin-block">${head}<p class="sheet__note">Could not load: ${MD.esc(st.error)}. <button class="linklike" data-action="recruit-iv-refresh">Retry</button></p></section>`;
  return `<div class="admin-grid">
    <section class="admin-block">${head}<p class="field-error" role="alert" data-iv-error hidden></p>${rcIvSlotsHtml(st)}</section>
    ${lead ? `<section class="admin-block"><div class="admin-block__head"><h2>Invitations</h2><span class="count">${st.bookings?.length || 0}</span></div>${rcIvBookingsHtml(st)}</section>` : ''}
    <section class="admin-block"><div class="admin-block__head"><h2>My interviews</h2><span class="count">${(st.mine || []).reduce((n, g) => n + g.bookings.length, 0)}</span></div>${rcIvMineHtml(st)}</section>
  </div>`;
}

/* -------------------------------- modals ---------------------------------- */

function rcIvMemberChecks(selected = []) {
  const members = rcIvState()?.members || [];
  if (!members.length) return `<p class="sheet__note">No active members to assign.</p>`;
  return `<div class="member-checks">${members.map((m) => `<label class="sheet__check" style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-m="recruit-iv-interviewer" value="${MD.esc(m.email)}" ${selected.includes(m.email) ? 'checked' : ''}> ${MD.esc(m.name || m.email)}${m.subteam ? ` <span class="faint">· ${MD.esc(m.subteam)}</span>` : ''}</label>`).join('')}</div>`;
}

function rcIvSlotsModal(m) {
  const cycle = UI.recruit?.cycle?.data;
  const rounds = rcIvRounds(cycle);
  const round = m.round || rcIvRoundFor(cycle);
  const minutes = (cycle?.doc?.interviews?.rounds || []).find((r) => r.key === round)?.minutes || 20;
  const edit = m.slot;
  const d = edit ? new Date(edit.starts) : null;
  const pad = (n) => String(n).padStart(2, '0');
  const dateOf = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  const timeOf = (x) => `${pad(x.getHours())}:${pad(x.getMinutes())}`;
  return `<div class="modal" role="dialog" aria-label="${edit ? 'Edit slot' : 'Add slots'}">
    <form data-action="${edit ? 'recruit-iv-slot-edit-form' : 'recruit-iv-slots-form'}" data-id="${MD.esc(edit?.id || '')}" data-version="${edit?.version ?? ''}">
    <div class="modal__head"><h3>${edit ? 'Edit slot' : 'Add slots'}</h3><button type="button" class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body">
      ${edit ? '' : `<label>Round${dd('recruit-iv-modal-round', rounds, round)}</label>`}
      <label>Date<input class="text-input" data-m="recruit-iv-date" placeholder="YYYY-MM-DD" value="${MD.esc(d ? dateOf(d) : '')}" maxlength="10" autocomplete="off" spellcheck="false"></label>
      <div style="display:flex;gap:12px">
        <label style="flex:1">Start<input class="text-input" data-m="recruit-iv-start" placeholder="HH:MM" value="${MD.esc(d ? timeOf(d) : '')}" maxlength="5" autocomplete="off"></label>
        <label style="flex:1">End<input class="text-input" data-m="recruit-iv-end" placeholder="HH:MM" value="${MD.esc(edit ? timeOf(new Date(edit.ends)) : '')}" maxlength="5" autocomplete="off"></label>
      </div>
      ${edit ? '' : `<label>Split into slots every<input class="text-input" data-m="recruit-iv-every" value="${minutes}" inputmode="numeric" maxlength="3" style="max-width:120px"> minutes (blank for one slot)</label>`}
      <div style="display:flex;gap:12px">
        <label style="flex:1">Capacity<input class="text-input" data-m="recruit-iv-capacity" value="${edit?.capacity ?? 1}" inputmode="numeric" maxlength="2"></label>
        <label style="flex:2">Place<input class="text-input" data-m="recruit-iv-place" value="${MD.esc(edit?.place || '')}" maxlength="120" placeholder="e.g. Upson 116"></label>
      </div>
      <label>Interviewers</label>${rcIvMemberChecks(edit?.interviewers || [])}
      <p class="field-error" role="alert" data-iv-error hidden></p>
    </div>
    <div class="modal__foot"><button type="button" class="btn" data-action="modal-close">Cancel</button><button type="submit" class="btn btn--primary">${edit ? 'Save' : 'Add'}</button></div>
    </form>
  </div>`;
}

function rcIvSlotOptions(round, currentSlot) {
  return (rcIvState()?.slots || []).filter((s) => s.round === round && (s.booked < s.capacity || s.id === currentSlot))
    .map((s) => ({ value: s.id, label: `${rcIvWhen(s.starts, s.ends)}${s.place ? ` · ${s.place}` : ''} · ${s.capacity - s.booked} free` }));
}

function rcIvBookingModal(m) {
  const b = (rcIvState()?.bookings || []).find((x) => x.id === m.id) || m.booking || {};
  const options = rcIvSlotOptions(b.round || rcIvState()?.round, b.slotId);
  const reschedule = m.mode === 'reschedule';
  return `<div class="modal" role="dialog" aria-label="${reschedule ? 'Reschedule' : 'Assign slot'}">
    <form data-action="recruit-iv-booking-form" data-id="${MD.esc(b.id || '')}" data-version="${b.version ?? ''}" data-mode="${reschedule ? 'reschedule' : 'book'}">
    <div class="modal__head"><h3>${reschedule ? 'Reschedule' : 'Assign a time'} · ${MD.esc(b.name || '')}</h3><button type="button" class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body">
      ${options.length ? `<label>Slot${dd('recruit-iv-slot-pick', options, options[0].value)}</label>` : `<p class="sheet__note">No open slots in this round. Add slots first.</p>`}
      <label class="sheet__check" style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-m="recruit-iv-send" checked> Email the ${reschedule ? 'new time' : 'invitation'}</label>
      <p class="field-error" role="alert" data-iv-error hidden></p>
    </div>
    <div class="modal__foot"><button type="button" class="btn" data-action="modal-close">Cancel</button><button type="submit" class="btn btn--primary" ${options.length ? '' : 'disabled'}>${reschedule ? 'Reschedule' : 'Book'}</button></div>
    </form>
  </div>`;
}

function rcIvInviteModal(m) {
  const cycle = UI.recruit?.cycle?.data;
  const rounds = rcIvRounds(cycle);
  const round = m.round || rcIvRoundFor(cycle);
  const options = [{ value: '', label: 'Let the applicant pick later' }, ...rcIvSlotOptions(round)];
  const n = m.ids?.length || 0;
  return `<div class="modal" role="dialog" aria-label="Invite to interview">
    <form data-action="recruit-iv-invite-form" data-ids="${MD.esc(JSON.stringify(m.ids || []))}">
    <div class="modal__head"><h3>Invite ${n} ${n === 1 ? 'person' : 'people'} to interview</h3><button type="button" class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body">
      <label>Round${dd('recruit-iv-invite-round', rounds, round)}</label>
      <label>Slot${dd('recruit-iv-slot-pick', options, '')}</label>
      <label class="sheet__check" style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-m="recruit-iv-send" checked> Send the interview email now</label>
      <p class="field-error" role="alert" data-iv-error hidden></p>
    </div>
    <div class="modal__foot"><button type="button" class="btn" data-action="modal-close">Cancel</button><button type="submit" class="btn btn--primary" ${n ? '' : 'disabled'}>Invite</button></div>
    </form>
  </div>`;
}

/* ------------------------------- actions ---------------------------------- */

function rcIvParseWhen(date, start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Enter the date as YYYY-MM-DD');
  const time = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim()); if (!m || +m[1] > 23 || +m[2] > 59) throw new Error('Enter times as HH:MM'); return [+m[1], +m[2]]; };
  const [sh, sm] = time(start), [eh, em] = time(end);
  const [y, mo, d] = date.split('-').map(Number);
  const starts = new Date(y, mo - 1, d, sh, sm).getTime();
  const ends = new Date(y, mo - 1, d, eh, em).getTime();
  if (!Number.isFinite(starts) || !Number.isFinite(ends)) throw new Error('Enter the date as YYYY-MM-DD');
  if (ends <= starts) throw new Error('The slot must end after it starts');
  return { starts, ends };
}

function rcIvSlotsBody(form) {
  const { starts, ends } = rcIvParseWhen(rcIvVal(form, 'recruit-iv-date'), rcIvVal(form, 'recruit-iv-start'), rcIvVal(form, 'recruit-iv-end'));
  const capacity = Number(rcIvVal(form, 'recruit-iv-capacity') || 1);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10) throw new Error('Capacity is 1 to 10');
  const interviewers = $$('[data-m="recruit-iv-interviewer"]', form).filter((c) => c.checked).map((c) => c.value);
  const body = { starts, ends, capacity, place: rcIvVal(form, 'recruit-iv-place').trim(), interviewers };
  const every = Number(rcIvVal(form, 'recruit-iv-every'));
  if (every && every > 0) {
    if (every < 5) throw new Error('Slots are at least 5 minutes');
    body.ends = starts + every * 60000;
    body.repeat = { every, until: ends };
  }
  return body;
}

async function rcIvSubmitSlots(form) {
  const cycleId = UI.recruit?.cycleId;
  if (!cycleId || rcIvBusy().has('iv-slots')) return;
  let body;
  try { body = rcIvSlotsBody(form); } catch (e) { rcIvError(form, e.message); return; }
  const m = UI.modal;
  m.requestId ||= 'rq-' + crypto.randomUUID();
  body.requestId = m.requestId;
  body.round = rcIvDd(form, 'recruit-iv-modal-round') || rcIvRoundFor(UI.recruit.cycle.data);
  rcIvBusy().add('iv-slots');
  rcIvError(form, '');
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${cycleId}/slots`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(RC_IV_TIMEOUT) });
    if (UI.modal !== m) return;
    const n = out.slots?.length || 0;
    closeModal(() => { toast(`Added ${n} ${n === 1 ? 'slot' : 'slots'}`); rcIvRefresh(body.round); });
  } catch (e) {
    if (UI.modal === m) rcIvError(form, rcIvMsg(e));
  } finally { rcIvBusy().delete('iv-slots'); }
}

async function rcIvSubmitSlotEdit(form) {
  const id = form.dataset.id;
  if (!id || rcIvBusy().has('iv-slot-' + id)) return;
  let body;
  try { body = rcIvSlotsBody(form); } catch (e) { rcIvError(form, e.message); return; }
  delete body.repeat;
  body.version = Number(form.dataset.version);
  const m = UI.modal;
  rcIvBusy().add('iv-slot-' + id);
  try {
    await RECRUIT.api(`/recruit/slots/${id}`, { method: 'PATCH', body: JSON.stringify(body), signal: AbortSignal.timeout(RC_IV_TIMEOUT) });
    if (UI.modal !== m) return;
    closeModal(() => { toast('Slot saved'); rcIvRefresh(); });
  } catch (e) {
    if (UI.modal === m) rcIvError(form, rcIvMsg(e));
  } finally { rcIvBusy().delete('iv-slot-' + id); }
}

function rcIvSlotMenu(el) {
  const id = el.dataset.id, version = Number(el.dataset.version), booked = Number(el.dataset.booked);
  const slot = (rcIvState()?.slots || []).find((s) => s.id === id);
  openMenu([
    { label: 'Edit…', run: () => { UI.modal = { kind: 'recruit-slots', slot }; render(); } },
    { label: booked ? `Delete (${booked} booked)` : 'Delete…', danger: true, run: () => {
      if (booked) { toast('Cancel the bookings in this slot first'); return; }
      UI.modal = { kind: 'confirm', title: 'Delete this slot?', text: MD.esc(slot ? rcIvWhen(slot.starts, slot.ends) : ''), confirm: 'Delete', danger: true,
        onGo: async () => {
          try { await RECRUIT.api(`/recruit/slots/${id}?version=${version}`, { method: 'DELETE', signal: AbortSignal.timeout(RC_IV_TIMEOUT) }); toast('Slot deleted'); }
          catch (e) { toast(rcIvMsg(e)); }
          rcIvRefresh();
        } };
      render();
    } },
  ], el);
}

async function rcIvSetStatus(id, status, version) {
  const key = 'iv-bk-' + id;
  if (rcIvBusy().has(key)) return;
  rcIvBusy().add(key);
  try {
    await RECRUIT.api(`/recruit/bookings/${id}`, { method: 'PATCH', body: JSON.stringify({ version, status }), signal: AbortSignal.timeout(RC_IV_TIMEOUT) });
    toast(`Marked ${RC_IV_STATUS[status].toLowerCase()}`);
  } catch (e) {
    toast(rcIvMsg(e));
  } finally { rcIvBusy().delete(key); }
  rcIvRefresh();
}

async function rcIvResend(id) {
  const key = 'iv-resend-' + id;
  if (rcIvBusy().has(key)) return;
  rcIvBusy().add(key);
  try {
    const out = await RECRUIT.api(`/recruit/bookings/${id}/resend`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(RC_IV_TIMEOUT) });
    toast(out.emailed ? 'Invitation sent again' : 'Invitation queued');
  } catch (e) {
    toast(rcIvMsg(e));
  } finally { rcIvBusy().delete(key); }
  rcIvRefresh();
}

function rcIvBookingMenu(el) {
  const { id, status, slot } = el.dataset;
  const version = Number(el.dataset.version);
  const open = status === 'invited' || status === 'confirmed';
  const items = [];
  if (open && !slot) items.push({ label: 'Assign slot…', run: () => { UI.modal = { kind: 'recruit-booking', id, mode: 'book' }; render(); } });
  if (['invited', 'confirmed', 'declined', 'no_show'].includes(status) && slot) items.push({ label: 'Reschedule…', run: () => { UI.modal = { kind: 'recruit-booking', id, mode: 'reschedule' }; render(); } });
  if (open) items.push({ label: 'Resend invite', run: () => rcIvResend(id) });
  if (status === 'confirmed') items.push('-', { label: 'No-show', run: () => rcIvSetStatus(id, 'no_show', version) }, { label: 'Done', run: () => rcIvSetStatus(id, 'done', version) });
  if (open) items.push('-', { label: 'Cancel invitation', danger: true, run: () => rcIvSetStatus(id, 'cancelled', version) });
  if (!items.length) items.push({ label: `${RC_IV_STATUS[status] || status} · nothing to change`, run: () => {} });
  openMenu(items, el);
}

async function rcIvSubmitBooking(form) {
  const id = form.dataset.id, mode = form.dataset.mode;
  const key = 'iv-bk-' + id;
  if (!id || rcIvBusy().has(key)) return;
  const slotId = rcIvDd(form, 'recruit-iv-slot-pick');
  if (!slotId) { rcIvError(form, 'Pick a slot'); return; }
  const body = { version: Number(form.dataset.version), slotId, send: $('[data-m="recruit-iv-send"]', form)?.checked !== false };
  const m = UI.modal;
  rcIvBusy().add(key);
  try {
    await RECRUIT.api(`/recruit/bookings/${id}/${mode === 'reschedule' ? 'reschedule' : 'book'}`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(RC_IV_TIMEOUT) });
    if (UI.modal !== m) return;
    closeModal(() => { toast(mode === 'reschedule' ? 'Rescheduled' : 'Booked'); rcIvRefresh(); });
  } catch (e) {
    if (UI.modal === m) rcIvError(form, rcIvMsg(e));
  } finally { rcIvBusy().delete(key); }
}

async function rcIvSubmitInvite(form) {
  const cycleId = UI.recruit?.cycleId;
  if (!cycleId || rcIvBusy().has('iv-invite')) return;
  let ids = [];
  try { ids = JSON.parse(form.dataset.ids || '[]'); } catch (e) { ids = []; }
  if (!ids.length) { rcIvError(form, 'Pick at least one person'); return; }
  const m = UI.modal;
  m.requestId ||= 'rq-' + crypto.randomUUID();
  const round = rcIvDd(form, 'recruit-iv-invite-round') || rcIvRoundFor(UI.recruit.cycle.data);
  const body = { requestId: m.requestId, round, ids, send: $('[data-m="recruit-iv-send"]', form)?.checked !== false };
  const slotId = rcIvDd(form, 'recruit-iv-slot-pick');
  if (slotId) body.slotId = slotId;
  rcIvBusy().add('iv-invite');
  rcIvError(form, '');
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${cycleId}/invitations`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(RC_IV_TIMEOUT) });
    if (UI.modal !== m) return;
    const created = out.created?.length || 0, existing = out.existing?.length || 0;
    closeModal(() => {
      toast(`Invited ${created}${existing ? ` · ${existing} already invited` : ''}${out.full?.length ? ` · ${out.full.length} without a time (slot full)` : ''}`);
      if (UI.recruit?.selected?.clear) UI.recruit.selected.clear();
      rcIvRefresh(round);
    });
  } catch (e) {
    if (UI.modal === m) rcIvError(form, rcIvMsg(e));
  } finally { rcIvBusy().delete('iv-invite'); }
}

/* ------------------------------- settings --------------------------------- */

function rcIvSettingsView(cycle) {
  const iv = cycle.doc?.interviews || { rounds: [] };
  const rows = (iv.rounds || []).map((r, i) => `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end" data-round-row>
      <input type="hidden" data-m="recruit-iv-round-key" value="${MD.esc(r.key)}">
      <label style="flex:2">Name<input class="text-input" data-m="recruit-iv-round-name" value="${MD.esc(r.name)}" maxlength="60"></label>
      <label style="flex:1">Minutes<input class="text-input" data-m="recruit-iv-round-minutes" value="${Number(r.minutes) || 20}" inputmode="numeric" maxlength="3"></label>
      <label style="flex:2">Place<input class="text-input" data-m="recruit-iv-round-place" value="${MD.esc(r.place || '')}" maxlength="120"></label>
      ${i > 0 ? `<button type="button" class="btn btn--sm" data-action="recruit-iv-round-remove" data-key="${MD.esc(r.key)}">Remove</button>` : ''}
    </div>`).join('');
  return `<form data-action="recruit-settings-interviews" class="admin-form" data-version="${cycle.version}">
    <div style="display:flex;flex-direction:column;gap:12px" data-round-rows>${rows}</div>
    <div style="display:flex;gap:12px;align-items:center;margin-top:12px;flex-wrap:wrap">
      <button type="button" class="btn btn--sm" data-action="recruit-iv-round-add">${I.plus} Add round</button>
      <label class="sheet__check" style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-m="recruit-iv-self" ${iv.selfSchedule ? 'checked' : ''}> Applicants pick their own time from the RSVP link</label>
      <button type="submit" class="btn btn--primary">Save</button>
    </div>
  </form>`;
}

function rcIvSettingsBody(form) {
  const cycle = UI.recruit?.cycle?.data;
  const existing = cycle?.doc?.interviews?.rounds || [];
  const rounds = $$('[data-round-row]', form).map((row) => {
    const key = rcIvVal(row, 'recruit-iv-round-key');
    const prior = existing.find((r) => r.key === key);
    return { key, name: rcIvVal(row, 'recruit-iv-round-name').trim(), minutes: Number(rcIvVal(row, 'recruit-iv-round-minutes')), place: rcIvVal(row, 'recruit-iv-round-place').trim(), rubric: prior?.rubric };
  });
  return { version: Number(form.dataset.version), settings: { rounds, selfSchedule: !!$('[data-m="recruit-iv-self"]', form)?.checked } };
}

// Called by the core inside runAdminForm; throwing shows the message on the form.
async function rcIvSettingsSubmit(form, cycle) {
  const cycleId = cycle?.id || UI.recruit?.cycleId;
  if (!cycleId) return;
  const body = rcIvSettingsBody(form);
  if (body.settings.rounds.some((r) => !r.name)) throw new Error('Every round needs a name.');
  const out = await RECRUIT.api(`/recruit/cycles/${cycleId}/settings/interviews`, { method: 'PUT', body: JSON.stringify(body), signal: AbortSignal.timeout(RC_IV_TIMEOUT) });
  if (out.cycle) { if (typeof recruitAdoptCycle === 'function') recruitAdoptCycle(out.cycle); else if (UI.recruit?.cycleId === cycleId && UI.recruit.cycle?.data) UI.recruit.cycle.data = out.cycle; }
  rcIvSet(undefined);
  form.dataset.adminDirty = 'false';
  toast('Saved');
}

function rcIvRoundAdd(el) {
  const form = el.closest('form');
  const host = $('[data-round-rows]', form);
  if (!host) return;
  const n = $$('[data-round-row]', form).length + 1;
  form.dataset.adminDirty = 'true';
  host.insertAdjacentHTML('beforeend', `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end" data-round-row>
      <input type="hidden" data-m="recruit-iv-round-key" value="r${n}">
      <label style="flex:2">Name<input class="text-input" data-m="recruit-iv-round-name" value="Round ${n}" maxlength="60"></label>
      <label style="flex:1">Minutes<input class="text-input" data-m="recruit-iv-round-minutes" value="20" inputmode="numeric" maxlength="3"></label>
      <label style="flex:2">Place<input class="text-input" data-m="recruit-iv-round-place" value="" maxlength="120"></label>
      <button type="button" class="btn btn--sm" data-action="recruit-iv-round-remove" data-key="r${n}">Remove</button>
    </div>`);
  $$('[data-round-row]', form).at(-1)?.querySelector('[data-m="recruit-iv-round-name"]')?.focus();
}

/* ------------------------------- register --------------------------------- */

RECRUIT.register({
  name: 'interviews',
  order: 60,
  panel: { id: 'interviews', label: 'Interviews', when: (cycle, role) => cycle?.doc?.modules?.interviews !== false && ['admin', 'lead', 'interviewer'].includes(role) },
  view: rcIvView,
  mount(cycle) {
    if (typeof REMOTE === 'undefined' || !cycle) return;
    const st = rcIvState();
    if (st === undefined || (st.key && st.key !== cycle.id)) rcIvLoad(cycle);
  },
  actions: {
    'recruit-iv-refresh': (el, ev, stop) => { stop?.(); rcIvRefresh(); },
    'recruit-iv-add-slots': (el, ev, stop) => { stop?.(); UI.modal = { kind: 'recruit-slots' }; render(); },
    'recruit-iv-slots-form': (form) => rcIvSubmitSlots(form),
    'recruit-iv-slot-edit-form': (form) => rcIvSubmitSlotEdit(form),
    'recruit-iv-slot-menu': (el, ev, stop) => { stop?.(); rcIvSlotMenu(el); },
    'recruit-iv-booking-menu': (el, ev, stop) => { stop?.(); rcIvBookingMenu(el); },
    'recruit-iv-booking-form': (form) => rcIvSubmitBooking(form),
    'recruit-iv-invite': (el, ev, stop) => { stop?.(); const ids = el.dataset.ids ? JSON.parse(el.dataset.ids) : [...(UI.recruit?.selected || [])]; UI.modal = { kind: 'recruit-invite', ids }; render(); },
    'recruit-iv-invite-form': (form) => rcIvSubmitInvite(form),
    'recruit-iv-status': (el, ev, stop) => { stop?.(); return rcIvSetStatus(el.dataset.id, el.dataset.status, Number(el.dataset.version)); },
    'recruit-iv-resend': (el, ev, stop) => { stop?.(); return rcIvResend(el.dataset.id); },
    'recruit-iv-scorecard': (el, ev, stop) => { stop?.(); UI.modal = { kind: 'recruit-scorecard', id: el.dataset.id, scoreKind: 'interview', round: el.dataset.round }; render(); },
    'recruit-iv-round-add': (el, ev, stop) => { stop?.(); rcIvRoundAdd(el); },
    'recruit-iv-round-remove': (el, ev, stop) => { stop?.(); const form = el.closest('form'); if (form) form.dataset.adminDirty = 'true'; el.closest('[data-round-row]')?.remove(); },
  },
  inputs: {},
  // Dropdowns use the core's default menu (built from data-opts); the
  // handler only hears the pick.
  dd: {
    'recruit-round': (host, value) => { if (value !== undefined) rcIvRefresh(value); },
    'recruit-iv-modal-round': () => {},
    'recruit-iv-invite-round': (host, value) => { if (value !== undefined && UI.modal?.kind === 'recruit-invite') { UI.modal.round = value; render(); } },
    'recruit-iv-slot-pick': () => {},
  },
  modals: {
    'recruit-slots': rcIvSlotsModal,
    'recruit-booking': rcIvBookingModal,
    'recruit-invite': rcIvInviteModal,
  },
  columns: [{ id: 'interview', label: 'Interview', sortKey: null, cell: (app) => { const b = app.extras?.booking; return b ? `${MD.esc(RC_IV_STATUS[b.status] || b.status)}${b.starts ? ` <span class="faint">${MD.esc(recruitDate(b.starts))}</span>` : ''}` : ''; } }],
  filters: [
    { group: 'Interview', value: 'interview:invited', label: 'Invited to interview', test: (row) => ['invited', 'confirmed'].includes(row.extras?.booking?.status) },
    { group: 'Interview', value: 'interview:confirmed', label: 'Interview confirmed', test: (row) => row.extras?.booking?.status === 'confirmed' },
    { group: 'Interview', value: 'interview:none', label: 'Not invited', test: (row) => !row.extras?.booking },
  ],
  selectionActions: (ids, cycle, role) => (cycle?.doc?.modules?.interviews !== false && (role === 'admin' || role === 'lead')
    ? [{ id: 'invite', label: 'Invite to interview…', action: 'recruit-iv-invite', run: () => { UI.modal = { kind: 'recruit-invite', ids: [...ids] }; render(); } }] : []),
  detailSections: (app, cycle, role) => {
    const list = Array.isArray(app.bookings) ? app.bookings : app.extras?.booking ? [app.extras.booking] : [];
    if (!list.length && !['admin', 'lead'].includes(role)) return [];
    const html = list.length ? `<dl class="interest-detail">${list.map((b) => `<dt>${MD.esc(rcIvRoundName(b.round))}</dt><dd>${MD.esc(RC_IV_STATUS[b.status] || b.status)}${b.starts ? ` · ${MD.esc(rcIvWhen(b.starts))}` : ''}</dd>`).join('')}</dl>`
      : `<p class="faint" style="margin:0">Not invited yet.</p>`;
    return [{ id: 'interview', title: 'Interview', html }];
  },
  settings: { id: 'interviews', label: 'Interviews', view: rcIvSettingsView, submit: rcIvSettingsSubmit },
  reset() { rcIvSet(undefined); },
});
// recruit:interviews:end
