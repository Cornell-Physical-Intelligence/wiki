/* ============================================================================
   Applications — flow module (client). The cycle's flow chart: every stage a
   card in columns by how people move through them, connections drawn between
   them, and the people at each stage counted on its card. Leads add stages,
   connect them (drag from a card's port, or its menu), reorder and remove
   them; every change saves at once. A card opens its stage's page.
   ========================================================================== */

'use strict';

// recruit:flow:start

// Card size and spacing, in CSS pixels. Fixed, so layout needs no measuring.
const FC = { W: 216, H: 132, GX: 50, GY: 20, VGY: 56, VGX: 16, PAD: 20, OUT_W: 164, OUT_H: 146 };
const FC_OUTCOME = '__outcome';

// Everything the chart shows about a stage: kind, form, and its counts.
function recruitFlowStats(key) {
  const ins = recruitState().insights?.data;
  return ins?.stages?.find((s) => s.key === key) || null;
}

// Positions for every stage: columns by rank (rows when the chart runs down
// a phone), each column ordered so connections cross as little as a single
// pass over the columns manages, then centred.
function recruitFlowLayout(flow, { vertical = false, outcome = true } = {}) {
  const cols = [];
  for (const k of flow.keys) (cols[flow.ranks.get(k)] ||= []).push(k);
  const columns = cols.filter(Boolean);
  const centre = new Map();
  const along = vertical ? FC.W + FC.VGX : FC.H + FC.GY;
  columns.forEach((col, c) => {
    if (c > 0) {
      const bary = (k) => { const ins = flow.into.get(k).filter((p) => centre.has(p)); return ins.length ? ins.reduce((a, p) => a + centre.get(p), 0) / ins.length : Infinity; };
      col.sort((a, b) => bary(a) - bary(b) || flow.order.indexOf(a) - flow.order.indexOf(b));
    }
    col.forEach((k, i) => centre.set(k, i - (col.length - 1) / 2));
  });
  if (outcome && flow.keys.length) columns.push([FC_OUTCOME]);
  const span = Math.max(...columns.map((col) => col.length), 1);
  const cross = span * along - (vertical ? FC.VGX : FC.GY);
  const nodes = new Map();
  columns.forEach((col, c) => {
    const size = col.length * along - (vertical ? FC.VGX : FC.GY);
    col.forEach((k, i) => {
      const out = k === FC_OUTCOME;
      const h = out ? FC.OUT_H : FC.H, w = out ? FC.OUT_W : FC.W;
      const offset = (cross - size) / 2 + i * along;
      nodes.set(k, vertical
        ? { key: k, x: FC.PAD + offset + (FC.W - w) / 2, y: FC.PAD + c * (FC.H + FC.VGY), w, h }
        : { key: k, x: FC.PAD + c * (FC.W + FC.GX), y: FC.PAD + offset + (FC.H - h) / 2, w, h });
    });
  });
  const edges = [];
  for (const [from, to] of flow.edges) for (const k of to) edges.push({ from, to: k, ...recruitEdgePath(nodes.get(from), nodes.get(k), vertical) });
  if (outcome) for (const k of flow.keys) if (!flow.edges.get(k).length) edges.push({ from: k, to: FC_OUTCOME, outcome: true, ...recruitEdgePath(nodes.get(k), nodes.get(FC_OUTCOME), vertical) });
  const outW = outcome && flow.keys.length ? FC.W - FC.OUT_W : 0;
  const width = vertical ? FC.PAD * 2 + cross : FC.PAD * 2 + columns.length * (FC.W + FC.GX) - FC.GX - outW;
  const height = vertical ? FC.PAD * 2 + columns.length * (FC.H + FC.VGY) - FC.VGY + (FC.OUT_H - FC.H) : FC.PAD * 2 + cross + Math.max(0, FC.OUT_H - FC.H);
  return { nodes, edges, width, height, vertical };
}

