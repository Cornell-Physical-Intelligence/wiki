// Website module (kernel): what the club site reads and where it posts.
// GET /api/recruit/site describes the cycle receiving the website and its
// forms; POST /api/recruit/site/:section takes a submission for one
// of them. Both are public, CORS-limited to the site, and rate-limited by the
// registry. Submissions are journaled first, then written, exactly like the
// interest form's fixed POST.
//
// No submission is lost to one failing store: the private journal and the
// database each keep a copy, the cycle is also kept in the journal so both
// routes work while the database is down, and a submission left with fewer
// than two copies is emailed to the team with its files.

import { randomBytes } from 'node:crypto';
import { validateAnswers } from '../fixed-form.js';
import { sectionsFor, publicSections, validateSite, landingFor, applyFor } from '../sections.js';
import { flowOf, nextOf } from '../flow.js';

const fail = (status, error, extra = {}) => Object.assign(new Error(error), { status, error, ...extra });
const within = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`No answer within ${ms / 1000} s`)), ms))]);

// Where a backup copy goes besides the form's own recipients.
const BACKUP_TO = () => String(process.env.RECRUIT_BACKUP_TO || 'cuphysint@cornell.edu').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
// The spam limit per network address and hour. A cycle saved with a lower
// number (5 was the old default) still gets at least this: one campus
// network can carry a whole info session's applications.
export const INTAKE_FLOOR = { perIpHour: 120 };
export const intakeLimits = (cycle) => ({ perIpHour: Math.max(INTAKE_FLOOR.perIpHour, Number(cycle?.doc?.intake?.perIpHour) || 0) });

// Time limits that keep the slowest path inside Vercel's 60 s: reading the
// cycle 10 (then the saved copy 5), the journal 12, the database write 15,
// the backup email 10, and the steps after a save a few seconds each.
export const LIMIT = { read: 10000, snapshot: 5000, journal: 12000, write: 15000, email: 10000, after: 3000, notify: 8000 };
const SNAPSHOT_FRESH_MS = 10 * 60000;

const SNAPSHOT = 'site.snapshot';
const snapshotOf = (cycle) => (cycle ? { id: cycle.id, version: cycle.version, name: cycle.name, term: cycle.term, status: cycle.status, closesAt: cycle.closesAt ?? null, formVersion: cycle.formVersion || 0, doc: cycle.doc || {} } : null);

// The cycle receiving the website. Each version read is also kept in the
// journal store; when the database cannot be reached, that copy keeps the
// forms on the site and submissions still land in the journal.
async function liveCycle(kit) {
  let cycle;
  try {
    // A database that hangs is treated like one that fails.
    cycle = await within((async () => {
      const target = await kit.cycles.intakeTarget();
      return target ? kit.cycles.get(target.cycleId) : null;
    })(), LIMIT.read);
  } catch (error) {
    let saved = null;
    try { saved = await within((await kit.intake.journal()).loadSite?.() ?? Promise.resolve(null), LIMIT.snapshot); } catch (e) { saved = null; }
    if (saved && Object.prototype.hasOwnProperty.call(saved, 'cycle')) {
      console.error('[intake] database unreachable; serving the saved cycle', error?.message || error);
      return { cycle: saved.cycle, offline: true };
    }
    throw error;
  }
  // Saved once per cycle version and instance, and again every ten minutes
  // so another instance's older copy never lasts; a failed save is tried
  // again a minute later, never on every request.
  const mark = cycle ? `${cycle.id}:${cycle.version}` : 'none';
  const last = kit.store?.cache?.get(SNAPSHOT);
  if (!last || last.value !== mark || Date.now() > last.until) {
    let saved = false;
    try {
      const journal = await kit.intake.journal();
      saved = typeof journal.saveSite === 'function' && Boolean(await within(journal.saveSite({ cycle: snapshotOf(cycle), savedAt: kit.now() }), LIMIT.snapshot));
    } catch (e) { console.error('[intake] could not keep the cycle for an outage', e?.message || e); }
    kit.store?.cache?.set(SNAPSHOT, { value: mark, saved, until: Date.now() + (saved ? SNAPSHOT_FRESH_MS : 60000) });
  }
  return { cycle, offline: false };
}

