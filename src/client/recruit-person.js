/* ============================================================================
   Applications — person module (client). A person's page: where they stand
   in the flow, every stage's checklist (filled in right there), what they
   sent on each form, the team's comments (each may name a stage) and what
   happened when. Also every write about a person, shared by the lists: a
   checklist value, a move, a status, the flag, a comment.
   ========================================================================== */

'use strict';

// recruit:person:start

/* ------------------------------- caches ---------------------------------- */

// st.persons[email] = { loading, error, person, submissions, history }
function recruitPersons() { return recruitState().persons ||= {}; }
const recruitPerson = (email) => recruitPersons()[email];
const recruitPersonEmail = () => String(UI.route?.params?.email || '').trim().toLowerCase();

// Every list row that shows this person: the People list, the board, a
// stage's list, and the page itself.
function recruitPersonRows(email) {
  const st = recruitState();
  return [
    ...(st.people?.rows || []).filter((r) => r.email === email),
    ...(st.board?.rows || []).filter((r) => r.email === email),
    ...(st.stagePeople?.rows || []).filter((r) => r.email === email),
  ];
}

// The server answers every write with where the person stands now; every
// cache takes it unless it already holds something newer.
function recruitAcceptTrack(email, p) {
  if (!p) return;
  const fresh = (have) => Number(p.trackVersion ?? 0) >= Number(have?.trackVersion ?? 0);
  const view = { stage: p.stage, status: p.status, states: p.states, done: p.done, fields: p.fields, trackVersion: p.trackVersion, ...(Array.isArray(p.next) ? { next: p.next } : {}) };
  for (const row of recruitPersonRows(email)) if (fresh(row)) Object.assign(row, view);
  const d = recruitPerson(email);
  if (d?.person && fresh(d.person)) Object.assign(d.person, view, p.track ? { track: p.track } : {});
  recruitPersonChanged(email);
}

function recruitAcceptReview(email, out) {
  const person = out?.person;
  if (!person) return;
  const d = recruitPerson(email);
  const newer = (have) => Number(person.reviewVersion ?? 0) >= Number(have?.reviewVersion ?? 0);
  if (d?.person && newer(d.person)) Object.assign(d.person, { review: person.review || d.person.review, reviewVersion: person.reviewVersion ?? d.person.reviewVersion, flagged: person.flagged === true });
  for (const row of recruitPersonRows(email)) if (newer(row)) Object.assign(row, { flagged: person.flagged === true, comments: (person.review?.comments || []).length, reviewVersion: person.reviewVersion ?? row.reviewVersion });
  recruitPersonChanged(email);
}

// Every view showing this person repaints what it shows of them.
function recruitPersonChanged(email) {
  for (const m of RECRUIT.modules) { try { m.personChanged?.(email); } catch (e) { console.error(e); } }
}

// Track responses derive their path from the cycle settings at request time.
function recruitTrackGuard(cycle) {
  const st = recruitState();
  const key = st.key;
  const { id, version } = cycle;
  const sameCycle = () => recruitState() === st && st.key === key && recruitCycleRow()?.id === id;
  return { sameCycle, current: () => sameCycle() && recruitCycleRow().version === version };
}

/* ------------------------------- checklist values ------------------------ */

const recruitStarsLabel = (n, max) => `${n} of ${max}`;

// One checklist field as a control. `value` is what a list row carries: the
// team's answer, or for a per-reviewer field { n, avg | counts, mine }.
function recruitFieldControlHtml(f, value, ctx) {
  const { email, stage, name = '', compact = false } = ctx;
  const editable = ctx.editable ?? recruitCanReview();
  const attrs = `data-email="${MD.esc(email)}" data-stage="${MD.esc(stage)}" data-field="${MD.esc(f.key)}"`;
  const mine = f.each ? (value?.mine ?? null) : (value ?? null);
  const label = `${f.label}${name ? ' for ' + name : ''}`;
  const summary = f.each ? recruitEachSummaryHtml(f, value) : '';
  const team = recruitState().cycle?.team || [];
  const memberName = (email2) => team.find((m) => m.email === email2)?.name || email2;
  if (!editable) {
    const shown = f.type === 'check' ? (mine === true ? `<span class="rc-yes">${I.check}Yes</span>` : mine === false ? '<span class="faint">No</span>' : '<span class="faint">—</span>')
      : f.type === 'rating' ? (mine ? recruitStarsHtml(f, mine, null) : '<span class="faint">—</span>')
      : f.type === 'member' ? (mine ? MD.esc(memberName(mine)) : '<span class="faint">—</span>')
      : mine !== null && mine !== '' ? `<span class="rc-fieldtext">${MD.esc(String(mine))}</span>` : '<span class="faint">—</span>';
    return `<span class="rc-field rc-field--${f.type}">${f.each ? summary || '<span class="faint">—</span>' : shown}</span>`;
  }
  switch (f.type) {
    case 'check':
      return `<label class="rc-checkfield"><input type="checkbox" data-action="recruit-field-check" ${attrs} ${mine === true ? 'checked' : ''} aria-label="${MD.esc(label)}"><span class="rc-box" aria-hidden="true">${I.check}</span>${compact ? '' : `<span class="rc-checkfield__text">${mine === true ? 'Yes' : 'Not yet'}</span>`}</label>`;
    case 'rating':
      return `<span class="rc-field rc-field--rating">${recruitStarsHtml(f, mine, attrs, label)}${summary}</span>`;
    case 'choice':
      return `<span class="rc-field rc-field--choice">${recruitDd('recruit-field-choice', [{ value: '', label: '—' }, ...(f.options || []).map((o) => ({ value: o, label: o }))], mine || '', `${attrs} aria-label="${MD.esc(label)}"`, { small: true })}${summary}</span>`;
    case 'member': {
      const options = [{ value: '', label: 'Nobody' }, ...team.map((m) => ({ value: m.email, label: m.name || m.email }))];
      if (mine && !options.some((o) => o.value === mine)) options.push({ value: mine, label: mine });
      return `<span class="rc-field rc-field--member">${recruitDd('recruit-field-member', options, mine || '', `${attrs} aria-label="${MD.esc(label)}"`, { small: true })}</span>`;
    }
    case 'note':
      if (compact) {
        const text = f.each ? '' : String(mine || '');
        return `<a class="rc-notecell" href="${recruitPersonHref(email)}#pn-stage-${MD.esc(stage)}" data-action="recruit-person-go" data-email="${MD.esc(email)}" data-list="stage" title="${MD.esc(text || 'Write a note')}">${f.each ? summary || '<span class="faint">Add a note</span>' : text ? MD.esc(text.length > 80 ? text.slice(0, 80) + '…' : text) : '<span class="faint">Add a note</span>'}</a>`;
      }
      return `<span class="rc-field rc-field--note"><textarea class="text-input rc-note" data-m="recruit-field-note" ${attrs} rows="3" maxlength="4000" placeholder="${f.each ? 'Your note' : 'Write a note'}" aria-label="${MD.esc(label)}">${MD.esc(mine || '')}</textarea>${summary}</span>`;
    default: {
      const kind = f.type === 'number' ? `inputmode="decimal"${compact ? ' placeholder="Add"' : ''}` : f.type === 'date' ? 'placeholder="YYYY-MM-DD" maxlength="10"' : `maxlength="200"${compact ? ' placeholder="Add"' : ''}`;
      return `<span class="rc-field rc-field--${f.type}"><input class="text-input rc-cell-input" data-m="recruit-field-text" ${attrs} value="${MD.esc(mine ?? '')}" ${kind} aria-label="${MD.esc(label)}" autocomplete="off">${summary}</span>`;
    }
  }
}
const recruitFieldCellHtml = (f, value, ctx) => recruitFieldControlHtml(f, value, { ...ctx, compact: true });

