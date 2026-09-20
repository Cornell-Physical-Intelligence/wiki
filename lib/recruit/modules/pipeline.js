// Pipeline module: stages, moves, decisions, tags and saved views for one
// recruitment cycle. The shared application columns (stage, outcome,
// decision, tags, edit_version) are written only through kit.apps.*; this
// file adds the stage-kind rules, the role checks, request idempotency and
// the event fan-out on top. It owns no table: the transition trail is the
// application's stage_history plus the 'stage' audit row that kit.apps.move
// writes in the same statement as the move.

const STAGE_KEY = /^[a-z][a-z0-9_]{0,23}$/;
const VIEW_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const APP_ID = /^in-[a-z0-9]+$/;
const REQUEST_ID = /^rq-[a-z0-9-]{8,80}$/;
const KINDS = new Set(['open', 'hold', 'closed']);
const OUTCOMES = new Set(['accepted', 'declined', 'rejected', 'waitlisted']);
const QUERY_KEYS = ['q', 'stage', 'subteam', 'year', 'tag', 'flagged', 'assigned', 'unscored', 'sort', 'dir'];
const SORTS = new Set(['ts', 'name', 'updated', 'stage_at', 'score']);
const MAX_IDS = 2000;
const MAX_STAGES = 30;
const MAX_VIEWS = 30;
const MAX_TAGS = 20;

export const DEFAULT_STAGES = [
  { key: 'applied', name: 'Applied', kind: 'open' },
  { key: 'screening', name: 'Screening', kind: 'open' },
  { key: 'interview', name: 'Interview', kind: 'open' },
  { key: 'decision', name: 'Decision', kind: 'open' },
  { key: 'offer', name: 'Offer', kind: 'open' },
  { key: 'waitlisted', name: 'Waitlisted', kind: 'hold', outcome: 'waitlisted' },
  { key: 'accepted', name: 'Accepted', kind: 'closed', outcome: 'accepted' },
  { key: 'declined', name: 'Declined', kind: 'closed', outcome: 'declined' },
  { key: 'rejected', name: 'Rejected', kind: 'closed', outcome: 'rejected' },
];

const fail = (status, error) => Object.assign(new Error(error), { status, error });
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

const defaults = () => ({ stages: DEFAULT_STAGES.map((s) => ({ ...s })), views: [], reviewersMayMove: false });
export const settingsOf = (cycle) => ({ ...defaults(cycle), ...(isObject(cycle?.doc?.pipeline) ? cycle.doc.pipeline : {}) });

// A stage's outcome: only hold/closed stages carry one; open stages clear it.
export function outcomeOf(stages, key) {
  const stage = (stages || []).find((s) => s.key === key);
  return stage && stage.kind !== 'open' ? stage.outcome || null : null;
}

export function stageFor(stages, outcome) {
  return (stages || []).find((s) => s.kind !== 'open' && s.outcome === outcome) || null;
}

/* ------------------------------ validation ------------------------------ */

function normalizeStages(input) {
  if (!Array.isArray(input) || !input.length) throw fail(400, 'Keep at least one stage');
  if (input.length > MAX_STAGES) throw fail(400, `Keep it to ${MAX_STAGES} stages`);
  const seen = new Set();
  const stages = input.map((raw) => {
    if (!isObject(raw)) throw fail(400, 'Each stage needs a key, a name and a kind');
    const key = String(raw.key || '');
    if (!STAGE_KEY.test(key)) throw fail(400, `Stage key "${key.slice(0, 40)}" must be lowercase letters, digits or underscores`);
    if (seen.has(key)) throw fail(400, `Stage key "${key}" is used twice`);
    seen.add(key);
    const name = clip(raw.name, 40);
    if (!name) throw fail(400, `Give stage "${key}" a name`);
    const kind = String(raw.kind || 'open');
    if (!KINDS.has(kind)) throw fail(400, `Stage "${name}" has an unknown kind`);
    const outcome = raw.outcome == null || raw.outcome === '' ? null : String(raw.outcome);
    if (kind === 'open' && outcome) throw fail(400, `Open stage "${name}" cannot record an outcome`);
    if (kind !== 'open' && !OUTCOMES.has(outcome)) throw fail(400, `Stage "${name}" needs an outcome: accepted, declined, rejected or waitlisted`);
    return kind === 'open' ? { key, name, kind } : { key, name, kind, outcome };
  });
  if (!seen.has('applied')) throw fail(400, 'The "applied" stage cannot be removed');
  return stages;
}

export function normalizeQuery(input) {
  const query = {};
  if (!isObject(input)) return query;
  for (const key of QUERY_KEYS) {
    if (input[key] === undefined || input[key] === null || input[key] === '' || input[key] === false) continue;
    const value = input[key] === true ? '1' : clip(input[key], 120);
    if (!value) continue;
    if (key === 'sort' && !SORTS.has(value)) throw fail(400, 'Unknown sort');
    if (key === 'dir' && value !== 'asc' && value !== 'desc') throw fail(400, 'Sort direction must be asc or desc');
    if ((key === 'flagged' || key === 'unscored') && value !== '1') throw fail(400, `${key} is a switch: 1 or nothing`);
    query[key] = value;
  }
  return query;
}

