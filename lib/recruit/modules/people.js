import { visibleHistory } from '../permissions.js';
// People module (kernel): one row per person per cycle. The person is who
// the team talks about and moves through the flow: their flag, their comment
// thread (a comment may name a stage), and their track: where the team
// placed them, their status, and what each stage's checklist holds for them.
// Forms hold answers only. Reviews written on individual submissions before
// this existed are merged into the person's row the first time it is needed.

import { sectionsFor, formForRow } from '../sections.js';
import { STATUSES, MAX_MOVES, flowOf, personFlow, fieldsSummary, cleanValue, insightsFor, splitQuestions } from '../flow.js';

const COMMENT_ID = /^ic-[a-z0-9-]{8,80}$/;
const REQUEST_ID = /^rq-[a-z0-9-]{8,80}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const BULK_MAX = 500;
const fail = (status, error, extra = {}) => Object.assign(new Error(error), { status, error, ...extra });
const isObject = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const asObject = (v) => (isObject(v) ? v : typeof v === 'string' ? (() => { try { const p = JSON.parse(v); return isObject(p) ? p : {}; } catch { return {}; } })() : {});
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const isLead = (role) => role === 'admin' || role === 'lead';
const emailOf = (v) => String(v || '').trim().toLowerCase();
const requestIdOf = (body) => { const id = String(body?.requestId || ''); if (!REQUEST_ID.test(id)) throw fail(400, 'A request ID is required'); return id; };

// What the person's submissions carried before reviews moved: every flag
// and comment, in time order, deleted ids kept so a retry stays refused.
function seedOf(apps) {
  const out = { flagged: false, comments: [], deletedCommentIds: [] };
  for (const a of [...apps].sort((x, y) => (x.ts || 0) - (y.ts || 0))) {
    const r = asObject(a.review);
    if (r.flagged === true) { out.flagged = true; out.flaggedBy = r.flaggedBy; out.flaggedName = r.flaggedName; out.flaggedAt = r.flaggedAt; }
    for (const c of r.comments || []) if (c?.id && !out.comments.some((x) => x.id === c.id)) out.comments.push(c);
    for (const d of r.deletedCommentIds || []) if (!out.deletedCommentIds.includes(d)) out.deletedCommentIds.push(d);
  }
  out.comments.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return out;
}

