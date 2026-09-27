// The recruitment flow: a cycle's stages as a directed graph, the checklist
// each stage keeps for the team, and where every person stands. Pure: no
// storage and no imports. sections.js owns each stage's saved shape and its
// website form; this file owns the graph, the checklist fields, the values a
// person's track stores, and everything derived from them (positions, stage
// states, list summaries, insights).

export const STAGE_KINDS = ['form', 'meeting', 'review', 'step'];
export const FIELD_TYPES = ['check', 'rating', 'choice', 'text', 'note', 'number', 'date', 'member'];
// Types each reviewer answers for themselves: a score, a recommendation, notes.
export const EACH_TYPES = ['rating', 'choice', 'text', 'note', 'number'];
export const STATUSES = ['active', 'accepted', 'waitlisted', 'declined', 'withdrew'];
export const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_FIELDS = 20;
export const MAX_MOVES = 200;
const MAX_OPTIONS = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DAY = 86400000;

const isObject = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const fail = (status, error) => Object.assign(new Error(error), { status, error });
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/* ------------------------------- checklist fields ------------------------ */

function cleanField(raw, i) {
  if (!isObject(raw)) throw fail(400, 'Each checklist field needs a label and a type');
  const key = String(raw.key || '');
  if (!FIELD_KEY.test(key)) throw fail(400, `Checklist field ${i + 1} needs a key of lowercase letters, digits or underscores`);
  if (!FIELD_TYPES.includes(raw.type)) throw fail(400, `Checklist field "${key}" has an unknown type`);
  const label = clip(raw.label, 80);
  if (!label) throw fail(400, `Checklist field ${i + 1} needs a label`);
  const out = { key, type: raw.type, label };
  const help = clip(raw.help, 200);
  if (help) out.help = help;
  if (raw.type === 'choice') {
    const options = [...new Set((Array.isArray(raw.options) ? raw.options : []).map((o) => clip(o, 60)).filter(Boolean))];
    if (!options.length) throw fail(400, `"${label}" needs at least one choice`);
    if (options.length > MAX_OPTIONS) throw fail(400, `"${label}" can have up to ${MAX_OPTIONS} choices`);
    out.options = options;
  }
  if (raw.type === 'rating') {
    const max = raw.max === undefined || raw.max === null ? 5 : Number(raw.max);
    if (!Number.isInteger(max) || max < 3 || max > 10) throw fail(400, `"${label}" rates from 1 to between 3 and 10`);
    out.max = max;
  }
  if (raw.each === true) {
    if (!EACH_TYPES.includes(raw.type)) throw fail(400, `"${label}" holds one answer for the whole team`);
    out.each = true;
  }
  return out;
}

// A stage's checklist as saved. Strict for edits; lenient on read, where a
// field that no longer validates is dropped instead of breaking the cycle.
export function cleanFields(list, { lenient = false } = {}) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) { if (lenient) return []; throw fail(400, 'Checklist fields must be a list'); }
  if (list.length > MAX_FIELDS && !lenient) throw fail(400, `Keep a stage to ${MAX_FIELDS} checklist fields`);
  const out = [];
  const seen = new Set();
  for (const [i, raw] of list.slice(0, MAX_FIELDS).entries()) {
    let field;
    try { field = cleanField(raw, i); } catch (e) { if (lenient) continue; throw e; }
    if (seen.has(field.key)) { if (lenient) continue; throw fail(400, `Checklist field "${field.key}" is listed twice`); }
    seen.add(field.key);
    out.push(field);
  }
  return out;
}

// The checkbox that marks a stage done, when the stage names one.
export const doneFieldOf = (stage) => (stage?.done ? (stage.fields || []).find((f) => f.key === stage.done && f.type === 'check' && !f.each) || null : null);

const validDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
};

// One value for one field, as a reviewer sent it. null clears it.
export function cleanValue(field, value, { members = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const label = field.label || field.key;
  switch (field.type) {
    case 'check':
      if (typeof value !== 'boolean') throw fail(400, `${label} is checked or not`);
      return value;
    case 'rating': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > (field.max || 5)) throw fail(400, `${label} is a whole number from 1 to ${field.max || 5}`);
      return n;
    }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(n) || Math.abs(n) > 1e9) throw fail(400, `${label} must be a number`);
      return Math.round(n * 10000) / 10000;
    }
    case 'choice': {
      const v = clip(value, 60);
      if (!(field.options || []).includes(v)) throw fail(400, `Choose one of the options for ${label}`);
      return v;
    }
    case 'text': return clip(value, 200) || null;
    case 'note': {
      const v = String(value).replace(/\r\n?/g, '\n').trim();
      if (v.length > 4000) throw fail(400, `${label} is capped at 4,000 characters`);
      return v || null;
    }
    case 'date': {
      const v = String(value).trim();
      if (!validDate(v)) throw fail(400, `${label} is a date like 2026-10-03`);
      return v;
    }
    case 'member': {
      const v = String(value).trim().toLowerCase();
      if (!EMAIL_RE.test(v)) throw fail(400, `Choose a person for ${label}`);
      if (members && !members.includes(v)) throw fail(400, `Choose someone on this cycle's team for ${label}`);
      return v;
    }
    default:
      throw fail(400, `${label} has an unknown type`);
  }
}

