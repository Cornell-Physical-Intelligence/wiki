// The interest-list component. Everything about the Apply-page form lives
// here: its own tables, rate limits, validation, notification email, CSV,
// and admin routes. The core wiki mounts it at /api/interest* and passes a
// small capability context; it knows nothing else about this feature.
// Delete this file and the mount line, and the wiki is exactly what it was.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { storageMode, rawSql, putFile, getFile, deleteFile } from './db.js';
import { freshOauthToken, resolveFrom } from './email.js';
import { intakeJournal, newIntakeReceipt } from './intake-journal.js';

const MAIN_SITE = 'https://cornellphysicalintelligence.com';
const WIKI_URL = (process.env.WIKI_URL || 'https://wiki.cornellphysicalintelligence.com').replace(/\/$/, '');
const NOTIFY = (process.env.INTEREST_NOTIFY || 'ab3233@cornell.edu')
  .split(',').map((s) => s.trim()).filter(Boolean);
const SUBTEAMS = new Set(['Mechanical', 'Electrical', 'Software', 'Creative', 'Business & Marketing']);
const YEARS = new Set(['Freshman', 'Sophomore', 'Junior', 'Senior', 'Grad']);
const FILE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);
const MAX_FILE = 2.5 * 1024 * 1024;

// IPs never touch storage raw — only a salted hash used for rate limiting.
const IP_SALT = process.env.SESSION_SECRET || 'cupi-dev-salt';
const instanceHits = new Map(); // per-instance pre-gate: ipHash -> recent timestamps

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const json = (res, code, obj) => {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
};

const ipHashOf = (req) => {
  const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
    .split(',')[0].trim();
  return createHash('sha256').update(`interest|${IP_SALT}|${ip}`).digest('hex').slice(0, 24);
};

// Exact-origin CORS: the main site in production, localhost only under dev auth.
const cors = (req, res) => {
  const origin = req.headers.origin || '';
  const devOk = process.env.DEV_FAKE_AUTH && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
  if (origin === MAIN_SITE || origin === WIKI_URL || devOk) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    return true;
  }
  return false;
};

/* ------------------------------- storage ----------------------------------
   Own tables in production; in dev (memory mode) a JSON file beside the
   wiki's own dev data, so `npm run dev` still needs nothing. */

const DEV_FILE = new URL('../.devinterest.json', import.meta.url);
const mem = { rows: null, events: [], archives: [], receipts: {} };

function memLoad() {
  if (mem.rows) return;
  if (existsSync(DEV_FILE)) {
    try {
      const d = JSON.parse(readFileSync(DEV_FILE, 'utf8'));
      mem.rows = d.rows || [];
      mem.events = d.events || [];
      mem.archives = d.archives || [];
      mem.receipts = d.receipts || {};
      return;
    } catch (e) { /* reseed */ }
  }
  mem.rows = [];
  mem.events = [];
  mem.archives = [];
}

function memSave() {
  try { writeFileSync(DEV_FILE, JSON.stringify({ rows: mem.rows, events: mem.events, archives: mem.archives, receipts: mem.receipts })); } catch (e) { /* dev only */ }
}

let tablesReady = false;
async function sql() {
  const s = await rawSql();
  if (!tablesReady) {
    await s`CREATE TABLE IF NOT EXISTS interest_submissions (
      id text PRIMARY KEY, ts bigint NOT NULL, updated bigint NOT NULL,
      name text NOT NULL, email text UNIQUE NOT NULL,
      subteam text NOT NULL DEFAULT '', project text NOT NULL DEFAULT '',
      cornell boolean NOT NULL DEFAULT false,
      file_id text, file_name text, file_type text, file_size int,
      ip_hash text NOT NULL DEFAULT '')`;
    // Additive migration: existing submissions keep an unknown year (NULL).
    await s`ALTER TABLE interest_submissions ADD COLUMN IF NOT EXISTS year text`;
    await s`CREATE TABLE IF NOT EXISTS interest_events (ts bigint NOT NULL, ip_hash text NOT NULL)`;
    // A receipt commits in the same statement as its row. It survives list
    // archives/deletions so a delayed journal replay cannot resurrect a row.
    await s`CREATE TABLE IF NOT EXISTS interest_receipts (id text PRIMARY KEY, outcome text NOT NULL, ts bigint NOT NULL)`;
    // Archives: a named snapshot per recruiting cycle. Rows are copied whole,
    // and their files are deliberately left in place so an archive's
    // attachments keep working years later.
    await s`CREATE TABLE IF NOT EXISTS interest_archives (
      id text PRIMARY KEY, ts bigint NOT NULL, name text NOT NULL,
      count int NOT NULL DEFAULT 0, rows jsonb NOT NULL DEFAULT '[]'::jsonb)`;
    tablesReady = true;
  }
  return s;
}