function makeFacade(kit) {
  const mem = () => (kit.mem.people ||= []);
  const fromPg = (r) => ({
    cycleId: r.cycle_id, email: r.email, name: r.name || '', review: asObject(r.review), reviewVersion: Number(r.review_version || 0),
    track: asObject(r.track), trackVersion: Number(r.track_version || 0), updated: Number(r.updated || 0),
  });
  const memRow = (p) => (p ? { ...clone(p), track: clone(p.track) || {}, trackVersion: p.trackVersion || 0 } : null);

  const seedFrom = async (cycleId, email) => seedOf(await kit.apps.allByEmail(cycleId, email));

  async function get(cycleId, email) {
    if (kit.mode === 'memory') return memRow(mem().find((p) => p.cycleId === cycleId && p.email === email));
    const s = await kit.sql();
    const r = await s`SELECT * FROM recruit_people WHERE cycle_id = ${cycleId} AND email = ${email}`;
    return r.rows[0] ? fromPg(r.rows[0]) : null;
  }

  // The person's review as it stands, created or not.
  async function review(cycleId, email) {
    const have = await get(cycleId, email);
    if (have) return { review: have.review, reviewVersion: have.reviewVersion };
    return { review: await seedFrom(cycleId, email), reviewVersion: 0 };
  }

  async function ensure(cycleId, email, name = '') {
    const have = await get(cycleId, email);
    if (have) return have;
    const seeded = await seedFrom(cycleId, email);
    const now = kit.now();
    if (kit.mode === 'memory') {
      const row = { cycleId, email, name, review: seeded, reviewVersion: 1, track: {}, trackVersion: 0, updated: now };
      mem().push(row); kit.memSave();
      return memRow(row);
    }
    const s = await kit.sql();
    await s`INSERT INTO recruit_people (cycle_id, email, name, review, review_version, updated)
      VALUES (${cycleId}, ${email}, ${name}, ${JSON.stringify(seeded)}::jsonb, 1, ${now}) ON CONFLICT (cycle_id, email) DO NOTHING`;
    return get(cycleId, email);
  }

  // The rows for many people at once, created where missing: one read, one
  // read of the missing people's submissions, one insert.
  async function ensureMany(cycleId, list) {
    if (kit.mode === 'memory') { for (const p of list) await ensure(cycleId, p.email, p.name); return; }
    const s = await kit.sql();
    const emails = list.map((p) => p.email);
    const have = new Set((await s`SELECT email FROM recruit_people WHERE cycle_id = ${cycleId} AND email = ANY(${emails})`).rows.map((r) => r.email));
    const missing = list.filter((p) => !have.has(p.email));
    if (!missing.length) return;
    const apps = (await s`SELECT email, ts, review FROM recruit_applications WHERE cycle_id = ${cycleId} AND email = ANY(${missing.map((p) => p.email)})`).rows;
    const rows = missing.map((p) => ({ email: p.email, name: p.name || '', review: seedOf(apps.filter((a) => a.email === p.email).map((a) => ({ ts: Number(a.ts), review: a.review }))) }));
    await s`INSERT INTO recruit_people (cycle_id, email, name, review, review_version, updated)
      SELECT ${cycleId}, x.email, x.name, x.review, 1, ${kit.now()} FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(email text, name text, review jsonb)
      ON CONFLICT (cycle_id, email) DO NOTHING`;
  }

  // Every person row in a cycle, by email: the review and the track.
  async function reviews(cycleId) {
    const out = new Map();
    if (kit.mode === 'memory') {
      for (const p of mem()) if (p.cycleId === cycleId) out.set(p.email, { review: clone(p.review), reviewVersion: p.reviewVersion, track: clone(p.track) || {}, trackVersion: p.trackVersion || 0 });
      return out;
    }
    const s = await kit.sql();
    const r = await s`SELECT email, review, review_version, track, track_version FROM recruit_people WHERE cycle_id = ${cycleId}`;
    for (const x of r.rows) out.set(x.email, { review: asObject(x.review), reviewVersion: Number(x.review_version || 0), track: asObject(x.track), trackVersion: Number(x.track_version || 0) });
    return out;
  }

  // One flag change, one comment, or one deletion, as a single statement.
  async function updateReview(cycleId, email, name, { flag, comment, deleteComment }) {
    await ensure(cycleId, email, name);
    const failure = (row) => {
      if (!row) return { status: 404, error: 'This person is no longer in this cycle' };
      const deleted = row.review?.deletedCommentIds || [];
      if (deleteComment) return deleted.includes(deleteComment) ? { row } : { status: 404, error: 'This comment is no longer available' };
      if (comment && deleted.includes(comment.id)) return { status: 409, error: 'This comment was deleted and cannot be posted again' };
      const prior = (row.review?.comments || []).find((c) => c.id === comment?.id);
      if (prior && prior.by === comment.by && prior.text === comment.text) return { row };
      if (!prior && (row.review?.comments?.length || 0) + deleted.length >= 1000) return { status: 409, error: 'This person has reached their comment history limit' };
      return { status: 409, error: prior ? 'This comment was already sent with different text. Reopen the person and try again.' : 'This person has reached their limit of 200 comments' };
    };
    if (kit.mode === 'memory') {
      const row = mem().find((p) => p.cycleId === cycleId && p.email === email);
      if (!row) return failure(null);
      const comments = row.review?.comments || [];
      const deleted = row.review?.deletedCommentIds || [];
      if (deleteComment && !comments.some((c) => c.id === deleteComment)) return failure(memRow(row));
      if (comment && (comments.length >= 200 || comments.length + deleted.length >= 1000 || deleted.includes(comment.id) || comments.some((c) => c.id === comment.id))) return failure(memRow(row));
      row.review = { ...row.review, ...(flag || {}), ...(comment ? { comments: [...comments, comment] } : {}),
        ...(deleteComment ? { comments: comments.filter((c) => c.id !== deleteComment), deletedCommentIds: [...deleted, deleteComment] } : {}) };
      row.reviewVersion = (row.reviewVersion || 0) + 1;
      row.updated = kit.now();
      kit.memSave();
      return { row: memRow(row) };
    }
    const s = await kit.sql();
    const now = kit.now();
    const result = deleteComment
      ? await s`UPDATE recruit_people SET
          review = jsonb_set(jsonb_set(review, '{comments}',
            (SELECT COALESCE(jsonb_agg(c), '[]'::jsonb) FROM jsonb_array_elements(COALESCE(review->'comments', '[]'::jsonb)) AS c WHERE c->>'id' <> ${deleteComment})),
            '{deletedCommentIds}', COALESCE(review->'deletedCommentIds', '[]'::jsonb) || ${JSON.stringify([deleteComment])}::jsonb),
          review_version = review_version + 1, updated = ${now}
        WHERE cycle_id = ${cycleId} AND email = ${email} AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(review->'comments', '[]'::jsonb)) AS c WHERE c->>'id' = ${deleteComment})
        RETURNING *`
      : comment
      ? await s`UPDATE recruit_people SET
          review = jsonb_set(review, '{comments}', COALESCE(review->'comments', '[]'::jsonb) || ${JSON.stringify([comment])}::jsonb),
          review_version = review_version + 1, updated = ${now}
        WHERE cycle_id = ${cycleId} AND email = ${email} AND jsonb_array_length(COALESCE(review->'comments', '[]'::jsonb)) < 200
          AND jsonb_array_length(COALESCE(review->'comments', '[]'::jsonb)) + jsonb_array_length(COALESCE(review->'deletedCommentIds', '[]'::jsonb)) < 1000
          AND NOT (COALESCE(review->'deletedCommentIds', '[]'::jsonb) ? ${comment.id})
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(review->'comments', '[]'::jsonb)) AS c WHERE c->>'id' = ${comment.id})
        RETURNING *`
      : await s`UPDATE recruit_people SET review = review || ${JSON.stringify(flag)}::jsonb, review_version = review_version + 1, updated = ${now}
          WHERE cycle_id = ${cycleId} AND email = ${email} RETURNING *`;
    if (result.rows[0]) return { row: fromPg(result.rows[0]) };
    return failure(await get(cycleId, email));
  }

  // One checklist value, as one statement that touches only that field: two
  // reviewers ticking different boxes at once never overwrite each other. A
  // per-reviewer field keeps one entry per reviewer.
  async function setField(cycleId, email, name, { stage, field, each, value, by, byName, now }) {
    await ensure(cycleId, email, name);
    const entry = each ? { v: value, name: byName, at: now } : { v: value, by, name: byName, at: now };
    if (kit.mode === 'memory') {
      const row = mem().find((p) => p.cycleId === cycleId && p.email === email);
      if (!row) return null;
      const track = row.track || {};
      const fields = isObject(track.fields) ? track.fields : {};
      const own = isObject(fields[stage]) ? fields[stage] : {};
      const stored = isObject(own[field]) ? own[field] : {};
      own[field] = each ? { ...stored, each: { ...(isObject(stored.each) ? stored.each : {}), [by]: entry } } : entry;
      row.track = { ...track, fields: { ...fields, [stage]: own } };
      row.trackVersion = (row.trackVersion || 0) + 1;
      row.updated = now;
      kit.memSave();
      return memRow(row);
    }
    const s = await kit.sql();
    const r = each
      ? await s`UPDATE recruit_people SET track = jsonb_set(jsonb_set(jsonb_set(jsonb_set(
            COALESCE(track, '{}'::jsonb) || jsonb_build_object('fields', COALESCE(track->'fields', '{}'::jsonb)),
            ARRAY['fields', ${stage}::text], COALESCE(track #> ARRAY['fields', ${stage}::text], '{}'::jsonb)),
            ARRAY['fields', ${stage}::text, ${field}::text], COALESCE(track #> ARRAY['fields', ${stage}::text, ${field}::text], '{}'::jsonb)),
            ARRAY['fields', ${stage}::text, ${field}::text, 'each'], COALESCE(track #> ARRAY['fields', ${stage}::text, ${field}::text, 'each'], '{}'::jsonb)),
            ARRAY['fields', ${stage}::text, ${field}::text, 'each', ${by}::text], ${JSON.stringify(entry)}::jsonb),
          track_version = track_version + 1, updated = ${now}
        WHERE cycle_id = ${cycleId} AND email = ${email} RETURNING *`
      : await s`UPDATE recruit_people SET track = jsonb_set(jsonb_set(
            COALESCE(track, '{}'::jsonb) || jsonb_build_object('fields', COALESCE(track->'fields', '{}'::jsonb)),
            ARRAY['fields', ${stage}::text], COALESCE(track #> ARRAY['fields', ${stage}::text], '{}'::jsonb)),
            ARRAY['fields', ${stage}::text, ${field}::text], ${JSON.stringify(entry)}::jsonb),
          track_version = track_version + 1, updated = ${now}
        WHERE cycle_id = ${cycleId} AND email = ${email} RETURNING *`;
    return r.rows[0] ? fromPg(r.rows[0]) : null;
  }

  // A move (stage and/or status) with its history entry, as one statement.
  async function move(cycleId, email, name, { patch, entry, now }) {
    await ensure(cycleId, email, name);
    if (kit.mode === 'memory') {
      const row = mem().find((p) => p.cycleId === cycleId && p.email === email);
      if (!row) return null;
      const track = row.track || {};
      row.track = { ...track, ...patch, moves: [...(Array.isArray(track.moves) ? track.moves : []), entry].slice(-MAX_MOVES) };
      row.trackVersion = (row.trackVersion || 0) + 1;
      row.updated = now;
      kit.memSave();
      return memRow(row);
    }
    const s = await kit.sql();
    const r = await s`UPDATE recruit_people SET track = COALESCE(track, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb || jsonb_build_object('moves',
          (CASE WHEN jsonb_array_length(COALESCE(track->'moves', '[]'::jsonb)) >= ${MAX_MOVES} THEN COALESCE(track->'moves', '[]'::jsonb) - 0 ELSE COALESCE(track->'moves', '[]'::jsonb) END) || ${JSON.stringify([entry])}::jsonb),
        track_version = track_version + 1, updated = ${now}
      WHERE cycle_id = ${cycleId} AND email = ${email} RETURNING *`;
    return r.rows[0] ? fromPg(r.rows[0]) : null;
  }

  // The same move for many people, one statement; each keeps its own
  // history entry (where they were before).
  async function moveMany(cycleId, list, { patch, now }) {
    await ensureMany(cycleId, list);
    if (kit.mode === 'memory') {
      const moved = [];
      for (const p of list) if (await move(cycleId, p.email, p.name, { patch, entry: p.entry, now })) moved.push(p.email);
      return moved;
    }
    const s = await kit.sql();
    const entries = Object.fromEntries(list.map((p) => [p.email, p.entry]));
    const r = await s`UPDATE recruit_people SET track = COALESCE(track, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb || jsonb_build_object('moves',
          (CASE WHEN jsonb_array_length(COALESCE(track->'moves', '[]'::jsonb)) >= ${MAX_MOVES} THEN COALESCE(track->'moves', '[]'::jsonb) - 0 ELSE COALESCE(track->'moves', '[]'::jsonb) END)
          || jsonb_build_array(${JSON.stringify(entries)}::jsonb -> email)),
        track_version = track_version + 1, updated = ${now}
      WHERE cycle_id = ${cycleId} AND email = ANY(${list.map((p) => p.email)}) RETURNING email`;
    return r.rows.map((x) => x.email);
  }

  // Who a stage holds on to: people the team placed there, and people with
  // anything written in its checklist. A stage with either is not removed.
  async function usage(cycleId, stage) {
    let rows;
    if (kit.mode === 'memory') rows = mem().filter((p) => p.cycleId === cycleId).map((p) => ({ track: p.track || {} }));
    else {
      const s = await kit.sql();
      rows = (await s`SELECT track FROM recruit_people WHERE cycle_id = ${cycleId} AND (track->>'stage' = ${stage} OR COALESCE(track->'fields', '{}'::jsonb) ? ${stage})`).rows.map((x) => ({ track: asObject(x.track) }));
    }
    const hasValue = (v) => v !== null && v !== undefined && v !== '' && v !== false;
    const recordedIn = (values) => Object.values(isObject(values) ? values : {}).some((f) => isObject(f) && (hasValue(f.v) || Object.values(isObject(f.each) ? f.each : {}).some((e) => hasValue(e?.v))));
    return {
      placed: rows.filter((p) => p.track.stage === stage).length,
      recorded: rows.filter((p) => recordedIn(p.track.fields?.[stage])).length,
    };
  }

  // Erasing a person takes their thread and track with them.
  async function forget(email, cycleId = null) {
    if (kit.mode === 'memory') { const before = mem().length; kit.mem.people = mem().filter((p) => !(p.email === email && (!cycleId || p.cycleId === cycleId))); if (kit.mem.people.length !== before) kit.memSave(); return; }
    const s = await kit.sql();
    if (cycleId) await s`DELETE FROM recruit_people WHERE email = ${email} AND cycle_id = ${cycleId}`;
    else await s`DELETE FROM recruit_people WHERE email = ${email}`;
  }

  return { get, review, ensure, ensureMany, reviews, updateReview, setField, move, moveMany, usage, forget, seedFrom, result: (rq) => peopleResult(rq, kit) };
}

