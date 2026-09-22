// Synthetic Postgres: lib/db.js is replaced by a stub whose tagged-template
// runner dispatches on statement text (and throws on anything unexpected).
// Asserts the single-statement shapes the design depends on. No network, no keys.
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// The §4.1 seam edits (same as test-recruit-core.mjs); a no-op once integrated.
function patchInterest(source) {
  if (source.includes('ctx.intake')) return source;
  const edit = (from, to) => { if (!source.includes(from)) throw new Error('interest.js anchor missing: ' + from.slice(0, 60)); source = source.replace(from, to); };
  edit("const MAX_FILE = 2.5 * 1024 * 1024;\n", "const MAX_FILE = 2.5 * 1024 * 1024;\nexport const INTAKE_VOCAB = { SUBTEAMS, YEARS, FILE_TYPES, MAX_FILE };\nexport { cors, rowFromPg, replayIntake };\n");
  edit("async function replayIntake(journal) {", "async function replayIntake(journal, ctx = null) {");
  edit("      const result = await commitIntake(entry, journal);\n      if (result.outcome === 'review' || result.outcome === 'held') pendingReview.push(",
    "      const result = entry.cycleId && ctx?.intake ? await ctx.intake.commit(entry, journal, null, { cycleId: entry.cycleId }) : await commitIntake(entry, journal);\n      if (result.outcome === 'review' || result.outcome === 'held') pendingReview.push(");
  edit("    const journal = ctx.journal || intakeJournal;\n    const entry = {",
    "    let target = null;\n    try { target = ctx.intake ? await ctx.intake.target() : null; } catch (e) { target = null; }\n    const journal = ctx.journal || intakeJournal;\n    const entry = {");
  edit("      fileName: file?.name || null, fileType: file?.type || null, fileSize: file?.data.length || null,\n    };",
    "      fileName: file?.name || null, fileType: file?.type || null, fileSize: file?.data.length || null,\n      cycleId: target?.cycleId || null,\n    };");
  edit("    try { journaled = await journal.append(entry, file); }", "    try { journaled = await journal.append(entry, file, { perDay: target?.perDay ?? 300, perIpHour: target?.perIpHour ?? 5 }); }");
  edit("      if (counts.hourSameIp >= 5) return", "      if (counts.hourSameIp >= (target?.perIpHour ?? 5)) return");
  edit("      if (counts.day >= 300) return", "      if (counts.day >= (target?.perDay ?? 300)) return");
  edit("      const existing = await findByEmail(email);\n",
    "      let existing;\n      try { existing = target ? await ctx.intake.find(target, email) : await findByEmail(email); }\n      catch (e) { target = null; existing = await findByEmail(email); }\n");
  edit("      if (!existing && await countStored() >= 1000) return await reject(",
    "      let full = false;\n      if (!existing) {\n        try { full = target ? await ctx.intake.count(target) >= (target.capacity || Infinity) : await countStored() >= 1000; }\n        catch (e) { target = null; full = await countStored() >= 1000; }\n      }\n      if (full) return await reject(");
  edit("      const result = await commitIntake(entry, journal, file);\n",
    "      let result;\n      try { result = target ? await ctx.intake.commit(entry, journal, file, target) : await commitIntake(entry, journal, file); }\n      catch (e) { if (!target) throw e; target = null; result = await commitIntake(entry, journal, file); }\n");
  edit("      if (result.outcome === 'saved' && !result.existing) {", "      if (result.outcome === 'saved' && !result.existing && !(target && result.notify === false)) {");
  edit("  const journal = ctx.journal || intakeJournal;\n  if (path === '/interest/storage-check'",
    "  const journal = ctx.journal || intakeJournal;\n  let recruit = false;\n  try { recruit = Boolean(ctx.intake && await ctx.intake.migrated()); } catch (e) { recruit = false; }\n  if (path === '/interest/storage-check'");
  edit("    const queue = await replayIntake(journal);\n    return json(res, 200, { rows: await listRows(), ...queue });",
    "    const queue = await replayIntake(journal, ctx);\n    if (recruit) { const legacy = await ctx.intake.listLegacy(); return json(res, 200, { rows: legacy.rows, truncated: legacy.truncated, ...queue }); }\n    return json(res, 200, { rows: await listRows(), ...queue });");
  edit("    return sendCsv(res, await listRows(), `cupi-interest-", "    return sendCsv(res, recruit ? (await ctx.intake.listLegacy()).rows : await listRows(), `cupi-interest-");
  edit("  if (path === '/interest/archive' && req.method === 'POST') {\n",
    "  if (path === '/interest/archive' && req.method === 'POST') {\n    if (recruit) return json(res, 409, { error: 'Applications are managed per cycle now. Open Applications in the wiki.', code: 'RECRUIT_ACTIVE' });\n");
  edit("  if (archiveOne && req.method === 'DELETE') {\n",
    "  if (archiveOne && req.method === 'DELETE') {\n    if (recruit) return json(res, 409, { error: 'Applications are managed per cycle now. Open Applications in the wiki.', code: 'RECRUIT_ACTIVE' });\n");
  edit("    const result = await updateReview(commentDeleteMatch[1], { deleteComment: commentDeleteMatch[2] });",
    "    const result = recruit ? (await ctx.intake.has(commentDeleteMatch[1]) ? await ctx.intake.review(commentDeleteMatch[1], { deleteComment: commentDeleteMatch[2] }) : { status: 404, error: 'This submission is no longer on the live list' }) : await updateReview(commentDeleteMatch[1], { deleteComment: commentDeleteMatch[2] });");
  edit("    const result = await updateReview(reviewMatch[1], mutation);",
    "    const result = recruit ? (await ctx.intake.has(reviewMatch[1]) ? await ctx.intake.review(reviewMatch[1], mutation) : { status: 404, error: 'This submission is no longer on the live list' }) : await updateReview(reviewMatch[1], mutation);");
  edit("    const removed = await removeRow(rowMatch[1]);\n    if (!removed) return json(res, 404, { error: 'No such submission' });\n    if (removed.fileId) {",
    "    const viaRecruit = recruit && await ctx.intake.has(rowMatch[1]);\n    const removed = viaRecruit ? await ctx.intake.remove(rowMatch[1], me.email) : recruit ? null : await removeRow(rowMatch[1]);\n    if (!removed) return json(res, 404, { error: 'No such submission' });\n    if (removed.fileId && !viaRecruit) {");
  return source;
}

