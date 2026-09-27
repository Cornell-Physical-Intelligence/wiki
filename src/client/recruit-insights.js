/* ============================================================================
   Applications — insights module (client). The cycle in numbers: how far
   people got through each stage and how many finished it, where everyone is
   now, how they ended up, when the forms came in, who applied, and what the
   checklists hold (chats held, average scores, recommendations). One ink,
   two steps: the lighter one is "reached", the full ink is "done". Every
   chart can be read as a table, and every bar says its value on hover or
   focus.
   ========================================================================== */

'use strict';

// recruit:insights:start

// The counts behind the chart cards, the stage headers and this view. One
// request serves all three; each repaints when it lands.
function recruitLoadInsights({ quiet = false } = {}) {
  const st = recruitState();
  const cycle = recruitCycleRow();
  if (!cycle) return Promise.resolve();
  const key = st.key + ':' + cycle.id;
  if (!st.insights || st.insights.key !== key) st.insights = { key, data: null, loading: false, error: null, promise: null };
  const box = st.insights;
  if (box.loading) return box.promise;
  box.loading = true;
  if (!quiet) box.error = null;
  box.promise = RECRUIT.api(`/recruit/cycles/${encodeURIComponent(cycle.id)}/insights`)
    .then((data) => { if (st.insights === box) { box.data = data; box.error = null; } })
    .catch((e) => { if (st.insights === box && !box.data) box.error = recruitError(e); })
    .finally(() => { box.loading = false; if (st.insights === box) recruitInsightsChanged(); });
  return box.promise;
}

function recruitInsightsChanged() {
  recruitPaintFlow();
  for (const m of RECRUIT.modules) { try { m.insightsChanged?.(); } catch (e) { console.error(e); } }
}

const recruitPct = (n, of) => (of ? Math.round((n / of) * 100) : 0);

/* ------------------------------- pieces ---------------------------------- */

// A card holding one chart and its table twin, switched by one button.
function recruitChartCard(id, title, chart, table, { wide = false, note = '' } = {}) {
  const asTable = recruitState().insightTables?.has(id);
  return `<section class="ri-card ${wide ? 'ri-card--wide' : ''}" aria-labelledby="ri-${MD.esc(id)}-h" data-chart="${MD.esc(id)}">
    <header class="ri-card__head"><h3 id="ri-${MD.esc(id)}-h">${MD.esc(title)}</h3>${table ? `<button type="button" class="btn btn--sm btn--ghost ri-card__toggle" data-action="recruit-insight-table" data-chart="${MD.esc(id)}" aria-pressed="${Boolean(asTable)}">${asTable ? 'Chart' : 'Table'}</button>` : ''}</header>
    ${note ? `<p class="ri-card__note">${note}</p>` : ''}
    <div class="ri-card__body">${asTable && table ? table : chart}</div>
  </section>`;
}