function normalizeViews(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw fail(400, 'Saved views must be a list');
  if (input.length > MAX_VIEWS) throw fail(400, `Keep it to ${MAX_VIEWS} saved views`);
  const seen = new Set();
  return input.map((raw) => {
    if (!isObject(raw)) throw fail(400, 'Each saved view needs a key, a name and a query');
    const key = String(raw.key || '');
    if (!VIEW_KEY.test(key)) throw fail(400, 'Saved view keys are lowercase letters, digits, dashes or underscores');
    if (seen.has(key)) throw fail(400, `Saved view "${key}" is listed twice`);
    seen.add(key);
    const name = clip(raw.name, 60);
    if (!name) throw fail(400, 'Give the saved view a name');
    return { key, name, query: normalizeQuery(raw.query) };
  });
}

async function countByStage(kit, cycle) {
  const counts = {};
  if (kit.mode === 'memory') {
    for (const app of kit.mem.applications || []) if (app.cycleId === cycle.id) counts[app.stage] = (counts[app.stage] || 0) + 1;
    return counts;
  }
  const s = await kit.sql();
  const r = await s`SELECT stage, count(*)::int AS n FROM recruit_applications WHERE cycle_id = ${cycle.id} GROUP BY stage`;
  for (const row of r.rows) counts[row.stage] = Number(row.n);
  return counts;
}

// Shape checks throw synchronously. With a kit, the populated-stage check
// runs too and the call returns a promise, so `await` works either way.
function validateSettings(next, cycle, kit) {
  if (!isObject(next)) throw fail(400, 'Pipeline settings must be an object');
  const settings = {
    stages: normalizeStages(next.stages),
    views: normalizeViews(next.views),
    reviewersMayMove: next.reviewersMayMove === true,
  };
  if (!kit) return settings;
  const prior = settingsOf(cycle).stages;
  const removed = prior.filter((s) => !settings.stages.some((n) => n.key === s.key));
  if (!removed.length) return Promise.resolve(settings);
  return countByStage(kit, cycle).then((counts) => {
    for (const stage of removed) {
      const n = counts[stage.key] || 0;
      if (n) throw fail(409, `${stage.name} still has ${n} application${n === 1 ? '' : 's'}. Move them first.`);
    }
    return settings;
  });
}

/* -------------------------------- routes -------------------------------- */

function requestIdOf(body) {
  const id = String(body?.requestId || '');
  if (!REQUEST_ID.test(id)) throw fail(400, 'A request id is required');
  return id;
}

function idsOf(input) {
  if (!Array.isArray(input) || !input.length) throw fail(400, 'Choose at least one application');
  if (input.length > MAX_IDS) throw fail(400, `Choose at most ${MAX_IDS} applications at a time`);
  const ids = [...new Set(input.map((v) => String(v)))];
  for (const id of ids) if (!APP_ID.test(id)) throw fail(400, 'Unknown application id');
  return ids;
}

const isLead = (role) => role === 'admin' || role === 'lead';

async function skipReason(kit, cycle, id, to, from, stages) {
  const current = await kit.apps.get(cycle, id);
  if (!current) return 'No such application';
  if (current.stage === to) return `Already in ${stages.find((s) => s.key === to)?.name || to}`;
  if (from && current.stage !== from) return `Not in ${stages.find((s) => s.key === from)?.name || from}`;
  return 'Not moved';
}

async function moves(rq, kit) {
  const { cycle, me, role } = rq;
  const settings = settingsOf(cycle);
  const body = await rq.body();
  const requestId = requestIdOf(body);
  const ids = idsOf(body.ids);
  const to = String(body.to || '');
  const stage = settings.stages.find((s) => s.key === to);
  if (!stage) throw fail(400, 'Choose a stage');
  const from = body.from == null || body.from === '' ? null : String(body.from);
  if (from !== null && !settings.stages.some((s) => s.key === from)) throw fail(400, 'Unknown starting stage');
  const note = clip(body.note, 500);
  if (!isLead(role) && !settings.reviewersMayMove) throw fail(403, 'Not allowed in this cycle');
  if (!isLead(role) && stage.kind !== 'open') throw fail(403, 'Decisions are made by leads');
  const outcome = outcomeOf(settings.stages, to);
  const result = await kit.once(requestId, me.email, async () => {
    const moved = [], skipped = [];
    for (const id of ids) {
      if (rq.scope && !rq.scope.has(id)) { skipped.push({ id, reason: 'Outside your assignments' }); continue; }
      const row = await kit.apps.move(cycle, { id, to, from, outcome, by: me.email, requestId, note, now: kit.now() });
      if (!row) { skipped.push({ id, reason: await skipReason(kit, cycle, id, to, from, settings.stages) }); continue; }
      moved.push({ id, from: row.from, editVersion: row.editVersion });
    }
    for (const m of moved) await kit.emit('stage.moved', { cycle, application: m.id, from: m.from, to, by: me.email });
    return { moved, skipped };
  });
  return { status: 200, body: result };
}