function recruitStarsHtml(f, value, attrs, label = '') {
  const max = f.max || 5;
  if (!attrs) return `<span class="rc-stars rc-stars--read" role="img" aria-label="${MD.esc(recruitStarsLabel(value, max))}">${Array.from({ length: max }, (_, i) => `<span class="rc-star ${i < value ? 'is-on' : ''}">${I.star}</span>`).join('')}</span>`;
  return `<span class="rc-stars" role="radiogroup" aria-label="${MD.esc(label)}">${Array.from({ length: max }, (_, i) => `<button type="button" class="rc-star ${i < (value || 0) ? 'is-on' : ''}" role="radio" aria-checked="${value === i + 1}" data-action="recruit-field-rate" ${attrs} data-v="${i + 1}" aria-label="${MD.esc(recruitStarsLabel(i + 1, max))}" title="${value === i + 1 ? 'Clear' : i + 1}">${I.star}</button>`).join('')}</span>`;
}

// What the other reviewers said, next to your own answer.
function recruitEachSummaryHtml(f, value) {
  if (!value || !value.n) return '';
  if (f.type === 'rating' || f.type === 'number') return `<span class="rc-avg">avg ${MD.esc(String(value.avg))} of ${recruitNum(value.n)}</span>`;
  if (f.type === 'choice') return `<span class="rc-avg">${Object.entries(value.counts || {}).map(([k, n]) => `${MD.esc(k)} ${n}`).join(' · ')}</span>`;
  return `<span class="rc-avg">${recruitPlural(value.n, 'answer')}</span>`;
}

// The value a list row carries, rebuilt from a stored entry after a write.
function recruitFieldSummaryOf(f, stored, me) {
  if (!stored) return null;
  if (!f.each) return stored.v ?? null;
  const entries = Object.entries(stored.each || {}).filter(([, e]) => e && e.v !== null && e.v !== undefined && e.v !== '');
  if (!entries.length) return null;
  const mine = entries.find(([who]) => who === me)?.[1]?.v ?? null;
  if (f.type === 'rating' || f.type === 'number') { const nums = entries.map(([, e]) => Number(e.v)); return { n: nums.length, avg: Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100, mine }; }
  if (f.type === 'choice') { const counts = {}; for (const [, e] of entries) counts[e.v] = (counts[e.v] || 0) + 1; return { n: entries.length, counts, mine }; }
  return { n: entries.length, mine };
}

// A value as the field's type means it.
function recruitFieldValue(f, raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (f.type === 'number') { const n = Number(s); if (!Number.isFinite(n)) throw new Error(`${f.label} must be a number.`); return n; }
  if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${f.label} is a date like 2026-10-03.`);
  return f.type === 'note' ? String(raw).trim() : s;
}

// One value, shown at once everywhere, saved, and put back if it fails.
async function recruitSetField(email, stageKey, fieldKey, value) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const f = recruitSections(cycle)[stageKey]?.fields?.find((x) => x.key === fieldKey);
  if (!cycle || !f || !recruitCanReview(cycle)) return;
  const guard = recruitTrackGuard(cycle);
  const me = recruitMyEmail();
  const rows = recruitPersonRows(email);
  const before = rows.map((r) => r.fields?.[stageKey]?.[fieldKey]);
  const d = recruitPerson(email);
  const storedBefore = d?.person?.track?.fields?.[stageKey]?.[fieldKey];
  const next = f.each ? { ...(recruitFieldSummaryOf(f, storedBefore, me) || { n: 0 }), mine: value } : value;
  for (const r of rows) { r.fields ||= {}; r.fields[stageKey] = { ...(r.fields[stageKey] || {}), [fieldKey]: next }; }
  if (d?.person) {
    const track = d.person.track ||= {};
    track.fields ||= {};
    track.fields[stageKey] = { ...(track.fields[stageKey] || {}) };
    const entry = { v: value, name: Store.me?.()?.name || me, at: Date.now() };
    track.fields[stageKey][fieldKey] = f.each ? { ...(storedBefore || {}), each: { ...(storedBefore?.each || {}), [me]: entry } } : { ...entry, by: me };
    d.person.fields = { ...(d.person.fields || {}), [stageKey]: { ...(d.person.fields?.[stageKey] || {}), [fieldKey]: next } };
  }
  const busy = `field:${email}:${stageKey}:${fieldKey}`;
  const pending = st.busy;
  pending.add(busy);
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/people/${encodeURIComponent(email)}/fields`, { method: 'PATCH', body: JSON.stringify({ stage: stageKey, field: fieldKey, value }) });
    if (!guard.sameCycle()) return;
    if (guard.current()) recruitAcceptTrack(email, out.person);
    else recruitLoadPerson(email, { quiet: true });
  } catch (e) {
    if (!guard.sameCycle()) return;
    if (guard.current()) {
      rows.forEach((r, i) => { r.fields ||= {}; r.fields[stageKey] = { ...(r.fields[stageKey] || {}), [fieldKey]: before[i] }; });
      if (d?.person?.track?.fields?.[stageKey]) d.person.track.fields[stageKey][fieldKey] = storedBefore;
      recruitPersonChanged(email);
    } else recruitLoadPerson(email, { quiet: true });
    toast(`Could not save ${f.label}: ${recruitError(e)}`);
  } finally { pending.delete(busy); }
}

/* ------------------------------- moves ----------------------------------- */

// A person to another stage, or a new status; shown at once, put back if
// the save fails.
async function recruitMovePerson(email, { stage, status }) {
  const cycle = recruitCycleRow();
  if (!cycle || !recruitCanEdit(cycle)) return;
  const st = recruitState();
  const guard = recruitTrackGuard(cycle);
  const rows = recruitPersonRows(email);
  const d = recruitPerson(email);
  const prior = [...rows, ...(d?.person ? [d.person] : [])].map((r) => ({ r, stage: r.stage, status: r.status, states: r.states }));
  for (const { r } of prior) { if (stage) { r.stage = stage; r.states = { ...(r.states || {}), [stage]: 'current' }; } if (status) r.status = status; }
  recruitPersonChanged(email);
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/people/${encodeURIComponent(email)}/move`, { method: 'POST', body: JSON.stringify({ requestId: recruitId('rq'), ...(stage ? { stage } : {}), ...(status ? { status } : {}) }) });
    if (status && recruitState() === st) recruitLoadCycles({ quiet: true });
    if (!guard.sameCycle()) return;
    if (guard.current()) recruitAcceptTrack(email, out.person);
    else recruitLoadPerson(email, { quiet: true });
    const who = out.person ? (d?.person?.name || rows[0]?.name || email) : email;
    toast(stage ? `${who} moved to ${recruitSectionTitle(stage, cycle)}` : `${who} marked ${recruitStatusLabel(status).toLowerCase()}`);
    recruitLoadInsights({ quiet: true });
  } catch (e) {
    if (!guard.sameCycle()) return;
    if (guard.current()) {
      for (const p of prior) Object.assign(p.r, { stage: p.stage, status: p.status, states: p.states });
      recruitPersonChanged(email);
    } else recruitLoadPerson(email, { quiet: true });
    toast(`Could not move: ${recruitError(e)}`);
  }
}

// The same move for everyone selected in a list.
async function recruitBulkMove(emails, change) {
  const cycle = recruitCycleRow();
  if (!cycle || !recruitCanEdit(cycle) || !emails.length) return;
  const st = recruitState();
  const guard = recruitTrackGuard(cycle);
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/moves`, { method: 'POST', body: JSON.stringify({ requestId: recruitId('rq'), emails, ...change }) });
    if (change.status && recruitState() === st) recruitLoadCycles({ quiet: true });
    if (!guard.sameCycle()) return;
    toast(`${recruitPlural(out.moved || 0, 'person', 'people')} ${change.stage ? `moved to ${recruitSectionTitle(change.stage)}` : `marked ${recruitStatusLabel(change.status).toLowerCase()}`}`);
    for (const m of RECRUIT.modules) { try { m.peopleMoved?.(); } catch (e) { console.error(e); } }
    recruitLoadInsights({ quiet: true });
  } catch (e) { if (guard.sameCycle()) toast(`Could not move: ${recruitError(e)}`); }
}

