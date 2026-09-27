/* ============================================================================
   Applications — flow module (client). The cycle's flow chart: every stage a
   card, top to bottom in the order people meet them, the connections drawn
   between them, and the people at each stage counted on its card. A split
   sends people on by an answer they gave; its connections say which answer
   goes where. Leads add stages, connect them (drag from a card's +, or its
   menus), split, reorder and remove them; every change saves at once. A card
   opens its stage's page.
   ========================================================================== */

'use strict';

// recruit:flow:start

// Card size and spacing, in CSS pixels. Fixed, so layout needs no measuring;
// a card with a checklist's progress bar is taller, and so is its row.
const FC = { W: 256, H: 122, H_METER: 134, GAP_X: 32, GAP_Y: 84, PAD: 28, OUT_H: 52, OUT_MIN: 480, DETOUR: 26 };
const FC_OUTCOME = '__outcome';

// Everything the chart shows about a stage: kind, form, and its counts.
function recruitFlowStats(key) {
  const ins = recruitState().insights?.data;
  return ins?.stages?.find((s) => s.key === key) || null;
}

// A point on a connection's curve, t from 0 (the card it leaves) to 1.
const recruitBezier = (t, p0, p1, p2, p3) => (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3;

// A connection leaves a card's bottom and enters the next card's top on a
// smooth curve; one that passes stages in between runs down beside them.
function recruitEdgePath(a, b, { x2 = null, side = null } = {}) {
  if (!a || !b) return { d: '', mx: 0, my: 0 };
  const x1 = a.x + a.w / 2, y1 = a.y + a.h, tx = x2 ?? b.x + b.w / 2, ty = b.y;
  if (side !== null) {
    const h = Math.min(30, (ty - y1) / 4);
    return { d: `M${x1} ${y1} C${x1} ${y1 + h}, ${side} ${y1 + h}, ${side} ${y1 + 2 * h} L${side} ${ty - 2 * h} C${side} ${ty - h}, ${tx} ${ty - h}, ${tx} ${ty}`, mx: side, my: (y1 + ty) / 2 };
  }
  const dy = Math.max(24, (ty - y1) / 2);
  // A split's answer sits nearer the card it leads to, clear of its siblings.
  const t = 0.66;
  return { d: `M${x1} ${y1} C${x1} ${y1 + dy}, ${tx} ${ty - dy}, ${tx} ${ty}`, mx: recruitBezier(t, x1, x1, tx, tx), my: recruitBezier(t, y1, y1 + dy, ty - dy, ty) };
}

// Positions for every stage: a row per step along the flow, each row ordered
// so connections cross as little as one pass over the rows manages, centred;
// the outcomes span the bottom.
function recruitFlowLayout(flow, { outcome = true } = {}) {
  const rows = [];
  for (const k of flow.keys) (rows[flow.ranks.get(k)] ||= []).push(k);
  const list = rows.filter(Boolean);
  const centre = new Map();
  list.forEach((row, r) => {
    if (r > 0) {
      const bary = (k) => { const ins = flow.into.get(k).filter((p) => centre.has(p)); return ins.length ? ins.reduce((a, p) => a + centre.get(p), 0) / ins.length : Infinity; };
      row.sort((a, b) => bary(a) - bary(b) || flow.order.indexOf(a) - flow.order.indexOf(b));
    }
    row.forEach((k, i) => centre.set(k, i - (row.length - 1) / 2));
  });
  const withOutcome = outcome && flow.keys.length > 0;
  const widest = Math.max(1, ...list.map((row) => row.length));
  const span = Math.max(widest * FC.W + (widest - 1) * FC.GAP_X, withOutcome ? FC.OUT_MIN : 0);
  const nodes = new Map();
  const meter = (k) => { const s = flow.sections[k]; return Boolean(s?.done && (s.fields || []).some((f) => f.key === s.done)); };
  let y = FC.PAD;
  list.forEach((row, r) => {
    const width = row.length * FC.W + (row.length - 1) * FC.GAP_X;
    const h = row.some(meter) ? FC.H_METER : FC.H;
    row.forEach((k, i) => nodes.set(k, { key: k, row: r, x: FC.PAD + (span - width) / 2 + i * (FC.W + FC.GAP_X), y, w: FC.W, h }));
    y += h + FC.GAP_Y;
  });
  let height = y - FC.GAP_Y;
  if (withOutcome) {
    nodes.set(FC_OUTCOME, { key: FC_OUTCOME, row: list.length, x: FC.PAD, y: height + FC.GAP_Y, w: span, h: FC.OUT_H });
    height += FC.GAP_Y + FC.OUT_H;
  }
  let right = FC.PAD + span;
  const cards = [...nodes.values()].filter((n) => n.key !== FC_OUTCOME);
  // A connection that would cross a card between its two rows goes around.
  const sideFor = (a, b, x2) => {
    const lo = Math.min(a.x + a.w / 2, x2) - 12, hi = Math.max(a.x + a.w / 2, x2) + 12;
    const between = cards.filter((n) => n.row > a.row && n.row < b.row);
    if (!between.some((n) => n.x < hi && n.x + n.w > lo)) return null;
    const side = Math.max(a.x + a.w, ...between.map((n) => n.x + n.w)) + FC.DETOUR;
    right = Math.max(right, side + FC.DETOUR);
    return side;
  };
  const edges = [];
  for (const [from, to] of flow.edges) {
    const split = flow.splits?.get(from);
    const conditional = split ? recruitSplitTargets(split) : null;
    for (const k of to) {
      const a = nodes.get(from), b = nodes.get(k);
      if (!a || !b) continue;
      edges.push({ from, to: k, label: conditional?.has(k) ? recruitSplitLabel(split, k) : '', ...recruitEdgePath(a, b, { side: sideFor(a, b, b.x + b.w / 2) }) });
    }
  }
  if (withOutcome) {
    const out = nodes.get(FC_OUTCOME);
    for (const k of flow.keys) {
      if ((flow.edges.get(k) || []).length) continue;
      const a = nodes.get(k);
      const x2 = a.x + a.w / 2;
      edges.push({ from: k, to: FC_OUTCOME, outcome: true, label: '', ...recruitEdgePath(a, out, { x2, side: sideFor(a, out, x2) }) });
    }
  }
  return { nodes, edges, width: right + FC.PAD, height: height + FC.PAD };
}

/* ------------------------------- drawing --------------------------------- */

// The kind of a stage as a quiet tag: its icon and its name.
const recruitKindTagHtml = (kind) => `<span class="rc-kind-tag">${recruitKindIcon(kind)}${MD.esc(recruitKindLabel(kind))}</span>`;

function recruitFlowNodeHtml(cycle, flow, n) {
  const key = n.key;
  const s = flow.sections[key];
  const stats = recruitFlowStats(key);
  const lead = recruitCanEdit(cycle);
  const loading = !recruitState().insights?.data;
  const num = (v) => (loading ? '–' : recruitNum(v));
  const landing = recruitLandingKey(cycle) === key;
  const site = s.form ? `<span class="fc-web ${s.open ? 'is-open' : ''}" title="${s.open ? 'Open on the website' : 'Closed on the website'}">${s.open ? (landing ? 'Open · /apply' : 'Open') : 'Closed'}</span>` : '';
  const doneField = (s.fields || []).find((f) => f.key === s.done);
  const reached = Number(stats?.reached || 0), done = Number(stats?.done || 0), upNext = Number(stats?.upNext || 0);
  const pct = reached ? Math.round((done / reached) * 100) : 0;
  const progress = doneField
    ? `<span class="fc-node__done"><span class="fc-node__donetext"><b>${num(done)}</b>/${num(reached)} ${MD.esc(doneField.label.toLowerCase())}</span><span class="fc-meter" aria-hidden="true"><span style="width:${pct}%"></span></span></span>`
    : s.form ? `<span class="fc-node__done"><span class="fc-node__donetext"><b>${num(stats?.responses)}</b> ${stats?.responses === 1 ? 'response' : 'responses'}</span></span>`
    : `<span class="fc-node__done"><span class="fc-node__donetext"><b>${num(done)}</b> moved on</span></span>`;
  const label = `${s.title}, ${recruitKindLabel(s.kind)}${loading ? '' : `: ${recruitPlural(stats?.here || 0, 'person', 'people')} here, ${recruitNum(reached)} reached${upNext ? `, ${recruitNum(upNext)} up next` : ''}${doneField ? `, ${recruitNum(done)} ${doneField.label.toLowerCase()}` : ''}`}`;
  return `<div class="fc-node fc-node--${MD.esc(s.kind)}" data-key="${MD.esc(key)}" style="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px">
    <a class="fc-node__main" href="${recruitStageHref(key)}" data-key="${MD.esc(key)}" aria-label="${MD.esc(label)}">
      <span class="fc-node__top">${recruitKindTagHtml(s.kind)}${site}</span>
      <span class="fc-node__title">${MD.esc(s.title)}</span>
      <span class="fc-node__stats"><span><b>${num(stats?.here)}</b> here</span><span><b>${num(reached)}</b> reached</span>${upNext ? `<span class="fc-node__next"><b>${recruitNum(upNext)}</b> up next</span>` : ''}</span>
      ${progress}
    </a>
    ${lead ? `<button type="button" class="icon-btn fc-node__more" data-action="recruit-flow-menu" data-key="${MD.esc(key)}" aria-label="Options for ${MD.esc(s.title)}" aria-haspopup="menu" title="Options">${I.dots}</button>
    <button type="button" class="fc-port" data-action="recruit-flow-port" data-key="${MD.esc(key)}" aria-label="Add after ${MD.esc(s.title)}, connect or split it" title="Add, connect or split; drag to a stage to connect" aria-haspopup="menu">${I.plus}</button>` : ''}
  </div>`;
}

// How it ended, along the bottom: each status and how many people have it.
function recruitFlowOutcomeHtml(n) {
  const ins = recruitState().insights?.data;
  const rows = [['accepted', 'Accepted'], ['waitlisted', 'Waitlisted'], ['declined', 'Declined'], ['withdrew', 'Withdrew']];
  return `<div class="fc-node fc-node--outcome" style="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px" role="group" aria-label="Outcomes">
    <ul class="fc-outcome">${rows.map(([k, label]) => `<li><a href="${recruitPanelHref(recruitCycleRow().id, 'people', { status: k })}">${label}<b>${ins ? recruitNum(ins.statuses?.[k]) : '–'}</b></a></li>`).join('')}</ul>
  </div>`;
}

function recruitFlowCanvasHtml(cycle) {
  const flow = recruitFlow(cycle);
  if (!flow.keys.length) return `<div class="rc-empty-card"><b>No stages yet</b>${recruitCanEdit(cycle) ? '<p>Add the first stage: a form on the website, a meeting, a review, or any step the team tracks.</p><button class="btn btn--primary" data-action="recruit-stage-new">Add a stage</button>' : ''}</div>`;
  const layout = recruitFlowLayout(flow);
  const lead = recruitCanEdit(cycle);
  const edges = layout.edges.map((e) => `<path class="fc-edge ${e.outcome ? 'fc-edge--outcome' : ''} ${e.label ? 'fc-edge--split' : ''}" data-from="${MD.esc(e.from)}" data-to="${MD.esc(e.to)}" d="${e.d}" marker-end="url(#fc-arrow${e.outcome ? '-soft' : ''})"/>`).join('');
  // A split's connections say which answers take people there.
  const labels = layout.edges.filter((e) => e.label).map((e) => {
    const style = `left:${Math.round(e.mx)}px;top:${Math.round(e.my)}px`;
    const text = MD.esc(e.label);
    return lead
      ? `<button type="button" class="fc-when" data-action="recruit-flow-split" data-key="${MD.esc(e.from)}" data-from="${MD.esc(e.from)}" data-to="${MD.esc(e.to)}" style="${style}" title="${text}: edit the split">${text}</button>`
      : `<span class="fc-when" data-from="${MD.esc(e.from)}" data-to="${MD.esc(e.to)}" style="${style}" title="${text}">${text}</span>`;
  }).join('');
  const nodes = [...layout.nodes.values()].map((n) => (n.key === FC_OUTCOME ? recruitFlowOutcomeHtml(n) : recruitFlowNodeHtml(cycle, flow, n))).join('');
  return `<div class="fc-scroll" data-rc="flow-scroll"><div class="fc-canvas" data-rc="flow-canvas" style="width:${layout.width}px;height:${layout.height}px">
    <svg class="fc-edges" width="${layout.width}" height="${layout.height}" aria-hidden="true">
      <defs><marker id="fc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1L9 5L0 9z"/></marker>
      <marker id="fc-arrow-soft" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1L9 5L0 9z"/></marker></defs>
      ${edges}<path class="fc-edge fc-edge--draft" data-rc="flow-draft" d=""/>
    </svg>${nodes}${labels}
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
  recruitRepaint(host, recruitFlowCanvasHtml(cycle));
  const next = $('[data-rc="flow-scroll"]', host);
  if (next) { recruitFlowPlace(next); recruitFlowFades(next); }
  const summary = $('[data-rc="flow-summary"]');
  if (summary) summary.outerHTML = recruitFlowSummaryHtml();
  return true;
}

// A chart wider than the page opens on its middle, where the flow starts,
// and keeps its place when it is drawn again.
function recruitFlowPlace(scroll) {
  if (!scroll?.dataset || scroll.dataset.placed) return;
  scroll.dataset.placed = '1';
  const more = (Number(scroll.scrollWidth) || 0) - (Number(scroll.clientWidth) || 0);
  if (more > 0) scroll.scrollLeft = recruitState().mod.flowLeft ?? Math.round(more / 2);
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
// (every stage's list, made explicit), the order, and the splits to edit in
// place, and may add or remove stages. The chart shows the change right away
// and goes back if the save fails. `done` is the toast, or makes it.
async function recruitFlowEdit(change, done) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  if (!cycle || !recruitCanEdit(cycle)) return false;
  const flow = recruitFlow(cycle);
  const edit = { next: new Map([...flow.edges].map(([k, v]) => [k, [...v]])), order: [...flow.order], add: {}, remove: [], split: new Map() };
  if (change(edit) === false) return false;
  const live = edit.order.filter((k) => !edit.remove.includes(k));
  const sections = {};
  for (const k of live) sections[k] = { ...(edit.add[k] || {}), next: (edit.next.get(k) || []).filter((to) => live.includes(to)), ...(edit.split.has(k) ? { split: edit.split.get(k) } : {}) };
  const settings = { sections, order: live, ...(edit.remove.length ? { remove: edit.remove } : {}) };
  const before = st.cycle.sections;
  const optimistic = {};
  for (const k of live) {
    optimistic[k] = { ...(before[k] || { kind: 'step', fields: [], form: null, open: false }), ...(edit.add[k] || {}), next: sections[k].next };
    // Answers that led to a stage no longer connected are dropped, as the server does.
    const split = edit.split.has(k) ? edit.split.get(k) : recruitPruneSplit(flow.splits.get(k) || null, sections[k].next);
    if (split) optimistic[k].split = split; else delete optimistic[k].split;
  }
  st.cycle.sections = optimistic;
  recruitPaintFlow();
  st.busy.add('flow');
  try {
    await recruitPutSite(settings);
    toast(typeof done === 'function' ? done() : done);
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
  return recruitFlowEdit((e) => { e.next.get(from).push(to); }, `${title(from)} now leads to ${title(to)}`);
}

function recruitFlowUnlink(from, to) {
  const flow = recruitFlow();
  return recruitFlowEdit((e) => {
    const list = e.next.get(from) || [];
    if (!list.includes(to)) return false;
    e.next.set(from, list.filter((k) => k !== to));
    const split = flow.splits.get(from);
    if (split && recruitSplitTargets(split).has(to)) e.split.set(from, recruitPruneSplit(split, e.next.get(from)));
  }, `Removed the connection from ${recruitSectionTitle(from)} to ${recruitSectionTitle(to)}`);
}

// Left or right within its row; the order also sorts stages everywhere else.
function recruitFlowNudge(key, delta) {
  const flow = recruitFlow();
  const rank = flow.ranks.get(key);
  const row = flow.order.filter((k) => flow.ranks.get(k) === rank);
  const i = row.indexOf(key), j = i + delta;
  if (j < 0 || j >= row.length) return;
  recruitFlowEdit((e) => {
    const a = e.order.indexOf(key), b = e.order.indexOf(row[j]);
    [e.order[a], e.order[b]] = [e.order[b], e.order[a]];
  }, `Moved ${recruitSectionTitle(key)} ${delta < 0 ? 'left' : 'right'}`);
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

// The + under a card: what comes after it.
function recruitFlowPortMenu(anchor, key) {
  const split = recruitFlow().splits.get(key);
  openMenu([
    { label: 'Add a stage after', icon: I.plus, run: () => recruitOpenStageNew(key) },
    { label: 'Connect to…', icon: RC_ICONS.flow, run: () => recruitFlowConnectMenu(anchor, key) },
    { label: split ? 'Edit split…' : 'Split by an answer…', icon: RC_ICONS.split, run: () => recruitOpenSplit(key) },
  ], anchor);
}

function recruitFlowNodeMenu(anchor, key) {
  const flow = recruitFlow();
  const s = flow.sections[key];
  if (!s) return;
  const row = flow.order.filter((k) => flow.ranks.get(k) === flow.ranks.get(key));
  const at = row.indexOf(key);
  const next = flow.edges.get(key) || [];
  const items = [
    { label: 'Open', icon: RC_ICONS.arrow, run: () => nav(recruitStageHref(key)) },
    { label: 'Add a stage after', icon: I.plus, run: () => recruitOpenStageNew(key) },
    { label: 'Connect to…', icon: RC_ICONS.flow, run: () => recruitFlowConnectMenu(anchor, key) },
    { label: flow.splits.has(key) ? 'Edit split…' : 'Split by an answer…', icon: RC_ICONS.split, run: () => recruitOpenSplit(key) },
    ...(next.length ? [{ label: 'Disconnect from…', icon: I.x, run: () => openMenu(next.map((k) => ({ label: recruitSectionTitle(k), run: () => recruitFlowUnlink(key, k) })), anchor) }] : []),
    ...(row.length > 1 ? ['-', ...(at > 0 ? [{ label: 'Move left', run: () => recruitFlowNudge(key, -1) }] : []), ...(at < row.length - 1 ? [{ label: 'Move right', run: () => recruitFlowNudge(key, 1) }] : [])] : []),
    '-',
    { label: 'Remove stage…', danger: true, run: () => recruitConfirmRemoveStage(key) },
  ];
  openMenu(items, anchor);
}

// Removing a stage joins what led into it to what it led to, so the rest of
// the flow stays connected; a split's answer that led there follows it to
// the one stage it led to, or goes. The server refuses a stage that still
// holds form responses, people placed there, or checklist entries.
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
        for (const from of into) {
          e.next.set(from, [...new Set([...(e.next.get(from) || []).filter((k) => k !== key), ...out])]);
          const split = flow.splits.get(from);
          if (split && recruitSplitTargets(split).has(key)) {
            const to = out.length === 1 ? out[0] : null;
            const routes = Object.fromEntries(Object.entries(split.routes).map(([a, t]) => [a, t === key ? to : t]).filter(([, t]) => t));
            e.split.set(from, Object.keys(routes).length ? { ...split, routes, otherwise: split.otherwise === key ? to : split.otherwise } : null);
          }
        }
        e.remove.push(key);
      }, `${s.title} removed`);
      if (ok) { const st = recruitState(); delete st.stageDrafts?.[`${cycle.id}:${key}`]; if (UI.route?.params?.sub === 'stage') nav(recruitPanelHref(cycle.id, 'flow')); }
    },
  };
  render();
}

/* ------------------------------- splits ---------------------------------- */

// Where a split can read an answer: a choice or a checkbox on this stage's
// form, or on the form of any stage that leads here.
function recruitSplitQuestions(flow, from) {
  const out = [];
  for (const k of flow.keys) {
    if (k !== from && !recruitReaches(flow, from, k)) continue;
    for (const q of flow.sections[k].form?.questions || []) {
      if (!RECRUIT_SPLIT_TYPES.includes(q.type) || !recruitSplitOptions(q).length) continue;
      out.push({ value: `${k}::${q.key}`, label: `${flow.sections[k].title} · ${q.label || q.key}`, stage: k, q });
    }
  }
  return out;
}

// Stages a split can send people to: any that does not lead back here.
const recruitSplitDestinations = (flow, from) => flow.keys.filter((k) => k !== from && !recruitReaches(flow, from, k));

// A first guess at where each answer goes: the stage named for it, by the
// answer itself or a common short name (Software: CS, Mechanical: Mech).
const RECRUIT_SPLIT_ALIASES = { software: ['cs', 'swe', 'software', 'code', 'computer', 'programming'], electrical: ['ee', 'ece', 'elec', 'electrical', 'hardware'], mechanical: ['me', 'mech', 'mechanical'], creative: ['creative', 'design', 'art', 'media'], business: ['business', 'biz', 'marketing', 'ops', 'operations'] };
// Words every stage name might carry say nothing about which one an answer means.
const RECRUIT_SPLIT_GENERIC = new Set(['form', 'forms', 'stage', 'chat', 'chats', 'team', 'the', 'and', 'for']);
function recruitSplitGuess(answer, stages) {
  const words = (text) => String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !RECRUIT_SPLIT_GENERIC.has(w));
  const said = words(answer);
  const names = new Set([...said, ...said.flatMap((w) => Object.entries(RECRUIT_SPLIT_ALIASES).filter(([k, list]) => w.startsWith(k.slice(0, 4)) || list.includes(w)).flatMap(([, list]) => list))]);
  const hit = stages.find((s) => words(s.title).some((w) => names.has(w) || (w.length >= 4 && said.some((a) => a.startsWith(w)))));
  return hit?.key || '';
}

// A new split starts with each answer on the stage its name suggests.
function recruitSplitDefaults(flow, from, pick) {
  const [stage, key] = String(pick || '').split('::');
  const q = (flow.sections[stage]?.form?.questions || []).find((x) => x.key === key);
  const stages = recruitSplitDestinations(flow, from).map((k) => ({ key: k, title: flow.sections[k].title }));
  const routes = {};
  for (const answer of recruitSplitOptions(q)) { const to = recruitSplitGuess(answer, stages); if (to) routes[answer] = to; }
  return routes;
}

function recruitOpenSplit(from) {
  const flow = recruitFlow();
  if (!flow.sections[from] || !recruitCanEdit()) return;
  const split = flow.splits.get(from) || null;
  const questions = recruitSplitQuestions(flow, from);
  const pick = split ? `${split.stage}::${split.q}` : (questions.find((x) => x.stage === from && x.q.key === 'subteam') || questions.find((x) => x.stage === from) || questions.find((x) => x.q.key === 'subteam') || questions[0])?.value || '';
  UI.modal = { kind: 'recruit-split', from, pick, routes: split ? { ...split.routes } : recruitSplitDefaults(flow, from, pick), otherwise: split?.otherwise || '', error: '', busy: false };
  render();
}

function recruitSplitBodyHtml(m) {
  const flow = recruitFlow();
  const from = m.from;
  const questions = recruitSplitQuestions(flow, from);
  if (!questions.length) {
    const form = flow.sections[from]?.form ? from : null;
    return `<p>No form before ${MD.esc(recruitSectionTitle(from))} asks a choose-one, choose-many or checkbox question to split by.</p>${form ? `<a class="btn" href="${recruitStageHref(form, 'form')}" style="text-decoration:none">Add a question to its form</a>` : ''}`;
  }
  const chosen = questions.find((x) => x.value === m.pick) || questions[0];
  const places = recruitSplitDestinations(flow, from).map((k) => ({ value: k, label: flow.sections[k].title }));
  const to = [{ value: '', label: '—' }, ...places, { value: '__new__', label: 'A new stage' }];
  const rows = recruitSplitOptions(chosen.q).map((answer) => `<li class="sp-route"><span class="sp-route__answer">${MD.esc(answer)}</span><span class="sp-route__arrow" aria-hidden="true">${RC_ICONS.arrow}</span>${recruitDd('recruit-split-to', to, m.routes[answer] || '', `data-answer="${MD.esc(answer)}" aria-label="Where people who answered ${MD.esc(answer)} go"`)}</li>`).join('');
  const other = [{ value: '', label: 'Nowhere: they stop here' }, ...places];
  return `<label class="rc-label">Split by the answer to${recruitDd('recruit-split-q', questions.map(({ value, label }) => ({ value, label })), chosen.value, 'aria-label="Question"')}</label>
    <ul class="sp-routes">${rows}
      <li class="sp-route sp-route--else"><span class="sp-route__answer">Anyone else</span><span class="sp-route__arrow" aria-hidden="true">${RC_ICONS.arrow}</span>${recruitDd('recruit-split-else', other, m.otherwise || '', 'aria-label="Where everyone else goes"')}</li></ul>
    <p class="rc-set__note">An answer set to — goes where Anyone else goes. Someone who picked several answers goes to each of their stages.</p>
    <p class="field-error" role="alert" ${m.error ? '' : 'hidden'}>${MD.esc(m.error || '')}</p>`;
}

function recruitSplitModalHtml(m) {
  const flow = recruitFlow();
  const existing = flow.splits.has(m.from);
  const title = recruitSectionTitle(m.from);
  const can = recruitSplitQuestions(flow, m.from).length > 0;
  return `<div class="modal sp" role="dialog" aria-label="Split after ${MD.esc(title)}">
    <div class="modal__head"><h3>Split after ${MD.esc(title)}</h3><button class="icon-btn" data-action="modal-close" aria-label="Close">${I.x}</button></div>
    <div class="modal__body rc-form" data-rc="split-body">${recruitSplitBodyHtml(m)}</div>
    <div class="modal__foot modal__foot--split">${existing ? `<button class="btn btn--ghost" data-action="recruit-split-remove" ${m.busy ? 'disabled' : ''}>Remove split</button>` : '<span></span>'}<span class="sp__actions"><button class="btn" data-action="modal-close">Cancel</button>${can ? `<button class="btn btn--primary" data-action="recruit-split-save" ${m.busy ? 'disabled' : ''}>${m.busy ? 'Saving…' : 'Save split'}</button>` : ''}</span></div>
  </div>`;
}

function recruitPaintSplit() {
  const m = UI.modal;
  const body = $('[data-rc="split-body"]');
  if (m?.kind !== 'recruit-split' || !body) return;
  recruitRepaint(body, recruitSplitBodyHtml(m));
}

async function recruitSaveSplit() {
  const m = UI.modal;
  if (m?.kind !== 'recruit-split' || m.busy) return;
  const flow = recruitFlow();
  const from = m.from;
  const say = (text) => { m.error = text; const el = $('.sp .field-error'); if (el) { el.textContent = text; el.hidden = !text; } };
  const chosen = recruitSplitQuestions(flow, from).find((x) => x.value === m.pick);
  if (!chosen) { say('Choose the question to split by.'); return; }
  const answers = recruitSplitOptions(chosen.q);
  const routes = Object.fromEntries(Object.entries(m.routes || {}).filter(([a, to]) => to && answers.includes(a)));
  if (!Object.keys(routes).length) { say('Send at least one answer to a stage.'); return; }
  // Answers set to a new stage each get a form of their own, right after this stage.
  const add = {};
  const taken = new Set([...flow.keys, 'people', 'flow', 'stage', 'person', 'insights']);
  for (const [answer, to] of Object.entries(routes)) {
    if (to !== '__new__') continue;
    const title = `${answer} form`.slice(0, 80);
    const base = recruitStageKeyFor(title);
    let key = base;
    for (let n = 2; taken.has(key); n += 1) key = `${base.slice(0, 37)}-${n}`;
    taken.add(key);
    add[key] = { title, kind: 'form', open: false, description: '', form: { questions: [{ key: 'name', type: 'short', label: 'Name', required: true, max: 100 }, { key: 'email', type: 'email', label: 'Email', required: true, max: 200 }] }, fields: [], done: null };
    routes[answer] = key;
  }
  const split = { stage: chosen.stage, q: chosen.q.key, routes, otherwise: m.otherwise || null };
  const targets = recruitSplitTargets(split);
  const before = recruitSplitTargets(flow.splits.get(from) || null);
  const cut = [];
  m.busy = true;
  say('');
  const ok = await recruitFlowEdit((e) => {
    for (const [key, stage] of Object.entries(add)) { e.add[key] = stage; e.order.splice(e.order.indexOf(from) + 1, 0, key); e.next.set(key, []); }
    // The split's stages are alternatives: one no longer leads to another.
    for (const t of targets) {
      const list = e.next.get(t) || [];
      for (const k of list) if (targets.has(k)) cut.push([t, k]);
      e.next.set(t, list.filter((k) => !targets.has(k)));
    }
    const everyone = (e.next.get(from) || []).filter((k) => !before.has(k) && !targets.has(k));
    e.next.set(from, [...everyone, ...targets]);
    e.split.set(from, split);
  }, () => `Split saved${cut.length ? `. ${cut.map(([a, b]) => `${recruitSectionTitle(a)} no longer leads to ${recruitSectionTitle(b)}`).join('; ')}` : ''}`);
  m.busy = false;
  if (ok && UI.modal === m) { closeModal(); return; }
  if (UI.modal === m) render();
}

async function recruitRemoveSplit() {
  const m = UI.modal;
  if (m?.kind !== 'recruit-split' || m.busy) return;
  const from = m.from;
  m.busy = true;
  const ok = await recruitFlowEdit((e) => { e.split.set(from, null); }, `Split removed. Everyone after ${recruitSectionTitle(from)} now goes to each of its stages.`);
  m.busy = false;
  if (ok && UI.modal === m) closeModal();
  else if (UI.modal === m) render();
}

/* ------------------------------- dragging to connect --------------------- */

// Drag from a card's + to another card to connect them. A click on the +
// (or Enter) opens the menu of what can come after the card.
function recruitFlowDragStart(ev, port) {
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  const canvas = port.closest('[data-rc="flow-canvas"]');
  const from = port.dataset.key;
  const flow = recruitFlow();
  const layout = recruitFlowLayout(flow);
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
    const x1 = a.x + a.w / 2, y1 = a.y + a.h;
    const d = Math.max(24, (y - y1) / 2);
    draft.setAttribute('d', `M${x1} ${y1} C${x1} ${y1 + d}, ${x} ${y - d}, ${x} ${y}`);
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
    if (!moved) recruitFlowPortMenu(port, from);
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
  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { const scroll = document.querySelector?.('[data-rc="flow-scroll"]'); if (scroll) recruitFlowFades(scroll); }, 120);
  });
  document.addEventListener?.('scroll', (e) => {
    if (!e.target?.matches?.('[data-rc="flow-scroll"]')) return;
    recruitState().mod.flowLeft = e.target.scrollLeft;
    recruitFlowFades(e.target);
  }, true);
}

/* ------------------------------- register -------------------------------- */

RECRUIT.register({
  name: 'flow',
  order: 1,
  kernel: true,
  panels: [{ id: 'flow', label: 'Flow', icon: RC_ICONS.flow, order: 1, when: () => true }],
  view: (cycle) => recruitFlowView(cycle),
  mount(cycle) {
    const st = recruitState();
    if (!st.insights || st.insights.key !== st.key + ':' + cycle.id) recruitLoadInsights();
    if (st.cycles?.intakeCycleId === cycle.id && recruitIsAdmin() && st.queue === undefined) recruitLoadQueue();
    const scroll = $('[data-rc="flow-scroll"]');
    if (scroll) { recruitFlowPlace(scroll); recruitFlowFades(scroll); }
  },
  refresh: { load: () => recruitLoadInsights({ quiet: true }), every: RECRUIT_SYNC_MS },
  actions: {
    'recruit-flow-menu': (el) => recruitFlowNodeMenu(el, el.dataset.key),
    'recruit-flow-port': () => {},   // the pointerdown handler owns the +; Enter lands in keydown
    'recruit-flow-split': (el) => recruitOpenSplit(el.dataset.key),
    'recruit-split-save': () => recruitSaveSplit(),
    'recruit-split-remove': () => recruitRemoveSplit(),
  },
  dd: {
    'recruit-split-q': (host, value) => {
      const m = UI.modal;
      if (value === undefined || m?.kind !== 'recruit-split' || value === m.pick) return;
      m.pick = value;
      m.routes = recruitSplitDefaults(recruitFlow(), m.from, value);
      m.error = '';
      recruitPaintSplit();
    },
    'recruit-split-to': (host, value) => { const m = UI.modal; if (value !== undefined && m?.kind === 'recruit-split') m.routes = { ...m.routes, [host.dataset.answer]: value }; },
    'recruit-split-else': (host, value) => { const m = UI.modal; if (value !== undefined && m?.kind === 'recruit-split') m.otherwise = value; },
  },
  modals: { 'recruit-split': recruitSplitModalHtml },
  keydown(ev) {
    const port = typeof ev.target?.matches === 'function' && ev.target.matches('.fc-port') ? ev.target : null;
    if (!port || (ev.key !== 'Enter' && ev.key !== ' ')) return false;
    ev.preventDefault();
    recruitFlowPortMenu(port, port.dataset.key);
    return true;
  },
  reset() {},
});

// recruit:flow:end
