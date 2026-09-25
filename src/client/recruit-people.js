/* ============================================================================
   Applications — people module (client). The People tab: everyone in the
   cycle across its forms; and the person dialog, where their forms are
   read and where the flag and the comment thread live. Forms hold answers;
   the person is who the team talks about.
   ========================================================================== */

'use strict';

// recruit:people:start

/* ------------------------------- the list -------------------------------- */

const RECRUIT_PEOPLE_FILTERS = [
  { value: '', label: 'All people' }, { value: 'flagged', label: 'Flagged' }, { value: 'comments', label: 'Has comments' },
];

let recruitPeopleSearchTimer;
async function recruitLoadPeople(more = false, quiet = false) {
  const st = recruitState(), cycle = recruitCycleRow();
  if (!cycle) return;
  const prior = st.people;
  if (prior?.loading && (quiet || more)) return;
  const cursor = more ? prior?.next : null;
  if (more && !cursor) return;
  const people = { key: st.key + ':' + cycle.id, rows: quiet || more ? prior?.rows || [] : [], byEmail: {}, counts: prior?.counts, total: prior?.total || 0, loading: true, error: null, q: prior?.q || '', filter: prior?.filter || '' };
  st.people = people;
  const key = st.key;
  const params = new URLSearchParams({ q: people.q, limit: '100' });
  if (people.filter) params.set(people.filter, '1');
  if (cursor) params.set('cursor', cursor);
  try {
    let out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/people?${params}`);
    if (quiet) {
      while (out.next && out.rows.length < (prior?.rows.length || 0) && st.key === key && st.people === people) {
        params.set('cursor', out.next);
        const page = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/people?${params}`);
        out = { ...page, rows: [...out.rows, ...page.rows] };
      }
    }
    if (st.key !== key || st.people !== people) return;
    const incoming = Array.isArray(out.rows) ? out.rows : [];
    people.rows = more ? people.rows.concat(incoming) : incoming;
    people.byEmail = Object.fromEntries(people.rows.map((p) => [p.email, p]));
    people.counts = out.counts || null;
    people.total = Number(out.total ?? people.rows.length);
    people.next = out.next || null;
  } catch (e) {
    if (st.key !== key || st.people !== people) return;
    people.error = recruitError(e);
  }
  people.loading = false;
  if (!recruitPaintPeople()) renderBackground('recruit');
}

function recruitPeopleVisible() {
  const p = recruitState().people;
  if (!p) return [];
  return p.rows;
}

function recruitPeopleCountsLine() {
  const c = recruitState().people?.counts;
  if (!c) return '';
  const by = c.bySection || {};
  const forms = recruitSectionKeys().map((key) => `${recruitSectionTitle(key)} ${Number(by[key] || 0).toLocaleString('en-US')}`);
  return [recruitPlural(c.people || 0, 'person', 'people'), c.flagged ? `${c.flagged} flagged` : '', ...forms].filter(Boolean).join(' · ');
}

function recruitPeopleFootText() {
  const p = recruitState().people;
  if (!p || p.loading || p.error) return '';
  const shown = recruitPeopleVisible().length;
  return shown === p.total ? recruitPlural(shown, 'person', 'people') : `${shown} of ${recruitPlural(p.total, 'person', 'people')}`;
}

// The row's flag: the same control the list always had, on the person.
function recruitPersonRowFlagHtml(p) {
  const flagged = Boolean(p.flagged);
  const readOnly = !recruitCan('reviewer') || recruitCycleRow()?.status === 'archived';
  const label = `${flagged ? 'Unflag' : 'Flag'} ${p.name}`;
  if (readOnly) return flagged ? `<span class="interest-flag-readonly" title="Flagged">${RC_ICONS.flag}</span>` : '';
  return `<button class="icon-btn interest-flag ${flagged ? 'is-flagged' : ''}" data-action="recruit-person-flag" data-email="${MD.esc(p.email)}" aria-pressed="${flagged}" aria-label="${MD.esc(label)}" title="${MD.esc(label)}" aria-disabled="${recruitState().busy.has('flag:' + p.email)}">${RC_ICONS.flag}</button>`;
}

// Flag and comments on the row, as the list always had them; both are the person's.
function recruitPersonReviewCellHtml(p) {
  const comments = Number(p.comments || 0);
  return `<td class="sheet__review-cell" data-col="review"><div class="interest-row-actions">
      ${recruitPersonRowFlagHtml(p)}
      <button class="icon-btn interest-comments ${comments ? 'has-comments' : ''}" data-action="recruit-person-open" data-email="${MD.esc(p.email)}" data-comments="true" aria-label="${comments ? `${comments} ${comments === 1 ? 'comment' : 'comments'} on` : 'Comment on'} ${MD.esc(p.name)}" title="${comments ? `${comments} ${comments === 1 ? 'comment' : 'comments'}` : 'Add comment'}">${RC_ICONS.comment}${comments ? `<span>${comments}</span>` : ''}</button>
    </div></td>`;
}

