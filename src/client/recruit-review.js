// recruit:review:start
'use strict';

/* Review (client): the reviewer queue, the scorecard dialog, the lead's
   assignment and calibration blocks, the Auto-assign dialog and the Review
   settings section. State lives on UI.recruit.mod.review with the
   undefined | {loading:true} | {error} | data sentinel; async completions
   paint regions in place or call renderBackground, never render(). */

const RC_REVIEW_RECS = [{ value: '', label: 'No recommendation' }, { value: 'strong_yes', label: 'Strong yes' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }, { value: 'strong_no', label: 'Strong no' }];
const RC_REVIEW_REC_LABEL = Object.fromEntries(RC_REVIEW_RECS.map((r) => [r.value, r.label]));

function rcReviewCycle() { return UI.recruit?.cycle?.data || null; }
function rcReviewRole() { return UI.recruit?.cycle?.role || null; }
function rcReviewLead(role = rcReviewRole()) { return role === 'admin' || role === 'lead'; }
function rcReviewMe() { return (typeof Store !== 'undefined' && Store.me?.()?.email) || UI.recruit?.me?.email || ''; }
function rcReviewSettings(cycle) {
  const s = cycle?.doc?.review || {};
  return { blind: s.blind || 'until-submitted', visibility: s.visibility || 'assigned', perApplication: s.perApplication || 2, editAfterSubmit: s.editAfterSubmit === true, rubric: s.rubric || { version: 1, scale: 5, criteria: [] } };
}
function rcReviewState() {
  UI.recruit ||= {};
  UI.recruit.mod ||= {};
  return (UI.recruit.mod.review ||= { key: null, data: undefined, summary: undefined, queue: undefined, roster: undefined, cards: {}, drafts: {}, rubricDraft: null });
}
function rcReviewDraft(id) {
  const st = rcReviewState();
  return (st.drafts[id] ||= { scores: {}, notes: '', recommendation: null, conflict: false, sending: false, error: '' });
}
function rcReviewError(e) { return e?.name === 'TimeoutError' ? 'The request timed out. Try again.' : (e?.message || 'Something went wrong'); }
const rcReviewNum = (n) => (n == null ? '—' : String(Math.round(n * 100) / 100));
function rcReviewGet(path) { return RECRUIT.api(path, { signal: AbortSignal.timeout(20000) }); }

/* -------------------------------- loaders ------------------------------- */

// Every loader checks the cycle key on return so a late answer after a
// cycle switch is dropped, then repaints through renderBackground.
function rcReviewLoad(cycle, field, path, shape) {
  const st = rcReviewState();
  if (st[field] !== undefined) return;
  st[field] = { loading: true };
  const key = cycle.id;
  rcReviewGet(path).then((out) => {
    if (rcReviewState().key !== key) return;
    rcReviewState()[field] = shape(out);
    renderBackground('recruit');
  }).catch((e) => {
    if (rcReviewState().key !== key) return;
    rcReviewState()[field] = { error: rcReviewError(e) };
    renderBackground('recruit');
  });
}
function rcReviewMount(cycle) {
  if (typeof REMOTE === 'undefined' || !cycle) return;
  const st = rcReviewState();
  if (st.key !== cycle.id) Object.assign(st, { key: cycle.id, data: undefined, summary: undefined, queue: undefined, roster: undefined, cards: {}, drafts: {}, rubricDraft: null });
  rcReviewLoad(cycle, 'data', `/recruit/cycles/${cycle.id}/assignments`, (out) => ({ assignments: out.assignments || [], load: out.load || [] }));
  if (rcReviewLead()) rcReviewLoad(cycle, 'summary', `/recruit/cycles/${cycle.id}/scores/summary`, (out) => ({ rows: out.rows || [], members: out.members || [] }));
  else rcReviewLoad(cycle, 'queue', `/recruit/cycles/${cycle.id}/applications?assigned=me&limit=200`, (out) => ({ rows: out.rows || [] }));
}

/* --------------------------------- views -------------------------------- */

