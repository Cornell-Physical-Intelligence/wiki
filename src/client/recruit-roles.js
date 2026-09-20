/* ============================================================================
   Applications — roles module (client). Settings/Roles (who may lead, review
   or interview in a cycle, from the wiki roster), the cycle's activity log,
   and the Activity section of the application dialog.
   ========================================================================== */

'use strict';

// recruit:roles:start

const RECRUIT_ROLE_LABELS = { admin: 'Admin', lead: 'Lead', reviewer: 'Reviewer', interviewer: 'Interviewer' };

function recruitRolesState() {
  const st = recruitState();
  return st.mod.roles;   // undefined | {loading:true} | {error} | { roles, members }
}

function recruitLoadRoles(cycle) {
  const st = recruitState();
  if (!cycle || !recruitCan('lead')) return;
  if (st.mod.roles?.loading) return;
  st.mod.roles = { loading: true };
  const key = st.key;
  RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/roles`)
    .then((out) => {
      if (st.key !== key) return;
      st.mod.roles = { roles: Array.isArray(out.roles) ? out.roles : [], members: Array.isArray(out.members) ? out.members : [] };
      if (!recruitPaintRoles()) renderBackground('recruit');
    })
    .catch((e) => { if (st.key !== key) return; st.mod.roles = { error: recruitError(e) }; if (!recruitPaintRoles()) renderBackground('recruit'); });
}

function recruitPaintRoles() {
  const host = $('[data-rc="roles"]');
  if (!host) return false;
  recruitRepaint(host, recruitRolesListHtml(recruitCycleRow()));
  // The picker was drawn before the roster arrived; redraw it unless the
  // lead has already started filling the form in.
  const formHost = $('[data-rc="roles-form"]');
  const form = formHost && $('form', formHost);
  if (formHost && !(form?.dataset.adminDirty === 'true' || formHost.contains(document.activeElement))) formHost.innerHTML = recruitRolesFormHtml(recruitCycleRow(), recruitState().mod.rolesEdit || null);
  return true;
}

function recruitRolesListHtml(cycle) {
  const s = recruitRolesState();
  if (!s || s.loading) return '<p class="sheet__note" style="margin:0">Loading…</p>';
  if (s.error) return `<p class="sheet__note" style="margin:0">Could not load: ${MD.esc(s.error)}. <button class="linklike" data-action="recruit-roles-retry">Retry</button></p>`;
  const admin = recruitCan('admin');
  if (!s.roles.length) return '<p class="admin-block__sub" style="margin:0">No one has a role in this cycle yet. Admins see everything.</p>';
  return `<div class="audit">${s.roles.map((r) => {
    const member = s.members.find((m) => m.email === r.member);
    const who = r.name || member?.name || r.member;
    const roles = (r.roles || []).map((x) => RECRUIT_ROLE_LABELS[x] || x).join(', ');
    const teams = Array.isArray(r.subteams) && r.subteams.length ? r.subteams.map((k) => recruitSubteams(cycle).find((t) => t.key === k)?.name || k).join(', ') : 'All subteams';
    return `<div class="audit__row" data-member="${MD.esc(r.member)}"><span class="audit__what"><b>${MD.esc(who)}</b> <span class="faint">${MD.esc(r.member)}</span> · ${MD.esc(roles || 'No role')} · ${MD.esc(teams)}</span>
      ${admin ? `<button class="btn btn--sm" style="margin-left:auto" data-action="recruit-role-edit" data-member="${MD.esc(r.member)}">Edit</button><button class="btn btn--sm btn--danger" data-action="recruit-role-remove" data-member="${MD.esc(r.member)}" aria-label="Remove ${MD.esc(who)}">Remove</button>` : ''}</div>`;
  }).join('')}</div>`;
}

function recruitRolesFormHtml(cycle, edit) {
  const s = recruitRolesState();
  const members = s?.members || [];
  const admin = recruitCan('admin');
  const current = edit ? (s?.roles || []).find((r) => r.member === edit) : null;
  const granted = new Set((s?.roles || []).map((r) => r.member));
  const options = current
    ? [{ value: current.member, label: `${current.name || members.find((m) => m.email === current.member)?.name || current.member}` }]
    : [{ value: '', label: 'Choose a member' }, ...members.filter((m) => !granted.has(m.email)).map((m) => ({ value: m.email, label: m.subteam ? `${m.name} · ${m.subteam}` : m.name }))];
  const has = (x) => Boolean(current?.roles?.includes(x));
  const teams = recruitSubteams(cycle);
  const picked = new Set(current?.subteams || []);
  return `<form class="rc-form" data-action="recruit-settings-roles" data-member="${MD.esc(current?.member || '')}">
    ${recruitFormField('Member', dd('recruit-role-member', options, current?.member || ''))}
    <div class="rc-checks" role="group" aria-label="Roles">
      ${admin ? `<label class="rc-check"><input type="checkbox" name="lead" ${has('lead') ? 'checked' : ''}> Lead <span class="sub">runs the cycle, everything but delete and intake</span></label>` : ''}
      <label class="rc-check"><input type="checkbox" name="reviewer" ${has('reviewer') ? 'checked' : ''}> Reviewer <span class="sub">scores the applications assigned to them</span></label>
      <label class="rc-check"><input type="checkbox" name="interviewer" ${has('interviewer') ? 'checked' : ''}> Interviewer <span class="sub">runs their booked interviews</span></label>
    </div>
    ${teams.length ? `<div class="rc-checks" role="group" aria-label="Subteams"><span class="sub">Limit to subteams (none = all)</span>${teams.map((t) => `<label class="rc-check"><input type="checkbox" name="subteam:${MD.esc(t.key)}" ${picked.has(t.key) ? 'checked' : ''}> ${MD.esc(t.name)}</label>`).join('')}</div>` : ''}
    <div class="rc-form__foot">${current ? '<button type="button" class="btn" data-action="recruit-role-edit-cancel">Cancel</button>' : ''}<span style="flex:1"></span><button type="submit" class="btn btn--primary">${current ? 'Save role' : 'Grant role'}</button></div>
  </form>`;
}

function recruitRolesSectionHtml(cycle, role) {
  const st = recruitState();
  return `<p class="admin-block__sub">Admins see every cycle. Leads run this one; reviewers and interviewers see only what they are assigned.</p>
    <div data-rc="roles">${recruitRolesListHtml(cycle)}</div>
    <div data-rc="roles-form" style="margin-top:16px">${recruitRolesFormHtml(cycle, st.mod.rolesEdit || null)}</div>`;
}

async function recruitSubmitRole(form, cycle) {
  const st = recruitState();
  const member = String($('[data-m="recruit-role-member"]', form)?.dataset.value || form.dataset.member || '').trim().toLowerCase();
  if (!member) throw new Error('Choose a member.');
  const roles = ['lead', 'reviewer', 'interviewer'].filter((r) => form.elements[r]?.checked);
  if (!roles.length) throw new Error('Pick at least one role.');
  if (roles.includes('lead') && !recruitCan('admin')) throw new Error('Only admins grant the lead role.');
  const subteams = [...form.elements].filter((el) => el.name?.startsWith('subteam:') && el.checked).map((el) => el.name.slice('subteam:'.length));
  st.mod.roleRequest ||= {};
  const requestId = st.mod.roleRequest[member] ||= recruitId('rq');
  const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/roles/${encodeURIComponent(member)}`, { method: 'PUT', body: JSON.stringify({ requestId, roles, subteams }) });
  delete st.mod.roleRequest[member];
  if (st.mod.roles?.roles) {
    const row = out.role || { member, roles, subteams, ts: Date.now() };
    const i = st.mod.roles.roles.findIndex((r) => r.member === member);
    if (i >= 0) st.mod.roles.roles[i] = { ...st.mod.roles.roles[i], ...row }; else st.mod.roles.roles.push(row);
  }
  st.mod.rolesEdit = null;
  form.dataset.adminDirty = 'false';
  toast(`${RECRUIT_ROLE_LABELS[roles[0]] || 'Role'} granted`);
  renderBackground('recruit');
}