function recruitPeopleRowsHtml(rows) {
  const p = recruitState().people;
  const keys = recruitSectionKeys();
  const span = 6;
  if (!p || (p.loading && !p.rows.length)) return `<tr class="sheet__empty"><td colspan="${span}">Loading…</td></tr>`;
  if (p.error && !p.rows.length) return `<tr class="sheet__empty"><td colspan="${span}">Could not load: ${MD.esc(p.error)}. <button class="linklike" data-action="recruit-people-refresh">Retry</button></td></tr>`;
  if (!rows.length) return `<tr class="sheet__empty"><td colspan="${span}">${p.rows.length ? 'No one matches.' : 'No one yet.'}</td></tr>`;
  return rows.map((x) => `<tr data-email="${MD.esc(x.email)}">
    <td data-col="person"><button class="interest-person" data-action="recruit-person-open" data-email="${MD.esc(x.email)}" aria-label="Open ${MD.esc(x.name)}"><b>${MD.esc(x.name)}</b><span class="mail">${MD.esc(x.email)}</span></button><span class="rc-mobile-meta">${MD.esc([x.subteam, x.year].filter(Boolean).join(' · '))}</span><div class="rc-participation rc-mobile-meta">${keys.filter((k) => x.sections?.[k]).map((k) => `<button data-action="recruit-person-open" data-email="${MD.esc(x.email)}" data-form="${MD.esc(k)}">${MD.esc(recruitSectionTitle(k))}</button>`).join('')}</div></td>
    ${recruitPersonReviewCellHtml(x)}
    <td data-col="forms"><div class="rc-participation">${keys.filter((key) => x.sections?.[key]).map((key) => `<button data-action="recruit-person-open" data-email="${MD.esc(x.email)}" data-form="${MD.esc(key)}">${MD.esc(recruitSectionTitle(key))}</button>`).join('')}</div></td>
    <td data-col="subteam">${MD.esc(x.subteam || 'Undecided')}</td>
    <td data-col="year">${x.year ? MD.esc(x.year) : '<span class="faint">—</span>'}</td>
    <td class="interest-when" data-col="last" title="${MD.esc(new Date(Number(x.last)).toLocaleString())}">${MD.esc(recruitDate(Number(x.last)))}</td>
  </tr>`).join('');
}

function recruitPeopleHtml(cycle) {
  const p = recruitState().people;
  const th = (id, label) => `<th data-col="${id}"><span class="sheet__sort sheet__sort--static">${MD.esc(label)}</span></th>`;
  const lead = recruitCan('lead');
  return `<div class="rc-mode"><span class="rc-mode__status" data-rc="people-counts">${MD.esc(recruitPeopleCountsLine())}</span></div>
  <div class="sheet sheet--recruit sheet--people">
    <div class="sheet__bar">
      <div class="sheet__search-wrap">${I.search}<input class="text-input sheet__search" data-m="recruit-people-q" type="search" placeholder="Search people…" value="${MD.esc(p?.q || '')}" aria-label="Search by name or email" autocomplete="off" spellcheck="false"></div>
      <div class="sheet__actions">
        <button class="icon-btn" data-action="recruit-people-refresh" aria-label="Refresh people" title="Refresh people">${I.refresh || '↻'}</button>
        ${dd('recruit-people-filter', RECRUIT_PEOPLE_FILTERS, p?.filter || '')}
        ${lead ? `<a class="btn" href="/api/recruit/cycles/${encodeURIComponent(cycle.id)}/people.csv" download>${RC_ICONS.download} Export</a>` : ''}
      </div>
    </div>
    <div class="sheet__scroll"><table aria-label="People in ${MD.esc(cycle.name)}">
      <thead><tr>${th('person', 'Person')}${th('review', 'Review')}${th('forms', 'Forms sent')}${th('subteam', 'Subteam')}${th('year', 'Year')}${th('last', 'Latest')}</tr></thead>
      <tbody data-rc="people-rows">${recruitPeopleRowsHtml(recruitPeopleVisible())}</tbody>
    </table></div>
    <div class="sheet__foot" role="status" data-rc="people-foot">${recruitPeopleFootHtml()}</div>
  </div>`;
}

function recruitPeopleFootHtml() { return `${MD.esc(recruitPeopleFootText())}${recruitState().people?.next ? ' · <button class="linklike" data-action="recruit-people-more">Load more</button>' : ''}`; }

function recruitPaintPeople() {
  const body = $('[data-rc="people-rows"]');
  if (!body) return false;
  recruitRepaint(body, recruitPeopleRowsHtml(recruitPeopleVisible()));
  const foot = $('[data-rc="people-foot"]');
  if (foot) foot.innerHTML = recruitPeopleFootHtml();
  const counts = $('[data-rc="people-counts"]');
  if (counts) counts.textContent = recruitPeopleCountsLine();
  return true;
}

/* ------------------------------- answers --------------------------------- */