if (!process.env.RECRUIT_PG_TEST_ROOT) {
  const dir = await mkdtemp(join(tmpdir(), 'cupi-recruit-pg-'));
  try {
    await cp(new URL('../lib', import.meta.url), join(dir, 'lib'), { recursive: true });
    await cp(new URL('./recruit-rollback.mjs', import.meta.url), join(dir, 'recruit-rollback.mjs'));
    await cp(new URL('./recruit-backup.mjs', import.meta.url), join(dir, 'recruit-backup.mjs'));
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await writeFile(join(dir, 'lib/interest.js'), patchInterest(await readFile(join(dir, 'lib/interest.js'), 'utf8')));
    await writeFile(join(dir, 'lib/db.js'), `
      export const storageMode = () => 'postgres';
      export const rawSql = async () => globalThis.recruitDb.sql;
      export const putFile = async () => { throw new Error('Unexpected file writer'); };
      export const getFile = async (id) => globalThis.recruitDb.files.get(id) || null;
      export const deleteFile = async (id) => globalThis.recruitDb.files.delete(id);
    `);
    const out = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, RECRUIT_PG_TEST_ROOT: dir, SESSION_SECRET: 'synthetic' }, stdio: 'inherit',
    });
    process.exitCode = out.status || (out.error ? 1 : 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
} else {
  globalThis.fetch = async () => { throw new Error('Network disabled in recruit tests'); };
  const root = process.env.RECRUIT_PG_TEST_ROOT;
  const lib = (p) => import(pathToFileURL(join(root, 'lib', p)));
  let clock = 1789700000000;
  Date.now = () => clock;

  /* ------------------------------ the fake ------------------------------ */

  const numbered = (strings) => strings.map((s, i) => (i < strings.length - 1 ? s + '$' + (i + 1) : s)).join('').replace(/\s+/g, ' ').trim();
  // Parse "a, b, c" at the top level (commas inside parentheses/quotes stay).
  function splitTop(text) {
    const out = []; let depth = 0, quote = false, cur = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "'" ) { quote = !quote; cur += ch; continue; }
      if (!quote) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
      }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  function literal(token, v) {
    const t = token.trim();
    const cast = /::(\w+)/.exec(t)?.[1];
    const bare = t.replace(/::[\w\[\]]+$/, '');
    let value;
    if (/^\$\d+$/.test(bare)) value = v[Number(bare.slice(1)) - 1];
    else if (/^'.*'$/s.test(bare)) value = bare.slice(1, -1).replace(/''/g, "'");
    else if (/^-?\d+$/.test(bare)) value = Number(bare);
    else if (bare === 'NULL') value = null;
    else if (bare === 'true' || bare === 'false') value = bare === 'true';
    else throw new Error('Unparsed literal: ' + t);
    if (cast === 'jsonb' && typeof value === 'string') return JSON.parse(value);
    return value;
  }
  const clone = (x) => structuredClone(x);
  const isObject = (x) => Boolean(x && typeof x === 'object' && !Array.isArray(x));

  const db = globalThis.recruitDb = {
    trace: [], schema: [], failTarget: false, files: new Map(),
    settings: null, cycles: [], applications: [], applicants: [], receipts: new Map(), audit: [], requests: [], roles: [],
    interest_submissions: [], interest_archives: [], interest_events: [], legacyTables: true,
    async sql(strings, ...v) {
      assert.ok(Array.isArray(strings) && 'raw' in strings, 'every statement arrives as a tagged template (raw present)');
      const text = numbered(strings);
      db.trace.push(text);
      const result = (rows = [], rowCount = rows.length) => ({ rows: clone(rows), rowCount });
      const m = (re) => re.exec(text);

      /* schema */
      if (/^CREATE TABLE IF NOT EXISTS/.test(text)) { db.schema.push(text); return result(); }
      if (/^(CREATE (UNIQUE )?INDEX|ALTER TABLE)/.test(text)) return result();
      if (/^INSERT INTO recruit_settings \(id, version, doc\) VALUES \(1, 1, '(.*)'::jsonb\) ON CONFLICT DO NOTHING$/.test(text)) {
        const doc = JSON.parse(/VALUES \(1, 1, '(.*)'::jsonb\)/.exec(text)[1].replace(/''/g, "'"));
        if (!db.settings) db.settings = { version: 1, doc };
        return result();
      }

      /* settings */
      if (text.startsWith("SELECT s.doc->'migration' AS migration, s.doc->>'intakeCycleId' AS intake_cycle_id")) {
        if (db.failTarget) throw new Error('Synthetic recruit outage');
        assert.match(text, /FROM recruit_settings s LEFT JOIN recruit_cycles c ON c\.id = s\.doc->>'intakeCycleId' AND c\.status = 'open' WHERE s\.id = 1/);
        if (!db.settings) return result([]);
        const c = db.cycles.find((x) => x.id === db.settings.doc.intakeCycleId && x.status === 'open');
        return result([{ migration: db.settings.doc.migration ?? null, intake_cycle_id: db.settings.doc.intakeCycleId ?? null, id: c?.id ?? null, form_version: c?.form_version ?? null, status: c?.status ?? null, intake: c?.doc?.intake ?? null, capacity: c?.doc?.capacity ?? null }]);
      }
      if (text === 'SELECT version, doc FROM recruit_settings WHERE id = 1') return result(db.settings ? [{ version: String(db.settings.version), doc: db.settings.doc }] : []);
      if (m(/^UPDATE recruit_settings SET doc = doc \|\| jsonb_build_object\('intakeCycleId', \$1::text\), version = version \+ 1 WHERE id = 1 AND doc->>'intakeCycleId' IS NULL$/)) {
        if (db.settings.doc.intakeCycleId == null) { db.settings.doc.intakeCycleId = v[0]; db.settings.version++; return result([], 1); }
        return result([], 0);
      }
      if (m(/^UPDATE recruit_settings SET doc = doc \|\| jsonb_build_object\('intakeCycleId', \$1::text\), version = version \+ 1 WHERE id = 1 AND version = \$2 AND EXISTS \(SELECT 1 FROM recruit_cycles WHERE id = \$3 AND status = 'open'\) RETURNING version, doc$/)) {
        db.pointerCas = text;
        if (db.settings.version !== v[1] || !db.cycles.some((c) => c.id === v[2] && c.status === 'open')) return result([]);
        db.settings.doc.intakeCycleId = v[0]; db.settings.version++;
        return result([{ version: String(db.settings.version), doc: db.settings.doc }]);
      }
      if (m(/^UPDATE recruit_settings SET doc = CASE WHEN doc->>'intakeCycleId' = \$1 THEN doc - 'intakeCycleId' ELSE doc END, version = version \+ 1 WHERE id = 1 AND version = \$2 RETURNING version, doc$/)) {
        if (db.settings.version !== v[1]) return result([]);
        if (db.settings.doc.intakeCycleId === v[0]) delete db.settings.doc.intakeCycleId;
        db.settings.version++;
        return result([{ version: String(db.settings.version), doc: db.settings.doc }]);
      }
      if (m(/^UPDATE recruit_settings SET doc = doc - 'intakeCycleId', version = version \+ 1 WHERE id = 1 AND doc->>'intakeCycleId' = \$1$/)) {
        if (db.settings.doc.intakeCycleId === v[0]) { delete db.settings.doc.intakeCycleId; db.settings.version++; return result([], 1); }
        return result([], 0);
      }
      if (m(/^UPDATE recruit_settings SET doc = jsonb_set\(doc, '\{migration\}', \$1::jsonb\), version = version \+ 1 WHERE id = 1 AND doc->>'migration' IS NULL$/)) {
        if (db.settings.doc.migration == null) { db.settings.doc.migration = JSON.parse(v[0]); db.settings.version++; return result([], 1); }
        return result([], 0);
      }
      if (m(/^UPDATE recruit_settings SET doc = jsonb_set\(doc, '\{migration\}', \(doc->'migration'\) \|\| jsonb_build_object\('archives', COALESCE\(doc->'migration'->'archives', '\{\}'::jsonb\) \|\| \$1::jsonb, 'duplicates', \$2::int\)\), version = version \+ 1 WHERE id = 1 AND doc->>'migration' IS NOT NULL$/)) {
        if (db.settings.doc.migration == null) return result([], 0);
        db.settings.doc.migration = { ...db.settings.doc.migration, archives: { ...(db.settings.doc.migration.archives || {}), ...JSON.parse(v[0]) }, duplicates: v[1] };
        db.settings.version++;
        return result([], 1);
      }
      if (m(/^UPDATE recruit_settings SET doc = jsonb_set\(doc, '\{migration,completedAt\}', \$1::jsonb\), version = version \+ 1 WHERE id = 1 AND doc->>'migration' IS NOT NULL AND doc->'migration'->>'completedAt' IS NULL$/)) {
        if (db.settings.doc.migration && db.settings.doc.migration.completedAt == null) { db.settings.doc.migration.completedAt = JSON.parse(v[0]); db.settings.version++; return result([], 1); }
        return result([], 0);
      }

      /* cycles */
      if (m(/^SELECT \* FROM recruit_cycles WHERE id = \$1$/)) return result(db.cycles.filter((c) => c.id === v[0]));
      if (text.startsWith('SELECT * FROM recruit_cycles WHERE true')) {
        let rows = [...db.cycles];
        if (text.includes("AND status <> 'archived'")) rows = rows.filter((c) => c.status !== 'archived');
        const any = /AND id = ANY\(\$(\d+)\)/.exec(text);
        if (any) rows = rows.filter((c) => v[Number(any[1]) - 1].includes(c.id));
        return result(rows.sort((a, b) => b.updated - a.updated));
      }
      const insCycle = m(/^INSERT INTO recruit_cycles \(([^)]*)\) VALUES \((.*)\) ON CONFLICT \(id\) DO NOTHING( RETURNING \*)?$/);
      if (insCycle) {
        const cols = insCycle[1].split(',').map((s) => s.trim());
        const vals = splitTop(insCycle[2]).map((t) => literal(t, v));
        const row = { version: 1, opens_at: null, closes_at: null, closed_at: null, form_version: 0, legacy: null, term: '' };
        cols.forEach((c, i) => { row[c] = vals[i]; });
        if (db.cycles.some((c) => c.id === row.id) || (row.legacy?.archiveId && db.cycles.some((c) => c.legacy?.archiveId === row.legacy.archiveId))) return result([]);
        db.cycles.push(row);
        return result(insCycle[3] ? [row] : []);
      }
      const updCycle = m(/^UPDATE recruit_cycles SET (.*) WHERE id = \$(\d+) AND version = \$(\d+) RETURNING \*$/);
      if (updCycle) {
        const row = db.cycles.find((c) => c.id === v[Number(updCycle[2]) - 1] && Number(c.version) === v[Number(updCycle[3]) - 1]);
        if (!row) return result([]);
        for (const part of splitTop(updCycle[1])) {
          const [col, expr] = part.split(/ = (.*)/s);
          if (col === 'version') row.version = Number(row.version) + 1;
          else if (expr.startsWith('doc || ')) row.doc = { ...row.doc, ...literal(expr.slice(7), v) };
          else if (expr.startsWith('jsonb_set(doc, ')) { const [pathTok, valTok] = splitTop(expr.slice('jsonb_set(doc, '.length, -1)); const key = literal(pathTok.replace('::text[]', ''), v).replace(/[{}]/g, ''); row.doc = { ...row.doc, [key]: literal(valTok, v) }; }
          else row[col] = literal(expr, v);
        }
        return result([row]);
      }
      if (m(/^DELETE FROM recruit_cycles WHERE id = \$1$/)) { db.cycles = db.cycles.filter((c) => c.id !== v[0]); return result(); }
      if (m(/^SELECT cycle_id, stage, section, count\(\*\)::int AS n FROM recruit_applications WHERE true( AND cycle_id = ANY\(\$1\))? GROUP BY cycle_id, stage, section$/)) {
        const counts = new Map();
        for (const a of db.applications) if (!v[0] || v[0].includes(a.cycle_id)) { const k = a.cycle_id + '|' + a.stage + '|' + (a.section || 'interest'); counts.set(k, (counts.get(k) || 0) + 1); }
        return result([...counts].map(([k, n]) => ({ cycle_id: k.split('|')[0], stage: k.split('|')[1], section: k.split('|')[2], n })));
      }

      /* legacy tables */
      if (text.startsWith("SELECT to_regclass('public.interest_submissions') AS live")) return result([{ live: db.legacyTables ? 'interest_submissions' : null, archives: db.legacyTables ? 'interest_archives' : null }]);
      if (text.startsWith('SELECT count(*) AS n, count(*) FILTER')) {
        return result([{ n: String(db.interest_submissions.length), orphans: String(db.interest_submissions.filter((s) => !db.applications.some((a) => a.id === s.id)).length) }]);
      }
      if (text === 'SELECT id, ts, name, count FROM interest_archives ORDER BY ts DESC') return result([...db.interest_archives].sort((a, b) => b.ts - a.ts).map(({ rows, ...meta }) => meta));
      if (m(/^SELECT id, ts, name, count FROM interest_archives WHERE id = \$1$/)) return result(db.interest_archives.filter((a) => a.id === v[0]).map(({ rows, ...meta }) => meta));
      const legacyToApp = (r, cycleId, source) => ({
        id: r.id, cycle_id: cycleId, email: String(r.email).toLowerCase(), ts: r.ts, updated: r.updated ?? r.ts, name: r.name ?? '', cornell: Boolean(r.cornell), subteam: r.subteam ?? '', year: r.year ?? null, source, form_version: 0,
        answers: { project: r.project ?? '' }, files: (r.file_id ?? r.fileId) ? [{ id: r.file_id ?? r.fileId, question: 'file', name: r.file_name ?? r.fileName, type: r.file_type ?? r.fileType, size: r.file_size ?? r.fileSize }] : [],
        stage: 'applied', stage_at: r.ts, stage_history: [{ stage: 'applied', at: r.ts, by: 'migration' }], outcome: null, decision: {}, tags: [], review: r.review ?? {}, review_version: r.review_version ?? r.reviewVersion ?? 0, edit_version: 0, ip_hash: r.ip_hash ?? '', onboarded_at: null, erased_at: null, receipt_id: null,
      });
      const copyIn = (rows, cycleId, source) => { let n = 0; for (const r of rows) { const app = legacyToApp(r, cycleId, source); if (db.applications.some((a) => a.id === app.id)) continue; if (db.applications.some((a) => a.cycle_id === cycleId && a.email === app.email)) throw new Error('duplicate key (cycle_id, email)'); db.applications.push(app); n++; } return n; };
      if (text.startsWith('INSERT INTO recruit_applications (id, cycle_id, email, ts, updated, name, cornell, subteam, year, source, form_version, answers, files, stage, stage_at, stage_history, review, review_version, ip_hash) SELECT')) {
        db.migrationInsert = text;
        if (text.includes('FROM interest_submissions ON CONFLICT (id) DO NOTHING')) { copyIn(db.interest_submissions, v[0], 'migrated'); return result(); }
        if (text.includes('jsonb_to_recordset(a.rows)')) {
          assert.match(text, /ON CONFLICT \(id\) DO NOTHING$/);
          const a = db.interest_archives.find((x) => x.id === v[1]);
          const seen = new Set(); const rows = [];
          for (const r of [...(a?.rows || [])].sort((x, y) => x.ts - y.ts)) { const e = String(r.email).toLowerCase(); if (seen.has(e)) continue; seen.add(e); rows.push(r); }
          copyIn(rows, v[0], 'migrated');
          return result();
        }
        if (text.includes("'orphan'")) {
          assert.match(text, /ON CONFLICT DO NOTHING RETURNING id$/);
          const rows = db.interest_submissions.filter((s) => !db.applications.some((a) => a.id === s.id) && !db.applications.some((a) => a.cycle_id === v[0] && a.email === String(s.email).toLowerCase()));
          const n = copyIn(rows, v[0], 'orphan');
          return result(rows.slice(0, n).map((r) => ({ id: r.id })));
        }
      }
      if (text.startsWith('INSERT INTO recruit_applicants (email, name, cornell, first_seen, last_seen, applications) SELECT email')) {
        for (const email of new Set(db.applications.filter((a) => a.cycle_id === v[0]).map((a) => a.email))) {
          const apps = db.applications.filter((a) => a.email === email).sort((x, y) => y.updated - x.updated);
          const prior = db.applicants.find((p) => p.email === email);
          const next = { email, name: apps[0].name, cornell: apps.some((a) => a.cornell), first_seen: Math.min(...apps.map((a) => a.ts)), last_seen: Math.max(...apps.map((a) => a.updated)), applications: apps.length, erased_at: null, doc: {} };
          if (prior) Object.assign(prior, next); else db.applicants.push(next);
        }
        return result();
      }

      if (text === 'SELECT doc FROM recruit_cycles WHERE id = $1 FOR UPDATE') return result(db.cycles.filter((c) => c.id === v[0]).map((c) => ({ doc: c.doc })));
      if (text === 'SELECT email, review, review_version FROM recruit_people WHERE cycle_id = $1') return result([]);
      if (text === 'SELECT count(*) AS n FROM recruit_applications WHERE cycle_id = $1') return result([{ n: String(db.applications.filter((a) => a.cycle_id === v[0]).length) }]);
      /* applications */
      if (m(/^SELECT count\(\*\) AS n FROM recruit_applications WHERE cycle_id = \$1 AND \(\$2::boolean OR erased_at IS NULL\)$/)) return result([{ n: String(db.applications.filter((a) => a.cycle_id === v[0] && (v[1] || a.erased_at == null)).length) }]);
      if (m(/^SELECT count\(\*\) AS n FROM recruit_applications WHERE cycle_id = \$1 AND section = \$2 AND \(\$3::boolean OR erased_at IS NULL\)$/)) return result([{ n: String(db.applications.filter((a) => a.cycle_id === v[0] && (a.section || 'interest') === v[1] && (v[2] || a.erased_at == null)).length) }]);
      if (m(/^SELECT \* FROM recruit_applications WHERE cycle_id = \$1 AND section = \$2 AND email = \$3$/)) return result(db.applications.filter((a) => a.cycle_id === v[0] && (a.section || 'interest') === v[1] && a.email === v[2]));
      if (m(/^SELECT \* FROM recruit_applications WHERE cycle_id = \$1 AND section = \$2 ORDER BY ts DESC$/)) return result(db.applications.filter((a) => a.cycle_id === v[0] && (a.section || 'interest') === v[1]).sort((x, y) => y.ts - x.ts));
      if (m(/^SELECT \* FROM recruit_applications WHERE id = \$1 AND cycle_id = \$2$/)) return result(db.applications.filter((a) => a.id === v[0] && a.cycle_id === v[1]));
      if (m(/^SELECT \* FROM recruit_applications WHERE id = \$1$/)) return result(db.applications.filter((a) => a.id === v[0]));
      if (m(/^SELECT \* FROM recruit_applications WHERE cycle_id = \$1 ORDER BY ts DESC LIMIT \$2$/)) return result(db.applications.filter((a) => a.cycle_id === v[0]).sort((x, y) => y.ts - x.ts).slice(0, v[1]));
      if (m(/^SELECT \* FROM recruit_applications WHERE cycle_id = \$1 AND erased_at IS NULL ORDER BY ts$/)) return result(db.applications.filter((a) => a.cycle_id === v[0] && a.erased_at == null).sort((x, y) => x.ts - y.ts));
      if (m(/^SELECT \* FROM recruit_applicants WHERE email = \$1$/)) return result(db.applicants.filter((p) => p.email === v[0]));
      if (m(/^SELECT \* FROM recruit_applications WHERE email = \$1 ORDER BY ts DESC$/)) return result(db.applications.filter((a) => a.email === v[0]));
      if (/^WITH prior AS \( ?SELECT outcome FROM interest_receipts WHERE id = \$1 AND NOT \(\$2 AND outcome IN/.test(text)) {
        db.commitStatement = text;
        assert.equal(v.length, 34, 'the commit CTE carries every value as a parameter');
        const [rid, override] = v;
        const prior = db.receipts.get(rid);
        if (prior && !(override && ['review', 'held'].includes(prior))) return result([{ outcome: prior, inserted: null }]);
        const incoming = { id: v[2], cycle_id: v[3], section: v[4], email: v[5], ts: v[6], updated: v[7], name: v[8], cornell: v[9], subteam: v[10], year: v[11], source: v[12], form_version: v[13], answers: JSON.parse(v[14]), files: JSON.parse(v[15]), stage: v[16], stage_at: v[17], stage_history: JSON.parse(v[18]), ip_hash: v[19], receipt_id: v[20], outcome: null, decision: {}, tags: [], review: {}, review_version: 0, edit_version: 0, onboarded_at: null, erased_at: null };
        const hasYear = v[21], modern = v[22], confirmUpdate = v[24];
        const current = db.applications.find((a) => a.cycle_id === incoming.cycle_id && (a.section || 'interest') === (incoming.section || 'interest') && a.email === incoming.email);
        let written = false, inserted = false;
        if (!current) { db.applications.push(incoming); written = inserted = true; }
        else if (confirmUpdate && current.updated <= incoming.updated) {
          Object.assign(current, { name: incoming.name, subteam: incoming.subteam, updated: incoming.updated, ip_hash: incoming.ip_hash, year: hasYear ? incoming.year : current.year, answers: modern ? incoming.answers : { ...current.answers, ...incoming.answers }, files: modern || incoming.files.length ? incoming.files : current.files, form_version: incoming.form_version, receipt_id: incoming.receipt_id });
          written = true;
        }
        if (written) {
          const p = db.applicants.find((x) => x.email === incoming.email);
          if (p) { p.name = incoming.name; p.last_seen = incoming.updated; if (inserted) p.applications++; }
          else db.applicants.push({ email: incoming.email, name: incoming.name, cornell: incoming.cornell, first_seen: incoming.ts, last_seen: incoming.updated, applications: 1, erased_at: null, doc: {} });
        }
        const outcome = written ? 'saved' : confirmUpdate ? 'superseded' : 'review';
        if (!db.receipts.has(rid) || (override && ['review', 'held'].includes(db.receipts.get(rid)))) db.receipts.set(rid, outcome);
        return result([{ outcome, inserted }]);
      }
      if (text.startsWith('WITH moved AS (UPDATE recruit_applications SET stage = $1')) {
        db.moveStatement = text;
        const [to, now, outcome, historyJson, id, cycleId, , from] = v;
        const row = db.applications.find((a) => a.id === id && a.cycle_id === cycleId);
        if (!row || row.stage === to || (from !== null && row.stage !== from)) return result([]);
        const fromStage = row.stage;
        row.stage = to; row.stage_at = now; row.outcome = outcome; row.stage_history = [...row.stage_history, ...JSON.parse(historyJson)]; row.edit_version++;
        db.audit.push({ id: v[10], ts: v[11], cycle_id: v[12], application_id: id, actor: v[13], kind: 'stage', detail: { from: fromStage, to, requestId: v[15] } });
        return result([{ id, edit_version: String(row.edit_version), from_stage: fromStage }]);
      }
      if (text.startsWith('WITH before AS (SELECT id, cycle_id, files, email, receipt_id FROM recruit_applications WHERE erased_at IS NULL AND')) {
        db.eraseStatement = text;
        assert.match(text, /email = 'erased:' \|\| a\.id/);
        assert.match(text, /review = a\.review - 'comments'/);
        const rows = db.applications.filter((a) => a.erased_at == null && (text.includes('email = $1') ? a.email === v[0] : a.cycle_id === v[0])).slice(0, v[1]);
        const out = rows.map((a) => ({ id: a.id, cycle_id: a.cycle_id, files: a.files, email: a.email, receipt_id: a.receipt_id }));
        for (const a of rows) { const { comments, ...review } = a.review; Object.assign(a, { name: 'Applicant', email: 'erased:' + a.id, answers: {}, files: [], ip_hash: '', review, erased_at: v[2], edit_version: a.edit_version + 1 }); }
        return result(out);
      }
      if (m(/^DELETE FROM recruit_applicants p WHERE p\.email = ANY\(\$1\) AND NOT EXISTS/)) { db.applicants = db.applicants.filter((p) => !(v[0].includes(p.email) && !db.applications.some((a) => a.email === p.email))); return result(); }
      if (m(/^DELETE FROM wiki_files WHERE id = \$1 AND NOT EXISTS \(SELECT 1 FROM recruit_applications WHERE files @> \$2::jsonb\)/)) {
        db.fileDelete = text;
        assert.match(text, /NOT EXISTS \(SELECT 1 FROM interest_submissions WHERE file_id = \$3\)/);
        assert.match(text, /NOT EXISTS \(SELECT 1 FROM interest_archives a, jsonb_array_elements\(a\.rows\) r WHERE r->>'fileId' = \$4\)/);
        assert.deepEqual(JSON.parse(v[1]), [{ id: v[0] }]);
        const referenced = db.applications.some((a) => a.files.some((f) => f.id === v[0])) || db.interest_submissions.some((s) => s.file_id === v[0]) || db.interest_archives.some((a) => a.rows.some((r) => r.fileId === v[0]));
        if (!referenced) { const had = db.files.delete(v[0]); return result([], had ? 1 : 0); }
        return result([], 0);
      }
      if (m(/^SELECT id FROM recruit_applications WHERE cycle_id = \$1/)) return result(db.applications.filter((a) => a.cycle_id === v[0] && (!v[1] || v[1].includes(a.subteam))).map((a) => ({ id: a.id })));

      /* receipts and legacy statements from interest.js */
      if (m(/^SELECT outcome FROM interest_receipts WHERE id = \$1$/)) return result(db.receipts.has(v[0]) ? [{ outcome: db.receipts.get(v[0]) }] : []);
      if (m(/^INSERT INTO interest_receipts \(id, outcome, ts\) VALUES \(\$1, \$2, \$3\) ON CONFLICT DO NOTHING$/)) { if (!db.receipts.has(v[0])) db.receipts.set(v[0], v[1]); return result(); }
      if (m(/^INSERT INTO interest_receipts \(id, outcome, ts\) VALUES \(\$1, \$2, \$3\) ON CONFLICT \(id\) DO UPDATE SET outcome = EXCLUDED\.outcome WHERE interest_receipts\.outcome IN \('review', 'held'\)$/)) { if (!db.receipts.has(v[0]) || ['review', 'held'].includes(db.receipts.get(v[0]))) db.receipts.set(v[0], v[1]); return result(); }
      if (m(/^SELECT count\(\*\) AS n FROM interest_events WHERE ip_hash = \$1 AND ts > \$2$/)) return result([{ n: '0' }]);
      if (m(/^SELECT count\(\*\) AS n FROM interest_events WHERE ts > \$1$/)) return result([{ n: '0' }]);
      if (/^(DELETE FROM|INSERT INTO) interest_events/.test(text)) return result();
      if (text === 'SELECT count(*) AS n FROM interest_submissions') return result([{ n: String(db.interest_submissions.length) }]);
      if (m(/^SELECT \* FROM interest_submissions WHERE email = \$1$/)) return result(db.interest_submissions.filter((r) => r.email === v[0]));
      if (text === 'SELECT * FROM interest_submissions ORDER BY ts DESC') return result([...db.interest_submissions].sort((a, b) => b.ts - a.ts));
      if (text.startsWith('WITH prior AS ( SELECT outcome FROM interest_receipts WHERE id = $1 ), written AS ( INSERT INTO interest_submissions')) {
        const rid = v[0];
        if (db.receipts.has(rid)) return result([{ outcome: db.receipts.get(rid) }]);
        const incoming = { id: v[1], ts: v[2], updated: v[3], name: v[4], email: v[5], subteam: v[6], project: v[7], cornell: v[8], file_id: v[9], file_name: v[10], file_type: v[11], file_size: v[12], ip_hash: v[13], year: v[14], review: {}, review_version: 0 };
        const current = db.interest_submissions.find((r) => r.email === incoming.email);
        let outcome;
        if (current && !v[16]) outcome = 'review';
        else if (current && current.updated > incoming.updated) outcome = 'superseded';
        else { if (current) Object.assign(current, { ...incoming, id: current.id, ts: current.ts, year: v[15] ? incoming.year : current.year, review: current.review, review_version: current.review_version }); else db.interest_submissions.push(incoming); outcome = 'saved'; }
        db.receipts.set(rid, outcome);
        return result([{ outcome }]);
      }
      const insLegacy = m(/^INSERT INTO interest_submissions \(([^)]*)\) VALUES \((.*)\) ON CONFLICT \(email\) DO NOTHING RETURNING id$/);
      if (insLegacy) {
        db.rollbackInsert = text;
        const cols = insLegacy[1].split(',').map((s) => s.trim());
        const vals = splitTop(insLegacy[2]).map((t) => literal(t, v));
        const row = {}; cols.forEach((c, i) => { row[c] = vals[i]; });
        if (db.interest_submissions.some((r) => r.email === row.email)) return result([]);
        db.interest_submissions.push(row);
        return result([{ id: row.id }]);
      }

      /* roles, audit, requests */
      if (m(/^SELECT \* FROM recruit_roles WHERE cycle_id = \$1 AND member = \$2$/)) return result(db.roles.filter((g) => g.cycle_id === v[0] && g.member === v[1]));
      if (m(/^SELECT \* FROM recruit_roles WHERE member = \$1$/)) return result(db.roles.filter((g) => g.member === v[0]));
      if (m(/^SELECT member, roles, subteams, ts FROM recruit_roles WHERE cycle_id = \$1 ORDER BY ts$/)) return result(db.roles.filter((g) => g.cycle_id === v[0]));
      if (m(/^INSERT INTO recruit_audit \(id, ts, cycle_id, application_id, actor, kind, detail\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7::jsonb\)$/)) { db.audit.push({ id: v[0], ts: v[1], cycle_id: v[2], application_id: v[3], actor: v[4], kind: v[5], detail: JSON.parse(v[6]) }); return result(); }
      if (m(/^WITH purged AS \(DELETE FROM recruit_requests WHERE ts < \$1\) INSERT INTO recruit_requests \(id, ts, actor\) VALUES \(\$2, \$3, \$4\) ON CONFLICT \(id\) DO NOTHING RETURNING id$/)) {
        db.requests = db.requests.filter((r) => r.ts >= v[0]);
        if (db.requests.some((r) => r.id === v[1])) return result([]);
        db.requests.push({ id: v[1], ts: v[2], actor: v[3], result: null });
        return result([{ id: v[1] }]);
      }
      if (m(/^SELECT actor, result FROM recruit_requests WHERE id = \$1$/)) return result(db.requests.filter((r) => r.id === v[0]).map((r) => ({ actor: r.actor, result: r.result })));
      if (m(/^UPDATE recruit_requests SET result = \$1::jsonb WHERE id = \$2$/)) { const r = db.requests.find((x) => x.id === v[1]); if (r) r.result = JSON.parse(v[0]); return result(); }
      if (m(/^DELETE FROM recruit_requests WHERE id = \$1 AND result IS NULL$/)) { db.requests = db.requests.filter((r) => !(r.id === v[0] && r.result == null)); return result(); }
      if (m(/^INSERT INTO wiki_files/)) { db.files.set(v[0], { id: v[0], name: v[1], type: v[2], size: v[3], by: v[4], ts: v[5], data: Buffer.from(v[6], 'base64') }); return result(); }
      throw new Error('Unexpected synthetic SQL: ' + text);
    },
  };

  db.sql.transaction = (run) => run(db.sql);

  /* ------------------------------ fixtures ------------------------------ */

  const { handleInterest } = await lib('interest.js');
  const { createRecruit } = await lib('recruit/registry.js');
  const cycles = (await lib('recruit/modules/cycles.js')).default;
  const applications = (await lib('recruit/modules/applications.js')).default;
  const roles = (await lib('recruit/modules/roles.js')).default;
  const { rollbackCycle } = await import(pathToFileURL(join(root, 'recruit-rollback.mjs')));
  const R = createRecruit([cycles, applications, roles]);
  const admin = { email: 'admin@example.com', name: 'Ada', role: 'admin', status: 'active' };
  const journal = { records: new Map(), done: new Map(), enabled: () => true, async append(e) { this.records.set(e.id, structuredClone(e)); return true; }, async listPending() { return [...this.records.values()].filter((e) => !this.done.has(e.id)); }, async getEntry(id) { return this.records.get(id) || null; }, async getFile() { return null; }, async complete(id, o) { this.done.set(id, o); }, async check() { return { ok: true }; } };
  let n = 0;
  const baseCtx = (me) => ({ me: async () => me, journal, host: 'wiki.test', session: () => ({}), emailSettings: async () => { throw new Error('Email disabled in tests'); } });
  async function interest(method, path, body = {}, ctxExtra = {}) {
    clock += 10;
    const req = { method, headers: { origin: 'https://cornellphysicalintelligence.com', 'content-type': 'application/json', 'x-real-ip': `pg-${++n}` } };
    const res = { headers: {}, setHeader(k, val) { this.headers[k] = val; }, end(val) { this.body = val; } };
    await handleInterest(req, res, path, { ...baseCtx(admin), readJson: async () => body, ...ctxExtra });
    return { status: res.statusCode, data: res.headers['content-type'] === 'application/json' ? JSON.parse(res.body) : res.body };
  }
  async function recruit(method, path, body = {}, me = admin) {
    clock += 10;
    const req = { method, url: path, headers: { origin: 'https://cornellphysicalintelligence.com', 'content-type': 'application/json', 'x-real-ip': `pg-${++n}` } };
    const res = { headers: {}, setHeader(k, val) { this.headers[k] = val; }, end(val) { this.body = val; } };
    await R.handleRecruit(req, res, path.split('?')[0], { ...baseCtx(me), readJson: async () => body });
    return { status: res.statusCode, data: res.headers['content-type'] === 'application/json' ? JSON.parse(res.body) : res.body };
  }
  let rq = 0;
  const requestId = () => `rq-pg-${String(++rq).padStart(6, '0')}`;
  const since = () => db.trace.length;
  const tracedSince = (i) => db.trace.slice(i);

  db.interest_submissions = [
    { id: 'in-one', ts: 1000, updated: 1000, name: 'One', email: 'one@example.com', subteam: 'Software', project: 'P1', cornell: false, file_id: 'int-onefile', file_name: 'one.png', file_type: 'image/png', file_size: 3, ip_hash: 'h1', year: 'Junior', review: { flagged: true, comments: [{ id: 'ic-aaaaaaaa', text: 'hi', by: 'admin@example.com', name: 'Ada', ts: 1 }] }, review_version: 2 },
    { id: 'in-two', ts: 2000, updated: 2000, name: 'Two', email: 'two@example.com', subteam: '', project: '', cornell: true, file_id: null, file_name: null, file_type: null, file_size: null, ip_hash: 'h2', year: null, review: {}, review_version: 0 },
  ];
  db.files.set('int-onefile', { id: 'int-onefile', name: 'one.png', type: 'image/png', size: 3, by: 'one@example.com', ts: 1, data: Buffer.from('png') });
  db.interest_archives = [{ id: 'ar-old', ts: 500, name: 'Spring 2025 archive', count: 2, rows: [
    { id: 'in-arch1', ts: 100, updated: 100, name: 'Arch', email: 'ARCH@example.com', subteam: '', project: '', cornell: false, ipHash: 'x', fileId: null, fileName: null, fileType: null, fileSize: null },
    { id: 'in-arch2', ts: 200, updated: 200, name: 'Arch Dup', email: 'arch@example.com', subteam: '', project: '', cornell: false, ipHash: 'x' },
  ] }];

  /* ---- legacy path issues no recruit SQL without the bridge ---- */
  let mark = since();
  const legacyPost = await interest('POST', '/interest', { name: 'Legacy Only', email: 'legacy-only@example.com' }, { intake: undefined });
  assert.equal(legacyPost.status, 200);
  const legacyGet = await interest('GET', '/interest', {}, { intake: undefined });
  assert.equal(legacyGet.status, 200);
  assert.equal(legacyGet.data.rows.length, 3);
  assert.ok(tracedSince(mark).every((t) => !/recruit_/.test(t)), 'no recruit_* SQL on /interest when ctx.intake is absent');
  const recruitTables = () => db.schema.filter((t) => /recruit_/.test(t));
  assert.equal(recruitTables().length, 0, 'the recruit schema never ran');
  /* ---- a bridge whose target() throws leaves the legacy path intact ---- */
  mark = since();
  const broken = await interest('POST', '/interest', { name: 'Broken Bridge', email: 'broken@example.com' }, { intake: { target: async () => { throw new Error('Synthetic bridge failure'); } } });
  assert.equal(broken.status, 200);
  assert.ok(db.interest_submissions.some((r) => r.email === 'broken@example.com'));
  assert.ok(tracedSince(mark).every((t) => !/recruit_/.test(t)));
  db.failTarget = true;
  mark = since();
  const outage = await interest('POST', '/interest', { name: 'Outage', email: 'outage@example.com' }, { intake: R.intakeBridge });
  assert.equal(outage.status, 200, 'a recruit outage during target() falls back to the legacy tables');
  assert.ok(db.interest_submissions.some((r) => r.email === 'outage@example.com'));
  assert.ok(!tracedSince(mark).some((t) => t.startsWith('INSERT INTO recruit_applications')));
  db.failTarget = false;
  console.log('PASS: no recruit SQL on /interest without the bridge; target() failure → legacy 200');

  /* ---- schema runs once per instance, every string tagged with raw ---- */
  const kit = R.kitFor(baseCtx(admin));
  mark = since();
  await kit.sql();
  const expectedTables = kit.statements().filter((s) => s.startsWith('CREATE TABLE') && /recruit_/.test(s)).length;
  assert.equal(recruitTables().length, expectedTables, 'every CREATE TABLE ran');
  assert.ok(db.schema.some((t) => t.includes('recruit_settings')) && db.schema.some((t) => t.includes('recruit_applications')) && db.schema.some((t) => t.includes('recruit_audit')));
  assert.ok(db.trace.some((t) => t.startsWith('INSERT INTO recruit_settings (id, version, doc) VALUES (1, 1,')), 'the settings row is seeded inside kit.sql()');
  assert.deepEqual(db.settings.doc.intakeCycleId, null);
  assert.equal(db.settings.doc.notify, undefined, 'no global recipients: each form names its own');
  const afterSchema = since();
  await kit.sql();
  await R.kitFor(baseCtx(admin)).sql();
  assert.equal(since(), afterSchema, 'a second kit on the same instance issues no schema statements');
  assert.equal(recruitTables().length, expectedTables);
  console.log('PASS: schema strings run once per instance with raw');

  /* ---- migration: ON CONFLICT (id) DO NOTHING, idempotent, resumable ---- */
  const state0 = (await recruit('GET', '/recruit/migrate')).data;
  assert.deepEqual([state0.done, state0.next, state0.legacyLive, state0.orphans], [false, { step: 'live' }, 5, 5]);
  const live = (await recruit('POST', '/recruit/migrate', { requestId: requestId(), step: 'live' })).data;
  assert.match(db.migrationInsert, /FROM interest_submissions ON CONFLICT \(id\) DO NOTHING$/);
  assert.deepEqual([live.done, live.next, live.migration.live], [false, { step: 'archive', archiveId: 'ar-old' }, 5]);
  assert.equal(db.settings.doc.intakeCycleId, 'cy-interest');
  const one = db.applications.find((a) => a.id === 'in-one');
  assert.deepEqual([one.cycle_id, one.source, one.review_version, one.files[0].id, one.answers.project, one.year], ['cy-interest', 'migrated', 2, 'int-onefile', 'P1', 'Junior']);
  const rowsAfterLive = clone(db.applications);
  assert.equal((await recruit('POST', '/recruit/migrate', { requestId: requestId(), step: 'live' })).status, 200);
  assert.deepEqual(db.applications, rowsAfterLive, 'the live step is idempotent');
  const arch = (await recruit('POST', '/recruit/migrate', { requestId: requestId(), step: 'archive', archiveId: 'ar-old' })).data;
  assert.match(db.migrationInsert, /jsonb_to_recordset\(a\.rows\)/);
  assert.match(db.migrationInsert, /ON CONFLICT \(id\) DO NOTHING$/);
  assert.deepEqual([arch.done, arch.next, arch.migration.archives, arch.migration.duplicates], [true, null, { 'ar-old': 'cy-old' }, 1]);
  assert.equal(db.cycles.find((c) => c.id === 'cy-old').term, 'Spring 2025');
  assert.equal(db.cycles.find((c) => c.id === 'cy-old').status, 'archived');
  assert.equal(db.applications.filter((a) => a.cycle_id === 'cy-old').length, 1, 'one row per email inside an archive');
  const snap = JSON.stringify(db.applications);
  assert.equal((await recruit('POST', '/recruit/migrate', { requestId: requestId(), step: 'archive', archiveId: 'ar-old' })).status, 200);
  assert.equal(JSON.stringify(db.applications), snap, 'the archive step is idempotent');
  assert.equal(db.cycles.length, 2, 'the unique legacy index keeps one cycle per archive');
  assert.ok(db.audit.some((a) => a.kind === 'migrate'));
  assert.equal(db.interest_submissions.length, 5, 'legacy rows are never touched');
  console.log('PASS: migration ON CONFLICT (id) DO NOTHING, idempotent and resumable');

  /* ---- the commit CTE is one statement with the receipt ---- */
  mark = since();
  const posted = await interest('POST', '/interest', { name: 'Via Bridge', email: 'bridge@example.com', year: 'Grad', project: 'Cool' }, { intake: R.intakeBridge });
  assert.equal(posted.status, 200);
  const commit = tracedSince(mark).filter((t) => /^WITH prior AS \( ?SELECT outcome FROM interest_receipts WHERE id = \$1 AND NOT/.test(t));
  assert.equal(commit.length, 1, 'exactly one commit statement');
  assert.match(commit[0], /INSERT INTO interest_receipts/);
  assert.match(commit[0], /ON CONFLICT \(cycle_id, section, email\) DO UPDATE SET/);
  assert.match(commit[0], /INSERT INTO recruit_applicants/);
  const setClause = /DO UPDATE SET (.*?) WHERE \$25 AND recruit_applications\.updated <= EXCLUDED\.updated/s.exec(commit[0])[1];
  for (const col of ['review', 'stage', 'tags', 'decision', 'edit_version', 'outcome']) assert.ok(!new RegExp(`\\b${col} =`).test(setClause), `${col} is never in the applicant SET list`);
  assert.ok(!tracedSince(mark).some((t) => t.startsWith('INSERT INTO interest_submissions')), 'nothing lands in the legacy table');
  const bridged = db.applications.find((a) => a.email === 'bridge@example.com');
  assert.equal(bridged.id, 'in-' + posted.data.receipt.replace(/[^a-z0-9]/g, ''));
  assert.equal(db.receipts.get(posted.data.receipt), 'saved');
  assert.ok(db.audit.some((a) => a.kind === 'app.create' && a.actor === 'applicant' && a.application_id === bridged.id));
  const entry = journal.records.get(posted.data.receipt);
  mark = since();
  const replay = await R.intakeBridge.commit(entry, journal, null, { cycleId: entry.cycleId });
  assert.deepEqual([replay.outcome, replay.inserted], ['saved', false], 'a replayed receipt converges on the prior outcome');
  assert.ok(!tracedSince(mark).some((t) => t.startsWith('WITH prior')), 'the prior receipt short-circuits before the write');
  assert.equal(db.applications.filter((a) => a.email === 'bridge@example.com').length, 1);
  const dup = await interest('POST', '/interest', { name: 'Via Bridge', email: 'bridge@example.com' }, { intake: R.intakeBridge });
  assert.equal(dup.status, 409);
  console.log('PASS: the bridge commit is one statement inserting interest_receipts; replays converge; review/stage/tags/decision untouched');

  /* ---- pointer CAS on the intake route ---- */
  const created = (await recruit('POST', '/recruit/cycles', { requestId: requestId(), name: 'Fall 2026', term: 'Fall 2026' })).data.cycle;
  const opened = (await recruit('POST', `/recruit/cycles/${created.id}/status`, { version: created.version, status: 'open' })).data.cycle;
  assert.equal(opened.status, 'open');
  const stale = await recruit('POST', `/recruit/cycles/${created.id}/intake`, { on: true, version: db.settings.version - 1 });
  assert.equal(stale.status, 409);
  assert.match(db.pointerCas, /WHERE id = 1 AND version = \$2/);
  const pointed = await recruit('POST', `/recruit/cycles/${created.id}/intake`, { on: true, version: db.settings.version });
  assert.deepEqual([pointed.status, pointed.data.intakeCycleId], [200, created.id]);
  assert.equal((await R.intakeBridge.target()).cycleId, created.id);
  const closedNow = await recruit('POST', `/recruit/cycles/${created.id}/status`, { version: opened.version, status: 'closed' });
  assert.equal(closedNow.status, 200);
  assert.equal(db.settings.doc.intakeCycleId, undefined, 'closing the receiving cycle clears the pointer');
  console.log('PASS: pointer CAS WHERE id = 1 AND version = $n; closing clears it');

  /* ---- move CTE: guarded UPDATE with RETURNING and the audit insert ---- */
  const moved = await kit.apps.move({ id: 'cy-interest', doc: {} }, { id: 'in-one', to: 'screening', by: 'admin@example.com', requestId: 'rq-move-000001' });
  assert.deepEqual([moved.from, moved.to, moved.editVersion], ['applied', 'screening', 1]);
  assert.match(db.moveStatement, /RETURNING id, edit_version, \(SELECT stage FROM recruit_applications WHERE id = \$10\) AS from_stage/);
  assert.match(db.moveStatement, /INSERT INTO recruit_audit/);
  assert.match(db.moveStatement, /WHERE id = \$5 AND cycle_id = \$6 AND stage <> \$7 AND \(\$8::text IS NULL OR stage = \$9\)/);
  assert.equal(await kit.apps.move({ id: 'cy-interest', doc: {} }, { id: 'in-one', to: 'interview', from: 'applied', by: 'admin@example.com' }), null, 'from mismatch moves nothing');
  assert.equal(db.audit.filter((a) => a.kind === 'stage').length, 1);
  console.log('PASS: move CTE has RETURNING and the audit insert in the same statement');

  /* ---- kit.once in Postgres ---- */
  let runs = 0;
  const first = await kit.once('rq-once-000001', 'admin@example.com', async () => { runs++; return { n: 1 }; });
  const second = await kit.once('rq-once-000001', 'admin@example.com', async () => { runs++; return { n: 2 }; });
  assert.deepEqual([first, second, runs], [{ n: 1 }, { n: 1, replayed: true }, 1]);
  assert.ok(db.trace.some((t) => t.startsWith('WITH purged AS (DELETE FROM recruit_requests WHERE ts < $1) INSERT INTO recruit_requests')));
  console.log('PASS: request idempotency is one INSERT … ON CONFLICT DO NOTHING RETURNING');

  /* ---- erase shape and the file reference check ---- */
  const erased = await kit.apps.eraseApplicant('one@example.com', { by: 'admin@example.com' });
  assert.equal(erased.erased, 1);
  assert.match(db.eraseStatement, /^WITH before AS \(SELECT id, cycle_id, files, email, receipt_id FROM recruit_applications WHERE erased_at IS NULL AND email = \$1 LIMIT \$2\), done AS \(/);
  assert.equal(db.applications.find((a) => a.id === 'in-one').email, 'erased:in-one');
  assert.match(db.fileDelete, /files @> \$2::jsonb/);
  assert.ok(db.files.has('int-onefile'), 'a file the frozen legacy row references is kept');
  console.log('PASS: erase is one guarded UPDATE; file deletion checks every reference');

  /* ---- rollback copies a cycle back with ON CONFLICT (email) DO NOTHING ---- */
  const dry = await rollbackCycle(db.sql, 'cy-interest', { dryRun: true });
  assert.equal(dry.total, db.applications.filter((a) => a.cycle_id === 'cy-interest' && a.erased_at == null).length);
  assert.equal(db.rollbackInsert, undefined, 'a dry run inserts nothing');
  const legacyCount = db.interest_submissions.length;
  const back = await rollbackCycle(db.sql, 'cy-interest');
  assert.match(db.rollbackInsert, /ON CONFLICT \(email\) DO NOTHING RETURNING id$/);
  assert.equal(back.placed, 1, 'only the application received while recruit was live is new to the legacy table');
  assert.ok(back.unplaced.every((u) => ['two@example.com', 'legacy-only@example.com', 'broken@example.com', 'outage@example.com'].includes(u.email)), 'emails already on the legacy list are reported, not overwritten');
  assert.equal(db.interest_submissions.length, legacyCount + 1);
  assert.equal(db.interest_submissions.find((r) => r.email === 'bridge@example.com').project, 'Cool');
  await assert.rejects(rollbackCycle(db.sql, 'nope'), /cycle id/);
  console.log('PASS: single-statement atomicity shapes against a fake sql tag, migration idempotency and resumability, rollback');
}
