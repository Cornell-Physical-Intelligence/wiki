/* ============================================================================
   Applications — forms module (client). Each section tab has two views: the
   responses sheet and the form as the website shows it. The editor draws
   every question the way an applicant sees it, keeps one draft per section,
   and nothing reaches the website before Save.
   ========================================================================== */

'use strict';

// recruit:forms:start

const RECRUIT_QUESTION_TYPES = [
  { value: 'short', label: 'Short text' }, { value: 'long', label: 'Long text' }, { value: 'email', label: 'Email' },
  { value: 'single', label: 'Choose one' }, { value: 'multi', label: 'Choose many' }, { value: 'checkbox', label: 'Checkbox' },
  { value: 'link', label: 'Link' }, { value: 'file', label: 'File' },
];
const RECRUIT_FILE_ACCEPT = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'];
// Questions the website posts as columns: they keep their key and type.
const RECRUIT_FIXED_KEYS = { interest: ['name', 'email', 'subteam', 'year', 'project', 'file'], coffee: ['name', 'email'], application: ['name', 'email'] };
// What the note under a question does on the website, by type.
const RECRUIT_HELP_HINT = {
  short: 'Short answer', long: 'Long answer', email: 'netid@cornell.edu', link: 'https://',
  checkbox: 'Text next to the box', single: 'Note under the question (optional)', multi: 'Note under the question (optional)', file: 'Note under the question (optional)',
};
const recruitQuestionKey = (label) => { const k = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40); return /^[a-z]/.test(k) ? k : 'q_' + k; };
const recruitTypeLabel = (type) => (RECRUIT_QUESTION_TYPES.find((t) => t.value === type) || RECRUIT_QUESTION_TYPES[0]).label;
const recruitIsChoice = (type) => type === 'single' || type === 'multi';
const recruitIsText = (type) => type === 'short' || type === 'long' || type === 'email' || type === 'link';

const RECRUIT_SITE_URL = 'https://cornellphysicalintelligence.com';
const RECRUIT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RECRUIT_NOTIFY_MAX = 10;
const RECRUIT_GRIP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';

// The form view of a section tab (?edit=1) is for leads.
const recruitEditingForm = () => recruitCan('lead') && UI.route?.params?.edit === '1';

/* ------------------------------- mode bar -------------------------------- */

// Responses | Form on one side; the form's address and whether the website
// takes it on the other.
function recruitModeBarInnerHtml(cycle, key, editing) {
  const st = recruitState();
  const sec = recruitSections(cycle)[key];
  const count = Number(st.cycle?.counts?.bySection?.[key] || 0);
  const receiving = st.cycles ? st.cycles.intakeCycleId === cycle.id : null;
  const open = sec?.open === true;
  const lead = recruitCan('lead') && cycle.status !== 'archived';
  const busy = st.busy.has('mode-open:' + key);
  // Leads flip the form open or closed right here; everyone else reads it.
  const status = !sec ? '' : lead
    ? `<label class="fe-switch rc-mode__switch"><input type="checkbox" data-action="recruit-mode-open" data-form="${MD.esc(key)}" ${open ? 'checked' : ''} ${busy ? 'disabled' : ''}><span class="fe-switch__track"></span><span class="fe-switch__text">Open on the website</span></label>${open && receiving === false ? '<span class="rc-mode__also">but another cycle receives the website\'s forms</span>' : ''}`
    : !open ? '<span class="rc-mode__dot"></span>Closed on the website'
    : receiving === false ? '<span class="rc-mode__dot"></span>Open, but another cycle receives the website\'s forms'
    : '<span class="rc-mode__dot rc-mode__dot--on"></span>Open on the website';
  // Every form has a page of its own on the club site; the address is always
  // shown so it can be opened or copied. /apply (the QR code) shows the form
  // chosen for it, else the first open one.
  const landing = recruitLandingKey(cycle);
  const url = `${RECRUIT_SITE_URL}/apply/${encodeURIComponent(key)}/`;
  // The address is its own group so a phone can drop it under the switch.
  const link = `<span class="rc-mode__addr"><span class="rc-mode__sep">·</span><a class="rc-mode__link" href="${MD.esc(url)}" target="_blank" rel="noopener" title="Open this form's page">${MD.esc(url.replace(/^https:\/\//, '').replace(/\/$/, ''))}</a><button type="button" class="icon-btn rc-mode__copy" data-action="recruit-copy-link" data-link="${MD.esc(url)}" aria-label="Copy the link to this form" title="Copy link">${I.copy}</button>${open && landing === key ? `<span class="rc-mode__also">and at <a class="rc-mode__link" href="${RECRUIT_SITE_URL}/apply/" target="_blank" rel="noopener">/apply</a></span>` : ''}</span>`;
  const responses = `Responses <span class="count" data-rc-count="${MD.esc(key)}">${count.toLocaleString('en-US')}</span>`;
  // The thumb slides from where the view was last time this tab was drawn.
  const was = st.modeWas?.[key];
  const from = was === undefined || was === editing ? '' : ` data-seg-from="${was ? 1 : 0}"`;
  if (recruitCan('lead')) { st.modeWas ||= {}; st.modeWas[key] = editing; }
  const seg = recruitCan('lead')
    ? `<nav class="rc-seg rc-seg--mode" aria-label="View"${from}><span class="rc-seg__thumb" aria-hidden="true"></span><a href="${recruitPanelHref(cycle.id, key)}" ${editing ? '' : 'aria-current="page"'}>${responses}</a><a href="${recruitPanelHref(cycle.id, key, { edit: 1 })}" ${editing ? 'aria-current="page"' : ''}>Edit form</a></nav>`
    : `<span class="rc-mode__plain">${responses}</span>`;
  return `<span class="rc-mode__status" data-rc="mode-status">${status}${link}</span>${seg}`;
}

