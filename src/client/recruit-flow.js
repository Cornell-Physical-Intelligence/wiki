/* ============================================================================
   Applications — flow module (client). The cycle's flow chart: every stage a
   card, left to right in the order people meet them (top to bottom on a
   narrow screen), the connections drawn between them, and the people at
   each stage counted on its card. A split sends people on by an answer they
   gave: its branches leave the card together and say which answers take
   them. Leads add stages (the + in the chart, or a card's own +), connect
   them (drag from a card's +, or its menus), split, reorder and remove them;
   every change saves at once. A card opens its stage in a panel over the
   chart.
   ========================================================================== */

'use strict';

// recruit:flow:start

// Sizes, in CSS pixels. Across a wide chart every card is as wide as the
// chart allows between W_MIN and W_MAX (and as tall as its content needs); columns sit GAP apart (a gap
// is as wide as the counts and answers on its connections need), and stages
// that share a column stack STACK apart. A connection that passes a column
// takes a LANE through it. Down a narrow chart, rows sit V_GAP apart.
const FC = {
  W_MIN: 184, W_MAX: 300, PAD: 24,
  GAP: 56, GAP_MIN: 44, GAP_GROW: 40, GAP_LABEL: 200, ENTRY: 40, WHY: 112,
  STACK: 28, LANE: 14, LANE_GAP: 14,
  OUT_W: 140, OUT_H: 184,
  FORK: 20, BEND: 10, SCALE_MIN: 0.8,
  NARROW: 700, V_W: 272, V_GAP: 64, V_STACK: 20, V_OUT_H: 100, V_ENTRY: 44,
};
const FC_OUTCOME = '__outcome';

// Everything the chart shows about a stage: kind, form, and its counts.
function recruitFlowStats(key) {
  const ins = recruitState().insights?.data;
  return ins?.stages?.find((s) => s.key === key) || null;
}

// The width the chart fills: its own zone once drawn; before that, the
// window less the sidebar and the page's margins. The chart lays itself out
// again once it knows (recruitFlowFit).
function recruitFlowAvail() {
  const zone = typeof document !== 'undefined' ? document.querySelector?.('[data-rc="flow"]') : null;
  const w = Number(zone?.clientWidth) || 0;
  if (w > 0) return w - 2;   // the zone's border
  const vw = Number(typeof window !== 'undefined' && window.innerWidth) || 1280;
  return Math.max(320, vw > 860 ? vw - 268 - 80 : vw - 36);
}

// How wide a line of text is in the page's font (12px labels by default,
// a card's 15px titles): measured where the page can, counted otherwise.
let recruitMeasure = null;
function recruitTextWidth(text, { px = 12, weight = 400 } = {}) {
  const s = String(text || '');
  try {
    if (recruitMeasure === null) {
      const ctx = document.createElement('canvas').getContext?.('2d') || false;
      recruitMeasure = ctx ? { ctx, family: getComputedStyle(document.body).fontFamily || 'sans-serif' } : false;
    }
    if (recruitMeasure) { recruitMeasure.ctx.font = `${weight} ${px}px ${recruitMeasure.family}`; return Math.ceil(recruitMeasure.ctx.measureText(s).width); }
  } catch { recruitMeasure = false; }
  return Math.ceil(s.length * px * (weight >= 600 ? 0.6 : 0.56));
}

// How wide a label is once its words wrap at `max` (two lines at most; a
// longer label is cut).
function recruitWrapWidth(text, max) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  let widest = 0, line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && recruitTextWidth(next) > max) { widest = Math.max(widest, recruitTextWidth(line)); line = w; } else line = next;
  }
  return Math.min(max, Math.max(widest, recruitTextWidth(line)));
}

// Centres for one column's items, kept in order, as near the wanted centres
// as the spacing between neighbours allows (least squares, by pooling
// adjacent violators).
function recruitSpread(want, gaps) {
  const off = [0];
  for (let i = 0; i < gaps.length; i += 1) off.push(off[i] + gaps[i]);
  const blocks = [];
  want.forEach((w, i) => {
    let b = { sum: w - off[i], n: 1, start: i };
    while (blocks.length && blocks.at(-1).sum / blocks.at(-1).n > b.sum / b.n) {
      const top = blocks.pop();
      b = { sum: top.sum + b.sum, n: top.n + b.n, start: top.start };
    }
    blocks.push(b);
  });
  const out = [];
  for (const b of blocks) for (let k = 0; k < b.n; k += 1) out.push(b.sum / b.n + off[b.start + k]);
  return out;
}

