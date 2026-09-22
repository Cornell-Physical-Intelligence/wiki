// Exercise the existing admin diagnostic with fake services; no network or data writes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import applications from '../lib/recruit/modules/applications.js';

const route = applications.routes.find((r) => r.path === '/storage-check');

function services({ transactionFails = false, backupFails = false, journalFails = false, mode = 'postgres' } = {}) {
  const calls = [];
  const sql = Object.assign(async () => { throw new Error('Queries must use the transaction connection'); }, {
    async transaction(run) {
      calls.push('transaction');
      if (transactionFails) throw new Error('secret database connection details');
      return run(async (strings) => {
        const query = strings.join('');
        calls.push(query);
        assert.ok(['SET TRANSACTION READ ONLY', 'SELECT 1 AS ok'].includes(query), 'diagnostic must not mutate application data');
        return { rows: query.startsWith('SELECT') ? [{ ok: 1 }] : [] };
      });
    },
  });
  return { calls, kit: {
    mode,
    sql: async () => sql,
    intake: { async journal() {
      if (journalFails) throw new Error('secret journal connection details');
      return { async check() {
        calls.push('backup');
        if (backupFails) throw new Error('secret Blob connection details');
        return { ok: true };
      } };
    } },
  } };
}

test('storage diagnostic remains admin-only and verifies a read-only database transaction plus backup storage', async () => {
  assert.equal(route.method, 'POST');
  assert.equal(route.access, 'admin');
  const { kit, calls } = services();
  const result = await route.handler({}, kit);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, database: { ok: true, mode: 'postgres', transaction: true }, backup: { ok: true } });
  assert.deepEqual(calls, ['transaction', 'SET TRANSACTION READ ONLY', 'SELECT 1 AS ok', 'backup']);
});

test('transaction connection failure returns 503 while still checking backup storage', async () => {
  const { kit, calls } = services({ transactionFails: true });
  const result = await route.handler({}, kit);
  assert.equal(result.status, 503);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.database.ok, false);
  assert.equal(result.body.backup.ok, true);
  assert.match(result.body.error, /Database transactions/);
  assert.doesNotMatch(JSON.stringify(result.body), /secret/);
  assert.deepEqual(calls, ['transaction', 'backup']);
});

test('backup failure or unavailable journal returns 503 without concealing the successful database check', async () => {
  for (const option of ['backupFails', 'journalFails']) {
    const { kit } = services({ [option]: true });
    const result = await route.handler({}, kit);
    assert.equal(result.status, 503);
    assert.equal(result.body.database.ok, true);
    assert.equal(result.body.backup.ok, false);
    assert.match(result.body.error, /Private submission backup storage/);
    assert.doesNotMatch(JSON.stringify(result.body), /secret/);
  }
});

test('local memory mode does not claim a Postgres transaction was verified', async () => {
  const { kit, calls } = services({ mode: 'memory' });
  const result = await route.handler({}, kit);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.database, { ok: true, mode: 'memory', transaction: false });
  assert.deepEqual(calls, ['backup']);
});
