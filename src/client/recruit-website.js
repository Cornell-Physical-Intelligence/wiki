/* ============================================================================
   Applications — website module (client). The Website tab: what /apply shows
   applicants from this cycle, drawn as they see it, beside everything that
   decides it: whether this cycle feeds the website, where each form is (on
   /apply, at its own link only, or off), the order and labels /apply lists
   them by, and the question above them. Every change here saves at once.
   ========================================================================== */

'use strict';

// recruit:website:start

// The cycle's forms: those /apply lists (marked and open, in its order) and
// the rest in the order people meet them.
function recruitWebForms(cycle) {
  const sections = recruitSections(cycle);
  const listed = recruitApplyKeys(cycle).filter((k) => sections[k]?.form && sections[k].open);
  const others = recruitFlow(cycle).keys.filter((k) => sections[k]?.form && !listed.includes(k));
  return { sections, listed, others };
}

// What was typed here and not saved yet: the preview follows it as it is typed.
const recruitWebTyped = () => (recruitState().mod.web ||= { labels: {}, question: undefined, pick: null });
const recruitWebLabel = (cycle, key) => {
  const s = recruitSections(cycle)[key];
  const typed = recruitWebTyped().labels[key];
  return String(typed ?? s?.choiceLabel ?? '').trim() || s?.title || key;
};
const recruitWebQuestion = (cycle) => String(recruitWebTyped().question ?? cycle?.doc?.site?.question ?? '').trim() || RECRUIT_APPLY_QUESTION;

/* ------------------------------- drawing --------------------------------- */

function recruitWebView(cycle) {
  return `<div class="ws" data-rc="web">${recruitWebInnerHtml(cycle)}</div>`;
}

function recruitWebInnerHtml(cycle) {
  return `${recruitWebStatusHtml(cycle)}
    <div class="ws-grid">
      <div class="ws-forms" data-rc="web-forms">${recruitWebFormsHtml(cycle)}</div>
      <div class="ws-preview" data-rc="web-preview">${recruitWebPreviewHtml(cycle)}</div>
    </div>`;
}

// Whether /apply is showing this cycle now, why not, and the one control
// that changes it.
function recruitWebStatusHtml(cycle) {
  const st = recruitState();
  const block = recruitSiteBlock(cycle);
  const lead = recruitCanEdit(cycle);
  const feeds = st.cycles?.intakeCycleId === cycle.id;
  const url = `${RECRUIT_SITE_URL}/apply/`;
  const text = block
    ? `<b>Not live</b><span>${MD.esc(block)}</span>`
    : `<b>Live</b><a href="${MD.esc(url)}" target="_blank" rel="noopener">cornellphysicalintelligence.com/apply</a>`;
  const acts = [];
  if (cycle.status === 'draft' || cycle.status === 'closed') {
    if (lead && recruitStatusChoices(cycle).some((x) => x.status === 'open')) acts.push(`<button type="button" class="btn btn--sm" data-action="recruit-status" data-status="open">Open cycle</button>`);
  } else if (cycle.status === 'open') {
    if (feeds && lead && cycle.closesAt && Date.now() > Number(cycle.closesAt)) acts.push(`<button type="button" class="btn btn--sm" data-action="recruit-settings-open">Change deadline</button>`);
    if (recruitCan('admin')) acts.push(`<label class="fe-switch"><input type="checkbox" data-action="recruit-website-toggle" ${feeds ? 'checked' : ''}><span class="fe-switch__track"></span><span class="fe-switch__text">Feeds /apply</span></label>`);
  }
  return `<section class="ws-status ${block ? '' : 'is-live'}" data-rc="web-status" aria-label="Website status">
    <p class="ws-status__text">${text}</p>${acts.length ? `<div class="ws-status__act">${acts.join('')}</div>` : ''}
  </section>`;
}