/* ------------------------------- the flow --------------------------------- */

const submissionsOf = (apps) => apps.map((a) => ({ section: a.section || 'interest', ts: Number(a.ts) || 0, answers: a.answers || {} }));

// Where a person stands and what their stages hold, as every route answers it.
function trackView(flow, apps, row, me) {
  const track = row?.track || {};
  const pf = personFlow(flow, submissionsOf(apps), track);
  return { stage: pf.stage, status: pf.status, states: pf.states, done: pf.done, next: pf.next, fields: fieldsSummary(flow, track, me), track, trackVersion: row?.trackVersion || 0 };
}

// Everyone in the cycle the reader may see, each with where they stand.
async function cyclePeople(rq, kit, q = '') {
  const out = await kit.apps.people(rq.cycle.id, { q, grantSubteams: rq.grant?.subteams || null, scope: rq.scope, cycle: rq.cycle });
  const reviews = await kit.people.reviews(rq.cycle.id);
  const flow = flowOf(sectionsFor(rq.cycle));
  const questions = splitQuestions(flow);
  const answers = questions.size ? await kit.apps.routeAnswers(rq.cycle.id, questions) : null;
  const me = rq.me?.email || '';
  const rows = out.rows.map((p) => {
    const r = reviews.get(p.email);
    const review = r ? r.review : null;
    const comments = review ? (review.comments || []).length : Object.values(p.sections || {}).reduce((n, s) => n + Number(s?.legacyComments || 0), 0);
    const flagged = review ? review.flagged === true : Object.values(p.sections || {}).some((s) => s?.legacyFlagged === true);
    const sections = Object.fromEntries(Object.entries(p.sections || {}).map(([k, s]) => { const { legacyFlagged, legacyComments, ...rest } = s || {}; return [k, rest]; }));
    const track = r?.track || {};
    const submissions = Object.values(sections).map((s) => ({ section: s.section, ts: Number(s.ts) || 0, answers: answers?.get(p.email)?.[s.section] }));
    const pf = personFlow(flow, submissions, track);
    return {
      ...p, sections, flagged, comments, reviewVersion: r ? r.reviewVersion : 0,
      stage: pf.stage, status: pf.status, states: pf.states, done: pf.done, next: pf.next, fields: fieldsSummary(flow, track, me), trackVersion: r?.trackVersion || 0,
      _submissions: submissions, _track: track,
    };
  });
  return { out, flow, rows };
}

