#!/usr/bin/env node
// Manual rollback helper: copies one recruit cycle's applications back into
// the legacy interest_submissions table so a reverted deploy still shows
// them. Copy-only (ON CONFLICT (email) DO NOTHING); recruit_* tables are
// never touched. Emails that already exist in the legacy table are reported,
// not overwritten.
//
//   POSTGRES_URL=... node scripts/recruit-rollback.mjs --cycle cy-abc123 [--dry-run]

import { backupCycle } from './recruit-backup.mjs';
import { pathToFileURL } from 'node:url';

const num = (v) => (v == null ? null : Number(v));
const asArray = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? (() => { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } })() : []);
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : typeof v === 'string' ? (() => { try { const p = JSON.parse(v); return p && typeof p === 'object' ? p : {}; } catch { return {}; } })() : {});

// rollbackCycle(sql, cycleId, { dryRun }) → { cycleId, total, placed, unplaced:[{ id, email }] }
export async function rollbackCycle(sql, cycleId, { dryRun = false } = {}) {
  if (!/^cy-[a-z0-9-]+$/.test(String(cycleId || ''))) throw new Error('Pass a cycle id like cy-abc123');
  await sql`CREATE TABLE IF NOT EXISTS interest_submissions (
      id text PRIMARY KEY, ts bigint NOT NULL, updated bigint NOT NULL,
      name text NOT NULL, email text UNIQUE NOT NULL,
      subteam text NOT NULL DEFAULT '', project text NOT NULL DEFAULT '',
      cornell boolean NOT NULL DEFAULT false,
      file_id text, file_name text, file_type text, file_size int,
      ip_hash text NOT NULL DEFAULT '')`;
  await sql`ALTER TABLE interest_submissions ADD COLUMN IF NOT EXISTS year text`;
  await sql`ALTER TABLE interest_submissions ADD COLUMN IF NOT EXISTS review jsonb NOT NULL DEFAULT '{}'::jsonb`;
  await sql`ALTER TABLE interest_submissions ADD COLUMN IF NOT EXISTS review_version bigint NOT NULL DEFAULT 0`;
  const rows = (await sql`SELECT * FROM recruit_applications WHERE cycle_id = ${cycleId} AND erased_at IS NULL ORDER BY ts`).rows;
  const people = new Map((await sql`SELECT email, review, review_version FROM recruit_people WHERE cycle_id = ${cycleId}`).rows.map((p) => [p.email, p]));
  const out = { cycleId, total: rows.length, placed: 0, unplaced: [], dryRun };
  for (const r of rows) {
    const files = asArray(r.files);
    const f = files[0] || null;
    const answers = asObject(r.answers);
    if (dryRun) continue;
    const w = await sql`INSERT INTO interest_submissions (id, ts, updated, name, email, subteam, project, cornell, file_id, file_name, file_type, file_size, ip_hash, year, review, review_version)
      VALUES (${r.id}, ${num(r.ts)}, ${num(r.updated)}, ${r.name}, ${r.email}, ${r.subteam || ''}, ${String(answers.project ?? '')}, ${Boolean(r.cornell)},
        ${f?.id || null}, ${f?.name || null}, ${f?.type || null}, ${f?.size == null ? null : Number(f.size)}, ${r.ip_hash || ''}, ${r.year || null},
        ${JSON.stringify(asObject(people.get(r.email)?.review || r.review))}::jsonb, ${num(people.get(r.email)?.review_version ?? r.review_version) || 0})
      ON CONFLICT (email) DO NOTHING RETURNING id`;
    if (w.rows.length) out.placed++; else out.unplaced.push({ id: r.id, email: r.email });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--cycle');
  const cycleId = at >= 0 ? args[at + 1] : null;
  const dryRun = args.includes('--dry-run');
  const backupAt = args.indexOf('--backup');
  const backupPath = backupAt >= 0 ? args[backupAt + 1] : null;
  if (!dryRun && !backupPath) throw new Error('Legacy rollback cannot represent all form answers or files. Pass --backup /path/to/new-cycle-backup.json first.');
  const conn = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!cycleId || !conn) {
    console.error('Usage: POSTGRES_URL=... node scripts/recruit-rollback.mjs --cycle cy-abc123 [--dry-run]');
    process.exit(2);
  }
  const { createPool } = await import('@vercel/postgres');
  const pool = createPool({ connectionString: conn });
  const sql = (strings, ...values) => pool.sql(strings, ...values);
  sql.transaction = async (run) => { const c = await pool.connect(); try { await c.query('BEGIN'); const out = await run((strings, ...values) => c.sql(strings, ...values)); await c.query('COMMIT'); return out; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } };
  if (backupPath) { const saved = await backupCycle(sql, cycleId, backupPath); console.log(`Complete cycle backup saved to ${saved.path}.`); }
  const out = await rollbackCycle(sql, cycleId, { dryRun });
  console.log(`${dryRun ? 'Would copy' : 'Copied'} ${dryRun ? out.total : out.placed} of ${out.total} applications from ${cycleId} into interest_submissions.`);
  for (const u of out.unplaced) console.log(`  not placed (email already on the legacy list): ${u.id} ${u.email}`);
  await pool.end?.();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
