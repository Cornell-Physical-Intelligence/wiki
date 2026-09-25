// Route-level failures: no real DB, Blob store, applicant, or email.
import assert from 'node:assert/strict';
import site from '../lib/recruit/modules/site.js';

const submit = site.routes.find(r => r.method === 'POST').handler;
const cycle = { id: 'cy-test', status: 'open', doc: { site: { sections: { round: {
  title: 'Upload test', open: true, notify: false, form: { questions: [
    { key: 'name', type: 'short', required: true }, { key: 'email', type: 'email', required: true },
    { key: 'photo', type: 'file' },
  ] },
} } } } };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const body = { answers: { name: 'Test', email: 'test@example.test' }, files: { photo: { name: 'test.png', type: 'image/png', data: png.toString('base64') } } };
async function run({ journalFails = false, dbFails = false, outcome = 'saved', website = '', completeFails = false } = {}) {
  const calls = [], records = new Map();
  const journal = {
    async append(entry, files) {
      calls.push('append');
      if (journalFails) throw new Error('Synthetic Blob outage');
      assert.deepEqual(files[0].data, png);
      records.set(entry.id, structuredClone(entry));
      return true;
    },
    async complete(id, result) { calls.push(result); if (completeFails) throw new Error('Synthetic completion outage'); assert.ok(records.has(id)); },
  };
  const kit = {
    now: () => 1790000000000,
    cycles: { intakeTarget: async () => ({ cycleId: cycle.id }), get: async () => cycle },
    intake: { journal: async () => journal },
    apps: { async commitIntake(_cycle, entry, _journal, files) {
      calls.push('commit');
      assert.deepEqual(files[0].data, png);
      assert.equal(entry.files[0].size, png.length);
      if (dbFails) throw new Error('Synthetic attachment write failure');
      return { outcome };
    } },
  };
  try { return { response: await submit({ params: { section: 'round' }, body: async () => ({ ...body, website }) }, kit), calls, records }; }
  catch (error) { return { error, calls, records }; }
}
for (const options of [{}, { journalFails: true }, { completeFails: true }]) {
  const { response } = await run(options);
  assert.equal(response.status, 200);
  assert.match(response.body.receipt, /^jr-\d{13}-[a-f0-9]{24}$/);
}
const queued = await run({ dbFails: true });
assert.equal(queued.response.status, 202);
assert.equal(queued.response.body.queued, true);
assert.ok(queued.records.has(queued.response.body.receipt), 'queued success has a durable backup');
assert.deepEqual(queued.calls, ['append', 'commit'], 'failed attachment writes stay pending for recovery');
assert.equal((await run({ dbFails: true, journalFails: true })).error.status, 503);
const superseded = await run({ outcome: 'superseded' });
assert.equal(superseded.error.status, 409);
assert.equal(superseded.error.code, 'SUBMISSION_SUPERSEDED');
assert.deepEqual(superseded.calls, ['append', 'commit', 'superseded']);
assert.equal((await run({ outcome: 'unknown' })).error.status, 503);
assert.equal((await run({ outcome: 'held' })).error.status, 409);
assert.equal((await run({ outcome: 'review' })).response.status, 409);
const honeypot = await run({ website: 'autofilled.example' });
assert.equal(honeypot.response.body.receipt, undefined, 'honeypot suppression never supplies a saved receipt');
assert.deepEqual(honeypot.calls, []);
console.log('PASS: durable receipts, attachment-write outages, complete-marker outages, superseded submissions, unknown outcomes, and honeypot responses');