const recruitModeBarHtml = (cycle, key, editing) => `<div class="rc-mode" data-rc="mode-bar">${recruitModeBarInnerHtml(cycle, key, editing)}</div>`;

// Open or close a form from its tab bar: one save, then the bar, the
// editor's own switch, and the address line follow.
async function recruitToggleFormOpen(el) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const key = el.dataset.form || recruitSection();
  const want = Boolean(el.checked);
  if (!cycle || !recruitCan('lead') || st.busy.has('mode-open:' + key)) return;
  st.busy.add('mode-open:' + key);
  recruitPaintModeBar(cycle, key, recruitEditingForm());
  try {
    await recruitPutSettings(cycle, 'site', { sections: { [key]: { open: want } } });
    const sections = recruitSections(recruitCycleRow() || cycle);
    if (st.cycle?.data?.id === cycle.id) st.cycle.sections = { ...sections, [key]: { ...(sections[key] || {}), open: want } };
    // The editor's draft, if any, learns the saved state without turning dirty.
    const fe = st.forms?.[`${cycle.id}:${key}`];
    if (fe) { fe.model.open = want; const saved = JSON.parse(fe.saved); saved.open = want; fe.saved = JSON.stringify(saved); }
    toast(want ? `${recruitSectionTitle(key)} is open on the website` : `${recruitSectionTitle(key)} is closed on the website`);
  } catch (e) { toast(`Could not change it: ${recruitError(e)}`); }
  finally {
    st.busy.delete('mode-open:' + key);
    recruitPaintModeBar(recruitCycleRow() || cycle, key, recruitEditingForm());
    const host = $('[data-rc="form-editor"]');
    const fe = st.forms?.[`${cycle.id}:${key}`];
    if (host?.dataset.section === key && fe) { recruitRepaint($('[data-rc="fe-options"]', host), recruitFormOptionsHtml(fe)); recruitRepaint($('[data-rc="fe-foot"]', host), recruitFormFootHtml(fe)); }
  }
}

// The form /apply shows: the cycle's choice when that form is open, else the
// first open form in section order.
function recruitLandingKey(cycle) {
  const sections = recruitSections(cycle);
  const chosen = cycle?.doc?.site?.landing;
  if (sections[chosen]?.open) return chosen;
  return Object.keys(sections).find((k) => sections[k]?.open) || null;
}

function recruitPaintModeBar(cycle, key, editing) {
  const bar = $('[data-rc="mode-bar"]');
  if (!bar) return;
  bar.innerHTML = recruitModeBarInnerHtml(cycle, key, editing);
  recruitSegSlide($('.rc-seg--mode', bar));
}

/* ------------------------------- model ----------------------------------- */

let recruitQuestionSeq = 0;
// Cards keep an identity across repaints so a move can be animated.
const recruitQuestionId = () => `q${++recruitQuestionSeq}`;

function recruitFormModel(sec, key, landing = null) {
  const fixed = new Set(RECRUIT_FIXED_KEYS[key] || ['name', 'email']);
  const questions = (Array.isArray(sec?.form?.questions) ? sec.form.questions : []).map((q) => {
    const out = {
      _id: recruitQuestionId(),
      key: q.key || '', type: RECRUIT_QUESTION_TYPES.some((t) => t.value === q.type) ? q.type : 'short',
      label: q.label || '', help: q.help || '', required: q.required === true, fixed: fixed.has(q.key),
    };
    if (Array.isArray(q.options)) out.options = q.options.map(String);
    if (q.max) out.max = Number(q.max);
    if (Array.isArray(q.accept)) out.accept = [...q.accept];
    if (q.maxBytes) out.maxBytes = Number(q.maxBytes);
    return out;
  });
  return {
    title: sec?.title || RECRUIT_SECTION_LABELS[key] || key, description: sec?.description || '', open: sec?.open === true, atApply: landing === key,
    notify: sec?.notify !== false, notifyTo: Array.isArray(sec?.notifyTo) ? sec.notifyTo.map(String) : [], replace: sec?.replace !== false, capacity: Number(sec?.capacity) > 0 ? Number(sec.capacity) : 0, questions,
  };
}

// One draft per cycle and section; it survives a look at the responses and
// comes back when the tab is opened again.
function recruitFormEditor(cycle, key) {
  const st = recruitState();
  st.forms ||= {};
  const id = `${cycle.id}:${key}`;
  if (!st.forms[id]) {
    const model = recruitFormModel(recruitSections(cycle)[key], key, cycle.doc?.site?.landing || null);
    st.forms[id] = { id, key, cycleId: cycle.id, model, saved: JSON.stringify(model), saving: false, error: '', savedAt: 0 };
  }
  return st.forms[id];
}
const recruitFormDirty = (fe) => JSON.stringify(fe.model) !== fe.saved;
const recruitFormsDirty = () => Object.values(recruitState().forms || {}).some(recruitFormDirty);

/* ------------------------------- html ------------------------------------ */

