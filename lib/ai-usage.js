// Shared, durable OpenAI accounting. Dollars are stored as integer microdollars.
// No credentials, document text, or generated summaries enter this ledger.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { rawSql, storageMode } from './db.js';

export const AI_SPEND_LIMITS = Object.freeze({ monthMicros: 5_000_000, dayMicros: 1_000_000,
  requestMicros: 50_000, concurrent: 3, perMinute: 30, perMemberMinute: 8, perDay: 1200, perMemberDay: 200 });
export const AI_PRICE_DATE = '2026-09-18';
// Standard, short-context rates: https://developers.openai.com/api/docs/pricing
// A dollar per million tokens is one microdollar per token.
const prices = Object.freeze({
  'gpt-5.6-luna': { input: .20, cached: .02, write: .25, output: 1.20 },
  'gpt-5.6-sol': { input: 4, cached: .4, write: 5, output: 20 },
  'gpt-6-astra': { input: 10, cached: 1, write: 12.5, output: 50 },
});
export const aiOutputBudget = (effort) => ({ none: 160, low: 1024, medium: 2048, high: 4096, xhigh: 8192, max: 16384 })[effort] || 160;

export function reserveEstimate(model, instructions, input, maxOutput) {
  const price = prices[model];
  if (!price || !Number.isSafeInteger(maxOutput) || maxOutput < 1) return null;
  // UTF-8 byte count bounds the text tokens, plus generous message framing.
  // Reserve at cache-write pricing (higher than ordinary input), without
  // assuming a cache hit. The provider receives no tools or hidden context.
  const inputBound = Buffer.byteLength(instructions + input, 'utf8') + 1024;
  if (inputBound > 65000) return null; // never enter long-context pricing
  return Math.ceil(inputBound * price.write + maxOutput * price.output);
}

export function usageCost(model, usage, serviceTier) {
  const price = prices[model];
  if (!price || !usage || (serviceTier && serviceTier !== 'default')) return null;
  const input = usage.input_tokens, output = usage.output_tokens;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const writes = usage.input_tokens_details?.cache_write_tokens ?? 0;
  if (![input, output, cached, writes].every((n) => Number.isSafeInteger(n) && n >= 0)
    || input > 65000 || cached + writes > input || output > 16384) return null;
  return { costMicros: Math.ceil((input - cached - writes) * price.input + cached * price.cached + writes * price.write + output * price.output),
    inputTokens: input, outputTokens: output, cachedTokens: cached, cacheWriteTokens: writes };
}

const emptyPeriod = () => ({ costMicros: 0, reservedMicros: 0, uncertainMicros: 0, requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 });
const initial = (now) => ({ startedAt: now, lastAt: now, days: {}, months: {}, members: {}, requests: {}, halted: false });
const spent = (period) => period.costMicros + period.reservedMicros + period.uncertainMicros;
const utc = (now) => { const day = new Date(now).toISOString().slice(0, 10); return { day, month: day.slice(0, 7) }; };
const periods = (s, r) => [s.days[r.day] ||= emptyPeriod(), s.months[r.month] ||= emptyPeriod()];

function prepare(s, now) {
  now = Math.max(now, s.lastAt);
  s.lastAt = now;
  for (const [id, r] of Object.entries(s.requests)) {
    // A dead worker never gets a refund. Release its concurrency slot only;
    // retain the entire possible charge in both original budget periods.
    if (r.status === 'pending' && now - r.at >= 90000) {
      for (const p of periods(s, r)) { p.reservedMicros -= r.reserved; p.uncertainMicros += r.reserved; }
      r.status = 'uncertain';
    }
    if (now - r.at > 2 * 60 * 1000) delete s.requests[id];
  }
  const dayCutoff = new Date(now - 90 * 86400000).toISOString().slice(0, 10);
  for (const day of Object.keys(s.days)) if (day < dayCutoff) delete s.days[day];
  for (const member of Object.keys(s.members)) if (s.members[member].day !== utc(now).day) delete s.members[member];
  return now;
}

export function usageSnapshot(state, now = Date.now()) {
  const s = structuredClone(state); now = prepare(s, now);
  const { day, month } = utc(now), today = s.days[day] || emptyPeriod(), current = s.months[month] || emptyPeriod();
  return { startedAt: s.startedAt, asOf: now, day, month, today, current, limits: AI_SPEND_LIMITS, priceDate: AI_PRICE_DATE,
    halted: s.halted, paused: s.halted || spent(today) >= AI_SPEND_LIMITS.dayMicros || spent(current) >= AI_SPEND_LIMITS.monthMicros,
    recentDays: Object.entries(s.days).filter(([id]) => id.startsWith(month)).sort(([a], [b]) => b.localeCompare(a)).map(([date, value]) => ({ date, ...value })) };
}

