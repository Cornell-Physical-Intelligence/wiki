/* ------------------------- recruit: comms (self-contained) ------------------
   Client half of lib/recruit/modules/comms.js: the Emails panel (templates
   and the send log), the template editor with preview, and the Compose
   dialog that a selection opens. State on UI.recruit.mod.comms as
   undefined | {loading:true} | {error} | data, keyed by cycle. */

// recruit:comms:start
'use strict';

const RC_CM_TIMEOUT = 20000;
const RC_CM_LABEL = { received: 'Application received', interview_invite: 'Interview invitation', offer: 'Offer', rejection: 'Not this time', waitlist: 'Waitlist' };
const RC_CM_STATUS = { queued: 'Queued', sending: 'Sending', sent: 'Sent', failed: 'Failed', skipped: 'Skipped' };

function rcCmState() { UI.recruit.mod ||= {}; return UI.recruit.mod.comms; }
function rcCmSet(v) { UI.recruit.mod ||= {}; UI.recruit.mod.comms = v; }
function rcCmBusy() { return (UI.recruit.busy ||= new Set()); }
function rcCmVal(form, m) { return $(`[data-m="${m}"]`, form)?.value ?? ''; }
function rcCmDd(form, m) { return $(`[data-m="${m}"]`, form)?.dataset.value ?? ''; }
function rcCmMsg(e) { return e?.name === 'TimeoutError' ? 'The request timed out. Try again.' : e?.message || 'Something went wrong'; }
function rcCmLabel(key) { return RC_CM_LABEL[key] || (key.startsWith('custom-') ? key.slice(7).replace(/-/g, ' ') : key); }
function rcCmError(scope, text) {
  const el = $('[data-cm-error]', scope) || $('[data-cm-error]');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}
/* ------------------------------- loading ---------------------------------- */

async function rcCmLoad(cycle) {
  const key = cycle.id;
  rcCmSet({ loading: true, key });
  const fresh = () => UI.recruit?.cycleId === key && rcCmState()?.key === key;
  try {
    const [t, log] = await Promise.all([
      RECRUIT.api(`/recruit/cycles/${key}/templates`, { signal: AbortSignal.timeout(RC_CM_TIMEOUT) }),
      RECRUIT.api(`/recruit/cycles/${key}/mail?limit=100`, { signal: AbortSignal.timeout(RC_CM_TIMEOUT) }),
    ]);
    if (!fresh()) return;
    rcCmSet({ key, templates: t.templates || [], fields: t.fields || [], rows: log.rows || [], next: log.next || null, counts: log.counts || {} });
  } catch (e) {
    if (!fresh()) return;
    rcCmSet({ key, error: rcCmMsg(e) });
  }
  renderBackground('recruit');
}

function rcCmRefresh() {
  const cycle = UI.recruit?.cycle?.data;
  if (cycle) rcCmLoad(cycle);
}

