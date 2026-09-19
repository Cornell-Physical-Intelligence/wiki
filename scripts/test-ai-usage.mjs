// No network, credentials, or production data. Independent ledger workers
// contend against one versioned store, matching Postgres compare-and-swap.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiUsageLedger, AI_SPEND_LIMITS, usageCost, reserveEstimate } from '../lib/ai-usage.js';
import { generateChangeSummary } from '../lib/change-summary.js';

function fixture() {
  let now = Date.parse('2026-09-18T12:00:00Z'), version = 1;
  let state = { startedAt: now, lastAt: now, days: {}, months: {}, members: {}, requests: {}, halted: false };
  const store = {
    down: false, loseWrites: false,
    async read() { if (this.down) throw new Error('Offline'); return { state: structuredClone(state), version }; },
    async swap(expected, next) {
      await new Promise((r) => setImmediate(r));
      if (this.down || this.loseWrites) throw new Error('Offline');
      if (version !== expected) return false;
      state = structuredClone(next); version++; return true;
    },
  };
  const worker = () => createAiUsageLedger(store, () => now);
  return { ledger: worker(), worker, store, tick(ms) { now += ms; }, setTime(time) { now = Date.parse(time); },
    get state() { return state; }, setState(next) { state = next; } };
}
const args = (key, member = 'one@example.test', amount = 1000) => ({ key, member, amount, model: 'gpt-5.6-luna' });
const zero = { costMicros: 0 };
const total = (p) => p.costMicros + p.reservedMicros + p.uncertainMicros;

test('simultaneous workers reserve at most three calls and cannot bypass member concurrency', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 30 }, (_, n) => f.worker().reserve(args('key-' + n, 'member-' + n))));
  assert.equal(results.filter((r) => r.allowed).length, 3);
  assert.equal(total((await f.ledger.snapshot()).current), 3000);
  const g = fixture();
  const sameMember = await Promise.all(Array.from({ length: 10 }, (_, n) => g.worker().reserve(args('key-' + n))));
  assert.equal(sameMember.filter((r) => r.allowed).length, 1);
});

test('shared duplicate suppression survives cold workers and request retries', async () => {
  const f = fixture();
  const first = await f.ledger.reserve(args('same'));
  assert.equal((await f.worker().reserve(args('same', 'another'))).reason, 'duplicate');
  await f.worker().settle(first.id, { costMicros: 250, inputTokens: 1000, outputTokens: 40 });
  await f.worker().settle(first.id, { costMicros: 250 });
  const usage = await f.worker().snapshot();
  assert.equal(usage.current.costMicros, 250); assert.equal(usage.current.reservedMicros, 0);
  assert.equal(usage.current.requests, 1); assert.equal(usage.current.inputTokens, 1000);
  assert.equal((await f.worker().reserve(args('same', 'another'))).reason, 'duplicate');
});

test('reservations cannot cross daily or monthly caps under races', async () => {
  for (const period of ['days', 'months']) {
    const f = fixture(), seed = await f.ledger.reserve(args('seed'));
    await f.ledger.settle(seed.id, zero);
    const key = period === 'days' ? '2026-09-18' : '2026-09';
    const cap = period === 'days' ? AI_SPEND_LIMITS.dayMicros : AI_SPEND_LIMITS.monthMicros;
    f.state[period][key].costMicros = cap - 1500;
    const results = await Promise.all(Array.from({ length: 15 }, (_, n) => f.worker().reserve(args('race-' + n, 'race-' + n))));
    assert.equal(results.filter((r) => r.allowed).length, 1);
    assert.ok(total(f.state[period][key]) <= cap);
  }
});

test('timeouts and crashes keep maximum charges after the concurrency lease expires', async () => {
  const f = fixture();
  const first = await f.ledger.reserve(args('timeout', 'one', 50000));
  await f.ledger.settle(first.id, null);
  let usage = await f.ledger.snapshot();
  assert.equal(usage.current.uncertainMicros, 50000);
  const crashed = await f.ledger.reserve(args('crashed', 'two', 50000));
  f.tick(90001);
  usage = await f.ledger.snapshot();
  assert.equal(usage.current.uncertainMicros, 100000);
  assert.equal(usage.current.reservedMicros, 0);
  assert.equal((await f.ledger.reserve(args('after-crash', 'two'))).allowed, true);
  await f.ledger.settle(crashed.id, { costMicros: 100 });
  usage = await f.ledger.snapshot();
  assert.equal(usage.current.uncertainMicros, 50000);
  assert.equal(usage.current.costMicros, 100);
});