// One submission's answers, by the labels of the form it was sent through.
function recruitAnswersHtml(d) {
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
    const hasFile = (a.files || []).some((f) => f.question === q.key);
    blocks.push(`<h4 class="interest-subhead">${MD.esc(q.label || q.key)}</h4><p class="interest-project">${text ? (q.type === 'link' && /^https?:\/\//.test(text) ? `<a href="${MD.esc(text)}" target="_blank" rel="noopener noreferrer">${MD.esc(text)}</a>` : MD.esc(text)) : hasFile ? '<span class="faint">File attached below.</span>' : '<span class="faint">Left blank.</span>'}</p>`);
  }
  for (const [k, v] of Object.entries(answers)) {
    if (shown.has(k) || system.has(k)) continue;
    const text = Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v);
    const label = k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    blocks.push(`<h4 class="interest-subhead">${MD.esc(label)}</h4><p class="interest-project">${text ? MD.esc(text) : '<span class="faint">Left blank.</span>'}</p>`);
  }
  if (!blocks.length) blocks.push('<p class="interest-project"><span class="faint">No answers beyond the basics.</span></p>');
  const files = (a.files || []).map((f) => `<a class="interest-attachment" href="/api/recruit/files/${MD.esc(f.id)}" download="${MD.esc(f.name || 'file')}">${RC_ICONS.download}<span>${MD.esc(questions.find((q) => q.key === f.question)?.label || f.question || 'Attachment')}: ${MD.esc(f.name || 'Attachment')}<small>${Math.max(1, Math.round(Number(f.size || 0) / 1024))} KB</small></span></a>`).join('');
  return blocks.join('') + files;
}

/* ------------------------------- person dialog --------------------------- */

// st.persons[email] = { loading, error, person, submissions, history }
function recruitPersons() { return recruitState().persons ||= {}; }
const recruitPerson = (email) => recruitPersons()[email];

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
      if (st.key !== key) return;
      persons[email] = { person: out.person || null, submissions: Array.isArray(out.submissions) ? out.submissions : [], history: out.history || [] };
      recruitAdoptPersonRow(email, out.person);
      recruitPaintPerson(email);
    })
    .catch((e) => { if (st.key !== key) return; persons[email] = { error: recruitError(e), status: e.status }; recruitPaintPerson(email); });
}

// The People row learns what the dialog learned: flag, thread size, name.
function recruitAdoptPersonRow(email, person) {
  if (!person) return;
  const st = recruitState();
  const rows = [st.people?.byEmail?.[email], ...(st.apps?.rows || []).filter((r) => r.email === email)].filter(Boolean);
  for (const row of rows) Object.assign(row, { flagged: person.flagged === true, comments: (person.review?.comments || []).length, reviewVersion: person.reviewVersion ?? row.reviewVersion, name: person.name || row.name });
  recruitPaintPeople();
  recruitPaintRows();
}

// What the dialog knows about a person before their detail arrives: the
// People row, or the sheet row that opened them.
function recruitPersonRow(email) {
  const st = recruitState();
  const known = st.people?.byEmail?.[email];
  if (known) return known;
  const row = (st.apps?.rows || []).find((r) => r.email === email);
  return row ? { email, name: row.name, cornell: row.cornell, subteam: row.subteam, year: row.year, flagged: row.flagged || false, comments: row.comments || 0 } : null;
}

// Which of their forms the dialog shows: the one asked for if they sent it,
// else their latest.
function recruitPersonForm(email, want) {
  const d = recruitPerson(email);
  const subs = d?.submissions || [];
  if (want && subs.some((s) => s.application.section === want)) return want;
  const latest = subs.find((s) => s.application.id === d?.person?.latest);
  return latest ? latest.application.section : (subs.at(-1)?.application.section || want || null);
}

const recruitPersonIdentityHtml = (row, cycle) => `<h3>${MD.esc(row.name)}</h3><span>${MD.esc(row.email)} · ${MD.esc(cycle.name)}</span>`;

function recruitPersonFlagHtml(email) {
  const d = recruitPerson(email);
  const row = d?.person || recruitPersonRow(email) || {};
  const flagged = Boolean(row.flagged);
  const readOnly = !recruitCan('reviewer') || recruitCycleRow()?.status === 'archived';
  if (readOnly) return flagged ? `<span class="interest-flag-readonly" title="Flagged">${RC_ICONS.flag}Flagged</span>` : '';
  return `<button class="btn interest-detail-flag interest-flag ${flagged ? 'is-flagged' : ''}" data-action="recruit-person-flag" data-email="${MD.esc(email)}" aria-pressed="${flagged}" aria-label="${flagged ? 'Unflag' : 'Flag'} ${MD.esc(row.name || email)}" title="${flagged ? 'Remove the flag' : 'Flag for follow-up'}">${RC_ICONS.flag}<span>${flagged ? 'Flagged' : 'Flag'}</span></button>`;
}