// Whether a stored entry holds anything.
const filled = (v) => v !== null && v !== undefined && v !== '' && v !== false;

/* ------------------------------- the graph ------------------------------- */

// Where each stage leads. A stage with a saved `next` list leads exactly
// there; one without (every stage of a cycle made before the flow chart)
// leads to the stage after it in the cycle's order, so older cycles read as
// the straight line they always were.
export function edgesOf(sections) {
  const keys = Object.keys(sections || {});
  const live = new Set(keys);
  const edges = new Map();
  keys.forEach((key, i) => {
    const s = sections[key];
    const list = Array.isArray(s?.next) ? s.next : i + 1 < keys.length ? [keys[i + 1]] : [];
    edges.set(key, [...new Set(list.map(String))].filter((k) => k !== key && live.has(k)));
  });
  return edges;
}

// A stage that can reach itself, or null. A loop would leave a person with no
// way to finish, so edits that make one are refused.
export function loopIn(edges) {
  const state = new Map();
  const visit = (k) => {
    state.set(k, 1);
    for (const n of edges.get(k) || []) {
      if (state.get(n) === 1) return n;
      if (!state.get(n)) { const hit = visit(n); if (hit) return hit; }
    }
    state.set(k, 2);
    return null;
  };
  for (const k of edges.keys()) if (!state.get(k)) { const hit = visit(k); if (hit) return hit; }
  return null;
}

// Columns of the chart: a stage sits one step past the furthest stage that
// leads to it. Stages caught in a loop (only in data written by hand) keep
// the column their order gives them.
export function ranksOf(edges) {
  const keys = [...edges.keys()];
  const indegree = new Map(keys.map((k) => [k, 0]));
  for (const to of edges.values()) for (const k of to) indegree.set(k, indegree.get(k) + 1);
  const rank = new Map(keys.map((k) => [k, 0]));
  const queue = keys.filter((k) => indegree.get(k) === 0);
  const seen = new Set();
  while (queue.length) {
    const k = queue.shift();
    seen.add(k);
    for (const n of edges.get(k)) {
      rank.set(n, Math.max(rank.get(n), rank.get(k) + 1));
      indegree.set(n, indegree.get(n) - 1);
      if (indegree.get(n) === 0) queue.push(n);
    }
  }
  keys.forEach((k, i) => { if (!seen.has(k)) rank.set(k, Math.max(rank.get(k), i)); });
  return rank;
}

// Stages in the order a person meets them: by column, then the cycle's order.
export function flowKeys(sections, ranks = ranksOf(edgesOf(sections))) {
  const keys = Object.keys(sections || {});
  return keys.map((k, i) => ({ k, i, r: ranks.get(k) ?? 0 })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.k);
}

// Everything the other helpers need about a cycle's stages, computed once.
export function flowOf(sections) {
  const edges = edgesOf(sections);
  const ranks = ranksOf(edges);
  return { sections, edges, ranks, keys: flowKeys(sections, ranks) };
}

/* ------------------------------- a person -------------------------------- */

// Where a person stands. The team's last move places them; a form they send
// after that move, for a later stage, moves them on; before any move their
// furthest form places them. A tie goes to the newer activity.
export function positionOf(flow, submissions, track) {
  const known = (k) => Object.hasOwn(flow.sections, k);
  const moved = track?.stage && known(track.stage) ? { stage: track.stage, ts: Number(track.stageAt) || 0 } : null;
  const candidates = (submissions || [])
    .filter((s) => known(s.section) && (!moved || Number(s.ts) > moved.ts))
    .map((s) => ({ stage: s.section, ts: Number(s.ts) || 0 }));
  if (moved) candidates.push(moved);
  let best = null;
  for (const c of candidates) {
    const r = flow.ranks.get(c.stage) ?? 0, br = best ? flow.ranks.get(best.stage) ?? 0 : -1;
    if (!best || r > br || (r === br && c.ts > best.ts)) best = c;
  }
  return best?.stage || null;
}