test('late settlement stays in its original UTC day and month', async () => {
  const f = fixture(); f.setTime('2026-09-30T23:59:59Z');
  const first = await f.ledger.reserve(args('boundary', 'one', 10000));
  f.tick(2000); await f.ledger.settle(first.id, { costMicros: 2000 });
  const usage = await f.ledger.snapshot();
  assert.equal(usage.month, '2026-10'); assert.equal(total(usage.current), 0);
  assert.equal(f.state.months['2026-09'].costMicros, 2000);
  assert.equal(f.state.days['2026-09-30'].reservedMicros, 0);
});

test('minute and day request ceilings still apply when calls are rejected without a charge', async () => {
  const f = fixture();
  for (let n = 0; n < 8; n++) { const r = await f.ledger.reserve(args('own-' + n)); assert.equal(r.allowed, true); await f.ledger.settle(r.id, zero); }
  assert.equal((await f.ledger.reserve(args('own-over'))).reason, 'rate_limit');
  f.tick(60001); assert.equal((await f.ledger.reserve(args('new-window'))).allowed, true);
  const g = fixture();
  for (let n = 0; n < 30; n++) { const r = await g.ledger.reserve(args('site-' + n, 'person-' + n)); await g.ledger.settle(r.id, zero); }
  assert.equal((await g.ledger.reserve(args('site-over', 'different'))).reason, 'rate_limit');
  g.state.days['2026-09-18'].requests = 1200; g.tick(60001);
  assert.equal((await g.ledger.reserve(args('day-over', 'different'))).reason, 'rate_limit');
});

test('prices include cached input, cache writes and all output/reasoning tokens', () => {
  assert.deepEqual(usageCost('gpt-5.6-luna', { input_tokens: 1000, input_tokens_details: { cached_tokens: 400, cache_write_tokens: 200 }, output_tokens: 100 }, 'default'),
    { costMicros: 258, inputTokens: 1000, outputTokens: 100, cachedTokens: 400, cacheWriteTokens: 200 });
  assert.equal(usageCost('gpt-5.6-luna', { input_tokens: -1, output_tokens: 1 }), null);
  assert.equal(usageCost('gpt-5.6-luna', { input_tokens: 1000, output_tokens: 100 }, 'priority'), null);
  assert.ok(reserveEstimate('gpt-5.6-luna', 'Instructions', '中文'.repeat(1000), 160) > reserveEstimate('gpt-5.6-luna', 'Instructions', 'aa'.repeat(1000), 160));
  assert.equal(reserveEstimate('unknown', '', '', 160), null);
});

test('unknown models, oversized calls and unexpected provider costs fail closed', async () => {
  const f = fixture();
  assert.equal((await f.ledger.reserve(args('huge', 'one', 50001))).reason, 'request_limit');
  assert.equal((await f.ledger.reserve({ ...args('bad'), model: 'unknown' })).allowed, false);
  const r = await f.ledger.reserve(args('unexpected'));
  await f.ledger.settle(r.id, { costMicros: 1100 });
  assert.equal((await f.ledger.snapshot()).halted, true);
  assert.equal((await f.ledger.reserve(args('next'))).reason, 'accounting_halted');
});