function recruitPersonMainHtml(email, want) {
  const cycle = recruitCycleRow();
  const d = recruitPerson(email);
  if (!d || (d.loading && !d.person)) return '<p class="sheet__note">Loading…</p>';
  if (d.error) return `<p class="sheet__note">Could not load: ${MD.esc(d.error)}. <button class="linklike" data-action="recruit-person-retry" data-email="${MD.esc(email)}">Retry</button></p>`;
  const form = recruitPersonForm(email, want);
  const subs = d.submissions;
  if (!subs.length) return '<p class="faint">Nothing from this person in this cycle. Close this window to refresh the list.</p>';
  const sub = subs.find((s) => s.application.section === form) || subs[0];
  const a = sub.application;
  const was = d.shown;
  d.shown = a.section;
  const from = was && was !== a.section ? subs.findIndex((s) => s.application.section === was) : -1;
  const switcher = subs.length > 4 ? `<div class="rc-form-chooser">${dd('recruit-person-form-select', subs.map((s) => ({value:s.application.section,label:recruitSectionTitle(s.application.section)})), a.section)}</div>` : subs.length > 1
    ? `<nav class="rc-seg rc-seg--forms" aria-label="Forms sent"${from >= 0 ? ` data-seg-from="${from}"` : ''}><span class="rc-seg__thumb" aria-hidden="true"></span>${subs.map((s) => `<button type="button" data-action="recruit-person-form" data-email="${MD.esc(email)}" data-form="${MD.esc(s.application.section)}" aria-current="${s.application.section === a.section ? 'page' : 'false'}">${MD.esc(recruitSectionTitle(s.application.section))}</button>`).join('')}</nav>`
    : `<h4 class="interest-subhead">${MD.esc(recruitSectionTitle(a.section))}</h4>`;
  // Subteam and Year rows only where this form asked, or the answer exists.
  const asks = (key) => (sub.form?.questions || []).some((q) => q.key === key);
  const basics = `<dl class="interest-detail">
    ${!asks('subteam') && a.subteam ? `<dt>Subteam</dt><dd>${MD.esc(a.subteam || 'Undecided')}</dd>` : ''}
    ${!asks('year') && a.year ? `<dt>Year</dt><dd>${MD.esc(a.year || 'Not provided')}</dd>` : ''}
    <dt>Received</dt><dd>${MD.esc(recruitDate(Number(a.ts)))}${a.updated && a.updated !== a.ts ? ` <span class="faint">updated ${MD.esc(recruitDate(Number(a.updated)))}</span>` : ''}</dd>
    ${a.cornell === false ? '<dt>Address</dt><dd><span class="interest-outside">Outside cornell.edu</span></dd>' : ''}
  </dl>`;
  const others = (d.history || []).filter((h) => h.cycleId !== cycle?.id);
  const history = others.length ? `<p class="rc-history">Also sent ${others.map((h) => `${MD.esc(h.cycleName || h.cycleId)} · ${MD.esc(h.sectionTitle || h.section || '')}`).join(', ')}</p>` : '';
  return switcher + basics + recruitAnswersHtml(sub) + history;
}

function recruitPersonSideHtml(email, want) {
  const cycle = recruitCycleRow();
  const d = recruitPerson(email);
  if (!d?.submissions?.length) return '';
  const form = recruitPersonForm(email, want);
  const sub = d.submissions.find((s) => s.application.section === form) || d.submissions[0];
  const app = { ...sub.application, history: d.history };
  return RECRUIT.detailSections(app, cycle, recruitRole()).map((s) => `<section class="rc-section" data-rc-section="${MD.esc(s.id)}">${s.title ? `<h4 class="interest-subhead">${MD.esc(s.title)}</h4>` : ''}${s.html}</section>`).join('');
}

// Previous and Next walk the list the dialog was opened from: people on the
// People tab, otherwise the section sheet, one entry per person.
function recruitPersonSteps() {
  const st = recruitState();
  if (recruitActivePanel()?.id === 'people' && st.people) return recruitPeopleVisible().map((p) => ({ email: p.email, form: null }));
  const seen = new Set();
  const out = [];
  for (const r of recruitVisibleRows()) { if (!r.email || seen.has(r.email)) continue; seen.add(r.email); out.push({ email: r.email, form: r.section || recruitSection() }); }
  return out;
}

function recruitPersonNavHtml(email) {
  const steps = recruitPersonSteps();
  const index = steps.findIndex((s) => s.email === email);
  if (index < 0 || steps.length < 2) return '';
  return `<button class="btn" data-action="recruit-person-prev" ${index > 0 ? '' : 'disabled'}>${I.arrowL} Previous</button><span class="faint rc-app__index">${index + 1} of ${steps.length}</span><button class="btn" data-action="recruit-person-next" ${index < steps.length - 1 ? '' : 'disabled'}>Next ${RC_ICONS.arrowR}</button>`;
}

