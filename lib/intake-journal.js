// Independent, private intake storage. Records and attachments are immutable;
// completion markers suppress replay without deleting the recovery originals.
import { randomBytes } from 'node:crypto';

const PREFIX = 'interest-intake/v1/';
const DAY = 86400000;
const validReceipt = (id) => /^jr-\d{13}-[a-f0-9]{24}$/.test(String(id));
const dateOf = (ts) => new Date(ts).toISOString().slice(0, 10);
const options = { access: 'private', addRandomSuffix: false, contentType: 'application/json' };

export function newIntakeReceipt(now = Date.now()) {
  return `jr-${now}-${randomBytes(12).toString('hex')}`;
}

export function createIntakeJournal({
  enabled = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID),
  loadBlob = () => import('@vercel/blob'),
} = {}) {
  async function blobs(prefix) {
    const sdk = await loadBlob();
    const items = [];
    let cursor;
    do {
      const page = await sdk.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      items.push(...page.blobs);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return items;
  }
  async function readJson(path) {
    const sdk = await loadBlob();
    const result = await sdk.get(path, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) throw new Error('Saved intake could not be read');
    return JSON.parse(await new Response(result.stream).text());
  }
  return {
    enabled,
    async check() {
      if (!enabled()) throw new Error('Private intake storage is not configured');
      const sdk = await loadBlob();
      const id = randomBytes(16).toString('hex');
      const path = `diagnostics/intake-storage-${Date.now()}-${id}.json`;
      const payload = JSON.stringify({ probe: id });
      try {
        await sdk.put(path, payload, { ...options, allowOverwrite: false });
        const result = await sdk.get(path, { access: 'private', useCache: false });
        if (!result || result.statusCode !== 200 || !result.stream || await new Response(result.stream).text() !== payload) {
          throw new Error('The private storage check did not return the bytes written');
        }
        return { ok: true };
      } finally {
        // Delete only this generated diagnostic. Recovery records/attachments
        // are outside this namespace and never touched by a storage check.
        try { await sdk.del(path); } catch (e) { /* harmless diagnostic may remain after an outage */ }
      }
    },
    async append(entry, file) {
      if (!enabled()) return false;
      // These screens still operate when Neon is down. Paths contain only a
      // salted network hash, timestamp, and random receipt; never an email.
      const recent = (await Promise.all([dateOf(entry.ts), dateOf(entry.ts - DAY)]
        .map((day) => blobs(`${PREFIX}records/${day}/`)))).flat();
      const day = recent.filter((b) => Number(/jr-(\d{13})-/.exec(b.pathname)?.[1]) > entry.ts - DAY);
      const hour = day.filter((b) => b.pathname.includes(`/${entry.ipHash}/`) && Number(/jr-(\d{13})-/.exec(b.pathname)?.[1]) > entry.ts - 3600000);
      if (day.length >= 300 || hour.length >= 5) {
        throw Object.assign(new Error('Too many submissions. Try again later or email cuphysint@cornell.edu.'), { status: 429 });
      }
      const sdk = await loadBlob();
      if (file) {
        await sdk.put(`${PREFIX}files/${entry.id}`, file.data, { ...options, contentType: file.type, allowOverwrite: false });
      }
      const pathname = `${PREFIX}records/${dateOf(entry.ts)}/${entry.ipHash}/${entry.id}.json`;
      await sdk.put(pathname, JSON.stringify(entry), { ...options, allowOverwrite: false });
      return true;
    },
    async listPending() {
      if (!enabled()) return [];
      const [records, done] = await Promise.all([blobs(`${PREFIX}records/`), blobs(`${PREFIX}done/`)]);
      const completed = new Set(done.map((b) => b.pathname.split('/').pop().replace(/\.json$/, '')));
      const pending = records.filter((b) => !completed.has(b.pathname.split('/').pop().replace(/\.json$/, '')));
      const entries = [];
      // Read small metadata records sequentially; attachment bodies stay out of
      // listing responses and are fetched only when replay or an admin needs one.
      for (const blob of pending) entries.push(await readJson(blob.pathname));
      return entries.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    },
    async getEntry(id) {
      if (!validReceipt(id)) return null;
      const day = dateOf(Number(id.split('-')[1]));
      const record = (await blobs(`${PREFIX}records/${day}/`)).find((b) => b.pathname.endsWith(`/${id}.json`));
      return record ? readJson(record.pathname) : null;
    },
    async getFile(id) {
      if (!validReceipt(id)) return null;
      const sdk = await loadBlob();
      const result = await sdk.get(`${PREFIX}files/${id}`, { access: 'private', useCache: false });
      if (!result || result.statusCode !== 200 || !result.stream) return null;
      return Buffer.from(await new Response(result.stream).arrayBuffer());
    },
    async complete(id, outcome) {
      if (!enabled() || !validReceipt(id)) return;
      const sdk = await loadBlob();
      await sdk.put(`${PREFIX}done/${id}.json`, JSON.stringify({ id, outcome, completedAt: Date.now() }), {
        ...options, allowOverwrite: true,
      });
    },
  };
}

export const intakeJournal = createIntakeJournal();