function rcReviewQueueRows() {
  const st = rcReviewState();
  const rows = st.queue?.rows || [];
  const scored = (r) => r.extras?.score?.mine != null;
  return [...rows].sort((a, b) => (scored(a) - scored(b)) || (a.ts - b.ts));
}
function rcReviewNextId(id) {
  const rows = rcReviewQueueRows().filter((r) => r.extras?.score?.mine == null && r.id !== id);
  return rows[0]?.id || null;
}
function rcReviewQueueHtml(cycle) {
  const st = rcReviewState();
  if (st.queue === undefined || st.queue?.loading) return '<p class="sheet__note">Loading…</p>';
  if (st.queue?.error) return `<p class="sheet__note">${MD.esc(st.queue.error)} <button class="linklike" data-action="recruit-review-refresh">Retry</button></p>`;
  const rows = rcReviewQueueRows();
  const done = rows.filter((r) => r.extras?.score?.mine != null).length;
  const stageName = (key) => (cycle?.doc?.pipeline?.stages || []).find((s) => s.key === key)?.name || key;
  return `<div class="sheet">
    <div class="sheet__bar"><span class="sheet__heading">My queue</span><span class="count">${rows.length}</span><div class="sheet__actions"><button class="btn btn--sm" data-action="recruit-review-refresh">Refresh</button></div></div>
    <div class="sheet__scroll"><table aria-label="My review queue"><thead><tr><th>Person</th><th>Subteam</th><th>Stage</th><th>My score</th></tr></thead><tbody>
      ${rows.length ? rows.map((r) => `<tr data-id="${MD.esc(r.id)}">
        <td><button class="interest-person" data-action="recruit-scorecard-open" data-id="${MD.esc(r.id)}"><b>${MD.esc(r.name)}</b><span class="mail">${MD.esc(r.email)}</span></button></td>
        <td>${MD.esc(r.subteam || '—')}</td><td>${MD.esc(stageName(r.stage))}</td><td class="font-mono">${rcReviewNum(r.extras?.score?.mine)}</td></tr>`).join('') : '<tr><td colspan="4" class="faint">Nothing assigned to you yet.</td></tr>'}
    </tbody></table></div>
    <div class="sheet__foot" role="status">${done} of ${rows.length} scored</div>
  </div>`;
}
function rcReviewLeadHtml(cycle) {
  const st = rcReviewState();
  const settings = rcReviewSettings(cycle);
  const note = (v) => (v === undefined || v?.loading ? '<p class="sheet__note">Loading…</p>' : v?.error ? `<p class="sheet__note">${MD.esc(v.error)} <button class="linklike" data-action="recruit-review-refresh">Retry</button></p>` : null);
  const load = st.data?.load || [];
  const assignments = st.data?.assignments || [];
  const apps = new Set(assignments.filter((a) => a.kind === 'reviewer').map((a) => a.applicationId));
  const doneApps = new Set(assignments.filter((a) => a.kind === 'reviewer' && a.status === 'done').map((a) => a.applicationId));
  const conflicts = assignments.filter((a) => a.status === 'coi').length;
  const summary = st.summary?.rows || [];
  const members = (st.summary?.members || []).map((m) => m.email);
  const calibration = [...summary].filter((r) => r.n).sort((a, b) => (b.spread - a.spread) || a.name.localeCompare(b.name));
  return `<div class="admin-grid">
    <section class="admin-block"><div class="admin-block__head"><h2>Progress</h2></div>
      ${note(st.data) || `<p>${doneApps.size} of ${apps.size} screened · ${conflicts} conflict${conflicts === 1 ? '' : 's'}</p>`}</section>
    <section class="admin-block"><div class="admin-block__head"><h2>Rubric</h2><span class="count">${settings.rubric.criteria.length}</span></div>
      <table><thead><tr><th>Criterion</th><th>Weight</th></tr></thead><tbody>${settings.rubric.criteria.map((c) => `<tr><td>${MD.esc(c.name)}</td><td class="font-mono">${MD.esc(String(c.weight))}</td></tr>`).join('')}</tbody></table>
      <p class="faint">Scale 1 to ${settings.rubric.scale} · blind ${settings.blind === 'off' ? 'off' : 'until submitted'} · <a href="#/applications/${MD.esc(cycle.id)}/settings">Edit in Settings</a></p></section>
    <section class="admin-block"><div class="admin-block__head"><h2>Assignments</h2><button class="btn btn--sm" data-action="recruit-assign-open">Auto-assign…</button></div>
      ${note(st.data) || (load.length ? `<table><thead><tr><th>Reviewer</th><th>Assigned</th><th>Done</th><th>Conflicts</th><th>Mean</th></tr></thead><tbody>${load.map((m) => `<tr><td>${MD.esc(m.name || m.member)}</td><td class="font-mono">${m.assigned}</td><td class="font-mono">${m.done}</td><td class="font-mono">${m.coi}</td><td class="font-mono">${rcReviewNum(m.mean)}</td></tr>`).join('')}</tbody></table>` : '<p class="faint">Nobody is assigned yet.</p>')}</section>
    <section class="admin-block"><div class="admin-block__head"><h2>Calibration</h2><span class="count">${calibration.length}</span></div>
      ${note(st.summary) || (calibration.length ? `<div class="sheet__scroll"><table><thead><tr><th>Person</th><th>Subteam</th><th>n</th><th>Mean</th><th>Spread</th>${members.map((m) => `<th>${MD.esc(m.split('@')[0])}</th>`).join('')}</tr></thead><tbody>${calibration.map((r) => `<tr><td><button class="interest-person" data-action="recruit-scorecard-open" data-id="${MD.esc(r.id)}"><b>${MD.esc(r.name)}</b></button></td><td>${MD.esc(r.subteam || '—')}</td><td class="font-mono">${r.n}</td><td class="font-mono">${rcReviewNum(r.mean)}</td><td class="font-mono">${rcReviewNum(r.spread)}</td>${members.map((m) => `<td class="font-mono">${rcReviewNum(r.byMember?.[m])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        ${st.summary.members?.length ? `<p class="faint">${st.summary.members.map((m) => `${MD.esc(m.email.split('@')[0])} ${rcReviewNum(m.mean)} ±${rcReviewNum(m.sd)}`).join(' · ')}</p>` : ''}` : '<p class="faint">No submitted scorecards yet.</p>')}</section>
  </div>`;
}

/* ------------------------------- scorecard ------------------------------ */

function rcReviewCard(id) { return rcReviewState().cards[id]; }
function rcReviewLocked(id) {
  const card = rcReviewCard(id);
  const mine = card?.mine;
  return Boolean(mine?.submitted) && !rcReviewSettings(rcReviewCycle()).editAfterSubmit && !rcReviewLead();
}
function rcReviewAnswersHtml(id) {
  const detail = UI.recruit?.detail?.[id];
  if (!detail || detail.loading) return '<p class="sheet__note">Loading…</p>';
  if (detail.error) return `<p class="sheet__note">${MD.esc(detail.error)}</p>`;
  const app = detail.application || detail;
  const questions = detail.form?.questions || [];
  const answers = app.answers || {};
  const label = (key) => questions.find((q) => q.key === key)?.label || key;
  const rows = Object.entries(answers).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `<dt>${MD.esc(label(k))}</dt><dd>${MD.esc(Array.isArray(v) ? v.join(', ') : String(v))}</dd>`).join('');
  const files = (app.files || []).map((f) => `<li><a href="/api/recruit/files/${MD.esc(f.id)}" download="${MD.esc(f.name || 'file')}">${MD.esc(f.name || 'Attachment')}</a></li>`).join('');
  return `<dl class="interest-detail"><dt>Subteam</dt><dd>${MD.esc(app.subteam || '—')}</dd><dt>Year</dt><dd>${MD.esc(app.year || '—')}</dd>${rows}</dl>${files ? `<ul class="rc-files">${files}</ul>` : ''}`;
}
function rcReviewCriteriaHtml(id) {
  const card = rcReviewCard(id);
  if (!card || card.loading) return '<p class="sheet__note">Loading…</p>';
  if (card.error) return `<p class="sheet__note">${MD.esc(card.error)}</p>`;
  const rubric = card.rubric || rcReviewSettings(rcReviewCycle()).rubric;
  const draft = rcReviewDraft(id);
  const locked = rcReviewLocked(id) || draft.conflict;
  return rubric.criteria.map((c) => `<div class="rc-scorecard__row" role="group" aria-label="${MD.esc(c.name)}">
    <span class="rc-scorecard__name">${MD.esc(c.name)} <span class="faint">×${MD.esc(String(c.weight))}</span>${c.help ? `<span class="faint rc-scorecard__help">${MD.esc(c.help)}</span>` : ''}</span>
    <span class="rc-scorecard__scale">${Array.from({ length: rubric.scale }, (_, i) => i + 1).map((n) => `<button type="button" class="btn btn--sm" data-action="recruit-score-pick" data-key="${MD.esc(c.key)}" data-n="${n}" aria-pressed="${draft.scores[c.key] === n}" ${locked ? 'disabled' : ''}>${n}</button>`).join('')}</span>
  </div>`).join('');
}
function rcReviewOthersHtml(id) {
  const card = rcReviewCard(id);
  if (!card || card.loading || card.error) return '';
  if (card.others === null || card.others === undefined) return card.blind === 'off' ? '' : '<p class="faint">Other scorecards appear after you submit.</p>';
  const agg = card.aggregate;
  const lines = card.others.map((o) => `<li>${MD.esc(o.member.split('@')[0])} <span class="font-mono">${rcReviewNum(o.doc?.total)}</span>${o.doc?.recommendation ? ` · ${MD.esc(RC_REVIEW_REC_LABEL[o.doc.recommendation] || o.doc.recommendation)}` : ''}</li>`).join('');
  return `<h4 class="interest-subhead">Other scorecards <span class="count">${card.others.length}</span></h4>${agg ? `<p class="faint">Mean <span class="font-mono">${rcReviewNum(agg.mean)}</span> · spread <span class="font-mono">${rcReviewNum(agg.spread)}</span> · ${agg.n} submitted</p>` : ''}${lines ? `<ul class="rc-others">${lines}</ul>` : '<p class="faint">None yet.</p>'}`;
}
function rcReviewFootHtml(id) {
  const card = rcReviewCard(id);
  const draft = rcReviewDraft(id);
  if (!card || card.loading || card.error) return '<button class="btn" data-action="modal-close">Close</button>';
  if (rcReviewLocked(id)) return `<span class="faint">Submitted ${recruitDate(card.mine.submitted)}</span><button class="btn" data-action="modal-close">Close</button>`;
  const busy = draft.sending;
  const next = rcReviewNextId(id);
  return `<button class="btn" data-action="modal-close">Close</button>
    ${draft.conflict ? '' : `<button class="btn" data-action="recruit-score-save" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : 'Save draft'}</button>`}
    <button class="btn btn--primary" data-action="recruit-score-submit" ${busy ? 'disabled' : ''}>${busy ? 'Submitting…' : 'Submit'}</button>
    ${next && !rcReviewLead() ? `<button class="btn btn--primary" data-action="recruit-score-next" ${busy ? 'disabled' : ''}>Submit and next</button>` : ''}`;
}
function rcReviewCardTitle(id) {
  const detail = UI.recruit?.detail?.[id];
  const app = detail?.application || detail;
  const row = rcReviewQueueRows().find((r) => r.id === id) || UI.recruit?.apps?.byId?.[id];
  return app?.name || row?.name || 'Scorecard';
}
function rcReviewScorecardModal(m) {
  const id = m.id;
  const draft = rcReviewDraft(id);
  return `<div class="modal modal--wide rc-scorecard" role="dialog" aria-label="Scorecard">
    <div class="modal__head"><h3 data-rc-title>${MD.esc(rcReviewCardTitle(id))}</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body rc-scorecard__body">
      <div class="rc-scorecard__answers" data-rc-answers>${rcReviewAnswersHtml(id)}</div>
      <div class="rc-scorecard__form">
        <div data-rc-criteria>${rcReviewCriteriaHtml(id)}</div>
        <label>Notes<textarea class="text-input" data-m="recruit-score-notes" maxlength="4000" rows="4" ${rcReviewLocked(id) ? 'readonly' : ''}>${MD.esc(draft.notes)}</textarea></label>
        <label>Recommendation ${dd('recruit-score-rec', RC_REVIEW_RECS, draft.recommendation || '')}</label>
        <label class="check"><input type="checkbox" data-action="recruit-score-coi" ${draft.conflict ? 'checked' : ''} ${rcReviewLocked(id) ? 'disabled' : ''}> I know this applicant (conflict of interest)</label>
        <div data-rc-others>${rcReviewOthersHtml(id)}</div>
        <p class="field-error" data-rc-error role="alert" ${draft.error ? '' : 'hidden'}>${MD.esc(draft.error || '')}</p>
      </div>
    </div>
    <div class="modal__foot" data-rc-foot>${rcReviewFootHtml(id)}</div>
  </div>`;
}
// In-place repaint: regions only, the notes field is left alone while
// focused, and focus lands back where it was.
function rcReviewPaintCard(id, { focusFirst = false } = {}) {
  if (UI.modal?.kind !== 'recruit-scorecard' || UI.modal.id !== id) return;
  const dialog = $('.rc-scorecard');
  if (!dialog) return;
  const draft = rcReviewDraft(id);
  const ref = focusReference(document.activeElement);
  const wasInside = dialog.contains(document.activeElement);
  const title = $('[data-rc-title]', dialog);
  if (title) title.textContent = rcReviewCardTitle(id);
  for (const [selector, html] of [['[data-rc-answers]', rcReviewAnswersHtml(id)], ['[data-rc-criteria]', rcReviewCriteriaHtml(id)], ['[data-rc-others]', rcReviewOthersHtml(id)], ['[data-rc-foot]', rcReviewFootHtml(id)]]) {
    const region = $(selector, dialog);
    if (region) region.innerHTML = html;
  }
  const error = $('[data-rc-error]', dialog);
  if (error) { error.textContent = draft.error || ''; error.hidden = !draft.error; }
  const notes = $('[data-m="recruit-score-notes"]', dialog);
  if (notes && notes !== document.activeElement && notes.value !== draft.notes) notes.value = draft.notes;
  if (notes) notes.readOnly = rcReviewLocked(id);
  const coi = $('[data-action="recruit-score-coi"]', dialog);
  if (coi) coi.checked = draft.conflict;
  // Focus returns to the same control; when that control is gone (the
  // scorecard locked) it lands on the first usable one instead.
  const target = resolveFocus(ref, dialog);
  if (target) { if (target !== document.activeElement) target.focus({ preventScroll: true }); }
  else if (focusFirst || wasInside) ($('[data-action="recruit-score-pick"]:not([disabled])', dialog) || $('[data-action="modal-close"]', dialog))?.focus({ preventScroll: true });
}
function rcReviewEnsureCard(id) {
  const cycle = rcReviewCycle();
  const st = rcReviewState();
  if (!cycle) return;
  const scoreKind = UI.modal?.scoreKind || 'review';
  const round = UI.modal?.round || '';
  if (st.cards[id] === undefined) {
    st.cards[id] = { loading: true };
    const key = cycle.id;
    rcReviewGet(`/recruit/cycles/${cycle.id}/applications/${id}/scores?kind=${scoreKind}${round ? '&round=' + encodeURIComponent(round) : ''}`).then((out) => {
      if (rcReviewState().key !== key) return;
      rcReviewState().cards[id] = { mine: out.mine || null, others: out.others ?? null, aggregate: out.aggregate ?? null, rubric: out.rubric, blind: out.blind };
      const draft = rcReviewDraft(id);
      if (out.mine?.doc && !draft.touched) Object.assign(draft, { scores: { ...(out.mine.doc.scores || {}) }, notes: out.mine.doc.notes || '', recommendation: out.mine.doc.recommendation || null, conflict: out.mine.doc.conflict === true });
      rcReviewPaintCard(id, { focusFirst: true });
    }).catch((e) => {
      if (rcReviewState().key !== key) return;
      rcReviewState().cards[id] = { error: rcReviewError(e) };
      rcReviewPaintCard(id);
    });
  }
  UI.recruit.detail ||= {};
  if (UI.recruit.detail[id] === undefined) {
    UI.recruit.detail[id] = { loading: true };
    const key = cycle.id;
    rcReviewGet(`/recruit/cycles/${cycle.id}/applications/${id}`).then((out) => {
      if (rcReviewState().key !== key) return;
      UI.recruit.detail[id] = out;
      rcReviewPaintCard(id);
    }).catch((e) => {
      if (rcReviewState().key !== key) return;
      UI.recruit.detail[id] = { error: rcReviewError(e) };
      rcReviewPaintCard(id);
    });
  }
}
function rcReviewMergeQueue(id, score) {
  const total = score?.doc?.conflict ? null : score?.doc?.total ?? null;
  for (const row of [...(rcReviewState().queue?.rows || []), UI.recruit?.apps?.byId?.[id], UI.recruit?.apps?.rows?.find?.((r) => r.id === id)]) {
    if (!row || row.id !== id) continue;
    row.extras ||= {};
    row.extras.score = { ...(row.extras.score || {}), mine: total };
  }
}
async function rcReviewSubmit(id, { submit = false, next = false } = {}) {
  const cycle = rcReviewCycle();
  const st = rcReviewState();
  const draft = rcReviewDraft(id);
  const card = st.cards[id];
  if (!cycle || draft.sending || !card || card.loading) return;
  const scoreKind = UI.modal?.scoreKind || 'review';
  const round = UI.modal?.round || '';
  draft.sending = true;
  draft.error = '';
  rcReviewPaintCard(id);
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${cycle.id}/applications/${id}/scores/${scoreKind}${round ? '?round=' + encodeURIComponent(round) : ''}`, {
      method: 'PUT',
      body: JSON.stringify({ rubricVersion: card.rubric?.version, scores: draft.scores, notes: draft.notes, recommendation: draft.recommendation, conflict: draft.conflict, submit }),
      signal: AbortSignal.timeout(20000),
    });
    draft.sending = false;
    draft.touched = false;
    if (st.cards[id] && !st.cards[id].loading) {
      st.cards[id].mine = out.score;
      if (out.aggregate !== undefined) st.cards[id].aggregate = out.aggregate;
      if (out.score?.submitted && st.cards[id].others === null && rcReviewSettings(cycle).blind !== 'off') delete st.cards[id];
    }
    rcReviewMergeQueue(id, out.score);
    if (st.data && !st.data.loading) for (const a of st.data.assignments || []) if (a.applicationId === id && a.member === rcReviewMe() && (draft.conflict || out.score?.submitted)) a.status = draft.conflict ? 'coi' : 'done';
    toast(draft.conflict ? 'Conflict recorded' : submit ? 'Scorecard submitted' : 'Draft saved');
    if (UI.modal?.kind !== 'recruit-scorecard' || UI.modal.id !== id) return;
    const nextId = next && submit ? rcReviewNextId(id) : null;
    if (nextId) {
      UI.modal.id = nextId;
      rcReviewEnsureCard(nextId);
      rcReviewPaintCard(nextId, { focusFirst: true });
      return;
    }
    if (st.cards[id] === undefined) rcReviewEnsureCard(id);
    rcReviewPaintCard(id);
  } catch (e) {
    draft.sending = false;
    draft.error = rcReviewError(e);
    rcReviewPaintCard(id);
  }
}

/* ------------------------------ auto-assign ----------------------------- */

function rcReviewAssignIds(m) {
  if (m.ids?.length) return m.ids;
  return (UI.recruit?.apps?.rows || []).map((r) => r.id);
}
function rcReviewMembersHtml() {
  const st = rcReviewState();
  if (st.roster === undefined || st.roster?.loading) return '<p class="sheet__note">Loading…</p>';
  if (st.roster?.error) return `<p class="sheet__note">${MD.esc(st.roster.error)}</p>`;
  const reviewers = st.roster.members || [];
  if (!reviewers.length) return '<p class="faint">Nobody has a reviewer role yet. Grant roles under Settings.</p>';
  return reviewers.map((r) => `<label class="check"><input type="checkbox" data-rc-member="${MD.esc(r.email)}" checked> ${MD.esc(r.name || r.email)}${r.subteams?.length ? ` <span class="faint">${MD.esc(r.subteams.join(', '))}</span>` : ''}</label>`).join('');
}
function rcReviewAssignModal(m) {
  const cycle = rcReviewCycle();
  const ids = rcReviewAssignIds(m);
  const per = String(m.per || rcReviewSettings(cycle).perApplication || 2);
  const members = rcReviewState().roster?.members?.length || 0;
  const each = members ? Math.ceil((ids.length * Number(per)) / members) : 0;
  return `<div class="modal" role="dialog" aria-label="Assign reviewers">
    <div class="modal__head"><h3>Assign ${ids.length} ${ids.length === 1 ? 'application' : 'applications'}</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body">
      <label>Mode ${dd('recruit-assign-mode', [{ value: 'round-robin', label: 'Round robin' }, { value: 'manual', label: 'Everyone chosen reviews all' }], m.mode || 'round-robin')}</label>
      <label>Reviewers per application ${dd('recruit-assign-per', [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) })), per)}</label>
      <div data-rc-members>${rcReviewMembersHtml()}</div>
      <label class="check"><input type="checkbox" data-rc-bysubteam ${m.bySubteam ? 'checked' : ''}> Match reviewers to their subteams</label>
      <p class="faint" data-rc-preview>${each ? `≈ ${each} each` : ''}</p>
      <p class="field-error" data-rc-error role="alert" hidden></p>
    </div>
    <div class="modal__foot"><button class="btn" data-action="modal-close">Cancel</button><button class="btn btn--primary" data-action="recruit-assign-go">Assign</button></div>
  </div>`;
}
function rcReviewEnsureRoster() {
  const cycle = rcReviewCycle();
  const st = rcReviewState();
  if (!cycle || st.roster !== undefined) return;
  st.roster = { loading: true };
  const key = cycle.id;
  rcReviewGet(`/recruit/cycles/${cycle.id}/roles`).then((out) => {
    if (rcReviewState().key !== key) return;
    const names = Object.fromEntries((out.members || []).map((u) => [u.email, u.name]));
    rcReviewState().roster = { members: (out.roles || []).filter((r) => (r.roles || []).includes('reviewer')).map((r) => ({ email: r.member, name: r.name || names[r.member] || r.member, subteams: r.subteams || [] })) };
    const host = $('.modal [data-rc-members]');
    if (host) host.innerHTML = rcReviewMembersHtml();
  }).catch((e) => {
    if (rcReviewState().key !== key) return;
    rcReviewState().roster = { error: rcReviewError(e) };
    const host = $('.modal [data-rc-members]');
    if (host) host.innerHTML = rcReviewMembersHtml();
  });
}
async function rcReviewAssign(m) {
  const cycle = rcReviewCycle();
  if (!cycle || m.busy) return;
  const error = $('.modal [data-rc-error]');
  const show = (text) => { if (error) { error.textContent = text || ''; error.hidden = !text; } };
  const members = $$('.modal [data-rc-member]').filter((el) => el.checked).map((el) => el.dataset.rcMember);
  const ids = rcReviewAssignIds(m);
  if (!members.length) { show('Choose at least one reviewer'); return; }
  if (!ids.length) { show('Nothing to assign'); return; }
  const body = {
    requestId: (m.requestId ||= 'rq-' + crypto.randomUUID()),
    ids, kind: 'reviewer',
    mode: $('.modal [data-m="recruit-assign-mode"]')?.dataset.value || 'round-robin',
    perApplication: Number($('.modal [data-m="recruit-assign-per"]')?.dataset.value || rcReviewSettings(cycle).perApplication || 2),
    members,
    bySubteam: Boolean($('.modal [data-rc-bysubteam]')?.checked),
  };
  m.busy = true;
  show('');
  const button = $('.modal [data-action="recruit-assign-go"]');
  if (button) { button.disabled = true; button.textContent = 'Assigning…'; }
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${cycle.id}/assignments`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const st = rcReviewState();
    st.data = undefined;
    st.summary = undefined;
    UI.recruit.selected = new Set();
    m.busy = false;
    closeModal(() => renderBackground('recruit'));
    toast(`Assigned ${out.created || 0}${out.existing ? ` · ${out.existing} already assigned` : ''}`);
  } catch (e) {
    m.busy = false;
    show(rcReviewError(e));
    if (button) { button.disabled = false; button.textContent = 'Assign'; }
  }
}

