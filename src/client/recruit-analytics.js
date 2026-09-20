/* ----------------------- recruit: analytics (self-contained) ----------------
   Client half of lib/recruit/modules/analytics.js: plain tables for the
   funnel, breakdowns, reviewer throughput, time in stage, interviews and
   emails; export links; the retention block. Numbers only, no charts.
   State on UI.recruit.mod.analytics as undefined | {loading:true} | {error}
   | data, keyed by cycle; moves and decisions clear it. */

// recruit:analytics:start
'use strict';

const RC_AN_TIMEOUT = 20000;

function rcAnState() { UI.recruit.mod ||= {}; return UI.recruit.mod.analytics; }
function rcAnSet(v) { UI.recruit.mod ||= {}; UI.recruit.mod.analytics = v; }
function rcAnBusy() { return (UI.recruit.busy ||= new Set()); }
function rcAnMsg(e) { return e?.name === 'TimeoutError' ? 'The request timed out. Try again.' : e?.message || 'Something went wrong'; }
function rcAnStageName(cycle, key) { return (cycle?.doc?.pipeline?.stages || []).find((s) => s.key === key)?.name || key; }
function rcAnSubteamName(cycle, key) { if (!key) return 'Undecided'; return (cycle?.doc?.subteams || []).find((s) => s.key === key || s.name === key)?.name || key; }
function rcAnHours(h) { if (h === null || h === undefined) return '—'; return h >= 48 ? `${Math.round(h / 24)} d` : `${Math.round(h)} h`; }

/* ------------------------------- loading ---------------------------------- */

async function rcAnLoad(cycle, fresh) {
  const key = cycle.id;
  rcAnSet({ loading: true, key });
  const still = () => UI.recruit?.cycleId === key && rcAnState()?.key === key;
  try {
    const data = await RECRUIT.api(`/recruit/cycles/${key}/analytics${fresh ? '?fresh=1' : ''}`, { signal: AbortSignal.timeout(RC_AN_TIMEOUT) });
    if (!still()) return;
    rcAnSet({ key, data });
  } catch (e) {
    if (!still()) return;
    rcAnSet({ key, error: rcAnMsg(e) });
  }
  renderBackground('recruit');
}

function rcAnRefresh() {
  const cycle = UI.recruit?.cycle?.data;
  if (cycle) rcAnLoad(cycle, true);
}

/* -------------------------------- views ----------------------------------- */