function recruitMoveMenu(anchor, emails, current = null) {
  const flow = recruitFlow();
  openMenu(flow.keys.map((k) => recruitMenuItem(recruitSectionTitle(k), k === current, () => (emails.length === 1 ? recruitMovePerson(emails[0], { stage: k }) : recruitBulkMove(emails, { stage: k })))), anchor);
}
function recruitStatusMenu(anchor, emails, current = null) {
  openMenu(RECRUIT_STATUSES.map((s) => recruitMenuItem(s.label, s.value === current, () => (emails.length === 1 ? recruitMovePerson(emails[0], { status: s.value }) : recruitBulkMove(emails, { status: s.value })))), anchor);
}

function recruitDecisionMenu(anchor, email, current = 'active') {
  if (!recruitCanEdit()) return;
  const actions = { active: 'Reactivate', accepted: 'Accept', waitlisted: 'Waitlist', declined: 'Decline', withdrew: 'Mark withdrawn' };
  const items = RECRUIT_STATUSES.map((s) => recruitMenuItem(s.value === current ? s.label : actions[s.value], s.value === current, () => {
    if (s.value !== current) recruitMovePerson(email, { status: s.value });
  }));
  items.push('-', { label: 'Move to stage…', run: () => {
    const p = recruitPerson(email)?.person || recruitPersonRows(email)[0];
    recruitMoveMenu(anchor, [email], p?.stage);
  } });
  openMenu(items, anchor);
}

/* ------------------------------- flag and review cell -------------------- */

function recruitPersonRowFlagHtml(p) {
  const flagged = Boolean(p.flagged);
  const label = `${flagged ? 'Unflag' : 'Flag'} ${p.name}`;
  if (!recruitCanReview()) return flagged ? `<span class="interest-flag-readonly" title="Flagged">${RC_ICONS.flag}</span>` : '';
  return `<button class="icon-btn interest-flag ${flagged ? 'is-flagged' : ''}" data-action="recruit-person-flag" data-email="${MD.esc(p.email)}" aria-pressed="${flagged}" aria-label="${MD.esc(label)}" title="${MD.esc(label)}">${RC_ICONS.flag}</button>`;
}

// Flag and comments in a list row; both are the person's.
function recruitPersonReviewCellHtml(p) {
  const comments = Number(p.comments || 0);
  return `<td class="sheet__review-cell" data-col="review"><div class="interest-row-actions">
      ${recruitPersonRowFlagHtml(p)}
      <a class="icon-btn interest-comments ${comments ? 'has-comments' : ''}" href="${recruitPersonHref(p.email)}#pn-comments" data-action="recruit-person-go" data-email="${MD.esc(p.email)}" data-comments="1" aria-label="${comments ? `${comments} ${comments === 1 ? 'comment' : 'comments'} on` : 'Comment on'} ${MD.esc(p.name)}" title="${comments ? `${comments} ${comments === 1 ? 'comment' : 'comments'}` : 'Add comment'}">${RC_ICONS.comment}${comments ? `<span>${comments}</span>` : ''}</a>
    </div></td>`;
}

async function recruitTogglePersonFlag(email) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const row = recruitPerson(email)?.person || recruitPersonRows(email)[0];
  if (!cycle || !row || !recruitCanReview(cycle) || st.busy.has('flag:' + email)) return;
  st.busy.add('flag:' + email);
  const want = !row.flagged;
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/people/${encodeURIComponent(email)}/review`, { method: 'PATCH', body: JSON.stringify({ flagged: want }) });
    recruitAcceptReview(email, out);
    toast(want ? 'Flagged for follow-up' : 'Flag removed');
  } catch (e) { toast(e.name === 'TimeoutError' ? 'The flag request timed out. You can retry.' : `Could not update flag: ${recruitError(e)}`); }
  finally { st.busy.delete('flag:' + email); }
}

/* ------------------------------- answers --------------------------------- */

// One submission's answers, by the labels of the form it was sent through.
function recruitAnswersHtml(d, person = null) {
  const a = d.application;
  const questions = Array.isArray(d.form?.questions) ? d.form.questions : [];
  const answers = a.answers || {};
  const system = new Set(['name', 'email']);
  const shown = new Set();
  const blocks = [];
  for (const q of questions) {
    if (system.has(q.key) || q.type === 'file') continue;
    shown.add(q.key);
    const v = answers[q.key] ?? (['subteam', 'year'].includes(q.key) ? a[q.key] : null);
    const text = Array.isArray(v) ? v.join(', ') : v == null ? '' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
    if (['subteam', 'year'].includes(q.key) && text && text === String(person?.[q.key] || '')) continue;
    const hasFile = (a.files || []).some((f) => f.question === q.key);
    blocks.push(`<div class="pn-answer"><h4>${MD.esc(q.label || q.key)}</h4><p>${text ? (q.type === 'link' && /^https?:\/\//.test(text) ? `<a href="${MD.esc(text)}" target="_blank" rel="noopener noreferrer">${MD.esc(text)}</a>` : MD.esc(text)) : hasFile ? '<span class="faint">File attached below.</span>' : '<span class="faint">Left blank.</span>'}</p></div>`);
  }
  for (const [k, v] of Object.entries(answers)) {
    if (shown.has(k) || system.has(k)) continue;
    const text = Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v);
    if (['subteam', 'year'].includes(k) && text && text === String(person?.[k] || '')) continue;
    const label = k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    blocks.push(`<div class="pn-answer"><h4>${MD.esc(label)}</h4><p>${text ? MD.esc(text) : '<span class="faint">Left blank.</span>'}</p></div>`);
  }
  if (!blocks.length && !person) blocks.push('<p class="faint">No answers beyond the basics.</p>');
  const files = (a.files || []).map((f) => `<a class="interest-attachment" href="/api/recruit/files/${MD.esc(f.id)}" target="_blank" rel="noopener noreferrer"><span>${MD.esc(questions.find((q) => q.key === f.question)?.label || f.question || 'Attachment')}: ${MD.esc(f.name || 'Attachment')}</span></a>`).join('');
  return blocks.join('') + files;
}

/* ------------------------------- the page -------------------------------- */

