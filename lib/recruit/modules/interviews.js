// Interviews module: rounds live in the cycle settings, slots carry a seat
// count, bookings tie an application to one slot per round. Every seat change
// is one statement whose guard sits on the slot UPDATE, so `booked` can only
// move together with the booking that owns the seat. Applicants answer
// through a hashed single-use token; the raw token exists only in the invite
// email. Comms hears `booking.created` and sends the invite.

import { createHash, randomBytes } from 'node:crypto';

const RSVP_BASE = (process.env.RECRUIT_RSVP_BASE || process.env.WIKI_URL || 'https://wiki.cornellphysicalintelligence.com').replace(/\/$/, '');
const TZ = process.env.RECRUIT_TZ || 'America/New_York';
export const LIMITS = { slotsPerRequest: 100, capacity: 10, interviewers: 10, invitees: 500, tokenDays: 14 };
const REQUEST_ID = /^rq-[a-z0-9-]{8,80}$/;
const ROUND_KEY = /^[a-z][a-z0-9_-]{0,39}$/;
const SEATED = ['invited', 'confirmed'];
// Every terminal status hands the seat back, so `booked` always equals the
// live (invited or confirmed) bookings in the slot.
const RELEASING = ['declined', 'no_show', 'cancelled', 'done'];
// Which prior statuses each PATCH target accepts; `confirmed` also needs a seat.
const TRANSITIONS = { confirmed: ['invited'], declined: ['invited', 'confirmed'], no_show: ['confirmed'], done: ['confirmed'], cancelled: ['invited', 'confirmed'] };

const sha = (t) => createHash('sha256').update(String(t)).digest('hex');
const num = (v) => (v === null || v === undefined ? null : Number(v));
const arr = (v) => (typeof v === 'string' ? JSON.parse(v) : Array.isArray(v) ? v : []);
const obj = (v) => (typeof v === 'string' ? JSON.parse(v) : v || {});
const jsonRoute = (status, body) => ({ status, body });

/* ------------------------------- mappers ---------------------------------- */

function slotFromPg(r) {
  return { id: r.id, cycleId: r.cycle_id, round: r.round, starts: num(r.starts), ends: num(r.ends), place: r.place || '', capacity: Number(r.capacity), booked: Number(r.booked), interviewers: arr(r.interviewers), version: num(r.version), created: num(r.created), createdBy: r.created_by || '' };
}

// token_hash never leaves the module.
function bookingFromPg(r) {
  return { id: r.id, cycleId: r.cycle_id, round: r.round, applicationId: r.application_id, slotId: r.slot_id || null, status: r.status, version: num(r.version), invitedAt: num(r.invited_at), confirmedAt: num(r.confirmed_at), updated: num(r.updated), doc: obj(r.doc) };
}
const publicBooking = (b) => { if (!b) return null; const { tokenHash, token_hash, ...rest } = b; return rest; };

function normApp(r) {
  if (!r) return null;
  return { id: r.id, cycleId: r.cycleId ?? r.cycle_id, email: r.email, name: r.name, subteam: r.subteam ?? '', stage: r.stage, erasedAt: num(r.erasedAt ?? r.erased_at) };
}

const roundsOf = (cycle) => (cycle?.doc?.interviews?.rounds || []).filter((r) => r && ROUND_KEY.test(r.key || ''));
const roundName = (cycle, key) => roundsOf(cycle).find((r) => r.key === key)?.name || key;
const selfSchedule = (cycle) => cycle?.doc?.interviews?.selfSchedule === true;

const fmtDate = (ts) => new Date(ts).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: TZ });
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });

/* ------------------------------- storage ---------------------------------- */

const memSlots = (kit) => (kit.mem.slots ||= []);
const memBookings = (kit) => (kit.mem.bookings ||= []);

async function getSlot(kit, id) {
  if (kit.mode === 'memory') { const s = memSlots(kit).find((x) => x.id === id); return s ? { ...s, interviewers: [...s.interviewers] } : null; }
  const s = await kit.sql();
  const out = await s`SELECT * FROM recruit_slots WHERE id = ${id}`;
  return out.rows[0] ? slotFromPg(out.rows[0]) : null;
}

async function getBooking(kit, id) {
  if (kit.mode === 'memory') { const b = memBookings(kit).find((x) => x.id === id); return b ? { ...b } : null; }
  const s = await kit.sql();
  const out = await s`SELECT * FROM recruit_bookings WHERE id = ${id}`;
  return out.rows[0] ? { ...bookingFromPg(out.rows[0]), tokenHash: out.rows[0].token_hash } : null;
}

async function bookingByToken(kit, token) {
  const hash = sha(token);
  if (kit.mode === 'memory') { const b = memBookings(kit).find((x) => x.tokenHash === hash && x.tokenHash); return b ? { ...b } : null; }
  const s = await kit.sql();
  const out = await s`SELECT * FROM recruit_bookings WHERE token_hash = ${hash} AND token_hash <> ''`;
  return out.rows[0] ? { ...bookingFromPg(out.rows[0]), tokenHash: out.rows[0].token_hash } : null;
}

async function appsById(kit, cycleId, ids) {
  if (!ids.length) return new Map();
  if (kit.mode === 'memory') return new Map((kit.mem.applications || []).filter((a) => ids.includes(a.id) && (a.cycleId ?? a.cycle_id) === cycleId).map((a) => [a.id, normApp(a)]));
  const s = await kit.sql();
  const out = await s`SELECT id, cycle_id, email, name, subteam, stage, erased_at FROM recruit_applications WHERE cycle_id = ${cycleId} AND id = ANY(${ids})`;
  return new Map(out.rows.map((r) => [r.id, normApp(r)]));
}

async function listSlots(kit, cycleId, { round = null, from = null, to = null, me = null } = {}) {
  let slots;
  if (kit.mode === 'memory') {
    slots = memSlots(kit).filter((s) => s.cycleId === cycleId && (!round || s.round === round) && (from === null || s.ends >= from) && (to === null || s.starts <= to) && (!me || s.interviewers.includes(me)))
      .sort((a, b) => a.starts - b.starts || (a.id < b.id ? -1 : 1)).map((s) => ({ ...s, interviewers: [...s.interviewers] }));
  } else {
    const s = await kit.sql();
    const out = await s`SELECT * FROM recruit_slots WHERE cycle_id = ${cycleId} AND (${round}::text IS NULL OR round = ${round})
      AND (${from}::bigint IS NULL OR ends >= ${from}) AND (${to}::bigint IS NULL OR starts <= ${to})
      AND (${me}::text IS NULL OR interviewers @> ${JSON.stringify([me])}::jsonb) ORDER BY starts, id LIMIT 1000`;
    slots = out.rows.map(slotFromPg);
  }
  return slots;
}