// Submissions journaled while the database failed go in as soon as it
// answers again: a few per feed load, once a minute per instance, inside a
// short budget so the visitor's form is never held up for long.
const RETRY = 'site.retry';
const RETRY_EVERY_MS = 60000;
const RETRY_BUDGET_MS = 10000;
async function drainRetries(kit) {
  const last = kit.store?.cache?.get(RETRY);
  if (last && Date.now() < last.until) return;
  kit.store?.cache?.set(RETRY, { value: true, until: Date.now() + RETRY_EVERY_MS });
  const deadline = Date.now() + RETRY_BUDGET_MS;
  let journal;
  let ids = [];
  try {
    journal = await kit.intake.journal();
    if (typeof journal.listRetry !== 'function') return;
    ids = await within(journal.listRetry(5), LIMIT.after);
  } catch (e) { console.error('[intake] could not check queued submissions', e?.message || e); return; }
  for (const id of ids) {
    const left = deadline - Date.now();
    if (left < 2000) break;
    try {
      const entry = await within(journal.getEntry(id), Math.min(LIMIT.after, left));
      if (!entry?.cycleId) { await journal.clearRetry(id); continue; }
      const result = await within(kit.intake.commit(entry, journal, null, { cycleId: entry.cycleId }), Math.max(1000, deadline - Date.now()));
      if (result.outcome === 'saved' || result.outcome === 'superseded') { try { await journal.complete(id, result.outcome); } catch (e) { /* the receipt prevents repeats */ } }
      // Saved, or decided (a duplicate, a full form, late): either way it no
      // longer waits for the database; the undecided ones stay in the queue.
      await journal.clearRetry(id);
      console.error('[intake] queued submission replayed', id, result.outcome);
      if (result.outcome === 'saved' && result.inserted && result.row) {
        try {
          const cycle = await kit.cycles.get(entry.cycleId);
          const section = cycle ? sectionsFor(cycle)[entry.section] : null;
          if (section && section.notify !== false) await within(notifyLeads(kit, cycle, entry.section, section, result.row), LIMIT.after);
        } catch (e) { /* the row stands */ }
      }
    } catch (e) {
      // Still failing: tried again in a minute. A form that is gone cannot
      // take it; it waits in the queue for an admin to place it.
      if (e?.status === 409) { try { await journal.clearRetry(id); } catch (x) { /* next minute */ } }
      console.error('[intake] queued submission not replayed yet', id, e?.message || e);
    }
  }
}

const takesResponses = (kit, cycle) => cycle.status === 'open' && (cycle.closesAt == null || kit.now() < Number(cycle.closesAt));

async function siteRoute(rq, kit) {
  // Not cached anywhere: an edit in Settings must show on the next page load.
  const headers = { 'cache-control': 'no-store' };
  const { cycle, offline } = await liveCycle(kit);
  if (!offline) await drainRetries(kit);
  // No cycle receiving the website means nothing to show: the site says
  // applications are closed.
  if (!cycle) return { status: 200, body: { cycle: null, landing: null, sections: [] }, headers };
  // `landing` is the form /apply shows when it shows one; `apply` is what it
  // asks when several marked forms are open. Every form has its own page too.
  const sections = publicSections(cycle);
  const definitions = sectionsFor(cycle);
  await Promise.all(sections.map(async (s) => {
    const definition = definitions[s.key];
    let full = false;
    // The cap is checked again on every submission; a count that cannot be
    // read leaves the form showing rather than hiding it.
    if (definition.capacity && !offline) {
      try { full = (await kit.apps.count(cycle.id, s.key, true)) >= definition.capacity; } catch (e) { full = false; }
    }
    s.full = full;
    s.available = s.open && takesResponses(kit, cycle) && !full;
  }));
  return { status: 200, body: { cycle: { id: cycle.id, name: cycle.name, term: cycle.term, status: cycle.status }, landing: landingFor(cycle), apply: applyFor(cycle), sections }, headers };
}