function recruitLoadPerson(email, { quiet = false } = {}) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  if (!cycle || !email) return;
  const persons = recruitPersons();
  if (persons[email]?.loading) return;
  const prior = persons[email];
  persons[email] = quiet && prior && !prior.error ? { ...prior, loading: true } : { loading: true };
  const key = st.key;
  RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/people/${encodeURIComponent(email)}`)
    .then((out) => {
      if (st.key !== key || st.persons !== persons) return;
      persons[email] = { person: out.person || null, submissions: Array.isArray(out.submissions) ? out.submissions : [], history: out.history || [] };
      if (out.person) { recruitAcceptTrack(email, out.person); recruitAcceptReview(email, { person: out.person }); }
      if (!recruitPaintPerson(email)) recruitPersonChanged(email);
      if (!quiet && email === recruitPersonEmail()) recruitRevealPersonAnchor();
    })
    .catch((e) => { if (st.key !== key || st.persons !== persons) return; persons[email] = { error: recruitError(e), status: e.status }; recruitPaintPerson(email, true); });
}

// Previous and Next walk the list the page was opened from.
function recruitPersonNav() {
  const st = recruitState();
  const email = recruitPersonEmail();
  const list = st.personNav?.cycleId === recruitCycleRow()?.id ? st.personNav : null;
  const i = list ? list.emails.indexOf(email) : -1;
  return { list, i, prev: i > 0 ? list.emails[i - 1] : null, next: list && i >= 0 && i < list.emails.length - 1 ? list.emails[i + 1] : null };
}

function recruitPersonTopHtml(cycle) {
  const n = recruitPersonNav();
  const back = n.list?.href || recruitPanelHref(cycle.id, 'people');
  const label = n.list?.label || 'People';
  const stepper = n.i >= 0 && n.list.emails.length > 1 ? `<div class="pn-step">
      <a class="btn ${n.prev ? '' : 'is-disabled'}" ${n.prev ? `href="${recruitPersonHref(n.prev)}" data-action="recruit-person-step" data-email="${MD.esc(n.prev)}"` : 'aria-disabled="true"'}>${RC_ICONS.back}<span>Previous</span></a>
      <span class="pn-step__at">${recruitNum(n.i + 1)} of ${recruitNum(n.list.emails.length)}</span>
      <a class="btn ${n.next ? '' : 'is-disabled'}" ${n.next ? `href="${recruitPersonHref(n.next)}" data-action="recruit-person-step" data-email="${MD.esc(n.next)}"` : 'aria-disabled="true"'}><span>Next</span>${RC_ICONS.arrowR}</a></div>` : '';
  return `<div class="pn-top"><a class="pn-back" href="${back}">${RC_ICONS.back}<span>${MD.esc(label)}</span></a>${stepper}</div>`;
}

function recruitPersonView(cycle) {
  const email = recruitPersonEmail();
  if (!email) return `<div class="empty">${I.info}<b>No person chosen</b><a class="btn" href="${recruitPanelHref(cycle.id, 'people')}" style="text-decoration:none">People</a></div>`;
  return `<div class="pn" data-rc="person" data-email="${MD.esc(email)}">${recruitPersonInnerHtml(cycle, email)}</div>`;
}

function recruitPersonInnerHtml(cycle, email) {
  const d = recruitPerson(email);
  const row = d?.person || recruitPersonRows(email)[0];
  const top = recruitPersonTopHtml(cycle);
  if (!row && (!d || d.loading)) return top + '<p class="sheet__note">Loading…</p>';
  if (d?.error && !row) return top + `<div class="empty">${I.info}<b>${d.status === 404 ? 'Not in this cycle' : 'Could not load'}</b><p>${MD.esc(d.status === 404 ? 'Nothing from this person is here, or it is outside your subteams.' : d.error)}</p><button class="btn" data-action="recruit-person-retry" data-email="${MD.esc(email)}">Retry</button></div>`;
  const p = { ...row, email };
  return top + recruitPersonHeadHtml(cycle, p) + `<div class="pn-grid">
      <div class="pn-main" data-rc="pn-stages">${recruitPersonStagesHtml(cycle, p, d)}</div>
      <aside class="pn-side">
        <section class="pn-card" id="pn-comments" aria-labelledby="recruit-comments-heading" data-rc="person-comments">${recruitPersonDiscussionHtml(email)}</section>
        <details class="pn-history"><summary>Activity</summary><div data-rc="pn-activity">${recruitPersonActivityHtml(cycle, p, d)}</div></details>
      </aside>
    </div>`;
}

function recruitPersonHeadHtml(cycle, p) {
  const lead = recruitCanEdit(cycle);
  const meta = [p.email, p.subteam, p.year, p.cornell === false ? 'Outside cornell.edu' : ''].filter(Boolean).map((x) => `<span>${MD.esc(x)}</span>`).join('');
  const accepted = p.status === 'accepted';
  const decision = lead ? `<div class="pn-decision" role="group" aria-label="Decision for ${MD.esc(p.name || p.email)}">${!accepted ? `<button type="button" class="btn btn--primary" data-action="recruit-person-accept" data-email="${MD.esc(p.email)}">Accept</button>` : ''}<button type="button" class="btn ${accepted ? '' : 'pn-decision__more'}" data-action="recruit-person-status" data-email="${MD.esc(p.email)}" aria-label="${accepted ? 'Accepted — change decision' : 'More decisions'}" title="${accepted ? 'Change decision' : 'More decisions'}" aria-haspopup="menu" aria-expanded="false">${accepted ? '<span>Accepted</span>' : ''}${I.chev || ''}</button></div>` : '';
  return `<header class="pn-head" data-rc="pn-head">
    <div class="pn-id"><div class="pn-name"><h1>${MD.esc(p.name || p.email)}</h1>${recruitPersonRowFlagHtml(p)}${p.status !== 'active' && !(lead && accepted) ? recruitStatusPill(p.status) : ''}</div><div class="pn-meta">${meta}</div></div>
    ${decision}
  </header>`;
}

const RECRUIT_STATE_CHIPS = { current: 'Current', done: 'Done', open: 'Not done', skipped: 'Skipped', ahead: 'Not yet', next: 'Up next' };

function recruitPersonStagesHtml(cycle, p, d) {
  const flow = recruitFlow(cycle);
  if (d?.loading && !d.submissions) return '<p class="sheet__note">Loading…</p>';
  return recruitTheirKeys(p, flow).map((k) => recruitPersonStageHtml(cycle, flow, k, p, d)).join('');
}

function recruitPersonStageHtml(cycle, flow, key, p, d) {
  const s = flow.sections[key];
  const state = recruitStateOf(p, key);
  const isDone = Boolean(p.done?.[key]);
  const sub = (d?.submissions || []).find((x) => x.application.section === key);
  const quiet = (state === 'ahead' || state === 'next' || state === 'skipped') && !sub && !(s.fields || []).some((f) => p.fields?.[key]?.[f.key] !== undefined);
  const stored = d?.person?.track?.fields?.[key] || {};
  const comments = (d?.person?.review?.comments || []).filter((c) => c.stage === key).length;
  const chip = state === 'done' && sub && !(s.fields || []).length ? '' : `<span class="pn-state pn-state--${state} ${isDone ? 'is-done' : ''}">${RECRUIT_STATE_CHIPS[state]}</span>`;
  const when = sub ? `Sent ${recruitDay(sub.application.ts)}${sub.application.updated && sub.application.updated !== sub.application.ts ? ` · updated ${recruitDay(sub.application.updated)}` : ''}` : '';
  const fields = (s.fields || []).map((f) => {
    const entry = stored[f.key];
    const by = !f.each && entry?.at && entry.v !== null && entry.v !== undefined ? `<span class="pn-field__by">${MD.esc(entry.name || entry.by || '')} · ${MD.esc(recruitAgo(entry.at))}</span>` : '';
    const others = f.each ? Object.entries(entry?.each || {}).filter(([who, e]) => who !== recruitMyEmail() && e && e.v !== null && e.v !== '') : [];
    const theirs = others.length ? `<ul class="pn-each">${others.map(([, e]) => `<li><b>${MD.esc(e.name || 'Reviewer')}</b> ${f.type === 'rating' ? recruitStarsHtml(f, Number(e.v), null) : `<span>${MD.esc(String(e.v))}</span>`}<span class="pn-field__by">${MD.esc(recruitAgo(e.at))}</span></li>`).join('')}</ul>` : '';
    return `<div class="pn-field pn-field--${f.type}"><span class="pn-field__label">${MD.esc(f.label)}${f.each ? '<span class="pn-field__each">each reviewer</span>' : ''}</span>
      <span class="pn-field__value">${recruitFieldControlHtml(f, p.fields?.[key]?.[f.key], { email: p.email, stage: key, name: p.name })}${by}</span>${theirs}</div>`;
  }).join('');
  const response = sub ? `<div class="pn-answers__body">${recruitAnswersHtml(sub, p)}${recruitCan('admin') && cycle.status !== 'archived' ? `<button type="button" class="btn btn--ghost btn--sm pn-answers__delete" data-action="recruit-response-delete" data-id="${MD.esc(sub.application.id)}" data-stage="${MD.esc(key)}">Delete response</button>` : ''}</div>` : '';
  const answers = response && fields ? `<details class="pn-answers"><summary>Form response</summary>${response}</details>` : response;
  return `<section class="pn-stage pn-stage--${state} ${quiet ? 'pn-stage--quiet' : ''}" id="pn-stage-${MD.esc(key)}" data-stage="${MD.esc(key)}" aria-labelledby="pn-stage-${MD.esc(key)}-h">
    <details class="pn-stage__details" ${state === 'current' || state === 'open' ? 'open' : ''}><summary class="pn-stage__head"><span class="pn-stage__chevron" aria-hidden="true">${I.chev}</span><h3 id="pn-stage-${MD.esc(key)}-h">${MD.esc(s.title)}</h3>${chip}${when ? `<span class="pn-stage__when">${MD.esc(when)}</span>` : ''}${comments ? `<a class="pn-stage__comments" href="#pn-comments" data-action="recruit-person-comments-stage" data-stage="${MD.esc(key)}">${RC_ICONS.comment}${comments}</a>` : ''}</summary>
    ${quiet ? '' : `${fields ? `<div class="pn-fields">${fields}</div>` : ''}${answers}${!fields && !answers ? `<p class="pn-stage__empty">${state === 'current' ? 'Here now. Nothing to record at this stage.' : 'Nothing recorded.'}</p>` : ''}`}
    </details>
  </section>`;
}

// What happened, newest first: forms sent, moves, statuses, checklist entries.
function recruitPersonActivityHtml(cycle, p, d) {
  const events = [];
  for (const s of d?.submissions || []) {
    const title = recruitSectionTitle(s.application.section, cycle);
    const form = /\bform$/i.test(title) ? `the ${title}` : `the ${title} form`;
    events.push({ at: Number(s.application.ts), text: `Sent ${form}` });
    if (s.application.updated && s.application.updated !== s.application.ts) events.push({ at: Number(s.application.updated), text: `Updated ${form}` });
  }
  const track = d?.person?.track || {};
  for (const m of track.moves || []) {
    if (m.stage) events.push({ at: m.at, text: `${m.name || m.by || 'Someone'} moved them to ${recruitSectionTitle(m.stage.to, cycle)}` });
    if (m.status) events.push({ at: m.at, text: `${m.name || m.by || 'Someone'} marked them ${recruitStatusLabel(m.status.to).toLowerCase()}` });
  }
  const sections = recruitSections(cycle);
  for (const [stage, values] of Object.entries(track.fields || {})) {
    for (const [key, entry] of Object.entries(values || {})) {
      const f = sections[stage]?.fields?.find((x) => x.key === key);
      if (!f) continue;
      const list = f.each ? Object.values(entry?.each || {}) : [entry];
      for (const e of list) {
        if (!e?.at || e.v === null || e.v === undefined || e.v === '') continue;
        const what = f.type === 'check' ? (e.v === true ? `checked ${f.label}` : `unchecked ${f.label}`) : f.type === 'note' ? `wrote ${f.label.toLowerCase()}` : `set ${f.label} to ${f.type === 'member' ? (recruitState().cycle?.team || []).find((m) => m.email === e.v)?.name || e.v : e.v}`;
        events.push({ at: e.at, text: `${e.name || e.by || 'Someone'} ${what} · ${recruitSectionTitle(stage, cycle)}` });
      }
    }
  }
  events.sort((a, b) => b.at - a.at);
  const others = (d?.history || []).filter((h) => h.cycleId !== cycle.id);
  return `${events.length ? `<ol class="pn-activity">${events.slice(0, 40).map((e) => `<li><span>${MD.esc(e.text)}</span><time datetime="${MD.esc(new Date(Number(e.at)).toISOString())}" title="${MD.esc(new Date(Number(e.at)).toLocaleString())}">${MD.esc(recruitAgo(e.at))}</time></li>`).join('')}</ol>` : '<p class="faint">Nothing yet.</p>'}
    ${others.length ? `<p class="rc-history">Also in ${others.map((h) => `${MD.esc(h.cycleName || h.cycleId)} · ${MD.esc(h.sectionTitle || h.section || '')}`).join(', ')}</p>` : ''}`;
}

// Repaint the open page's regions in place; the composer keeps its text.
function recruitPaintPerson(email, whole = false) {
  const page = $('[data-rc="person"]');
  const cycle = recruitCycleRow();
  if (!page || !cycle || page.dataset.email !== email) return false;
  const d = recruitPerson(email);
  const row = d?.person || recruitPersonRows(email)[0];
  if (whole || !row || !$('[data-rc="pn-stages"]', page)) { recruitRepaint(page, recruitPersonInnerHtml(cycle, email)); return true; }
  const p = { ...row, email };
  const head = $('[data-rc="pn-head"]', page);
  if (head) { const holder = document.createElement('div'); holder.innerHTML = recruitPersonHeadHtml(cycle, p); const fresh = holder.firstElementChild || holder.children?.[0]; if (fresh) recruitRepaint(head, fresh.innerHTML); }
  // Stage cards repaint one by one, and never the one being typed in. When a
  // split sends them another way, the cards change with it.
  const flow = recruitFlow(cycle);
  const keys = recruitTheirKeys(p, flow);
  const stages = $('[data-rc="pn-stages"]', page);
  const typing = () => stages.contains(document.activeElement) && document.activeElement?.matches?.('textarea, input:not([type="checkbox"])');
  if ($$('.pn-stage[data-stage]', stages).map((el) => el.dataset.stage).join('\n') !== keys.join('\n') && !typing()) recruitRepaint(stages, recruitPersonStagesHtml(cycle, p, d));
  else for (const k of keys) {
    const card = $$('.pn-stage[data-stage]', page).find((el) => el.dataset.stage === k);
    if (!card) continue;
    if (card.contains(document.activeElement) && document.activeElement?.matches?.('textarea, input:not([type="checkbox"])')) continue;
    const holder = document.createElement('div');
    holder.innerHTML = recruitPersonStageHtml(cycle, flow, k, p, d);
    const fresh = holder.firstElementChild || holder.children?.[0];
    if (!fresh) continue;
    const disclosures = ['.pn-stage__details', '.pn-answers'].map((selector) => ({ selector, open: $(selector, card)?.open }));
    if (card.innerHTML !== fresh.innerHTML) {
      recruitRepaint(card, fresh.innerHTML);
      card.className = fresh.className;
      for (const { selector, open } of disclosures) if (open !== undefined && $(selector, card)) $(selector, card).open = open;
    }
  }
  recruitRepaint($('[data-rc="pn-activity"]', page), recruitPersonActivityHtml(cycle, p, d));
  recruitPaintPersonDiscussion(email);
  return true;
}

function recruitOpenPerson(email, list = null) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  if (!email || !cycle) return;
  if (list) st.personNav = { ...list, cycleId: cycle.id };
  nav(recruitPersonHref(email));
}

// The list a person was opened from, for Previous and Next.
function recruitNavFrom(listName) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  if (listName === 'stage' && st.stagePeople) return { emails: st.stagePeople.rows.map((r) => r.email), label: recruitSectionTitle(st.stagePeople.key), href: recruitStageHref(st.stagePeople.key) };
  if (listName === 'board' && st.board) return { emails: st.board.rows.map((r) => r.email), label: 'People', href: recruitPanelHref(cycle.id, 'people') };
  if (st.people) return { emails: st.people.rows.map((r) => r.email), label: 'People', href: recruitPanelHref(cycle.id, 'people') };
  return null;
}

// The neighbours load while this one is read, so a step shows at once.
function recruitPrefetchNeighbours() {
  const n = recruitPersonNav();
  for (const e of [n.next, n.prev]) if (e && recruitPerson(e) === undefined) recruitLoadPerson(e);
}

// Links from a checklist still reveal the requested stage when earlier
// stages start collapsed. Background refreshes preserve the reader's choice.
function recruitRevealPersonAnchor() {
  const hash = String(location.hash || '');
  const want = UI.route?.params?.anchor || (hash.includes('#pn-') ? hash.slice(hash.lastIndexOf('#') + 1) : '');
  if (!want) return;
  const target = document.getElementById?.(want);
  if (!target?.closest?.('[data-rc="person"]')) return;
  const detail = target.querySelector?.('.pn-stage__details');
  if (detail) detail.open = true;
  target.scrollIntoView?.({ block: 'start' });
}

/* ------------------------------- the thread ------------------------------ */

function recruitPersonDraft(email) {
  const st = recruitState();
  const key = 'cupi-comment-draft:' + JSON.stringify([Store.me?.()?.email || Store.session?.() || 'anon', recruitCycleRow()?.id || '', email]);
  if (st.drafts[key]) return st.drafts[key];
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(key)); } catch (e) { /* storage may be unavailable */ }
  return st.drafts[key] = { key, text: typeof saved?.text === 'string' ? saved.text.slice(0, 4000) : '', id: typeof saved?.id === 'string' ? saved.id : null, stage: typeof saved?.stage === 'string' ? saved.stage : null, sending: false, error: '', storageError: false, savedValue: saved ? JSON.stringify(saved) : null };
}

function recruitSavePersonDraft(draft) {
  try {
    if (draft.text) {
      const value = JSON.stringify({ text: draft.text, id: draft.id, stage: draft.stage || null });
      localStorage.setItem(draft.key, value);
      draft.savedValue = value;
    } else {
      // A completed post in this tab must not erase newer work in another tab.
      if (localStorage.getItem(draft.key) === draft.savedValue) localStorage.removeItem(draft.key);
      draft.savedValue = null;
    }
    draft.storageError = false;
  } catch (e) { draft.storageError = true; }
}

function recruitPersonDraftError(draft) {
  return draft.error || (draft.storageError ? 'This browser could not save your draft. Keep this tab open until you post or copy your comment.' : '');
}

function recruitPersonCommentHtml(c, email) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const mine = c.by && Store.me?.()?.email === c.by;
  const removable = cycle?.status !== 'archived' && (recruitCan('lead') || mine);
  const removal = st.mod.personRemovals?.[email + '/' + c.id];
  const stage = c.stage && recruitSections()[c.stage] ? `<span class="rc-stage-chip">${recruitKindIcon(recruitSections()[c.stage].kind)}${MD.esc(recruitSectionTitle(c.stage))}</span>` : '';
  return `<article class="interest-comment" data-comment-id="${MD.esc(c.id)}" data-stage="${MD.esc(c.stage || '')}"><div class="interest-comment__meta"><div class="rc-comment-author"><b>${MD.esc(c.name || c.by || 'Member')}</b><time title="${MD.esc(new Date(Number(c.ts)).toLocaleString())}" datetime="${MD.esc(new Date(Number(c.ts)).toISOString())}">${MD.esc(recruitAgo(Number(c.ts)))}</time></div>${stage}${removable ? `<button type="button" class="icon-btn interest-comment__delete" data-action="recruit-person-comment-delete" data-email="${MD.esc(email)}" data-cid="${MD.esc(c.id)}" aria-label="Delete comment" ${removal?.confirming ? 'disabled' : ''}>${I.trash}</button>` : ''}</div><p class="interest-comment__text">${MD.esc(c.text || '')}</p><div data-comment-controls>${recruitPersonCommentDeleteHtml(email, c.id)}</div></article>`;
}

function recruitPersonCommentDeleteHtml(email, commentId) {
  const removal = recruitState().mod.personRemovals?.[email + '/' + commentId];
  if (!removal?.confirming) return '';
  return `<div class="interest-comment__confirm" role="group" aria-label="Delete comment confirmation"><span>Delete this comment?</span><button type="button" class="btn btn--sm" data-action="recruit-person-comment-delete-cancel" data-email="${MD.esc(email)}" data-cid="${MD.esc(commentId)}" ${removal.busy ? 'disabled' : ''}>Keep</button><button type="button" class="btn btn--sm btn--danger" data-action="recruit-person-comment-delete-confirm" data-email="${MD.esc(email)}" data-cid="${MD.esc(commentId)}" ${removal.busy ? 'disabled' : ''}>${removal.busy ? 'Deleting…' : 'Delete'}</button>${removal.error ? `<span class="field-error" role="alert">${MD.esc(removal.error)}</span>` : ''}</div>`;
}

function recruitPersonDiscussionHtml(email) {
  const cycle = recruitCycleRow();
  const d = recruitPerson(email);
  const comments = d?.person?.review?.comments || [];
  const draft = recruitPersonDraft(email);
  const row = d?.person || recruitPersonRows(email)[0];
  const canComment = recruitCanReview(cycle);
  const stages = [{ value: '', label: 'General' }, ...recruitFlow(cycle).keys.map((k) => ({ value: k, label: recruitSectionTitle(k, cycle) }))];
  const about = draft.stage ?? '';
  return `<h3 class="pn-card__title" id="recruit-comments-heading">Team comments</h3>
    <div class="interest-thread" role="log" aria-label="Comments" aria-live="polite" aria-relevant="additions removals">${d?.loading && !d.person ? '<p class="interest-thread__empty">Loading…</p>' : comments.length ? comments.map((c) => recruitPersonCommentHtml(c, email)).join('') : '<p class="interest-thread__empty">No comments yet.</p>'}</div>
    ${canComment ? `<form class="interest-compose" data-action="recruit-person-comment-form" data-email="${MD.esc(email)}">
      <textarea class="text-input" data-m="recruit-person-comment" data-email="${MD.esc(email)}" aria-label="Comment on ${MD.esc(row?.name || 'this person')}" placeholder="Add a comment…" rows="2" maxlength="4000" ${draft.sending ? 'readonly' : ''}>${MD.esc(draft.text)}</textarea>
      <p class="field-error" data-comment-error role="alert" ${recruitPersonDraftError(draft) ? '' : 'hidden'}>${MD.esc(recruitPersonDraftError(draft))}</p>
      <div class="interest-compose__foot"><span class="pn-about">${recruitDd('recruit-person-comment-stage', stages, about, `data-email="${MD.esc(email)}" aria-label="Comment about"`, { small: true })}</span><button type="submit" class="btn btn--primary" ${draft.sending || !draft.text.trim() ? 'disabled' : ''}>${draft.sending ? 'Posting…' : 'Post'}</button></div>
    </form>` : '<p class="interest-readonly">Read only</p>'}`;
}

// Existing comment nodes keep their DOM identity, only removed comments and
// changed controls are touched, and the author's unsent composer is never
// replaced.
function recruitPaintPersonDiscussion(email, { posted = false } = {}) {
  const host = $('[data-rc="person-comments"]');
  if (!host || $('[data-rc="person"]')?.dataset.email !== email) return;
  const draft = recruitPersonDraft(email);
  const st = recruitState();
  const d = recruitPerson(email);
  const thread = $('.interest-thread', host), field = $('.interest-compose textarea', host);
  const button = $('.interest-compose [type="submit"]', host), error = $('[data-comment-error]', host);
  if (!thread) return;
  const comments = d?.person?.review?.comments || [];
  const nodes = $$('[data-comment-id]', thread);
  const active = document.activeElement;
  const removed = nodes.filter((node) => !comments.some((c) => c.id === node.dataset.commentId));
  const restoreAfterRemoval = removed.some((node) => node.contains?.(active));
  removed.forEach((node) => node.remove());
  const existing = new Set(nodes.filter((node) => !removed.includes(node)).map((el) => el.dataset.commentId));
  const added = comments.filter((c) => !existing.has(c.id));
  if (added.length || (d && !d.loading)) $('.interest-thread__empty', thread)?.remove();
  if (added.length) thread.insertAdjacentHTML('beforeend', added.map((c) => recruitPersonCommentHtml(c, email)).join(''));
  if (!comments.length && d && !d.loading && !$('.interest-thread__empty', thread)) thread.insertAdjacentHTML('beforeend', '<p class="interest-thread__empty">No comments yet.</p>');
  for (const node of $$('[data-comment-id]', thread)) {
    const commentId = node.dataset.commentId, controls = $('[data-comment-controls]', node);
    const removal = st.mod.personRemovals?.[email + '/' + commentId];
    const trigger = $('[data-action="recruit-person-comment-delete"]', node);
    if (trigger) trigger.disabled = Boolean(removal?.confirming);
    const key = JSON.stringify([!!removal?.confirming, !!removal?.busy, removal?.error || '']);
    if (controls && controls._stateKey !== key) {
      const action = controls.contains(document.activeElement) ? document.activeElement.dataset.action : null;
      controls.innerHTML = recruitPersonCommentDeleteHtml(email, commentId);
      controls._stateKey = key;
      if (action && !removal?.busy) $(`[data-action="${action}"]`, controls)?.focus({ preventScroll: true });
    }
  }
  if (field) { field.readOnly = draft.sending; if (posted) field.value = ''; }
  if (button) { button.disabled = draft.sending || !draft.text.trim(); button.textContent = draft.sending ? 'Posting…' : 'Post'; }
  if (error) { error.textContent = recruitPersonDraftError(draft); error.hidden = !error.textContent; }
  if (restoreAfterRemoval) ($('[data-action="recruit-person-comment-delete"]', thread) || field)?.focus({ preventScroll: true });
  if (posted && (document.activeElement === document.body || document.activeElement === button || document.activeElement === field)) field?.focus({ preventScroll: true });
}

async function recruitPostPersonComment(email) {
  const cycle = recruitCycleRow();
  if (!cycle || !recruitCanReview(cycle)) return;
  const draft = recruitPersonDraft(email);
  if (draft.sending || !draft.text.trim()) return;
  // The same id is kept while retrying a lost response, so a comment can
  // never post twice; editing after a failure starts a new submission.
  draft.id ||= recruitId('ic');
  draft.sending = true;
  draft.error = '';
  recruitSavePersonDraft(draft);
  recruitPaintPersonDiscussion(email);
  let posted = false;
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/people/${encodeURIComponent(email)}/comments`, { method: 'POST', body: JSON.stringify({ id: draft.id, text: draft.text, ...(draft.stage ? { stage: draft.stage } : {}) }) });
    recruitAcceptReview(email, out);
    draft.text = ''; draft.id = null;
    recruitSavePersonDraft(draft);
    posted = true;
    toast('Comment posted');
  } catch (e) {
    draft.error = e.name === 'TimeoutError'
      ? 'The request timed out. Your comment is still here; retrying will not post it twice.'
      : `Could not post: ${recruitError(e)}. Your comment is still here.`;
  } finally { draft.sending = false; recruitPaintPersonDiscussion(email, { posted }); }
}