const statusOf = (track) => (STATUSES.includes(track?.status) ? track.status : 'active');

// What the list, the chart and the person page say about a person at each
// stage: 'current' (where they stand), 'done', 'open' (reached, not done:
// a coffee chat requested and never held), 'skipped' (behind them, never
// reached) or 'ahead'.
export function personFlow(flow, submissions, track) {
  const position = positionOf(flow, submissions, track);
  const at = position ? flow.ranks.get(position) ?? 0 : -1;
  const sent = new Map();
  for (const s of submissions || []) if (!sent.has(s.section) || Number(s.ts) < sent.get(s.section)) sent.set(s.section, Number(s.ts) || 0);
  const movedTo = new Set([...(Array.isArray(track?.moves) ? track.moves : []).map((m) => m?.stage?.to), track?.stage].filter(Boolean));
  const states = {};
  const done = {};
  for (const key of flow.keys) {
    const stage = flow.sections[key];
    const values = isObject(track?.fields?.[key]) ? track.fields[key] : {};
    const recorded = (stage.fields || []).some((f) => {
      const v = values[f.key];
      if (!isObject(v)) return false;
      return f.each ? Object.values(isObject(v.each) ? v.each : {}).some((e) => filled(e?.v)) : filled(v.v);
    });
    const reached = sent.has(key) || movedTo.has(key) || recorded || key === position;
    const check = doneFieldOf(stage);
    done[key] = check ? values[check.key]?.v === true : stage.form ? sent.has(key) : reached && (flow.ranks.get(key) ?? 0) < at;
    states[key] = key === position ? 'current' : reached ? (done[key] ? 'done' : 'open') : (flow.ranks.get(key) ?? 0) < at ? 'skipped' : 'ahead';
  }
  return { stage: position, status: statusOf(track), states, done, sent: Object.fromEntries(sent) };
}

// A field's value as a list row shows it. One answer for the team is the
// value; per-reviewer answers are summarized, with the reader's own answer.
export function fieldSummary(field, stored, me = '') {
  if (!isObject(stored)) return null;
  if (!field.each) return filled(stored.v) || stored.v === false ? stored.v : null;
  const entries = Object.entries(isObject(stored.each) ? stored.each : {}).filter(([, e]) => filled(e?.v));
  if (!entries.length) return null;
  const mine = entries.find(([who]) => who === me)?.[1]?.v ?? null;
  if (field.type === 'rating' || field.type === 'number') {
    const nums = entries.map(([, e]) => Number(e.v)).filter(Number.isFinite);
    return { n: nums.length, avg: nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null, mine };
  }
  if (field.type === 'choice') {
    const counts = {};
    for (const [, e] of entries) counts[e.v] = (counts[e.v] || 0) + 1;
    return { n: entries.length, counts, mine };
  }
  return { n: entries.length, mine };
}

// Every field of every stage for one list row.
export function fieldsSummary(flow, track, me = '') {
  const out = {};
  for (const key of flow.keys) {
    const fields = flow.sections[key].fields || [];
    if (!fields.length) continue;
    const values = isObject(track?.fields?.[key]) ? track.fields[key] : {};
    const row = {};
    for (const f of fields) {
      const v = fieldSummary(f, values[f.key], me);
      if (v !== null) row[f.key] = v;
    }
    if (Object.keys(row).length) out[key] = row;
  }
  return out;
}

// A move appended to the track's history, trimmed to the newest entries.
export function withMove(moves, entry) {
  const list = Array.isArray(moves) ? moves : [];
  return [...list, entry].slice(-MAX_MOVES);
}

/* ------------------------------- insights -------------------------------- */

// The calendar day in Eastern time, which is how the club counts deadlines.
const easternDay = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Number(ts)));