// A copy of a submission that has fewer than two durable copies, by email:
// every answer under its question, which stores took it, and its files.
// Never throws; says whether the message was accepted.
const FILE_EXT = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const OUTCOME_NOTE = {
  saved: 'It is in the wiki; this email is its second copy because the private journal did not take it.',
  review: 'It is NOT in the wiki: this email already has a submission for the form, and public submissions never replace one. This email is the only copy of these answers.',
  held: 'It is NOT in the wiki: the form was full. This email is the only copy.',
  closed: 'It is NOT in the wiki: it arrived after the deadline. This email is the only copy.',
  superseded: 'It is NOT in the wiki: a newer submission from this email was saved first. This email is the only copy of these answers.',
};
async function emailBackup(kit, { cycle, section, entry, files, journaled, dbError, outcome }) {
  const to = [...new Set([...(Array.isArray(section.notifyTo) ? section.notifyTo : []), ...BACKUP_TO()])];
  if (!to.length) return false;
  const esc = kit.esc || ((v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]));
  const labels = Object.fromEntries((section.form?.questions || []).map((q) => [q.key, q.label || q.key]));
  const shown = (v) => (Array.isArray(v) ? v.join(', ') : v === true ? 'Yes' : v === false ? 'No' : String(v ?? ''));
  const answers = Object.entries(entry.answers || {}).filter(([, v]) => shown(v).trim())
    .map(([k, v]) => `<p style="margin:0 0 12px"><b>${esc(labels[k] || k)}</b><br>${esc(shown(v)).replace(/\n/g, '<br>')}</p>`).join('');
  const stores = `<p style="margin:0 0 12px"><b>Database</b>: ${dbError ? `no answer (${esc(String(dbError?.message || dbError).slice(0, 200))})` : esc(outcome || 'saved')}<br><b>Private journal</b>: ${journaled ? 'saved' : 'not saved'}<br><b>Receipt</b>: ${esc(entry.id)}</p>`;
  const next = dbError
    ? (journaled
      ? 'The database did not confirm it. The private journal has it and the wiki adds it when an admin opens Applications; search for this email there before adding it by hand.'
      : 'The database did not confirm it and the private journal did not take it. Search for this email in the wiki; if it is not there, add it from this email, the only copy.')
    : OUTCOME_NOTE[outcome] || `The database answered "${outcome}". Check the wiki for this email.`;
  const html = `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;color:#141414">
    <p><b>${esc(entry.name)}</b> (${esc(entry.email)}) sent the ${esc(section.title)} for ${esc(cycle?.name || '')}. ${esc(next)}</p>
    ${stores}${answers}
    ${files.length ? `<p style="margin:0 0 12px"><b>Files</b><br>${files.map((f, i) => `${esc(labels[f.question] || f.question)}: ${esc(f.name)} (attached as ${esc(`${f.question}-${i + 1}.${FILE_EXT[f.type] || 'bin'}`)})`).join('<br>')}</p>` : ''}</div>`;
  // Attachment names are ours, never the applicant's: their original names
  // are listed, escaped, in the body.
  const attachments = files.map((f, i) => ({ filename: `${f.question}-${i + 1}.${FILE_EXT[f.type] || 'bin'}`, content: Buffer.from(f.data).toString('base64'), content_type: f.type }));
  // While the database is down, its saved email settings cannot be read (or
  // safely refreshed): only the environment's Resend key can send.
  let settings = null;
  if (!dbError) { try { settings = await within(Promise.resolve(kit.email.settings?.()), LIMIT.after); } catch (e) { settings = null; } }
  try {
    const sent = await within(kit.email.send({ to, subject: `Backup copy: ${section.title} from ${entry.name}`, html, attachments, settings, clientId: dbError ? null : kit.email.clientId, saveOauth: kit.email.saveOauth }), LIMIT.email);
    if (!sent?.sent) console.error('[intake] backup email not sent', entry.id, sent?.reason || '');
    return Boolean(sent?.sent);
  } catch (e) {
    console.error('[intake] backup email failed', entry.id, e?.message || e);
    return false;
  }
}

// The same answers and files as the row already saved: a retry of a send
// whose answer never arrived, not a new submission to review.
const sameAsSaved = (existing, entry) => {
  if (!existing) return false;
  const norm = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k]]));
  const sizes = (list) => JSON.stringify((list || []).map((f) => [f.question || 'file', Number(f.size) || 0]).sort());
  return norm(existing.answers) === norm(entry.answers) && sizes(existing.files) === sizes(entry.files) && String(existing.name || '') === String(entry.name || '');
};

async function notifyLeads(kit, cycle, key, section, row) {
  // Only the addresses the form names; with none, nobody is emailed.
  const to = Array.isArray(section.notifyTo) ? section.notifyTo.filter(Boolean) : [];
  if (!to.length) return;
  const esc = kit.esc;
  const labels = Object.fromEntries(section.form.questions.map((q) => [q.key, q.label || q.key]));
  const answers = Object.entries(row.answers || {})
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([k, v]) => `<p style="margin:0 0 12px"><b>${esc(labels[k] || k)}</b><br>${esc(String(v).slice(0, 2000)).replace(/\n/g, '<br>')}</p>`).join('');
  const link = `https://${kit.email.host || 'wiki.cornellphysicalintelligence.com'}/#/applications/${encodeURIComponent(cycle.id)}/person?email=${encodeURIComponent(row.email)}`;
  const html = `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;color:#141414">
    <p><b>${esc(row.name)}</b> (${esc(row.email)}) sent the ${esc(section.title)} for ${esc(cycle.name)}.</p>
    ${row.subteam ? `<p style="margin:0 0 12px"><b>Subteam</b><br>${esc(row.subteam)}</p>` : ''}${row.year ? `<p style="margin:0 0 12px"><b>Year</b><br>${esc(row.year)}</p>` : ''}${answers}
    <p><a href="${link}">Open in the wiki</a></p></div>`;
  await kit.email.send({ to, subject: `${section.title}: ${row.name}`, html, settings: await kit.email.settings(), clientId: kit.email.clientId, saveOauth: kit.email.saveOauth });
}

