// The interest-list component. Everything about the Apply-page form lives
// here: its own tables, rate limits, validation, notification email, CSV,
// and admin routes. The core wiki mounts it at /api/interest* and passes a
// small capability context; it knows nothing else about this feature.
// Delete this file and the mount line, and the wiki is exactly what it was.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { storageMode, rawSql, putFile, getFile, deleteFile } from './db.js';
import { freshOauthToken, resolveFrom } from './email.js';

const MAIN_SITE = 'https://cornellphysicalintelligence.com';
const WIKI_URL = (process.env.WIKI_URL || 'https://wiki.cornellphysicalintelligence.com').replace(/\/$/, '');
const NOTIFY = (process.env.INTEREST_NOTIFY || 'ab3233@cornell.edu')
  .split(',').map((s) => s.trim()).filter(Boolean);
const SUBTEAMS = new Set(['Mechanical', 'Electrical', 'Software', 'Business & Marketing']);
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
const mem = { rows: null, events: [], archives: [] };

function memLoad() {
  if (mem.rows) return;
  if (existsSync(DEV_FILE)) {
    try {
      const d = JSON.parse(readFileSync(DEV_FILE, 'utf8'));
      mem.rows = d.rows || [];
      mem.events = d.events || [];
      mem.archives = d.archives || [];
      return;
    } catch (e) { /* reseed */ }
  }
  mem.rows = [];
  mem.events = [];
  mem.archives = [];
}

function memSave() {
  try { writeFileSync(DEV_FILE, JSON.stringify({ rows: mem.rows, events: mem.events, archives: mem.archives })); } catch (e) { /* dev only */ }
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
    await s`CREATE TABLE IF NOT EXISTS interest_events (ts bigint NOT NULL, ip_hash text NOT NULL)`;
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
  cornell: r.cornell,
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

async function saveRow(row, isUpdate) {
  if (storageMode() === 'memory') {
    memLoad();
    const i = mem.rows.findIndex((r) => r.email === row.email);
    if (i >= 0) mem.rows[i] = row; else mem.rows.push(row);
    memSave();
    return;
  }
  const s = await sql();
  if (isUpdate) {
    await s`UPDATE interest_submissions SET name = ${row.name}, subteam = ${row.subteam},
      project = ${row.project}, updated = ${row.updated}, ip_hash = ${row.ipHash || ''},
      file_id = ${row.fileId}, file_name = ${row.fileName}, file_type = ${row.fileType}, file_size = ${row.fileSize}
      WHERE email = ${row.email}`;
  } else {
    await s`INSERT INTO interest_submissions (id, ts, updated, name, email, subteam, project, cornell, file_id, file_name, file_type, file_size, ip_hash)
      VALUES (${row.id}, ${row.ts}, ${row.updated}, ${row.name}, ${row.email}, ${row.subteam}, ${row.project}, ${row.cornell}, ${row.fileId}, ${row.fileName}, ${row.fileType}, ${row.fileSize}, ${row.ipHash || ''})
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, subteam = EXCLUDED.subteam,
        project = EXCLUDED.project, updated = EXCLUDED.updated, ip_hash = EXCLUDED.ip_hash,
        file_id = COALESCE(EXCLUDED.file_id, interest_submissions.file_id),
        file_name = COALESCE(EXCLUDED.file_name, interest_submissions.file_name),
        file_type = COALESCE(EXCLUDED.file_type, interest_submissions.file_type),
        file_size = COALESCE(EXCLUDED.file_size, interest_submissions.file_size)`;
  }
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

async function clearRows() {
  if (storageMode() === 'memory') {
    memLoad();
    const rows = mem.rows;
    mem.rows = [];
    memSave();
    return rows;
  }
  const s = await sql();
  const r = await s`DELETE FROM interest_submissions RETURNING *`;
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

    // Durable screens: per-network hourly cap, then a global daily fuse so a
    // distributed flood cannot fill storage or the inbox.
    const counts = await eventCounts(ipHash, now);
    if (counts.hourSameIp >= 5) return json(res, 429, { error: 'Too many submissions from this network today' });
    if (counts.day >= 300) return json(res, 429, { error: 'The interest list is briefly closed. Email cuphysint@cornell.edu instead' });
    const existing = await findByEmail(email);
    if (!existing && (await countStored()) >= 1000) {
      return json(res, 429, { error: 'The interest list is full. Email cuphysint@cornell.edu instead' });
    }
    // A second submission from the same address replaces the first. That used
    // to happen silently; now the form asks and resends with confirmUpdate.
    // The reply carries only the earlier date, never the earlier answers.
    if (existing && !body.confirmUpdate) {
      return json(res, 409, { exists: true, submitted: existing.ts, error: 'This email is already on the interest list' });
    }

    let fileMeta = null;
    if (file) {
      const id = 'int-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      await putFile({ id, name: file.name, type: file.type, size: file.data.length, by: email, ts: now, data: file.data });
      fileMeta = { fileId: id, fileName: file.name, fileType: file.type, fileSize: file.data.length };
    }

    await logEvent(ipHash, now);
    const saved = existing
      ? {
          ...existing, name, subteam, project, updated: now, ipHash,
          ...(fileMeta || {}),
        }
      : {
          id: 'in-' + Math.random().toString(36).slice(2, 10) + now.toString(36),
          ts: now, updated: now, name, email, subteam, project,
          cornell: email.endsWith('@cornell.edu') || email.endsWith('.cornell.edu'),
          fileId: null, fileName: null, fileType: null, fileSize: null, ipHash,
          ...(fileMeta || {}),
        };
    await saveRow(saved, Boolean(existing));
    if (existing?.fileId && fileMeta) {
      try { await deleteFile(existing.fileId); } catch (e) { /* best effort */ }
    }

    // Notify on new submissions only; a resubmit just updates the list.
    if (!existing) {
      try {
        await notify({
          sub: saved, host: ctx.host,
          settings: await ctx.emailSettings(), clientId: ctx.clientId, saveOauth: ctx.saveOauth,
        });
      } catch (e) { /* the stored row is the source of truth */ }
    }
    return json(res, 200, { ok: true });
  }

  /* ---- everything else is for signed-in admins ---- */

  const me = await ctx.me();
  if (!me) return json(res, 401, { error: 'Not signed in' });
  if (me.role !== 'admin') return json(res, 403, { error: 'Admins only' });

  if (path === '/interest' && req.method === 'GET') {
    return json(res, 200, { rows: await listRows() });
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
    await clearRows(); // files stay put; the archive still points at them
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
  const csv = ['Submitted,Updated,Name,Email,Subteam,Coolest project,Cornell address,File']
    .concat(rows.map((r) => [
      new Date(r.ts).toISOString(),
      new Date(r.updated || r.ts).toISOString(),
      cell(r.name), cell(r.email), cell(r.subteam || ''), cell(r.project || ''),
      r.cornell ? 'yes' : 'no',
      r.fileId ? cell(`${r.fileName} · ${WIKI_URL}/api/interest/file/${r.fileId}`) : '',
    ].join(',')))
    .join('\r\n');
  res.statusCode = 200;
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${filename}.csv"`);
  return res.end('﻿' + csv); // BOM so Excel opens it as UTF-8
}