/* ---------------------------- settings section -------------------------- */

function rcReviewRubricRows(cycle) {
  const st = rcReviewState();
  return st.rubricDraft || rcReviewSettings(cycle).rubric.criteria.map((c) => ({ ...c }));
}
function rcReviewRubricRowsHtml(cycle) {
  return rcReviewRubricRows(cycle).map((c) => `<div class="rc-criterion" data-rc-criterion="${MD.esc(c.key)}">
    <span class="kbd">${MD.esc(c.key)}</span>
    <input class="text-input" name="crit-name-${MD.esc(c.key)}" value="${MD.esc(c.name)}" maxlength="80" aria-label="Criterion name" autocomplete="off">
    <input class="text-input" name="crit-weight-${MD.esc(c.key)}" value="${MD.esc(String(c.weight ?? 1))}" inputmode="decimal" aria-label="Weight" autocomplete="off">
    <input class="text-input" name="crit-help-${MD.esc(c.key)}" value="${MD.esc(c.help || '')}" maxlength="300" placeholder="Help" aria-label="Help" autocomplete="off">
    <button type="button" class="icon-btn" data-action="recruit-rubric-remove" data-key="${MD.esc(c.key)}" aria-label="Remove criterion">${I.x}</button>
  </div>`).join('');
}
function rcReviewReadRubricRows(form) {
  return $$('[data-rc-criterion]', form).map((row) => {
    const key = row.dataset.rcCriterion;
    return { key, name: ($(`[name="crit-name-${key}"]`, row)?.value || '').trim(), weight: Number($(`[name="crit-weight-${key}"]`, row)?.value || 1), help: ($(`[name="crit-help-${key}"]`, row)?.value || '').trim() };
  });
}
// The cycles panel draws the section and its heading; this is the form.
function rcReviewSettingsHtml(cycle) {
  const s = rcReviewSettings(cycle);
  const count = (n) => ({ value: String(n), label: String(n) });
  return `<form data-action="recruit-settings-review">
      <label>Blind scoring ${dd('recruit-review-blind', [{ value: 'until-submitted', label: 'Until submitted' }, { value: 'off', label: 'Off' }], s.blind)}</label>
      <label>Reviewers see ${dd('recruit-review-visibility', [{ value: 'assigned', label: 'Assigned applications' }, { value: 'subteam', label: 'Their subteams' }, { value: 'all', label: 'Everything' }], s.visibility)}</label>
      <label>Reviewers per application ${dd('recruit-review-per', [1, 2, 3, 4, 5].map(count), String(s.perApplication))}</label>
      <label>Scale ${dd('recruit-review-scale', [3, 4, 5, 6, 7, 8, 9, 10].map(count), String(s.rubric.scale || 5))}</label>
      <label class="check"><input type="checkbox" name="editAfterSubmit" ${s.editAfterSubmit ? 'checked' : ''}> Scorecards can be edited after submitting</label>
      <div data-rc-rubric>${rcReviewRubricRowsHtml(cycle)}</div>
      <div class="rc-criterion rc-criterion--new"><input class="text-input" data-m="recruit-rubric-new" placeholder="New criterion" maxlength="80" aria-label="New criterion" autocomplete="off"><button type="button" class="btn btn--sm" data-action="recruit-rubric-add">Add criterion</button></div>
      <p class="field-error" data-rc-error role="alert" hidden></p>
      <div class="admin-form__actions"><button class="btn btn--primary" type="submit">Save review settings</button></div>
    </form>`;
}
function rcReviewRubricEdit(el, mutate) {
  const form = el.closest('form');
  if (!form) return;
  const st = rcReviewState();
  st.rubricDraft = rcReviewReadRubricRows(form);
  const focusKey = mutate(st.rubricDraft);
  const host = $('[data-rc-rubric]', form);
  if (host) host.innerHTML = rcReviewRubricRowsHtml(rcReviewCycle());
  form.dataset.adminDirty = 'true';
  ((focusKey && $(`[data-action="recruit-rubric-remove"][data-key="${focusKey}"]`, form)) || $('[data-m="recruit-rubric-new"]', form))?.focus({ preventScroll: true });
}
const rcReviewCriterionKey = (name, taken) => {
  let key = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  if (!/^[a-z]/.test(key)) key = ('c_' + key).slice(0, 40);
  let out = key, n = 2;
  while (taken.includes(out)) out = key.slice(0, 37) + '_' + n++;
  return out;
};

