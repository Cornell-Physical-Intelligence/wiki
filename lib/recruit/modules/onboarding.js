// Onboarding module: accepted applicants become wiki members through the
// same `addMembers` op the Members page uses (the admin is re-checked inside
// the state write), get the welcome email, and are stamped `onboarded_at`
// exactly once. One small table remembers the outcome per application.

const REQUEST_ID = /^rq-[a-z0-9-]{8,80}$/;
export const LIMITS = { ids: 100 };
const jsonRoute = (status, body) => ({ status, body });
const num = (v) => (v === null || v === undefined ? null : Number(v));
const obj = (v) => (typeof v === 'string' ? JSON.parse(v) : v || {});

function rowFromPg(r) {
  return { applicationId: r.application_id, cycleId: r.cycle_id, memberEmail: r.member_email, status: r.status, reason: r.reason || '', by: r.by || '', ts: num(r.ts) };
}

function normApp(r) {
  if (!r) return null;
  return {
    id: r.id, cycleId: r.cycleId ?? r.cycle_id, email: r.email ?? '', name: r.name ?? '', subteam: r.subteam ?? '', year: r.year ?? null, stage: r.stage,
    outcome: r.outcome ?? null, decision: obj(r.decision), onboardedAt: num(r.onboardedAt ?? r.onboarded_at), erasedAt: num(r.erasedAt ?? r.erased_at),
  };
}

const memRows = (kit) => (kit.mem.onboarding ||= []);

async function acceptedIn(kit, cycleId, ids = null) {
  if (kit.mode === 'memory') {
    return (kit.mem.applications || []).map(normApp).filter((a) => a.cycleId === cycleId && a.outcome === 'accepted' && (!ids || ids.includes(a.id))).sort((a, b) => (a.decision?.at || 0) - (b.decision?.at || 0));
  }
  const s = await kit.sql();
  const out = await s`SELECT id, cycle_id, email, name, subteam, year, stage, outcome, decision, onboarded_at, erased_at FROM recruit_applications
    WHERE cycle_id = ${cycleId} AND outcome = 'accepted' AND (${ids}::text[] IS NULL OR id = ANY(${ids})) ORDER BY (decision->>'at')::bigint NULLS LAST, ts LIMIT 2000`;
  return out.rows.map(normApp);
}

async function rowsFor(kit, cycleId) {
  if (kit.mode === 'memory') return new Map(memRows(kit).filter((r) => r.cycleId === cycleId).map((r) => [r.applicationId, { ...r }]));
  const s = await kit.sql();
  const out = await s`SELECT * FROM recruit_onboarding WHERE cycle_id = ${cycleId}`;
  return new Map(out.rows.map((r) => [r.application_id, rowFromPg(r)]));
}

async function rosterEmails(kit) {
  try { return new Set(((await kit.roles.roster()) || []).map((u) => String(u.email).toLowerCase())); }
  catch (e) { return new Set(); }
}

async function record(kit, cycleId, results, by) {
  const now = kit.now();
  const rows = results.map((r) => ({ application_id: r.id, member_email: r.email, status: r.status, reason: r.reason || '' }));
  if (!rows.length) return;
  if (kit.mode === 'memory') {
    for (const r of rows) {
      const cur = memRows(kit).find((x) => x.applicationId === r.application_id);
      const next = { applicationId: r.application_id, cycleId, memberEmail: r.member_email, status: r.status, reason: r.reason, by, ts: now };
      if (cur) Object.assign(cur, next); else memRows(kit).push(next);
    }
    await kit.memSave();
    return;
  }
  const s = await kit.sql();
  await s`INSERT INTO recruit_onboarding (application_id, cycle_id, member_email, status, reason, by, ts)
    SELECT r.application_id, ${cycleId}, r.member_email, r.status, r.reason, ${by}, ${now} FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(application_id text, member_email text, status text, reason text)
    ON CONFLICT (application_id) DO UPDATE SET cycle_id = EXCLUDED.cycle_id, member_email = EXCLUDED.member_email, status = EXCLUDED.status, reason = EXCLUDED.reason, by = EXCLUDED.by, ts = EXCLUDED.ts`;
}