// Where everything goes. Stages sit in a column per step (a row, down a
// narrow chart). Within a column they are ordered so connections cross as
// little as a few sweeps manage, then placed as near the stages they
// connect to as their spacing allows: a split fans out evenly around the
// stage it leaves, and branches that meet again meet in the middle. A
// connection that passes a column takes a lane through it, clear of the
// cards there. Connections run straight, or bend once in a gap with rounded
// corners: a stage's branches bend together just after it, connections into
// one stage just before it. Every connection carries a count of the people
// who passed along it, a split's also the answers that take it; each first
// stage gets a short arrow in, counting who entered there. The outcomes
// close the chart: a column across, a bar down. When the chart is still too
// wide at its smallest cards, it is drawn a little smaller (never below
// SCALE_MIN) before it scrolls.
function recruitFlowLayout(flow, { width = recruitFlowAvail(), outcome = true } = {}) {
  const across = width >= FC.NARROW;
  const ranks = [...new Set(flow.keys.map((k) => flow.ranks.get(k) ?? 0))].sort((a, b) => a - b);
  const n = ranks.length;
  const colOf = (k) => ranks.indexOf(flow.ranks.get(k) ?? 0);
  const withOutcome = outcome && n > 0;

  // Items: a card per stage, and a lane in each column a connection passes.
  const items = new Map();
  const add = (id, col, kind, key = null, from = null) => { const it = { id, col, kind, key, from, preds: [], succs: [] }; items.set(id, it); return it; };
  for (const k of flow.keys) add(k, colOf(k), 'card', k);
  const edges = [];
  const connect = (from, to, extra) => {
    const last = to === FC_OUTCOME ? n : colOf(to);
    const chain = [from];
    for (let c = colOf(from) + 1; c < last; c += 1) chain.push(add(`${from}>${to}@${c}`, c, 'lane', null, from).id);
    if (to !== FC_OUTCOME) chain.push(to);
    for (let i = 1; i < chain.length; i += 1) { items.get(chain[i - 1]).succs.push(chain[i]); items.get(chain[i]).preds.push(chain[i - 1]); }
    edges.push({ from, to, chain, ...extra });
  };
  for (const [from, list] of flow.edges) {
    const split = flow.splits?.get(from) || null;
    const conditional = recruitSplitTargets(split);
    for (const to of list) {
      if (!items.has(to) || colOf(to) <= colOf(from)) continue;
      connect(from, to, { outcome: false, split: conditional.has(to), label: conditional.has(to) ? recruitSplitLabel(split, to) : '' });
    }
  }
  if (withOutcome) for (const k of flow.keys) if (!(flow.edges.get(k) || []).length) connect(k, FC_OUTCOME, { outcome: true, split: false, label: '' });
  const roots = flow.keys.filter((k) => !items.get(k).preds.length);

  // Order within each column: stage order first, then sweeps that sort each
  // column by where its neighbours sit (ties keep the order).
  const cols = Array.from({ length: n }, () => []);
  for (const it of items.values()) cols[it.col].push(it);
  const seq = (it) => flow.order.indexOf(it.key ?? it.from) + (it.key ? 0 : 0.5);
  for (const col of cols) col.sort((a, b) => seq(a) - seq(b));
  const at = new Map();
  const index = (col) => col.forEach((it, i) => at.set(it.id, i));
  cols.forEach(index);
  const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
  const sortBy = (col, side) => {
    const bary = new Map(col.map((it) => [it.id, mean(it[side].map((id) => at.get(id))) ?? at.get(it.id)]));
    col.sort((a, b) => bary.get(a.id) - bary.get(b.id) || at.get(a.id) - at.get(b.id));
    index(col);
  };
  for (let pass = 0; pass < 4; pass += 1) {
    for (let c = 1; c < n; c += 1) sortBy(cols[c], 'preds');
    for (let c = n - 2; c >= 0; c -= 1) sortBy(cols[c], 'succs');
  }

  // Cards are one height: room for the longest title (two lines at most)
  // and, where a checkbox marks a stage done, its bar.
  const Wd = Math.min(FC.V_W, Math.max(208, width - 2 * FC.PAD));
  const meters = flow.keys.some((k) => { const s = flow.sections[k]; return Boolean(s?.done && (s.fields || []).some((f) => f.key === s.done)); });
  const cardH = (w) => {
    const lines = flow.keys.some((k) => recruitTextWidth(flow.sections[k].title, { px: 15, weight: 600 }) > w - 32) ? 2 : 1;
    return Math.ceil(2 + 28 + 20 + 10 + 19.5 * lines + 12 + 22 + (meters ? 36 : 0));
  };
  let H = cardH(across ? FC.W_MAX : Wd);

  // Across the flow: centres, relaxed toward each item's neighbours.
  const size = (it) => (it.kind === 'lane' ? FC.LANE : across ? H : Wd);
  const apart = (a, b) => size(a) / 2 + (a.kind === 'lane' || b.kind === 'lane' ? FC.LANE_GAP : across ? FC.STACK : FC.V_STACK) + size(b) / 2;
  const c = new Map();
  const relax = () => {
    for (const col of cols) {
      let y = 0;
      col.forEach((it, i) => { if (i) y += apart(col[i - 1], it); c.set(it.id, y); });
      for (const it of col) c.set(it.id, c.get(it.id) - y / 2);
    }
    for (let round = 0; round < 24; round += 1) {
      for (const col of round % 2 ? [...cols].reverse() : cols) {
        const want = col.map((it) => mean([...it.preds, ...it.succs].map((id) => c.get(id))) ?? c.get(it.id));
        recruitSpread(want, col.slice(1).map((it, i) => apart(col[i], it))).forEach((v, i) => c.set(col[i].id, v));
      }
    }
  };
  relax();

  // How each connection enters its last gap, which decides where its count
  // sits and how wide that gap must be.
  const outs = new Map(), ins = new Map();
  for (const e of edges) { outs.set(e.from, (outs.get(e.from) || 0) + 1); if (!e.outcome) ins.set(e.to, (ins.get(e.to) || 0) + 1); }
  const pillW = (e) => (e.label ? recruitWrapWidth(e.label, FC.WHY) + 6 : 0) + recruitTextWidth('000') + 22;
  const need = new Array(n + 1).fill(0);   // need[c]: the gap before column c
  for (const e of edges) {
    if (e.outcome) continue;
    const bent = Math.abs(c.get(e.chain.at(-2)) - c.get(e.to)) >= 0.5;
    e.turn = bent ? (e.chain.length === 2 && outs.get(e.from) > 1 ? 'fork' : ins.get(e.to) > 1 ? 'merge' : 'mid') : 'none';
    const gap = colOf(e.to);
    need[gap] = Math.max(need[gap], (e.turn === 'none' ? 0 : FC.FORK + FC.BEND) + pillW(e) + 16);
  }

  // Along the flow: card width and gaps from the width there is.
  const gapCount = n - 1 + (withOutcome ? 1 : 0);
  const entry = across ? FC.ENTRY : FC.V_ENTRY;
  const gapsWith = (base) => Array.from({ length: gapCount }, (_, i) => Math.max(base, Math.min(FC.GAP_LABEL, need[i + 1])));
  const fixed = (base) => 2 * FC.PAD + entry + (withOutcome ? FC.OUT_W : 0) + gapsWith(base).reduce((a, b) => a + b, 0);
  let W = Wd, scale = 1, gaps;
  if (across) {
    const base = (width - fixed(FC.GAP)) / n >= FC.W_MIN ? FC.GAP : FC.GAP_MIN;
    W = Math.floor((width - fixed(base)) / n);
    if (W < FC.W_MIN) { W = FC.W_MIN; scale = Math.max(FC.SCALE_MIN, width / (fixed(base) + n * W)); }
    W = Math.min(FC.W_MAX, W);
    gaps = gapsWith(base);
    // Width left once the cards are at their widest opens the gaps a little.
    const extra = width - fixed(base) - n * W;
    if (scale === 1 && extra > 0 && gapCount) gaps = gaps.map((g) => g + Math.min(FC.GAP_GROW, extra / gapCount));
  } else gaps = Array.from({ length: gapCount }, (_, i) => Math.max(FC.V_GAP, Math.min(FC.GAP_LABEL, need[i + 1] ? 64 : 0)));
  if (across && cardH(W) !== H) { H = cardH(W); relax(); }
  const span = across ? W : H;   // a column's extent along the flow
  const main = [FC.PAD + entry];
  for (let i = 0; i < gapCount; i += 1) main.push(main[i] + span + gaps[i]);

  // Outcomes are centred on the connections that end there. Down, keep
  // the card as narrow as a stage so every label and count stays together.
  const ends = edges.filter((e) => e.outcome).map((e) => c.get(e.chain.at(-1)));
  let outLow = 0, outHigh = 0;
  if (withOutcome && ends.length) {
    const m = (Math.min(...ends) + Math.max(...ends)) / 2;
    const extent = across ? FC.OUT_H : Wd;
    outLow = m - extent / 2; outHigh = m + extent / 2;
  }
  let low = Infinity, high = -Infinity;
  for (const it of items.values()) { low = Math.min(low, c.get(it.id) - size(it) / 2); high = Math.max(high, c.get(it.id) + size(it) / 2); }
  if (withOutcome && ends.length) { low = Math.min(low, outLow); high = Math.max(high, outHigh); }
  if (!Number.isFinite(low)) { low = 0; high = 0; }
  const shift = FC.PAD - low;
  const mid = (id) => c.get(id) + shift;

  const nodes = new Map();
  for (const it of items.values()) {
    if (it.kind !== 'card') continue;
    const m = main[it.col], x0 = mid(it.id);
    nodes.set(it.key, across ? { key: it.key, col: it.col, x: m, y: x0 - H / 2, w: W, h: H } : { key: it.key, col: it.col, x: x0 - Wd / 2, y: m, w: Wd, h: H });
  }
  if (withOutcome && ends.length) {
    nodes.set(FC_OUTCOME, across
      ? { key: FC_OUTCOME, col: n, x: main[n], y: outLow + shift, w: FC.OUT_W, h: outHigh - outLow }
      : { key: FC_OUTCOME, col: n, x: outLow + shift, y: main[n], w: outHigh - outLow, h: FC.V_OUT_H });
  }

  // Connections, in (along, across) coordinates turned into x and y.
  const r1 = (v) => Math.round(v * 10) / 10;
  const P = (along, cross) => (across ? `${r1(along)} ${r1(cross)}` : `${r1(cross)} ${r1(along)}`);
  const XY = (along, cross) => (across ? { lx: along, ly: cross } : { lx: cross, ly: along });
  const hop = ([am, ac], [bm, bc], turn) => {
    if (Math.abs(bc - ac) < 0.5) return `L${P(bm, bc)}`;
    const s = bc > ac ? 1 : -1;
    const r = Math.max(0, Math.min(FC.BEND, Math.abs(bc - ac) / 2, turn - am, bm - turn));
    return `L${P(turn - r, ac)}Q${P(turn, ac)} ${P(turn, ac + s * r)}L${P(turn, bc - s * r)}Q${P(turn, bc)} ${P(turn + r, bc)}L${P(bm, bc)}`;
  };
  const drawn = edges.map((e) => {
    const steps = e.chain.slice(1).map((id) => items.get(id));
    const total = steps.length + (e.outcome ? 1 : 0);
    let here = [main[items.get(e.from).col] + span, mid(e.from)];
    let d = `M${P(...here)}`;
    let place = null, gap = 0;
    const cross = (next) => {
      gap += 1;
      const fork = gap === 1 && outs.get(e.from) > 1;
      const merge = gap === total && (e.outcome ? ends.length > 1 : ins.get(e.to) > 1);
      const turn = fork ? here[0] + FC.FORK : merge ? next[0] - FC.FORK : (here[0] + next[0]) / 2;
      d += hop(here, next, turn);
      if (gap === total) {
        // The count sits on the last straight stretch before the card, or
        // before the bend where connections merge into it.
        const level = Math.abs(next[1] - here[1]) < 0.5;
        const start = level ? (fork ? here[0] + FC.FORK : here[0]) : merge ? here[0] : turn + FC.BEND;
        const stop = level || !merge ? next[0] : turn - FC.BEND;
        place = { ...XY((start + stop) / 2, level || !merge ? next[1] : here[1]), lw: across ? stop - start - 10 : Wd - 16 };
      }
      here = next;
    };
    for (const it of steps) {
      cross([main[it.col], mid(it.id)]);
      if (it.kind === 'lane') { here = [main[it.col] + span, mid(it.id)]; d += `L${P(...here)}`; }
    }
    if (e.outcome) cross([main[n], shift + (outLow + outHigh) / 2]);
    return { from: e.from, to: e.to, outcome: e.outcome, split: e.split, label: e.label, d, ...(e.outcome ? {} : place) };
  });
  // Into each first stage: a short arrow from the chart's edge.
  for (const k of roots) {
    const cross = mid(k);
    drawn.push({ from: null, to: k, entry: true, outcome: false, split: false, label: '', d: `M${P(FC.PAD, cross)}L${P(main[0], cross)}`, ...XY(FC.PAD + entry / 2, cross), lw: across ? entry - 6 : Wd - 16 });
  }

  const boxes = [...nodes.values()];
  const far = (b) => (across ? b.x + b.w : b.y + b.h);
  const extentAlong = Math.max(...boxes.map(far), FC.PAD) + FC.PAD;
  const extentAcross = high - low + 2 * FC.PAD;
  return { across, W: across ? W : Wd, H, scale, nodes, edges: drawn, width: across ? extentAlong : extentAcross, height: across ? extentAcross : extentAlong };
}

