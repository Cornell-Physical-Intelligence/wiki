/* ---------------------- recruit: onboarding (self-contained) ----------------
   Client half of lib/recruit/modules/onboarding.js: the accepted sheet and
   "Invite to the wiki". Admin only. State on UI.recruit.mod.onboarding as
   undefined | {loading:true} | {error} | data, keyed by cycle. */

// recruit:onboarding:start
'use strict';

const RC_OB_TIMEOUT = 30000;

function rcObState() { UI.recruit.mod ||= {}; return UI.recruit.mod.onboarding; }
function rcObSet(v) { UI.recruit.mod ||= {}; UI.recruit.mod.onboarding = v; }
function rcObBusy() { return (UI.recruit.busy ||= new Set()); }
function rcObMsg(e) { return e?.name === 'TimeoutError' ? 'The request timed out. Check the list before retrying; nobody is invited twice.' : e?.message || 'Something went wrong'; }
function rcObSelected() { return (UI.recruit.mod.onboardingSelected ||= new Set()); }

/* ------------------------------- loading ---------------------------------- */

async function rcObLoad(cycle) {
  const key = cycle.id;
  rcObSet({ loading: true, key });
  const still = () => UI.recruit?.cycleId === key && rcObState()?.key === key;
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${key}/onboarding`, { signal: AbortSignal.timeout(RC_OB_TIMEOUT) });
    if (!still()) return;
    rcObSet({ key, rows: out.rows || [] });
  } catch (e) {
    if (!still()) return;
    rcObSet({ key, error: rcObMsg(e) });
  }
  renderBackground('recruit');
}

function rcObRefresh() {
  const cycle = UI.recruit?.cycle?.data;
  if (cycle) rcObLoad(cycle);
}

/* -------------------------------- views ----------------------------------- */

function rcObRosterLabel(r) {
  if (r.onRoster === 'active') return 'Active member';
  if (r.onRoster === 'invited') return 'Invited';
  if (r.onboarding?.status === 'failed') return `Failed · ${r.onboarding.reason || ''}`;
  return '—';
}

function rcObView(cycle, role) {
  const st = rcObState();
  const head = `<div class="admin-block__head"><h2>Accepted</h2><span class="count">${st?.rows?.length ?? ''}</span>
      <button class="icon-btn" data-action="recruit-ob-refresh" aria-label="Refresh" title="Refresh">${I.history}</button></div>`;
  if (role !== 'admin') return `<section class="admin-block">${head}<div class="empty">${I.users}<b>Admins invite new members</b><p>Ask an admin to onboard accepted applicants.</p></div></section>`;
  if (!st || st.loading || st.key !== cycle.id) return `<section class="admin-block">${head}<p class="sheet__note">Loading…</p></section>`;
  if (st.error) return `<section class="admin-block">${head}<p class="sheet__note">Could not load: ${MD.esc(st.error)}. <button class="linklike" data-action="recruit-ob-refresh">Retry</button></p></section>`;
  const selected = rcObSelected();
  const pending = st.rows.filter((r) => !r.onboardedAt && r.onRoster !== 'active' && r.email);
  const chosen = pending.filter((r) => selected.has(r.applicationId));
  const rows = st.rows.map((r) => {
    const invitable = !r.onboardedAt && r.onRoster !== 'active' && r.email;
    return `<tr data-app-id="${MD.esc(r.applicationId)}">
      <td class="sheet__check-cell"><label class="sheet__check"><input type="checkbox" data-action="recruit-ob-select" data-id="${MD.esc(r.applicationId)}" aria-label="Select ${MD.esc(r.name)}" ${selected.has(r.applicationId) ? 'checked' : ''} ${invitable ? '' : 'disabled'}></label></td>
      <td><button class="interest-person" data-action="recruit-app-open" data-id="${MD.esc(r.applicationId)}"><b>${MD.esc(r.name)}</b><span class="mail">${MD.esc(r.email || 'erased')}</span></button></td>
      <td>${r.decidedAt ? MD.esc(recruitDate(r.decidedAt)) : '—'}</td>
      <td>${MD.esc(rcObRosterLabel(r))}</td>
      <td>${r.onboardedAt ? MD.esc(recruitDate(r.onboardedAt)) : '<span class="faint">Not yet</span>'}</td>
    </tr>`;
  }).join('');
  return `<section class="admin-block">${head}
    <div class="sheet">
      <div class="sheet__bar">
        <div class="sheet__actions" data-ob-selection>
          <span role="status" data-ob-count>${chosen.length ? `${chosen.length} selected` : `${pending.length} to invite`}</span>
          <button class="btn btn--sm btn--primary" data-action="recruit-ob-invite" ${chosen.length || pending.length ? '' : 'disabled'}>${I.send} Invite ${chosen.length ? chosen.length : 'all'} to the wiki</button>
          ${chosen.length ? `<button class="icon-btn" data-action="recruit-ob-clear" aria-label="Clear selection" title="Clear selection">${I.x}</button>` : ''}
        </div>
      </div>
      <div class="sheet__scroll"><table aria-label="Accepted applicants">
        <thead><tr><th class="sheet__check-cell"></th><th>Person</th><th>Decided</th><th>On roster</th><th>Invited</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="faint">Nobody has been accepted yet.</td></tr>`}</tbody>
      </table></div>
      <div class="sheet__foot" role="status">${st.rows.length} accepted · ${st.rows.filter((r) => r.onboardedAt).length} onboarded</div>
    </div>
  </section>`;
}

/* ------------------------------- actions ---------------------------------- */