const strip = ({ _submissions, _track, ...row }) => row;
const REACHED = new Set(['current', 'done', 'open']);

// How a list sorts. Each key is compared as a tuple, then by email.
function sorterFor(flow, sort) {
  if (sort === 'name') return { name: 'name', dir: 1, key: (p) => [String(p.name || '').toLowerCase()] };
  if (sort === 'stage') return { name: 'stage', dir: 1, key: (p) => [p.stage ? flow.ranks.get(p.stage) ?? 0 : 9999, flow.keys.indexOf(p.stage), String(p.name || '').toLowerCase()] };
  return { name: 'last', dir: -1, key: (p) => [Number(p.last) || 0] };
}
const cmpTuple = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };

export async function peopleResult(rq, kit) {
  const qy = rq.query || {};
  const { out, flow, rows: all } = await cyclePeople(rq, kit, qy.q);
  const known = (k) => Object.hasOwn(flow.sections, k);
  let rows = all;
  if (qy.flagged === '1') rows = rows.filter((p) => p.flagged);
  if (qy.comments === '1') rows = rows.filter((p) => p.comments > 0);
  if (qy.section) {
    if (!known(qy.section)) throw fail(400, 'No such form in this cycle');
    rows = rows.filter((p) => Object.hasOwn(p.sections, qy.section));
  }
  for (const param of ['stage', 'reached', 'done', 'notdone', 'next']) if (qy[param] && !known(qy[param])) throw fail(400, 'No such stage in this cycle');
  if (qy.next) rows = rows.filter((p) => p.next.includes(qy.next));
  if (qy.stage) rows = rows.filter((p) => p.stage === qy.stage);
  if (qy.reached) rows = rows.filter((p) => REACHED.has(p.states[qy.reached]));
  if (qy.done) rows = rows.filter((p) => REACHED.has(p.states[qy.done]) && p.done[qy.done]);
  if (qy.notdone) rows = rows.filter((p) => REACHED.has(p.states[qy.notdone]) && !p.done[qy.notdone]);
  if (qy.status) {
    if (!STATUSES.includes(qy.status)) throw fail(400, 'No such status');
    rows = rows.filter((p) => p.status === qy.status);
  }
  if (qy.subteam) rows = rows.filter((p) => (qy.subteam === 'none' ? !p.subteam : String(p.subteam || '').split('; ').includes(qy.subteam)));
  if (qy.year) rows = rows.filter((p) => (qy.year === 'none' ? !p.year : p.year === qy.year));
  const sorter = sorterFor(flow, qy.sort);
  rows = [...rows].sort((a, b) => sorter.dir * cmpTuple(sorter.key(a), sorter.key(b)) || a.email.localeCompare(b.email));
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const byStage = {};
  for (const p of all) {
    byStatus[p.status] += 1;
    if (p.stage && p.status === 'active') byStage[p.stage] = (byStage[p.stage] || 0) + 1;
  }
  return {
    ...out, rows, total: rows.length, sort: sorter, flow,
    counts: { ...out.counts, flagged: rows.filter((p) => p.flagged).length, byStatus, byStage },
  };
}