async function bookingsForSlots(kit, cycleId, slotIds) {
  if (!slotIds.length) return [];
  let bookings;
  if (kit.mode === 'memory') bookings = memBookings(kit).filter((b) => slotIds.includes(b.slotId)).map(publicBooking);
  else {
    const s = await kit.sql();
    const out = await s`SELECT * FROM recruit_bookings WHERE slot_id = ANY(${slotIds})`;
    bookings = out.rows.map(bookingFromPg);
  }
  const apps = await appsById(kit, cycleId, [...new Set(bookings.map((b) => b.applicationId))]);
  return bookings.map((b) => ({ ...b, name: apps.get(b.applicationId)?.name || 'Applicant' }));
}

async function listBookings(kit, cycleId, { round = null, status = null } = {}) {
  let bookings;
  if (kit.mode === 'memory') bookings = memBookings(kit).filter((b) => b.cycleId === cycleId && (!round || b.round === round) && (!status || b.status === status)).map(publicBooking);
  else {
    const s = await kit.sql();
    const out = await s`SELECT * FROM recruit_bookings WHERE cycle_id = ${cycleId} AND (${round}::text IS NULL OR round = ${round}) AND (${status}::text IS NULL OR status = ${status}) ORDER BY updated DESC, id LIMIT 2000`;
    bookings = out.rows.map(bookingFromPg);
  }
  const apps = await appsById(kit, cycleId, [...new Set(bookings.map((b) => b.applicationId))]);
  const slots = new Map((await listSlots(kit, cycleId)).map((s) => [s.id, s]));
  return bookings.map((b) => {
    const slot = b.slotId ? slots.get(b.slotId) : null;
    const a = apps.get(b.applicationId);
    return { ...b, name: a?.name || 'Applicant', email: a?.email || '', subteam: a?.subteam || '', stage: a?.stage || '', starts: slot?.starts ?? null, ends: slot?.ends ?? null, place: slot?.place || '', interviewers: slot?.interviewers || [] };
  });
}

const history = (status, by, now) => JSON.stringify([{ status, at: now, by }]);

// One statement: the seat is taken on the slot row only if the booking is
// still free, and the booking row is stamped from that same CTE.
async function book(kit, { booking, slotId, version = null, tokenHash = null, by }) {
  const now = kit.now();
  if (kit.mode === 'memory') {
    const b = memBookings(kit).find((x) => x.id === booking.id);
    const s = memSlots(kit).find((x) => x.id === slotId && x.cycleId === booking.cycleId && x.round === booking.round);
    const guard = b && (version === null ? b.tokenHash && b.tokenHash === tokenHash : b.version === version) && SEATED.includes(b.status) && !b.slotId;
    if (!guard || !s || s.booked >= s.capacity) return null;
    s.booked += 1; s.version += 1;
    Object.assign(b, { slotId: s.id, status: 'confirmed', confirmedAt: now, updated: now, version: b.version + 1, doc: { ...b.doc, history: [...(b.doc?.history || []), { status: 'confirmed', at: now, by }] } });
    if (tokenHash !== null) b.tokenHash = '';
    await kit.memSave();
    return { booking: { ...b }, slot: { ...s } };
  }
  const s = await kit.sql();
  const hist = history('confirmed', by, now);
  const out = await s`WITH s AS (UPDATE recruit_slots SET booked = booked + 1, version = version + 1
      WHERE id = ${slotId} AND cycle_id = ${booking.cycleId} AND round = ${booking.round} AND booked < capacity
      AND EXISTS (SELECT 1 FROM recruit_bookings b WHERE b.id = ${booking.id} AND (${version}::bigint IS NULL OR b.version = ${version}) AND (${tokenHash}::text IS NULL OR (b.token_hash <> '' AND b.token_hash = ${tokenHash})) AND b.status IN ('invited', 'confirmed') AND b.slot_id IS NULL)
      RETURNING id, interviewers)
    UPDATE recruit_bookings b SET slot_id = s.id, status = 'confirmed', confirmed_at = ${now}, updated = ${now}, version = b.version + 1,
      token_hash = CASE WHEN ${tokenHash}::text IS NULL THEN b.token_hash ELSE '' END,
      doc = jsonb_set(b.doc, '{history}', COALESCE(b.doc->'history', '[]'::jsonb) || ${hist}::jsonb)
    FROM s WHERE b.id = ${booking.id} RETURNING b.*, s.interviewers AS slot_interviewers`;
  if (!out.rows[0]) return null;
  return { booking: bookingFromPg(out.rows[0]), slot: { id: slotId, interviewers: arr(out.rows[0].slot_interviewers) } };
}

async function bookOr409(kit, args) {
  const r = await book(kit, args);
  if (r) return r;
  const cur = await getBooking(kit, args.booking.id);
  if (!cur) throw { status: 404, error: 'No such booking' };
  if (cur.slotId) throw { status: 409, error: 'Already booked', row: publicBooking(cur) };
  if (args.version !== null && cur.version !== args.version) throw { status: 409, error: 'This booking changed. Reload.', version: cur.version };
  if (!SEATED.includes(cur.status)) throw { status: 409, error: 'This invitation is no longer open', row: publicBooking(cur) };
  throw { status: 409, error: 'That time is full' };
}

// Status change plus seat release in the same statement.
async function setStatus(kit, { booking, status, version = null, tokenHash = null, by }) {
  const from = TRANSITIONS[status];
  if (!from) throw { status: 400, error: 'Unknown status' };
  const now = kit.now();
  const releases = RELEASING.includes(status);
  const blankToken = status !== 'confirmed';
  if (kit.mode === 'memory') {
    const b = memBookings(kit).find((x) => x.id === booking.id);
    const guard = b && (version === null ? b.tokenHash && b.tokenHash === tokenHash : b.version === version) && from.includes(b.status) && (status !== 'confirmed' || b.slotId);
    if (!guard) return null;
    const prev = b.status, prevSlot = b.slotId;
    Object.assign(b, { status, updated: now, version: b.version + 1, doc: { ...b.doc, history: [...(b.doc?.history || []), { status, at: now, by }] } });
    if (blankToken || tokenHash !== null) b.tokenHash = '';
    if (releases && prevSlot && SEATED.includes(prev)) { const s = memSlots(kit).find((x) => x.id === prevSlot); if (s) { s.booked = Math.max(0, s.booked - 1); s.version += 1; } }
    await kit.memSave();
    return { ...b };
  }
  const s = await kit.sql();
  const hist = history(status, by, now);
  const out = await s`WITH prev AS (SELECT id, slot_id, status FROM recruit_bookings WHERE id = ${booking.id} AND (${version}::bigint IS NULL OR version = ${version}) AND (${tokenHash}::text IS NULL OR (token_hash <> '' AND token_hash = ${tokenHash}))),
    b AS (UPDATE recruit_bookings x SET status = ${status}, updated = ${now}, version = x.version + 1,
      token_hash = CASE WHEN ${blankToken || tokenHash !== null} THEN '' ELSE x.token_hash END,
      doc = jsonb_set(x.doc, '{history}', COALESCE(x.doc->'history', '[]'::jsonb) || ${hist}::jsonb)
      FROM prev WHERE x.id = prev.id AND prev.status = ANY(${from}) AND (${status !== 'confirmed'} OR prev.slot_id IS NOT NULL)
      RETURNING x.*, prev.status AS prev_status, prev.slot_id AS prev_slot),
    s AS (UPDATE recruit_slots SET booked = GREATEST(booked - 1, 0), version = version + 1
      WHERE ${releases} AND id = (SELECT prev_slot FROM b) AND (SELECT prev_status FROM b) IN ('invited', 'confirmed') RETURNING id)
    SELECT * FROM b`;
  return out.rows[0] ? bookingFromPg(out.rows[0]) : null;
}