// jsonb comes back parsed from the driver, but a string can slip through some
// paths; normalise to an array either way.
const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};

const rowFromPg = (r) => ({
  id: r.id, ts: Number(r.ts), updated: Number(r.updated),
  name: r.name, email: r.email, subteam: r.subteam, project: r.project,
  cornell: r.cornell, year: r.year || null,
  fileId: r.file_id || null, fileName: r.file_name || null,
  fileType: r.file_type || null, fileSize: r.file_size == null ? null : Number(r.file_size),
});

async function listRows() {
  if (storageMode() === 'memory') {
    memLoad();
    return [...mem.rows].sort((a, b) => b.ts - a.ts);
  }
  const s = await sql();
  const r = await s`SELECT * FROM interest_submissions ORDER BY ts DESC`;
  return r.rows.map(rowFromPg);
}

async function findByEmail(email) {
  if (storageMode() === 'memory') { memLoad(); return mem.rows.find((r) => r.email === email) || null; }
  const s = await sql();
  const r = await s`SELECT * FROM interest_submissions WHERE email = ${email}`;
  return r.rows[0] ? rowFromPg(r.rows[0]) : null;
}

async function receiptOutcome(id) {
  if (storageMode() === 'memory') { memLoad(); return mem.receipts[id] || null; }
  const s = await sql();
  const r = await s`SELECT outcome FROM interest_receipts WHERE id = ${id}`;
  return r.rows[0]?.outcome || null;
}

async function recordOutcome(entry, outcome) {
  if (storageMode() === 'memory') {
    memLoad(); mem.receipts[entry.id] ||= outcome; memSave(); return mem.receipts[entry.id];
  }
  const s = await sql();
  await s`INSERT INTO interest_receipts (id, outcome, ts) VALUES (${entry.id}, ${outcome}, ${entry.ts}) ON CONFLICT DO NOTHING`;
  return receiptOutcome(entry.id);
}