function recruitWebFormsHtml(cycle) {
  const { listed, others } = recruitWebForms(cycle);
  const lead = recruitCanEdit(cycle);
  if (!listed.length && !others.length) {
    return `<div class="ws-none"><b>No forms yet</b><p>A stage with a form gets a page on the website. Add one from a stage on the Flow tab.</p><a class="btn btn--sm" href="${recruitPanelHref(cycle.id, 'flow')}">Open the flow</a></div>`;
  }
  const many = listed.length > 1;
  const typedQ = recruitWebTyped().question;
  const question = many
    ? `<label class="ws-question"><span class="ws-question__label">Question above the choices</span><input class="text-input" data-m="recruit-ws-question" value="${MD.esc(typedQ ?? cycle.doc?.site?.question ?? '')}" placeholder="${MD.esc(RECRUIT_APPLY_QUESTION)}" maxlength="120" autocomplete="off" ${lead ? '' : 'disabled'}></label>`
    : '';
  const apply = listed.length
    ? `<ol class="ws-list" data-sortable="apply" aria-label="Forms on /apply">${listed.map((k, i) => recruitWebRowHtml(cycle, k, { i, many, sortable: lead && many })).join('')}</ol>`
    : '<p class="ws-empty">Nothing is on /apply, so it shows the closed page.</p>';
  const rest = others.length
    ? `<h2 class="ws-h">Other forms</h2><ul class="ws-list">${others.map((k) => recruitWebRowHtml(cycle, k)).join('')}</ul>`
    : '';
  return `<h2 class="ws-h">On /apply${listed.length ? ` <span class="count">${listed.length}</span>` : ''}</h2>${question}${apply}${rest}`;
}

// One form: its name (to its editor), its own address, the button /apply
// lists it by when there is a choice, whether it is live, and where it is.
function recruitWebRowHtml(cycle, key, { i = -1, many = false, sortable = false } = {}) {
  const s = recruitSections(cycle)[key];
  const w = recruitWebState(cycle, key);
  const word = recruitWebWord(w);
  const lead = recruitCanEdit(cycle);
  const title = MD.esc(s.title);
  const url = `${RECRUIT_SITE_URL}/apply/${encodeURIComponent(key)}/`;
  const typed = recruitWebTyped().labels[key];
  const grip = sortable ? `<button type="button" class="rc-grip ws-row__grip" data-action="recruit-grip" data-i="${i}" aria-label="Move ${title}: drag, or press the arrow keys" title="Drag to reorder">${RC_ICONS.grip}</button>` : '';
  const label = many ? `<label class="ws-row__label"><span>Button</span><input class="text-input" data-m="recruit-ws-label" data-key="${MD.esc(key)}" value="${MD.esc(typed ?? s.choiceLabel ?? '')}" placeholder="${title}" maxlength="40" autocomplete="off" aria-label="Button for ${title}" ${lead ? '' : 'disabled'}></label>` : '';
  const mode = lead
    ? recruitDd('recruit-web-mode', RECRUIT_WEB_MODES, w.mode, `data-stage="${MD.esc(key)}" aria-label="Where ${title} is"`, { small: true })
    : `<span class="ws-row__mode">${MD.esc(recruitWebModeLabel(w.mode))}</span>`;
  return `<li class="ws-row ${sortable ? 'is-sortable' : ''} ${label ? 'has-label' : ''}" data-key="${MD.esc(key)}" ${i >= 0 ? `data-qid="${MD.esc(key)}" data-i="${i}"` : ''}>
    ${grip}
    <div class="ws-row__main">
      <a class="ws-row__title" href="${recruitStageHref(key, 'form', cycle.id)}">${title}</a>
      <span class="ws-row__link"><a href="${MD.esc(url)}" target="_blank" rel="noopener">/apply/${MD.esc(key)}</a><button type="button" class="icon-btn" data-action="recruit-copy-link" data-link="${MD.esc(url)}" aria-label="Copy the link to ${title}" title="Copy link">${I.copy}</button></span>
    </div>
    ${w.mode === 'off' ? '<span class="rc-web-word"></span>' : `<span class="rc-web-word rc-web-word--${word.tone}" ${word.why ? `title="${MD.esc(word.why)}"` : ''}>${word.text}</span>`}
    ${mode}
    ${label}
  </li>`;
}

