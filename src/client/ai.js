/* Owner-managed inference. Credentials never enter Store or browser storage. */
// Official OpenAI Blossom: https://cdn.openai.com/brand/OpenAI-Logos-2025.zip
const OPENAI_MARK = `<svg viewBox="0 0 721 721" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M304.246 294.611V249.028C304.246 245.189 305.687 242.309 309.044 240.392L400.692 187.612C413.167 180.415 428.042 177.058 443.394 177.058C500.971 177.058 537.44 221.682 537.44 269.182C537.44 272.54 537.44 276.379 536.959 280.218L441.954 224.558C436.197 221.201 430.437 221.201 424.68 224.558L304.246 294.611ZM518.245 472.145V363.224C518.245 356.505 515.364 351.707 509.608 348.349L389.174 278.296L428.519 255.743C431.877 253.826 434.757 253.826 438.115 255.743L529.762 308.523C556.154 323.879 573.905 356.505 573.905 388.171C573.905 424.636 552.315 458.225 518.245 472.141V472.145ZM275.937 376.182L236.592 353.152C233.235 351.235 231.794 348.354 231.794 344.515V238.956C231.794 187.617 271.139 148.749 324.4 148.749C344.555 148.749 363.264 155.468 379.102 167.463L284.578 222.164C278.822 225.521 275.942 230.319 275.942 237.039V376.186L275.937 376.182ZM360.626 425.122L304.246 393.455V326.283L360.626 294.616L417.002 326.283V393.455L360.626 425.122ZM396.852 570.989C376.698 570.989 357.989 564.27 342.151 552.276L436.674 497.574C442.431 494.217 445.311 489.419 445.311 482.699V343.552L485.138 366.582C488.495 368.499 489.936 371.379 489.936 375.219V480.778C489.936 532.117 450.109 570.985 396.852 570.985V570.989ZM283.134 463.99L191.486 411.211C165.094 395.854 147.343 363.229 147.343 331.562C147.343 294.616 169.415 261.509 203.48 247.593V356.991C203.48 363.71 206.361 368.508 212.117 371.866L332.074 441.437L292.729 463.99C289.372 465.907 286.491 465.907 283.134 463.99ZM277.859 542.68C223.639 542.68 183.813 501.895 183.813 451.514C183.813 447.675 184.294 443.836 184.771 439.997L279.295 494.698C285.051 498.056 290.812 498.056 296.568 494.698L417.002 425.127V470.71C417.002 474.549 415.562 477.429 412.204 479.346L320.557 532.126C308.081 539.323 293.206 542.68 277.854 542.68H277.859ZM396.852 599.776C454.911 599.776 503.37 558.513 514.41 503.812C568.149 489.896 602.696 439.515 602.696 388.176C602.696 354.587 588.303 321.962 562.392 298.45C564.791 288.373 566.231 278.296 566.231 268.224C566.231 199.611 510.571 148.267 446.274 148.267C433.322 148.267 420.846 150.184 408.37 154.505C386.775 133.392 357.026 119.958 324.4 119.958C266.342 119.958 217.883 161.22 206.843 215.921C153.104 229.837 118.557 280.218 118.557 331.557C118.557 365.146 132.95 397.771 158.861 421.283C156.462 431.36 155.022 441.437 155.022 451.51C155.022 520.123 210.682 571.466 274.978 571.466C287.931 571.466 300.407 569.549 312.883 565.228C334.473 586.341 364.222 599.776 396.852 599.776Z"/></svg>`;

function aiEffortOptions(model) {
  const labels = { none: 'None · fastest', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' };
  return (AI_MODELS.find((m) => m.id === model) || AI_MODELS[0]).efforts.map((value) => ({ value, label: labels[value] }));
}

function aiMoney(micros) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(micros / 1e6);
}