function recruitPersonModalHtml(m) {
  const cycle = recruitCycleRow();
  const email = m.email;
  const d = recruitPerson(email);
  const row = d?.person || recruitPersonRow(email);
  if (!row || !cycle) return `<div class="modal" role="dialog" aria-label="Person unavailable"><div class="modal__head"><h3>Person unavailable</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div><div class="modal__body"><p>This person is no longer on the list. Close this window to refresh.</p></div></div>`;
  return `<div class="modal modal--wide interest-review rc-app rc-person" role="dialog" aria-label="${MD.esc(row.name)}" data-person="${MD.esc(email)}">
    <div class="modal__head">
      <div class="interest-review__identity" data-rc="person-identity">${recruitPersonIdentityHtml(row, cycle)}</div>
      <span data-rc="person-flag">${recruitPersonFlagHtml(email)}</span>
      <button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button>
    </div>
    <div class="modal__body interest-review__body">
      <section class="interest-application" aria-label="Responses">
        <div data-rc="person-main">${recruitPersonMainHtml(email, m.form)}</div>
      </section>
      <section class="interest-discussion" aria-labelledby="recruit-comments-heading">
        <div data-rc="person-side">${recruitPersonSideHtml(email, m.form)}</div>
        <div data-rc="person-comments">${recruitPersonDiscussionHtml(email)}</div>
      </section>
    </div>
    <div class="modal__foot modal__foot--split"><span class="rc-app__nav" data-rc="person-nav">${recruitPersonNavHtml(email)}</span><button class="btn" data-action="modal-close">Close</button></div>
  </div>`;
}

// Repaint the open dialog's regions in place; the composer keeps its text.
function recruitPaintPerson(email) {
  if (UI.modal?.kind !== 'recruit-person' || UI.modal.email !== email) return false;
  const dialog = $('.rc-person');
  if (!dialog) return false;
  const cycle = recruitCycleRow();
  const d = recruitPerson(email);
  const row = d?.person || recruitPersonRow(email);
  if (row && cycle) { recruitRepaint($('[data-rc="person-identity"]', dialog), recruitPersonIdentityHtml(row, cycle)); dialog.setAttribute('aria-label', row.name); }
  recruitRepaint($('[data-rc="person-main"]', dialog), recruitPersonMainHtml(email, UI.modal.form));
  recruitSegSlide($('[data-rc="person-main"] .rc-seg--forms', dialog));
  recruitRepaint($('[data-rc="person-side"]', dialog), recruitPersonSideHtml(email, UI.modal.form));
  const flag = $('[data-rc="person-flag"]', dialog);
  if (flag) recruitRepaint(flag, recruitPersonFlagHtml(email));
  recruitPaintPersonDiscussion(email);
  recruitFocusComments();
  return true;
}

function recruitOpenPerson(email, { form = null, comments = false } = {}) {
  if (!email) return;
  recruitShowModal({ kind: 'recruit-person', email, form, focusComments: comments, inPlace: true });
  recruitSegSlide($('.rc-person .rc-seg--forms'));
  const d = recruitPerson(email);
  if (d === undefined || d?.error) recruitLoadPerson(email);
  recruitPrefetchPeople(email);
  if (comments) { $('.rc-person .interest-compose textarea')?.focus(); recruitFocusComments(); }
  else $('.rc-person [data-action="modal-close"]')?.focus();
}

// Loading answers can move the discussion after its initial focus. Honor the
// comment-button intent once the full layout is present, including read-only cycles.
function recruitFocusComments() {
  if (!UI.modal?.focusComments || !recruitPerson(UI.modal.email)?.person) return;
  const target = $('.rc-person .interest-compose textarea') || $('.rc-person [data-rc="person-comments"]');
  target?.scrollIntoView?.({block: 'center'});
  target?.focus?.({preventScroll: true});
  UI.modal.focusComments = false;
}

// The neighbours load while this one is read, so a step shows at once.
function recruitPrefetchPeople(email) {
  const steps = recruitPersonSteps();
  const i = steps.findIndex((s) => s.email === email);
  if (i < 0) return;
  for (const n of [steps[i + 1], steps[i - 1]]) if (n && recruitPerson(n.email) === undefined) recruitLoadPerson(n.email);
}

// Another person in the same window: the regions repaint, nothing animates,
// the composer shows the draft that belongs to them.
function recruitSwapPerson(email, form = null) {
  const dialog = $('.rc-person');
  const cycle = recruitCycleRow();
  if (!dialog || !cycle || UI.modal?.kind !== 'recruit-person') { recruitOpenPerson(email, { form }); return; }
  UI.modal = { kind: 'recruit-person', email, form, inPlace: true };
  dialog.dataset.person = email;
  recruitRepaint($('[data-rc="person-nav"]', dialog), recruitPersonNavHtml(email));
  recruitRepaint($('[data-rc="person-comments"]', dialog), recruitPersonDiscussionHtml(email));
  recruitPaintPerson(email);
  const scroller = $('.interest-review__body', dialog);
  if (scroller) scroller.scrollTop = 0;
  const d = recruitPerson(email);
  if (d === undefined || d?.error) recruitLoadPerson(email);
  recruitPrefetchPeople(email);
}