// /apply as an applicant sees it: one form alone, a choice between several
// (click one to see its form below), or the closed page. A form that is full
// drops out, as on the site. Before the cycle is live this is what it will show.
function recruitWebPreviewHtml(cycle) {
  const { sections, listed } = recruitWebForms(cycle);
  const shown = listed.filter((k) => !recruitWebState(cycle, k)?.full);
  const live = !recruitSiteBlock(cycle);
  const form = (key, title) => recruitFormPreviewHtml(recruitStageModel(sections[key], key, cycle), true, { title });
  let page;
  if (!shown.length) {
    const crab = typeof CRAB_URI === 'string' ? `<img class="wp-crab" src="${CRAB_URI}" alt="" draggable="false">` : '';
    page = `<div class="wp-closed">${crab}<p>Unfortunately, applications are closed right now.</p></div>`;
  } else if (shown.length === 1) page = form(shown[0], true);
  else {
    const typed = recruitWebTyped();
    const pick = shown.includes(typed.pick) ? typed.pick : null;
    page = `<h2 class="wp-question">${MD.esc(recruitWebQuestion(cycle))}</h2>
      <div class="wp-choices" role="group" aria-label="Forms">${shown.map((k) => `<button type="button" class="wp-choice" data-action="recruit-ws-pick" data-key="${MD.esc(k)}" aria-pressed="${k === pick}">${MD.esc(recruitWebLabel(cycle, k))}</button>`).join('')}</div>
      ${pick ? form(pick, false) : ''}`;
  }
  return `<figure class="wp-frame" aria-label="What applicants see at /apply">
    <figcaption class="wp-bar"><span class="wp-url">cornellphysicalintelligence.com/apply</span><span class="wp-when">${live ? 'Now' : 'Once live'}</span></figcaption>
    <div class="wp-page">${page}</div>
  </figure>`;
}

// Repaints in place: the whole tab, or the preview alone while typing.
function recruitPaintWeb({ preview = false } = {}) {
  const cycle = recruitCycleRow();
  const host = $(preview ? '[data-rc="web-preview"]' : '[data-rc="web"]');
  if (!host || !cycle) return false;
  recruitRepaint(host, preview ? recruitWebPreviewHtml(cycle) : recruitWebInnerHtml(cycle));
  return true;
}

// After a form moves on or off the website, every place that shows it follows.
function recruitWebFollow(key) {
  recruitPaintWeb();
  if (typeof recruitPaintFlow === 'function') recruitPaintFlow();
  const head = $('[data-rc="stage-head"]');
  const cycle = recruitCycleRow();
  if (head && cycle && $('[data-rc="stage"]')?.dataset.stage === key) recruitRepaint(head, recruitStageHeadHtml(cycle, key));
}

/* ------------------------------- saving ---------------------------------- */

// One menu sets where a form is: open and listed at /apply, open at its own
// link only, or off. Off keeps its place in the /apply list for when it returns.
async function recruitSetWebMode(key, mode) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  if (!cycle || !recruitCanEdit(cycle) || !RECRUIT_WEB_MODES.some((x) => x.value === mode) || st.busy.has('web:' + key)) return;
  const was = recruitWebState(cycle, key);
  if (!was || was.mode === mode) return;
  const keys = recruitApplyKeys(cycle);
  const landing = mode === 'apply' ? (keys.includes(key) ? keys : [...keys, key]) : mode === 'link' ? keys.filter((k) => k !== key) : keys;
  st.busy.add('web:' + key);
  try {
    await recruitPutSite({ sections: { [key]: { open: mode !== 'off' } }, ...(landing !== keys ? { landing } : {}) });
    const title = recruitSectionTitle(key);
    toast(mode === 'apply' ? `${title} is on /apply` : mode === 'link' ? `${title} is open at its link only` : `${title} is off the website`);
  } catch (e) { recruitVersionToast(e, cycle.id); }
  finally { st.busy.delete('web:' + key); recruitWebFollow(key); }
}