async function rcCmLoadMore() {
  const st = rcCmState();
  if (!st?.next || rcCmBusy().has('cm-more')) return;
  const key = st.key;
  rcCmBusy().add('cm-more');
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${key}/mail?limit=100&cursor=${encodeURIComponent(st.next)}`, { signal: AbortSignal.timeout(RC_CM_TIMEOUT) });
    const cur = rcCmState();
    if (cur?.key !== key || cur.loading) return;
    cur.rows = cur.rows.concat(out.rows || []);
    cur.next = out.next || null;
    rcCmPaintLog();
  } catch (e) {
    toast(rcCmMsg(e));
  } finally { rcCmBusy().delete('cm-more'); }
}

/* -------------------------------- views ----------------------------------- */

function rcCmTemplatesHtml(st) {
  return `<div class="sheet sheet--list">${st.templates.map((t) => `<div class="sheet__archive">
      <div><span class="sheet__archivetitle">${MD.esc(rcCmLabel(t.key))}${t.auto ? ' <span class="chip">auto</span>' : ''}</span>
        <span class="sheet__archivemeta">${MD.esc(t.subject)}${t.inherited ? ' · default' : t.by ? ` · ${MD.esc(typeof Store !== 'undefined' && Store.userName ? Store.userName(t.by) : t.by)}${t.updatedAt ? ` · ${MD.esc(recruitDate(t.updatedAt))}` : ''}` : ''}</span></div>
      <button class="btn btn--sm" data-action="recruit-cm-edit" data-key="${MD.esc(t.key)}">Edit…</button>
    </div>`).join('')}</div>`;
}

function rcCmLogRowHtml(m) {
  const retry = m.status === 'failed' ? `<button class="btn btn--sm" data-action="recruit-cm-retry" data-id="${MD.esc(m.id)}">Retry</button>` : '';
  const mark = m.status === 'failed' || m.status === 'queued' || m.status === 'sending' ? `<button class="btn btn--sm btn--ghost" data-action="recruit-cm-mark" data-id="${MD.esc(m.id)}">Mark sent</button>` : '';
  return `<tr data-mail-id="${MD.esc(m.id)}">
    <td><span class="mail">${MD.esc(m.toEmail)}</span></td>
    <td>${MD.esc(rcCmLabel(m.templateKey))}</td>
    <td>${MD.esc(RC_CM_STATUS[m.status] || m.status)}</td>
    <td>${MD.esc(recruitDate(m.sentAt || m.updated || m.created))}</td>
    <td>${MD.esc(m.reason || '')} ${retry}${mark}</td>
  </tr>`;
}

function rcCmFootHtml(st) {
  const c = st.counts || {};
  const summary = ['sent', 'failed', 'queued', 'skipped'].filter((k) => c[k]).map((k) => `${c[k]} ${RC_CM_STATUS[k].toLowerCase()}`).join(' · ');
  return `${summary || '0 sent'}${st.next ? ` · <button class="linklike" data-action="recruit-cm-more">Load more</button>` : ''}`;
}

function rcCmLogHtml(st) {
  return `<div class="sheet">
    <div class="sheet__scroll"><table aria-label="Send log">
      <thead><tr><th>To</th><th>Template</th><th>Status</th><th>When</th><th>Reason</th></tr></thead>
      <tbody data-cm-log>${st.rows.length ? st.rows.map(rcCmLogRowHtml).join('') : `<tr><td colspan="5" class="faint">Nothing sent yet.</td></tr>`}</tbody>
    </table></div>
    <div class="sheet__foot" role="status" data-cm-foot>${rcCmFootHtml(st)}</div>
  </div>`;
}

function rcCmPaintLog() {
  const st = rcCmState();
  const body = $('[data-cm-log]');
  if (!st || !body) return;
  const ref = focusReference(document.activeElement);
  body.innerHTML = st.rows.map(rcCmLogRowHtml).join('');
  const foot = $('[data-cm-foot]');
  if (foot) foot.innerHTML = rcCmFootHtml(st);
  resolveFocus(ref, body.closest('.sheet') || document)?.focus({ preventScroll: true });
}

function rcCmView(cycle, role) {
  const st = rcCmState();
  const head = `<div class="admin-block__head"><h2>Templates</h2><button class="icon-btn" data-action="recruit-cm-refresh" aria-label="Refresh" title="Refresh">${I.history}</button></div>`;
  if (!st || st.loading || st.key !== cycle.id) return `<section class="admin-block">${head}<p class="sheet__note">Loading…</p></section>`;
  if (st.error) return `<section class="admin-block">${head}<p class="sheet__note">Could not load: ${MD.esc(st.error)}. <button class="linklike" data-action="recruit-cm-refresh">Retry</button></p></section>`;
  return `<div class="admin-grid">
    <section class="admin-block">${head}${rcCmTemplatesHtml(st)}</section>
    <section class="admin-block"><div class="admin-block__head"><h2>Send log</h2><span class="count">${st.rows.length}</span>
      <a class="btn btn--sm" href="/api/recruit/cycles/${MD.esc(cycle.id)}/mail.csv" download>Export</a></div>${rcCmLogHtml(st)}</section>
  </div>`;
}

/* -------------------------------- modals ---------------------------------- */

function rcCmFieldChips(fields) {
  return `<div style="display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 12px">${fields.map((f) => `<button type="button" class="kbd" data-action="recruit-cm-field" data-field="${MD.esc(f)}" title="Insert">{{${MD.esc(f)}}}</button>`).join('')}</div>`;
}

function rcCmTemplateModal(m) {
  const st = rcCmState() || {};
  const t = (st.templates || []).find((x) => x.key === m.key) || { key: m.key, subject: '', body: '', auto: false };
  const d = m.draft || (m.draft = { subject: t.subject, body: t.body, auto: t.auto });
  return `<div class="modal modal--wide" role="dialog" aria-label="Edit template">
    <form data-action="recruit-cm-template-form" data-key="${MD.esc(t.key)}">
    <div class="modal__head"><h3>${MD.esc(rcCmLabel(t.key))}</h3><button type="button" class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body">
      <label>Subject<input class="text-input" data-m="recruit-cm-subject" value="${MD.esc(d.subject)}" maxlength="200" spellcheck="true"></label>
      <label>Body<textarea class="text-input" data-m="recruit-cm-body" rows="12" maxlength="8000" spellcheck="true">${MD.esc(d.body)}</textarea></label>
      ${rcCmFieldChips(st.fields || [])}
      <label class="sheet__check" style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-m="recruit-cm-auto" ${d.auto ? 'checked' : ''}> Send automatically at this step</label>
      <p class="field-error" role="alert" data-cm-error hidden></p>
    </div>
    <div class="modal__foot">
      <button type="button" class="btn" data-action="recruit-cm-preview" data-key="${MD.esc(t.key)}">Preview</button>
      <button type="button" class="btn" data-action="recruit-cm-test" data-key="${MD.esc(t.key)}">Send me a test</button>
      <button type="button" class="btn" data-action="modal-close">Cancel</button>
      <button type="submit" class="btn btn--primary">Save</button>
    </div>
    </form>
  </div>`;
}

function rcCmPreviewModal(m) {
  const p = m.preview;
  return `<div class="modal modal--wide" role="dialog" aria-label="Email preview">
    <div class="modal__head"><h3>${MD.esc(p?.subject || 'Preview')}</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body">
      ${p?.warnings?.length ? `<p class="field-error" role="alert">${MD.esc(p.warnings.join(' · '))}</p>` : ''}
      ${p ? `<iframe sandbox="" srcdoc="${MD.esc(p.html)}" title="Email preview" style="width:100%;height:420px;border:1px solid var(--hairline);border-radius:var(--radius);background:#fff"></iframe>` : `<p class="sheet__note">Rendering…</p>`}
    </div>
    <div class="modal__foot"><button class="btn" data-action="recruit-cm-preview-back">Back</button><button class="btn btn--primary" data-action="modal-close">Close</button></div>
  </div>`;
}

function rcCmSendModal(m) {
  const st = rcCmState() || {};
  const ids = m.ids || [];
  const options = [...(st.templates || []).map((t) => ({ value: t.key, label: rcCmLabel(t.key) })), { value: '__custom', label: 'Custom email' }];
  const key = m.templateKey || options[0]?.value || '__custom';
  const custom = key === '__custom';
  const guard = m.guard;
  const guardLine = guard ? (guard.already ? `${guard.will} of ${ids.length} will be sent · ${guard.already} already received “${MD.esc(rcCmLabel(m.templateKey))}”` : `${ids.length} will be sent`) : '';
  const prog = m.progress;
  return `<div class="modal modal--wide" role="dialog" aria-label="Send email">
    <form data-action="recruit-cm-send-form" data-ids="${MD.esc(JSON.stringify(ids))}">
    <div class="modal__head"><h3>Email ${ids.length} ${ids.length === 1 ? 'person' : 'people'}</h3><button type="button" class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body">
      <label>Template${dd('recruit-cm-template', options, key)}</label>
      ${custom ? `<label>Subject<input class="text-input" data-m="recruit-cm-subject" value="${MD.esc(m.draft?.subject || '')}" maxlength="200"></label>
      <label>Body<textarea class="text-input" data-m="recruit-cm-body" rows="8" maxlength="8000">${MD.esc(m.draft?.body || '')}</textarea></label>${rcCmFieldChips(st.fields || [])}` : ''}
      ${!custom && guard?.already ? `<label class="sheet__check" style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-m="recruit-cm-again"> Send again to the ${guard.already} who already received it</label>` : ''}
      <p class="sheet__note" role="status" data-cm-guard>${guardLine}</p>
      ${m.first ? `<details><summary class="linklike">Preview for the first recipient</summary><iframe sandbox="" srcdoc="${MD.esc(m.first.html)}" title="Email preview" style="width:100%;height:320px;border:1px solid var(--hairline);border-radius:var(--radius);background:#fff;margin-top:8px"></iframe></details>` : ''}
      ${prog ? `<p class="sheet__note" role="status" data-cm-progress>${MD.esc(prog)}</p>` : ''}
      <p class="field-error" role="alert" data-cm-error hidden></p>
    </div>
    <div class="modal__foot">
      <button type="button" class="btn" data-action="recruit-cm-send-preview">Preview</button>
      <button type="button" class="btn" data-action="modal-close">Cancel</button>
      <button type="submit" class="btn btn--primary" ${ids.length && !m.sending ? '' : 'disabled'}>${m.sending ? 'Sending…' : 'Send'}</button>
    </div>
    </form>
  </div>`;
}

/* ------------------------------- actions ---------------------------------- */

function rcCmTemplateDraft(form) {
  return { subject: rcCmVal(form, 'recruit-cm-subject').trim(), body: rcCmVal(form, 'recruit-cm-body'), auto: !!$('[data-m="recruit-cm-auto"]', form)?.checked };
}

async function rcCmSaveTemplate(form) {
  const cycleId = UI.recruit?.cycleId, key = form.dataset.key;
  if (!cycleId || !key || rcCmBusy().has('cm-tpl')) return;
  const draft = rcCmTemplateDraft(form);
  if (!draft.subject) { rcCmError(form, 'Give the email a subject'); return; }
  if (!draft.body.trim()) { rcCmError(form, 'Write the email body'); return; }
  const m = UI.modal;
  const version = UI.recruit?.cycle?.data?.version;
  rcCmBusy().add('cm-tpl');
  rcCmError(form, '');
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${cycleId}/templates/${key}`, { method: 'PUT', body: JSON.stringify({ version, ...draft }), signal: AbortSignal.timeout(RC_CM_TIMEOUT) });
    if (UI.recruit?.cycleId === cycleId && UI.recruit.cycle?.data && out.cycle) UI.recruit.cycle.data = out.cycle;
    if (UI.modal !== m) return;
    closeModal(() => { toast('Template saved'); rcCmRefresh(); });
  } catch (e) {
    if (UI.modal === m) rcCmError(form, e.status === 409 ? 'This cycle changed. Reload and try again.' : rcCmMsg(e));
  } finally { rcCmBusy().delete('cm-tpl'); }
}