async function listRoute(rq, kit) {
  const { sort, flow, ...out } = await peopleResult(rq, kit);
  const limit = Math.max(1, Math.min(200, Number(rq.query.limit) || 100));
  let after = null;
  if (rq.query.cursor) {
    let cursor;
    try { cursor = JSON.parse(Buffer.from(rq.query.cursor, 'base64url').toString()); } catch { throw fail(400, 'Invalid people cursor'); }
    // Cursors from before sorting could change carry { last, email }.
    if (cursor && Number.isFinite(cursor.last) && !Array.isArray(cursor.v)) cursor = { v: [cursor.last], email: cursor.email };
    if (!Array.isArray(cursor?.v) || typeof cursor.email !== 'string') throw fail(400, 'Invalid people cursor');
    after = cursor;
  }
  const eligible = after ? out.rows.filter((p) => (sort.dir * cmpTuple(sort.key(p), after.v) || p.email.localeCompare(after.email)) > 0) : out.rows;
  const rows = eligible.slice(0, limit), last = rows.at(-1);
  const next = eligible.length > limit ? Buffer.from(JSON.stringify({ v: sort.key(last), email: last.email })).toString('base64url') : null;
  return { status: 200, body: { ...out, rows: rows.map(strip), next, sort: sort.name } };
}

/* ------------------------------- one person ------------------------------ */

// The person behind a route: their submissions in this cycle, in scope.
async function personApps(rq, kit) {
  let email;
  try { email = emailOf(decodeURIComponent(rq.params.email)); } catch { email = emailOf(rq.params.email); }
  const apps = (await kit.apps.allByEmail(rq.cycle.id, email)).filter((a) => a.erasedAt == null);
  const visible = rq.scope ? apps.filter((a) => rq.scope.has(a.id)) : apps;
  if (!visible.length) throw fail(404, 'No such person in this cycle');
  return { email, apps: visible };
}