// Stamps once: a second request for the same person changes nothing.
async function stamp(kit, ids) {
  if (!ids.length) return [];
  const now = kit.now();
  if (kit.mode === 'memory') {
    const stamped = [];
    for (const a of kit.mem.applications || []) {
      if (!ids.includes(a.id) || (a.onboardedAt ?? a.onboarded_at)) continue;
      if ('onboarded_at' in a) a.onboarded_at = now; else a.onboardedAt = now;
      if ('edit_version' in a) a.edit_version = Number(a.edit_version) + 1; else a.editVersion = Number(a.editVersion || 0) + 1;
      stamped.push({ id: a.id, email: a.email });
    }
    for (const p of kit.mem.applicants || []) if (stamped.some((x) => x.email === p.email)) p.doc = { ...(p.doc || {}), memberEmail: p.email };
    await kit.memSave();
    return stamped;
  }
  const s = await kit.sql();
  const out = await s`UPDATE recruit_applications SET onboarded_at = ${now}, edit_version = edit_version + 1 WHERE id = ANY(${ids}) AND onboarded_at IS NULL RETURNING id, email`;
  const emails = out.rows.map((r) => r.email);
  if (emails.length) await s`UPDATE recruit_applicants SET doc = doc || jsonb_build_object('memberEmail', email) WHERE email = ANY(${emails})`;
  return out.rows.map((r) => ({ id: r.id, email: r.email }));
}

function validateSettings(next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) throw { status: 400, error: 'Onboarding settings must be an object' };
  if (next.role !== undefined && next.role !== 'member') throw { status: 400, error: 'New members join as members; promote them on the Members page' };
}