// Store supplies read + compare-and-swap. Every allowance, reservation and
// settlement is committed atomically across Vercel workers before proceeding.
export function createAiUsageLedger(store, clock = Date.now) {
  async function change(fn) {
    for (let retry = 0; retry < 12; retry++) {
      const row = await store.read();
      const state = structuredClone(row.state), now = prepare(state, clock());
      const out = fn(state, now);
      if (!out.write) return out.result;
      if (await store.swap(row.version, state)) return out.result;
    }
    throw new Error('AI accounting is busy');
  }
  return {
    async snapshot() { return usageSnapshot((await store.read()).state, clock()); },
    reserve({ member, key, model, amount }) {
      if (!member || !key || !prices[model] || !Number.isSafeInteger(amount) || amount <= 0 || amount > AI_SPEND_LIMITS.requestMicros)
        return Promise.resolve({ allowed: false, reason: 'request_limit' });
      const memberId = createHash('sha256').update(member).digest('hex'), id = randomUUID();
      return change((s, now) => {
        const deny = (reason) => ({ result: { allowed: false, reason } });
        const { day, month } = utc(now), today = s.days[day] ||= emptyPeriod(), current = s.months[month] ||= emptyPeriod();
        if (s.halted) return deny('accounting_halted');
        if (spent(today) + amount > AI_SPEND_LIMITS.dayMicros || spent(current) + amount > AI_SPEND_LIMITS.monthMicros) return deny('budget_limit');
        const calls = Object.values(s.requests), recent = calls.filter((r) => now - r.at < 60000), pending = calls.filter((r) => r.status === 'pending');
        if (calls.some((r) => r.key === key)) return deny('duplicate');
        if (pending.length >= AI_SPEND_LIMITS.concurrent || pending.some((r) => r.member === memberId)) return deny('concurrency_limit');
        const own = s.members[memberId] ||= { day, requests: 0 };
        if (recent.length >= AI_SPEND_LIMITS.perMinute || recent.filter((r) => r.member === memberId).length >= AI_SPEND_LIMITS.perMemberMinute
          || today.requests >= AI_SPEND_LIMITS.perDay || own.requests >= AI_SPEND_LIMITS.perMemberDay) return deny('rate_limit');
        const request = { at: now, day, month, member: memberId, key, model, reserved: amount, status: 'pending' };
        s.requests[id] = request;
        for (const p of periods(s, request)) { p.reservedMicros += amount; p.requests++; }
        own.requests++;
        return { write: true, result: { allowed: true, id } };
      });
    },
    settle(id, usage, halt = false) {
      if (usage && (!Number.isSafeInteger(usage.costMicros) || usage.costMicros < 0)) { usage = null; halt = true; }
      return change((s) => {
        const r = s.requests[id];
        if (!r || (r.status !== 'pending' && r.status !== 'uncertain')) return { result: false };
        if (r.settled) return { result: false };
        for (const p of periods(s, r)) {
          if (r.status === 'pending') p.reservedMicros -= r.reserved; else p.uncertainMicros -= r.reserved;
          if (usage) {
            p.costMicros += usage.costMicros;
            for (const field of ['inputTokens', 'outputTokens', 'cachedTokens', 'cacheWriteTokens']) p[field] += usage[field] || 0;
          } else p.uncertainMicros += r.reserved;
        }
        if (halt || usage?.costMicros > r.reserved) s.halted = true;
        r.status = usage ? 'settled' : 'uncertain'; r.settled = true;
        return { write: true, result: true };
      });
    },
  };
}

const DEV_FILE = new URL('../.devaiusage.json', import.meta.url);
let ready;
async function readRow() {
  if (storageMode() === 'memory') {
    try { return JSON.parse(readFileSync(DEV_FILE, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const row = { version: 1, state: initial(Date.now()) }; writeFileSync(DEV_FILE, JSON.stringify(row)); return row;
  }
  const sql = await rawSql();
  ready ||= (async () => {
    await sql`CREATE TABLE IF NOT EXISTS wiki_ai_usage (id int PRIMARY KEY, version bigint NOT NULL, ledger jsonb NOT NULL)`;
    await sql`INSERT INTO wiki_ai_usage (id, version, ledger) VALUES (1, 1, ${JSON.stringify(initial(Date.now()))}::jsonb) ON CONFLICT DO NOTHING`;
  })().catch((error) => { ready = null; throw error; });
  await ready;
  const out = await sql`SELECT version, ledger AS state FROM wiki_ai_usage WHERE id = 1`;
  if (!out.rows[0]) throw new Error('AI accounting is unavailable');
  return { version: Number(out.rows[0].version), state: out.rows[0].state };
}
async function swapRow(version, state) {
  if (storageMode() === 'memory') {
    const row = JSON.parse(readFileSync(DEV_FILE, 'utf8'));
    if (row.version !== version) return false;
    const temp = new URL('../.devaiusage.json.tmp', import.meta.url);
    writeFileSync(temp, JSON.stringify({ version: version + 1, state })); renameSync(temp, DEV_FILE); return true;
  }
  const sql = await rawSql();
  const out = await sql`UPDATE wiki_ai_usage SET ledger = ${JSON.stringify(state)}::jsonb, version = version + 1 WHERE id = 1 AND version = ${version} RETURNING version`;
  return out.rows.length === 1;
}
export const aiUsageLedger = createAiUsageLedger({ read: readRow, swap: swapRow });