function viewAiUsage() {
  const usage = UI.aiUsage;
  if (!usage) return `<span class="ai-usage__note">${UI.aiUsageError ? MD.esc(UI.aiUsageError) : 'Usage unavailable'}</span>`;
  const meter = (label, period, cap) => {
    const held = period.reservedMicros + period.uncertainMicros, total = period.costMicros + held;
    return `<div class="ai-usage__period"><span>${label}</span><span class="ai-usage__amount">${aiMoney(total)} <small>/ ${aiMoney(cap)}</small></span>
      <div class="ai-usage__track" role="meter" aria-label="${label} AI spend" aria-valuemin="0" aria-valuemax="${cap / 1e6}" aria-valuenow="${Math.min(total, cap) / 1e6}" aria-valuetext="${aiMoney(total)} of ${aiMoney(cap)}"><span style="width:${Math.min(100, total / cap * 100)}%"></span></div>
      <span class="ai-usage__note">${period.requests.toLocaleString()} ${period.requests === 1 ? 'request' : 'requests'}${held ? ` · ${aiMoney(held)} held` : ''}</span></div>`;
  };
  return `<div class="ai-usage__meters">${meter('This month', usage.current, usage.limits.monthMicros)}${meter('Today', usage.today, usage.limits.dayMicros)}</div>
    ${usage.paused ? `<p class="ai-usage__notice" role="status">${usage.halted ? 'AI paused: provider usage needs review.' : 'AI paused at the spending limit.'} Editing and saving remain available.</p>` : ''}
    <div class="ai-usage__note">Tracked since ${new Date(usage.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })} · OpenAI only · UTC</div>
    <div class="ai-usage__note">5¢ maximum per request · 3 requests at once · 30 per minute</div>
    ${(usage.current.reservedMicros + usage.current.uncertainMicros) ? '<div class="ai-usage__note">Held amounts cover pending requests or unconfirmed charges and count toward the limits.</div>' : ''}
    ${UI.aiUsageError ? `<div class="field-error" role="alert">${MD.esc(UI.aiUsageError)}</div>` : ''}`;
}

let aiUsageTimer = null;
function syncAiUsage() {
  clearTimeout(aiUsageTimer); aiUsageTimer = null;
  if (typeof REMOTE === 'undefined' || UI.route?.name !== 'admin' || UI.editor || document.hidden || !Store.isAdmin()) return;
  if (!UI.aiUsageLoading && (!UI.aiUsageCheckedAt || Date.now() - UI.aiUsageCheckedAt >= 20000)) loadAiUsage();
  aiUsageTimer = setTimeout(syncAiUsage, 20000);
}

async function loadAiUsage() {
  if (typeof REMOTE === 'undefined' || UI.aiUsageLoading || UI.route?.name !== 'admin' || !Store.isAdmin()) return;
  UI.aiUsageLoading = true;
  const refresh = $('[data-action="ai-usage-refresh"]');
  const restoreFocus = refresh && document.activeElement === refresh;
  if (refresh) refresh.disabled = true;
  try {
    const out = await api('/ai/usage', { signal: AbortSignal.timeout(8000) });
    UI.aiUsage = out.usage;
    UI.aiUsageError = '';
  } catch { UI.aiUsageError = 'Usage could not refresh. New AI calls stop if spending protection is unavailable.'; }
  finally {
    UI.aiUsageLoading = false; UI.aiUsageCheckedAt = Date.now();
    if (UI.route?.name === 'admin' && !UI.editor && Store.isAdmin()) {
      const host = $('[data-ai-usage]');
      if (host) host.innerHTML = viewAiUsage();
      const button = $('[data-action="ai-usage-refresh"]');
      if (button) {
        button.disabled = false;
        if (restoreFocus && button === refresh && document.activeElement === document.body && !UI.modal)
          button.focus({ preventScroll: true });
      }
    }
  }
}