const personSummary = (apps) => {
  const sorted = [...apps].sort((a, b) => (Number(b.updated) || Number(b.ts)) - (Number(a.updated) || Number(a.ts)));
  const latest = sorted[0];
  return { name: latest.name, cornell: Boolean(latest.cornell), subteam: apps.map((a) => a.subteam).find(Boolean) || '', year: apps.map((a) => a.year).find(Boolean) || null,
    first: Math.min(...apps.map((a) => Number(a.ts))), last: Math.max(...apps.map((a) => Math.max(Number(a.ts) || 0, Number(a.updated) || 0))) };
};

async function detailRoute(rq, kit) {
  const { email, apps } = await personApps(rq, kit);
  const sections = sectionsFor(rq.cycle);
  const flow = flowOf(sections);
  const rv = await kit.people.review(rq.cycle.id, email);
  const row = await kit.people.get(rq.cycle.id, email);
  const submissions = apps.sort((a, b) => Number(a.ts) - Number(b.ts)).map((a) => {
    const { review, reviewVersion, ...application } = a;
    return { application, form: { questions: formForRow(sections, a).questions } };
  });
  const history = await visibleHistory(kit, rq.me, (await kit.apps.history(email, null)).filter((h) => h.cycleId !== rq.cycle.id));
  const summary = personSummary(apps);
  const sectionRows = Object.fromEntries(apps.map((a) => [a.section || 'interest', kit.apps.listRow(a)]));
  return { status: 200, body: { person: { email, ...summary, flagged: rv.review.flagged === true, review: rv.review, reviewVersion: rv.reviewVersion, sections: sectionRows, latest: [...apps].sort((a, b) => (Number(b.updated) || Number(b.ts)) - (Number(a.updated) || Number(a.ts)))[0]?.id || null, ...trackView(flow, apps, row, rq.me.email) }, submissions, history } };
}

const personBody = (rq, apps, out) => ({ person: { email: out.row.email, name: out.row.name || apps[0]?.name, flagged: out.row.review?.flagged === true, review: out.row.review, reviewVersion: out.row.reviewVersion } });

async function flagRoute(rq, kit) {
  const body = await rq.body();
  if (typeof body?.flagged !== 'boolean') throw fail(400, 'Choose whether to flag this person');
  const { email, apps } = await personApps(rq, kit);
  const out = await kit.people.updateReview(rq.cycle.id, email, apps[0].name, { flag: { flagged: body.flagged, flaggedBy: rq.me.email, flaggedName: rq.me.name || rq.me.email, flaggedAt: kit.now() } });
  if (out.error) throw fail(out.status, out.error);
  return { status: 200, body: personBody(rq, apps, out), audit: { kind: 'person.flag', detail: { email, flagged: body.flagged } } };
}

async function commentRoute(rq, kit) {
  const body = await rq.body();
  if (typeof body?.text !== 'string' || !body.text.trim() || body.text.trim().length > 4000) throw fail(400, 'Write a comment between 1 and 4,000 characters');
  if (typeof body.id !== 'string' || !COMMENT_ID.test(body.id)) throw fail(400, 'A comment ID is required');
  // A comment may be about one stage: the coffee chat, the interview.
  const stage = body.stage === undefined || body.stage === null || body.stage === '' ? null : String(body.stage);
  if (stage && !Object.hasOwn(sectionsFor(rq.cycle), stage)) throw fail(400, 'No such stage in this cycle');
  const { email, apps } = await personApps(rq, kit);
  const out = await kit.people.updateReview(rq.cycle.id, email, apps[0].name, { comment: { id: body.id, text: body.text.trim(), by: rq.me.email, name: rq.me.name || rq.me.email, ts: kit.now(), ...(stage ? { stage } : {}) } });
  if (out.error) throw fail(out.status, out.error);
  return { status: 200, body: personBody(rq, apps, out), audit: { kind: 'comment.post', detail: { email, commentId: body.id, ...(stage ? { stage } : {}) } } };
}

async function deleteCommentRoute(rq, kit) {
  const { email, apps } = await personApps(rq, kit);
  const current = await kit.people.review(rq.cycle.id, email);
  const existing = (current.review?.comments || []).find((c) => c.id === rq.params.comment);
  if (existing && existing.by !== rq.me.email && !isLead(rq.role)) throw fail(403, 'Not allowed in this cycle');
  const out = await kit.people.updateReview(rq.cycle.id, email, apps[0].name, { deleteComment: rq.params.comment });
  if (out.error) throw fail(out.status, out.error);
  return { status: 200, body: personBody(rq, apps, out), audit: { kind: 'comment.delete', detail: { email, commentId: rq.params.comment } } };
}