/* -------------------------------- module -------------------------------- */

RECRUIT.register({
  name: 'review',
  order: 50,
  panel: { id: 'review', label: 'Review', when: (cycle, role) => cycle?.doc?.modules?.review !== false && Boolean(role) && role !== 'interviewer' },
  view(cycle, role) {
    if (typeof REMOTE === 'undefined') return `<div class="empty">${I.mail}<b>Review lives on the wiki</b><p>Scorecards and assignments need the live wiki.</p></div>`;
    return rcReviewLead(role) ? rcReviewLeadHtml(cycle) : rcReviewQueueHtml(cycle);
  },
  mount: rcReviewMount,
  columns: [
    { id: 'score', label: 'Score', sortKey: 'score', cell: (app) => { const s = app.extras?.score; const n = s?.mean ?? s?.mine; return n == null ? '<span class="faint">—</span>' : `<span class="font-mono" title="${s.mean != null ? `${s.n} submitted` : 'My score'}">${MD.esc(rcReviewNum(n))}</span>`; } },
  ],
  filters: () => [
    { group: 'review', value: 'unscored', label: 'Unscored', query: { unscored: '1' }, test: (row) => row.extras?.score?.mine == null },
    { group: 'review', value: 'assigned', label: 'Assigned to me', query: { assigned: 'me' }, test: (row) => (row.extras?.assigned || []).includes(rcReviewMe()) },
  ],
  selectionActions(ids, cycle, role) {
    return rcReviewLead(role) ? [{ id: 'recruit-assign-open', action: 'recruit-assign-open', label: 'Assign…', run: () => { showModal({ kind: 'recruit-assign', ids: [...ids] }); rcReviewEnsureRoster(); } }] : [];
  },
  detailSections(app, cycle, role) {
    const s = app.extras?.score || {};
    const assigned = app.extras?.assigned || [];
    const mineAssigned = assigned.includes(rcReviewMe()) || rcReviewLead(role) || rcReviewSettings(cycle).visibility === 'all';
    const html = `<p>${s.mine != null ? `My score <span class="font-mono">${rcReviewNum(s.mine)}</span>` : 'Not scored by you'}${s.mean != null ? ` · mean <span class="font-mono">${rcReviewNum(s.mean)}</span> of ${s.n}` : ''}</p>
      ${rcReviewLead(role) && assigned.length ? `<p class="faint">Reviewers: ${MD.esc(assigned.map((e) => e.split('@')[0]).join(', '))}</p>` : ''}
      ${mineAssigned ? `<button class="btn btn--sm" data-action="recruit-scorecard-open" data-id="${MD.esc(app.id)}">Open scorecard</button>` : ''}`;
    return [{ id: 'scores', title: 'Scores', html }];
  },
  settings: {
    id: 'review',
    label: 'Review',
    view: (cycle) => rcReviewSettingsHtml(cycle),
    async submit(form, cycle) {
      const s = rcReviewSettings(cycle);
      const criteria = rcReviewReadRubricRows(form);
      if (!criteria.length) throw new Error('Add at least one criterion');
      if (criteria.some((c) => !c.name)) throw new Error('Every criterion needs a name');
      const settings = {
        blind: $('[data-m="recruit-review-blind"]', form)?.dataset.value || s.blind,
        visibility: $('[data-m="recruit-review-visibility"]', form)?.dataset.value || s.visibility,
        perApplication: Number($('[data-m="recruit-review-per"]', form)?.dataset.value || s.perApplication),
        editAfterSubmit: Boolean(form.elements?.editAfterSubmit?.checked),
        rubric: { version: (s.rubric.version || 1) + 1, scale: Number($('[data-m="recruit-review-scale"]', form)?.dataset.value || s.rubric.scale || 5), criteria },
      };
      const out = await RECRUIT.api(`/recruit/cycles/${cycle.id}/settings/review`, { method: 'PUT', body: JSON.stringify({ version: cycle.version, settings }), signal: AbortSignal.timeout(20000) });
      if (out?.cycle && UI.recruit?.cycle?.data?.id === out.cycle.id) UI.recruit.cycle.data = out.cycle;
      rcReviewState().rubricDraft = null;
    },
  },
  actions: {
    'recruit-review-refresh': () => { const st = rcReviewState(); st.data = undefined; st.summary = undefined; st.queue = undefined; render(); },
    'recruit-scorecard-open': (el) => { const id = el.dataset.id; if (!id) return; showModal({ kind: 'recruit-scorecard', id, scoreKind: el.dataset.kind || 'review', round: el.dataset.round || '' }); rcReviewEnsureCard(id); },
    'recruit-score-pick': (el) => {
      const id = UI.modal?.id;
      if (!id || el.disabled) return;
      const draft = rcReviewDraft(id);
      const n = Number(el.dataset.n);
      draft.touched = true;
      draft.scores[el.dataset.key] = draft.scores[el.dataset.key] === n ? undefined : n;
      if (draft.scores[el.dataset.key] === undefined) delete draft.scores[el.dataset.key];
      for (const b of $$(`[data-action="recruit-score-pick"][data-key="${el.dataset.key}"]`, el.closest('.rc-scorecard__row') || document)) b.setAttribute('aria-pressed', String(Number(b.dataset.n) === draft.scores[el.dataset.key]));
    },
    // A checkbox keeps its own default; only the bubbling stops.
    'recruit-score-coi': (el, ev) => { ev?.stopPropagation?.(); const id = UI.modal?.id; if (!id) return; const draft = rcReviewDraft(id); draft.touched = true; draft.conflict = Boolean(el.checked); rcReviewPaintCard(id); },
    'recruit-score-save': () => { if (UI.modal?.kind === 'recruit-scorecard') rcReviewSubmit(UI.modal.id, { submit: false }); },
    'recruit-score-submit': () => { if (UI.modal?.kind === 'recruit-scorecard') rcReviewSubmit(UI.modal.id, { submit: true }); },
    'recruit-score-next': () => { if (UI.modal?.kind === 'recruit-scorecard') rcReviewSubmit(UI.modal.id, { submit: true, next: true }); },
    'recruit-assign-open': (el) => { const ids = el.dataset.id ? [el.dataset.id] : [...(UI.recruit?.selected || [])]; showModal({ kind: 'recruit-assign', ids }); rcReviewEnsureRoster(); },
    'recruit-assign-go': () => { if (UI.modal?.kind === 'recruit-assign') rcReviewAssign(UI.modal); },
    'recruit-rubric-add': (el) => {
      const form = el.closest('form');
      const input = form && $('[data-m="recruit-rubric-new"]', form);
      const name = (input?.value || '').trim();
      if (!name) { input?.focus(); return; }
      rcReviewRubricEdit(el, (rows) => { const key = rcReviewCriterionKey(name, rows.map((r) => r.key)); rows.push({ key, name, weight: 1, help: '' }); return key; });
      if (input) input.value = '';
    },
    'recruit-rubric-remove': (el) => rcReviewRubricEdit(el, (rows) => { const i = rows.findIndex((r) => r.key === el.dataset.key); if (i >= 0) rows.splice(i, 1); return rows[Math.min(i, rows.length - 1)]?.key; }),
  },
  inputs: {
    'recruit-score-notes': (el) => { const id = UI.modal?.id; if (!id) return; const draft = rcReviewDraft(id); draft.notes = el.value; draft.touched = true; },
  },
  dd: {
    'recruit-score-rec': (host, value) => { if (value === undefined) return; const id = UI.modal?.id; if (!id) return; const draft = rcReviewDraft(id); draft.recommendation = value || null; draft.touched = true; },
    'recruit-assign-per': (host, value) => { if (value === undefined || UI.modal?.kind !== 'recruit-assign') return; UI.modal.per = value; const members = $$('.modal [data-rc-member]').filter((el) => el.checked).length; const preview = $('.modal [data-rc-preview]'); if (preview) preview.textContent = members ? `≈ ${Math.ceil((rcReviewAssignIds(UI.modal).length * Number(value)) / members)} each` : ''; },
  },
  modals: {
    'recruit-scorecard': rcReviewScorecardModal,
    'recruit-assign': rcReviewAssignModal,
  },
  // Arrow keys walk a criterion's scale; Enter/Space are the button's own.
  keydown(ev) {
    const el = ev.target;
    if (!el?.dataset || el.dataset.action !== 'recruit-score-pick') return false;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return false;
    const row = el.closest('.rc-scorecard__scale') || el.parentElement;
    const buttons = row ? $$('[data-action="recruit-score-pick"]', row) : [];
    const i = buttons.indexOf(el);
    if (i < 0) return false;
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? buttons.length - 1 : ev.key === 'ArrowLeft' ? Math.max(0, i - 1) : Math.min(buttons.length - 1, i + 1);
    ev.preventDefault();
    buttons[next]?.focus();
    return true;
  },
  reset() { const st = rcReviewState(); Object.assign(st, { key: null, data: undefined, summary: undefined, queue: undefined, roster: undefined, cards: {}, drafts: {}, rubricDraft: null }); },
});
// recruit:review:end