async function commitIntake(entry, journal, originalFile = null) {
  const prior = await receiptOutcome(entry.id);
  if (prior) return { outcome: prior };
  const existing = await findByEmail(entry.email);
  if (existing && !entry.confirmUpdate) {
    return { outcome: await recordOutcome(entry, 'review'), existing };
  }
  if (existing && existing.updated > entry.ts) {
    return { outcome: await recordOutcome(entry, 'superseded'), existing };
  }
  if (!existing && await countStored() >= 1000) return { outcome: await recordOutcome(entry, 'held') };
  let fileMeta = {};
  if (entry.fileSize) {
    const data = originalFile?.data || await journal.getFile(entry.id);
    if (!data || data.length !== entry.fileSize) throw new Error('Saved attachment is not available yet');
    const id = 'int-' + entry.id.replace(/[^a-z0-9]/g, '');
    if (storageMode() === 'memory') {
      if (!await getFile(id)) await putFile({ id, name: entry.fileName, type: entry.fileType, size: data.length, by: entry.email, ts: entry.ts, data });
    } else {
      const s = await sql();
      await s`INSERT INTO wiki_files (id, name, type, size, by, ts, data)
        VALUES (${id}, ${entry.fileName}, ${entry.fileType}, ${data.length}, ${entry.email}, ${entry.ts}, decode(${data.toString('base64')}, 'base64'))
        ON CONFLICT (id) DO NOTHING`;
    }
    fileMeta = { fileId: id, fileName: entry.fileName, fileType: entry.fileType, fileSize: entry.fileSize };
  }
  const row = {
    id: existing?.id || 'in-' + entry.id.replace(/[^a-z0-9]/g, ''),
    ts: existing?.ts || entry.ts, updated: entry.ts,
    name: entry.name, email: entry.email, subteam: entry.subteam, project: entry.project,
    cornell: entry.email.endsWith('@cornell.edu') || entry.email.endsWith('.cornell.edu'),
    year: entry.hasYear ? entry.year : (existing?.year || null), ipHash: entry.ipHash,
    fileId: existing?.fileId || null, fileName: existing?.fileName || null,
    fileType: existing?.fileType || null, fileSize: existing?.fileSize || null,
    ...fileMeta,
  };
  let outcome;
  if (storageMode() === 'memory') {
    // No asynchronous work between the final check and durable local write.
    const current = mem.rows.find((r) => r.email === entry.email);
    if (mem.receipts[entry.id]) return { outcome: mem.receipts[entry.id] };
    if (current && !entry.confirmUpdate) outcome = 'review';
    else if (current && current.updated > entry.ts) outcome = 'superseded';
    else {
      if (current) mem.rows[mem.rows.indexOf(current)] = row; else mem.rows.push(row);
      outcome = 'saved';
    }
    mem.receipts[entry.id] = outcome; memSave();
  } else {
    const s = await sql();
    const r = await s`WITH prior AS (
      SELECT outcome FROM interest_receipts WHERE id = ${entry.id}
    ), written AS (
      INSERT INTO interest_submissions (id, ts, updated, name, email, subteam, project, cornell, file_id, file_name, file_type, file_size, ip_hash, year)
      SELECT ${row.id}, ${row.ts}, ${row.updated}, ${row.name}, ${row.email}, ${row.subteam}, ${row.project}, ${row.cornell},
        ${fileMeta.fileId || null}, ${fileMeta.fileName || null}, ${fileMeta.fileType || null}, ${fileMeta.fileSize || null}, ${row.ipHash}, ${row.year}
      WHERE NOT EXISTS (SELECT 1 FROM prior)
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, subteam = EXCLUDED.subteam,
        project = EXCLUDED.project, updated = EXCLUDED.updated, ip_hash = EXCLUDED.ip_hash,
        year = CASE WHEN ${entry.hasYear} THEN EXCLUDED.year ELSE interest_submissions.year END,
        file_id = COALESCE(EXCLUDED.file_id, interest_submissions.file_id),
        file_name = COALESCE(EXCLUDED.file_name, interest_submissions.file_name),
        file_type = COALESCE(EXCLUDED.file_type, interest_submissions.file_type),
        file_size = COALESCE(EXCLUDED.file_size, interest_submissions.file_size)
      WHERE ${entry.confirmUpdate} AND interest_submissions.updated <= EXCLUDED.updated
      RETURNING id
    ), recorded AS (
      INSERT INTO interest_receipts (id, outcome, ts)
      SELECT ${entry.id}, CASE WHEN EXISTS (SELECT 1 FROM written) THEN 'saved'
        WHEN ${entry.confirmUpdate} THEN 'superseded' ELSE 'review' END, ${entry.ts}
      WHERE NOT EXISTS (SELECT 1 FROM prior)
      ON CONFLICT DO NOTHING RETURNING outcome
    ) SELECT outcome FROM recorded UNION ALL SELECT outcome FROM prior LIMIT 1`;
    outcome = r.rows[0]?.outcome || await receiptOutcome(entry.id);
    if (!outcome) throw new Error('The saved receipt could not be verified');
  }
  return { outcome, existing, row };
}

const pendingEntry = (entry, reason) => ({
  id: entry.id, receivedAt: entry.ts, reason, name: entry.name, email: entry.email,
  subteam: entry.subteam, year: entry.year, project: entry.project,
  fileName: entry.fileName, fileType: entry.fileType, fileSize: entry.fileSize,
  ...(entry.fileSize ? { fileUrl: `/api/interest/queue/${entry.id}/file` } : {}),
});