/* ------------------------------- drawing --------------------------------- */

// The kind of a stage as a quiet tag: its icon and its name.
const recruitKindTagHtml = (kind) => `<span class="rc-kind-tag">${recruitKindIcon(kind)}${MD.esc(recruitKindLabel(kind))}</span>`;

// The stage whose panel is open over the chart, if any.
const recruitOpenStage = () => (UI.route?.params?.sub === 'stage' ? recruitStageKey() : null);

// A card: the stage's kind, whether its form is on the website, its name,
// who is here now and, where a checkbox marks it done, how far along they
// are. How many came in is on the arrows.
function recruitFlowNodeHtml(cycle, flow, n) {
  const key = n.key;
  const s = flow.sections[key];
  const stats = recruitFlowStats(key);
  const lead = recruitCanEdit(cycle);
  const loading = !recruitState().insights?.data;
  const num = (v) => (loading ? '–' : recruitNum(Number(v) || 0));
  const site = s.form ? `<span class="fc-web ${s.open ? 'is-open' : ''}" title="${s.open ? 'Open on the website' : 'Closed on the website'}">${s.open ? 'Open' : 'Closed'}</span>` : '';
  const doneField = (s.fields || []).find((f) => f.key === s.done);
  const reached = Number(stats?.reached || 0), done = Number(stats?.done || 0), here = Number(stats?.here || 0);
  const meter = doneField ? `<span class="fc-node__done"><span class="fc-node__line"><b>${num(done)}</b> of ${num(reached)} ${MD.esc(doneField.label.toLowerCase())}</span><span class="fc-meter" aria-hidden="true"><span style="width:${reached ? Math.round((done / reached) * 100) : 0}%"></span></span></span>` : '';
  const label = `${s.title}, ${recruitKindLabel(s.kind)}${loading ? '' : `: ${recruitPlural(here, 'person', 'people')} here now${doneField ? `, ${recruitNum(done)} of ${recruitNum(reached)} ${doneField.label.toLowerCase()}` : ''}`}`;
  const open = recruitOpenStage() === key;
  return `<div class="fc-node ${open ? 'is-open' : ''}" data-key="${MD.esc(key)}" style="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px">
    <a class="fc-node__main" href="${recruitStageHref(key)}" data-key="${MD.esc(key)}" aria-label="${MD.esc(label)}" ${open ? 'aria-current="true"' : ''}>
      <span class="fc-node__top">${recruitKindTagHtml(s.kind)}${site}</span>
      <span class="fc-node__title">${MD.esc(s.title)}</span>
      <span class="fc-node__here ${here || loading ? '' : 'is-none'}"><b>${num(here)}</b><span>here now</span></span>
      ${meter}
    </a>
    ${lead ? `<button type="button" class="icon-btn fc-node__more" data-action="recruit-flow-menu" data-key="${MD.esc(key)}" aria-label="Options for ${MD.esc(s.title)}" aria-haspopup="menu" title="Options">${I.dots}</button>
    <button type="button" class="fc-port" data-action="recruit-flow-port" data-key="${MD.esc(key)}" aria-label="Add after ${MD.esc(s.title)}, connect or split it" title="Add, connect or split; drag to a stage to connect" aria-haspopup="menu">${I.plus}</button>` : ''}
  </div>`;
}