async function rcCmPreview({ templateKey, template, applicationId, back }) {
  const cycleId = UI.recruit?.cycleId;
  if (!cycleId || rcCmBusy().has('cm-preview')) return;
  const opener = UI.modal;
  rcCmBusy().add('cm-preview');
  try {
    const body = templateKey ? { templateKey } : { template };
    if (applicationId) body.applicationId = applicationId;
    const preview = await RECRUIT.api(`/recruit/cycles/${cycleId}/mail/preview`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(RC_CM_TIMEOUT) });
    if (UI.modal !== opener) return;
    showModal({ kind: 'recruit-mail-preview', preview, back: back || opener });
  } catch (e) {
    if (UI.modal === opener) rcCmError(document, rcCmMsg(e));
  } finally { rcCmBusy().delete('cm-preview'); }
}

async function rcCmTest(form) {
  const cycleId = UI.recruit?.cycleId;
  if (!cycleId || rcCmBusy().has('cm-test')) return;
  const draft = rcCmTemplateDraft(form);
  rcCmBusy().add('cm-test');
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${cycleId}/mail/test`, { method: 'POST', body: JSON.stringify({ template: draft }), signal: AbortSignal.timeout(RC_CM_TIMEOUT) });
    toast(out.sent ? 'Test email sent to you' : `Not sent: ${out.reason || 'unknown reason'}`);
  } catch (e) {
    toast(rcCmMsg(e));
  } finally { rcCmBusy().delete('cm-test'); }
}

// The guard line: how many of the selection would actually receive this
// template, so nobody is surprised by the once-only rule at send time.
async function rcCmGuard(m) {
  const cycleId = UI.recruit?.cycleId;
  if (!cycleId || !m.ids?.length || !m.templateKey || m.templateKey === '__custom') return;
  const key = m.templateKey;
  try {
    m.requestId ||= 'rq-' + crypto.randomUUID();
    const out = await RECRUIT.api(`/recruit/cycles/${cycleId}/mail/send`, { method: 'POST', body: JSON.stringify({ requestId: m.requestId, templateKey: key, ids: m.ids, dryRun: true }), signal: AbortSignal.timeout(RC_CM_TIMEOUT) });
    if (UI.modal !== m || m.templateKey !== key) return;
    m.guard = { will: out.will, already: out.already };
    const line = $('[data-cm-guard]');
    if (line) line.textContent = m.guard.already ? `${m.guard.will} of ${m.ids.length} will be sent · ${m.guard.already} already received “${rcCmLabel(key)}”` : `${m.ids.length} will be sent`;
    if (m.guard.already && !$('[data-m="recruit-cm-again"]')) showModal(m);
  } catch (e) { /* the line stays blank; the server still enforces the rule */ }
}

async function rcCmSend(form) {
  const cycleId = UI.recruit?.cycleId;
  const m = UI.modal;
  if (!cycleId || !m || m.sending) return;
  let ids = [];
  try { ids = JSON.parse(form.dataset.ids || '[]'); } catch (e) { ids = []; }
  if (!ids.length) { rcCmError(form, 'Pick at least one person'); return; }
  const key = rcCmDd(form, 'recruit-cm-template') || m.templateKey;
  m.requestId ||= 'rq-' + crypto.randomUUID();
  const body = { requestId: m.requestId, ids };
  if (key === '__custom') {
    body.custom = { subject: rcCmVal(form, 'recruit-cm-subject').trim(), body: rcCmVal(form, 'recruit-cm-body') };
    if (!body.custom.subject) { rcCmError(form, 'Give the email a subject'); return; }
    if (!body.custom.body.trim()) { rcCmError(form, 'Write the email body'); return; }
  } else {
    body.templateKey = key;
    if ($('[data-m="recruit-cm-again"]', form)?.checked) body.again = true;
  }
  m.sending = true;
  rcCmError(form, '');
  const submit = $('[type="submit"]', form);
  if (submit) { submit.disabled = true; submit.textContent = 'Sending…'; }
  const progress = (text) => { const p = $('[data-cm-progress]'); if (p) p.textContent = text; };
  let sent = 0, failed = 0, skipped = 0;
  try {
    const out = await RECRUIT.api(`/recruit/cycles/${cycleId}/mail/send`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    sent += out.sent || 0; failed += out.failed || 0; skipped += out.skipped?.length || 0;
    let remaining = out.remaining || 0;
    let rounds = 0;
    while (remaining > 0 && rounds < 50 && UI.modal === m) {
      rounds += 1;
      progress(`${sent} sent · ${remaining} to go`);
      const f = await RECRUIT.api(`/recruit/cycles/${cycleId}/mail/flush`, { method: 'POST', body: JSON.stringify({ requestId: 'rq-' + crypto.randomUUID() }), signal: AbortSignal.timeout(60000) });
      sent += f.sent || 0; failed += f.failed || 0; skipped += f.skipped || 0;
      if (f.remaining === remaining && !f.processed) break;
      remaining = f.remaining || 0;
    }
    if (UI.modal !== m) return;
    closeModal(() => {
      toast(`${sent} ${sent === 1 ? 'email' : 'emails'} sent${failed ? ` · ${failed} failed` : ''}${skipped ? ` · ${skipped} skipped` : ''}`);
      if (UI.recruit?.selected?.clear) UI.recruit.selected.clear();
      rcCmRefresh();
    });
  } catch (e) {
    m.sending = false;
    if (UI.modal !== m) return;
    if (submit) { submit.disabled = false; submit.textContent = 'Send'; }
    rcCmError(form, e.name === 'TimeoutError' ? 'The request timed out. Retrying will not send twice.' : rcCmMsg(e));
  }
}

async function rcCmRetry(id) {
  const key = 'cm-retry-' + id;
  if (rcCmBusy().has(key)) return;
  rcCmBusy().add(key);
  try {
    const out = await RECRUIT.api(`/recruit/mail/${id}/retry`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(RC_CM_TIMEOUT) });
    const st = rcCmState();
    if (st?.rows && out.row) { const i = st.rows.findIndex((r) => r.id === id); if (i >= 0) st.rows[i] = out.row; rcCmPaintLog(); }
    toast(out.row?.status === 'sent' ? 'Sent' : `Still failing: ${out.row?.reason || ''}`);
  } catch (e) {
    toast(rcCmMsg(e));
  } finally { rcCmBusy().delete(key); }
}

async function rcCmMark(id) {
  const key = 'cm-mark-' + id;
  if (rcCmBusy().has(key)) return;
  rcCmBusy().add(key);
  try {
    const out = await RECRUIT.api(`/recruit/mail/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'sent' }), signal: AbortSignal.timeout(RC_CM_TIMEOUT) });
    const st = rcCmState();
    if (st?.rows && out.row) { const i = st.rows.findIndex((r) => r.id === id); if (i >= 0) st.rows[i] = out.row; rcCmPaintLog(); }
    toast('Marked sent');
  } catch (e) {
    toast(rcCmMsg(e));
  } finally { rcCmBusy().delete(key); }
}