async function replayIntake(journal) {
  let entries;
  try { entries = await journal.listPending(); }
  catch (e) { return { pendingReview: [], queueUnavailable: true }; }
  const pendingReview = [];
  for (const entry of entries) {
    try {
      const result = await commitIntake(entry, journal);
      if (result.outcome === 'review' || result.outcome === 'held') pendingReview.push(pendingEntry(entry, result.outcome === 'review' ? 'duplicate' : 'capacity'));
      else {
        try { await journal.complete(entry.id, result.outcome); } catch (e) { /* receipt prevents repeat writes */ }
      }
    } catch (e) { pendingReview.push(pendingEntry(entry, 'replay_failed')); }
  }
  return { pendingReview, queueUnavailable: false };
}

async function removeRow(id) {
  if (storageMode() === 'memory') {
    memLoad();
    const i = mem.rows.findIndex((r) => r.id === id);
    if (i < 0) return null;
    const [row] = mem.rows.splice(i, 1);
    memSave();
    return row;
  }
  const s = await sql();
  const r = await s`DELETE FROM interest_submissions WHERE id = ${id} RETURNING *`;
  return r.rows[0] ? rowFromPg(r.rows[0]) : null;
}

async function clearRows(archivedRows) {
  if (storageMode() === 'memory') {
    memLoad();
    const versions = new Map(archivedRows.map((r) => [r.id, r.updated]));
    const rows = mem.rows.filter((r) => versions.get(r.id) === r.updated);
    mem.rows = mem.rows.filter((r) => versions.get(r.id) !== r.updated);
    memSave();
    return rows;
  }
  const s = await sql();
  // Only remove versions that were actually copied into this archive. A new
  // application or edit arriving during archiving must remain on the live list.
  const versions = JSON.stringify(archivedRows.map((r) => ({ id: r.id, updated: r.updated })));
  const r = await s`DELETE FROM interest_submissions AS live
    USING jsonb_to_recordset(${versions}::jsonb) AS archived(id text, updated bigint)
    WHERE live.id = archived.id AND live.updated = archived.updated RETURNING live.*`;
  return r.rows.map(rowFromPg);
}

/* -------------------------------- archives -------------------------------- */

async function listArchives() {
  if (storageMode() === 'memory') {
    memLoad();
    return [...mem.archives].sort((a, b) => b.ts - a.ts).map(({ rows, ...meta }) => meta);
  }
  const s = await sql();
  const r = await s`SELECT id, ts, name, count FROM interest_archives ORDER BY ts DESC`;
  return r.rows.map((x) => ({ id: x.id, ts: Number(x.ts), name: x.name, count: Number(x.count) }));
}

async function getArchive(id) {
  if (storageMode() === 'memory') { memLoad(); return mem.archives.find((a) => a.id === id) || null; }
  const s = await sql();
  const r = await s`SELECT * FROM interest_archives WHERE id = ${id}`;
  const a = r.rows[0];
  return a ? { id: a.id, ts: Number(a.ts), name: a.name, count: Number(a.count), rows: asArray(a.rows) } : null;
}

async function putArchive(archive) {
  if (storageMode() === 'memory') { memLoad(); mem.archives.push(archive); memSave(); return; }
  const s = await sql();
  await s`INSERT INTO interest_archives (id, ts, name, count, rows)
    VALUES (${archive.id}, ${archive.ts}, ${archive.name}, ${archive.count}, ${JSON.stringify(archive.rows)}::jsonb)`;
}

async function removeArchive(id) {
  if (storageMode() === 'memory') {
    memLoad();
    const i = mem.archives.findIndex((a) => a.id === id);
    if (i < 0) return null;
    const [a] = mem.archives.splice(i, 1);
    memSave();
    return a;
  }
  const s = await sql();
  const r = await s`DELETE FROM interest_archives WHERE id = ${id} RETURNING *`;
  const a = r.rows[0];
  return a ? { id: a.id, ts: Number(a.ts), name: a.name, rows: asArray(a.rows) } : null;
}