// A connection leaves a card's right edge (its bottom, running down) and
// enters the next card's left edge (its top) on a smooth curve.
function recruitEdgePath(a, b, vertical) {
  if (!a || !b) return { d: '', mx: 0, my: 0 };
  if (vertical) {
    const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y;
    const dy = Math.max(24, (y2 - y1) / 2);
    return { d: `M${x1} ${y1} C${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
  }
  const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
  const dx = Math.max(28, (x2 - x1) / 2);
  return { d: `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
}

const recruitFlowVertical = () => typeof window !== 'undefined' && Number(window.innerWidth) > 0 && window.innerWidth < 760;

/* ------------------------------- drawing --------------------------------- */

function recruitFlowNodeHtml(cycle, flow, n) {
  const key = n.key;
  const s = flow.sections[key];
  const stats = recruitFlowStats(key);
  const lead = recruitCanEdit(cycle);
  const loading = !recruitState().insights?.data;
  const num = (v) => (loading ? '–' : recruitNum(v));
  const landing = recruitLandingKey(cycle) === key;
  const site = s.form ? `<span class="fc-web ${s.open ? 'is-open' : ''}" title="${s.open ? 'Open on the website' : 'Closed on the website'}">${RC_ICONS.globe}${s.open ? (landing ? 'Open · /apply' : 'Open') : 'Closed'}</span>` : '';
  const doneField = (s.fields || []).find((f) => f.key === s.done);
  const reached = Number(stats?.reached || 0), done = Number(stats?.done || 0);
  const pct = reached ? Math.round((done / reached) * 100) : 0;
  const progress = doneField
    ? `<span class="fc-node__done"><span class="fc-node__donetext"><b>${num(done)}</b>/${num(reached)} ${MD.esc(doneField.label.toLowerCase())}</span><span class="fc-meter" aria-hidden="true"><span style="width:${pct}%"></span></span></span>`
    : s.form ? `<span class="fc-node__done"><span class="fc-node__donetext"><b>${num(stats?.responses)}</b> ${stats?.responses === 1 ? 'response' : 'responses'}</span></span>`
    : `<span class="fc-node__done"><span class="fc-node__donetext"><b>${num(done)}</b> moved on</span></span>`;
  const label = `${s.title}, ${recruitKindLabel(s.kind)}${loading ? '' : `: ${recruitPlural(stats?.here || 0, 'person', 'people')} here, ${recruitNum(reached)} reached${doneField ? `, ${recruitNum(done)} ${doneField.label.toLowerCase()}` : ''}`}`;
  return `<div class="fc-node fc-node--${MD.esc(s.kind)}" data-key="${MD.esc(key)}" style="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px">
    <a class="fc-node__main" href="${recruitStageHref(key)}" data-key="${MD.esc(key)}" aria-label="${MD.esc(label)}">
      <span class="fc-node__top"><span class="fc-kind">${recruitKindIcon(s.kind)}${MD.esc(recruitKindLabel(s.kind))}</span>${site}</span>
      <span class="fc-node__title">${MD.esc(s.title)}</span>
      <span class="fc-node__stats"><span><b>${num(stats?.here)}</b> here</span><span><b>${num(reached)}</b> reached</span>${(s.fields || []).length ? `<span class="fc-node__fields" title="${MD.esc(recruitPlural(s.fields.length, 'checklist field'))}">${RC_ICONS.check}${s.fields.length}</span>` : ''}</span>
      ${progress}
    </a>
    ${lead ? `<button type="button" class="icon-btn fc-node__more" data-action="recruit-flow-menu" data-key="${MD.esc(key)}" aria-label="Options for ${MD.esc(s.title)}" aria-haspopup="menu" title="Options">${I.dots}</button>
    <button type="button" class="fc-port" data-action="recruit-flow-port" data-key="${MD.esc(key)}" aria-label="Connect ${MD.esc(s.title)} to another stage" title="Drag to a stage to connect" aria-haspopup="menu">${I.plus}</button>` : ''}
  </div>`;
}

function recruitFlowOutcomeHtml(n) {
  const ins = recruitState().insights?.data;
  const rows = [['accepted', 'Accepted'], ['waitlisted', 'Waitlisted'], ['declined', 'Declined'], ['withdrew', 'Withdrew']];
  return `<div class="fc-node fc-node--outcome" style="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px" role="group" aria-label="Outcomes">
    <span class="fc-node__top"><span class="fc-kind">${RC_ICONS.check}Outcome</span></span>
    <ul class="fc-outcome">${rows.map(([k, label]) => `<li><a href="${recruitPanelHref(recruitCycleRow().id, 'people', { status: k })}"><span class="rc-status-dot rc-status-dot--${k}"></span>${label}<b>${ins ? recruitNum(ins.statuses?.[k]) : '–'}</b></a></li>`).join('')}</ul>
  </div>`;
}

function recruitFlowCanvasHtml(cycle) {
  const flow = recruitFlow(cycle);
  if (!flow.keys.length) return `<div class="rc-empty-card"><b>No stages yet</b>${recruitCanEdit(cycle) ? '<p>Add the first stage: a form on the website, a meeting, a review, or any step the team tracks.</p><button class="btn btn--primary" data-action="recruit-stage-new">Add a stage</button>' : ''}</div>`;
  const layout = recruitFlowLayout(flow, { vertical: recruitFlowVertical() });
  const lead = recruitCanEdit(cycle);
  const edges = layout.edges.map((e) => `<path class="fc-edge ${e.outcome ? 'fc-edge--outcome' : ''}" data-from="${MD.esc(e.from)}" data-to="${MD.esc(e.to)}" d="${e.d}" marker-end="url(#fc-arrow${e.outcome ? '-soft' : ''})"/>`).join('');
  const cuts = lead ? layout.edges.filter((e) => !e.outcome).map((e) => `<button type="button" class="fc-cut" data-action="recruit-flow-unlink" data-from="${MD.esc(e.from)}" data-to="${MD.esc(e.to)}" style="left:${e.mx}px;top:${e.my}px" aria-label="Remove the connection from ${MD.esc(recruitSectionTitle(e.from, cycle))} to ${MD.esc(recruitSectionTitle(e.to, cycle))}" title="Remove connection">${I.x}</button>`).join('') : '';
  const nodes = [...layout.nodes.values()].map((n) => (n.key === FC_OUTCOME ? recruitFlowOutcomeHtml(n) : recruitFlowNodeHtml(cycle, flow, n))).join('');
  return `<div class="fc-scroll" data-rc="flow-scroll"><div class="fc-canvas ${layout.vertical ? 'fc-canvas--down' : ''}" data-rc="flow-canvas" style="width:${layout.width}px;height:${layout.height}px">
    <svg class="fc-edges" width="${layout.width}" height="${layout.height}" aria-hidden="true">
      <defs><marker id="fc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1L9 5L0 9z"/></marker>
      <marker id="fc-arrow-soft" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1L9 5L0 9z"/></marker></defs>
      ${edges}<path class="fc-edge fc-edge--draft" data-rc="flow-draft" d=""/>
    </svg>${nodes}${cuts}
  </div></div>`;
}

// The numbers above the chart: everyone, where they stand, how it ended.
function recruitFlowSummaryHtml() {
  const ins = recruitState().insights;
  const d = ins?.data;
  if (!d) return `<div class="fc-summary" data-rc="flow-summary"><span class="fc-summary__item">${ins?.error ? `Could not load counts: ${MD.esc(ins.error)} <button class="linklike" data-action="recruit-insights-retry">Retry</button>` : 'Loading counts…'}</span></div>`;
  const item = (n, label, href) => `<a class="fc-summary__item" href="${href}"><b>${recruitNum(n)}</b>${label}</a>`;
  const id = recruitCycleRow().id;
  return `<div class="fc-summary" data-rc="flow-summary">
    ${item(d.people, d.people === 1 ? 'person' : 'people', recruitPanelHref(id, 'people'))}
    ${item(d.statuses.active, 'active', recruitPanelHref(id, 'people', { status: 'active' }))}
    ${item(d.statuses.accepted, 'accepted', recruitPanelHref(id, 'people', { status: 'accepted' }))}
    ${d.flagged ? item(d.flagged, 'flagged', recruitPanelHref(id, 'people', { review: 'flagged' })) : ''}
  </div>`;
}

function recruitFlowView(cycle) {
  const st = recruitState();
  const lead = recruitCanEdit(cycle);
  const held = st.cycles?.intakeCycleId === cycle.id && recruitIsAdmin() ? `<div data-rc="queue">${recruitPendingHtml()}</div>` : '';
  return `<div class="fc-bar">${recruitFlowSummaryHtml()}${lead ? `<button class="btn btn--primary" data-action="recruit-stage-new">${I.plus} Add stage</button>` : ''}</div>
    <div class="fc-wrap" data-rc="flow">${recruitFlowCanvasHtml(cycle)}</div>${held}`;
}

// The chart and its numbers repaint in place (counts arrive, a save lands).
function recruitPaintFlow() {
  const host = $('[data-rc="flow"]');
  const cycle = recruitCycleRow();
  if (!host || !cycle) return false;
  const scroll = $('[data-rc="flow-scroll"]', host);
  const left = scroll?.scrollLeft || 0, top = scroll?.scrollTop || 0;
  recruitRepaint(host, recruitFlowCanvasHtml(cycle));
  const next = $('[data-rc="flow-scroll"]', host);
  if (next) { next.scrollLeft = left; next.scrollTop = top; recruitFlowFades(next); }
  const summary = $('[data-rc="flow-summary"]');
  if (summary) summary.outerHTML = recruitFlowSummaryHtml();
  return true;
}

// A chart wider than the page fades out at the edge that has more.
function recruitFlowFades(scroll) {
  const wrap = scroll?.parentElement;
  if (!wrap?.classList) return;
  const left = Number(scroll.scrollLeft) || 0;
  const more = (Number(scroll.scrollWidth) || 0) - (Number(scroll.clientWidth) || 0);
  wrap.classList.toggle('is-more-left', left > 2);
  wrap.classList.toggle('is-more-right', more - left > 2);
}

// The form /apply shows: the cycle's choice when that form is open, else the
// first open form in stage order.
function recruitLandingKey(cycle) {
  const sections = recruitSections(cycle);
  const chosen = cycle?.doc?.site?.landing;
  if (sections[chosen]?.open) return chosen;
  return Object.keys(sections).find((k) => sections[k]?.open) || null;
}

/* ------------------------------- editing --------------------------------- */

// One change to the flow, saved at once. `change` receives the connections
// (every stage's list, made explicit) and the order to edit in place, and
// may add or remove stages. The chart shows the change right away and goes
// back if the save fails.
async function recruitFlowEdit(change, done) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  if (!cycle || !recruitCanEdit(cycle)) return false;
  const flow = recruitFlow(cycle);
  const edit = { next: new Map([...flow.edges].map(([k, v]) => [k, [...v]])), order: [...flow.order], add: {}, remove: [] };
  if (change(edit) === false) return false;
  const live = edit.order.filter((k) => !edit.remove.includes(k));
  const sections = {};
  for (const k of live) sections[k] = { ...(edit.add[k] || {}), next: (edit.next.get(k) || []).filter((to) => live.includes(to)) };
  const settings = { sections, order: live, ...(edit.remove.length ? { remove: edit.remove } : {}) };
  const before = st.cycle.sections;
  const optimistic = {};
  for (const k of live) optimistic[k] = { ...(before[k] || { kind: 'step', fields: [], form: null, open: false }), ...(edit.add[k] || {}), next: sections[k].next };
  st.cycle.sections = optimistic;
  recruitPaintFlow();
  st.busy.add('flow');
  try {
    await recruitPutSite(settings);
    toast(done);
    return true;
  } catch (e) {
    st.cycle.sections = before;
    recruitVersionToast(e, cycle.id);
    return false;
  } finally {
    st.busy.delete('flow');
    recruitPaintFlow();
  }
}

function recruitFlowConnect(from, to) {
  const flow = recruitFlow();
  const title = (k) => recruitSectionTitle(k);
  if (from === to || !flow.sections[from] || !flow.sections[to]) return;
  if ((flow.edges.get(from) || []).includes(to)) { toast(`${title(from)} already leads to ${title(to)}`); return; }
  if (recruitReaches(flow, from, to)) { toast(`${title(to)} comes before ${title(from)}; that connection would loop back`); return; }
  recruitFlowEdit((e) => { e.next.get(from).push(to); }, `${title(from)} now leads to ${title(to)}`);
}

function recruitFlowUnlink(from, to) {
  recruitFlowEdit((e) => { const list = e.next.get(from) || []; if (!list.includes(to)) return false; e.next.set(from, list.filter((k) => k !== to)); }, `Removed the connection from ${recruitSectionTitle(from)} to ${recruitSectionTitle(to)}`);
}

// Up or down within its column; the order also sorts stages everywhere else.
function recruitFlowNudge(key, delta) {
  const flow = recruitFlow();
  const rank = flow.ranks.get(key);
  const column = flow.order.filter((k) => flow.ranks.get(k) === rank);
  const i = column.indexOf(key), j = i + delta;
  if (j < 0 || j >= column.length) return;
  recruitFlowEdit((e) => {
    const a = e.order.indexOf(key), b = e.order.indexOf(column[j]);
    [e.order[a], e.order[b]] = [e.order[b], e.order[a]];
  }, `Moved ${recruitSectionTitle(key)} ${delta < 0 ? 'up' : 'down'}`);
}

// Stages this one could lead to without a loop or a repeat.
function recruitFlowTargets(from) {
  const flow = recruitFlow();
  return flow.keys.filter((k) => k !== from && !(flow.edges.get(from) || []).includes(k) && !recruitReaches(flow, from, k));
}

function recruitFlowConnectMenu(anchor, from) {
  const targets = recruitFlowTargets(from);
  if (!targets.length) { toast(`${recruitSectionTitle(from)} already leads everywhere it can`); return; }
  openMenu(targets.map((k) => ({ label: recruitSectionTitle(k), icon: recruitKindIcon(recruitSections()[k].kind), run: () => recruitFlowConnect(from, k) })), anchor);
}

function recruitFlowNodeMenu(anchor, key) {
  const flow = recruitFlow();
  const s = flow.sections[key];
  if (!s) return;
  const column = flow.order.filter((k) => flow.ranks.get(k) === flow.ranks.get(key));
  const at = column.indexOf(key);
  const next = flow.edges.get(key) || [];
  const items = [
    { label: 'Open', icon: RC_ICONS.arrow, run: () => nav(recruitStageHref(key)) },
    { label: 'Add a stage after', icon: I.plus, run: () => recruitOpenStageNew(key) },
    { label: 'Connect to…', icon: RC_ICONS.flow, run: () => recruitFlowConnectMenu(anchor, key) },
    ...(next.length ? [{ label: 'Disconnect from…', icon: I.x, run: () => openMenu(next.map((k) => ({ label: recruitSectionTitle(k), run: () => recruitFlowUnlink(key, k) })), anchor) }] : []),
    ...(column.length > 1 ? ['-', ...(at > 0 ? [{ label: 'Move up', run: () => recruitFlowNudge(key, -1) }] : []), ...(at < column.length - 1 ? [{ label: 'Move down', run: () => recruitFlowNudge(key, 1) }] : [])] : []),
    '-',
    { label: 'Remove stage…', danger: true, run: () => recruitConfirmRemoveStage(key) },
  ];
  openMenu(items, anchor);
}

// Removing a stage joins what led into it to what it led to, so the rest of
// the flow stays connected. The server refuses a stage that still holds
// form responses, people placed there, or checklist entries.
function recruitConfirmRemoveStage(key) {
  const cycle = recruitCycleRow();
  const flow = recruitFlow(cycle);
  const s = flow.sections[key];
  if (!cycle || !s || !recruitCanEdit(cycle)) return;
  const into = flow.into.get(key) || [], out = flow.edges.get(key) || [];
  const bridge = into.length && out.length ? ` ${into.map((k) => recruitSectionTitle(k)).join(' and ')} will lead to ${out.map((k) => recruitSectionTitle(k)).join(' and ')}.` : '';
  UI.modal = {
    kind: 'confirm', title: `Remove ${s.title}?`, danger: true, confirm: 'Remove stage',
    text: `${s.form ? 'Its form leaves the website at once. ' : ''}Its checklist goes with it.${MD.esc(bridge)}`,
    onGo: async () => {
      const ok = await recruitFlowEdit((e) => {
        for (const from of into) e.next.set(from, [...new Set([...(e.next.get(from) || []).filter((k) => k !== key), ...out])]);
        e.remove.push(key);
      }, `${s.title} removed`);
      if (ok) { const st = recruitState(); delete st.stageDrafts?.[`${cycle.id}:${key}`]; if (UI.route?.params?.sub === 'stage') nav(recruitPanelHref(cycle.id, 'flow')); }
    },
  };
  render();
}

/* ------------------------------- dragging to connect --------------------- */

// Drag from a card's port to another card to connect them. A click on the
// port (or Enter) opens the same choice as a menu.
function recruitFlowDragStart(ev, port) {
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  const canvas = port.closest('[data-rc="flow-canvas"]');
  const from = port.dataset.key;
  const flow = recruitFlow();
  const layout = recruitFlowLayout(flow, { vertical: recruitFlowVertical() });
  const a = layout.nodes.get(from);
  const draft = $('[data-rc="flow-draft"]', canvas);
  if (!canvas || !a || !draft || typeof canvas.getBoundingClientRect !== 'function') return;
  ev.preventDefault();
  const valid = new Set(recruitFlowTargets(from));
  const startX = ev.clientX, startY = ev.clientY;
  let moved = false, target = null;
  canvas.classList.add('is-connecting');
  for (const el of $$('.fc-node[data-key]', canvas)) el.classList.toggle('is-candidate', valid.has(el.dataset.key));
  try { port.setPointerCapture?.(ev.pointerId); } catch { /* capture is a nicety */ }
  const mine = (e) => e.pointerId === undefined || ev.pointerId === undefined || e.pointerId === ev.pointerId;
  const move = (e) => {
    if (!mine(e)) return;
    if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
    moved = true;
    const box = canvas.getBoundingClientRect();
    const x = e.clientX - box.left, y = e.clientY - box.top;
    const x1 = layout.vertical ? a.x + a.w / 2 : a.x + a.w, y1 = layout.vertical ? a.y + a.h : a.y + a.h / 2;
    const d = layout.vertical ? Math.max(24, (y - y1) / 2) : Math.max(28, (x - x1) / 2);
    draft.setAttribute('d', layout.vertical ? `M${x1} ${y1} C${x1} ${y1 + d}, ${x} ${y - d}, ${x} ${y}` : `M${x1} ${y1} C${x1 + d} ${y1}, ${x - d} ${y}, ${x} ${y}`);
    const hit = document.elementFromPoint?.(e.clientX, e.clientY)?.closest?.('.fc-node[data-key]');
    const key = hit?.dataset.key || null;
    if (key !== target) {
      $('.fc-node.is-target', canvas)?.classList.remove('is-target');
      target = key && valid.has(key) ? key : null;
      if (target) hit.classList.add('is-target');
    }
  };
  const end = (e) => {
    if (e && !mine(e)) return;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', end);
    document.removeEventListener('pointercancel', end);
    draft.setAttribute('d', '');
    canvas.classList.remove('is-connecting');
    for (const el of $$('.fc-node', canvas)) el.classList.remove('is-candidate', 'is-target');
    if (!moved) recruitFlowConnectMenu(port, from);
    else if (target && e?.type === 'pointerup') recruitFlowConnect(from, target);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('pointerdown', (ev) => {
    const port = typeof ev.target?.closest === 'function' ? ev.target.closest('.fc-port') : null;
    if (port) recruitFlowDragStart(ev, port);
  });
  // A card's connections light up while it is pointed at.
  document.addEventListener('pointerover', (ev) => {
    const node = typeof ev.target?.closest === 'function' ? ev.target.closest('.fc-node[data-key]') : null;
    const canvas = node?.closest?.('[data-rc="flow-canvas"]');
    const key = node?.dataset.key || null;
    const was = document.querySelector?.('[data-rc="flow-canvas"]')?.dataset?.hot || '';
    if (was === (key || '')) return;
    for (const c of $$('[data-rc="flow-canvas"]')) {
      c.dataset.hot = key || '';
      for (const p of $$('.fc-edge', c)) p.classList.toggle('is-hot', Boolean(key) && c === canvas && (p.dataset.from === key || p.dataset.to === key));
    }
  });
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  let wasVertical = null, timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const now = recruitFlowVertical();
      if (wasVertical !== null && now !== wasVertical && UI.route?.name === 'recruit') recruitPaintFlow();
      wasVertical = now;
      const scroll = document.querySelector?.('[data-rc="flow-scroll"]');
      if (scroll) recruitFlowFades(scroll);
    }, 120);
  });
  document.addEventListener?.('scroll', (e) => { if (e.target?.matches?.('[data-rc="flow-scroll"]')) recruitFlowFades(e.target); }, true);
}