function recruitFormEditorHtml(cycle, key) {
  const fe = recruitFormEditor(cycle, key);
  const m = fe.model;
  return `<div class="fe" data-rc="form-editor" data-section="${MD.esc(key)}" role="region" aria-label="${MD.esc(recruitSectionTitle(key, cycle))} editor">
    <div class="fe__head">
      <input class="fe__title" data-m="recruit-fe-title" value="${MD.esc(m.title)}" placeholder="Form title" maxlength="80" aria-label="Form title" autocomplete="off" spellcheck="false">
      <textarea class="fe__desc" data-m="recruit-fe-desc" rows="2" placeholder="A line or two shown above the form on the website" maxlength="600" aria-label="Description">${MD.esc(m.description)}</textarea>
    </div>
    <ol class="fe__list" data-rc="fe-list">${recruitQuestionCardsHtml(fe, cycle)}</ol>
    <div class="fe__add"><button type="button" class="btn" data-action="recruit-fe-add">${I.plus} Add question</button></div>
    <section class="fe-options" data-rc="fe-options" aria-label="How this form behaves">${recruitFormOptionsHtml(fe)}</section>
    <div class="fe__foot" data-rc="fe-foot">${recruitFormFootHtml(fe)}</div>
  </div>`;
}

// What happens around the form: whether the site shows it, whether it is
// the one at /apply, who hears about a response, repeats, and a cap.
function recruitFormOptionsHtml(fe) {
  const m = fe.model;
  const sw = (action, on, text, help = '') => `<label class="fe-switch fe-switch--row"><input type="checkbox" data-action="${action}" ${on ? 'checked' : ''}><span class="fe-switch__track"></span><span class="fe-switch__text">${text}${help ? `<small>${help}</small>` : ''}</span></label>`;
  return `<h3 class="fe-options__title">Form settings</h3>
    ${sw('recruit-fe-open', m.open, 'Open on the website')}
    ${sw('recruit-fe-landing', m.atApply, 'Shown at /apply', 'Where the QR code and the Apply link land. One form at a time.')}
    ${recruitFormNotifyHtml(fe)}
    ${sw('recruit-fe-replace', m.replace, 'If someone submits twice, replace their earlier answers')}
    <label class="fe-options__cap"><span class="fe-switch__text">Stop accepting after</span><input class="text-input fe-options__n" data-m="recruit-fe-capacity" value="${m.capacity ? MD.esc(String(m.capacity)) : ''}" inputmode="numeric" maxlength="6" placeholder="no limit" aria-label="Stop accepting after this many responses"><span class="fe-switch__text">responses</span></label>
    ${recruitFormRemoveHtml(fe)}`;
}

// Who hears about a response: only the addresses the form lists. The list
// shows while emailing is on; with nothing written, it says so.
function recruitFormNotifyHtml(fe) {
  const m = fe.model;
  const own = Array.isArray(m.notifyTo) ? m.notifyTo : [];
  const listed = own.some((e) => String(e).trim());
  const small = m.notify && !listed ? 'Nobody is emailed until an address is added.' : '';
  const rows = own.map((e, j) => `<li class="fe-opt"><input class="fe-opt__text" data-m="recruit-fe-recipient" data-j="${j}" value="${MD.esc(e)}" placeholder="name@cornell.edu" inputmode="email" maxlength="120" aria-label="Recipient ${j + 1}" autocomplete="off" spellcheck="false"><button type="button" class="icon-btn" data-action="recruit-fe-recipient-remove" data-j="${j}" aria-label="Remove ${MD.esc(e || 'this address')}">${I.x}</button></li>`).join('');
  const list = m.notify ? `<ul class="fe-opts fe-notify" data-rc="fe-notify">${rows}<li class="fe-opt fe-opt--add"><button type="button" class="linklike" data-action="recruit-fe-recipient-add">${own.length ? 'Add another address' : 'Add an address'}</button></li></ul>` : '';
  return `<label class="fe-switch fe-switch--row"><input type="checkbox" data-action="recruit-fe-notify" ${m.notify ? 'checked' : ''}><span class="fe-switch__track"></span><span class="fe-switch__text">Email the team when someone submits<small data-rc="fe-notify-default" ${small ? '' : 'hidden'}>${small}</small></span></label>${list}`;
}

// Any form can go once it has no responses.
function recruitFormRemoveHtml(fe) {
  const n = Number(recruitState().cycle?.counts?.bySection?.[fe.key] || 0);
  return `<div class="fe-options__remove"><span class="fe-switch__text">Remove this form${n ? `<small>${MD.esc(recruitPlural(n, 'response'))} so far. Close it instead; a form with responses cannot be removed.</small>` : ''}</span><button type="button" class="btn btn--sm ${n ? '' : 'btn--danger'}" data-action="recruit-form-remove" data-form="${MD.esc(fe.key)}" ${n ? 'disabled' : ''}>Remove</button></div>`;
}

/* ------------------------------- new and removed forms ------------------- */

const recruitFormKey = (title) => { const k = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); return /^[a-z]/.test(k) ? k : 'form-' + k; };

function recruitFormNewModalHtml() {
  const cycle = recruitCycleRow();
  const sections = cycle ? recruitSections(cycle) : {};
  const from = [{ value: '', label: 'A blank form (name and email)' }, ...Object.keys(sections).map((k) => ({ value: k, label: `A copy of ${sections[k].title}` }))];
  return `<div class="modal rc-form-new" role="dialog" aria-label="New form">
    <div class="modal__head"><h3>New form</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <form class="modal__body rc-form" data-action="recruit-form-create">
      ${recruitFormField('Name', `<input class="text-input" name="title" placeholder="e.g. Coffee chats, round 2" maxlength="80" required autocomplete="off" spellcheck="false">`)}
      ${recruitFormField('Start from', dd('recruit-form-from', from, ''))}
    </form>
    <div class="modal__foot"><button class="btn" data-action="modal-close">Cancel</button><button class="btn btn--primary" data-action="recruit-form-create-go">Create form</button></div>
  </div>`;
}