function viewAiSettings() {
  const settings = Store.s.settings?.ai || AI_DEFAULTS;
  const draft = UI.aiDraft || settings;
  const model = AI_MODELS.find((m) => m.id === draft.model) || AI_MODELS[0];
  const savedModel = AI_MODELS.find((m) => m.id === settings.model) || AI_MODELS[0];
  const effortLabels = { none: 'Fastest', low: 'Low effort', medium: 'Medium effort', high: 'High effort', xhigh: 'Extra-high effort', max: 'Maximum effort' };
  const busy = UI.aiBusy ? ' disabled' : '';
  return `<section class="admin-block ai-integration" aria-busy="${Boolean(UI.aiBusy)}">
    <div class="admin-block__head"><h2>AI</h2></div>
    <div class="integration-card">
    <div class="integration">
      <span class="integration__tile ai-integration__tile${settings.connected ? '' : ' integration__tile--off'}" aria-hidden="true">${OPENAI_MARK}</span>
      <span class="integration__meta">
        <span class="integration__name">OpenAI <span class="integration__status ${settings.connected ? 'integration__status--on' : 'integration__status--off'}">${settings.connected ? 'Connected' : 'Not connected'}</span></span>
        ${settings.connected ? `<span class="integration__sub">${MD.esc(savedModel.label)} · ${MD.esc(effortLabels[settings.effort] || 'Fastest')} <button class="linklike" data-action="ai-configure" aria-expanded="${Boolean(UI.aiEdit)}" aria-controls="ai-configuration"${busy}>change</button></span>` : ''}
      </span>
      <span class="integration__actions">
        ${settings.connected ? `${UI.aiEdit ? '' : `<button class="btn btn--sm" data-action="ai-test"${busy}>Test connection</button>`}<button class="btn btn--sm" data-action="ai-disconnect"${busy}>Disconnect</button>`
          : `<button class="btn btn--sm btn--primary" data-action="ai-configure" aria-expanded="${Boolean(UI.aiEdit)}" aria-controls="ai-configuration"${busy}>Connect</button>`}
      </span>
    </div>
    <div class="ai-usage">
      <div class="ai-usage__head"><span>Estimated API spend</span><button class="linklike" data-action="ai-usage-refresh"${UI.aiUsageLoading ? ' disabled' : ''}>Refresh</button></div>
      <div data-ai-usage>${viewAiUsage()}</div>
    </div>
    <p class="field-error" data-ai-connection-error role="alert" ${UI.aiConnectionError ? '' : 'hidden'}>${MD.esc(UI.aiConnectionError || '')}</p>
    ${UI.aiEdit ? `<form class="ai-settings integration__editor integration-card__editor" id="ai-configuration" data-action="ai-settings-form">
      <fieldset class="ai-settings__fields"${busy}>
      <label class="ai-settings__key">OpenAI API key
        <input class="text-input" type="password" name="key" autocomplete="new-password" spellcheck="false" autocapitalize="none" placeholder="${settings.keySet ? 'Saved key ending in ' + MD.esc(settings.keyTail) + ' · enter to replace' : settings.source === 'environment' ? 'Server key available · enter to replace' : 'sk-…'}">
      </label>
      <div class="ai-settings__choices">
        <div class="ai-settings__field"><span id="ai-model-label">Model</span>${dd('ai-model', AI_MODELS.map((m) => ({ value: m.id, label: m.label + (m.id === AI_DEFAULTS.model ? ' · fastest' : '') })), model.id)}</div>
        <div class="ai-settings__field"><span id="ai-effort-label">Reasoning effort</span>${dd('ai-effort', aiEffortOptions(model.id), draft.effort)}</div>
      </div>
      <p class="field-error" data-ai-error role="alert" hidden></p>
      <div class="ai-settings__actions">
        <button class="btn btn--primary" type="submit">Save</button>
        <button class="btn" type="button" data-action="ai-cancel">Cancel</button>
        <button class="btn" type="button" data-action="ai-test">Test connection</button>
      </div>
      </fieldset>
    </form>` : ''}
    </div>
  </section>`;
}