// How many people passed along a connection (reached both its stages),
// entered at a first stage, or ended at a last one; null before the counts
// arrive.
function recruitFlowCount(e) {
  const ins = recruitState().insights?.data;
  if (!ins) return null;
  if (e.entry) return ins.stages?.find((x) => x.key === e.to)?.reached ?? null;
  if (e.outcome) return ins.stages?.find((x) => x.key === e.from)?.ended ?? null;
  const hit = (ins.edges || []).find((x) => x && x.from === e.from && x.to === e.to);
  return hit ? Number(hit.n) || 0 : null;
}

// A connection's count, and for a split the answers that take it; a lead
// opens the split from its label.
function recruitFlowLabelHtml(e, lead) {
  if (e.lx === undefined) return '';
  const n = recruitFlowCount(e);
  const num = n === null ? '–' : recruitNum(n);
  const who = n === 1 ? 'person' : 'people';
  const title = e.entry ? `${num} ${who} entered at ${recruitSectionTitle(e.to)}`
    : e.outcome ? `${num} ${who} ended at ${recruitSectionTitle(e.from)}`
    : `${num} ${who} went from ${recruitSectionTitle(e.from)} to ${recruitSectionTitle(e.to)}${e.label ? ` (${e.label})` : ''}`;
  const style = `left:${Math.round(e.lx)}px;top:${Math.round(e.ly)}px;max-width:${Math.max(40, Math.round(e.lw))}px`;
  const cls = `fc-flow ${e.split ? 'fc-flow--split' : ''} ${e.outcome ? 'fc-flow--end' : ''} ${n === 0 ? 'is-zero' : ''}`;
  const data = `data-from="${MD.esc(e.from || '')}" data-to="${MD.esc(e.to)}" style="${style}" title="${MD.esc(title)}"`;
  const inner = `${e.label ? `<span class="fc-flow__why">${MD.esc(e.label)}</span>` : ''}<b>${num}</b>`;
  return lead && e.split
    ? `<button type="button" class="${cls}" data-action="recruit-flow-split" data-key="${MD.esc(e.from)}" ${data} aria-label="${MD.esc(title)}. Edit the split">${inner}</button>`
    : `<span class="${cls}" ${data}>${inner}</span>`;
}

