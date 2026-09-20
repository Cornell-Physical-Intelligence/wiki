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
  short: 'Placeholder text (optional)', long: 'Placeholder text (optional)', email: 'Placeholder text (optional)', link: 'Placeholder text (optional)',
  checkbox: 'Text next to the box', single: 'Note under the question (optional)', multi: 'Note under the question (optional)', file: 'Note under the question (optional)',
};
const recruitQuestionKey = (label) => { const k = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40); return /^[a-z]/.test(k) ? k : 'q_' + k; };
const recruitTypeLabel = (type) => (RECRUIT_QUESTION_TYPES.find((t) => t.value === type) || RECRUIT_QUESTION_TYPES[0]).label;
const recruitIsChoice = (type) => type === 'single' || type === 'multi';

// The form view of a section tab (?edit=1) is for leads.
const recruitEditingForm = () => recruitCan('lead') && UI.route?.params?.edit === '1';

/* ------------------------------- mode bar -------------------------------- */

// Responses | Form on the left; whether the website takes this form on the right.
function recruitModeBarHtml(cycle, key, editing) {
  const st = recruitState();
  const sec = recruitSections(cycle)[key];
  const count = Number(st.cycle?.counts?.bySection?.[key] || 0);
  const receiving = st.cycles ? st.cycles.intakeCycleId === cycle.id : null;
  const open = sec?.open === true;
  const status = !sec ? '' : !open ? '<span class="rc-mode__dot"></span>Closed on the website'
    : receiving === false ? '<span class="rc-mode__dot"></span>Open, but another cycle receives the website'
    : '<span class="rc-mode__dot rc-mode__dot--on"></span>Open on the website';
  const link = open && receiving !== false ? `<a href="https://cornellphysicalintelligence.com/apply/?form=${encodeURIComponent(key)}" target="_blank" rel="noopener">See it</a>` : '';
  const responses = `Responses <span class="count" data-rc-count="${MD.esc(key)}">${count.toLocaleString('en-US')}</span>`;
  const seg = recruitCan('lead')
    ? `<nav class="rc-seg" aria-label="View"><a href="${recruitPanelHref(cycle.id, key)}" ${editing ? '' : 'aria-current="page"'}>${responses}</a><a href="${recruitPanelHref(cycle.id, key, { edit: 1 })}" ${editing ? 'aria-current="page"' : ''}>Form</a></nav>`
    : `<span class="rc-mode__plain">${responses}</span>`;
  return `<div class="rc-mode" data-rc="mode-bar"><span class="rc-mode__status" data-rc="mode-status">${status}${link}</span>${seg}</div>`;
}

function recruitPaintModeBar(cycle, key, editing) {
  const bar = $('[data-rc="mode-bar"]');
  if (bar) bar.outerHTML = recruitModeBarHtml(cycle, key, editing);
}

/* ------------------------------- model ----------------------------------- */

function recruitFormModel(sec, key) {
  const fixed = new Set(RECRUIT_FIXED_KEYS[key] || ['name', 'email']);
  const questions = (Array.isArray(sec?.form?.questions) ? sec.form.questions : []).map((q) => {
    const out = {
      key: q.key || '', type: RECRUIT_QUESTION_TYPES.some((t) => t.value === q.type) ? q.type : 'short',
      label: q.label || '', help: q.help || '', required: q.required === true, fixed: fixed.has(q.key),
    };
    if (Array.isArray(q.options)) out.options = q.options.map(String);
    if (q.max) out.max = Number(q.max);
    if (Array.isArray(q.accept)) out.accept = [...q.accept];
    if (q.maxBytes) out.maxBytes = Number(q.maxBytes);
    return out;
  });
  return { title: sec?.title || RECRUIT_SECTION_LABELS[key], description: sec?.description || '', open: sec?.open === true, questions };
}