function rcCmInsertField(el) {
  const form = el.closest('form');
  const ta = $('[data-m="recruit-cm-body"]', form);
  if (!ta) return;
  const token = `{{${el.dataset.field}}}`;
  const start = ta.selectionStart ?? ta.value.length, end = ta.selectionEnd ?? start;
  ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
  ta.focus();
  ta.setSelectionRange?.(start + token.length, start + token.length);
  if (UI.modal?.draft) UI.modal.draft.body = ta.value;
}

/* ------------------------------- settings --------------------------------- */

function rcCmSettingsView(cycle) {
  const replyTo = cycle.doc?.comms?.replyTo || '';
  return `<form data-action="recruit-settings-comms" class="admin-form" data-version="${cycle.version}" style="display:flex;gap:12px;align-items:end;flex-wrap:wrap">
    <label style="flex:1;min-width:240px">Reply-to address<input class="text-input" data-m="recruit-cm-replyto" value="${MD.esc(replyTo)}" placeholder="Leave blank to use the From address" maxlength="200" autocomplete="off" spellcheck="false"></label>
    <button type="submit" class="btn btn--primary">Save</button>
  </form>`;
}

// Called by the core inside runAdminForm; throwing shows the message on the form.
async function rcCmSettingsSubmit(form, cycle) {
  const cycleId = cycle?.id || UI.recruit?.cycleId;
  if (!cycleId) return;
  const templates = (cycle || UI.recruit?.cycle?.data)?.doc?.comms?.templates || {};
  const body = { version: (cycle || UI.recruit?.cycle?.data)?.version, settings: { templates, replyTo: rcCmVal(form, 'recruit-cm-replyto').trim() } };
  const out = await RECRUIT.api(`/recruit/cycles/${cycleId}/settings/comms`, { method: 'PUT', body: JSON.stringify(body), signal: AbortSignal.timeout(RC_CM_TIMEOUT) });
  if (out.cycle) { if (typeof recruitAdoptCycle === 'function') recruitAdoptCycle(out.cycle); else if (UI.recruit?.cycleId === cycleId && UI.recruit.cycle?.data) UI.recruit.cycle.data = out.cycle; }
  form.dataset.adminDirty = 'false';
  toast('Saved');
}