function recruitStepPerson(delta) {
  const email = UI.modal?.kind === 'recruit-person' ? UI.modal.email : null;
  if (!email) return;
  const steps = recruitPersonSteps();
  const i = steps.findIndex((s) => s.email === email);
  const next = steps[i + delta];
  if (i < 0 || !next) return;
  recruitSwapPerson(next.email, next.form);
  const dialog = $('.rc-person');
  if (dialog && !dialog.contains(document.activeElement)) {
    ($(`.rc-person [data-action="${delta > 0 ? 'recruit-person-next' : 'recruit-person-prev'}"]:not([disabled])`) || $(`.rc-person [data-action="${delta > 0 ? 'recruit-person-prev' : 'recruit-person-next'}"]:not([disabled])`) || $('.rc-person [data-action="modal-close"]'))?.focus({ preventScroll: true });
  }
}

/* ------------------------------- the thread ------------------------------ */

function recruitPersonDraft(email) {
  const st = recruitState();
  return st.drafts['person:' + email] ||= { text: '', id: null, sending: false, error: '' };
}

function recruitPersonCommentHtml(c, email) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const mine = c.by && Store.me?.()?.email === c.by;
  const removable = cycle?.status !== 'archived' && (recruitCan('lead') || mine);
  const removal = st.mod.personRemovals?.[email + '/' + c.id];
  return `<article class="interest-comment" data-comment-id="${MD.esc(c.id)}"><div class="interest-comment__meta"><b>${MD.esc(c.name || c.by || 'Member')}</b><time title="${MD.esc(new Date(Number(c.ts)).toLocaleString())}" datetime="${MD.esc(new Date(Number(c.ts)).toISOString())}">${MD.esc(recruitDate(Number(c.ts)))}</time>${removable ? `<button type="button" class="icon-btn interest-comment__delete" data-action="recruit-person-comment-delete" data-email="${MD.esc(email)}" data-cid="${MD.esc(c.id)}" aria-label="Delete comment" ${removal?.confirming ? 'disabled' : ''}>${I.trash}</button>` : ''}</div><p class="interest-comment__text">${MD.esc(c.text || '')}</p><div data-comment-controls>${recruitPersonCommentDeleteHtml(email, c.id)}</div></article>`;
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
  const row = d?.person || recruitPersonRow(email);
  const canComment = recruitCan('reviewer') && cycle?.status !== 'archived';
  return `<h4 class="interest-subhead" id="recruit-comments-heading">Comments <span class="count">${comments.length}</span><span class="interest-private">Team only</span></h4>
    <div class="interest-thread" role="log" aria-label="Comments" aria-live="polite" aria-relevant="additions removals">${d?.loading && !d.person ? '<p class="interest-thread__empty">Loading…</p>' : comments.length ? comments.map((c) => recruitPersonCommentHtml(c, email)).join('') : '<p class="interest-thread__empty">No comments yet.</p>'}</div>
    ${canComment ? `<form class="interest-compose" data-action="recruit-person-comment-form" data-email="${MD.esc(email)}">
      <textarea class="text-input" data-m="recruit-person-comment" data-email="${MD.esc(email)}" aria-label="Comment on ${MD.esc(row?.name || 'this person')}" placeholder="Add a comment about this person…" rows="3" maxlength="4000" ${draft.sending ? 'readonly' : ''}>${MD.esc(draft.text)}</textarea>
      <p class="field-error" data-comment-error role="alert" ${draft.error ? '' : 'hidden'}>${MD.esc(draft.error || '')}</p>
      <div class="interest-compose__foot"><button type="submit" class="btn btn--primary" ${draft.sending || !draft.text.trim() ? 'disabled' : ''}>${draft.sending ? 'Posting…' : 'Post comment'}</button></div>
    </form>` : '<p class="interest-readonly">Read only</p>'}`;
}