// Release the old seat and take the new one together; a new token goes out
// with the reschedule email.
async function reschedule(kit, { booking, slotId, version, tokenHash, by }) {
  const now = kit.now();
  const from = ['invited', 'confirmed', 'declined', 'no_show'];
  if (kit.mode === 'memory') {
    const b = memBookings(kit).find((x) => x.id === booking.id);
    if (!b || b.version !== version || !from.includes(b.status) || b.slotId === slotId) return null;
    const s = memSlots(kit).find((x) => x.id === slotId && x.cycleId === b.cycleId && x.round === b.round);
    if (!s || s.booked >= s.capacity) return null;
    s.booked += 1; s.version += 1;
    if (b.slotId && SEATED.includes(b.status)) { const old = memSlots(kit).find((x) => x.id === b.slotId); if (old) { old.booked = Math.max(0, old.booked - 1); old.version += 1; } }
    Object.assign(b, { slotId: s.id, status: 'confirmed', tokenHash, confirmedAt: now, updated: now, version: b.version + 1, doc: { ...b.doc, history: [...(b.doc?.history || []), { status: 'confirmed', at: now, by, rescheduled: true }] } });
    await kit.memSave();
    return { booking: { ...b }, slot: { ...s } };
  }
  const s = await kit.sql();
  const hist = JSON.stringify([{ status: 'confirmed', at: now, by, rescheduled: true }]);
  const out = await s`WITH old AS (SELECT id, slot_id, status FROM recruit_bookings WHERE id = ${booking.id} AND version = ${version} AND status = ANY(${from}) AND (slot_id IS NULL OR slot_id <> ${slotId})),
    taken AS (UPDATE recruit_slots SET booked = booked + 1, version = version + 1
      WHERE id = ${slotId} AND cycle_id = ${booking.cycleId} AND round = ${booking.round} AND booked < capacity AND EXISTS (SELECT 1 FROM old) RETURNING id, interviewers),
    freed AS (UPDATE recruit_slots SET booked = GREATEST(booked - 1, 0), version = version + 1
      WHERE id = (SELECT slot_id FROM old) AND (SELECT status FROM old) IN ('invited', 'confirmed') AND EXISTS (SELECT 1 FROM taken) RETURNING id),
    b AS (UPDATE recruit_bookings x SET slot_id = taken.id, status = 'confirmed', token_hash = ${tokenHash}, confirmed_at = ${now}, updated = ${now}, version = x.version + 1,
      doc = jsonb_set(x.doc, '{history}', COALESCE(x.doc->'history', '[]'::jsonb) || ${hist}::jsonb)
      FROM taken WHERE x.id = ${booking.id} RETURNING x.*, taken.interviewers AS slot_interviewers)
    SELECT * FROM b`;
  if (!out.rows[0]) return null;
  return { booking: bookingFromPg(out.rows[0]), slot: { id: slotId, interviewers: arr(out.rows[0].slot_interviewers) } };
}

async function rotateToken(kit, bookingId, tokenHash) {
  const now = kit.now();
  if (kit.mode === 'memory') {
    const b = memBookings(kit).find((x) => x.id === bookingId && SEATED.includes(x.status));
    if (!b) return null;
    Object.assign(b, { tokenHash, invitedAt: now, updated: now, version: b.version + 1 });
    await kit.memSave();
    return { ...b };
  }
  const s = await kit.sql();
  // A fresh link starts a fresh expiry window.
  const out = await s`UPDATE recruit_bookings SET token_hash = ${tokenHash}, invited_at = ${now}, updated = ${now}, version = version + 1 WHERE id = ${bookingId} AND status IN ('invited', 'confirmed') RETURNING *`;
  return out.rows[0] ? bookingFromPg(out.rows[0]) : null;
}

async function cancelInvited(kit, cycleId, { applicationId = null, blankAll = false }) {
  const now = kit.now();
  if (kit.mode === 'memory') {
    let n = 0;
    for (const b of memBookings(kit)) {
      if (b.cycleId !== cycleId || (applicationId && b.applicationId !== applicationId)) continue;
      if (b.status === 'invited') { b.status = 'cancelled'; b.updated = now; b.version += 1; b.doc = { ...b.doc, history: [...(b.doc?.history || []), { status: 'cancelled', at: now, by: 'system' }] }; b.tokenHash = ''; n++; }
      else if (blankAll && b.tokenHash) { b.tokenHash = ''; b.updated = now; b.version += 1; }
    }
    if (n || blankAll) await kit.memSave();
    return n;
  }
  const s = await kit.sql();
  const hist = history('cancelled', 'system', now);
  const out = await s`UPDATE recruit_bookings SET status = CASE WHEN status = 'invited' THEN 'cancelled' ELSE status END,
      doc = CASE WHEN status = 'invited' THEN jsonb_set(doc, '{history}', COALESCE(doc->'history', '[]'::jsonb) || ${hist}::jsonb) ELSE doc END,
      token_hash = '', updated = ${now}, version = version + 1
    WHERE cycle_id = ${cycleId} AND (${applicationId}::text IS NULL OR application_id = ${applicationId}) AND (status = 'invited' OR (${blankAll} AND token_hash <> '')) RETURNING id, status`;
  return out.rows.filter((r) => r.status === 'cancelled').length;
}

/* ------------------------------- helpers ---------------------------------- */

function interviewMerge(cycle, slot, round) {
  if (!slot) return { round: roundName(cycle, round), date: '', time: '', place: '' };
  return { round: roundName(cycle, round), date: fmtDate(slot.starts), time: fmtTime(slot.starts), place: slot.place || '' };
}

const rsvpUrl = (token) => `${RSVP_BASE}/api/recruit/rsvp/${token}`;

async function announce(kit, { cycle, booking, app, token, slot, send, purpose, templateKey }) {
  try {
    await kit.emit('booking.created', {
      cycle, booking: publicBooking(booking), application: app ? { id: app.id, name: app.name, email: app.email } : { id: booking.applicationId },
      slot: slot ? { id: slot.id, starts: slot.starts, ends: slot.ends, place: slot.place, interviewers: slot.interviewers } : null,
      interview: interviewMerge(cycle, slot, booking.round), rsvpUrl: rsvpUrl(token), send, purpose, templateKey,
    });
  } catch (e) { /* hooks log their own failures */ }
}

