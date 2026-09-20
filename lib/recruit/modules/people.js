// People module (kernel): one review per person per cycle. A flag and the
// comment thread belong to the person, whatever forms they sent; the forms
// hold answers only. Reviews written on individual submissions before this
// existed are merged into the person's row the first time it is needed.

import { sectionsFor } from '../sections.js';

const COMMENT_ID = /^ic-[a-z0-9-]{8,80}$/;
const fail = (status, error, extra = {}) => Object.assign(new Error(error), { status, error, ...extra });
const isObject = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const asObject = (v) => (isObject(v) ? v : typeof v === 'string' ? (() => { try { const p = JSON.parse(v); return isObject(p) ? p : {}; } catch { return {}; } })() : {});
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const isLead = (role) => role === 'admin' || role === 'lead';
const emailOf = (v) => String(v || '').trim().toLowerCase();

function makeFacade(kit) {
  const mem = () => (kit.mem.people ||= []);
  const fromPg = (r) => ({ cycleId: r.cycle_id, email: r.email, name: r.name || '', review: asObject(r.review), reviewVersion: Number(r.review_version || 0), updated: Number(r.updated || 0) });

  // What the person's submissions carried before reviews moved: every flag
  // and comment, in time order, deleted ids kept so a retry stays refused.
  async function seedFrom(cycleId, email) {
    const apps = await kit.apps.allByEmail(cycleId, email);
    const out = { flagged: false, comments: [], deletedCommentIds: [] };
    for (const a of apps.sort((x, y) => (x.ts || 0) - (y.ts || 0))) {
      const r = a.review || {};
      if (r.flagged === true) { out.flagged = true; out.flaggedBy = r.flaggedBy; out.flaggedName = r.flaggedName; out.flaggedAt = r.flaggedAt; }
      for (const c of r.comments || []) if (c?.id && !out.comments.some((x) => x.id === c.id)) out.comments.push(c);
      for (const d of r.deletedCommentIds || []) if (!out.deletedCommentIds.includes(d)) out.deletedCommentIds.push(d);
    }
    out.comments.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return out;
  }

  async function get(cycleId, email) {
    if (kit.mode === 'memory') return clone(mem().find((p) => p.cycleId === cycleId && p.email === email) || null);
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
      const row = { cycleId, email, name, review: seeded, reviewVersion: 1, updated: now };
      mem().push(row); kit.memSave();
      return clone(row);
    }
    const s = await kit.sql();
    await s`INSERT INTO recruit_people (cycle_id, email, name, review, review_version, updated)
      VALUES (${cycleId}, ${email}, ${name}, ${JSON.stringify(seeded)}::jsonb, 1, ${now}) ON CONFLICT (cycle_id, email) DO NOTHING`;
    return get(cycleId, email);
  }

  // Every review in a cycle, by email.
  async function reviews(cycleId) {
    const out = new Map();
    if (kit.mode === 'memory') { for (const p of mem()) if (p.cycleId === cycleId) out.set(p.email, { review: clone(p.review), reviewVersion: p.reviewVersion }); return out; }
    const s = await kit.sql();
    const r = await s`SELECT email, review, review_version FROM recruit_people WHERE cycle_id = ${cycleId}`;
    for (const x of r.rows) out.set(x.email, { review: asObject(x.review), reviewVersion: Number(x.review_version || 0) });
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
      if (deleteComment && !comments.some((c) => c.id === deleteComment)) return failure(clone(row));
      if (comment && (comments.length >= 200 || comments.length + deleted.length >= 1000 || deleted.includes(comment.id) || comments.some((c) => c.id === comment.id))) return failure(clone(row));
      row.review = { ...row.review, ...(flag || {}), ...(comment ? { comments: [...comments, comment] } : {}),
        ...(deleteComment ? { comments: comments.filter((c) => c.id !== deleteComment), deletedCommentIds: [...deleted, deleteComment] } : {}) };
      row.reviewVersion = (row.reviewVersion || 0) + 1;
      row.updated = kit.now();
      kit.memSave();
      return { row: clone(row) };
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

  // Erasing a person takes their thread with them.
  async function forget(email, cycleId = null) {
    if (kit.mode === 'memory') { const before = mem().length; kit.mem.people = mem().filter((p) => !(p.email === email && (!cycleId || p.cycleId === cycleId))); if (kit.mem.people.length !== before) kit.memSave(); return; }
    const s = await kit.sql();
    if (cycleId) await s`DELETE FROM recruit_people WHERE email = ${email} AND cycle_id = ${cycleId}`;
    else await s`DELETE FROM recruit_people WHERE email = ${email}`;
  }

  return { get, review, ensure, reviews, updateReview, forget, seedFrom };
}

/* ------------------------------- routes ---------------------------------- */

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

async function listRoute(rq, kit) {
  const qy = rq.query;
  const out = await kit.apps.people(rq.cycle.id, { q: qy.q, grantSubteams: rq.grant?.subteams || null, cycle: rq.cycle });
  const reviews = await kit.people.reviews(rq.cycle.id);
  let rows = out.rows.map((p) => {
    const r = reviews.get(p.email);
    const review = r ? r.review : null;
    const comments = review ? (review.comments || []).length : Object.values(p.sections || {}).reduce((n, s) => n + Number(s?.legacyComments || 0), 0);
    const flagged = review ? review.flagged === true : Object.values(p.sections || {}).some((s) => s?.legacyFlagged === true);
    const sections = Object.fromEntries(Object.entries(p.sections || {}).map(([k, s]) => { const { legacyFlagged, legacyComments, ...rest } = s || {}; return [k, rest]; }));
    return { ...p, sections, flagged, comments, reviewVersion: r ? r.reviewVersion : 0 };
  });
  if (qy.flagged === '1') rows = rows.filter((p) => p.flagged);
  if (qy.comments === '1') rows = rows.filter((p) => p.comments > 0);
  return { status: 200, body: { ...out, rows, total: rows.length, counts: { ...out.counts, flagged: rows.filter((p) => p.flagged).length } } };
}