async function recruitCreateForm() {
  const st = recruitState();
  const cycle = recruitCycleRow();
  const form = $('.rc-form-new form');
  if (!cycle || !form || st.busy.has('form-new')) return;
  const title = String(form.elements.title.value || '').trim();
  if (!title) { form.elements.title.focus(); toast('Give the form a name'); return; }
  const sections = recruitSections(cycle);
  let key = recruitFormKey(title);
  for (let n = 2; sections[key] !== undefined; n += 1) key = `${recruitFormKey(title).slice(0, 37)}-${n}`;
  const fromKey = $('[data-m="recruit-form-from"]', form)?.dataset.value || '';
  const questions = fromKey && sections[fromKey] ? JSON.parse(JSON.stringify(sections[fromKey].form.questions)) : [
    { key: 'name', type: 'short', label: 'Name', required: true, max: 100 }, { key: 'email', type: 'email', label: 'Email', required: true, max: 200 },
  ];
  st.busy.add('form-new');
  try {
    await recruitPutSettings(cycle, 'site', { sections: { [key]: { title, description: fromKey && sections[fromKey] ? sections[fromKey].description : '', open: false, form: { questions } } } });
    toast(`${title} added`);
    closeModal(() => { RECRUIT.reset(cycle.id); nav(recruitPanelHref(cycle.id, key, { edit: 1 })); });
  } catch (e) { toast(`Could not add: ${recruitError(e)}`); }
  finally { st.busy.delete('form-new'); }
}

function recruitConfirmRemoveForm(key) {
  const cycle = recruitCycleRow();
  const sec = cycle ? recruitSections(cycle)[key] : null;
  if (!cycle || !sec || !recruitCan('lead')) return;
  UI.modal = {
    kind: 'confirm', title: `Remove ${sec.title}?`, danger: true, confirm: 'Remove form',
    text: `The form and its questions go; it has no responses. The website stops showing it at once.`,
    onGo: async () => {
      try {
        await recruitPutSettings(cycle, 'site', { remove: [key] });
        const st = recruitState();
        delete st.forms?.[`${cycle.id}:${key}`];
        toast(`${sec.title} removed`);
        RECRUIT.reset(cycle.id);
        nav(recruitPanelHref(cycle.id, 'people'));
      } catch (e) { toast(`Could not remove: ${recruitError(e)}`); }
    },
  };
  render();
}

const recruitQuestionCardsHtml = (fe, cycle) => fe.model.questions.map((q, i, all) => recruitQuestionCardHtml(q, i, all.length, cycle)).join('');

function recruitFormFootHtml(fe) {
  const dirty = recruitFormDirty(fe);
  const status = fe.saving ? 'Saving…' : dirty ? 'Unsaved changes' : fe.savedAt ? 'Saved' : '';
  return `${fe.error ? `<span class="fe__error" role="alert">${MD.esc(fe.error)}</span>` : `<span class="fe__status ${dirty ? 'fe__status--dirty' : ''}" role="status">${status}</span>`}
    <button type="button" class="btn" data-action="recruit-fe-discard" ${dirty && !fe.saving ? '' : 'disabled'}>Discard</button>
    <button type="button" class="btn btn--primary" data-action="recruit-fe-save" ${dirty && !fe.saving ? '' : 'disabled'}>Save</button>`;
}

function recruitQuestionCardHtml(q, i, total, cycle) {
  const n = i + 1;
  const name = q.label || `question ${n}`;
  const typeControl = q.fixed
    ? `<span class="fe-q__type fe-q__type--fixed">${MD.esc(recruitTypeLabel(q.type))}</span>`
    : dd('recruit-fe-type', RECRUIT_QUESTION_TYPES, q.type, { small: true }).replace('data-m="recruit-fe-type"', `data-m="recruit-fe-type" data-i="${i}" aria-label="Answer type for ${MD.esc(name)}"`).replace('class="dd dd--sm"', 'class="dd dd--sm fe-q__type"');
  return `<li class="fe-q" data-i="${i}" data-qid="${MD.esc(q._id || '')}">
    <div class="fe-q__head">
      <button type="button" class="fe-q__grip" data-action="recruit-fe-grip" data-i="${i}" aria-label="Move ${MD.esc(name)}: drag, or press the arrow keys" title="Drag to reorder">${RECRUIT_GRIP}</button>
      <input class="fe-q__label" data-m="recruit-fe-label" data-i="${i}" value="${MD.esc(q.label)}" placeholder="Question" maxlength="120" aria-label="Question ${n}" autocomplete="off">
      ${typeControl}
    </div>
    ${recruitIsText(q.type) ? '' : `<input class="fe-q__help" data-m="recruit-fe-help" data-i="${i}" value="${MD.esc(q.help)}" placeholder="${MD.esc(RECRUIT_HELP_HINT[q.type] || '')}" maxlength="300" aria-label="Note for question ${n}" autocomplete="off">`}
    <div class="fe-q__answer" data-rc="fe-answer">${recruitAnswerPreviewHtml(q, i)}</div>
    <div class="fe-q__foot">
      <label class="fe-switch"><input type="checkbox" data-action="recruit-fe-required" data-i="${i}" ${q.required ? 'checked' : ''}><span class="fe-switch__track"></span><span class="fe-switch__text">Required</span></label>
      <span class="fe-q__tools">
        ${q.fixed ? '<span class="fe-q__fixed" title="The website needs this question">Fixed</span>' : `<button type="button" class="icon-btn" data-action="recruit-fe-remove" data-i="${i}" aria-label="Remove ${MD.esc(name)}">${I.x}</button>`}
      </span>
    </div>
  </li>`;
}

