// Compressed transport for complete wiki snapshots. PostgreSQL keeps the
// canonical JSONB state so older deployments can still read and write it.
// The storage adapter must pair these bytes with the exact state version;
// it must use JSONB whenever an older writer has advanced that version.
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';

const compress = promisify(gzip);
const decompress = promisify(gunzip);

export async function encodeSnapshot(state) {
  const json = JSON.stringify(state);
  if (json === undefined) throw new TypeError('Snapshot must be JSON serializable');
  return (await compress(Buffer.from(json, 'utf8'))).toString('base64');
}

// Callers with a known size bound can supply maxOutputLength. Do not impose a
// new fixed wiki-size limit here: these are trusted database snapshots, and
// existing histories can legitimately be larger than an arbitrary cap.
// gunzip verifies the gzip integrity checksum before JSON is parsed.
export async function decodeSnapshot(data64, { maxOutputLength } = {}) {
  if (typeof data64 !== 'string' || !data64.trim()) throw new TypeError('Snapshot data is required');
  // PostgreSQL encode(bytea, 'base64') inserts line breaks; Buffer accepts them.
  const options = maxOutputLength === undefined ? {} : { maxOutputLength };
  const json = await decompress(Buffer.from(data64, 'base64'), options);
  return JSON.parse(json.toString('utf8'));
}
