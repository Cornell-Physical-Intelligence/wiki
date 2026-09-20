// recruit:forms:start
'use strict';

/* Forms (client): the Form settings section (versions, current, publish)
   and the builder dialog for drafts: sections per subteam, questions with
   dd() types, reorder, remove. State lives on UI.recruit.mod.forms with the
   undefined | {loading:true} | {error} | data sentinel; async completions
   paint regions in place or call renderBackground, never render(). */

const RC_FORMS_TYPES = [
  { value: 'short', label: 'Short answer' }, { value: 'long', label: 'Paragraph' }, { value: 'email', label: 'Email' },
  { value: 'single', label: 'One choice' }, { value: 'multi', label: 'Several choices' }, { value: 'checkbox', label: 'Checkbox' },
  { value: 'link', label: 'Link' }, { value: 'file', label: 'File' },
];
const RC_FORMS_TYPE_LABEL = Object.fromEntries(RC_FORMS_TYPES.map((t) => [t.value, t.label]));
const RC_FORMS_ALWAYS_REQUIRED = ['name', 'email'];
const RC_FORMS_LOCKED = ['name', 'email', 'subteam', 'year'];

function rcFormsCycle() { return UI.recruit?.cycle?.data || null; }
function rcFormsRole() { return UI.recruit?.cycle?.role || null; }
function rcFormsLead(role = rcFormsRole()) { return role === 'admin' || role === 'lead'; }
function rcFormsState() {
  UI.recruit ||= {};
  UI.recruit.mod ||= {};
  return (UI.recruit.mod.forms ||= { key: null, list: undefined, draft: null });
}
function rcFormsError(e) { return e?.name === 'TimeoutError' ? 'The request timed out. Try again.' : (e?.message || 'Something went wrong'); }
function rcFormsApi(path, opts = {}) { return RECRUIT.api(path, { signal: AbortSignal.timeout(20000), ...opts }); }
const rcFormsSubteams = (cycle) => (cycle?.doc?.subteams || []).map((s) => ({ value: s.key, label: s.name }));
const rcFormsKey = (label, taken, prefix = 'q') => {
  let key = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  if (!/^[a-z]/.test(key)) key = (prefix + '_' + key).replace(/_+$/, '').slice(0, 40);
  let out = key, n = 2;
  while (taken.includes(out)) out = key.slice(0, 37) + '_' + n++;
  return out;
};

/* -------------------------------- loaders ------------------------------- */

function rcFormsEnsureList(cycle) {
  if (typeof REMOTE === 'undefined' || !cycle) return;
  const st = rcFormsState();
  if (st.key !== cycle.id) Object.assign(st, { key: cycle.id, list: undefined, draft: null });
  if (st.list !== undefined) return;
  st.list = { loading: true };
  const key = cycle.id;
  rcFormsApi(`/recruit/cycles/${cycle.id}/forms`).then((out) => {
    if (rcFormsState().key !== key) return;
    rcFormsState().list = { forms: out.forms || [], current: out.current ?? 0 };
    renderBackground('recruit');
  }).catch((e) => {
    if (rcFormsState().key !== key) return;
    rcFormsState().list = { error: rcFormsError(e) };
    renderBackground('recruit');
  });
}

/* ---------------------------- settings section -------------------------- */