// How it ended: each status and how many people have it.
function recruitFlowOutcomeHtml(n) {
  const ins = recruitState().insights?.data;
  const rows = [['accepted', 'Accepted'], ['waitlisted', 'Waitlisted'], ['declined', 'Declined'], ['withdrew', 'Withdrew']];
  return `<div class="fc-node fc-node--outcome" style="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px" role="group" aria-label="Outcomes">
    <ul class="fc-outcome">${rows.map(([k, label]) => `<li><a href="${recruitPanelHref(recruitCycleRow().id, 'people', { status: k })}"><span>${label}</span><b>${ins ? recruitNum(ins.statuses?.[k]) : '–'}</b></a></li>`).join('')}</ul>
  </div>`;
}

function recruitFlowCanvasHtml(cycle) {
  const flow = recruitFlow(cycle);
  const lead = recruitCanEdit(cycle);
  const add = lead && flow.keys.length ? `<button type="button" class="fc-add" data-action="recruit-stage-new" aria-label="Add stage" title="Add stage">${I.plus}</button>` : '';
  const ins = recruitState().insights;
  const note = ins?.error && !ins.data ? `<p class="fc-note" role="status">Counts did not load: ${MD.esc(ins.error)} <button class="linklike" data-action="recruit-insights-retry">Retry</button></p>` : '';
  if (!flow.keys.length) return `<div class="fc-empty"><b>No stages yet</b>${lead ? '<p>Start with a form on the website, a meeting, a review, or any step the team tracks.</p><button class="btn btn--primary" data-action="recruit-stage-new">Add the first stage</button>' : '<p>A lead has not added any stages.</p>'}</div>`;
  const width = recruitFlowAvail();
  const layout = recruitFlowLayout(flow, { width });
  const W = Math.ceil(layout.width), H = Math.ceil(layout.height), k = layout.scale;
  const edges = layout.edges.map((e) => `<path class="fc-edge ${e.outcome ? 'fc-edge--outcome' : ''} ${e.entry ? 'fc-edge--entry' : ''} ${e.split ? 'fc-edge--split' : ''}" data-from="${MD.esc(e.from || '')}" data-to="${MD.esc(e.to)}" d="${e.d}" marker-end="url(#fc-arrow${e.outcome ? '-soft' : ''})"/>`).join('');
  const labels = layout.edges.map((e) => recruitFlowLabelHtml(e, lead)).join('');
  const nodes = [...layout.nodes.values()].map((n) => (n.key === FC_OUTCOME ? recruitFlowOutcomeHtml(n) : recruitFlowNodeHtml(cycle, flow, n))).join('');
  const focus = recruitOpenStage() ? 'is-focus' : '';
  return `${add}${note}<div class="fc-scroll" data-rc="flow-scroll"><div class="fc-sizer" data-rc="flow-sizer" style="width:${Math.ceil(W * k)}px;height:${Math.ceil(H * k)}px">
    <div class="fc-canvas fc-canvas--${layout.across ? 'across' : 'down'} ${focus}" data-rc="flow-canvas" data-width="${Math.round(width)}" data-scale="${k}" style="width:${W}px;height:${H}px${k < 1 ? `;transform:scale(${Math.round(k * 1000) / 1000})` : ''}">
      <svg class="fc-edges" width="${W}" height="${H}" aria-hidden="true">
        <defs><marker id="fc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1L9 5L0 9z"/></marker>
        <marker id="fc-arrow-soft" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1L9 5L0 9z"/></marker></defs>
        ${edges}<path class="fc-edge fc-edge--draft" data-rc="flow-draft" d=""/>
      </svg>${nodes}${labels}
    </div></div></div>`;
}