async function decisions(rq, kit) {
  const { cycle, me } = rq;
  const settings = settingsOf(cycle);
  const body = await rq.body();
  const requestId = requestIdOf(body);
  const ids = idsOf(body.ids);
  const outcome = String(body.outcome || '');
  if (!OUTCOMES.has(outcome)) throw fail(400, 'Choose an outcome');
  const stage = stageFor(settings.stages, outcome);
  if (!stage) throw fail(400, `No stage records "${outcome}". Add one under Stages.`);
  const reason = clip(body.reason, 2000);
  const subteams = Array.isArray(cycle.doc?.subteams) ? cycle.doc.subteams : [];
  let subteam = clip(body.subteam, 40);
  if (subteam) {
    const match = subteams.find((s) => s.key === subteam || s.name === subteam);
    if (!match) throw fail(400, 'Unknown subteam');
    subteam = match.key;
  }
  const result = await kit.once(requestId, me.email, async () => {
    const decided = [], skipped = [];
    for (const id of ids) {
      const row = await kit.apps.setDecision(cycle, { id, outcome, reason, subteam, stage: stage.key, by: me.email, requestId, now: kit.now() });
      if (!row) { skipped.push({ id, reason: 'No such application' }); continue; }
      decided.push({ id, from: row.from, editVersion: row.editVersion });
      await kit.audit({ cycleId: cycle.id, applicationId: id, actor: me.email, kind: 'decision', detail: { outcome, stage: stage.key, from: row.from, requestId } });
    }
    for (const d of decided) {
      if (d.from !== stage.key) await kit.emit('stage.moved', { cycle, application: d.id, from: d.from, to: stage.key, by: me.email });
      await kit.emit('decision.set', { cycle, application: d.id, outcome, reason, subteam, from: d.from, to: stage.key, by: me.email });
    }
    return { decided, skipped };
  });
  return { status: 200, body: result };
}

function tagList(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw fail(400, 'Tags must be a list');
  // Same label in different case is one tag; the first spelling wins.
  const seen = new Set();
  const tags = [];
  for (const raw of input) {
    const tag = clip(raw, 30);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  if (tags.length > MAX_TAGS) throw fail(400, `Keep it to ${MAX_TAGS} tags`);
  return tags;
}

async function tags(rq, kit) {
  const { cycle, me } = rq;
  const body = await rq.body();
  const requestId = requestIdOf(body);
  const ids = idsOf(body.ids);
  const add = tagList(body.add), remove = tagList(body.remove);
  if (!add.length && !remove.length) throw fail(400, 'Nothing to change');
  const result = await kit.once(requestId, me.email, async () => {
    const tagged = [], skipped = [];
    for (const id of ids) {
      const row = await kit.apps.patch(cycle, { id, tags: { add, remove }, by: me.email, requestId, now: kit.now() });
      if (!row) { skipped.push({ id, reason: 'No such application' }); continue; }
      tagged.push({ id, editVersion: row.editVersion, tags: row.tags });
      await kit.audit({ cycleId: cycle.id, applicationId: id, actor: me.email, kind: 'tag', detail: { added: add.length, removed: remove.length, requestId } });
    }
    return { tagged, skipped };
  });
  return { status: 200, body: result };
}

async function pipeline(rq, kit) {
  const settings = settingsOf(rq.cycle);
  const byStage = await countByStage(kit, rq.cycle);
  const total = Object.values(byStage).reduce((a, b) => a + b, 0);
  return {
    status: 200,
    body: {
      stages: settings.stages.map((s) => ({ ...s, count: byStage[s.key] || 0 })),
      counts: { total, byStage },
      views: settings.views,
      reviewersMayMove: settings.reviewersMayMove,
    },
  };
}

export default {
  name: 'pipeline',
  kernel: false,
  order: 30,
  schema: [],
  memory: {},
  defaults,
  validateSettings,
  routes: [
    { method: 'GET', path: '/cycles/:cycle/pipeline', access: 'role', handler: pipeline },
    // Reviewers reach this only when pipeline.reviewersMayMove; the handler re-checks.
    { method: 'POST', path: '/cycles/:cycle/moves', access: 'reviewer', scoped: true, mutates: true, cap: 262144, handler: moves },
    { method: 'POST', path: '/cycles/:cycle/decisions', access: 'lead', mutates: true, cap: 262144, handler: decisions },
    { method: 'POST', path: '/cycles/:cycle/tags', access: 'lead', mutates: true, cap: 262144, handler: tags },
  ],
  hooks: {},
  collect: {},
  auditKinds: ['stage', 'decision', 'tag'],
};