// The answer as the applicant will see it. For a typed answer the box is
// the placeholder's own input: what is written here is what they will read.
function recruitAnswerPreviewHtml(q, i) {
  const edit = (cls, hint) => `<input class="fe-ans ${cls} fe-ans--edit" data-m="recruit-fe-help" data-i="${i}" value="${MD.esc(q.help)}" placeholder="${MD.esc(hint)}" maxlength="300" aria-label="Placeholder for question ${i + 1}" autocomplete="off">`;
  switch (q.type) {
    case 'long': return `<textarea class="fe-ans fe-ans--para fe-ans--edit" data-m="recruit-fe-help" data-i="${i}" placeholder="${MD.esc(RECRUIT_HELP_HINT.long)}" maxlength="300" rows="3" aria-label="Placeholder for question ${i + 1}">${MD.esc(q.help)}</textarea>`;
    case 'email': return edit('fe-ans--line', RECRUIT_HELP_HINT.email);
    case 'link': return edit('fe-ans--line', RECRUIT_HELP_HINT.link);
    case 'file': return `<div class="fe-ans fe-ans--file">${I.paperclip}<span>Photo or PDF, up to 2.5 MB</span></div>`;
    case 'checkbox': return `<div class="fe-ans fe-ans--check"><span class="fe-mark"></span><span>${MD.esc(q.help || 'Yes')}</span></div>`;
    case 'single': case 'multi': return recruitOptionsHtml(q, i);
    default: return edit('fe-ans--line', RECRUIT_HELP_HINT.short);
  }
}

function recruitOptionsHtml(q, i) {
  const mark = q.type === 'single' ? 'fe-mark fe-mark--radio' : 'fe-mark';
  const options = q.options || [];
  if (q.fixed) {
    const note = q.key === 'subteam' ? "Options follow this cycle's subteams, under Settings." : '';
    return `<ul class="fe-opts">${options.map((o) => `<li class="fe-opt fe-opt--fixed"><span class="${mark}"></span><span class="fe-opt__text">${MD.esc(o)}</span></li>`).join('')}</ul>${note ? `<p class="fe-q__note">${note}</p>` : ''}`;
  }
  return `<ul class="fe-opts">${options.map((o, j) => `<li class="fe-opt"><span class="${mark}"></span><input class="fe-opt__text" data-m="recruit-fe-option" data-i="${i}" data-j="${j}" value="${MD.esc(o)}" placeholder="Option ${j + 1}" maxlength="80" aria-label="Option ${j + 1}" autocomplete="off"><button type="button" class="icon-btn" data-action="recruit-fe-option-remove" data-i="${i}" data-j="${j}" aria-label="Remove option ${j + 1}">${I.x}</button></li>`).join('')}
    <li class="fe-opt fe-opt--add"><span class="${mark} fe-mark--ghost"></span><button type="button" class="linklike" data-action="recruit-fe-option-add" data-i="${i}">Add option</button></li></ul>`;
}

/* ------------------------------- edits ----------------------------------- */

function recruitFeCtx(el) {
  const cycle = recruitCycleRow();
  if (!cycle) return null;
  const host = el?.closest?.('[data-rc="form-editor"]') || $('[data-rc="form-editor"]');
  const key = host?.dataset?.section || recruitSection();
  const fe = recruitFormEditor(cycle, key);
  const q = fe.model.questions[Number(el?.dataset?.i)];
  return { cycle, key, fe, host, q, i: Number(el?.dataset?.i), j: Number(el?.dataset?.j) };
}

// Structural changes repaint the list and animate every card from where it
// was to where it is; typing repaints only the footer.
// The options card and the foot together: switches that show or hide rows.
function recruitPaintOptions(c) {
  if (!c?.host) return;
  recruitRepaint($('[data-rc="fe-options"]', c.host), recruitFormOptionsHtml(c.fe));
  recruitPaintForm(c, { list: false });
}

function recruitPaintForm(c, { list = true } = {}) {
  if (!c?.host) return;
  if (list) {
    const listEl = $('[data-rc="fe-list"]', c.host);
    const before = recruitCardTops(listEl);
    recruitRepaint(listEl, recruitQuestionCardsHtml(c.fe, c.cycle));
    recruitFlip(listEl, before);
  }
  recruitRepaint($('[data-rc="fe-foot"]', c.host), recruitFormFootHtml(c.fe));
}

const recruitCards = (listEl) => (listEl ? [...listEl.querySelectorAll('.fe-q')].filter((el) => el.parentElement === listEl) : []);
const recruitMeasurable = (el) => typeof el?.getBoundingClientRect === 'function';

function recruitCardTops(listEl) {
  const tops = new Map();
  for (const el of recruitCards(listEl)) if (recruitMeasurable(el)) tops.set(el.dataset.qid, el.getBoundingClientRect().top);
  return tops;
}

const recruitReducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// FLIP: cards start where they were and glide to where they are now.
function recruitFlip(listEl, before) {
  if (!before.size || recruitReducedMotion()) return;
  const moved = [];
  for (const el of recruitCards(listEl)) {
    if (!recruitMeasurable(el) || !before.has(el.dataset.qid)) continue;
    const dy = before.get(el.dataset.qid) - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) continue;
    el.style.transition = 'none';
    el.style.transform = `translateY(${dy}px)`;
    moved.push(el);
  }
  if (!moved.length) return;
  void listEl.offsetHeight;
  for (const el of moved) { el.style.transition = 'transform 220ms cubic-bezier(0.2, 0, 0, 1)'; el.style.transform = ''; }
  setTimeout(() => { for (const el of moved) { el.style.transition = ''; } }, 260);
}