async function submitRoute(rq, kit) {
  const key = rq.params.section;
  const { cycle, offline } = await liveCycle(kit);
  if (!cycle) throw fail(409, 'Applications are not open right now');
  const section = sectionsFor(cycle)[key];
  // A stage without a form (an interview the team runs) is not on the website.
  if (!section || !section.form) throw fail(404, 'No such form');
  if (!takesResponses(kit, cycle)) throw fail(409, 'The deadline has passed. This cycle is closed.');
  if (!section.open) throw fail(409, `${section.title} is closed right now`);
  const body = await rq.body();
  // The spam trap: answered without a receipt, but kept (answers only, no
  // files) so a real applicant an autofill tool caught can still be found.
  const trap = String(body?.website || body?.hp_8c1f || '').trim();
  if (trap) {
    const raw = body?.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers : {};
    const answers = Object.fromEntries(Object.entries(raw).slice(0, 80).map(([k, v]) => [String(k).slice(0, 60), typeof v === 'string' ? v.replace(/\u0000/g, '').slice(0, 4000) : Array.isArray(v) ? v.slice(0, 20).map((x) => String(x).slice(0, 200)) : v === true]));
    const trace = { id: `jr-${kit.now()}-${randomBytes(12).toString('hex')}`, ts: kit.now(), cycleId: cycle.id, section: key, trap: trap.slice(0, 200), answers };
    try { const journal = await kit.intake.journal(); await within(Promise.resolve(journal.keepSuspect?.(trace)), LIMIT.after); } catch (e) { /* the log line below remains */ }
    console.error('[intake] spam trap', JSON.stringify({ receipt: trace.id, section: key, name: String(answers.name || '').slice(0, 100), email: String(answers.email || '').slice(0, 200) }));
    return { status: 200, body: { ok: true } };
  }
  const v = validateAnswers(section.form, body, cycle);
  if (v.error) throw fail(v.status || 400, v.error);
  const now = kit.now();
  const files = v.files;
  // Public submissions never authorize replacing someone else's answers.
  const entry = {
    id: `jr-${now}-${randomBytes(12).toString('hex')}`, ts: now, ipHash: rq.ipHash || '', section: key, cycleId: cycle.id,
    name: v.columns.name, email: v.columns.email, subteam: v.columns.subteam, year: v.columns.year, hasYear: v.columns.hasYear,
    answers: v.answers, formSnapshot: section.form, confirmUpdate: false,
    version: 2, files: files.map(({ question, name, type, size }) => ({ question, name, type, size })),
  };
  // First copy: the private journal, kept even after the database has it.
  const journal = await kit.intake.journal();
  let journaled = false;
  try { journaled = await within(journal.append(entry, files, intakeLimits(cycle)), LIMIT.journal); }
  catch (e) {
    if (e.status === 429) throw fail(429, e.message);
    console.error('[intake] journal failed', entry.id, e?.message || e);
  }
  // Second copy: the database. One that does not answer in time counts as
  // failed; if it lands later, the receipt keeps it from landing twice.
  let result = null, dbError = null;
  if (offline) dbError = new Error('The database could not be reached');
  else {
    try { result = await within(kit.apps.commitIntake(cycle, entry, journal, files, { confirmUpdate: false, source: 'site' }), LIMIT.write); }
    catch (e) { dbError = e; console.error('[intake] database write failed', entry.id, e?.message || e); }
  }
  // Fewer than two copies: the team gets one by email, with the files.
  const outcome = result?.outcome;
  const mailed = !journaled || dbError ? await emailBackup(kit, { cycle, section, entry, files, journaled, dbError, outcome }) : false;
  if (!journaled && dbError) {
    // Neither store has it: the answers also go to the server log, so a
    // lost or bounced email still leaves a trace.
    console.error(`[intake] ${mailed ? 'EMAIL ONLY' : 'NOT SAVED'}`, JSON.stringify({ receipt: entry.id, cycleId: cycle.id, section: key, name: entry.name, email: entry.email, answers: entry.answers, files: entry.files }));
  }
  if (dbError) {
    if (journaled) { try { await within(Promise.resolve(journal.markRetry?.(entry.id)), LIMIT.after); } catch (e) { /* the admin queue still replays it */ } }
    if (journaled) return { status: 202, body: { ok: true, queued: true, receipt: entry.id, message: 'Saved. It will show up on the list shortly.' } };
    if (mailed) return { status: 202, body: { ok: true, queued: true, receipt: entry.id, message: 'Received. The team has your answers by email.' } };
    throw fail(503, 'Could not save right now. Try again in a minute.', { code: 'INTAKE_UNAVAILABLE' });
  }
  if (outcome === 'closed') throw fail(409, 'The deadline has passed. This cycle is closed.');
  if (outcome === 'held') throw fail(409, `${section.title} is full`);
  if (outcome === 'review') {
    // A resend of exactly what is saved (an answer that never arrived) is
    // marked done so it never waits in the queue as a duplicate.
    if (journaled && sameAsSaved(result.existing, entry)) { try { await within(journal.complete(entry.id, 'review'), LIMIT.after); } catch (e) { /* stays in the queue; harmless */ } }
    return { status: 409, body: { exists: true, replaceable: false, submitted: result.existing?.ts || null, receipt: entry.id, error: 'A submission already exists for this email. To correct it, email cuphysint@cornell.edu.' } };
  }
  if (journaled && (outcome === 'saved' || outcome === 'superseded')) { try { await within(journal.complete(entry.id, outcome), LIMIT.after); } catch (e) { /* the receipt prevents repeats */ } }
  if (outcome === 'superseded') throw fail(409, 'A newer submission was saved. Your changes were not applied. Review them and submit again.', { code: 'SUBMISSION_SUPERSEDED' });
  if (outcome !== 'saved') throw fail(503, 'Could not confirm your submission. Try again in a minute.', { code: 'INTAKE_UNAVAILABLE' });
  if (result.inserted && result.row) {
    try { await within(kit.audit({ kind: 'app.create', cycleId: cycle.id, applicationId: result.row.id, actor: 'applicant', detail: { receipt: entry.id, source: 'site', section: key } }), LIMIT.after); } catch (e) { /* durable already */ }
    if (section.notify !== false) { try { await within(notifyLeads(kit, cycle, key, section, result.row), LIMIT.notify); } catch (e) { /* never fails a submission */ } }
  }
  let next = [];
  try { next = await within(nextForms(kit, cycle, key, entry), LIMIT.after); } catch (e) { /* the submission stands without it */ }
  return { status: 200, body: { ok: true, receipt: entry.id, ...(next.length ? { next } : {}) } };
}