function rcAnTable(label, head, rows, empty) {
  return `<div class="sheet"><div class="sheet__scroll"><table aria-label="${MD.esc(label)}">
    <thead><tr>${head.map((h, i) => `<th${i ? ' class="font-mono"' : ''}>${MD.esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.length ? rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="font-mono"' : ''}>${i ? MD.esc(String(c)) : c}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${head.length}" class="faint">${MD.esc(empty || 'Nothing yet.')}</td></tr>`}</tbody>
  </table></div></div>`;
}

function rcAnPivot(cycle, rows, groupKey, groupName) {
  const stages = [...new Set(rows.map((r) => r.stage))].sort((a, b) => (cycle?.doc?.pipeline?.stages || []).findIndex((s) => s.key === a) - (cycle?.doc?.pipeline?.stages || []).findIndex((s) => s.key === b));
  const groups = [...new Set(rows.map((r) => r[groupKey]))];
  const head = [groupName, 'Total', ...stages.map((s) => rcAnStageName(cycle, s))];
  const body = groups.map((g) => {
    const mine = rows.filter((r) => r[groupKey] === g);
    return [MD.esc(groupKey === 'subteam' ? rcAnSubteamName(cycle, g) : g || '—'), mine.reduce((n, r) => n + r.n, 0), ...stages.map((s) => mine.find((r) => r.stage === s)?.n || 0)];
  });
  return { head, body };
}

function rcAnRetentionHtml(cycle, role, data) {
  const r = data.retention || { months: 24, cycles: [] };
  const admin = role === 'admin';
  const due = (r.cycles || []).filter((c) => c.remaining > 0);
  const here = cycle.status === 'archived' && admin;
  return `<section class="admin-block"><div class="admin-block__head"><h2>Retention</h2><span class="count">${r.months} months</span></div>
    <p class="sheet__note">Personal data in archived cycles is kept ${r.months} months after closing. Nothing is removed automatically.</p>
    ${due.length ? `<div class="sheet sheet--list">${due.map((c) => `<div class="sheet__archive">
      <div><span class="sheet__archivetitle">${MD.esc(c.name)}</span><span class="sheet__archivemeta">closed ${MD.esc(recruitDate(c.closedAt))} · ${c.remaining} with personal data</span></div>
      ${admin ? `<button class="btn btn--sm btn--danger" data-action="recruit-an-purge" data-id="${MD.esc(c.id)}" data-name="${MD.esc(c.name)}" data-remaining="${c.remaining}">Purge personal data…</button>` : ''}
    </div>`).join('')}</div>` : ''}
    ${here && !due.some((c) => c.id === cycle.id) ? `<p><button class="btn btn--sm btn--danger" data-action="recruit-an-purge" data-id="${MD.esc(cycle.id)}" data-name="${MD.esc(cycle.name)}" data-remaining="${data.total || 0}">Purge this cycle’s personal data…</button></p>` : ''}
  </section>`;
}

function rcAnView(cycle, role) {
  const st = rcAnState();
  const head = `<div class="admin-block__head"><h2>Funnel</h2><span class="count">${st?.data?.total ?? ''}</span>
      <a class="btn btn--sm" href="/api/recruit/cycles/${MD.esc(cycle.id)}/export.csv" download>Export applications</a>
      <button class="icon-btn" data-action="recruit-an-refresh" aria-label="Refresh" title="Refresh">${I.history}</button></div>`;
  if (!st || st.loading || st.key !== cycle.id) return `<section class="admin-block">${head}<p class="sheet__note">Loading…</p></section>`;
  if (st.error) return `<section class="admin-block">${head}<p class="sheet__note">Could not load: ${MD.esc(st.error)}. <button class="linklike" data-action="recruit-an-refresh">Retry</button></p></section>`;
  const d = st.data;
  const sub = rcAnPivot(cycle, d.bySubteam || [], 'subteam', 'Subteam');
  const year = rcAnPivot(cycle, d.byYear || [], 'year', 'Year');
  const iv = d.interviews || {};
  const mail = d.mail || {};
  return `<div class="admin-grid">
    <section class="admin-block">${head}${rcAnTable('Funnel', ['Stage', 'People'], (d.funnel || []).map((f) => [MD.esc(rcAnStageName(cycle, f.stage)), f.n]))}</section>
    <section class="admin-block"><div class="admin-block__head"><h2>By subteam</h2></div>${rcAnTable('By subteam', sub.head, sub.body)}</section>
    <section class="admin-block"><div class="admin-block__head"><h2>By year</h2></div>${rcAnTable('By year', year.head, year.body)}</section>
    <section class="admin-block"><div class="admin-block__head"><h2>Received per day</h2></div>${rcAnTable('Received per day', ['Day', 'Applications'], (d.daily || []).slice(-31).map((x) => [MD.esc(x.day), x.n]))}</section>
    <section class="admin-block"><div class="admin-block__head"><h2>Reviewers</h2>${['admin', 'lead'].includes(role) ? `<a class="btn btn--sm" href="/api/recruit/cycles/${MD.esc(cycle.id)}/scores.csv" download>Export scores</a>` : ''}</div>
      ${rcAnTable('Reviewers', ['Reviewer', 'Assigned', 'Done', 'Mean', 'Median time'], (d.reviewers || []).map((r) => [MD.esc(typeof Store !== 'undefined' && Store.userName ? Store.userName(r.member) : r.member), r.assigned, r.done, r.mean ?? '—', rcAnHours(r.medianHours)]), 'No reviews yet.')}</section>
    <section class="admin-block"><div class="admin-block__head"><h2>Time in stage</h2></div>${rcAnTable('Time in stage', ['Stage', 'People', 'Median', '90th percentile'], (d.timeInStage || []).map((t) => [MD.esc(rcAnStageName(cycle, t.stage)), t.n, rcAnHours(t.medianHours), rcAnHours(t.p90Hours)]))}</section>
    <section class="admin-block"><div class="admin-block__head"><h2>Interviews</h2></div>${rcAnTable('Interviews', ['Measure', 'Count'], [['Slots', iv.slots || 0], ['Seats booked', iv.booked || 0], ['Invited', iv.invited || 0], ['Confirmed', iv.confirmed || 0], ['No-shows', iv.noShow || 0], ['Done', iv.done || 0]])}</section>
    <section class="admin-block"><div class="admin-block__head"><h2>Emails</h2><a class="btn btn--sm" href="/api/recruit/cycles/${MD.esc(cycle.id)}/mail.csv" download>Export log</a></div>${rcAnTable('Emails', ['Status', 'Count'], [['Sent', mail.sent || 0], ['Failed', mail.failed || 0], ['Queued', mail.queued || 0], ['Skipped', mail.skipped || 0]])}</section>
    <section class="admin-block"><div class="admin-block__head"><h2>Outcomes</h2></div>${rcAnTable('Outcomes', ['Outcome', 'People'], (d.outcomes || []).map((o) => [MD.esc(o.outcome), o.n]))}</section>
    ${rcAnRetentionHtml(cycle, role, d)}
  </div>`;
}

/* ------------------------------- actions ---------------------------------- */

function rcAnPurgeConfirm(el) {
  const id = el.dataset.id, name = el.dataset.name, remaining = Number(el.dataset.remaining) || 0;
  UI.modal = {
    kind: 'confirm', title: `Purge personal data from ${name}?`, danger: true, typed: name, confirm: 'Purge',
    text: `Names, emails, answers, files, notes, recipient addresses and interview tokens for ${remaining} ${remaining === 1 ? 'person' : 'people'} are removed. Counts, stages, scores and the activity log stay. This cannot be undone.`,
    onGo: () => rcAnPurge(id, name),
  };
  render();
}

async function rcAnPurge(id, name) {
  const key = 'an-purge-' + id;
  if (rcAnBusy().has(key)) return;
  rcAnBusy().add(key);
  let purged = 0;
  try {
    for (let page = 0; page < 200; page++) {
      const out = await RECRUIT.api(`/recruit/cycles/${id}/purge`, { method: 'POST', body: JSON.stringify({ confirm: name }), signal: AbortSignal.timeout(60000) });
      purged += out.purged || 0;
      if (!out.remaining || !out.purged) break;
    }
    toast(`Purged ${purged} ${purged === 1 ? 'person' : 'people'} from ${name}`);
  } catch (e) {
    toast(rcAnMsg(e));
  } finally { rcAnBusy().delete(key); }
  rcAnSet(undefined);
  rcAnRefresh();
}

/* ------------------------------- register --------------------------------- */

RECRUIT.register({
  name: 'analytics',
  order: 80,
  panel: { id: 'analytics', label: 'Analytics', when: (cycle, role) => cycle?.doc?.modules?.analytics !== false && (role === 'admin' || role === 'lead') },
  view: rcAnView,
  mount(cycle) {
    if (typeof REMOTE === 'undefined' || !cycle) return;
    const st = rcAnState();
    if (st === undefined || (st.key && st.key !== cycle.id)) rcAnLoad(cycle);
  },
  actions: {
    'recruit-an-refresh': (el, ev, stop) => { stop?.(); rcAnRefresh(); },
    'recruit-an-purge': (el, ev, stop) => { stop?.(); rcAnPurgeConfirm(el); },
  },
  inputs: {},
  dd: {},
  modals: {},
  columns: [],
  filters: [],
  selectionActions: () => [],
  detailSections: () => [],
  reset() { rcAnSet(undefined); },
});
// recruit:analytics:end