async function detailRoute(rq, kit) {
  const { email, apps } = await personApps(rq, kit);
  const sections = sectionsFor(rq.cycle);
  const rv = await kit.people.review(rq.cycle.id, email);
  const submissions = apps.sort((a, b) => Number(a.ts) - Number(b.ts)).map((a) => {
    const { review, reviewVersion, ...application } = a;
    return { application, form: { questions: (sections[a.section || 'interest'] || sections.interest).form.questions } };
  });
  const history = (await kit.apps.history(email, null)).filter((h) => h.cycleId !== rq.cycle.id);
  const summary = personSummary(apps);
  const sectionRows = Object.fromEntries(apps.map((a) => [a.section || 'interest', kit.apps.listRow(a)]));
  return { status: 200, body: { person: { email, ...summary, flagged: rv.review.flagged === true, review: rv.review, reviewVersion: rv.reviewVersion, sections: sectionRows, latest: [...apps].sort((a, b) => (Number(b.updated) || Number(b.ts)) - (Number(a.updated) || Number(a.ts)))[0]?.id || null }, submissions, history } };
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
  const { email, apps } = await personApps(rq, kit);
  const out = await kit.people.updateReview(rq.cycle.id, email, apps[0].name, { comment: { id: body.id, text: body.text.trim(), by: rq.me.email, name: rq.me.name || rq.me.email, ts: kit.now() } });
  if (out.error) throw fail(out.status, out.error);
  return { status: 200, body: personBody(rq, apps, out), audit: { kind: 'comment.post', detail: { email, commentId: body.id } } };
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

async function csvRoute(rq, kit) {
  const out = await kit.apps.people(rq.cycle.id, { cycle: rq.cycle });
  const reviews = await kit.people.reviews(rq.cycle.id);
  const safe = (v) => { const s = String(v ?? ''); return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; };
  const when = (ts) => (ts ? new Date(Number(ts)).toISOString() : '');
  const rows = out.rows.map((p) => { const r = reviews.get(p.email); return { ...p, flagged: r ? r.review.flagged === true : false, comments: r ? (r.review.comments || []).length : 0 }; });
  const columns = [
    { header: 'Name', cell: (r) => safe(r.name) }, { header: 'Email', cell: (r) => safe(r.email) }, { header: 'Cornell', cell: (r) => (r.cornell ? 'yes' : 'no') },
    { header: 'Subteam', cell: (r) => safe(r.subteam || '') }, { header: 'Year', cell: (r) => safe(r.year || '') },
    ...Object.entries(sectionsFor(rq.cycle)).map(([key, sec]) => ({ header: sec.title, cell: (r) => when(r.sections?.[key]?.ts) })),
    { header: 'Flagged', cell: (r) => (r.flagged ? 'yes' : '') }, { header: 'Comments', cell: (r) => r.comments },
    { header: 'Last activity', cell: (r) => when(r.last) },
  ];
  kit.csv(rq.res, rows, columns, `cupi-${rq.cycle.term || rq.cycle.name}-people-${new Date(kit.now()).toISOString().slice(0, 10)}`);
  return undefined;
}

export default {
  name: 'people',
  label: 'People',
  kernel: true,
  order: 11,
  schema: [
    `CREATE TABLE IF NOT EXISTS recruit_people (cycle_id text NOT NULL, email text NOT NULL, name text NOT NULL DEFAULT '', review jsonb NOT NULL DEFAULT '{}'::jsonb, review_version integer NOT NULL DEFAULT 0, updated bigint NOT NULL DEFAULT 0, PRIMARY KEY (cycle_id, email))`,
  ],
  memory: { people: [] },
  defaults: () => ({}),
  validateSettings: () => ({}),
  provide: (kit) => ({ people: makeFacade(kit) }),
  routes: [
    { method: 'GET', path: '/cycles/:cycle/people', access: 'role', scoped: true, handler: listRoute },
    { method: 'GET', path: '/cycles/:cycle/people.csv', access: 'lead', handler: csvRoute },
    { method: 'GET', path: '/cycles/:cycle/people/:email', access: 'role', scoped: true, handler: detailRoute },
    { method: 'PATCH', path: '/cycles/:cycle/people/:email/review', access: 'reviewer', scoped: true, mutates: true, cap: 32000, handler: flagRoute },
    { method: 'POST', path: '/cycles/:cycle/people/:email/comments', access: 'reviewer', scoped: true, mutates: true, cap: 32000, handler: commentRoute },
    { method: 'DELETE', path: '/cycles/:cycle/people/:email/comments/:comment', access: 'reviewer', scoped: true, mutates: true, handler: deleteCommentRoute },
  ],
  hooks: {},
  collect: {},
  auditKinds: ['person.flag', 'comment.post', 'comment.delete'],
};