async function countStored() {
  if (storageMode() === 'memory') { memLoad(); return mem.rows.length; }
  const s = await sql();
  return Number((await s`SELECT count(*) AS n FROM interest_submissions`).rows[0].n);
}

async function logEvent(ipHash, now) {
  if (storageMode() === 'memory') {
    memLoad();
    mem.events = mem.events.filter((e) => now - e.ts < 86400000).slice(-1999);
    mem.events.push({ ts: now, h: ipHash });
    memSave();
    return;
  }
  const s = await sql();
  await s`DELETE FROM interest_events WHERE ts < ${now - 86400000}`;
  await s`INSERT INTO interest_events (ts, ip_hash) VALUES (${now}, ${ipHash})`;
}

async function eventCounts(ipHash, now) {
  if (storageMode() === 'memory') {
    memLoad();
    const day = mem.events.filter((e) => now - e.ts < 86400000);
    return { hourSameIp: day.filter((e) => e.h === ipHash && now - e.ts < 3600000).length, day: day.length };
  }
  const s = await sql();
  const hour = await s`SELECT count(*) AS n FROM interest_events WHERE ip_hash = ${ipHash} AND ts > ${now - 3600000}`;
  const day = await s`SELECT count(*) AS n FROM interest_events WHERE ts > ${now - 86400000}`;
  return { hourSameIp: Number(hour.rows[0].n), day: Number(day.rows[0].n) };
}

/* ----------------------------- notification ------------------------------- */