// The open forms this applicant goes to after the one they just sent: every
// connection out of it, and of a split only the way their answers pick. The
// site can link them there; forms they have already sent are left out.
async function nextForms(kit, cycle, key, entry) {
  const sections = sectionsFor(cycle);
  const flow = flowOf(sections);
  const targets = flow.edges.get(key) || [];
  if (!targets.some((k) => sections[k]?.form && sections[k].open)) return [];
  const mine = flow.splits.size ? await kit.apps.allByEmail(cycle.id, entry.email) : [];
  const submissions = [...mine.filter((a) => a.erasedAt == null).map((a) => ({ section: a.section || 'interest', ts: Number(a.ts) || 0, answers: a.answers || {}, subteam: a.subteam, year: a.year })), { section: key, ts: entry.ts, answers: entry.answers, subteam: entry.subteam, year: entry.year }];
  const sent = new Set(submissions.map((x) => x.section));
  return nextOf(flow, key, submissions).filter((k) => sections[k]?.form && sections[k].open && !sent.has(k)).map((k) => ({ key: k, title: sections[k].title }));
}

export default {
  name: 'site',
  label: 'Website',
  kernel: true,
  order: 15,
  schema: [],
  memory: {},
  defaults: () => ({}),
  validateSettings: (next, cycle) => validateSite(next, cycle),
  routes: [
    { method: 'GET', path: '/site', access: 'public', handler: siteRoute },
    { method: 'POST', path: '/site/:section', access: 'public', cap: 4000000, handler: submitRoute },
  ],
  hooks: {},
  collect: {},
  auditKinds: ['app.create'],
};