async function sentCount(kit, purposes) {
  if (!purposes.length) return 0;
  try {
    if (kit.mode === 'memory') return (kit.mem.mail || []).filter((m) => purposes.includes(m.purposeKey) && m.status === 'sent').length;
    const s = await kit.sql();
    const out = await s`SELECT count(*) AS n FROM recruit_mail WHERE purpose_key = ANY(${purposes}) AND status = 'sent'`;
    return Number(out.rows[0]?.n || 0);
  } catch (e) { return 0; }
}

async function roleFor(kit, rq, cycleId) {
  if (rq.role === 'admin') return 'admin';
  const grant = await kit.roles.grantFor(cycleId, rq.me.email);
  return kit.roles.roleOf(rq.me, grant);
}

function requireLead(role) {
  if (role !== 'admin' && role !== 'lead') throw { status: 403, error: role ? 'Not allowed in this cycle' : 'Admins only' };
}

async function cycleFor(kit, cycleId, { mutates = true } = {}) {
  const cycle = await kit.cycles.get(cycleId);
  if (!cycle) throw { status: 404, error: 'No such cycle' };
  if (cycle.doc?.modules?.interviews === false) throw { status: 409, error: 'Interviews is off for this cycle' };
  if (mutates && cycle.status === 'archived') throw { status: 409, error: 'This cycle is archived' };
  return cycle;
}

function validateSettings(next, cycle) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) throw { status: 400, error: 'Interview settings must be an object' };
  const rounds = Array.isArray(next.rounds) ? next.rounds : [];
  if (!rounds.length) throw { status: 400, error: 'Keep at least one interview round' };
  if (rounds.length > 10) throw { status: 400, error: 'At most 10 rounds' };
  const keys = new Set();
  for (const r of rounds) {
    if (!r || !ROUND_KEY.test(String(r.key || ''))) throw { status: 400, error: 'Round keys are lowercase letters, digits, _ and -' };
    if (keys.has(r.key)) throw { status: 400, error: `Round ${r.key} is listed twice` };
    keys.add(r.key);
    if (!String(r.name || '').trim() || String(r.name).length > 60) throw { status: 400, error: 'Round names are 1 to 60 characters' };
    const minutes = Number(r.minutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) throw { status: 400, error: 'Round length is 5 to 240 minutes' };
    if (String(r.place || '').length > 120) throw { status: 400, error: 'Places are capped at 120 characters' };
    if (r.rubric !== undefined) {
      const c = r.rubric?.criteria;
      if (!Array.isArray(c) || c.length > 20 || c.some((x) => !x || !/^[a-z][a-z0-9_]{0,23}$/.test(String(x.key || '')) || !String(x.name || '').trim())) throw { status: 400, error: 'Rubric criteria need a key and a name' };
      const scale = Number(r.rubric.scale ?? 5);
      if (!Number.isInteger(scale) || scale < 2 || scale > 10) throw { status: 400, error: 'Rubric scale is 2 to 10' };
    }
  }
  if (next.selfSchedule !== undefined && typeof next.selfSchedule !== 'boolean') throw { status: 400, error: 'selfSchedule is on or off' };
}

const DEFAULT_RUBRIC = { version: 1, scale: 5, criteria: [{ key: 'motivation', name: 'Motivation', weight: 1, help: '' }, { key: 'skills', name: 'Relevant skills', weight: 2, help: '' }, { key: 'teamwork', name: 'Works with others', weight: 1, help: '' }] };