function recruitConfirmRoleRemoval(member) {
  const cycle = recruitCycleRow();
  const st = recruitState();
  if (!cycle || !recruitCan('admin')) return;
  const row = st.mod.roles?.roles?.find((r) => r.member === member);
  if (!row) return;
  UI.modal = {
    kind: 'confirm', title: 'Remove this role?', danger: true, confirm: 'Remove',
    text: `<b>${MD.esc(row.name || member)}</b> loses access to ${MD.esc(cycle.name)}. Scores and assignments they already made stay.`,
    onGo: async () => {
      try {
        await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/roles/${encodeURIComponent(member)}`, { method: 'DELETE' });
        if (st.mod.roles?.roles) st.mod.roles.roles = st.mod.roles.roles.filter((r) => r.member !== member);
        toast('Role removed');
      } catch (e) { toast(`Could not remove: ${recruitError(e)}`); }
      finally { renderBackground('recruit'); }
    },
  };
  render();
}

/* ------------------------------- activity -------------------------------- */

const RECRUIT_AUDIT_LABELS = {
  'cycle.create': 'created the cycle', 'cycle.update': 'updated the cycle', 'cycle.status': 'changed the cycle status', 'cycle.intake': 'changed the website form target', 'cycle.delete': 'deleted the cycle',
  'form.publish': 'published a form', 'app.create': 'application received', 'app.edit': 'edited the application', 'app.delete': 'deleted an application', 'app.erase': 'erased an applicant', 'app.flag': 'changed the flag',
  'comment.post': 'commented', 'comment.delete': 'deleted a comment', stage: 'moved the stage', decision: 'recorded a decision', tag: 'changed tags', assign: 'assigned', unassign: 'unassigned', score: 'scored', coi: 'declared a conflict',
  slot: 'changed interview slots', booking: 'changed a booking', rsvp: 'RSVP received', mail: 'sent email', role: 'changed a role', onboard: 'invited to the wiki', 'queue.place': 'placed a saved submission', migrate: 'imported the old list', purge: 'purged personal data',
};

function recruitAuditLine(a) {
  const kind = String(a.kind || '');
  let label = RECRUIT_AUDIT_LABELS[kind] || (kind.startsWith('cycle.settings.') ? `changed ${kind.slice('cycle.settings.'.length)} settings` : kind);
  const d = a.detail || {};
  if (kind === 'stage' && d.to) label = `moved to ${d.to}${d.from ? ` from ${d.from}` : ''}`;
  if (kind === 'decision' && d.outcome) label = `decided: ${d.outcome}`;
  const actor = a.actor === 'applicant' ? 'The applicant' : a.actor === 'system' ? 'System' : (Store.userName?.(a.actor) || a.actor || 'Someone');
  return `<div class="audit__row"><span class="audit__when" title="${MD.esc(new Date(Number(a.ts)).toLocaleString())}">${MD.esc(Store.relTime ? Store.relTime(Number(a.ts)) : recruitDate(Number(a.ts)))}</span><span class="audit__what"><b>${MD.esc(actor)}</b> ${MD.esc(label)}${a.applicationId && !UI.modal ? ` · <button class="linklike" data-action="recruit-app-open" data-id="${MD.esc(a.applicationId)}">application</button>` : ''}</span></div>`;
}

function recruitLoadActivity(cycle) {
  const st = recruitState();
  if (!cycle || !recruitCan('lead') || st.mod.activity?.loading) return;
  st.mod.activity = { loading: true };
  const key = st.key;
  RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/audit`)
    .then((out) => { if (st.key !== key) return; st.mod.activity = { rows: Array.isArray(out.rows) ? out.rows : [], next: out.next || null }; if (!recruitPaintActivity()) renderBackground('recruit'); })
    .catch((e) => { if (st.key !== key) return; st.mod.activity = { error: recruitError(e) }; if (!recruitPaintActivity()) renderBackground('recruit'); });
}

function recruitPaintActivity() {
  const host = $('[data-rc="activity"]');
  return host ? recruitRepaint(host, recruitActivityListHtml()) : false;
}

function recruitActivityListHtml() {
  const s = recruitState().mod.activity;
  if (!s || s.loading) return '<p class="sheet__note" style="margin:0">Loading…</p>';
  if (s.error) return `<p class="sheet__note" style="margin:0">Could not load: ${MD.esc(s.error)}. <button class="linklike" data-action="recruit-activity-retry">Retry</button></p>`;
  if (!s.rows.length) return '<p class="admin-block__sub" style="margin:0">Nothing has happened in this cycle yet.</p>';
  return `<div class="audit">${s.rows.slice(0, 50).map(recruitAuditLine).join('')}</div>${s.rows.length > 50 ? `<p class="sheet__note" style="margin:8px 0 0">Showing 50 of ${s.rows.length}. <a href="/api/recruit/cycles/${MD.esc(encodeURIComponent(recruitCycleRow()?.id || ''))}/audit.csv" download>Download the CSV</a> for the rest.</p>` : ''}`;
}

/* ------------------------------- register -------------------------------- */

RECRUIT.register({
  name: 'roles',
  order: 20,
  kernel: true,
  settings: [
    {
      id: 'roles', label: 'Roles', when: () => recruitCan('lead'),
      view: recruitRolesSectionHtml,
      submit: recruitSubmitRole,
      mount: (cycle) => { if (recruitRolesState() === undefined) recruitLoadRoles(cycle); },
    },
    {
      id: 'activity', label: 'Activity', when: () => recruitCan('lead'),
      view: () => `<div data-rc="activity">${recruitActivityListHtml()}</div>`,
      mount: (cycle) => { if (recruitState().mod.activity === undefined) recruitLoadActivity(cycle); },
    },
  ],
  detailSections: (app, cycle, role) => {
    if (!recruitCan('lead') || !Array.isArray(app.audit)) return null;
    return { id: 'activity', title: 'Activity', html: app.audit.length ? `<div class="audit rc-audit--compact">${app.audit.slice(0, 20).map(recruitAuditLine).join('')}</div>` : '<p class="faint" style="margin:0;font-size:13px">No activity yet.</p>' };
  },
  actions: {
    'recruit-roles-retry': () => { const st = recruitState(); st.mod.roles = undefined; recruitLoadRoles(recruitCycleRow()); recruitPaintRoles(); },
    'recruit-activity-retry': () => { const st = recruitState(); st.mod.activity = undefined; recruitLoadActivity(recruitCycleRow()); recruitPaintActivity(); },
    'recruit-role-edit': (el) => {
      const st = recruitState();
      st.mod.rolesEdit = el.dataset.member;
      const host = $('[data-rc="roles-form"]');
      if (host) { host.innerHTML = recruitRolesFormHtml(recruitCycleRow(), st.mod.rolesEdit); $('input[type="checkbox"]', host)?.focus(); }
    },
    'recruit-role-edit-cancel': () => {
      const st = recruitState();
      st.mod.rolesEdit = null;
      const host = $('[data-rc="roles-form"]');
      if (host) { host.innerHTML = recruitRolesFormHtml(recruitCycleRow(), null); $('[data-m="recruit-role-member"]', host)?.focus(); }
    },
    'recruit-role-remove': (el) => recruitConfirmRoleRemoval(el.dataset.member),
  },
  reset() { const st = recruitState(); st.mod.rolesEdit = null; },
});

// recruit:roles:end