function rcObPaintSelection() {
  const st = rcObState();
  if (!st?.rows) return;
  const selected = rcObSelected();
  const pending = st.rows.filter((r) => !r.onboardedAt && r.onRoster !== 'active' && r.email);
  const chosen = pending.filter((r) => selected.has(r.applicationId)).length;
  const count = $('[data-ob-count]');
  if (count) count.textContent = chosen ? `${chosen} selected` : `${pending.length} to invite`;
  const btn = $('[data-action="recruit-ob-invite"]');
  if (btn) { btn.disabled = !(chosen || pending.length); btn.innerHTML = `${I.send} Invite ${chosen ? chosen : 'all'} to the wiki`; }
}

function rcObInviteConfirm(ids) {
  const st = rcObState();
  const rows = (st?.rows || []).filter((r) => ids.includes(r.applicationId));
  if (!rows.length) { toast('Nobody to invite'); return; }
  const m = { kind: 'confirm', title: `Invite ${rows.length} to the wiki?`, confirm: 'Invite',
    text: `They join as members and get the welcome email.<br><span class="faint">${rows.map((r) => MD.esc(r.email)).join(', ')}</span>`,
    requestId: 'rq-' + crypto.randomUUID(),
    onGo: () => rcObInvite(ids, m.requestId) };
  UI.modal = m;
  render();
}

async function rcObInvite(ids, requestId) {
  const cycleId = UI.recruit?.cycleId;
  if (!cycleId || rcObBusy().has('ob-invite')) return;
  rcObBusy().add('ob-invite');
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${cycleId}/onboarding`, { method: 'POST', body: JSON.stringify({ requestId, ids }), signal: AbortSignal.timeout(RC_OB_TIMEOUT) });
    const bits = [];
    if (out.invited) bits.push(`${out.invited} invited`);
    if (out.active) bits.push(`${out.active} already on the roster`);
    if (out.failed) bits.push(`${out.failed} failed`);
    const unsent = (out.results || []).filter((r) => r.status === 'invited' && r.emailed && !r.emailed.sent).length;
    if (unsent) bits.push(`${unsent} without a welcome email`);
    toast(bits.join(' · ') || 'Nothing to do');
    rcObSelected().clear();
  } catch (e) {
    toast(rcObMsg(e));
  } finally { rcObBusy().delete('ob-invite'); }
  rcObRefresh();
}

/* ------------------------------- register --------------------------------- */

RECRUIT.register({
  name: 'onboarding',
  order: 90,
  panel: { id: 'onboarding', label: 'Onboarding', when: (cycle, role) => cycle?.doc?.modules?.onboarding !== false && role === 'admin' },
  view: rcObView,
  mount(cycle) {
    if (typeof REMOTE === 'undefined' || !cycle) return;
    const st = rcObState();
    if (st === undefined || (st.key && st.key !== cycle.id)) { rcObSelected().clear(); rcObLoad(cycle); }
  },
  actions: {
    'recruit-ob-refresh': (el, ev, stop) => { stop?.(); rcObRefresh(); },
    'recruit-ob-select': (el, ev) => { ev?.stopPropagation?.(); const s = rcObSelected(); if (el.checked) s.add(el.dataset.id); else s.delete(el.dataset.id); rcObPaintSelection(); },
    'recruit-ob-clear': (el, ev, stop) => { stop?.(); rcObSelected().clear(); render(); },
    'recruit-ob-invite': (el, ev, stop) => {
      stop?.();
      const st = rcObState();
      const pending = (st?.rows || []).filter((r) => !r.onboardedAt && r.onRoster !== 'active' && r.email).map((r) => r.applicationId);
      const chosen = pending.filter((id) => rcObSelected().has(id));
      const ids = el.dataset.ids ? JSON.parse(el.dataset.ids) : chosen.length ? chosen : pending;
      rcObInviteConfirm(ids.slice(0, 100));
    },
  },
  inputs: {},
  dd: {},
  modals: {},
  columns: [],
  filters: [{ group: 'Onboarding', value: 'onboarding:done', label: 'Onboarded', test: (row) => !!row.onboardedAt || !!row.extras?.onboarding }],
  selectionActions: (ids, cycle, role) => (cycle?.doc?.modules?.onboarding !== false && role === 'admin'
    ? [{ id: 'onboard', label: 'Invite to wiki', action: 'recruit-ob-invite', run: () => { const st = rcObState(); const known = st?.rows ? new Set(st.rows.map((r) => r.applicationId)) : null; const list = [...ids].filter((id) => !known || known.has(id)); if (!list.length) { toast('Only accepted people can be invited. Open Onboarding to see who is ready.'); return; } rcObInviteConfirm(list.slice(0, 100)); } }] : []),
  detailSections: (app, cycle, role) => {
    if (role !== 'admin') return [];
    const ob = app.extras?.onboarding || app.onboarding;
    const html = app.onboardedAt ? `<p style="margin:0">Invited to the wiki ${MD.esc(recruitDate(app.onboardedAt))}${ob?.status ? ` · ${MD.esc(ob.status)}` : ''}</p>`
      : app.outcome === 'accepted' ? `<p style="margin:0"><button class="btn btn--sm" data-action="recruit-ob-invite" data-ids="${MD.esc(JSON.stringify([app.id]))}">${I.send} Invite to the wiki</button></p>` : `<p class="faint" style="margin:0">Accepted people can be invited.</p>`;
    return [{ id: 'onboarding', title: 'Onboarding', html }];
  },
  reset() { rcObSet(undefined); },
});
// recruit:onboarding:end