function slotPlan(body, cycle) {
  const round = String(body?.round || '');
  if (!roundsOf(cycle).some((r) => r.key === round)) throw { status: 400, error: 'Pick an interview round' };
  const starts = Number(body?.starts), ends = Number(body?.ends);
  if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends <= starts) throw { status: 400, error: 'The slot must end after it starts' };
  if (ends - starts > 12 * 3600000) throw { status: 400, error: 'Slots are capped at 12 hours' };
  const capacity = Number(body?.capacity ?? 1);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > LIMITS.capacity) throw { status: 400, error: `Capacity is 1 to ${LIMITS.capacity}` };
  const place = String(body?.place ?? '').trim().slice(0, 120);
  const interviewers = [...new Set((Array.isArray(body?.interviewers) ? body.interviewers : []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  if (interviewers.length > LIMITS.interviewers) throw { status: 400, error: `At most ${LIMITS.interviewers} interviewers per slot` };
  const times = [];
  const length = ends - starts;
  if (body?.repeat && typeof body.repeat === 'object') {
    const every = Number(body.repeat.every) * 60000, until = Number(body.repeat.until);
    if (!Number.isFinite(every) || every < 5 * 60000) throw { status: 400, error: 'Repeat every 5 minutes or more' };
    if (!Number.isFinite(until) || until <= starts) throw { status: 400, error: 'Repeat until a time after the first slot' };
    for (let t = starts; t + length <= until && times.length <= LIMITS.slotsPerRequest; t += every) times.push([t, t + length]);
  } else times.push([starts, ends]);
  if (times.length > LIMITS.slotsPerRequest) throw { status: 400, error: `At most ${LIMITS.slotsPerRequest} slots per request` };
  return { round, capacity, place, interviewers, times };
}

async function checkInterviewers(kit, interviewers) {
  if (!interviewers.length) return;
  const roster = await kit.roles.roster();
  const emails = new Set((roster || []).map((u) => String(u.email).toLowerCase()));
  const unknown = interviewers.find((e) => !emails.has(e));
  if (unknown) throw { status: 400, error: `${unknown} is not on the roster` };
}

async function scoredSet(kit, member, round) {
  try {
    if (kit.mode === 'memory') return new Set((kit.mem.scores || []).filter((x) => x.member === member && x.kind === 'interview' && (x.round || '') === round && x.submitted).map((x) => x.applicationId ?? x.application_id));
    const s = await kit.sql();
    const out = await s`SELECT application_id FROM recruit_scores WHERE member = ${member} AND kind = 'interview' AND round = ${round} AND submitted IS NOT NULL`;
    return new Set(out.rows.map((r) => r.application_id));
  } catch (e) { return new Set(); }
}

/* -------------------------------- module ---------------------------------- */

export default {
  name: 'interviews',
  kernel: false,
  order: 60,
  schema: [
    `CREATE TABLE IF NOT EXISTS recruit_slots (id text PRIMARY KEY, cycle_id text NOT NULL, round text NOT NULL, starts bigint NOT NULL, ends bigint NOT NULL, place text NOT NULL DEFAULT '', capacity int NOT NULL DEFAULT 1, booked int NOT NULL DEFAULT 0, interviewers jsonb NOT NULL DEFAULT '[]', version bigint NOT NULL DEFAULT 1, created bigint, created_by text)`,
    `CREATE INDEX IF NOT EXISTS recruit_slots_cycle ON recruit_slots (cycle_id, round, starts)`,
    `CREATE TABLE IF NOT EXISTS recruit_bookings (id text PRIMARY KEY, cycle_id text NOT NULL, round text NOT NULL, application_id text NOT NULL, slot_id text, status text NOT NULL DEFAULT 'invited', token_hash text NOT NULL, version bigint NOT NULL DEFAULT 1, invited_at bigint, confirmed_at bigint, updated bigint, doc jsonb NOT NULL DEFAULT '{}', UNIQUE (application_id, round))`,
    `CREATE INDEX IF NOT EXISTS recruit_bookings_slot ON recruit_bookings (slot_id)`,
    `CREATE INDEX IF NOT EXISTS recruit_bookings_token ON recruit_bookings (token_hash)`,
  ],
  memory: { slots: [], bookings: [] },
  defaults: () => ({ rounds: [{ key: 'r1', name: 'Interview', minutes: 20, place: '', rubric: DEFAULT_RUBRIC }], selfSchedule: false }),
  validateSettings,
  auditKinds: ['slot', 'booking', 'rsvp'],

  routes: [
    { method: 'GET', path: '/cycles/:cycle/slots', access: 'interviewer', async handler(rq, kit) {
      const q = rq.query || {};
      const lead = rq.role === 'admin' || rq.role === 'lead';
      const slots = await listSlots(kit, rq.cycle.id, { round: q.round || null, from: q.from ? Number(q.from) : null, to: q.to ? Number(q.to) : null, me: lead ? null : rq.me.email });
      const bookings = await bookingsForSlots(kit, rq.cycle.id, slots.map((s) => s.id));
      const body = { slots: slots.map((s) => ({ ...s, bookings: bookings.filter((b) => b.slotId === s.id).map((b) => ({ id: b.id, applicationId: b.applicationId, name: b.name, status: b.status })) })), rounds: roundsOf(rq.cycle).map(({ key, name, minutes, place }) => ({ key, name, minutes, place })), selfSchedule: selfSchedule(rq.cycle) };
      if (lead) body.members = ((await kit.roles.roster()) || []).map((u) => ({ email: u.email, name: u.name, subteam: u.subteam || '' }));
      return jsonRoute(200, body);
    } },

    { method: 'GET', path: '/cycles/:cycle/bookings', access: 'lead', async handler(rq, kit) {
      const q = rq.query || {};
      return jsonRoute(200, { bookings: await listBookings(kit, rq.cycle.id, { round: q.round || null, status: q.status || null }) });
    } },

    { method: 'POST', path: '/cycles/:cycle/slots', access: 'lead', mutates: true, cap: 65536, async handler(rq, kit) {
      const body = await rq.body();
      const requestId = String(body?.requestId || '');
      if (!REQUEST_ID.test(requestId)) return jsonRoute(400, { error: 'Missing requestId' });
      const plan = slotPlan(body, rq.cycle);
      await checkInterviewers(kit, plan.interviewers);
      const out = await kit.once(requestId, rq.me.email, async () => {
        const now = kit.now();
        const rows = plan.times.map(([starts, ends]) => ({ id: kit.id('sl'), starts, ends }));
        let slots;
        if (kit.mode === 'memory') {
          slots = rows.map((r) => ({ id: r.id, cycleId: rq.cycle.id, round: plan.round, starts: r.starts, ends: r.ends, place: plan.place, capacity: plan.capacity, booked: 0, interviewers: [...plan.interviewers], version: 1, created: now, createdBy: rq.me.email }));
          memSlots(kit).push(...slots.map((s) => ({ ...s, interviewers: [...s.interviewers] })));
          await kit.memSave();
        } else {
          const s = await kit.sql();
          const ins = await s`INSERT INTO recruit_slots (id, cycle_id, round, starts, ends, place, capacity, booked, interviewers, version, created, created_by)
            SELECT r.id, ${rq.cycle.id}, ${plan.round}, r.starts, r.ends, ${plan.place}, ${plan.capacity}, 0, ${JSON.stringify(plan.interviewers)}::jsonb, 1, ${now}, ${rq.me.email}
            FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(id text, starts bigint, ends bigint) RETURNING *`;
          slots = ins.rows.map(slotFromPg);
        }
        await kit.audit({ cycleId: rq.cycle.id, actor: rq.me.email, kind: 'slot', detail: { created: slots.length, round: plan.round, requestId } });
        return { slots };
      });
      return jsonRoute(201, out);
    } },

    { method: 'PATCH', path: '/slots/:slot', access: 'member', cap: 65536, async handler(rq, kit) {
      const slot = await getSlot(kit, rq.params.slot);
      if (!slot) return jsonRoute(404, { error: 'No such slot' });
      requireLead(await roleFor(kit, rq, slot.cycleId));
      const cycle = await cycleFor(kit, slot.cycleId);
      const body = await rq.body();
      const version = Number(body?.version);
      if (!Number.isFinite(version)) return jsonRoute(400, { error: 'Missing version' });
      const next = { starts: body.starts !== undefined ? Number(body.starts) : slot.starts, ends: body.ends !== undefined ? Number(body.ends) : slot.ends, place: body.place !== undefined ? String(body.place).trim().slice(0, 120) : slot.place, capacity: body.capacity !== undefined ? Number(body.capacity) : slot.capacity, interviewers: body.interviewers !== undefined ? [...new Set((Array.isArray(body.interviewers) ? body.interviewers : []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))] : slot.interviewers };
      if (!Number.isFinite(next.starts) || !Number.isFinite(next.ends) || next.ends <= next.starts) return jsonRoute(400, { error: 'The slot must end after it starts' });
      if (!Number.isInteger(next.capacity) || next.capacity < 1 || next.capacity > LIMITS.capacity) return jsonRoute(400, { error: `Capacity is 1 to ${LIMITS.capacity}` });
      if (next.interviewers.length > LIMITS.interviewers) return jsonRoute(400, { error: `At most ${LIMITS.interviewers} interviewers per slot` });
      await checkInterviewers(kit, next.interviewers);
      let row;
      if (kit.mode === 'memory') {
        const s = memSlots(kit).find((x) => x.id === slot.id);
        if (s.version !== version) return jsonRoute(409, { error: 'This slot changed. Reload.', version: s.version });
        if (next.capacity < s.booked) return jsonRoute(409, { error: `${s.booked} already booked` });
        Object.assign(s, next, { version: s.version + 1 });
        await kit.memSave();
        row = { ...s };
      } else {
        const s = await kit.sql();
        const out = await s`UPDATE recruit_slots SET starts = ${next.starts}, ends = ${next.ends}, place = ${next.place}, capacity = ${next.capacity}, interviewers = ${JSON.stringify(next.interviewers)}::jsonb, version = version + 1
          WHERE id = ${slot.id} AND version = ${version} AND ${next.capacity} >= booked RETURNING *`;
        if (!out.rows[0]) {
          const cur = await getSlot(kit, slot.id);
          return jsonRoute(409, cur.version !== version ? { error: 'This slot changed. Reload.', version: cur.version } : { error: `${cur.booked} already booked` });
        }
        row = slotFromPg(out.rows[0]);
      }
      return { status: 200, body: { slot: row }, audit: { kind: 'slot', cycleId: slot.cycleId, detail: { slotId: slot.id, updated: true } } };
    } },

    { method: 'DELETE', path: '/slots/:slot', access: 'member', cap: 65536, async handler(rq, kit) {
      const slot = await getSlot(kit, rq.params.slot);
      if (!slot) return jsonRoute(404, { error: 'No such slot' });
      requireLead(await roleFor(kit, rq, slot.cycleId));
      await cycleFor(kit, slot.cycleId);
      const version = Number((rq.query || {}).version ?? slot.version);
      let removed = false;
      if (kit.mode === 'memory') {
        const i = memSlots(kit).findIndex((x) => x.id === slot.id && x.version === version && x.booked === 0);
        if (i >= 0) { memSlots(kit).splice(i, 1); removed = true; await kit.memSave(); }
      } else {
        const s = await kit.sql();
        const out = await s`DELETE FROM recruit_slots WHERE id = ${slot.id} AND version = ${version} AND booked = 0 RETURNING id`;
        removed = out.rows.length === 1;
      }
      if (!removed) {
        const cur = await getSlot(kit, slot.id);
        if (!cur) return jsonRoute(200, { ok: true });
        return jsonRoute(409, cur.booked > 0 ? { error: `${cur.booked} already booked. Cancel those first.` } : { error: 'This slot changed. Reload.', version: cur.version });
      }
      return { status: 200, body: { ok: true }, audit: { kind: 'slot', cycleId: slot.cycleId, detail: { slotId: slot.id, deleted: true } } };
    } },

    { method: 'POST', path: '/cycles/:cycle/invitations', access: 'lead', mutates: true, cap: 262144, async handler(rq, kit) {
      const body = await rq.body();
      const requestId = String(body?.requestId || '');
      if (!REQUEST_ID.test(requestId)) return jsonRoute(400, { error: 'Missing requestId' });
      const round = String(body?.round || '');
      if (!roundsOf(rq.cycle).some((r) => r.key === round)) return jsonRoute(400, { error: 'Pick an interview round' });
      const ids = [...new Set((Array.isArray(body?.ids) ? body.ids : []).map(String).filter((id) => /^in-[a-z0-9]+$/.test(id)))];
      if (!ids.length) return jsonRoute(400, { error: 'Pick at least one person' });
      if (ids.length > LIMITS.invitees) return jsonRoute(400, { error: `Invite at most ${LIMITS.invitees} people at once` });
      const slotId = body.slotId ? String(body.slotId) : null;
      if (slotId && !/^sl-[a-z0-9]+$/.test(slotId)) return jsonRoute(400, { error: 'No such slot' });
      const send = body.send !== false;
      const out = await kit.once(requestId, rq.me.email, async () => {
        const now = kit.now();
        const apps = await appsById(kit, rq.cycle.id, ids);
        const tokens = new Map();
        const rows = [];
        for (const id of ids) {
          const a = apps.get(id);
          if (!a || a.erasedAt) continue;
          const token = randomBytes(16).toString('hex');
          tokens.set(id, token);
          rows.push({ id: kit.id('bk'), app: id, hash: sha(token) });
        }
        let created;
        if (kit.mode === 'memory') {
          created = [];
          for (const r of rows) {
            if (memBookings(kit).some((b) => b.applicationId === r.app && b.round === round)) continue;
            const b = { id: r.id, cycleId: rq.cycle.id, round, applicationId: r.app, slotId: null, status: 'invited', tokenHash: r.hash, version: 1, invitedAt: now, confirmedAt: null, updated: now, doc: { history: [{ status: 'invited', at: now, by: rq.me.email }] } };
            memBookings(kit).push(b);
            created.push({ ...b });
          }
          await kit.memSave();
        } else {
          const s = await kit.sql();
          const ins = await s`INSERT INTO recruit_bookings (id, cycle_id, round, application_id, slot_id, status, token_hash, version, invited_at, updated, doc)
            SELECT r.id, ${rq.cycle.id}, ${round}, r.app, NULL, 'invited', r.hash, 1, ${now}, ${now}, ${JSON.stringify({ history: [{ status: 'invited', at: now, by: rq.me.email }] })}::jsonb
            FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(id text, app text, hash text)
            ON CONFLICT (application_id, round) DO NOTHING RETURNING *`;
          created = ins.rows.map(bookingFromPg);
        }
        const createdIds = new Set(created.map((b) => b.applicationId));
        const existingRows = await listBookings(kit, rq.cycle.id, { round });
        const existing = existingRows.filter((b) => ids.includes(b.applicationId) && !createdIds.has(b.applicationId));
        const full = [];
        const results = [];
        for (const b of created) {
          let slot = null;
          if (slotId) {
            const r = await book(kit, { booking: b, slotId, version: b.version, by: rq.me.email });
            if (r) { Object.assign(b, r.booking); slot = await getSlot(kit, slotId); }
            else full.push(b.applicationId);
          }
          await kit.audit({ cycleId: rq.cycle.id, applicationId: b.applicationId, actor: rq.me.email, kind: 'booking', detail: { bookingId: b.id, round, slotId: b.slotId, requestId } });
          await announce(kit, { cycle: rq.cycle, booking: b, app: apps.get(b.applicationId), token: tokens.get(b.applicationId), slot, send, purpose: `interview_invite:${b.id}`, templateKey: 'interview_invite' });
          results.push(publicBooking(b));
        }
        const emailed = send ? await sentCount(kit, created.map((b) => `interview_invite:${b.id}`)) : 0;
        return { created: results, existing: existing.map(publicBooking), emailed, full };
      });
      return jsonRoute(201, out);
    } },

    { method: 'POST', path: '/bookings/:booking/book', access: 'member', cap: 65536, async handler(rq, kit) {
      const booking = await getBooking(kit, rq.params.booking);
      if (!booking) return jsonRoute(404, { error: 'No such booking' });
      requireLead(await roleFor(kit, rq, booking.cycleId));
      const cycle = await cycleFor(kit, booking.cycleId);
      const body = await rq.body();
      const version = Number(body?.version);
      const slotId = String(body?.slotId || '');
      if (!Number.isFinite(version) || !/^sl-[a-z0-9]+$/.test(slotId)) return jsonRoute(400, { error: 'Pick a time' });
      const r = await bookOr409(kit, { booking, slotId, version, by: rq.me.email });
      const slot = await getSlot(kit, slotId);
      const apps = await appsById(kit, cycle.id, [booking.applicationId]);
      if (body.send === true) {
        const token = randomBytes(16).toString('hex');
        const rotated = await rotateToken(kit, booking.id, sha(token));
        if (rotated) Object.assign(r.booking, rotated);
        await announce(kit, { cycle, booking: r.booking, app: apps.get(booking.applicationId), token, slot, send: true, purpose: `interview_invite:${booking.id}:${r.booking.version}`, templateKey: 'interview_invite' });
      }
      return { status: 200, body: { booking: publicBooking(r.booking), slot }, audit: { kind: 'booking', cycleId: booking.cycleId, target: booking.applicationId, detail: { bookingId: booking.id, slotId, booked: true } } };
    } },

    { method: 'PATCH', path: '/bookings/:booking', access: 'member', cap: 65536, async handler(rq, kit) {
      const booking = await getBooking(kit, rq.params.booking);
      if (!booking) return jsonRoute(404, { error: 'No such booking' });
      const role = await roleFor(kit, rq, booking.cycleId);
      if (role !== 'admin' && role !== 'lead') {
        const slot = booking.slotId ? await getSlot(kit, booking.slotId) : null;
        if (role !== 'interviewer' || !slot?.interviewers.includes(rq.me.email)) throw { status: 403, error: role ? 'Not allowed in this cycle' : 'Admins only' };
      }
      await cycleFor(kit, booking.cycleId);
      const body = await rq.body();
      const version = Number(body?.version);
      const status = String(body?.status || '');
      if (!Number.isFinite(version)) return jsonRoute(400, { error: 'Missing version' });
      if (!TRANSITIONS[status]) return jsonRoute(400, { error: 'Unknown status' });
      const row = await setStatus(kit, { booking, status, version, by: rq.me.email });
      if (!row) {
        const cur = await getBooking(kit, booking.id);
        if (cur.version !== version) return jsonRoute(409, { error: 'This booking changed. Reload.', version: cur.version });
        return jsonRoute(409, { error: `Cannot mark a ${cur.status.replace('_', '-')} interview as ${status.replace('_', '-')}`, row: publicBooking(cur) });
      }
      try { await kit.emit('booking.status', { cycle: booking.cycleId, booking: publicBooking(row), from: booking.status, to: status, by: rq.me.email }); } catch (e) { /* hooks log their own failures */ }
      return { status: 200, body: { booking: publicBooking(row) }, audit: { kind: 'booking', cycleId: booking.cycleId, target: booking.applicationId, detail: { bookingId: booking.id, from: booking.status, to: status } } };
    } },

    { method: 'POST', path: '/bookings/:booking/reschedule', access: 'member', cap: 65536, async handler(rq, kit) {
      const booking = await getBooking(kit, rq.params.booking);
      if (!booking) return jsonRoute(404, { error: 'No such booking' });
      requireLead(await roleFor(kit, rq, booking.cycleId));
      const cycle = await cycleFor(kit, booking.cycleId);
      const body = await rq.body();
      const version = Number(body?.version);
      const slotId = String(body?.slotId || '');
      if (!Number.isFinite(version) || !/^sl-[a-z0-9]+$/.test(slotId)) return jsonRoute(400, { error: 'Pick a time' });
      const token = randomBytes(16).toString('hex');
      const r = await reschedule(kit, { booking, slotId, version, tokenHash: sha(token), by: rq.me.email });
      if (!r) {
        const cur = await getBooking(kit, booking.id);
        if (cur.version !== version) return jsonRoute(409, { error: 'This booking changed. Reload.', version: cur.version });
        if (cur.slotId === slotId) return jsonRoute(409, { error: 'Already booked', row: publicBooking(cur) });
        if (!['invited', 'confirmed', 'declined', 'no_show'].includes(cur.status)) return jsonRoute(409, { error: 'This interview cannot be rescheduled', row: publicBooking(cur) });
        return jsonRoute(409, { error: 'That time is full' });
      }
      const slot = await getSlot(kit, slotId);
      const apps = await appsById(kit, cycle.id, [booking.applicationId]);
      const send = body.send !== false;
      await announce(kit, { cycle, booking: r.booking, app: apps.get(booking.applicationId), token, slot, send, purpose: `interview_reschedule:${booking.id}:${r.booking.version}`, templateKey: 'interview_invite' });
      return { status: 200, body: { booking: publicBooking(r.booking), slot }, audit: { kind: 'booking', cycleId: booking.cycleId, target: booking.applicationId, detail: { bookingId: booking.id, from: booking.slotId, to: slotId, rescheduled: true } } };
    } },

    { method: 'POST', path: '/bookings/:booking/resend', access: 'member', cap: 65536, async handler(rq, kit) {
      const booking = await getBooking(kit, rq.params.booking);
      if (!booking) return jsonRoute(404, { error: 'No such booking' });
      requireLead(await roleFor(kit, rq, booking.cycleId));
      const cycle = await cycleFor(kit, booking.cycleId);
      if (!SEATED.includes(booking.status)) return jsonRoute(409, { error: 'This invitation is no longer open', row: publicBooking(booking) });
      const token = randomBytes(16).toString('hex');
      const row = await rotateToken(kit, booking.id, sha(token));
      if (!row) return jsonRoute(409, { error: 'This invitation is no longer open' });
      const slot = row.slotId ? await getSlot(kit, row.slotId) : null;
      const apps = await appsById(kit, cycle.id, [booking.applicationId]);
      await announce(kit, { cycle, booking: row, app: apps.get(booking.applicationId), token, slot, send: true, purpose: `interview_invite:${booking.id}:again-${row.version}`, templateKey: 'interview_invite' });
      const emailed = await sentCount(kit, [`interview_invite:${booking.id}:again-${row.version}`]);
      return { status: 200, body: { booking: publicBooking(row), emailed }, audit: { kind: 'booking', cycleId: booking.cycleId, target: booking.applicationId, detail: { bookingId: booking.id, resent: true } } };
    } },

    { method: 'GET', path: '/cycles/:cycle/my-interviews', access: 'interviewer', async handler(rq, kit) {
      const from = kit.now() - 3600000;
      const slots = await listSlots(kit, rq.cycle.id, { from, me: rq.me.email });
      const bookings = await bookingsForSlots(kit, rq.cycle.id, slots.map((s) => s.id));
      const scored = new Map();
      for (const round of new Set(slots.map((s) => s.round))) scored.set(round, await scoredSet(kit, rq.me.email, round));
      const upcoming = slots.map((slot) => ({ slot, bookings: bookings.filter((b) => b.slotId === slot.id && ['invited', 'confirmed', 'done'].includes(b.status)).map((b) => ({ id: b.id, applicationId: b.applicationId, name: b.name, status: b.status, version: b.version, scored: scored.get(slot.round)?.has(b.applicationId) || false })) }));
      return jsonRoute(200, { upcoming, rounds: roundsOf(rq.cycle).map(({ key, name }) => ({ key, name })) });
    } },

    // Public: the applicant's link. No session, no applicant data in the
    // response, 404 for anything that is not a live token.
    { method: 'GET', path: '/rsvp/:token', access: 'public', public: true, async handler(rq, kit) {
      const b = await bookingByToken(kit, rq.params.token);
      if (!b || !SEATED.includes(b.status) || b.invitedAt < kit.now() - LIMITS.tokenDays * 86400000) return jsonRoute(404, { error: 'This link has expired' });
      const cycle = await kit.cycles.get(b.cycleId);
      if (!cycle || cycle.status === 'archived') return jsonRoute(404, { error: 'This link has expired' });
      const slot = b.slotId ? await getSlot(kit, b.slotId) : null;
      const out = { round: roundName(cycle, b.round), status: b.status, slot: slot ? { starts: slot.starts, ends: slot.ends, place: slot.place } : null };
      if (!slot && selfSchedule(cycle)) {
        const open = await listSlots(kit, b.cycleId, { round: b.round, from: kit.now() });
        out.slots = open.filter((s) => s.booked < s.capacity).map((s) => ({ id: s.id, starts: s.starts, ends: s.ends, place: s.place, free: s.capacity - s.booked }));
      }
      return { status: 200, body: out, headers: { 'cache-control': 'private, no-store' } };
    } },

    { method: 'POST', path: '/rsvp/:token', access: 'public', public: true, cap: 4096, async handler(rq, kit) {
      const b = await bookingByToken(kit, rq.params.token);
      if (!b || !SEATED.includes(b.status) || b.invitedAt < kit.now() - LIMITS.tokenDays * 86400000) return jsonRoute(404, { error: 'This link has expired' });
      const cycle = await kit.cycles.get(b.cycleId);
      if (!cycle || cycle.status === 'archived') return jsonRoute(404, { error: 'This link has expired' });
      const body = await rq.body();
      const action = String(body?.action || '');
      let row;
      if (action === 'decline') {
        row = await setStatus(kit, { booking: b, status: 'declined', tokenHash: b.tokenHash, by: 'applicant' });
      } else if (action === 'confirm') {
        if (!b.slotId) {
          const slotId = String(body?.slotId || '');
          if (!selfSchedule(cycle) || !/^sl-[a-z0-9]+$/.test(slotId)) return jsonRoute(400, { error: 'Pick a time' });
          const r = await book(kit, { booking: b, slotId, tokenHash: b.tokenHash, by: 'applicant' });
          if (!r) {
            const cur = await getBooking(kit, b.id);
            return jsonRoute(409, cur?.slotId ? { error: 'Already booked' } : { error: 'That time is full' });
          }
          row = r.booking;
        } else row = await setStatus(kit, { booking: b, status: 'confirmed', tokenHash: b.tokenHash, by: 'applicant' }) || (b.status === 'confirmed' ? await confirmAgain(kit, b) : null);
      } else return jsonRoute(400, { error: 'Confirm or decline' });
      if (!row) return jsonRoute(404, { error: 'This link has expired' });
      await kit.audit({ cycleId: b.cycleId, applicationId: b.applicationId, actor: 'applicant', kind: 'rsvp', detail: { bookingId: b.id, action, slotId: row.slotId || null } });
      try { await kit.emit('booking.status', { cycle: b.cycleId, booking: publicBooking(row), from: b.status, to: row.status, by: 'applicant' }); } catch (e) { /* best effort */ }
      return { status: 200, body: { status: row.status }, headers: { 'cache-control': 'private, no-store' } };
    } },
  ],

  hooks: {
    async 'stage.moved'(ev, kit) {
      const cycle = typeof ev.cycle === 'string' ? await kit.cycles.get(ev.cycle) : ev.cycle;
      if (!cycle) return;
      const toStage = (cycle.doc?.pipeline?.stages || []).find((s) => s.key === ev.to);
      const leftInterview = ev.from === 'interview' && ev.to !== 'interview';
      if (!leftInterview && toStage?.kind !== 'closed') return;
      const applicationId = typeof ev.application === 'string' ? ev.application : ev.application?.id;
      if (!applicationId) return;
      const n = await cancelInvited(kit, cycle.id, { applicationId });
      if (n) await kit.audit({ cycleId: cycle.id, applicationId, actor: 'system', kind: 'booking', detail: { cancelled: n, reason: 'stage', to: ev.to } });
    },
    async 'cycle.status'(ev, kit) {
      const cycleId = typeof ev.cycle === 'string' ? ev.cycle : ev.cycle?.id;
      const status = ev.status || ev.to || ev.cycle?.status;
      if (!cycleId || !['closed', 'archived'].includes(status)) return;
      const n = await cancelInvited(kit, cycleId, { blankAll: true });
      if (n) await kit.audit({ cycleId, actor: 'system', kind: 'booking', detail: { cancelled: n, reason: 'cycle', status } });
    },
  },

  collect: {
    async 'scope.applications'({ cycle, me }, kit) {
      const slots = await listSlots(kit, cycle.id, { me: me.email });
      const bookings = await bookingsForSlots(kit, cycle.id, slots.map((s) => s.id));
      return new Set(bookings.filter((b) => b.status !== 'cancelled' && b.status !== 'declined').map((b) => b.applicationId));
    },
    async 'application.extras'({ cycle, ids }, kit) {
      const out = {};
      const bookings = (await listBookings(kit, cycle.id)).filter((b) => ids.includes(b.applicationId));
      for (const b of bookings) {
        const cur = out[b.applicationId]?.booking;
        if (!cur || (b.updated || 0) > (cur.updated || 0)) out[b.applicationId] = { booking: { id: b.id, round: b.round, status: b.status, starts: b.starts, slotId: b.slotId, version: b.version, updated: b.updated } };
      }
      return out;
    },
    async 'csv.columns'(cycle, kit) {
      const latest = new Map();
      for (const b of await listBookings(kit, cycle.id)) {
        const cur = latest.get(b.applicationId);
        if (!cur || (b.updated || 0) > (cur.updated || 0)) latest.set(b.applicationId, b);
      }
      const label = (b) => (b ? `${b.status.replace('_', '-')}${b.starts ? ` · ${new Date(b.starts).toISOString()}` : ''}` : '');
      return [{ header: 'Interview', cell: (row) => label(latest.get(row.id)) }];
    },
    async purge({ ids }, kit) {
      if (!ids?.length) return;
      if (kit.mode === 'memory') {
        for (const b of memBookings(kit)) if (ids.includes(b.applicationId)) b.tokenHash = '';
        await kit.memSave();
        return;
      }
      const s = await kit.sql();
      await s`UPDATE recruit_bookings SET token_hash = '' WHERE application_id = ANY(${ids}) AND token_hash <> ''`;
    },
  },
};

// An applicant re-confirming a slot the lead already booked: record the
// acknowledgement and spend the token.
async function confirmAgain(kit, b) {
  const now = kit.now();
  if (kit.mode === 'memory') {
    const row = memBookings(kit).find((x) => x.id === b.id && x.tokenHash === b.tokenHash && x.status === 'confirmed');
    if (!row) return null;
    Object.assign(row, { tokenHash: '', updated: now, version: row.version + 1, doc: { ...row.doc, history: [...(row.doc?.history || []), { status: 'confirmed', at: now, by: 'applicant' }] } });
    await kit.memSave();
    return { ...row };
  }
  const s = await kit.sql();
  const out = await s`UPDATE recruit_bookings SET token_hash = '', updated = ${now}, version = version + 1, doc = jsonb_set(doc, '{history}', COALESCE(doc->'history', '[]'::jsonb) || ${history('confirmed', 'applicant', now)}::jsonb)
    WHERE id = ${b.id} AND token_hash <> '' AND token_hash = ${b.tokenHash} AND status = 'confirmed' RETURNING *`;
  return out.rows[0] ? bookingFromPg(out.rows[0]) : null;
}

export { book, setStatus, reschedule, listSlots, listBookings, cancelInvited, sha as hashToken };