const input = { title: 'Wiring', beforeTitle: 'Wiring', section: 'Electrical', beforeSection: 'Electrical', diff: '- 5V\n+ 3.3V', isNew: false, truncated: false };
const completed = (extra = {}) => ({ ok: true, json: async () => ({ status: 'completed', service_tier: 'default', model: 'gpt-5.6-luna', usage: { input_tokens: 1000, output_tokens: 50 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Changed the sensor voltage to 3.3V' }] }], ...extra }) });

test('provider calls require durable allowance; caches never create a second charge', async () => {
  const f = fixture(); let calls = 0;
  const options = { actor: 'synthetic', apiKey: 'synthetic-usage', ledger: f.ledger, fetchImpl: async (_, init) => {
    calls++; assert.equal(JSON.parse(init.body).service_tier, 'default');
    assert.ok((await f.ledger.snapshot()).current.reservedMicros > 0, 'reservation commits before sending');
    return completed();
  } };
  assert.equal((await generateChangeSummary(input, options)).available, true);
  await generateChangeSummary(input, options);
  assert.equal(calls, 1); assert.equal((await f.ledger.snapshot()).current.costMicros, 260);
  f.store.down = true;
  const blocked = await generateChangeSummary({ ...input, diff: 'new uncached diff' }, options);
  assert.equal(blocked.reason, 'accounting_unavailable'); assert.equal(calls, 1);
});

test('HTTP rejection refunds safely; missing usage and timeout never refund unknown spend', async () => {
  for (const [name, fetchImpl, uncertain] of [
    ['rejected', async () => ({ ok: false, status: 401 }), false],
    ['missing-usage', async () => completed({ usage: null }), true],
    ['timeout', async () => { throw new Error('Timeout'); }, true],
    ['server-error', async () => ({ ok: false, status: 500 }), true],
  ]) {
    const f = fixture();
    await generateChangeSummary(input, { actor: 'synthetic', apiKey: 'usage-' + name, ledger: f.ledger, fetchImpl });
    const usage = await f.ledger.snapshot();
    assert.equal(usage.current.costMicros, 0); assert.equal(usage.current.reservedMicros, 0);
    assert.equal(usage.current.uncertainMicros > 0, uncertain, name);
  }
});

test('a failed settlement retains the full durable reservation', async () => {
  const f = fixture();
  await generateChangeSummary(input, { actor: 'synthetic', apiKey: 'usage-settle-down', ledger: f.ledger,
    fetchImpl: async () => { f.store.loseWrites = true; return completed(); } });
  assert.ok((await f.ledger.snapshot()).current.reservedMicros > 260);
});

test('reservation write failure and contention exhaustion never reach the provider', async () => {
  for (const mode of ['write-failure', 'contention']) {
    const f = fixture(); let calls = 0;
    if (mode === 'write-failure') f.store.loseWrites = true;
    else f.store.swap = async () => false;
    const result = await generateChangeSummary(input, { actor: 'synthetic', apiKey: 'usage-' + mode, ledger: f.ledger,
      fetchImpl: async () => { calls++; return completed(); } });
    assert.equal(result.reason, 'accounting_unavailable'); assert.equal(calls, 0);
  }
});

test('member daily limits survive request pruning and unknown charges remain counted', async () => {
  const f = fixture(), first = await f.ledger.reserve(args('expired', 'one', 50000));
  f.state.members[Object.keys(f.state.members)[0]].requests = 200;
  f.tick(121000);
  assert.equal((await f.ledger.reserve(args('member-day', 'one'))).reason, 'rate_limit');
  assert.equal((await f.ledger.reserve(args('other-member', 'two'))).allowed, true);
  assert.equal(f.state.requests[first.id], undefined);
  assert.equal((await f.ledger.snapshot()).current.uncertainMicros, 50000);
  assert.equal(await f.ledger.settle(first.id, zero), false, 'a pruned unknown charge cannot be refunded blindly');
});

test('unexpected provider tier/model and invalid settlement amounts pause further calls', async () => {
  for (const [name, extra] of [['tier', { service_tier: 'priority' }], ['model', { model: 'unknown-model' }]]) {
    const f = fixture();
    await generateChangeSummary(input, { actor: 'synthetic', apiKey: 'usage-halt-' + name, ledger: f.ledger, fetchImpl: async () => completed(extra) });
    assert.equal((await f.ledger.snapshot()).halted, true);
    assert.equal((await f.ledger.reserve(args('after-' + name))).reason, 'accounting_halted');
  }
  const f = fixture(), first = await f.ledger.reserve(args('malformed'));
  await f.ledger.settle(first.id, { costMicros: -1 });
  const usage = await f.ledger.snapshot();
  assert.equal(usage.current.uncertainMicros, 1000); assert.equal(usage.halted, true);
});