export default {
  name: 'onboarding',
  kernel: false,
  order: 90,
  schema: [
    `CREATE TABLE IF NOT EXISTS recruit_onboarding (application_id text PRIMARY KEY, cycle_id text NOT NULL, member_email text NOT NULL, status text NOT NULL, reason text NOT NULL DEFAULT '', by text, ts bigint NOT NULL)`,
  ],
  memory: { onboarding: [] },
  defaults: () => ({ role: 'member' }),
  validateSettings,
  auditKinds: ['onboard'],

  routes: [
    { method: 'GET', path: '/cycles/:cycle/onboarding', access: 'admin', async handler(rq, kit) {
      const [apps, rows, roster] = await Promise.all([acceptedIn(kit, rq.cycle.id), rowsFor(kit, rq.cycle.id), rosterEmails(kit)]);
      return jsonRoute(200, { rows: apps.map((a) => {
        const row = rows.get(a.id) || null;
        const onRoster = a.erasedAt ? null : roster.has(a.email) ? 'active' : row?.status === 'invited' ? 'invited' : null;
        return { applicationId: a.id, name: a.name, email: a.erasedAt ? '' : a.email, subteam: a.subteam, decidedAt: num(a.decision?.at), onboardedAt: a.onboardedAt, onboarding: row, onRoster };
      }) });
    } },

    { method: 'POST', path: '/cycles/:cycle/onboarding', access: 'admin', mutates: true, cap: 65536, async handler(rq, kit) {
      const body = await rq.body();
      const requestId = String(body?.requestId || '');
      if (!REQUEST_ID.test(requestId)) return jsonRoute(400, { error: 'Missing requestId' });
      const ids = [...new Set((Array.isArray(body?.ids) ? body.ids : []).map(String).filter((id) => /^in-[a-z0-9]+$/.test(id)))];
      if (!ids.length) return jsonRoute(400, { error: 'Pick at least one person' });
      if (ids.length > LIMITS.ids) return jsonRoute(400, { error: `Invite at most ${LIMITS.ids} people at once` });
      const out = await kit.once(requestId, rq.me.email, async () => {
        const accepted = new Map((await acceptedIn(kit, rq.cycle.id, ids)).map((a) => [a.id, a]));
        const results = [];
        const todo = [];
        for (const id of ids) {
          const a = accepted.get(id);
          if (!a) { results.push({ id, email: '', ok: false, reason: 'not accepted' }); continue; }
          if (a.erasedAt) { results.push({ id, email: '', ok: false, reason: 'erased' }); continue; }
          if (a.onboardedAt) { results.push({ id, email: a.email, ok: false, status: 'active', reason: 'already onboarded' }); continue; }
          todo.push(a);
        }
        let invited = 0, active = 0, failed = 0;
        if (todo.length) {
          const emails = todo.map((a) => a.email);
          const wiki = await kit.wiki.addMembers(emails, rq.me.email);
          if (!wiki || !Array.isArray(wiki.results)) throw { status: 403, error: 'Admins only' };
          const byEmail = new Map(wiki.results.map((r) => [String(r.email).toLowerCase(), r]));
          const settled = [];
          for (const a of todo) {
            const r = byEmail.get(a.email) || { ok: false, reason: 'no result' };
            if (r.ok) {
              let emailed = { sent: false, reason: 'welcome email skipped' };
              try { emailed = await kit.wiki.sendWelcome({ to: a.email, addedByName: rq.me.name || rq.me.email, host: kit.email?.host, settings: wiki.settings, clientId: kit.email?.clientId, saveOauth: kit.email?.saveOauth }); }
              catch (e) { emailed = { sent: false, reason: e.message }; }
              invited += 1;
              settled.push({ id: a.id, email: a.email, ok: true, status: 'invited', reason: '', emailed: { sent: !!emailed?.sent, ...(emailed?.reason ? { reason: emailed.reason } : {}) } });
            } else if (/already on the roster/i.test(r.reason || '')) {
              active += 1;
              settled.push({ id: a.id, email: a.email, ok: true, status: 'active', reason: r.reason || '' });
            } else {
              failed += 1;
              settled.push({ id: a.id, email: a.email, ok: false, status: 'failed', reason: r.reason || 'could not invite' });
            }
          }
          await record(kit, rq.cycle.id, settled, rq.me.email);
          await stamp(kit, settled.filter((x) => x.ok).map((x) => x.id));
          for (const x of settled) await kit.audit({ cycleId: rq.cycle.id, applicationId: x.id, actor: rq.me.email, kind: 'onboard', detail: { status: x.status, requestId } });
          results.push(...settled);
          try { await kit.emit('onboarding.invited', { cycle: rq.cycle, ids: settled.filter((x) => x.ok).map((x) => x.id), by: rq.me.email }); } catch (e) { /* hooks log their own failures */ }
        }
        return { results, invited, active, failed };
      });
      return jsonRoute(200, out);
    } },
  ],

  hooks: {},

  collect: {
    async 'application.extras'({ cycle, ids }, kit) {
      const rows = await rowsFor(kit, cycle.id);
      const out = {};
      for (const id of ids) { const r = rows.get(id); if (r) out[id] = { onboarding: { status: r.status, ts: r.ts } }; }
      return out;
    },
    async 'csv.columns'() {
      return [{ header: 'Onboarded', cell: (row) => (row.onboardedAt ? new Date(Number(row.onboardedAt)).toISOString() : '') }];
    },
    async purge({ ids }, kit) {
      if (!ids?.length) return;
      if (kit.mode === 'memory') {
        for (const r of memRows(kit)) if (ids.includes(r.applicationId)) r.memberEmail = 'erased';
        await kit.memSave();
        return;
      }
      const s = await kit.sql();
      await s`UPDATE recruit_onboarding SET member_email = 'erased' WHERE application_id = ANY(${ids}) AND member_email <> 'erased'`;
    },
  },
};