// The cycles panel draws the section and its heading; this is the body.
function rcFormsSettingsHtml(cycle) {
  rcFormsEnsureList(cycle);
  const st = rcFormsState();
  const list = st.list;
  let body;
  if (typeof REMOTE === 'undefined') body = '<p class="faint">Form versions need the live wiki.</p>';
  else if (list === undefined || list.loading) body = '<p class="sheet__note">Loading…</p>';
  else if (list.error) body = `<p class="sheet__note">${MD.esc(list.error)} <button class="linklike" data-action="recruit-form-refresh">Retry</button></p>`;
  else {
    const rows = list.forms.map((f) => `<tr>
      <td class="font-mono">${f.version}</td>
      <td>${f.status === 'published' ? (f.version === list.current || (list.current === 0 && f.version === 0) ? 'Receives applications' : 'Published') : f.status === 'draft' ? 'Draft' : 'Superseded'}${f.version === 0 ? ' <span class="faint">· fixed website form</span>' : ''}</td>
      <td>${f.createdBy ? MD.esc(f.createdBy.split('@')[0]) : '—'}${f.created ? ` <span class="faint">${recruitDate(f.created)}</span>` : ''}</td>
      <td class="rc-form-actions">${f.status === 'draft' ? `<button class="btn btn--sm" data-action="recruit-form-edit" data-id="${MD.esc(f.id)}" data-version="${f.version}">Edit…</button> <button class="btn btn--sm btn--primary" data-action="recruit-form-publish" data-id="${MD.esc(f.id)}" data-version="${f.version}">Publish</button>` : `<button class="btn btn--sm" data-action="recruit-form-copy" data-version="${f.version}">Copy to draft</button>`}</td>
    </tr>`).join('');
    body = `<p>Version <b class="font-mono">${list.current}</b> receives the website form.</p>
      <div class="sheet__scroll"><table aria-label="Form versions"><thead><tr><th>Version</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  return `${body}${typeof REMOTE === 'undefined' ? '' : `<p><button class="btn btn--sm" data-action="recruit-form-copy" data-version="${st.list?.current ?? 0}">New draft</button></p>`}`;
}

/* -------------------------------- builder ------------------------------- */

function rcFormsDraft() { return rcFormsState().draft; }
function rcFormsSectionOptions(doc) { return [{ value: '', label: 'No section' }, ...(doc.sections || []).map((s) => ({ value: s.key, label: s.title }))]; }
function rcFormsSectionsHtml(doc, cycle) {
  const sections = doc.sections || [];
  if (!sections.length) return '<p class="faint">No sections. Questions without a section show for everyone.</p>';
  return sections.map((s, i) => `<div class="rc-form-section" data-s="${i}">
    <span class="kbd">${MD.esc(s.key)}</span>
    <input class="text-input" data-m="recruit-form-sfield" data-s="${i}" data-f="title" value="${MD.esc(s.title)}" maxlength="80" aria-label="Section title" autocomplete="off">
    ${dd('recruit-form-steam', [{ value: '', label: 'Everyone' }, ...rcFormsSubteams(cycle)], s.subteam || '', { small: true })}
    <button type="button" class="icon-btn" data-action="recruit-form-section-remove" data-s="${i}" aria-label="Remove section">${I.x}</button>
  </div>`).join('');
}
function rcFormsQuestionHtml(q, i, doc, cycle) {
  const last = i === doc.questions.length - 1;
  const locked = RC_FORMS_LOCKED.includes(q.key);
  const choices = q.type === 'single' || q.type === 'multi';
  return `<div class="rc-form-q" data-q="${i}" data-key="${MD.esc(q.key)}">
    <div class="rc-form-q__head">
      <span class="kbd">${MD.esc(q.key)}</span><span class="faint">${MD.esc(RC_FORMS_TYPE_LABEL[q.type] || q.type)}${q.system ? ' · system' : ''}</span>
      <button type="button" class="icon-btn" data-action="recruit-form-up" data-q="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="icon-btn" data-action="recruit-form-down" data-q="${i}" aria-label="Move down" ${last ? 'disabled' : ''}>↓</button>
      <button type="button" class="icon-btn" data-action="recruit-form-remove" data-q="${i}" aria-label="Remove question" ${locked ? 'disabled' : ''}>${I.x}</button>
    </div>
    <label>Label<input class="text-input" data-m="recruit-form-field" data-q="${i}" data-f="label" value="${MD.esc(q.label || '')}" maxlength="120" autocomplete="off"></label>
    <label>Help<input class="text-input" data-m="recruit-form-field" data-q="${i}" data-f="help" value="${MD.esc(q.help || '')}" maxlength="300" autocomplete="off"></label>
    ${choices ? `<label>Choices, one per line<textarea class="text-input" data-m="recruit-form-field" data-q="${i}" data-f="options" rows="3" ${q.system && q.key === 'subteam' ? 'readonly' : ''}>${MD.esc((q.options || []).join('\n'))}</textarea></label>` : ''}
    <div class="rc-form-q__row">
      <label class="check"><input type="checkbox" data-action="recruit-form-required" data-q="${i}" ${q.required ? 'checked' : ''} ${RC_FORMS_ALWAYS_REQUIRED.includes(q.key) ? 'disabled' : ''}> Required</label>
      <label>Section ${dd('recruit-form-qsection', rcFormsSectionOptions(doc), q.section || '', { small: true })}</label>
      <label>Only for ${dd('recruit-form-qteam', [{ value: '', label: 'Everyone' }, ...rcFormsSubteams(cycle)], q.subteamOnly || '', { small: true })}</label>
    </div>
  </div>`;
}
function rcFormsListHtml(doc, cycle) {
  return (doc.questions || []).map((q, i) => rcFormsQuestionHtml(q, i, doc, cycle)).join('') || '<p class="faint">No questions yet.</p>';
}
function rcFormsFootHtml(draft) {
  const busy = draft?.saving;
  return `<button class="btn" data-action="modal-close">Close</button>
    <button class="btn" data-action="recruit-form-save" ${busy || !draft?.doc ? 'disabled' : ''}>${busy === 'save' ? 'Saving…' : 'Save draft'}</button>
    <button class="btn btn--primary" data-action="recruit-form-publish-draft" ${busy || !draft?.doc ? 'disabled' : ''}>${busy === 'publish' ? 'Publishing…' : 'Save and publish'}</button>`;
}
function rcFormsTitle(draft) { return draft?.loading ? 'Form' : draft?.isNew ? 'New form draft' : `Form · version ${draft?.version ?? ''} (draft)`; }
function rcFormsBodyHtml(draft, cycle) {
  const doc = draft?.doc;
  const body = !doc
    ? (draft?.error ? `<p class="sheet__note">${MD.esc(draft.error)}</p>` : '<p class="sheet__note">Loading…</p>')
    : `<h4 class="interest-subhead">Sections <span class="count">${(doc.sections || []).length}</span></h4>
      <div data-rc-sections>${rcFormsSectionsHtml(doc, cycle)}</div>
      <div class="rc-form-add"><input class="text-input" data-m="recruit-form-newsection" placeholder="New section" maxlength="80" aria-label="New section title" autocomplete="off"><button type="button" class="btn btn--sm" data-action="recruit-form-section-add">Add section</button></div>
      <h4 class="interest-subhead">Questions <span class="count" data-rc-qcount>${(doc.questions || []).length}</span></h4>
      <div data-rc-form-list>${rcFormsListHtml(doc, cycle)}</div>
      <div class="rc-form-add"><input class="text-input" data-m="recruit-form-newlabel" placeholder="Question" maxlength="120" aria-label="New question label" autocomplete="off">${dd('recruit-qtype', RC_FORMS_TYPES, 'short', { small: true })}<button type="button" class="btn btn--sm" data-action="recruit-form-add">Add question</button></div>`;
  return `${body}<p class="field-error" data-rc-error role="alert" ${draft?.error && doc ? '' : 'hidden'}>${MD.esc(doc ? draft?.error || '' : '')}</p>`;
}
function rcFormsBuilderModal() {
  const draft = rcFormsDraft();
  return `<div class="modal modal--wide rc-form-builder" role="dialog" aria-label="Edit form">
    <div class="modal__head"><h3 data-rc-title>${MD.esc(rcFormsTitle(draft))}</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body" data-rc-body>${rcFormsBodyHtml(draft, rcFormsCycle())}</div>
    <div class="modal__foot" data-rc-foot>${rcFormsFootHtml(draft)}</div>
  </div>`;
}
// Whole-dialog repaint once a draft arrives; the head and foot otherwise
// stay put and only the list moves.
function rcFormsPaintBuilder() {
  if (UI.modal?.kind !== 'recruit-form-edit') return;
  const dialog = $('.rc-form-builder');
  if (!dialog) return;
  const ref = focusReference(document.activeElement);
  const cycle = rcFormsCycle();
  const draft = rcFormsDraft();
  const title = $('[data-rc-title]', dialog);
  if (title) title.textContent = rcFormsTitle(draft);
  const bodyHost = $('[data-rc-body]', dialog);
  const list = $('[data-rc-form-list]', dialog);
  if (bodyHost && (!list || !draft?.doc)) bodyHost.innerHTML = rcFormsBodyHtml(draft, cycle);
  else if (list && draft?.doc) {
    list.innerHTML = rcFormsListHtml(draft.doc, cycle);
    const sections = $('[data-rc-sections]', dialog);
    if (sections) sections.innerHTML = rcFormsSectionsHtml(draft.doc, cycle);
    const count = $('[data-rc-qcount]', dialog);
    if (count) count.textContent = String(draft.doc.questions.length);
  }
  const foot = $('[data-rc-foot]', dialog);
  if (foot) foot.innerHTML = rcFormsFootHtml(draft);
  const error = $('[data-rc-error]', dialog);
  if (error) { error.textContent = draft?.error || ''; error.hidden = !draft?.error; }
  (resolveFocus(ref, dialog) || $('[data-m="recruit-form-newlabel"]', dialog) || $('[data-action="modal-close"]', dialog))?.focus({ preventScroll: true });
}
// List-only repaint after an edit; focus follows the question that moved.
function rcFormsPaintList(focus) {
  if (UI.modal?.kind !== 'recruit-form-edit') return;
  const dialog = $('.rc-form-builder');
  const draft = rcFormsDraft();
  if (!dialog || !draft?.doc) return;
  const list = $('[data-rc-form-list]', dialog);
  if (list) list.innerHTML = rcFormsListHtml(draft.doc, rcFormsCycle());
  const sections = $('[data-rc-sections]', dialog);
  if (sections) sections.innerHTML = rcFormsSectionsHtml(draft.doc, rcFormsCycle());
  const count = $('[data-rc-qcount]', dialog);
  if (count) count.textContent = String(draft.doc.questions.length);
  const target = focus?.action !== undefined ? $(`[data-action="${focus.action}"][data-${focus.section ? 's' : 'q'}="${focus.index}"]`, dialog) : null;
  (target && !target.disabled ? target : focus?.fallback ? $(focus.fallback, dialog) : null)?.focus({ preventScroll: true });
}
function rcFormsEdit(mutate) {
  const draft = rcFormsDraft();
  if (!draft?.doc || draft.saving) return;
  draft.dirty = true;
  draft.error = '';
  const focus = mutate(draft.doc);
  rcFormsPaintList(focus);
}
function rcFormsOpen({ version = null, id = null, copyFrom = null } = {}) {
  const cycle = rcFormsCycle();
  if (!cycle) return;
  const st = rcFormsState();
  st.draft = { loading: true, id, version, isNew: copyFrom !== null, doc: null, dirty: false, saving: false, error: '' };
  showModal({ kind: 'recruit-form-edit' });
  const key = cycle.id;
  const request = copyFrom !== null
    ? rcFormsApi(`/recruit/cycles/${cycle.id}/forms/${copyFrom}`)
    : rcFormsApi(`/recruit/cycles/${cycle.id}/forms/${version}`);
  request.then((out) => {
    if (rcFormsState().key !== key || rcFormsState().draft?.loading !== true) return;
    const form = out.form;
    rcFormsState().draft = { loading: false, id: copyFrom !== null ? null : form.id, version: copyFrom !== null ? null : form.version, isNew: copyFrom !== null, doc: JSON.parse(JSON.stringify(form.doc || { sections: [], questions: [] })), dirty: copyFrom !== null, saving: false, error: '' };
    rcFormsPaintBuilder();
  }).catch((e) => {
    if (rcFormsState().key !== key) return;
    rcFormsState().draft = { loading: false, id, version, isNew: copyFrom !== null, doc: null, dirty: false, saving: false, error: rcFormsError(e) };
    rcFormsPaintBuilder();
  });
}
function rcFormsCheck(doc) {
  for (const q of doc.questions) {
    if (!String(q.label || '').trim()) return `Question "${q.key}" needs a label`;
    if ((q.type === 'single' || q.type === 'multi') && !(q.options || []).length) return `"${q.label}" needs at least one choice`;
  }
  for (const s of doc.sections || []) if (!String(s.title || '').trim()) return `Section "${s.key}" needs a title`;
  return '';
}
async function rcFormsSave({ publish = false } = {}) {
  const cycle = rcFormsCycle();
  const st = rcFormsState();
  const draft = st.draft;
  if (!cycle || !draft?.doc || draft.saving) return;
  const problem = rcFormsCheck(draft.doc);
  if (problem) { draft.error = problem; rcFormsPaintBuilder(); return; }
  draft.saving = publish ? 'publish' : 'save';
  draft.error = '';
  rcFormsPaintBuilder();
  const key = cycle.id;
  try {
    let form;
    if (draft.id) form = (await rcFormsApi(`/recruit/cycles/${cycle.id}/forms/${draft.id}`, { method: 'PATCH', body: JSON.stringify({ doc: draft.doc }) })).form;
    else form = (await rcFormsApi(`/recruit/cycles/${cycle.id}/forms`, { method: 'POST', body: JSON.stringify({ doc: draft.doc }) })).form;
    if (rcFormsState().key !== key) return;
    Object.assign(draft, { id: form.id, version: form.version, isNew: false, dirty: false, doc: form.doc || draft.doc });
    if (st.list && !st.list.loading && !st.list.error) {
      const i = st.list.forms.findIndex((f) => f.id === form.id);
      const summary = { id: form.id, version: form.version, status: form.status, created: form.created, createdBy: form.createdBy, published: form.published };
      if (i >= 0) st.list.forms[i] = summary; else st.list.forms.push(summary);
    }
    if (publish) {
      const out = await rcFormsApi(`/recruit/cycles/${cycle.id}/forms/${form.id}/publish`, { method: 'POST', body: '{}' });
      if (rcFormsState().key !== key) return;
      rcFormsApplyPublish(out);
      draft.saving = false;
      st.draft = null;
      closeModal(() => renderBackground('recruit'));
      toast(`Form version ${out.current ?? form.version} published`);
      return;
    }
    draft.saving = false;
    toast('Draft saved');
    rcFormsPaintBuilder();
  } catch (e) {
    if (rcFormsState().key !== key) return;
    draft.saving = false;
    draft.error = rcFormsError(e);
    rcFormsPaintBuilder();
  }
}
function rcFormsApplyPublish(out) {
  const st = rcFormsState();
  const version = out.current ?? out.form?.version;
  if (UI.recruit?.cycle?.data && version !== undefined) UI.recruit.cycle.data.formVersion = version;
  if (st.list && !st.list.loading && !st.list.error) {
    for (const f of st.list.forms) {
      if (f.id === out.form?.id) { f.status = 'published'; f.published = out.form.published; }
      else if (f.status === 'published' && f.version !== 0) f.status = 'superseded';
    }
    if (version !== undefined) st.list.current = version;
  }
}
async function rcFormsPublish(id, version) {
  const cycle = rcFormsCycle();
  if (!cycle) return;
  const key = cycle.id;
  const button = $(`[data-action="recruit-form-publish"][data-id="${id}"]`);
  if (button) { button.disabled = true; button.textContent = 'Publishing…'; }
  try {
    const out = await rcFormsApi(`/recruit/cycles/${cycle.id}/forms/${id}/publish`, { method: 'POST', body: '{}' });
    if (rcFormsState().key !== key) return;
    rcFormsApplyPublish(out);
    toast(`Form version ${out.current ?? version} published`);
    renderBackground('recruit');
  } catch (e) {
    if (button?.isConnected) { button.disabled = false; button.textContent = 'Publish'; }
    toast(rcFormsError(e));
  }
}

/* -------------------------------- module -------------------------------- */

RECRUIT.register({
  name: 'forms',
  order: 40,
  settings: {
    id: 'form',
    label: 'Form',
    mount: (cycle) => rcFormsEnsureList(cycle),
    view: (cycle) => rcFormsSettingsHtml(cycle),
    async submit() {},
  },
  actions: {
    'recruit-form-refresh': () => { rcFormsState().list = undefined; render(); },
    'recruit-form-edit': (el) => rcFormsOpen({ id: el.dataset.id, version: Number(el.dataset.version) }),
    'recruit-form-copy': (el) => rcFormsOpen({ copyFrom: Number(el.dataset.version || 0) }),
    'recruit-form-publish': (el) => {
      const version = Number(el.dataset.version);
      showModal({ kind: 'confirm', title: `Publish version ${version}?`, text: 'Applicants see the new questions right away. The published version cannot be edited afterwards.', confirm: 'Publish', onGo: () => rcFormsPublish(el.dataset.id, version) });
    },
    'recruit-form-add': (el) => {
      const dialog = el.closest('.modal') || document;
      const input = $('[data-m="recruit-form-newlabel"]', dialog);
      const label = (input?.value || '').trim();
      const type = $('[data-m="recruit-qtype"]', dialog)?.dataset.value || 'short';
      if (!label) { input?.focus(); return; }
      rcFormsEdit((doc) => {
        const key = rcFormsKey(label, doc.questions.map((q) => q.key));
        doc.questions.push({ key, type, label, help: '', required: false, system: false, options: [], max: null, accept: [], maxBytes: null, section: null, subteamOnly: null });
        return { action: 'recruit-form-up', index: doc.questions.length - 1, fallback: '[data-m="recruit-form-newlabel"]' };
      });
      if (input) input.value = '';
    },
    'recruit-form-up': (el) => rcFormsEdit((doc) => { const i = Number(el.dataset.q); if (i > 0) [doc.questions[i - 1], doc.questions[i]] = [doc.questions[i], doc.questions[i - 1]]; return { action: 'recruit-form-up', index: Math.max(0, i - 1), fallback: `[data-action="recruit-form-down"][data-q="${Math.max(0, i - 1)}"]` }; }),
    'recruit-form-down': (el) => rcFormsEdit((doc) => { const i = Number(el.dataset.q); if (i < doc.questions.length - 1) [doc.questions[i + 1], doc.questions[i]] = [doc.questions[i], doc.questions[i + 1]]; const at = Math.min(doc.questions.length - 1, i + 1); return { action: 'recruit-form-down', index: at, fallback: `[data-action="recruit-form-up"][data-q="${at}"]` }; }),
    'recruit-form-remove': (el) => rcFormsEdit((doc) => { const i = Number(el.dataset.q); if (doc.questions[i] && !RC_FORMS_LOCKED.includes(doc.questions[i].key)) doc.questions.splice(i, 1); return { action: 'recruit-form-remove', index: Math.min(i, doc.questions.length - 1), fallback: '[data-m="recruit-form-newlabel"]' }; }),
    'recruit-form-required': (el, ev) => { ev?.stopPropagation?.(); const draft = rcFormsDraft(); const q = draft?.doc?.questions[Number(el.dataset.q)]; if (!q) return; q.required = Boolean(el.checked); draft.dirty = true; },
    'recruit-form-section-add': (el) => {
      const dialog = el.closest('.modal') || document;
      const input = $('[data-m="recruit-form-newsection"]', dialog);
      const title = (input?.value || '').trim();
      if (!title) { input?.focus(); return; }
      rcFormsEdit((doc) => { doc.sections ||= []; doc.sections.push({ key: rcFormsKey(title, doc.sections.map((s) => s.key), 's'), title, subteam: null }); return { action: 'recruit-form-section-remove', index: doc.sections.length - 1, section: true, fallback: '[data-m="recruit-form-newsection"]' }; });
      if (input) input.value = '';
    },
    'recruit-form-section-remove': (el) => rcFormsEdit((doc) => { const i = Number(el.dataset.s); const gone = doc.sections?.[i]; if (!gone) return null; doc.sections.splice(i, 1); for (const q of doc.questions) if (q.section === gone.key) q.section = null; return { action: 'recruit-form-section-remove', index: Math.min(i, doc.sections.length - 1), section: true, fallback: '[data-m="recruit-form-newsection"]' }; }),
    'recruit-form-save': () => rcFormsSave({ publish: false }),
    'recruit-form-publish-draft': () => rcFormsSave({ publish: true }),
  },
  inputs: {
    'recruit-form-field': (el) => {
      const draft = rcFormsDraft();
      const q = draft?.doc?.questions[Number(el.dataset.q)];
      if (!q) return;
      const f = el.dataset.f;
      if (f === 'options') q.options = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
      else q[f] = el.value;
      draft.dirty = true;
    },
    'recruit-form-sfield': (el) => {
      const draft = rcFormsDraft();
      const s = draft?.doc?.sections?.[Number(el.dataset.s)];
      if (!s) return;
      s[el.dataset.f] = el.value;
      draft.dirty = true;
    },
  },
  dd: {
    'recruit-qtype': () => {},
    'recruit-form-qsection': (host, value) => { if (value === undefined) return; const draft = rcFormsDraft(); const row = host.closest('[data-q]'); const q = draft?.doc?.questions[Number(row?.dataset.q)]; if (!q) return; q.section = value || null; draft.dirty = true; },
    'recruit-form-qteam': (host, value) => { if (value === undefined) return; const draft = rcFormsDraft(); const row = host.closest('[data-q]'); const q = draft?.doc?.questions[Number(row?.dataset.q)]; if (!q) return; q.subteamOnly = value || null; draft.dirty = true; },
    'recruit-form-steam': (host, value) => { if (value === undefined) return; const draft = rcFormsDraft(); const row = host.closest('[data-s]'); const s = draft?.doc?.sections?.[Number(row?.dataset.s)]; if (!s) return; s.subteam = value || null; draft.dirty = true; },
  },
  modals: {
    'recruit-form-edit': rcFormsBuilderModal,
  },
  reset() { Object.assign(rcFormsState(), { key: null, list: undefined, draft: null }); },
});
// recruit:forms:end