// One draft per cycle and section; it survives a look at the responses and
// comes back when the tab is opened again.
function recruitFormEditor(cycle, key) {
  const st = recruitState();
  st.forms ||= {};
  const id = `${cycle.id}:${key}`;
  if (!st.forms[id]) {
    const model = recruitFormModel(recruitSections(cycle)[key], key);
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
  return `<div class="fe" data-rc="form-editor" data-section="${MD.esc(key)}" role="region" aria-label="${MD.esc(RECRUIT_SECTION_LABELS[key])} editor">
    <div class="fe__head">
      <input class="fe__title" data-m="recruit-fe-title" value="${MD.esc(m.title)}" placeholder="Form title" maxlength="80" aria-label="Form title" autocomplete="off" spellcheck="false">
      <textarea class="fe__desc" data-m="recruit-fe-desc" rows="2" placeholder="A line or two shown above the form on the website" maxlength="600" aria-label="Description">${MD.esc(m.description)}</textarea>
    </div>
    <ol class="fe__list" data-rc="fe-list">${recruitQuestionCardsHtml(fe, cycle)}</ol>
    <div class="fe__add"><button type="button" class="btn" data-action="recruit-fe-add">${I.plus} Add question</button></div>
    <div class="fe__foot" data-rc="fe-foot">${recruitFormFootHtml(fe)}</div>
  </div>`;
}

const recruitQuestionCardsHtml = (fe, cycle) => fe.model.questions.map((q, i, all) => recruitQuestionCardHtml(q, i, all.length, cycle)).join('');

function recruitFormFootHtml(fe) {
  const dirty = recruitFormDirty(fe);
  const status = fe.saving ? 'Saving…' : dirty ? 'Unsaved changes' : fe.savedAt ? 'Saved' : '';
  return `<label class="fe-switch fe-switch--lg"><input type="checkbox" data-action="recruit-fe-open" ${fe.model.open ? 'checked' : ''}><span class="fe-switch__track"></span><span class="fe-switch__text">Open on the website</span></label>
    ${fe.error ? `<span class="fe__error" role="alert">${MD.esc(fe.error)}</span>` : `<span class="fe__status ${dirty ? 'fe__status--dirty' : ''}" role="status">${status}</span>`}
    <button type="button" class="btn" data-action="recruit-fe-discard" ${dirty && !fe.saving ? '' : 'disabled'}>Discard</button>
    <button type="button" class="btn btn--primary" data-action="recruit-fe-save" ${dirty && !fe.saving ? '' : 'disabled'}>Save</button>`;
}

function recruitQuestionCardHtml(q, i, total, cycle) {
  const n = i + 1;
  const name = q.label || `question ${n}`;
  const typeControl = q.fixed
    ? `<span class="fe-q__type fe-q__type--fixed" title="The website needs this question as it is">${MD.esc(recruitTypeLabel(q.type))}</span>`
    : dd('recruit-fe-type', RECRUIT_QUESTION_TYPES, q.type, { small: true }).replace('data-m="recruit-fe-type"', `data-m="recruit-fe-type" data-i="${i}" aria-label="Answer type for ${MD.esc(name)}"`).replace('class="dd dd--sm"', 'class="dd dd--sm fe-q__type"');
  return `<li class="fe-q" data-i="${i}">
    <div class="fe-q__head">
      <input class="fe-q__label" data-m="recruit-fe-label" data-i="${i}" value="${MD.esc(q.label)}" placeholder="Question" maxlength="120" aria-label="Question ${n}" autocomplete="off">
      ${typeControl}
    </div>
    <input class="fe-q__help" data-m="recruit-fe-help" data-i="${i}" value="${MD.esc(q.help)}" placeholder="${MD.esc(RECRUIT_HELP_HINT[q.type] || '')}" maxlength="300" aria-label="Note for question ${n}" autocomplete="off">
    <div class="fe-q__answer" data-rc="fe-answer">${recruitAnswerPreviewHtml(q, i)}</div>
    <div class="fe-q__foot">
      <label class="fe-switch"><input type="checkbox" data-action="recruit-fe-required" data-i="${i}" ${q.required ? 'checked' : ''}><span class="fe-switch__track"></span><span class="fe-switch__text">Required</span></label>
      <span class="fe-q__tools">
        <button type="button" class="icon-btn fe-q__up" data-action="recruit-fe-up" data-i="${i}" aria-label="Move ${MD.esc(name)} up" ${i === 0 ? 'disabled' : ''}>${I.chev}</button>
        <button type="button" class="icon-btn" data-action="recruit-fe-down" data-i="${i}" aria-label="Move ${MD.esc(name)} down" ${i >= total - 1 ? 'disabled' : ''}>${I.chev}</button>
        ${q.fixed ? '<span class="fe-q__fixed" title="The website needs this question">Fixed</span>' : `<button type="button" class="icon-btn" data-action="recruit-fe-remove" data-i="${i}" aria-label="Remove ${MD.esc(name)}">${I.x}</button>`}
      </span>
    </div>
  </li>`;
}

// The answer as the applicant will see it.
function recruitAnswerPreviewHtml(q, i) {
  switch (q.type) {
    case 'long': return `<div class="fe-ans fe-ans--para">${MD.esc(q.help || 'Long answer')}</div>`;
    case 'email': return `<div class="fe-ans fe-ans--line">${MD.esc(q.help || 'netid@cornell.edu')}</div>`;
    case 'link': return `<div class="fe-ans fe-ans--line">${MD.esc(q.help || 'https://')}</div>`;
    case 'file': return `<div class="fe-ans fe-ans--file">${I.paperclip}<span>Photo or PDF, up to 2.5 MB</span></div>`;
    case 'checkbox': return `<div class="fe-ans fe-ans--check"><span class="fe-mark"></span><span>${MD.esc(q.help || 'Yes')}</span></div>`;
    case 'single': case 'multi': return recruitOptionsHtml(q, i);
    default: return `<div class="fe-ans fe-ans--line">${MD.esc(q.help || 'Short answer')}</div>`;
  }
}

function recruitOptionsHtml(q, i) {
  const mark = q.type === 'single' ? 'fe-mark fe-mark--radio' : 'fe-mark';
  const options = q.options || [];
  if (q.fixed) {
    const note = q.key === 'subteam' ? "Options follow this cycle's subteams, under Settings." : 'A fixed list.';
    return `<ul class="fe-opts">${options.map((o) => `<li class="fe-opt fe-opt--fixed"><span class="${mark}"></span><span class="fe-opt__text">${MD.esc(o)}</span></li>`).join('')}</ul><p class="fe-q__note">${note}</p>`;
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

// Structural changes repaint the list; typing repaints only the footer.
function recruitPaintForm(c, { list = true } = {}) {
  if (!c?.host) return;
  if (list) recruitRepaint($('[data-rc="fe-list"]', c.host), recruitQuestionCardsHtml(c.fe, c.cycle));
  recruitRepaint($('[data-rc="fe-foot"]', c.host), recruitFormFootHtml(c.fe));
}

function recruitPaintAnswer(c) {
  const card = $(`.fe-q[data-i="${c.i}"] [data-rc="fe-answer"]`, c.host);
  if (card && !recruitIsChoice(c.q.type)) card.innerHTML = recruitAnswerPreviewHtml(c.q, c.i);
}

function recruitMoveQuestion(el, delta) {
  const c = recruitFeCtx(el);
  if (!c?.q) return;
  const qs = c.fe.model.questions, j = c.i + delta;
  if (j < 0 || j >= qs.length) return;
  [qs[c.i], qs[j]] = [qs[j], qs[c.i]];
  recruitPaintForm(c);
  ($(`[data-action="${delta < 0 ? 'recruit-fe-up' : 'recruit-fe-down'}"][data-i="${j}"]:not([disabled])`, c.host) || $(`[data-action="${delta < 0 ? 'recruit-fe-down' : 'recruit-fe-up'}"][data-i="${j}"]`, c.host))?.focus({ preventScroll: true });
}

// What the server stores: keys for new questions come from their labels.
function recruitFormPayload(fe) {
  const used = new Set(fe.model.questions.map((q) => q.key).filter(Boolean));
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
  return { title: String(fe.model.title || '').trim() || RECRUIT_SECTION_LABELS[fe.key], description: String(fe.model.description || '').trim(), open: fe.model.open === true, form: { questions } };
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
    await recruitPutSettings(cycle, 'site', { sections: { [key]: payload } });
    const st = recruitState();
    if (st.cycle?.data?.id === cycle.id) st.cycle.sections = { ...recruitSections(cycle), [key]: payload };
    fe.model = recruitFormModel(payload, key);
    fe.saved = JSON.stringify(fe.model);
    fe.savedAt = Date.now();
    toast(`${RECRUIT_SECTION_LABELS[key]} saved${payload.open ? ' · live on the website' : ''}`);
  } catch (e) { fe.error = recruitError(e); }
  fe.saving = false;
  const host = $('[data-rc="form-editor"]');
  if (host?.dataset.section === key) { c.host = host; recruitPaintForm(c); recruitPaintModeBar(recruitCycleRow() || cycle, key, true); }
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
    'recruit-fe-up': (el) => recruitMoveQuestion(el, -1),
    'recruit-fe-down': (el) => recruitMoveQuestion(el, 1),
    'recruit-fe-required': (el) => { const c = recruitFeCtx(el); if (!c?.q) return; c.q.required = Boolean(el.checked); recruitPaintForm(c, { list: false }); },
    'recruit-fe-open': (el) => { const c = recruitFeCtx(el); if (!c) return; c.fe.model.open = Boolean(el.checked); recruitPaintForm(c, { list: false }); },
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
    'recruit-fe-save': (el) => recruitSaveForm(el),
    'recruit-fe-discard': (el) => {
      const c = recruitFeCtx(el);
      if (!c) return;
      c.fe.model = JSON.parse(c.fe.saved); c.fe.error = '';
      recruitPaintForm(c);
      toast('Changes discarded');
    },
  },
  inputs: {
    'recruit-fe-title': (el) => { const c = recruitFeCtx(el); if (!c) return; c.fe.model.title = el.value; recruitPaintForm(c, { list: false }); },
    'recruit-fe-desc': (el) => { const c = recruitFeCtx(el); if (!c) return; c.fe.model.description = el.value; recruitPaintForm(c, { list: false }); },
    'recruit-fe-label': (el) => { const c = recruitFeCtx(el); if (!c?.q) return; c.q.label = el.value; recruitPaintForm(c, { list: false }); },
    'recruit-fe-help': (el) => { const c = recruitFeCtx(el); if (!c?.q) return; c.q.help = el.value; recruitPaintAnswer(c); recruitPaintForm(c, { list: false }); },
    'recruit-fe-option': (el) => { const c = recruitFeCtx(el); if (!c?.q || !Array.isArray(c.q.options)) return; c.q.options[c.j] = el.value; recruitPaintForm(c, { list: false }); },
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
  reset() {},
});

// recruit:forms:end