function recruitFlowView(cycle) {
  const st = recruitState();
  const held = st.cycles?.intakeCycleId === cycle.id && recruitIsAdmin() ? `<div data-rc="queue">${recruitPendingHtml()}</div>` : '';
  return `<div class="fc-wrap ${recruitCanEdit(cycle) ? 'has-add' : ''}" data-rc="flow">${recruitFlowCanvasHtml(cycle)}</div>${held}`;
}

// The chart repaints in place (counts arrive, a save lands, the width
// changes), keeping where it was scrolled and the panel's focus.
function recruitPaintFlow() {
  const host = $('[data-rc="flow"]');
  const cycle = recruitCycleRow();
  if (!host || !cycle) return false;
  recruitRepaint(host, recruitFlowCanvasHtml(cycle));
  recruitFlowSettle();
  return true;
}

// After the chart is drawn: its scroll place, its edge fades, and the pan
// that keeps an open stage's card clear of the panel.
function recruitFlowSettle({ animate = false } = {}) {
  const scroll = $('[data-rc="flow-scroll"]');
  if (!scroll) return;
  recruitFlowPlace(scroll);
  recruitFlowFades(scroll);
  if (typeof recruitStageFocusChart === 'function') recruitStageFocusChart({ animate });
}

// The chart is laid out for the width it was drawn at; when its zone is
// another width now (the first draw guessed, the window changed), it lays
// itself out again.
function recruitFlowFit() {
  const zone = $('[data-rc="flow"]');
  const canvas = zone ? $('[data-rc="flow-canvas"]', zone) : null;
  const now = (Number(zone?.clientWidth) || 0) - 2;
  if (canvas && now > 0 && Math.abs(now - Number(canvas.dataset.width || 0)) > 4) return recruitPaintFlow();
  return false;
}