async function notify({ sub, host, settings, clientId, saveOauth }) {
  let apiKey;
  if (settings?.oauth?.refresh && clientId) {
    try { apiKey = await freshOauthToken(settings.oauth, clientId, saveOauth); }
    catch (e) { return { sent: false, reason: 'expired Resend connection' }; }
  } else {
    apiKey = settings?.key || process.env.RESEND_API_KEY;
  }
  if (!apiKey) return { sent: false, reason: 'no Resend connection' };
  const from = await resolveFrom(apiKey, settings);
  const row = (k, v) => `<tr><td style="padding:6px 14px 6px 0;color:#888;font-size:12px;letter-spacing:.08em;text-transform:uppercase;vertical-align:top;white-space:nowrap">${k}</td><td style="padding:6px 0;font-size:14.5px">${v}</td></tr>`;
  const html = `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:0 4px;color:#141414;background:#ffffff">
    <div style="font-size:28px;font-weight:700;font-family:Georgia,serif;margin:26px 0 2px">CUPI</div>
    <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#888;margin-bottom:16px">New interest submission</div>
    <table style="border-collapse:collapse">
      ${row('Name', `<b>${esc(sub.name)}</b>${sub.cornell ? '' : ' <span style="color:#8a5f00;font-size:12px">(not a cornell.edu address)</span>'}`)}
      ${row('Email', esc(sub.email))}
      ${row('Year', esc(sub.year || 'Not provided'))}
      ${row('Subteam', esc(sub.subteam || 'Not sure yet'))}
      ${row('Coolest project', sub.project ? esc(sub.project) : '<span style="color:#999">(blank)</span>')}
      ${row('File', sub.fileName ? `${esc(sub.fileName)} (${Math.max(1, Math.round(sub.fileSize / 1024))} KB, in the wiki)` : '<span style="color:#999">none</span>')}
    </table>
    <p style="margin:22px 0"><a href="https://${host}/#/interest" style="display:inline-block;background:#141414;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600">Open the interest list</a></p>
    <p style="color:#777;font-size:12.5px">Sent by the interest form on cornellphysicalintelligence.com/apply.</p>
  </div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: NOTIFY, subject: `New CUPI interest: ${sub.name}${sub.subteam ? ` (${sub.subteam})` : ''}`, html }),
    });
    if (!r.ok) return { sent: false, reason: `Resend ${r.status}` };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

/* -------------------------------- routes ----------------------------------
   ctx: { readJson, host, clientId, me(), emailSettings(), saveOauth() } */

export async function handleInterest(req, res, path, ctx) {
  /* ---- public: the form posts here ---- */

  if (path === '/interest' && req.method === 'OPTIONS') {
    const ok = cors(req, res);
    if (ok) {
      res.setHeader('access-control-allow-methods', 'POST');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-max-age', '86400');
    }
    res.statusCode = ok ? 204 : 403;
    return res.end();
  }

  if (path === '/interest' && req.method === 'POST') {
    if (!cors(req, res)) return json(res, 403, { error: 'Origin not allowed' });
    if (!/application\/json/.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'JSON only' });

    // Instance-local pre-gate: hot loops die before storage hears of them.
    const ipHash = ipHashOf(req);
    const now = Date.now();
    const hits = (instanceHits.get(ipHash) || []).filter((t) => now - t < 60000);
    hits.push(now);
    instanceHits.set(ipHash, hits);
    if (instanceHits.size > 5000) instanceHits.clear(); // memory backstop
    if (hits.length > 3) return json(res, 429, { error: 'Too many submissions. Give it a minute' });

    const body = await ctx.readJson(req, 3600000);
    // Honeypot: humans never see the field; bots fill everything. Pretend
    // success so the bot moves on, store nothing.
    if (String(body.website || '').trim()) return json(res, 200, { ok: true });

    const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
    const subteam = SUBTEAMS.has(body.subteam) ? body.subteam : '';
    const hasYear = Object.hasOwn(body, 'year');
    if (hasYear && body.year != null && body.year !== '' && !YEARS.has(body.year)) {
      return json(res, 400, { error: 'Choose Freshman, Sophomore, Junior, Senior, or Grad for year' });
    }
    const year = YEARS.has(body.year) ? body.year : null;
    const project = String(body.project || '').trim().slice(0, 1000);
    if (!name) return json(res, 400, { error: 'Tell us your name' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json(res, 400, { error: 'That email does not look right' });

    let file = null;
    if (body.file && typeof body.file === 'object' && body.file.data) {
      const data = String(body.file.data);
      if (!/^[A-Za-z0-9+/=]+$/.test(data)) return json(res, 400, { error: 'The file did not decode' });
      const buf = Buffer.from(data, 'base64');
      if (buf.length) {
        if (buf.length > MAX_FILE) return json(res, 413, { error: 'Files are capped at 2.5 MB' });
        const type = String(body.file.type || '');
        if (!FILE_TYPES.has(type)) return json(res, 400, { error: 'Images or PDF only' });
        file = { name: String(body.file.name || 'project').slice(0, 200), type, data: buf };
      }
    }

    const journal = ctx.journal || intakeJournal;
    const entry = {
      id: newIntakeReceipt(now), ts: now, ipHash, name, email, subteam, project, year, hasYear,
      confirmUpdate: Boolean(body.confirmUpdate),
      fileName: file?.name || null, fileType: file?.type || null, fileSize: file?.data.length || null,
    };
    let journaled = false;
    let rejection = null;
    try { journaled = await journal.append(entry, file); }
    catch (e) {
      if (e.status === 429) return json(res, 429, { error: e.message });
      // Independent failures are allowed: Neon can still durably accept this
      // submission if Blob is temporarily unavailable or not configured.
    }
    try {
      const reject = async (error) => {
        rejection = { status: 429, body: { error } };
        await recordOutcome(entry, 'rejected');
        if (journaled) { try { await journal.complete(entry.id, 'rejected'); } catch (e) { /* ledger is durable */ } }
        return json(res, 429, { error });
      };
      const counts = await eventCounts(ipHash, now);
      if (counts.hourSameIp >= 5) return await reject('Too many submissions from this network today');
      if (counts.day >= 300) return await reject('The interest list is briefly closed. Email cuphysint@cornell.edu instead');
      const existing = await findByEmail(email);
      // An admin refresh can replay this new journal while its public request
      // is still running. A receipt already committed by that replay is success.
      if (existing && await receiptOutcome(entry.id) === 'saved') {
        if (journaled) { try { await journal.complete(entry.id, 'saved'); } catch (e) { /* ledger is durable */ } }
        return json(res, 200, { ok: true, receipt: entry.id });
      }
      if (!existing && await countStored() >= 1000) return await reject('The interest list is full. Email cuphysint@cornell.edu instead');
      if (existing && !entry.confirmUpdate) {
        rejection = { status: 409, body: { exists: true, submitted: existing.ts, receipt: entry.id, error: 'This email is already on the interest list' } };
        await recordOutcome(entry, 'rejected');
        if (journaled) { try { await journal.complete(entry.id, 'confirmation_required'); } catch (e) { /* ledger is durable */ } }
        return json(res, 409, { exists: true, submitted: existing.ts, receipt: entry.id, error: 'This email is already on the interest list' });
      }
      await logEvent(ipHash, now);
      const result = await commitIntake(entry, journal, file);
      if (result.outcome === 'review') {
        // Another request may have inserted this email after the earlier check.
        return json(res, 409, { exists: true, submitted: result.existing?.ts || now, receipt: entry.id, error: 'This email is already on the interest list' });
      }
      if (journaled) { try { await journal.complete(entry.id, result.outcome); } catch (e) { /* receipt prevents duplicate replay */ } }
      if (result.outcome === 'saved' && !result.existing) {
        try {
          await notify({ sub: result.row, host: ctx.host, settings: await ctx.emailSettings(), clientId: ctx.clientId, saveOauth: ctx.saveOauth });
        } catch (e) { /* both stores keep the application even if notification fails */ }
      }
      return json(res, 200, { ok: true, receipt: entry.id });
    } catch (e) {
      // A known rejection stays a rejection even if recording its receipt has
      // an uncertain response. Never turn a saved rejection into queued success.
      if (rejection) return json(res, rejection.status, rejection.body);
      if (journaled) return json(res, 202, {
        ok: true, queued: true, receipt: entry.id,
        message: 'Your application is saved. The team will review it when syncing is restored.',
      });
      res.setHeader('retry-after', '60');
      return json(res, 503, {
        error: 'Your application could not be saved. Keep this page open and try again, or email cuphysint@cornell.edu.',
        code: 'INTAKE_UNAVAILABLE',
      });
    }
  }

  /* ---- everything else is for signed-in admins ---- */

  const me = await ctx.me();
  if (!me) return json(res, 401, { error: 'Not signed in' });
  if (me.role !== 'admin') return json(res, 403, { error: 'Admins only' });

  const journal = ctx.journal || intakeJournal;
  if (path === '/interest/storage-check' && req.method === 'POST') {
    try { return json(res, 200, await journal.check()); }
    catch (e) { return json(res, 503, { error: 'Private intake storage could not be verified. Try again shortly.' }); }
  }
  if (path === '/interest' && req.method === 'GET') {
    const queue = await replayIntake(journal);
    return json(res, 200, { rows: await listRows(), ...queue });
  }

  const queuedFile = path.match(/^\/interest\/queue\/(jr-\d{13}-[a-f0-9]{24})\/file$/);
  if (queuedFile && req.method === 'GET') {
    const entry = await journal.getEntry(queuedFile[1]);
    if (!entry?.fileSize) return json(res, 404, { error: 'No saved attachment' });
    const data = await journal.getFile(entry.id);
    if (!data) return json(res, 503, { error: 'The saved attachment is temporarily unavailable' });
    res.statusCode = 200;
    res.setHeader('content-type', entry.fileType || 'application/octet-stream');
    res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(entry.fileName || 'attachment')}"`);
    res.setHeader('cache-control', 'private, no-store');
    return res.end(data);
  }

  // The list as a spreadsheet, generated fresh on every download.
  if (path === '/interest.csv') {
    return sendCsv(res, await listRows(), `cupi-interest-${new Date().toISOString().slice(0, 10)}`);
  }

  /* ---- archives: one named snapshot per recruiting cycle ---- */

  if (path === '/interest/archives' && req.method === 'GET') {
    return json(res, 200, { archives: await listArchives() });
  }

  // Archiving is how the live list is emptied: nothing is destroyed, and the
  // snapshot keeps its files so old attachments still open.
  if (path === '/interest/archive' && req.method === 'POST') {
    const body = await ctx.readJson(req, 32000);
    const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) return json(res, 400, { error: 'Give the archive a name' });
    const rows = await listRows();
    if (!rows.length) return json(res, 400, { error: 'There is nothing to archive' });
    const archive = {
      id: 'ar-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
      ts: Date.now(), name, count: rows.length, rows,
    };
    await putArchive(archive);
    await clearRows(rows); // files stay put; the archive still points at them
    return json(res, 200, { ok: true, archive: { id: archive.id, ts: archive.ts, name, count: archive.count } });
  }

  const archiveCsv = path.match(/^\/interest\/archives\/(ar-[a-z0-9]+)\.csv$/);
  if (archiveCsv) {
    const a = await getArchive(archiveCsv[1]);
    if (!a) return json(res, 404, { error: 'No such archive' });
    return sendCsv(res, a.rows, `cupi-interest-${a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'archive'}`);
  }

  const archiveOne = path.match(/^\/interest\/archives\/(ar-[a-z0-9]+)$/);
  if (archiveOne && req.method === 'GET') {
    const a = await getArchive(archiveOne[1]);
    if (!a) return json(res, 404, { error: 'No such archive' });
    return json(res, 200, { archive: a });
  }

  if (archiveOne && req.method === 'DELETE') {
    const a = await removeArchive(archiveOne[1]);
    if (!a) return json(res, 404, { error: 'No such archive' });
    // Deleting an archive is the only true purge: its files go too, unless a
    // live row still points at one.
    const live = await listRows();
    const stillUsed = new Set(live.map((r) => r.fileId).filter(Boolean));
    for (const r of a.rows) {
      if (r.fileId && !stillUsed.has(r.fileId)) {
        try { await deleteFile(r.fileId); } catch (e) { /* best effort */ }
      }
    }
    return json(res, 200, { ok: true });
  }

  const fileMatch = path.match(/^\/interest\/file\/(int-[a-z0-9]+)$/);
  if (fileMatch && req.method === 'GET') {
    const f = await getFile(fileMatch[1]);
    if (!f) return json(res, 404, { error: 'No such file' });
    res.statusCode = 200;
    res.setHeader('content-type', f.type || 'application/octet-stream');
    res.setHeader('content-disposition', `inline; filename="${encodeURIComponent(f.name)}"`);
    res.setHeader('cache-control', 'private, max-age=3600');
    return res.end(Buffer.from(f.data));
  }

  const rowMatch = path.match(/^\/interest\/(in-[a-z0-9]+)$/);

  if (rowMatch && req.method === 'DELETE') {
    const removed = await removeRow(rowMatch[1]);
    if (!removed) return json(res, 404, { error: 'No such submission' });
    if (removed.fileId) { try { await deleteFile(removed.fileId); } catch (e) { /* best effort */ } }
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'No such endpoint' });
}

// One CSV shape for the live list and every archive.
function sendCsv(res, rows, filename) {
  const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csv = ['Submitted,Updated,Name,Email,Subteam,Coolest project,Cornell address,File,Year']
    .concat(rows.map((r) => [
      new Date(r.ts).toISOString(),
      new Date(r.updated || r.ts).toISOString(),
      cell(r.name), cell(r.email), cell(r.subteam || ''), cell(r.project || ''),
      r.cornell ? 'yes' : 'no',
      r.fileId ? cell(`${r.fileName} · ${WIKI_URL}/api/interest/file/${r.fileId}`) : '',
      cell(r.year || ''),
    ].join(',')))
    .join('\r\n');
  res.statusCode = 200;
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${filename}.csv"`);
  return res.end('﻿' + csv); // BOM so Excel opens it as UTF-8
}