function fieldInsight(field, values, reachedEmails) {
  const shared = [];
  const each = [];
  for (const [email, stored] of values) {
    if (!reachedEmails.has(email) || !isObject(stored)) continue;
    if (field.each) { for (const [who, e] of Object.entries(isObject(stored.each) ? stored.each : {})) if (filled(e?.v)) each.push({ email, who, v: e.v }); }
    else if (filled(stored.v) || stored.v === false) shared.push({ email, v: stored.v });
  }
  const list = field.each ? each : shared;
  if (field.type === 'check') {
    const yes = shared.filter((x) => x.v === true).length;
    return { yes, of: reachedEmails.size };
  }
  if (field.type === 'rating' || field.type === 'number') {
    const nums = list.map((x) => Number(x.v)).filter(Number.isFinite);
    const out = { n: nums.length, people: new Set(list.map((x) => x.email)).size, avg: nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null };
    if (field.type === 'rating') { out.max = field.max || 5; out.dist = Array.from({ length: out.max }, (_, i) => nums.filter((n) => n === i + 1).length); }
    else if (nums.length) { out.min = Math.min(...nums); out.max = Math.max(...nums); }
    return out;
  }
  if (field.type === 'choice') {
    const counts = Object.fromEntries((field.options || []).map((o) => [o, 0]));
    for (const x of list) counts[x.v] = (counts[x.v] || 0) + 1;
    return { n: list.length, counts };
  }
  if (field.type === 'text' || field.type === 'member') {
    const tally = new Map();
    for (const x of list) {
      const k = String(x.v).trim().toLowerCase();
      const t = tally.get(k) || { value: String(x.v).trim(), n: 0 };
      t.n += 1;
      tally.set(k, t);
    }
    return { n: list.length, top: [...tally.values()].sort((a, b) => b.n - a.n || a.value.localeCompare(b.value)).slice(0, 8) };
  }
  if (field.type === 'date') {
    const days = list.map((x) => String(x.v)).sort();
    return { n: days.length, first: days[0] || null, last: days.at(-1) || null };
  }
  return { n: list.length };
}

// The cycle at a glance: statuses, each stage's reach and completion, what
// the checklists hold, submissions by day, and who the people are. `people`
// rows carry { email, subteam, year, flagged, comments, submissions, track }.
export function insightsFor(flow, people, { now = Date.now(), days = 60 } = {}) {
  const statuses = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const perStage = new Map(flow.keys.map((k) => [k, { here: 0, reached: 0, done: 0, responses: 0, declined: 0, reachedEmails: new Set(), values: [] }]));
  const subteams = new Map(), years = new Map(), daily = new Map();
  let flagged = 0, commented = 0, first = Infinity;
  const spans = [];
  for (const p of people) {
    const pf = personFlow(flow, p.submissions, p.track);
    statuses[pf.status] += 1;
    if (p.flagged) flagged += 1;
    if (p.comments > 0) commented += 1;
    const team = String(p.subteam || '').trim() || 'Undecided';
    subteams.set(team, (subteams.get(team) || 0) + 1);
    const year = String(p.year || '').trim() || 'Not given';
    years.set(year, (years.get(year) || 0) + 1);
    const times = (p.submissions || []).map((s) => Number(s.ts)).filter(Number.isFinite);
    if (times.length) { const lo = Math.min(...times); first = Math.min(first, lo); spans.push(Math.max(0, now - lo)); }
    for (const s of p.submissions || []) {
      const row = perStage.get(s.section);
      if (row) row.responses += 1;
      if (!Number.isFinite(Number(s.ts)) || now - Number(s.ts) > days * DAY) continue;
      const day = easternDay(s.ts);
      const bucket = daily.get(day) || {};
      bucket[s.section] = (bucket[s.section] || 0) + 1;
      daily.set(day, bucket);
    }
    for (const key of flow.keys) {
      const row = perStage.get(key);
      const state = pf.states[key];
      const reached = state === 'current' || state === 'done' || state === 'open';
      if (key === pf.stage && pf.status === 'active') row.here += 1;
      if (key === pf.stage && pf.status === 'declined') row.declined += 1;
      if (reached) { row.reached += 1; row.reachedEmails.add(p.email); }
      if (reached && pf.done[key]) row.done += 1;
      if (isObject(p.track?.fields?.[key])) row.values.push([p.email, p.track.fields[key]]);
    }
  }
  const stages = flow.keys.map((key) => {
    const s = flow.sections[key];
    const row = perStage.get(key);
    const fields = (s.fields || []).map((f) => ({ key: f.key, label: f.label, type: f.type, each: f.each === true, options: f.options, max: f.max, summary: fieldInsight(f, row.values.map(([email, v]) => [email, v[f.key]]), row.reachedEmails) }));
    return { key, title: s.title, kind: s.kind, rank: flow.ranks.get(key) ?? 0, form: Boolean(s.form), open: s.open === true, doneField: doneFieldOf(s)?.label || null, here: row.here, reached: row.reached, done: row.done, notDone: row.reached - row.done, responses: row.responses, declined: row.declined, fields };
  });
  const sorted = [...spans].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  return {
    people: people.length, statuses, flagged, commented,
    medianDays: Math.round(median / DAY),
    firstAt: Number.isFinite(first) ? first : null,
    stages,
    edges: flow.keys.flatMap((k) => (flow.edges.get(k) || []).map((to) => [k, to])),
    daily: [...daily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, counts]) => ({ day, counts })),
    subteams: [...subteams.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)),
    years: [...years.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)),
  };
}