// Existing comment nodes keep their DOM identity, only removed comments and
// changed controls are touched, and the author's unsent composer is never
// replaced.
function recruitPaintPersonDiscussion(email, { posted = false } = {}) {
  if (UI.modal?.kind !== 'recruit-person' || UI.modal.email !== email) return;
  const dialog = $('.rc-person'), draft = recruitPersonDraft(email);
  const st = recruitState();
  const d = recruitPerson(email);
  if (!dialog) return;
  const thread = $('.interest-thread', dialog), field = $('.interest-compose textarea', dialog);
  const button = $('.interest-compose [type="submit"]', dialog), error = $('[data-comment-error]', dialog);
  const scroller = $('.interest-review__body', dialog);
  if (!thread) return;
  const scrollTop = scroller?.scrollTop || 0;
  const followBottom = scroller ? scroller.scrollHeight - scroller.clientHeight - scrollTop < 32 : false;
  const comments = d?.person?.review?.comments || [];
  const nodes = $$('[data-comment-id]', thread);
  const active = document.activeElement;
  const removed = nodes.filter((node) => !comments.some((c) => c.id === node.dataset.commentId));
  const restoreAfterRemoval = removed.some((node) => node.contains?.(active));
  const anchor = scroller?.getBoundingClientRect && nodes.find((node) => !removed.includes(node) && node.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top);
  const anchorTop = anchor?.getBoundingClientRect().top;
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
  const count = $('.interest-subhead .count', dialog);
  if (count) count.textContent = comments.length;
  if (field) {
    field.readOnly = draft.sending;
    if (posted) field.value = '';
  }
  if (button) {
    button.disabled = draft.sending || !draft.text.trim();
    button.textContent = draft.sending ? 'Posting…' : 'Post comment';
  }
  if (error) { error.textContent = draft.error || ''; error.hidden = !draft.error; }
  if (scroller) scroller.scrollTop = posted && followBottom ? scroller.scrollHeight : scrollTop + (anchor?.isConnected ? anchor.getBoundingClientRect().top - anchorTop : 0);
  if (restoreAfterRemoval) ($('[data-action="recruit-person-comment-delete"]', thread) || field)?.focus({ preventScroll: true });
  if (posted && (document.activeElement === document.body || document.activeElement === button || document.activeElement === field)) field?.focus({ preventScroll: true });
}

// The server answers every review change with the person; both the dialog
// and the People row take it when it is not older than what they hold.
function recruitAcceptPersonReview(email, out) {
  const person = out?.person;
  if (!person) return;
  const persons = recruitPersons();
  const d = persons[email];
  if (d?.person) {
    if (Number(person.reviewVersion ?? 0) >= Number(d.person.reviewVersion ?? 0)) d.person = { ...d.person, review: person.review || d.person.review, reviewVersion: person.reviewVersion ?? d.person.reviewVersion, flagged: person.flagged === true };
  } else persons[email] = { ...(d && !d.error ? d : {}), person: { ...(recruitPersonRow(email) || { email }), ...person }, submissions: d?.submissions || [], history: d?.history || [] };
  recruitAdoptPersonRow(email, persons[email].person);
}

async function recruitTogglePersonFlag(email) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const row = recruitPerson(email)?.person || recruitPersonRow(email);
  if (!cycle || !row || !recruitCan('reviewer') || cycle.status === 'archived' || st.busy.has('flag:' + email)) return;
  st.busy.add('flag:' + email);
  const want = !row.flagged;
  const paint = () => {
    const host = $('.rc-person [data-rc="person-flag"]');
    if (host && UI.modal?.kind === 'recruit-person' && UI.modal.email === email) {
      const focused = host.contains(document.activeElement);
      host.innerHTML = recruitPersonFlagHtml(email);
      if (focused) $('.interest-detail-flag', host)?.focus();
    }
    recruitPaintPeople();
  };
  paint();
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/people/${encodeURIComponent(email)}/review`, { method: 'PATCH', body: JSON.stringify({ flagged: want }) });
    recruitAcceptPersonReview(email, out);
    toast(want ? 'Flagged for follow-up' : 'Flag removed');
  } catch (e) { toast(e.name === 'TimeoutError' ? 'The flag request timed out. You can retry.' : `Could not update flag: ${recruitError(e)}`); }
  finally { st.busy.delete('flag:' + email); paint(); }
}

async function recruitPostPersonComment(email) {
  const cycle = recruitCycleRow();
  if (!cycle || !recruitCan('reviewer') || cycle.status === 'archived') return;
  const draft = recruitPersonDraft(email);
  if (draft.sending || !draft.text.trim()) return;
  // The same id is kept while retrying a lost response, so a comment can
  // never post twice; editing after a failure starts a new submission.
  draft.id ||= recruitId('ic');
  draft.sending = true;
  draft.error = '';
  recruitPaintPersonDiscussion(email);
  let posted = false;
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/people/${encodeURIComponent(email)}/comments`, { method: 'POST', body: JSON.stringify({ id: draft.id, text: draft.text }) });
    recruitAcceptPersonReview(email, out);
    draft.text = ''; draft.id = null;
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
  if (UI.modal?.kind !== 'recruit-person' || UI.modal.email !== email) return;
  const comments = recruitPerson(email)?.person?.review?.comments || [];
  if (!comments.some((c) => c.id === commentId)) return;
  st.mod.personRemovals ||= {};
  const key = email + '/' + commentId;
  const removal = st.mod.personRemovals[key] ||= {};
  if (removal.busy) return;
  if (cancel) delete st.mod.personRemovals[key];
  else { removal.confirming = true; removal.error = ''; }
  recruitPaintPersonDiscussion(email);
  const node = $$('[data-comment-id]', $('.rc-person .interest-thread')).find((el) => el.dataset.commentId === commentId);
  $(cancel ? '[data-action="recruit-person-comment-delete"]' : '[data-action="recruit-person-comment-delete-cancel"]', node)?.focus({ preventScroll: true });
}