function recruitConfirmPersonCommentRemoval(email, commentId, cancel = false) {
  const st = recruitState();
  const comments = recruitPerson(email)?.person?.review?.comments || [];
  if (!comments.some((c) => c.id === commentId)) return;
  st.mod.personRemovals ||= {};
  const key = email + '/' + commentId;
  const removal = st.mod.personRemovals[key] ||= {};
  if (removal.busy) return;
  if (cancel) delete st.mod.personRemovals[key];
  else { removal.confirming = true; removal.error = ''; }
  recruitPaintPersonDiscussion(email);
  const node = $$('[data-comment-id]', $('[data-rc="person-comments"] .interest-thread')).find((el) => el.dataset.commentId === commentId);
  $(cancel ? '[data-action="recruit-person-comment-delete"]' : '[data-action="recruit-person-comment-delete-cancel"]', node)?.focus({ preventScroll: true });
}

async function recruitDeletePersonComment(email, commentId) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  if (!cycle || cycle.status === 'archived') return;
  const key = email + '/' + commentId;
  const removal = st.mod.personRemovals?.[key];
  if (!removal?.confirming || removal.busy) return;
  removal.busy = true; removal.error = '';
  recruitPaintPersonDiscussion(email);
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/people/${encodeURIComponent(email)}/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' });
    recruitAcceptReview(email, out);
    delete st.mod.personRemovals[key];
    toast('Comment deleted');
  } catch (e) {
    removal.error = e.name === 'TimeoutError' ? 'The request timed out. Retry to confirm deletion.' : `Could not delete: ${recruitError(e)}`;
  } finally {
    removal.busy = false;
    recruitPaintPersonDiscussion(email);
  }
}