// Dragging a card by its grip: the card follows the pointer, the others slide
// out of its way, and the drop repaints the list in the new order with no
// jump because everything is already where it will be.
function recruitDragStart(ev, grip) {
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  const card = grip.closest('.fe-q');
  const listEl = card?.parentElement;
  const c = recruitFeCtx(grip);
  if (!card || !listEl || !c?.q || !recruitMeasurable(card)) return;
  ev.preventDefault();
  const cards = recruitCards(listEl);
  const from = cards.indexOf(card);
  const rects = cards.map((el) => el.getBoundingClientRect());
  const gap = cards.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 12;
  const h = rects[from].height + gap;
  const startY = ev.clientY;
  const others = cards.map((_, j) => j).filter((j) => j !== from);
  let to = from;
  card.classList.add('is-dragging');
  listEl.classList.add('is-sorting');
  try { grip.setPointerCapture?.(ev.pointerId); } catch { /* capture is a nicety */ }
  const mine = (e) => e.pointerId === undefined || ev.pointerId === undefined || e.pointerId === ev.pointerId;
  const move = (e) => {
    if (!mine(e)) return;
    const dy = e.clientY - startY;
    card.style.transform = `translateY(${dy}px)`;
    const centre = rects[from].top + rects[from].height / 2 + dy;
    to = others.filter((j) => rects[j].top + rects[j].height / 2 < centre).length;
    for (const j of others) {
      const shift = j < from ? (j >= to ? h : 0) : (j <= to ? -h : 0);
      cards[j].style.transform = shift ? `translateY(${shift}px)` : '';
    }
  };
  const end = (e) => {
    if (e && !mine(e)) return;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', end);
    document.removeEventListener('pointercancel', end);
    card.classList.remove('is-dragging');
    if (to !== from) {
      const qs = c.fe.model.questions;
      const [q] = qs.splice(from, 1);
      qs.splice(to, 0, q);
      recruitPaintForm(c);   // measured with the cards where they sit, so only the dragged one settles
      listEl.classList.remove('is-sorting');
      $(`.fe-q[data-i="${to}"] .fe-q__grip`, c.host)?.focus({ preventScroll: true });
    } else {
      for (const el of cards) el.style.transform = '';
      setTimeout(() => listEl.classList.remove('is-sorting'), 200);
    }
  };
  // Listened for on the document, so the drag survives the pointer leaving
  // the grip even where capture is refused.
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('pointerdown', (ev) => {
    const grip = typeof ev.target?.closest === 'function' ? ev.target.closest('.fe-q__grip') : null;
    if (grip) recruitDragStart(ev, grip);
  });
}

function recruitPaintAnswer(c) {
  const card = $(`.fe-q[data-i="${c.i}"] [data-rc="fe-answer"]`, c.host);
  // A typed answer's box is the input itself; repainting it would take the caret.
  if (card && !recruitIsChoice(c.q.type) && !recruitIsText(c.q.type)) card.innerHTML = recruitAnswerPreviewHtml(c.q, c.i);
}

// Arrow keys on a grip move the card one slot; the list animates the same
// way a drop does.
function recruitMoveQuestion(el, delta) {
  const c = recruitFeCtx(el);
  if (!c?.q) return;
  const qs = c.fe.model.questions, j = c.i + delta;
  if (j < 0 || j >= qs.length) return;
  [qs[c.i], qs[j]] = [qs[j], qs[c.i]];
  recruitPaintForm(c);
  $(`.fe-q[data-i="${j}"] .fe-q__grip`, c.host)?.focus({ preventScroll: true });
}

// What the server stores: keys for new questions come from their labels.
function recruitFormPayload(fe) {
  const used = new Set(fe.model.questions.map((q) => q.key).filter(Boolean));
  if (fe.model.capacity && (!Number.isInteger(fe.model.capacity) || fe.model.capacity < 0 || fe.model.capacity > 100000)) throw Object.assign(new Error('Stop accepting after a whole number of responses, up to 100,000.'), { focus: '[data-m="recruit-fe-capacity"]' });
  const questions = fe.model.questions.map((q, i) => {
    const label = String(q.label || '').trim();
    if (!label) throw Object.assign(new Error(`Question ${i + 1} needs a label.`), { focus: `[data-m="recruit-fe-label"][data-i="${i}"]` });
    let key = q.key;
    if (!key) {
      const base = recruitQuestionKey(label);
      key = base;
      for (let n = 2; used.has(key); n += 1) key = `${base.slice(0, 37)}_${n}`;
      used.add(key);
    }
    const out = { key, type: q.type, label, help: String(q.help || '').trim(), required: q.required === true };
    if (recruitIsChoice(q.type)) {
      const options = [...new Set((q.options || []).map((o) => String(o).trim()).filter(Boolean))];
      if (!options.length) throw Object.assign(new Error(`"${label}" needs at least one option.`), { focus: `[data-m="recruit-fe-option"][data-i="${i}"], [data-action="recruit-fe-option-add"][data-i="${i}"]` });
      out.options = options;
    }
    if (q.max) out.max = q.max;
    if (q.type === 'file') { out.accept = Array.isArray(q.accept) && q.accept.length ? q.accept : RECRUIT_FILE_ACCEPT; out.maxBytes = q.maxBytes || 2621440; }
    return out;
  });
  const notifyTo = [];
  (fe.model.notifyTo || []).forEach((e, j) => {
    const v = String(e || '').trim().toLowerCase();
    if (!v) return;
    if (!RECRUIT_EMAIL.test(v)) throw Object.assign(new Error(`"${v}" is not an email address.`), { focus: `[data-m="recruit-fe-recipient"][data-j="${j}"]` });
    if (!notifyTo.includes(v)) notifyTo.push(v);
  });
  if (notifyTo.length > RECRUIT_NOTIFY_MAX) throw Object.assign(new Error(`Up to ${RECRUIT_NOTIFY_MAX} addresses.`), { focus: '[data-action="recruit-fe-recipient-add"]' });
  return {
    title: String(fe.model.title || '').trim() || RECRUIT_SECTION_LABELS[fe.key] || fe.key, description: String(fe.model.description || '').trim(), open: fe.model.open === true,
    notify: fe.model.notify !== false, notifyTo, replace: fe.model.replace !== false, capacity: Number(fe.model.capacity) > 0 ? Number(fe.model.capacity) : 0, form: { questions },
  };
}

