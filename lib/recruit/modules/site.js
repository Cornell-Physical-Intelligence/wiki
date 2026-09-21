// Website module (kernel): what the club site reads and where it posts.
// GET /api/recruit/site describes the cycle receiving the website and its
// three sections; POST /api/recruit/site/:section takes a submission for one
// of them. Both are public, CORS-limited to the site, and rate-limited by the
// registry. Submissions are journaled first, then written, exactly like the
// interest form's fixed POST.

import { randomBytes } from 'node:crypto';
import { validateAnswers } from '../fixed-form.js';
import { sectionsFor, publicSections, validateSite, landingFor } from '../sections.js';

const fail = (status, error, extra = {}) => Object.assign(new Error(error), { status, error, ...extra });

async function liveCycle(kit) {
  const target = await kit.cycles.intakeTarget();
  return target ? kit.cycles.get(target.cycleId) : null;
}

async function siteRoute(rq, kit) {
  // Not cached anywhere: an edit in Settings must show on the next page load.
  const headers = { 'cache-control': 'no-store' };
  const cycle = await liveCycle(kit);
  if (!cycle) {
    // Before a cycle receives the website, the site shows the interest form
    // as it always has; that POST still lands in the legacy inbox.
    const interest = publicSections(null).find((s) => s.key === 'interest');
    return { status: 200, body: { cycle: null, landing: 'interest', sections: [{ ...interest, open: true }] }, headers };
  }
  // `landing` is the form /apply shows; the others are reached by their own pages.
  return { status: 200, body: { cycle: { id: cycle.id, name: cycle.name, term: cycle.term, status: cycle.status }, landing: landingFor(cycle), sections: publicSections(cycle) }, headers };
}

async function notifyLeads(kit, cycle, key, section, row) {
  const settings = await kit.cycles.settings();
  // The form's own recipients when it has any, else the wiki's default list.
  const own = Array.isArray(section.notifyTo) ? section.notifyTo.filter(Boolean) : [];
  const to = own.length ? own : (Array.isArray(settings.doc?.notify) ? settings.doc.notify.filter(Boolean) : []);
  if (!to.length || cycle.doc?.intake?.notify === false) return;
  const esc = kit.esc;
  const labels = Object.fromEntries(section.form.questions.map((q) => [q.key, q.label || q.key]));
  const answers = Object.entries(row.answers || {})
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([k, v]) => `<p style="margin:0 0 12px"><b>${esc(labels[k] || k)}</b><br>${esc(String(v).slice(0, 2000)).replace(/\n/g, '<br>')}</p>`).join('');
  const link = `https://${kit.email.host || 'wiki.cornellphysicalintelligence.com'}/#/applications/${encodeURIComponent(cycle.id)}/${key}`;
  const html = `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;color:#141414">
    <p><b>${esc(row.name)}</b> (${esc(row.email)}) sent the ${esc(section.title)} for ${esc(cycle.name)}.</p>
    ${row.subteam ? `<p style="margin:0 0 12px"><b>Subteam</b><br>${esc(row.subteam)}</p>` : ''}${row.year ? `<p style="margin:0 0 12px"><b>Year</b><br>${esc(row.year)}</p>` : ''}${answers}
    <p><a href="${link}">Open in the wiki</a></p></div>`;
  await kit.email.send({ to, subject: `${section.title}: ${row.name}`, html, settings: await kit.email.settings(), clientId: kit.email.clientId, saveOauth: kit.email.saveOauth });
}

async function submitRoute(rq, kit) {
  const key = rq.params.section;
  const cycle = await liveCycle(kit);
  if (!cycle) throw fail(409, 'Applications are not open right now');
  const section = sectionsFor(cycle)[key];
  if (!section) throw fail(404, 'No such form');
  if (!section.open) throw fail(409, `${section.title} is closed right now`);
  const body = await rq.body();
  if (String(body?.website || '').trim()) return { status: 200, body: { ok: true } }; // honeypot
  const v = validateAnswers(section.form, body, cycle);
  if (v.error) throw fail(v.status || 400, v.error);
  const now = kit.now();
  const file = v.files[0] || null;
  const intake = { perIpHour: 5, perDay: 2000, notify: true, confirmUpdate: true, ...(cycle.doc?.intake || {}) };
  // The form's own cap first; the cycle-wide number is the older setting.
  const capacity = Number(section.capacity) > 0 ? Number(section.capacity) : Number(cycle.doc?.capacity || 0);
  if (capacity > 0 && (await kit.apps.count(cycle.id, key)) >= capacity) throw fail(409, `${section.title} is full`);
  const replaceable = section.replace !== false && intake.confirmUpdate !== false;
  const entry = {
    id: `jr-${now}-${randomBytes(12).toString('hex')}`, ts: now, ipHash: rq.ipHash || '', section: key, cycleId: cycle.id,
    name: v.columns.name, email: v.columns.email, subteam: v.columns.subteam, year: v.columns.year, hasYear: v.columns.hasYear,
    answers: v.answers, confirmUpdate: body.confirmUpdate === true,
    fileName: file?.name || null, fileType: file?.type || null, fileSize: file?.data?.length || null,
  };
  const journal = await kit.intake.journal();
  let journaled = false;
  try { journaled = await journal.append(entry, file, { perDay: intake.perDay, perIpHour: intake.perIpHour }); }
  catch (e) { if (e.status === 429) throw fail(429, e.message); }
  let result;
  try {
    result = await kit.apps.commitIntake(cycle, entry, journal, file, { confirmUpdate: entry.confirmUpdate && replaceable, source: 'site' });
  } catch (e) {
    if (journaled) return { status: 202, body: { ok: true, queued: true, receipt: entry.id, message: 'Saved. It will show up on the list shortly.' } };
    throw fail(503, 'Could not save right now. Try again in a minute.', { code: 'INTAKE_UNAVAILABLE' });
  }
  if (result.outcome === 'review') {
    return { status: 409, body: { exists: true, replaceable, submitted: result.existing?.ts || null, receipt: entry.id, error: replaceable ? 'You already sent this form with this email. Confirm to replace your earlier answers.' : 'You already sent this form with this email.' } };
  }
  if (journaled && (result.outcome === 'saved' || result.outcome === 'superseded')) { try { await journal.complete(entry.id, result.outcome); } catch (e) { /* the receipt prevents repeats */ } }
  if (result.outcome === 'saved' && result.inserted && result.row) {
    try { await kit.audit({ kind: 'app.create', cycleId: cycle.id, applicationId: result.row.id, actor: 'applicant', detail: { receipt: entry.id, source: 'site', section: key } }); } catch (e) { /* durable already */ }
    if (intake.notify !== false && section.notify !== false) { try { await notifyLeads(kit, cycle, key, section, result.row); } catch (e) { /* never fails a submission */ } }
  }
  return { status: 200, body: { ok: true, receipt: entry.id } };
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
    { method: 'POST', path: '/site/:section', access: 'public', cap: 3600000, handler: submitRoute },
  ],
  hooks: {},
  collect: {},
  auditKinds: ['app.create'],
};

