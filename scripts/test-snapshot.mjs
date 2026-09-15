// Synthetic storage snapshots only. No production data, database or network.
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { encodeSnapshot, decodeSnapshot } from '../lib/snapshot.js';

const body = '# Contact replay 🦀\n\nCafé — 校准\n\n'
  + '- [ ] Replay the recorded contact sequence.\n'.repeat(90)
  + '!file[CAD assembly](att:att-synthetic)\n';
const state = {
  users: [{ email: 'member@example.test', status: 'active', role: 'admin' }],
  pages: [{
    id: 'contact-replay', title: 'Contact replay', body, updated: 80,
    revs: Array.from({ length: 80 }, (_, n) => ({
      ts: n + 1, by: 'member@example.test', summary: 'Edited', body: body + `\nTrial ${n}\n`,
    })),
  }],
  trash: [{ id: 'old-page', body: 'Archived text', revs: [{ ts: 1, body: 'Original text' }] }],
  activity: [{ ts: 80, kind: 'edit', by: 'member@example.test', pageId: 'contact-replay' }],
  prefs: { 'member@example.test': { recents: ['contact-replay'], bookmarks: [] } },
  settings: { email: { key: 'synthetic-only', oauth: { refresh: 'synthetic-only' } } },
};
const before = structuredClone(state);
const encoded = await encodeSnapshot(state);
const decoded = await decodeSnapshot(encoded);
assert.deepEqual(decoded, state, 'pages, complete history, trash, preferences and server settings survive');
assert.deepEqual(state, before, 'encoding does not mutate the state being written');
decoded.pages[0].revs[0].body = 'Changed independently';
assert.deepEqual(await decodeSnapshot(encoded), state, 'each decode produces independent mutable state');

const wrapped = encoded.match(/.{1,76}/g).join('\n');
assert.deepEqual(await decodeSnapshot(wrapped), state, 'PostgreSQL base64 line breaks decode correctly');
assert.deepEqual(await decodeSnapshot(await encodeSnapshot({ pages: [], trash: [], users: [] })), {
  pages: [], trash: [], users: [],
}, 'empty collections survive');

const rawBytes = Buffer.byteLength(JSON.stringify(state));
const wireBytes = Buffer.byteLength(encoded);
assert.ok(wireBytes < rawBytes * 0.2, 'history-heavy snapshots cut database transfer by at least 80%, including base64 overhead');
assert.deepEqual(await decodeSnapshot(encoded, { maxOutputLength: rawBytes }), state, 'an exact optional output bound is supported');
await assert.rejects(decodeSnapshot(encoded, { maxOutputLength: rawBytes - 1 }), 'a configured output bound is enforced');

const corrupt = Buffer.from(encoded, 'base64');
corrupt[corrupt.length - 8] ^= 1; // Corrupt the gzip integrity checksum.
await assert.rejects(decodeSnapshot(corrupt.toString('base64')), 'corrupt data cannot silently become wiki state');
await assert.rejects(decodeSnapshot(Buffer.from(encoded, 'base64').subarray(0, 20).toString('base64')), 'truncated snapshots fail');
await assert.rejects(decodeSnapshot(gzipSync('not JSON').toString('base64')), 'invalid JSON fails');
await assert.rejects(decodeSnapshot(''), 'missing data fails');
await assert.rejects(encodeSnapshot(undefined), 'non-JSON input fails');

console.log(`Snapshot tests passed: synthetic history ${rawBytes.toLocaleString()} → ${wireBytes.toLocaleString()} bytes (${(100 * (1 - wireBytes / rawBytes)).toFixed(1)}% less database transfer).`);