async function recruitSaveForm(el) {
  const c = recruitFeCtx(el);
  if (!c || c.fe.saving) return;
  const { fe, cycle, key } = c;
  let payload;
  try { payload = recruitFormPayload(fe); }
  catch (e) { fe.error = e.message; recruitPaintForm(c, { list: false }); if (e.focus) $(e.focus, c.host)?.focus(); return; }
  fe.saving = true; fe.error = '';
  recruitPaintForm(c, { list: false });
  try {
    // The /apply choice is one per cycle: this form takes it, gives it up, or leaves it.
    const current = cycle.doc?.site?.landing || null;
    const landing = fe.model.atApply ? key : (current === key ? null : current);
    await recruitPutSettings(cycle, 'site', { sections: { [key]: payload }, landing });
    const st = recruitState();
    if (st.cycle?.data?.id === cycle.id) st.cycle.sections = { ...recruitSections(cycle), [key]: payload };
    fe.model = recruitFormModel(payload, key, landing);
    fe.saved = JSON.stringify(fe.model);
    fe.savedAt = Date.now();
    toast(`${payload.title} saved${payload.open ? ' · live on the website' : ''}`);
    // A new title is the tab's label too.
    const tab = $(`.rc-tabs [role="tab"][href$="/${key}"]`);
    if (tab && tab.textContent !== payload.title) tab.textContent = payload.title;
  } catch (e) { fe.error = recruitError(e); }
  fe.saving = false;
  const host = $('[data-rc="form-editor"]');
  if (host?.dataset.section === key) { c.host = host; recruitPaintForm(c); recruitRepaint($('[data-rc="fe-options"]', host), recruitFormOptionsHtml(c.fe)); recruitPaintModeBar(recruitCycleRow() || cycle, key, true); }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', (ev) => {
    try { if (recruitFormsDirty()) { ev.preventDefault(); ev.returnValue = ''; } } catch { /* nothing to guard */ }
  });
}