/* ------------------------------- register -------------------------------- */

RECRUIT.register({
  name: 'flow',
  order: 1,
  kernel: true,
  panels: [{ id: 'flow', label: 'Flow', icon: RC_ICONS.flow, order: 1, when: () => true }],
  view: (cycle) => recruitFlowView(cycle),
  wide: () => true,
  mount(cycle) {
    const st = recruitState();
    if (!st.insights || st.insights.key !== st.key + ':' + cycle.id) recruitLoadInsights();
    if (st.cycles?.intakeCycleId === cycle.id && recruitIsAdmin() && st.queue === undefined) recruitLoadQueue();
    const scroll = $('[data-rc="flow-scroll"]');
    if (scroll) recruitFlowFades(scroll);
  },
  refresh: { load: () => recruitLoadInsights({ quiet: true }), every: RECRUIT_SYNC_MS },
  actions: {
    'recruit-flow-menu': (el) => recruitFlowNodeMenu(el, el.dataset.key),
    'recruit-flow-port': () => {},   // the pointerdown handler owns the port; Enter lands here
    'recruit-flow-unlink': (el) => recruitFlowUnlink(el.dataset.from, el.dataset.to),
  },
  keydown(ev) {
    const port = typeof ev.target?.matches === 'function' && ev.target.matches('.fc-port') ? ev.target : null;
    if (!port || (ev.key !== 'Enter' && ev.key !== ' ')) return false;
    ev.preventDefault();
    recruitFlowConnectMenu(port, port.dataset.key);
    return true;
  },
  reset() {},
});

// recruit:flow:end