// One checklist value for one person: { stage, field, value }; null clears.
async function fieldRoute(rq, kit) {
  const body = await rq.body();
  if (!isObject(body) || !Object.hasOwn(body, 'value')) throw fail(400, 'Send a value, or null to clear it');
  const sections = sectionsFor(rq.cycle);
  const key = String(body.stage || '');
  const stage = Object.hasOwn(sections, key) ? sections[key] : null;
  if (!stage) throw fail(400, 'No such stage in this cycle');
  const field = (stage.fields || []).find((f) => f.key === String(body.field || ''));
  if (!field) throw fail(400, `${stage.title} has no such checklist field`);
  const members = field.type === 'member' ? (await kit.roles.team(rq.cycle.id)).map((m) => m.email) : null;
  const value = cleanValue(field, body.value, { members });
  const { email, apps } = await personApps(rq, kit);
  const row = await kit.people.setField(rq.cycle.id, email, apps[0].name, { stage: key, field: field.key, each: field.each === true, value, by: rq.me.email, byName: rq.me.name || rq.me.email, now: kit.now() });
  if (!row) throw fail(404, 'This person is no longer in this cycle');
  return { status: 200, body: { person: { email, ...trackView(flowOf(sections), apps, row, rq.me.email) } }, audit: { kind: 'person.field', detail: { email, stage: key, field: field.key } } };
}

// A move names a stage, a status, or both.
function moveOf(body, flow) {
  const out = {};
  if (body?.stage !== undefined && body.stage !== null && body.stage !== '') {
    if (!Object.hasOwn(flow.sections, String(body.stage))) throw fail(400, 'No such stage in this cycle');
    out.stage = String(body.stage);
  }
  if (body?.status !== undefined && body.status !== null && body.status !== '') {
    if (!STATUSES.includes(body.status)) throw fail(400, 'Choose active, accepted, waitlisted, declined or withdrew');
    out.status = body.status;
  }
  if (!out.stage && !out.status) throw fail(400, 'Choose a stage or a status');
  return out;
}

const movePatch = (move, me, now) => ({
  ...(move.stage ? { stage: move.stage, stageAt: now, stageBy: me.email, stageName: me.name || me.email } : {}),
  ...(move.status ? { status: move.status, statusAt: now, statusBy: me.email, statusName: me.name || me.email } : {}),
});
const moveEntry = (move, before, me, now) => ({
  at: now, by: me.email, name: me.name || me.email,
  ...(move.stage ? { stage: { from: before.stage || null, to: move.stage } } : {}),
  ...(move.status ? { status: { from: before.status, to: move.status } } : {}),
});

async function moveRoute(rq, kit) {
  const body = await rq.body();
  const requestId = requestIdOf(body);
  const sections = sectionsFor(rq.cycle);
  const flow = flowOf(sections);
  const move = moveOf(body, flow);
  const { email, apps } = await personApps(rq, kit);
  const result = await kit.once(requestId, rq.me.email, async () => {
    const before = personFlow(flow, submissionsOf(apps), (await kit.people.get(rq.cycle.id, email))?.track || {});
    const now = kit.now();
    const row = await kit.people.move(rq.cycle.id, email, apps[0].name, { patch: movePatch(move, rq.me, now), entry: moveEntry(move, before, rq.me, now), now });
    if (!row) throw fail(404, 'This person is no longer in this cycle');
    return { person: { email, ...trackView(flow, apps, row, rq.me.email) } };
  });
  return { status: 200, body: result, audit: { kind: 'person.move', detail: { email, ...move, requestId } } };
}

// The same move for up to 500 people: { emails, stage?, status?, requestId }.
async function bulkMoveRoute(rq, kit) {
  const body = await rq.body();
  const requestId = requestIdOf(body);
  if (!Array.isArray(body?.emails) || !body.emails.length) throw fail(400, 'Choose at least one person');
  if (body.emails.length > BULK_MAX) throw fail(400, `Move up to ${BULK_MAX} people at a time`);
  const emails = [...new Set(body.emails.map(emailOf))];
  if (emails.some((e) => !EMAIL_RE.test(e))) throw fail(400, 'One of those is not an email address');
  const { flow, rows } = await cyclePeople(rq, kit);
  const move = moveOf(body, flow);
  const byEmail = new Map(rows.map((p) => [p.email, p]));
  const found = emails.filter((e) => byEmail.has(e));
  const missing = emails.filter((e) => !byEmail.has(e));
  const result = await kit.once(requestId, rq.me.email, async () => {
    const now = kit.now();
    const list = found.map((e) => { const p = byEmail.get(e); return { email: e, name: p.name, entry: moveEntry(move, { stage: p.stage, status: p.status }, rq.me, now) }; });
    const moved = list.length ? await kit.people.moveMany(rq.cycle.id, list, { patch: movePatch(move, rq.me, now), now }) : [];
    return { moved: moved.length, emails: moved, missing };
  });
  return { status: 200, body: result, audit: { kind: 'person.move', detail: { people: found.length, ...move, requestId } } };
}

async function insightsRoute(rq, kit) {
  const { flow, rows } = await cyclePeople(rq, kit);
  const people = rows.map((p) => ({ email: p.email, subteam: p.subteam, year: p.year, flagged: p.flagged, comments: p.comments, submissions: p._submissions, track: p._track }));
  return { status: 200, body: insightsFor(flow, people, { now: kit.now() }) };
}

/* ------------------------------- export ---------------------------------- */