const recruitTable = (head, rows) => `<div class="ri-table-wrap"><table class="ri-table"><thead><tr>${head.map((h, i) => `<th ${i ? 'class="num"' : ''}>${MD.esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td ${i ? 'class="num"' : ''}>${MD.esc(String(c))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

// Horizontal bars on one baseline: label, bar, value at the tip. `soft`
// stacks a lighter segment after the ink one, up to `r.soft` (reached, of
// which `r.value` are done), with a 2px gap between the two.
function recruitBarsHtml(rows, { max = null, soft = false, href = null } = {}) {
  const top = max ?? Math.max(1, ...rows.map((r) => (soft ? r.soft : r.value) || 0));
  if (!rows.length) return '<p class="faint">Nothing yet.</p>';
  const pct = (v) => Math.max(0, Math.min(100, (v / top) * 100));
  return `<ul class="ri-bars">${rows.map((r) => {
    const tip = r.tip || `${r.label}: ${recruitNum(r.value)}`;
    const label = href && r.key ? `<a href="${href(r.key)}">${MD.esc(r.label)}</a>` : MD.esc(r.label);
    const ink = pct(r.value || 0), rest = soft ? pct(r.soft || 0) - ink : 0;
    const tail = rest > 0 ? `<span class="ri-bar__fill ri-bar__fill--soft" style="left:calc(${ink}% + ${ink ? 2 : 0}px);width:calc(${rest}% - ${ink ? 2 : 0}px)"></span>` : '';
    return `<li class="ri-bar"><span class="ri-bar__label">${label}</span>
      <span class="ri-bar__track" tabindex="0" data-tip="${MD.esc(tip)}" aria-label="${MD.esc(tip)}">${ink ? `<span class="ri-bar__fill${tail ? ' ri-bar__fill--head' : ''}" style="width:${ink}%"></span>` : ''}${tail}</span>
      <span class="ri-bar__value">${r.valueText ?? recruitNum(r.value)}</span></li>`;
  }).join('')}</ul>`;
}

// A done-of-reached meter, full ink on the lighter step of the same ink.
const recruitMeterHtml = (n, of, label) => `<span class="ri-meter" tabindex="0" data-tip="${MD.esc(`${label}: ${recruitNum(n)} of ${recruitNum(of)}`)}" role="img" aria-label="${MD.esc(`${label}: ${recruitNum(n)} of ${recruitNum(of)}`)}"><span style="width:${recruitPct(n, of)}%"></span></span>`;

/* ------------------------------- the charts ------------------------------ */

function recruitKpisHtml(d) {
  const id = recruitCycleRow().id;
  const tile = (label, value, href, sub = '') => `<a class="ri-kpi" href="${href}"><span class="ri-kpi__label">${label}</span><span class="ri-kpi__value">${value}</span>${sub ? `<span class="ri-kpi__sub">${sub}</span>` : ''}</a>`;
  const decided = d.statuses.accepted + d.statuses.declined + d.statuses.waitlisted + d.statuses.withdrew;
  return `<div class="ri-kpis">
    ${tile('People', recruitNum(d.people), recruitPanelHref(id, 'people'))}
    ${tile('Still active', recruitNum(d.statuses.active), recruitPanelHref(id, 'people', { status: 'active' }), d.people ? `${recruitPct(d.statuses.active, d.people)}% of everyone` : '')}
    ${tile('Accepted', recruitNum(d.statuses.accepted), recruitPanelHref(id, 'people', { status: 'accepted' }), decided ? `${recruitPct(d.statuses.accepted, decided)}% of decisions` : '')}
    ${tile('Median time in cycle', `${recruitNum(d.medianDays)}<small>${d.medianDays === 1 ? 'day' : 'days'}</small>`, recruitPanelHref(id, 'people'))}
    ${tile('Flagged', recruitNum(d.flagged), recruitPanelHref(id, 'people', { review: 'flagged' }), `${recruitNum(d.commented)} with comments`)}
  </div>`;
}

// How far people got: for each stage, everyone who reached it (the whole
// bar, as a share of everyone), split into done (ink) and not done (lighter).
function recruitFunnelCard(d) {
  const rows = d.stages.map((s) => ({ key: s.key, label: s.title, soft: s.reached, value: s.done, valueText: `${recruitNum(s.reached)}<small>${recruitNum(s.done)} done</small>`, tip: `${s.title}: ${recruitNum(s.reached)} reached (${recruitPct(s.reached, d.people)}% of everyone), ${recruitNum(s.done)} done` }));
  const chart = `<div class="ri-legend"><span><i class="ri-key"></i>Done</span><span><i class="ri-key ri-key--soft"></i>Reached, not done</span></div>${recruitBarsHtml(rows, { soft: true, max: Math.max(1, d.people), href: (k) => recruitStageHref(k) })}`;
  const table = recruitTable(['Stage', 'Reached', 'Share of everyone', 'Done', 'Done of reached'], d.stages.map((s) => [s.title, recruitNum(s.reached), `${recruitPct(s.reached, d.people)}%`, recruitNum(s.done), `${recruitPct(s.done, s.reached)}%`]));
  return recruitChartCard('funnel', 'How far people got', chart, table, { wide: true });
}

function recruitNowCard(d) {
  const rows = d.stages.map((s) => ({ key: s.key, label: s.title, value: s.here, tip: `${s.title}: ${recruitPlural(s.here, 'person', 'people')} here now` }));
  const chart = recruitBarsHtml(rows, { href: (k) => recruitStageHref(k) });
  return recruitChartCard('now', 'Where active people are now', chart, recruitTable(['Stage', 'Active here', 'Declined here'], d.stages.map((s) => [s.title, recruitNum(s.here), recruitNum(s.declined)])));
}

function recruitOutcomesCard(d) {
  const rows = RECRUIT_STATUSES.map((s) => ({ key: s.value, label: s.label, value: d.statuses[s.value] || 0, tip: `${s.label}: ${recruitNum(d.statuses[s.value] || 0)} (${recruitPct(d.statuses[s.value] || 0, d.people)}%)` }));
  return recruitChartCard('outcomes', 'Status', recruitBarsHtml(rows, { href: (k) => recruitPanelHref(recruitCycleRow().id, 'people', { status: k }) }), recruitTable(['Status', 'People', 'Share'], rows.map((r) => [r.label, recruitNum(r.value), `${recruitPct(r.value, d.people)}%`])));
}

function recruitWhoCard(d, key, title) {
  const list = d[key] || [];
  const rows = list.slice(0, 10).map((x) => ({ key: x.name, label: x.name, value: x.n, tip: `${x.name}: ${recruitPlural(x.n, 'person', 'people')}` }));
  const rest = list.slice(10).reduce((a, x) => a + x.n, 0);
  if (rest) rows.push({ label: 'Others', value: rest, tip: `Others: ${recruitPlural(rest, 'person', 'people')}` });
  return recruitChartCard(key, title, recruitBarsHtml(rows), recruitTable([title, 'People'], list.map((x) => [x.name, recruitNum(x.n)])));
}

// Forms sent per day, one small chart per form on one shared scale, so a
// busy day reads the same in every row.
function recruitDailyCard(d) {
  const forms = d.stages.filter((s) => s.form);
  const days = d.daily.map((x) => x.day);
  if (!days.length || !forms.length) return recruitChartCard('daily', 'Forms sent per day', '<p class="faint">No forms sent in the last 60 days.</p>', '');
  const all = recruitDayRange(days[0], days.at(-1));
  const by = new Map(d.daily.map((x) => [x.day, x.counts]));
  const max = Math.max(1, ...d.daily.flatMap((x) => Object.values(x.counts)));
  const fmt = (day) => new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const chart = `<div class="ri-daily">${forms.map((s) => {
    const total = all.reduce((a, day) => a + (by.get(day)?.[s.key] || 0), 0);
    return `<div class="ri-daily__row"><span class="ri-daily__label">${MD.esc(s.title)}<small>${recruitNum(total)}</small></span>
      <span class="ri-daily__cols" style="--days:${all.length}">${all.map((day) => { const n = by.get(day)?.[s.key] || 0; const tip = `${fmt(day)} · ${s.title}: ${recruitPlural(n, 'form')}`; return `<span class="ri-col" tabindex="0" data-tip="${MD.esc(tip)}" aria-label="${MD.esc(tip)}"><span style="height:${n ? Math.max(6, (n / max) * 100) : 0}%"></span></span>`; }).join('')}</span></div>`;
  }).join('')}<div class="ri-daily__axis"><span></span><span class="ri-daily__ticks"><span>${MD.esc(fmt(all[0]))}</span><span>Busiest day: ${recruitNum(max)}</span><span>${MD.esc(fmt(all.at(-1)))}</span></span></div></div>`;
  const table = recruitTable(['Day', ...forms.map((s) => s.title)], all.filter((day) => by.has(day)).reverse().map((day) => [fmt(day), ...forms.map((s) => recruitNum(by.get(day)?.[s.key] || 0))]));
  return recruitChartCard('daily', 'Forms sent per day', chart, table, { wide: true });
}

// Every calendar day between two, inclusive.
function recruitDayRange(a, b) {
  const out = [];
  const end = Date.parse(b + 'T12:00:00Z');
  for (let t = Date.parse(a + 'T12:00:00Z'); t <= end && out.length < 400; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

// What one checklist field adds up to across everyone who reached the stage.
function recruitFieldInsightHtml(stage, f) {
  const s = f.summary || {};
  const team = recruitState().cycle?.team || [];
  const name = (v) => (f.type === 'member' ? team.find((m) => m.email === v)?.name || v : v);
  switch (f.type) {
    case 'check':
      return `<div class="ri-field__big"><b>${recruitNum(s.yes)}</b><span>of ${recruitNum(s.of)} · ${recruitPct(s.yes, s.of)}%</span></div>${recruitMeterHtml(s.yes || 0, s.of || 0, f.label)}`;
    case 'rating': {
      const dist = (s.dist || []).map((n, i) => ({ label: `${i + 1}`, value: n, tip: `${f.label} ${i + 1}: ${recruitPlural(n, 'answer')}` }));
      return `<div class="ri-field__big"><b>${s.avg === null || s.avg === undefined ? '—' : MD.esc(String(s.avg))}</b><span>average of ${recruitPlural(s.n || 0, 'answer')}${f.each ? ` for ${recruitPlural(s.people || 0, 'person', 'people')}` : ''}</span></div>${s.n ? recruitBarsHtml(dist.reverse()) : ''}`;
    }
    case 'number':
      return `<div class="ri-field__big"><b>${s.avg === null || s.avg === undefined ? '—' : MD.esc(String(s.avg))}</b><span>average${s.n ? ` · ${MD.esc(String(s.min))} to ${MD.esc(String(s.max))}` : ''}</span></div>`;
    case 'choice':
      return s.n ? recruitBarsHtml(Object.entries(s.counts || {}).map(([k, n]) => ({ label: k, value: n, tip: `${f.label}: ${k}, ${recruitPlural(n, 'answer')}` }))) : '<p class="faint">No answers yet.</p>';
    case 'text': case 'member':
      return s.n ? recruitBarsHtml((s.top || []).map((x) => ({ label: name(x.value), value: x.n, tip: `${f.label}: ${name(x.value)}, ${recruitNum(x.n)}` }))) : '<p class="faint">Nothing filled in yet.</p>';
    case 'date':
      return s.n ? `<div class="ri-field__big"><b>${recruitNum(s.n)}</b><span>${MD.esc(s.first)} to ${MD.esc(s.last)}</span></div>` : '<p class="faint">No dates yet.</p>';
    default:
      return `<div class="ri-field__big"><b>${recruitNum(s.n || 0)}</b><span>${f.type === 'note' ? (s.n === 1 ? 'note' : 'notes') : 'filled in'}</span></div>`;
  }
}

function recruitChecklistsHtml(d) {
  const stages = d.stages.filter((s) => s.fields.length);
  if (!stages.length) return '';
  return `<h2 class="ri-h">Checklists</h2><div class="ri-grid">${stages.map((s) => recruitChartCard(`ck-${s.key}`, s.title,
    `<p class="ri-card__sub">${recruitPlural(s.reached, 'person', 'people')} reached this stage</p><div class="ri-fields">${s.fields.map((f) => `<div class="ri-field"><h4>${recruitFieldIcon(f.type)}${MD.esc(f.label)}${f.each ? '<small>each reviewer</small>' : ''}</h4>${recruitFieldInsightHtml(s, f)}</div>`).join('')}</div>`,
    recruitTable(['Field', 'Summary'], s.fields.map((f) => [f.label, recruitFieldInsightText(f)])),
  )).join('')}</div>`;
}

function recruitFieldInsightText(f) {
  const s = f.summary || {};
  if (f.type === 'check') return `${s.yes || 0} of ${s.of || 0} (${recruitPct(s.yes, s.of)}%)`;
  if (f.type === 'rating' || f.type === 'number') return s.n ? `average ${s.avg} from ${s.n}` : 'no answers';
  if (f.type === 'choice') return Object.entries(s.counts || {}).map(([k, n]) => `${k}: ${n}`).join('; ') || 'no answers';
  if (f.type === 'text' || f.type === 'member') return (s.top || []).map((x) => `${x.value}: ${x.n}`).join('; ') || 'none';
  if (f.type === 'date') return s.n ? `${s.first} to ${s.last}` : 'none';
  return `${s.n || 0} filled in`;
}

function recruitInsightsView(cycle) {
  const st = recruitState();
  const box = st.insights;
  const d = box?.key === st.key + ':' + cycle.id ? box.data : null;
  if (!d) return box?.error ? `<p class="sheet__note">Could not load: ${MD.esc(box.error)}. <button class="linklike" data-action="recruit-insights-retry">Retry</button></p>` : '<p class="sheet__note">Loading…</p>';
  if (!d.people) return `<div class="rc-empty-card"><b>No one yet</b><p>Numbers appear here once people send a form.</p></div>`;
  return `<div class="ri ${box.loading ? 'is-refreshing' : ''}" data-rc="insights">
    ${recruitKpisHtml(d)}
    <div class="ri-grid">
      ${recruitFunnelCard(d)}
      ${recruitNowCard(d)}
      ${recruitOutcomesCard(d)}
      ${recruitDailyCard(d)}
      ${recruitWhoCard(d, 'subteams', 'Subteam')}
      ${recruitWhoCard(d, 'years', 'Year')}
    </div>
    ${recruitChecklistsHtml(d)}
  </div>`;
}

function recruitPaintInsights() {
  const host = $('[data-rc="insights"]');
  const cycle = recruitCycleRow();
  if (!host || !cycle || recruitActivePanel()?.id !== 'insights') return false;
  const holder = document.createElement('div');
  holder.innerHTML = recruitInsightsView(cycle);
  const fresh = holder.firstElementChild || holder.children?.[0];
  if (fresh?.dataset?.rc === 'insights') { recruitRepaint(host, fresh.innerHTML); host.className = fresh.className; }
  else renderBackground('recruit');
  return true;
}

/* ------------------------------- the tooltip ----------------------------- */

// One floating tip for every mark that carries data-tip, on hover and focus.
function recruitTipShow(el) {
  if (!el?.dataset?.tip || typeof document.createElement !== 'function') return;
  let tip = document.querySelector?.('.ri-tip');
  if (!tip) { tip = document.createElement('div'); tip.className = 'ri-tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  if (typeof el.getBoundingClientRect !== 'function') return;
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth || 160, h = tip.offsetHeight || 28;
  const left = Math.max(8, Math.min((window.innerWidth || 1024) - w - 8, r.left + r.width / 2 - w / 2));
  const top = r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
function recruitTipHide() { const tip = document.querySelector?.('.ri-tip'); if (tip) tip.hidden = true; }

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  const target = (ev) => (typeof ev.target?.closest === 'function' ? ev.target.closest('[data-tip]') : null);
  document.addEventListener('pointerover', (ev) => { const el = target(ev); if (el) recruitTipShow(el); else recruitTipHide(); });
  document.addEventListener('focusin', (ev) => { const el = target(ev); if (el) recruitTipShow(el); else recruitTipHide(); });
  document.addEventListener('focusout', () => recruitTipHide());
  document.addEventListener('scroll', () => recruitTipHide(), true);
}

/* ------------------------------- register -------------------------------- */

RECRUIT.register({
  name: 'insights',
  order: 5,
  kernel: true,
  panels: [{ id: 'insights', label: 'Insights', icon: RC_ICONS.insights, order: 3, when: () => true }],
  view: (cycle) => recruitInsightsView(cycle),
  mount(cycle) {
    const st = recruitState();
    if (!st.insights || st.insights.key !== st.key + ':' + cycle.id || (!st.insights.data && !st.insights.loading)) recruitLoadInsights();
  },
  refresh: { load: () => recruitLoadInsights({ quiet: true }), every: RECRUIT_SYNC_MS },
  insightsChanged: () => recruitPaintInsights(),
  actions: {
    'recruit-insights-retry': () => { const st = recruitState(); if (st.insights) st.insights.error = null; recruitLoadInsights(); renderBackground('recruit'); },
    'recruit-insight-table': (el) => {
      const st = recruitState();
      st.insightTables ||= new Set();
      const id = el.dataset.chart;
      if (st.insightTables.has(id)) st.insightTables.delete(id); else st.insightTables.add(id);
      recruitPaintInsights();
      $(`[data-action="recruit-insight-table"][data-chart="${id}"]`)?.focus({ preventScroll: true });
    },
  },
  reset() { const st = recruitState(); st.insights = undefined; },
});

// recruit:insights:end