function setAiConfiguration(open) {
  if (UI.aiBusy) return;
  const form = $('.ai-settings');
  if (open && UI.aiEdit && form) { form.elements.key.focus(); return; }
  if (form) { form.elements.key.value = ''; form.dataset.adminDirty = 'false'; }
  UI.aiConnectionError = '';
  UI.aiEdit = open;
  const settings = Store.s.settings?.ai || AI_DEFAULTS;
  UI.aiDraft = open ? { model: settings.model || AI_DEFAULTS.model, effort: settings.effort || AI_DEFAULTS.effort } : null;
  render();
  if (open) $('.ai-settings [name="key"]')?.focus();
  else $('.ai-integration [data-action="ai-configure"]')?.focus();
}

async function changeAiSettings(form, action = 'save') {
  if ((!form && action === 'save') || UI.aiBusy) return;
  if (typeof REMOTE === 'undefined') { toast('Configure AI on the live wiki.'); return; }
  const settings = Store.s.settings?.ai || AI_DEFAULTS;
  const origin = form || $('.ai-integration');
  if (!origin) return;
  const body = action === 'disconnect' ? { disconnect: true } : {
    model: form ? $('[data-m="ai-model"]', form).dataset.value : settings.model || AI_DEFAULTS.model,
    effort: form ? $('[data-m="ai-effort"]', form).dataset.value : settings.effort || AI_DEFAULTS.effort,
    key: form ? form.elements.key.value.trim() : '',
  };
  UI.aiBusy = true;
  UI.aiConnectionError = '';
  if (form) form.dataset.adminPending = 'true';
  const section = $('.ai-integration');
  const active = document.activeElement;
  section?.setAttribute('aria-busy', 'true');
  const controls = $$('button, input, fieldset', section || origin), error = $(form ? '[data-ai-error]' : '[data-ai-connection-error]', origin);
  controls.forEach((el) => { el.disabled = true; });
  if (error) error.hidden = true;
  try {
    const out = await api(action === 'test' ? '/ai/test' : '/ai/settings', {
      method: action === 'test' ? 'POST' : 'PUT', body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    if (action !== 'test') {
      const editorForm = form || $('.ai-settings');
      if (editorForm) {
        editorForm.elements.key.value = '';
        editorForm.dataset.adminDirty = 'false';
        editorForm.dataset.adminPending = 'false';
      }
      Store.s.settings ||= {};
      Store.s.settings.ai = out.settings;
      UI.aiDraft = null;
      UI.aiEdit = false;
      UI.aiBusy = false;
      // The owner may have moved to an editor while the request was pending.
      // Never let this completion remount that unrelated, possibly dirty view.
      if (UI.route?.name === 'admin' && !UI.editor && !UI.modal) {
        const returnFocus = origin.isConnected && (document.activeElement === document.body || section?.contains(document.activeElement));
        const current = $('.ai-integration');
        if (current) current.outerHTML = viewAiSettings();
        if (returnFocus) $('.ai-integration [data-action="ai-configure"]')?.focus({ preventScroll: true });
      }
    }
    if (UI.route?.name === 'admin' && Store.isAdmin()) loadAiUsage();
    toast(action === 'test' ? 'Connection verified' : action === 'disconnect' ? 'AI disconnected' : 'AI settings saved');
  } catch (e) {
    if (form) form.dataset.adminDirty = 'true';
    const message = e.name === 'TimeoutError' ? 'The request timed out. Try again.' : e.status === 401 ? 'Your session expired. Sign in again.' : e.message || 'Unable to update AI settings.';
    if (form && error) { error.textContent = message; error.hidden = false; }
    else {
      UI.aiConnectionError = message;
      const current = $('.ai-integration [data-ai-connection-error]');
      if (current) { current.textContent = message; current.hidden = false; }
    }
    if (!origin.isConnected) toast(message);
  } finally {
    UI.aiBusy = false;
    if (form) form.dataset.adminPending = 'false';
    $('.ai-integration')?.setAttribute('aria-busy', 'false');
    controls.forEach((el) => { el.disabled = false; });
    $$('.ai-integration [data-action^="ai-"], .ai-settings__fields').forEach((el) => { el.disabled = false; });
    if (origin.isConnected && active?.isConnected && !UI.modal && document.activeElement === document.body) active.focus({ preventScroll: true });
  }
}