async function recruitDeletePersonComment(email, commentId) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  if (!cycle || cycle.status === 'archived') return;
  const key = email + '/' + commentId;
  const removal = st.mod.personRemovals?.[key];
  if (!removal?.confirming || removal.busy) return;
  const originalNode = $$('[data-comment-id]', $('.rc-person .interest-thread')).find((el) => el.dataset.commentId === commentId);
  const restoreFocus = originalNode?.contains(document.activeElement);
  removal.busy = true; removal.error = '';
  recruitPaintPersonDiscussion(email);
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/people/${encodeURIComponent(email)}/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' });
    recruitAcceptPersonReview(email, out);
    delete st.mod.personRemovals[key];
    toast('Comment deleted');
  } catch (e) {
    removal.error = e.name === 'TimeoutError' ? 'The request timed out. Retry to confirm deletion.' : `Could not delete: ${recruitError(e)}`;
  } finally {
    removal.busy = false;
    recruitPaintPersonDiscussion(email);
    if (restoreFocus && UI.modal?.kind === 'recruit-person' && UI.modal.email === email && document.activeElement === document.body) {
      const node = $$('[data-comment-id]', $('.rc-person .interest-thread')).find((el) => el.dataset.commentId === commentId);
      (removal.error ? $('[data-action="recruit-person-comment-delete-confirm"]', node) : $('.rc-person .interest-compose textarea'))?.focus({ preventScroll: true });
    }
  }
}

/* ------------------------------- register -------------------------------- */

RECRUIT.register({
  name: 'people',
  order: 8,
  kernel: true,
  panels: [{ id: 'people', label: 'People', order: 1, when: () => true }],
  view: (cycle) => recruitPeopleHtml(cycle),
  mount(cycle, role, panel) {
    const st = recruitState();
    if (panel === 'people' && (st.people === undefined || st.people.key !== st.key + ':' + cycle.id)) recruitLoadPeople();
  },
  modals: { 'recruit-person': recruitPersonModalHtml },
  refresh: { load: () => recruitLoadPeople(false, true), every: RECRUIT_SYNC_MS },
  actions: {
    'recruit-people-more': () => recruitLoadPeople(true),
    'recruit-people-refresh': () => { recruitLoadPeople(false, true); },
    'recruit-person-open': (el) => recruitOpenPerson(el.dataset.email, { form: el.dataset.form || null, comments: Boolean(el.dataset.comments) }),
    'recruit-person-form': (el) => {
      if (UI.modal?.kind !== 'recruit-person' || UI.modal.email !== el.dataset.email) return;
      UI.modal.form = el.dataset.form || null;
      recruitPaintPerson(el.dataset.email);
      $(`.rc-person [data-action="recruit-person-form"][data-form="${el.dataset.form}"]`)?.focus({ preventScroll: true });
    },
    'recruit-person-prev': () => recruitStepPerson(-1),
    'recruit-person-next': () => recruitStepPerson(1),
    'recruit-person-retry': (el) => { recruitPersons()[el.dataset.email] = undefined; recruitLoadPerson(el.dataset.email); recruitPaintPerson(el.dataset.email); },
    'recruit-person-flag': (el) => recruitTogglePersonFlag(el.dataset.email),
    'recruit-person-comment-form': (form) => recruitPostPersonComment(form.dataset.email),
    'recruit-person-comment-delete': (el) => recruitConfirmPersonCommentRemoval(el.dataset.email, el.dataset.cid),
    'recruit-person-comment-delete-cancel': (el) => recruitConfirmPersonCommentRemoval(el.dataset.email, el.dataset.cid, true),
    'recruit-person-comment-delete-confirm': (el) => recruitDeletePersonComment(el.dataset.email, el.dataset.cid),
  },
  inputs: {
    'recruit-people-q': (el) => { const p = recruitState().people; if (!p) return; p.q = el.value; clearTimeout(recruitPeopleSearchTimer); recruitPeopleSearchTimer = setTimeout(() => recruitLoadPeople(), 220); },
    'recruit-person-comment': (el) => {
      const draft = recruitPersonDraft(el.dataset.email);
      draft.text = el.value;
      if (!draft.sending) draft.id = null;
      const button = el.closest('form')?.querySelector('[type="submit"]');
      if (button) button.disabled = draft.sending || !draft.text.trim();
    },
  },
  dd: {
    'recruit-person-form-select': (host, value) => { if (value === undefined || UI.modal?.kind !== 'recruit-person') return; UI.modal.form = value; recruitPaintPerson(UI.modal.email); $('.rc-person [data-m="recruit-person-form-select"]')?.focus(); },
    'recruit-people-filter': (host, value) => {
      if (value === undefined) return undefined;
      const p = recruitState().people;
      if (!p) return;
      p.filter = value;
      recruitLoadPeople();
    },
  },
  reset() { const st = recruitState(); st.people = undefined; st.persons = {}; },
});

// recruit:people:end