// Deleting one form response (admins): the person stays while they have
// other responses; their flag, thread and checklist stay with them.
function recruitConfirmDeleteResponse(id, stage) {
  const cycle = recruitCycleRow();
  const email = recruitPersonEmail();
  if (!cycle || !recruitCan('admin')) return;
  UI.modal = {
    kind: 'confirm', title: `Delete this ${recruitSectionTitle(stage)} response?`, danger: true, confirm: 'Delete response',
    text: 'The answers and attachments on this form are removed for good. The person\'s flag, comments and checklist stay with them.',
    onGo: async () => {
      try {
        await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/applications/${encodeURIComponent(id)}`, { method: 'DELETE' });
        toast('Response deleted');
        recruitPersons()[email] = undefined;
        recruitLoadPerson(email);
        recruitLoadInsights({ quiet: true });
      } catch (e) { toast(`Could not delete: ${recruitError(e)}`); }
    },
  };
  render();
}

/* ------------------------------- register -------------------------------- */

RECRUIT.register({
  name: 'person',
  order: 4,
  kernel: true,
  panels: [{ id: 'person', label: 'Person', tab: false, order: 60, when: () => true }],
  view: (cycle) => recruitPersonView(cycle),
  crumb: () => { const e = recruitPersonEmail(); const r = recruitPerson(e)?.person || recruitPersonRows(e)[0]; return MD.esc(r?.name || e || 'Person'); },
  mount() {
    const email = recruitPersonEmail();
    if (!email) return;
    const d = recruitPerson(email);
    if (d === undefined || d?.error) recruitLoadPerson(email);
    recruitPrefetchNeighbours();
    setTimeout(recruitRevealPersonAnchor, 0);
  },
  refresh: { load: () => { const e = recruitPersonEmail(); if (e && !$('[data-rc="person"] :focus')) recruitLoadPerson(e, { quiet: true }); }, every: RECRUIT_SYNC_MS },
  personChanged: (email) => recruitPaintPerson(email),
  actions: {
    'recruit-person-go': (el, ev) => {
      // A modified click opens the page in a new tab, as a link does.
      const list = recruitNavFrom(el.dataset.list);
      if (ev?.metaKey || ev?.ctrlKey || ev?.shiftKey || ev?.button === 1) { if (list) recruitState().personNav = { ...list, cycleId: recruitCycleRow()?.id }; return; }
      ev?.preventDefault?.();
      recruitOpenPerson(el.dataset.email, list);
    },
    'recruit-person-step': (el, ev) => { ev?.preventDefault?.(); nav(recruitPersonHref(el.dataset.email)); },
    'recruit-person-retry': (el) => { recruitPersons()[el.dataset.email] = undefined; recruitLoadPerson(el.dataset.email); recruitPaintPerson(el.dataset.email, true); },
    'recruit-person-flag': (el) => recruitTogglePersonFlag(el.dataset.email),
    'recruit-person-accept': (el) => {
      const focused = document.activeElement === el;
      const saving = recruitMovePerson(el.dataset.email, { status: 'accepted' });
      if (focused) $('[data-rc="pn-head"] [data-action="recruit-person-status"]')?.focus({ preventScroll: true });
      return saving;
    },
    'recruit-person-status': (el) => { const r = recruitPerson(el.dataset.email)?.person || recruitPersonRows(el.dataset.email)[0]; recruitDecisionMenu(el, el.dataset.email, r?.status); },
    'recruit-person-comments-stage': (el, ev) => { ev?.preventDefault?.(); $('#pn-comments')?.scrollIntoView?.({ block: 'start' }); },
    'recruit-person-comment-form': (form) => recruitPostPersonComment(form.dataset.email),
    'recruit-person-comment-delete': (el) => recruitConfirmPersonCommentRemoval(el.dataset.email, el.dataset.cid),
    'recruit-person-comment-delete-cancel': (el) => recruitConfirmPersonCommentRemoval(el.dataset.email, el.dataset.cid, true),
    'recruit-person-comment-delete-confirm': (el) => recruitDeletePersonComment(el.dataset.email, el.dataset.cid),
    'recruit-response-delete': (el) => recruitConfirmDeleteResponse(el.dataset.id, el.dataset.stage),
    // Checklist values, from any list or the page.
    'recruit-field-check': (el) => recruitSetField(el.dataset.email, el.dataset.stage, el.dataset.field, Boolean(el.checked)),
    'recruit-field-rate': (el) => {
      const on = el.getAttribute('aria-checked') === 'true';
      recruitSetField(el.dataset.email, el.dataset.stage, el.dataset.field, on ? null : Number(el.dataset.v));
    },
    // Moves from a list's selection.
    'recruit-bulk-move': (el) => { const emails = recruitSelectedFor(el.dataset.list); if (emails.length) recruitMoveMenu(el, emails); },
    'recruit-bulk-status': (el) => { const emails = recruitSelectedFor(el.dataset.list); if (emails.length) recruitStatusMenu(el, emails); },
    'recruit-bulk-copy': (el) => { const emails = recruitSelectedFor(el.dataset.list); if (emails.length) recruitCopy(emails.join(', '), `Copied ${recruitPlural(emails.length, 'email')}`); },
  },
  inputs: {
    'recruit-person-comment': (el) => {
      const draft = recruitPersonDraft(el.dataset.email);
      draft.text = el.value;
      if (!draft.sending) draft.id = null;
      recruitSavePersonDraft(draft);
      const error = el.closest('form')?.querySelector('[data-comment-error]');
      if (error) { error.textContent = recruitPersonDraftError(draft); error.hidden = !error.textContent; }
      const button = el.closest('form')?.querySelector('[type="submit"]');
      if (button) button.disabled = draft.sending || !draft.text.trim();
    },
    // Typed values save when the field is left (the change event), not per key.
    'recruit-field-text': () => {},
    'recruit-field-note': () => {},
  },
  changes: {
    'recruit-field-text': (el) => {
      const f = recruitSections()[el.dataset.stage]?.fields?.find((x) => x.key === el.dataset.field);
      if (!f) return;
      try { recruitSetField(el.dataset.email, el.dataset.stage, el.dataset.field, recruitFieldValue(f, el.value)); }
      catch (e) { toast(e.message); el.focus(); }
    },
    'recruit-field-note': (el) => {
      const f = recruitSections()[el.dataset.stage]?.fields?.find((x) => x.key === el.dataset.field);
      if (f) recruitSetField(el.dataset.email, el.dataset.stage, el.dataset.field, recruitFieldValue(f, el.value));
    },
  },
  dd: {
    'recruit-field-choice': (host, value) => { if (value !== undefined) recruitSetField(host.dataset.email, host.dataset.stage, host.dataset.field, value || null); },
    'recruit-field-member': (host, value) => { if (value !== undefined) recruitSetField(host.dataset.email, host.dataset.stage, host.dataset.field, value || null); },
    'recruit-person-comment-stage': (host, value) => { if (value === undefined) return; const draft = recruitPersonDraft(host.dataset.email); draft.stage = value || null; recruitSavePersonDraft(draft); },
  },
  keydown(ev) {
    // ⌘/Ctrl-Enter saves a note or posts a comment.
    if (ev.key !== 'Enter' || !(ev.metaKey || ev.ctrlKey) || typeof ev.target?.matches !== 'function') return false;
    if (ev.target.matches('[data-m="recruit-field-note"]')) { ev.preventDefault(); ev.target.blur(); return true; }
    if (ev.target.matches('[data-m="recruit-person-comment"]')) { ev.preventDefault(); recruitPostPersonComment(ev.target.dataset.email); return true; }
    return false;
  },
  cycleChanged() { recruitState().persons = {}; },
  reset() { const st = recruitState(); st.persons = {}; st.personNav = null; },
});

// The emails selected in a list: the stage's list, or People.
function recruitSelectedFor(list) {
  const st = recruitState();
  if (list === 'stage') return [...(st.stagePeople?.selected || [])];
  return [...(st.people?.selected || [])];
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('beforeunload', (event) => {
  if (Object.values(recruitState().drafts).some((draft) => draft.key && draft.text && (draft.sending || draft.storageError))) {
    event.preventDefault(); event.returnValue = '';
  }
});

// recruit:person:end