RECRUIT.register({
  name: 'forms',
  order: 12,
  kernel: true,
  actions: {
    'recruit-fe-add': (el) => {
      const c = recruitFeCtx(el);
      if (!c) return;
      c.fe.model.questions.push({ key: '', type: 'short', label: '', help: '', required: false, fixed: false });
      recruitPaintForm(c);
      $$('[data-m="recruit-fe-label"]', c.host).at(-1)?.focus({ preventScroll: true });
    },
    'recruit-fe-remove': (el) => {
      const c = recruitFeCtx(el);
      if (!c?.q || c.q.fixed) return;
      c.fe.model.questions.splice(c.i, 1);
      recruitPaintForm(c);
      ($$('[data-m="recruit-fe-label"]', c.host)[Math.min(c.i, c.fe.model.questions.length - 1)] || $('[data-action="recruit-fe-add"]', c.host))?.focus({ preventScroll: true });
    },
    'recruit-fe-grip': () => {},   // a click on the grip does nothing; dragging and the arrow keys move the card
    'recruit-fe-required': (el) => { const c = recruitFeCtx(el); if (!c?.q) return; c.q.required = Boolean(el.checked); recruitPaintForm(c, { list: false }); },
    'recruit-fe-open': (el) => { const c = recruitFeCtx(el); if (!c) return; c.fe.model.open = Boolean(el.checked); recruitPaintForm(c, { list: false }); },
    'recruit-fe-landing': (el) => { const c = recruitFeCtx(el); if (!c) return; c.fe.model.atApply = Boolean(el.checked); recruitPaintForm(c, { list: false }); },
    'recruit-fe-notify': (el) => { const c = recruitFeCtx(el); if (!c) return; c.fe.model.notify = Boolean(el.checked); recruitPaintOptions(c); },
    'recruit-fe-recipient-add': (el) => {
      const c = recruitFeCtx(el);
      if (!c) return;
      c.fe.model.notifyTo = [...(c.fe.model.notifyTo || []), ''];
      recruitPaintOptions(c);
      $$('[data-m="recruit-fe-recipient"]', c.host).at(-1)?.focus({ preventScroll: true });
    },
    'recruit-fe-recipient-remove': (el) => {
      const c = recruitFeCtx(el);
      if (!c || !Array.isArray(c.fe.model.notifyTo)) return;
      c.fe.model.notifyTo.splice(c.j, 1);
      recruitPaintOptions(c);
      ($$('[data-m="recruit-fe-recipient"]', c.host)[Math.min(c.j, c.fe.model.notifyTo.length - 1)] || $('[data-action="recruit-fe-recipient-add"]', c.host))?.focus({ preventScroll: true });
    },
    'recruit-fe-replace': (el) => { const c = recruitFeCtx(el); if (!c) return; c.fe.model.replace = Boolean(el.checked); recruitPaintForm(c, { list: false }); },
    'recruit-fe-option-add': (el) => {
      const c = recruitFeCtx(el);
      if (!c?.q || c.q.fixed) return;
      c.q.options = [...(c.q.options || []), ''];
      recruitPaintForm(c);
      $$(`[data-m="recruit-fe-option"][data-i="${c.i}"]`, c.host).at(-1)?.focus({ preventScroll: true });
    },
    'recruit-fe-option-remove': (el) => {
      const c = recruitFeCtx(el);
      if (!c?.q || c.q.fixed || !Array.isArray(c.q.options)) return;
      c.q.options.splice(c.j, 1);
      recruitPaintForm(c);
      ($$(`[data-m="recruit-fe-option"][data-i="${c.i}"]`, c.host)[Math.min(c.j, c.q.options.length - 1)] || $(`[data-action="recruit-fe-option-add"][data-i="${c.i}"]`, c.host))?.focus({ preventScroll: true });
    },
    'recruit-copy-link': async (el) => {
      const link = el.dataset.link || '';
      try { await navigator.clipboard.writeText(link); toast('Link copied'); }
      catch { toast('Could not copy; the address is next to the button'); }
    },
    'recruit-fe-save': (el) => recruitSaveForm(el),
    'recruit-mode-open': (el) => recruitToggleFormOpen(el),
    'recruit-form-new': () => { if (!recruitCycleRow() || !recruitCan('lead')) return; UI.modal = { kind: 'recruit-form-new' }; render(); $('.rc-form-new [name="title"]')?.focus(); },
    'recruit-form-create': () => recruitCreateForm(),
    'recruit-form-create-go': () => recruitCreateForm(),
    'recruit-form-remove': (el) => recruitConfirmRemoveForm(el.dataset.form),
    'recruit-fe-discard': (el) => {
      const c = recruitFeCtx(el);
      if (!c) return;
      c.fe.model = JSON.parse(c.fe.saved); c.fe.error = '';
      recruitPaintForm(c);
      recruitRepaint($('[data-rc="fe-options"]', c.host), recruitFormOptionsHtml(c.fe));
      toast('Changes discarded');
    },
  },
  inputs: {
    'recruit-fe-title': (el) => { const c = recruitFeCtx(el); if (!c) return; c.fe.model.title = el.value; recruitPaintForm(c, { list: false }); },
    'recruit-fe-desc': (el) => { const c = recruitFeCtx(el); if (!c) return; c.fe.model.description = el.value; recruitPaintForm(c, { list: false }); },
    'recruit-fe-capacity': (el) => { const c = recruitFeCtx(el); if (!c) return; const n = Number(String(el.value || '').replace(/[^\d]/g, '')); c.fe.model.capacity = Number.isInteger(n) && n > 0 ? Math.min(n, 100000) : 0; recruitPaintForm(c, { list: false }); },
    'recruit-fe-label': (el) => { const c = recruitFeCtx(el); if (!c?.q) return; c.q.label = el.value; recruitPaintForm(c, { list: false }); },
    'recruit-fe-help': (el) => { const c = recruitFeCtx(el); if (!c?.q) return; c.q.help = el.value; recruitPaintAnswer(c); recruitPaintForm(c, { list: false }); },
    'recruit-fe-option': (el) => { const c = recruitFeCtx(el); if (!c?.q || !Array.isArray(c.q.options)) return; c.q.options[c.j] = el.value; recruitPaintForm(c, { list: false }); },
    'recruit-fe-recipient': (el) => {
      const c = recruitFeCtx(el);
      if (!c || !Array.isArray(c.fe.model.notifyTo)) return;
      c.fe.model.notifyTo[c.j] = el.value;
      // "Nobody is emailed" stands only while no address is written.
      const note = $('[data-rc="fe-notify-default"]', c.host);
      if (note) note.hidden = c.fe.model.notifyTo.some((e) => String(e).trim());
      recruitPaintForm(c, { list: false });
    },
  },
  dd: {
    // The default menu from data-opts opens; the pick lands here with a value.
    'recruit-fe-type': (host, value) => {
      if (value === undefined) return undefined;
      const c = recruitFeCtx(host);
      if (!c?.q || c.q.fixed || c.q.type === value) return;
      const wasChoice = recruitIsChoice(c.q.type), isChoice = recruitIsChoice(value);
      c.q.type = value;
      if (isChoice && !wasChoice) c.q.options = [''];
      if (!isChoice) delete c.q.options;
      if (value === 'file') { c.q.accept = [...RECRUIT_FILE_ACCEPT]; c.q.maxBytes = 2621440; } else { delete c.q.accept; delete c.q.maxBytes; }
      recruitPaintForm(c);
      $(`[data-m="recruit-fe-type"][data-i="${c.i}"]`, c.host)?.focus({ preventScroll: true });
    },
  },
  modals: { 'recruit-form-new': recruitFormNewModalHtml },
  keydown(ev) {
    const grip = typeof ev.target?.matches === 'function' && ev.target.matches('.fe-q__grip') ? ev.target : null;
    if (!grip || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return false;
    ev.preventDefault();
    recruitMoveQuestion(grip, ev.key === 'ArrowUp' ? -1 : 1);
    return true;
  },
  reset() {},
});

// recruit:forms:end