// A checklist value as one CSV cell: the team's answer, or each reviewer's.
function csvValue(field, stored) {
  if (!isObject(stored)) return '';
  if (!field.each) {
    const v = stored.v;
    if (v === null || v === undefined) return '';
    if (field.type === 'check') return v === true ? 'yes' : 'no';
    return String(v);
  }
  const entries = Object.values(isObject(stored.each) ? stored.each : {}).filter((e) => e && e.v !== null && e.v !== undefined && e.v !== '');
  if (!entries.length) return '';
  if (field.type === 'rating' || field.type === 'number') {
    const nums = entries.map((e) => Number(e.v)).filter(Number.isFinite);
    return nums.length ? `${Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100} (${nums.length})` : '';
  }
  return entries.map((e) => `${e.name || 'Reviewer'}: ${e.v}`).join(' | ');
}

async function csvRoute(rq, kit) {
  const out = await peopleResult(rq, kit);
  const safe = (v) => { const s = String(v ?? ''); return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; };
  const when = (ts) => (ts ? new Date(Number(ts)).toISOString() : '');
  const rows = out.rows;
  const sections = out.flow.sections;
  const title = (key) => sections[key]?.title || key;
  // The default header is the one spreadsheets already import; ?columns=full
  // adds where each person stands and every checklist field.
  const full = rq.query.columns === 'full';
  const keys = full ? out.flow.keys : Object.keys(sections);
  const columns = [
    { header: 'Name', cell: (r) => safe(r.name) }, { header: 'Email', cell: (r) => safe(r.email) }, { header: 'Cornell', cell: (r) => (r.cornell ? 'yes' : 'no') },
    { header: 'Subteam', cell: (r) => safe(r.subteam || '') }, { header: 'Year', cell: (r) => safe(r.year || '') },
    ...(full ? [{ header: 'Status', cell: (r) => r.status }, { header: 'Stage', cell: (r) => safe(r.stage ? title(r.stage) : '') }] : []),
    ...keys.filter((key) => full || sections[key].form).map((key) => ({ header: safe(title(key)), cell: (r) => when(r.sections?.[key]?.ts) })),
    ...(full ? keys.flatMap((key) => (sections[key].fields || []).map((f) => ({ header: safe(`${title(key)}: ${f.label}`), cell: (r) => safe(csvValue(f, r._track?.fields?.[key]?.[f.key])) }))) : []),
    { header: 'Flagged', cell: (r) => (r.flagged ? 'yes' : '') }, { header: 'Comments', cell: (r) => r.comments },
    { header: 'Last activity', cell: (r) => when(r.last) },
  ];
  await kit.csv(rq.res, rows, columns, `cupi-${rq.cycle.term || rq.cycle.name}-people-${new Date(kit.now()).toISOString().slice(0, 10)}`);
  return undefined;
}

export default {
  name: 'people',
  label: 'People',
  kernel: true,
  order: 11,
  schema: [
    `CREATE TABLE IF NOT EXISTS recruit_people (cycle_id text NOT NULL, email text NOT NULL, name text NOT NULL DEFAULT '', review jsonb NOT NULL DEFAULT '{}'::jsonb, review_version integer NOT NULL DEFAULT 0, updated bigint NOT NULL DEFAULT 0, PRIMARY KEY (cycle_id, email))`,
    `ALTER TABLE recruit_people ADD COLUMN IF NOT EXISTS track jsonb NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE recruit_people ADD COLUMN IF NOT EXISTS track_version bigint NOT NULL DEFAULT 0`,
  ],
  memory: { people: [] },
  defaults: () => ({}),
  validateSettings: () => ({}),
  provide: (kit) => ({ people: makeFacade(kit) }),
  routes: [
    { method: 'GET', path: '/cycles/:cycle/people', access: 'role', scoped: true, handler: listRoute },
    { method: 'GET', path: '/cycles/:cycle/people.csv', access: 'lead', handler: csvRoute },
    { method: 'GET', path: '/cycles/:cycle/insights', access: 'role', scoped: true, handler: insightsRoute },
    { method: 'POST', path: '/cycles/:cycle/moves', access: 'lead', mutates: true, cap: 64000, handler: bulkMoveRoute },
    { method: 'GET', path: '/cycles/:cycle/people/:email', access: 'role', scoped: true, handler: detailRoute },
    { method: 'PATCH', path: '/cycles/:cycle/people/:email/review', access: 'reviewer', scoped: true, mutates: true, cap: 32000, handler: flagRoute },
    { method: 'PATCH', path: '/cycles/:cycle/people/:email/fields', access: 'reviewer', scoped: true, mutates: true, cap: 32000, handler: fieldRoute },
    { method: 'POST', path: '/cycles/:cycle/people/:email/move', access: 'lead', scoped: true, mutates: true, cap: 8000, handler: moveRoute },
    { method: 'POST', path: '/cycles/:cycle/people/:email/comments', access: 'reviewer', scoped: true, mutates: true, cap: 32000, handler: commentRoute },
    { method: 'DELETE', path: '/cycles/:cycle/people/:email/comments/:comment', access: 'reviewer', scoped: true, mutates: true, handler: deleteCommentRoute },
  ],
  hooks: {},
  collect: {},
  auditKinds: ['person.flag', 'person.field', 'person.move', 'comment.post', 'comment.delete'],
};