// A chart wider than its zone opens where the flow starts (the left across,
// the middle down) and keeps its place when drawn again.
function recruitFlowPlace(scroll) {
  if (!scroll?.dataset || scroll.dataset.placed) return;
  scroll.dataset.placed = '1';
  const more = (Number(scroll.scrollWidth) || 0) - (Number(scroll.clientWidth) || 0);
  if (more <= 0) return;
  const down = Boolean(scroll.querySelector?.('.fc-canvas--down'));
  scroll.scrollLeft = recruitState().mod.flowLeft ?? (down ? Math.round(more / 2) : 0);
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

// Earlier or later within its column (up or down across, left or right on
// a narrow chart); the order also sorts stages everywhere else.
const recruitFlowAcross = () => recruitFlowAvail() >= FC.NARROW;
function recruitFlowNudge(key, delta) {
  const flow = recruitFlow();
  const rank = flow.ranks.get(key);
  const row = flow.order.filter((k) => flow.ranks.get(k) === rank);
  const i = row.indexOf(key), j = i + delta;
  if (j < 0 || j >= row.length) return;
  recruitFlowEdit((e) => {
    const a = e.order.indexOf(key), b = e.order.indexOf(row[j]);
    [e.order[a], e.order[b]] = [e.order[b], e.order[a]];
  }, `Moved ${recruitSectionTitle(key)} ${recruitFlowAcross() ? (delta < 0 ? 'up' : 'down') : (delta < 0 ? 'left' : 'right')}`);
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

// The + on a card: what comes after it.
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
    ...(row.length > 1 ? ['-', ...(at > 0 ? [{ label: recruitFlowAcross() ? 'Move up' : 'Move left', run: () => recruitFlowNudge(key, -1) }] : []), ...(at < row.length - 1 ? [{ label: recruitFlowAcross() ? 'Move down' : 'Move right', run: () => recruitFlowNudge(key, 1) }] : [])] : []),
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
  const layout = recruitFlowLayout(flow, { width: Number(canvas?.dataset.width) || recruitFlowAvail() });
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
    const k = Number(canvas.dataset.scale) || 1;
    const x = (e.clientX - box.left) / k, y = (e.clientY - box.top) / k;
    if (layout.across) {
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, d = Math.max(24, Math.abs(x - x1) / 2);
      draft.setAttribute('d', `M${x1} ${y1} C${x1 + d} ${y1}, ${x - d} ${y}, ${x} ${y}`);
    } else {
      const x1 = a.x + a.w / 2, y1 = a.y + a.h, d = Math.max(24, Math.abs(y - y1) / 2);
      draft.setAttribute('d', `M${x1} ${y1} C${x1} ${y1 + d}, ${x} ${y - d}, ${x} ${y}`);
    }
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
    timer = setTimeout(() => { if (!recruitFlowFit()) { const scroll = document.querySelector?.('[data-rc="flow-scroll"]'); if (scroll) recruitFlowFades(scroll); } }, 120);
  });
  document.addEventListener?.('scroll', (e) => {
    if (!e.target?.matches?.('[data-rc="flow-scroll"]')) return;
    recruitState().mod.flowLeft = e.target.scrollLeft;
    recruitFlowFades(e.target);
  }, true);
}

// What the chart needs once it is on the page, whichever view drew it.
function recruitFlowMounted(cycle, { animate = false } = {}) {
  const st = recruitState();
  if (!st.insights || st.insights.key !== st.key + ':' + cycle.id) recruitLoadInsights();
  if (st.cycles?.intakeCycleId === cycle.id && recruitIsAdmin() && st.queue === undefined) recruitLoadQueue();
  if (!recruitFlowFit()) recruitFlowSettle({ animate });
  // A stage's panel just closed: its card takes the focus back.
  const back = st.mod.returnFocus;
  st.mod.returnFocus = null;
  if (back && !recruitOpenStage()) $$('.fc-node__main').find((a) => a.dataset.key === back)?.focus?.({ preventScroll: true });
}

/* ------------------------------- register -------------------------------- */

RECRUIT.register({
  name: 'flow',
  order: 1,
  kernel: true,
  panels: [{ id: 'flow', label: 'Flow', icon: RC_ICONS.flow, order: 1, when: () => true }],
  view: (cycle) => recruitFlowView(cycle),
  mount(cycle) { recruitFlowMounted(cycle); },
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