// A label or the question saves when the field is left.
async function recruitWebSaveText(el) {
  const cycle = recruitCycleRow();
  const typed = recruitWebTyped();
  if (!cycle || !recruitCanEdit(cycle)) return;
  const question = el.dataset.m === 'recruit-ws-question';
  const key = el.dataset.key;
  const value = String(el.value || '').trim().slice(0, question ? 120 : 40);
  const saved = question ? String(cycle.doc?.site?.question || '') : String(recruitSections(cycle)[key]?.choiceLabel || '');
  const forget = () => { if (question) typed.question = undefined; else delete typed.labels[key]; };
  if (value === saved) { forget(); recruitPaintWeb({ preview: true }); return; }
  try {
    await recruitPutSite(question ? { sections: {}, question: value } : { sections: { [key]: { choiceLabel: value } } });
    forget();
    toast(question ? 'Question saved' : `${recruitSectionTitle(key)}'s button saved`);
  } catch (e) { recruitVersionToast(e, cycle.id); }
  recruitPaintWeb();
}

// Dragging a form by its grip, or the arrow keys on the grip, reorders /apply.
// The list moves at once and goes back if the save fails.
RECRUIT_SORTERS.apply = () => {
  const cycle = recruitCycleRow();
  if (!cycle || !recruitCanEdit(cycle)) return null;
  const { listed } = recruitWebForms(cycle);
  return {
    items: listed,
    moved: async (from, to, before) => {
      const st = recruitState();
      const order = [...listed];
      const [moved] = order.splice(from, 1);
      order.splice(to, 0, moved);
      const landing = [...order, ...recruitApplyKeys(cycle).filter((k) => !order.includes(k))];
      const row = st.cycle.data;
      st.cycle.data = { ...row, doc: { ...row.doc, site: { ...row.doc?.site, landing } } };
      const paint = () => {
        const list = $('[data-sortable="apply"]');
        const was = before || recruitCardTops(list);
        recruitPaintWeb();
        recruitFlip($('[data-sortable="apply"]'), was);
      };
      paint();
      $(`[data-sortable="apply"] [data-qid="${moved}"] .rc-grip`)?.focus({ preventScroll: true });
      try {
        await recruitPutSite({ sections: {}, landing });
        toast('Order saved');
      } catch (e) {
        if (st.cycle?.data?.id === row.id && st.cycle.data.version === row.version) st.cycle.data = row;
        recruitVersionToast(e, cycle.id);
        recruitPaintWeb();
      }
    },
  };
};

/* ------------------------------- register -------------------------------- */

RECRUIT.register({
  name: 'website',
  order: 7,
  kernel: true,
  panels: [{ id: 'website', label: 'Website', icon: RC_ICONS.globe, order: 1.5, when: () => true }],
  view: (cycle) => recruitWebView(cycle),
  mount(cycle) {
    const st = recruitState();
    // Whether a capped form is full comes with the counts.
    if (!st.insights || st.insights.key !== st.key + ':' + cycle.id) recruitLoadInsights();
  },
  dirty: () => { const t = recruitState().mod.web; return Boolean(t && (t.question !== undefined || Object.keys(t.labels || {}).length)); },
  insightsChanged: () => { if (!$('[data-rc="web"]')?.contains(document.activeElement)) recruitPaintWeb(); },
  actions: {
    'recruit-ws-pick': (el) => { const t = recruitWebTyped(); t.pick = t.pick === el.dataset.key ? null : el.dataset.key; recruitPaintWeb({ preview: true }); },
  },
  inputs: {
    'recruit-ws-label': (el) => { recruitWebTyped().labels[el.dataset.key] = el.value; recruitPaintWeb({ preview: true }); },
    'recruit-ws-question': (el) => { recruitWebTyped().question = el.value; recruitPaintWeb({ preview: true }); },
  },
  changes: {
    'recruit-ws-label': (el) => recruitWebSaveText(el),
    'recruit-ws-question': (el) => recruitWebSaveText(el),
  },
  dd: {
    'recruit-web-mode': (host, value) => { if (value !== undefined) recruitSetWebMode(host.dataset.stage, value); },
  },
  reset() {},
});

// recruit:website:end