/* ------------------------------- register --------------------------------- */

RECRUIT.register({
  name: 'comms',
  order: 70,
  panel: { id: 'comms', label: 'Emails', when: (cycle, role) => cycle?.doc?.modules?.comms !== false && (role === 'admin' || role === 'lead') },
  view: rcCmView,
  mount(cycle) {
    if (typeof REMOTE === 'undefined' || !cycle) return;
    const st = rcCmState();
    if (st === undefined || (st.key && st.key !== cycle.id)) rcCmLoad(cycle);
  },
  actions: {
    'recruit-cm-refresh': (el, ev, stop) => { stop?.(); rcCmSet(undefined); rcCmRefresh(); },
    'recruit-cm-more': (el, ev, stop) => { stop?.(); return rcCmLoadMore(); },
    'recruit-cm-edit': (el, ev, stop) => { stop?.(); UI.modal = { kind: 'recruit-template', key: el.dataset.key }; render(); },
    'recruit-cm-template-form': (form) => rcCmSaveTemplate(form),
    'recruit-cm-field': (el, ev, stop) => { stop?.(); rcCmInsertField(el); },
    'recruit-cm-preview': (el, ev, stop) => { stop?.(); const form = el.closest('form'); if (UI.modal?.draft) Object.assign(UI.modal.draft, rcCmTemplateDraft(form)); return rcCmPreview({ template: rcCmTemplateDraft(form) }); },
    'recruit-cm-test': (el, ev, stop) => { stop?.(); return rcCmTest(el.closest('form')); },
    'recruit-cm-preview-back': (el, ev, stop) => { stop?.(); const back = UI.modal?.back; UI.modal = back && back.kind ? back : null; render(); },
    'recruit-cm-compose': (el, ev, stop) => { stop?.(); const ids = el.dataset.ids ? JSON.parse(el.dataset.ids) : [...(UI.recruit?.selected || [])]; const m = { kind: 'recruit-send', ids, templateKey: (rcCmState()?.templates || [])[0]?.key || '__custom' }; UI.modal = m; render(); rcCmGuard(m); },
    'recruit-cm-send-form': (form) => rcCmSend(form),
    'recruit-cm-send-preview': (el, ev, stop) => {
      stop?.();
      const form = el.closest('form'), m = UI.modal;
      const key = rcCmDd(form, 'recruit-cm-template') || m?.templateKey;
      const first = m?.ids?.[0];
      if (key === '__custom') { const template = { subject: rcCmVal(form, 'recruit-cm-subject'), body: rcCmVal(form, 'recruit-cm-body') }; if (m) m.draft = template; return rcCmPreview({ template, applicationId: first }); }
      return rcCmPreview({ templateKey: key, applicationId: first });
    },
    'recruit-cm-retry': (el, ev, stop) => { stop?.(); return rcCmRetry(el.dataset.id); },
    'recruit-cm-mark': (el, ev, stop) => { stop?.(); return rcCmMark(el.dataset.id); },
  },
  inputs: {
    'recruit-cm-subject': (el) => { if (UI.modal?.draft) UI.modal.draft.subject = el.value; },
    'recruit-cm-body': (el) => { if (UI.modal?.draft) UI.modal.draft.body = el.value; },
  },
  dd: {
    'recruit-cm-template': (host, value) => {
      if (value === undefined) return;
      const m = UI.modal;
      if (m?.kind !== 'recruit-send') return;
      m.templateKey = value; m.guard = null; m.first = null;
      render();
      rcCmGuard(m);
    },
  },
  modals: {
    'recruit-template': rcCmTemplateModal,
    'recruit-mail-preview': rcCmPreviewModal,
    'recruit-send': rcCmSendModal,
  },
  columns: [],
  filters: [],
  selectionActions: (ids, cycle, role) => (cycle?.doc?.modules?.comms !== false && (role === 'admin' || role === 'lead')
    ? [{ id: 'email', label: 'Email…', action: 'recruit-cm-compose', run: () => { const m = { kind: 'recruit-send', ids: [...ids], templateKey: (rcCmState()?.templates || [])[0]?.key || '__custom' }; UI.modal = m; render(); rcCmGuard(m); } }] : []),
  detailSections: (app, cycle, role) => {
    if (!['admin', 'lead'].includes(role) || !Array.isArray(app.mail)) return [];
    const html = app.mail.length ? `<dl class="interest-detail">${app.mail.map((m) => `<dt>${MD.esc(rcCmLabel(m.templateKey))}</dt><dd>${MD.esc(RC_CM_STATUS[m.status] || m.status)}${m.sentAt ? ` · ${MD.esc(recruitDate(m.sentAt))}` : ''}</dd>`).join('')}</dl>` : `<p class="faint" style="margin:0">No emails sent.</p>`;
    return [{ id: 'mail', title: 'Emails sent', html }];
  },
  settings: { id: 'comms', label: 'Emails', view: rcCmSettingsView, submit: rcCmSettingsSubmit },
  reset() { rcCmSet(undefined); },
});
// recruit:comms:end
