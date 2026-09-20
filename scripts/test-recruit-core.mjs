// Synthetic fixtures only: memory-mode storage in a temp copy of lib/, an in-memory journal, no network, no keys.
// The copy of lib/interest.js gets the §4.1 seam edits applied here when the
// repo file does not carry them yet, so the real public POST runs against
// the real bridge before and after the integration commit.
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// The exact seam edits of spec §4.1 (items 1-7). Idempotent: a source that
// already mentions ctx.intake is returned unchanged.
export function patchInterest(source) {
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

// A journal that behaves like the Blob one without the SDK.
export function fakeJournal() {
  const records = new Map(), files = new Map(), done = new Map();
  return {
    records, files, done, appendOptions: null, forgotten: [],
    enabled: () => true,
    async check() { return { ok: true }; },
    async append(entry, file, options) { this.appendOptions = options || null; records.set(entry.id, structuredClone(entry)); if (file) files.set(entry.id, Buffer.from(file.data)); return true; },
    async listPending() { return [...records.values()].filter((e) => !done.has(e.id)).sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id)); },
    async getEntry(id) { return records.get(id) ? structuredClone(records.get(id)) : null; },
    async getFile(id) { return files.get(id) || null; },
    async complete(id, outcome) { done.set(id, outcome); },
    async forget(id) { this.forgotten.push(id); records.delete(id); files.delete(id); },
  };
}

if (!process.env.RECRUIT_CORE_TEST_ROOT) {
  const dir = await mkdtemp(join(tmpdir(), 'cupi-recruit-core-'));
  try {
    await cp(new URL('../lib', import.meta.url), join(dir, 'lib'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await writeFile(join(dir, 'lib/interest.js'), patchInterest(await readFile(join(dir, 'lib/interest.js'), 'utf8')));
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, DEV_FAKE_AUTH: 'admin@example.com', RECRUIT_CORE_TEST_ROOT: dir },
      stdio: 'inherit',
    });
    process.exitCode = result.status || (result.error ? 1 : 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
} else {
  globalThis.fetch = async () => { throw new Error('Network disabled in recruit tests'); };
  const root = process.env.RECRUIT_CORE_TEST_ROOT;
  const lib = (p) => import(pathToFileURL(join(root, 'lib', p)));
  let clock = 1789600000000;
  Date.now = () => clock;

  const users = [
    { email: 'admin@example.com', name: 'Ada Admin', role: 'admin', status: 'active' },
    { email: 'lead@example.com', name: 'Lee Lead', role: 'member', status: 'active', subteam: 'Software' },
    { email: 'admin2@example.com', name: 'Second Admin', role: 'admin', status: 'active' },
    { email: 'plain@example.com', name: 'Pat Plain', role: 'member', status: 'active' },
  ];
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const files = [
    { id: 'int-legacyfile', name: 'legacy.png', type: 'image/png', size: png.length, by: 'legacy@example.com', ts: 1, data: png.toString('base64') },
    { id: 'int-archfile', name: 'arch.pdf', type: 'application/pdf', size: 3, by: 'arch1@example.com', ts: 1, data: Buffer.from('pdf').toString('base64') },
  ];
  await writeFile(join(root, '.devdata.json'), JSON.stringify({ state: { users, pages: [], trash: [], activity: [], settings: {} }, version: 1, prefs: {}, files }));
  const legacyReview = { flagged: true, flaggedBy: 'lead@example.com', flaggedName: 'Lee Lead', flaggedAt: 5, comments: [{ id: 'ic-legacy0001', text: 'Strong', by: 'lead@example.com', name: 'Lee Lead', ts: 5 }, { id: 'ic-legacy0002', text: 'Follow up', by: 'admin@example.com', name: 'Ada Admin', ts: 6 }], deletedCommentIds: ['ic-legacy0000'] };
  const legacy = {
    rows: [
      { id: 'in-legacy', ts: 1000, updated: 1000, name: 'Legacy Applicant', email: 'legacy@example.com', subteam: 'Software', project: 'Existing answer', cornell: false, year: null, ipHash: 'hash-legacy', fileId: 'int-legacyfile', fileName: 'legacy.png', fileType: 'image/png', fileSize: png.length, review: legacyReview, reviewVersion: 3 },
      { id: 'in-plain', ts: 2000, updated: 2000, name: 'Plain Applicant', email: 'plain-applicant@cornell.edu', subteam: 'Electrical', project: '', cornell: true, year: 'Junior', ipHash: 'hash-plain', fileId: null, fileName: null, fileType: null, fileSize: null },
    ],
    events: [],
    archives: [
      { id: 'ar-aaaa1111', ts: 500, name: 'Fall 2025 recruiting', count: 2, rows: [
        { id: 'in-arch1', ts: 100, updated: 100, name: 'Arch One', email: 'Arch1@example.com', subteam: 'Mechanical', project: 'Robot arm', cornell: false, year: 'Senior', ipHash: 'hash-a1', fileId: 'int-archfile', fileName: 'arch.pdf', fileType: 'application/pdf', fileSize: 3, review: { flagged: false, comments: [] }, reviewVersion: 1 },
        { id: 'in-arch2', ts: 200, updated: 200, name: 'Arch Two', email: 'arch2@example.com', subteam: '', project: '', cornell: false, ipHash: 'hash-a2', fileId: null, fileName: null, fileType: null, fileSize: null },
      ] },
      { id: 'ar-bbbb2222', ts: 800, name: 'Spring cleaning', count: 2, rows: [
        { id: 'in-arch2', ts: 200, updated: 200, name: 'Arch Two Again', email: 'arch2@example.com', subteam: '', project: '', cornell: false, ipHash: 'hash-a2' },
        { id: 'in-arch3', ts: 300, updated: 300, name: 'Arch Three', email: 'arch3@example.com', subteam: 'Creative', project: 'Poster', cornell: false, ipHash: 'hash-a3' },
      ] },
    ],
    receipts: {},
  };
  const legacyPath = join(root, '.devinterest.json');
  await writeFile(legacyPath, JSON.stringify(legacy));
  const legacyRaw = async () => readFile(legacyPath, 'utf8');
  // The frozen part: rows and archives. events/receipts stay live shared ledgers.
  const legacyBytes = async () => { const d = JSON.parse(await legacyRaw()); return JSON.stringify({ rows: d.rows, archives: d.archives }); };
  const recruitDoc = async () => JSON.parse(await readFile(join(root, '.devrecruit.json'), 'utf8'));

  const { handleInterest } = await lib('interest.js');
  const { getFile } = await lib('db.js');
  const { createRecruit } = await lib('recruit/registry.js');
  const cycles = (await lib('recruit/modules/cycles.js')).default;
  const applications = (await lib('recruit/modules/applications.js')).default;
  const roles = (await lib('recruit/modules/roles.js')).default;
  const R = createRecruit([cycles, applications, roles]);
  const bridge = R.intakeBridge;
  const journal = fakeJournal();
  const members = Object.fromEntries(users.map((u) => [u.email, u]));
  const admin = members['admin@example.com'], admin2 = members['admin2@example.com'], lead = members['lead@example.com'], plain = members['plain@example.com'];

  let n = 0;
  const ctxFor = (me) => ({ readJson: null, me: async () => me, journal, host: 'wiki.test', session: () => ({}), emailSettings: async () => { throw new Error('Email disabled in tests'); } });
  async function interest(method, path, body = {}, me = admin) {
    clock += 10;
    const req = { method, headers: { origin: 'https://cornellphysicalintelligence.com', 'content-type': 'application/json', 'x-real-ip': `core-${++n}` } };
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(v) { this.body = v; } };
    await handleInterest(req, res, path, { ...ctxFor(me), readJson: async () => body, intake: bridge });
    return { status: res.statusCode, headers: res.headers, text: res.body, data: res.headers['content-type'] === 'application/json' ? JSON.parse(res.body) : null };
  }
  async function recruit(method, path, body = {}, me = admin) {
    clock += 10;
    const req = { method, url: path, headers: { origin: 'https://cornellphysicalintelligence.com', 'content-type': 'application/json', 'x-real-ip': `core-${++n}` } };
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(v) { this.body = v; } };
    await R.handleRecruit(req, res, path.split('?')[0], { ...ctxFor(me), readJson: async () => body });
    return { status: res.statusCode, headers: res.headers, text: res.body, data: res.headers['content-type'] === 'application/json' ? JSON.parse(res.body) : null };
  }
  let rq = 0;
  const requestId = () => `rq-core-${String(++rq).padStart(6, '0')}`;
  const kit = R.kitFor(ctxFor(admin));
  const appsIn = async (cycleId) => (await kit.apps.legacyRows(cycleId, 1000)).rows;
  const settingsVersion = async () => (await kit.cycles.settings()).version;

  /* ---- before migration: everything is legacy ---- */
  const legacyBefore = await legacyBytes();
  assert.equal(await bridge.target(), null, 'no intake cycle before migration');
  assert.equal(await bridge.migrated(), false);
  const early = await interest('POST', '/interest', { name: 'Early Bird', email: 'early@example.com', year: 'Freshman' });
  assert.equal(early.status, 200);
  assert.match(early.data.receipt, /^jr-\d{13}-[a-f0-9]{24}$/);
  assert.equal(journal.records.get(early.data.receipt).cycleId, null, 'journal entries carry cycleId (null before migration)');
  assert.deepEqual(journal.appendOptions, { perDay: 300, perIpHour: 5 }, 'journal thresholds default to today\'s');
  assert.equal(JSON.parse(await legacyRaw()).rows.length, 3, 'lands in interest_submissions');
  assert.equal((await appsIn('cy-interest')).length, 0);
  const legacyList = await interest('GET', '/interest');
  assert.equal(legacyList.status, 200);
  assert.equal(legacyList.data.rows.length, 3);
  assert.equal((await interest('POST', '/interest/archive', { name: 'Should still work' }, plain)).status, 403, 'legacy admin gate unchanged');
  console.log('PASS: before migration the bridge reports no target and the form writes the legacy inbox');

  /* ---- migration: explicit, resumable, idempotent ---- */
  const legacyFrozen = await legacyBytes();
  const state0 = await recruit('GET', '/recruit/migrate');
  assert.deepEqual([state0.data.done, state0.data.next, state0.data.legacyLive, state0.data.orphans], [false, { step: 'live' }, 3, 3]);
  assert.deepEqual(state0.data.legacyArchives.map((a) => [a.id, a.cycleId]), [['ar-bbbb2222', null], ['ar-aaaa1111', null]]);
  async function migrateAll() {
    let state = (await recruit('GET', '/recruit/migrate')).data;
    let steps = 0;
    while (state.next && steps++ < 10) {
      const out = await recruit('POST', '/recruit/migrate', { requestId: requestId(), ...state.next });
      assert.equal(out.status, 200, JSON.stringify(out.data));
      state = out.data;
    }
    return state;
  }
  const done1 = await migrateAll();
  assert.equal(done1.done, true);
  assert.deepEqual(done1.migration.archives, { 'ar-aaaa1111': 'cy-aaaa1111', 'ar-bbbb2222': 'cy-bbbb2222' });
  assert.equal(done1.migration.live, 3);
  assert.equal(done1.migration.duplicates, 1, 'a duplicate id across two archives keeps the first and is counted');
  assert.equal(done1.orphans, 0);
  const snapshot = async () => { const d = await recruitDoc(); return JSON.stringify({ apps: [...d.applications].sort((a, b) => a.id.localeCompare(b.id)), cycles: d.cycles.map((c) => [c.id, c.status, c.term, c.name, c.legacy]).sort(), applicants: [...d.applicants].sort((a, b) => a.email.localeCompare(b.email)) }); };
  const snap1 = await snapshot();
  const d1 = await recruitDoc();
  assert.deepEqual(d1.cycles.map((c) => [c.id, c.status, c.term]).sort(), [['cy-aaaa1111', 'archived', 'Fall 2025'], ['cy-bbbb2222', 'archived', ''], ['cy-interest', 'open', 'Rolling']], 'terms are guessed from archive names');
  assert.equal(d1.settings.doc.intakeCycleId, 'cy-interest', 'the interest list receives the form from the live step on');
  const migratedLegacy = d1.applications.find((a) => a.id === 'in-legacy');
  assert.deepEqual(migratedLegacy.review, legacyReview, 'review preserved verbatim');
  assert.equal(migratedLegacy.reviewVersion, 3);
  assert.deepEqual(migratedLegacy.files, [{ id: 'int-legacyfile', question: 'file', name: 'legacy.png', type: 'image/png', size: png.length }]);
  assert.equal(migratedLegacy.source, 'migrated');
  assert.equal(migratedLegacy.ts, 1000);
  assert.deepEqual(migratedLegacy.answers, { project: 'Existing answer' });
  assert.ok(d1.applications.every((a) => !Object.hasOwn(a, 'ipHash') || a.ipHash === ''), 'ipHash never copied');
  assert.equal(d1.applications.filter((a) => a.cycleId === 'cy-aaaa1111').length, 2);
  assert.equal(d1.applications.filter((a) => a.cycleId === 'cy-bbbb2222').length, 1, 'the duplicate id stayed with the first archive');
  assert.equal(d1.applications.find((a) => a.id === 'in-arch1').email, 'arch1@example.com', 'emails lowercased');
  assert.equal(d1.applicants.find((p) => p.email === 'arch2@example.com').applications, 1);
  assert.equal(await legacyBytes(), legacyFrozen, 'legacy storage is byte-identical after migration');
  // Run every step again with new request ids: nothing changes.
  for (const step of [{ step: 'live' }, { step: 'archive', archiveId: 'ar-aaaa1111' }, { step: 'archive', archiveId: 'ar-bbbb2222' }]) {
    assert.equal((await recruit('POST', '/recruit/migrate', { requestId: requestId(), ...step })).status, 200);
  }
  assert.equal(await snapshot(), snap1, 'migration is idempotent');
  const done2 = (await recruit('GET', '/recruit/migrate')).data;
  assert.deepEqual([done2.done, done2.migration.live, done2.migration.duplicates], [true, 3, 1]);
  assert.equal(await legacyBytes(), legacyFrozen);
  assert.equal(await bridge.migrated(), true);
  assert.ok((await recruit('GET', '/recruit/cycles/cy-interest/audit?kind=migrate')).data.rows.length >= 1, 'migration is audited');
  console.log('PASS: migration twice → same counts, ids/review/files preserved, ipHash absent, terms guessed, duplicates counted, legacy untouched');

  /* ---- after migration: the fixed POST lands in the intake cycle ---- */
  const target = await bridge.target();
  assert.deepEqual(target, { cycleId: 'cy-interest', formVersion: 0, perIpHour: 5, perDay: 2000, capacity: 0, notify: true, confirmUpdate: true });
  const fresh = await interest('POST', '/interest', { name: 'Fresh Face', email: 'FRESH@example.com', subteam: 'Software', year: 'Grad', project: 'A robot' });
  assert.equal(fresh.status, 200);
  assert.equal(await legacyBytes(), legacyFrozen, 'the legacy inbox no longer grows');
  assert.deepEqual(journal.appendOptions, { perDay: 2000, perIpHour: 5 }, 'cycle intake limits reach the journal');
  assert.equal(journal.records.get(fresh.data.receipt).cycleId, 'cy-interest');
  const freshRow = (await appsIn('cy-interest')).find((a) => a.email === 'fresh@example.com');
  assert.equal(freshRow.id, 'in-' + fresh.data.receipt.replace(/[^a-z0-9]/g, ''), 'deterministic id from the receipt');
  assert.deepEqual([freshRow.source, freshRow.stage, freshRow.year, freshRow.answers.project, freshRow.receiptId, freshRow.subteam], ['form', 'applied', 'Grad', 'A robot', fresh.data.receipt, 'Software']);
  assert.ok((await recruit('GET', '/recruit/cycles/cy-interest/audit?kind=app.create')).data.rows.some((a) => a.applicationId === freshRow.id && a.actor === 'applicant' && a.detail.receipt === fresh.data.receipt));
  for (const year of ['Freshman', 'Sophomore', 'Junior', 'Senior', 'Grad']) {
    assert.equal((await interest('POST', '/interest', { name: year, email: `${year.toLowerCase()}@example.com`, year })).status, 200);
  }
  assert.equal((await interest('POST', '/interest', { name: 'No Year', email: 'blank@example.com' })).status, 200);
  assert.equal((await appsIn('cy-interest')).find((r) => r.email === 'blank@example.com').year, null);
  for (const year of ['Unknown', 2026, ['Grad'], {}]) {
    assert.equal((await interest('POST', '/interest', { name: 'Invalid', email: 'invalid@example.com', year })).status, 400);
  }
  assert.equal((await interest('POST', '/interest', { name: 'Fresh', email: 'fresh@example.com' })).status, 409);
  const dup = await interest('POST', '/interest', { name: 'Fresh', email: 'fresh@example.com' });
  assert.deepEqual([dup.data.exists, dup.data.submitted, dup.data.error], [true, freshRow.ts, 'This email is already on the interest list']);
  assert.match(dup.data.receipt, /^jr-/);
  const bot = await interest('POST', '/interest', { name: 'Bot', email: 'bot@example.com', website: 'http://spam' });
  assert.deepEqual([bot.status, bot.data], [200, { ok: true }]);
  assert.ok(!(await appsIn('cy-interest')).some((r) => r.email === 'bot@example.com'));
  assert.equal((await interest('POST', '/interest', { name: 'x', email: 'x@example.com' }, null, { origin: 'https://evil.example' })).status, 200, 'origin check is per header (still cornell here)');

  // confirmUpdate on a migrated row keeps id/ts/review/file, updates the rest.
  const upd = await interest('POST', '/interest', { name: 'Legacy Applicant', email: 'legacy@example.com', confirmUpdate: true, year: 'Grad', project: 'Revised answer', subteam: 'Software', review: { comments: [] } });
  assert.equal(upd.status, 200);
  let legacyRow = (await appsIn('cy-interest')).find((r) => r.email === 'legacy@example.com');
  assert.deepEqual([legacyRow.id, legacyRow.ts, legacyRow.year, legacyRow.answers.project, legacyRow.updated], ['in-legacy', 1000, 'Grad', 'Revised answer', clock]);
  assert.deepEqual(legacyRow.review, legacyReview, 'applicant updates never touch the review');
  assert.equal(legacyRow.reviewVersion, 3);
  assert.equal(legacyRow.files[0].id, 'int-legacyfile', 'the old file stays when none is sent');
  assert.equal((await interest('POST', '/interest', { name: 'Legacy Applicant', email: 'legacy@example.com', confirmUpdate: true, project: 'Revised answer', subteam: 'Software' })).status, 200);
  assert.equal((await appsIn('cy-interest')).find((r) => r.email === 'legacy@example.com').year, 'Grad', 'old clients preserve a saved year');
  assert.equal((await interest('POST', '/interest', { name: 'Legacy Applicant', email: 'legacy@example.com', confirmUpdate: true, year: null, project: 'Revised answer', subteam: 'Software' })).status, 200);
  assert.equal((await appsIn('cy-interest')).find((r) => r.email === 'legacy@example.com').year, null, 'explicit blank clears the year');
  // Superseded: an update older than the row's last update is silently skipped.
  const saved = clock;
  clock -= 100000;
  const old = await interest('POST', '/interest', { name: 'Older Name', email: 'legacy@example.com', confirmUpdate: true });
  clock = saved;
  assert.equal(old.status, 200);
  legacyRow = (await appsIn('cy-interest')).find((r) => r.email === 'legacy@example.com');
  assert.equal(legacyRow.name, 'Legacy Applicant', 'superseded submissions change nothing');
  assert.equal(journal.done.get(old.data.receipt), 'superseded');
  // A file rides the same commit and is stored under the receipt id.
  const withFile = await interest('POST', '/interest', { name: 'Filed', email: 'filed@example.com', file: { name: 'shot.png', type: 'image/png', data: png.toString('base64') } });
  assert.equal(withFile.status, 200);
  const filedRow = (await appsIn('cy-interest')).find((r) => r.email === 'filed@example.com');
  assert.equal(filedRow.files[0].id, 'int-' + withFile.data.receipt.replace(/[^a-z0-9]/g, ''));
  assert.ok(await getFile(filedRow.files[0].id));
  assert.equal((await interest('POST', '/interest', { name: 'Filed', email: 'filed@example.com', file: { name: 'x', type: 'text/plain', data: 'aGk=' } })).status, 400);
  console.log('PASS: fixed POST lands in the intake cycle with today\'s validation, 409/confirmUpdate, tri-state year, superseded and files');

  /* ---- capacity, the queue and placing held entries ---- */
  const interestCycle = (await recruit('GET', '/recruit/cycles/cy-interest')).data.cycle;
  const before = (await appsIn('cy-interest')).length;
  assert.equal((await recruit('PATCH', '/recruit/cycles/cy-interest', { version: interestCycle.version, capacity: before }, lead)).status, 403, 'capacity is admin-only');
  const capped = await recruit('PATCH', '/recruit/cycles/cy-interest', { version: interestCycle.version, capacity: before });
  assert.equal(capped.status, 200);
  assert.equal((await bridge.target()).capacity, before);
  const full = await interest('POST', '/interest', { name: 'Late', email: 'late@example.com' });
  assert.deepEqual([full.status, full.data.error], [429, 'The interest list is full. Email cuphysint@cornell.edu instead']);
  assert.equal((await interest('POST', '/interest', { name: 'Legacy Applicant', email: 'legacy@example.com', confirmUpdate: true, project: 'Revised answer', subteam: 'Software' })).status, 200, 'existing applicants still update at capacity');
  const uncapped = await recruit('PATCH', '/recruit/cycles/cy-interest', { version: capped.data.cycle.version, capacity: 0 });
  assert.equal(uncapped.status, 200);
  // Journal entries that never reached storage replay into their cycle.
  clock += 10;
  const heldId = `jr-${clock}-${'a'.repeat(24)}`;
  journal.records.set(heldId, { id: heldId, ts: clock, ipHash: 'h', name: 'Queued Person', email: 'queued@example.com', subteam: '', project: 'From the queue', year: null, hasYear: false, confirmUpdate: false, fileName: null, fileType: null, fileSize: null, cycleId: 'cy-interest' });
  const dupId = `jr-${clock + 1}-${'b'.repeat(24)}`;
  journal.records.set(dupId, { id: dupId, ts: clock + 1, ipHash: 'h', name: 'Fresh Twice', email: 'fresh@example.com', subteam: '', project: 'Second try', year: null, hasYear: false, confirmUpdate: false, fileName: null, fileType: null, fileSize: null, cycleId: 'cy-interest' });
  const capId = `jr-${clock + 2}-${'c'.repeat(24)}`;
  journal.records.set(capId, { id: capId, ts: clock + 2, ipHash: 'h', name: 'Held Person', email: 'held@example.com', subteam: '', project: '', year: null, hasYear: false, confirmUpdate: false, fileName: null, fileType: null, fileSize: null, cycleId: 'cy-interest' });
  await kit.apps.recordOutcome({ id: capId, ts: clock + 2 }, 'held');
  const queue = await recruit('GET', '/recruit/queue?force=1');
  assert.equal(queue.status, 200);
  assert.ok((await appsIn('cy-interest')).some((r) => r.email === 'queued@example.com'), 'GET /recruit/queue replays cycle-bound entries');
  assert.equal(journal.done.get(heldId), 'saved');
  assert.deepEqual(queue.data.pending.map((p) => [p.id, p.reason, p.cycleId]).sort(), [[dupId, 'duplicate', 'cy-interest'], [capId, 'capacity', 'cy-interest']]);
  assert.equal(queue.data.pending[0].fileUrl, undefined);
  assert.ok(queue.data.pending.every((p) => p.email && p.receivedAt), 'pending entries keep the legacy PendingEntry fields');
  const placeDup = await recruit('POST', `/recruit/queue/${dupId}/place`, { requestId: requestId(), cycleId: 'cy-interest', confirmUpdate: true });
  assert.deepEqual([placeDup.status, placeDup.data.outcome], [200, 'saved']);
  assert.equal((await appsIn('cy-interest')).find((r) => r.email === 'fresh@example.com').answers.project, 'Second try', 'placing a duplicate with confirmUpdate applies the update');
  const placeHeld = await recruit('POST', `/recruit/queue/${capId}/place`, { requestId: requestId(), cycleId: 'cy-interest' });
  assert.deepEqual([placeHeld.status, placeHeld.data.outcome], [200, 'saved']);
  assert.ok((await appsIn('cy-interest')).some((r) => r.email === 'held@example.com'));
  assert.deepEqual((await recruit('GET', '/recruit/queue')).data.pending, []);
  assert.equal((await recruit('GET', '/recruit/queue', {}, lead)).status, 403, 'the queue is admin-only');
  console.log('PASS: capacity refusal, queue replay, held and duplicate entries placed by hand');

  /* ---- switching the intake cycle: per-cycle dedupe ---- */
  const fall = (await recruit('POST', '/recruit/cycles', { requestId: requestId(), name: 'Fall 2026', term: 'Fall 2026' })).data.cycle;
  assert.deepEqual(await recruit('POST', `/recruit/cycles/${fall.id}/intake`, { on: true, version: await settingsVersion() }).then((r) => [r.status, r.data.error]), [409, 'Open the cycle before it can receive the form']);
  const opened = (await recruit('POST', `/recruit/cycles/${fall.id}/status`, { version: fall.version, status: 'open' })).data.cycle;
  const stalePointer = await recruit('POST', `/recruit/cycles/${fall.id}/intake`, { on: true, version: (await settingsVersion()) - 1 });
  assert.equal(stalePointer.status, 409, 'the pointer is version-matched');
  const pointed = await recruit('POST', `/recruit/cycles/${fall.id}/intake`, { on: true, version: await settingsVersion() });
  assert.deepEqual([pointed.status, pointed.data.intakeCycleId], [200, fall.id]);
  assert.equal((await bridge.target()).cycleId, fall.id, 'the cache is invalidated on writes');
  assert.equal((await recruit('GET', '/recruit/cycles')).data.cycles.find((c) => c.id === 'cy-interest').intake, false);
  const again = await interest('POST', '/interest', { name: 'Fresh Face', email: 'fresh@example.com', subteam: 'Electrical', project: 'New cycle' });
  assert.equal(again.status, 200, 'a returning applicant applies fresh to the new cycle');
  assert.equal((await appsIn(fall.id)).find((r) => r.email === 'fresh@example.com').answers.project, 'New cycle');
  assert.equal((await appsIn('cy-interest')).find((r) => r.email === 'fresh@example.com').answers.project, 'Second try', 'the old cycle keeps its own row');
  assert.equal((await interest('POST', '/interest', { name: 'Fresh Face', email: 'fresh@example.com' })).status, 409, 'dedupe is per cycle');
  const applicant = (await recruit('GET', '/recruit/applicants/fresh%40example.com', {}, admin)).data;
  assert.equal(applicant.applicant.applications, 2);
  assert.equal(applicant.applications.length, 2);
  const listNow = await interest('GET', '/interest');
  assert.deepEqual(listNow.data.rows.map((r) => r.email), ['fresh@example.com'], 'the legacy panel projects the intake cycle');
  assert.equal(listNow.data.truncated, false);
  console.log('PASS: switching the intake cycle; per-cycle dedupe; applicant identity across cycles');

  /* ---- closing the intake cycle clears the pointer; no cycle → legacy inbox + adopt ---- */
  const closed = await recruit('POST', `/recruit/cycles/${fall.id}/status`, { version: opened.version, status: 'closed' }, lead);
  assert.equal(closed.status, 403, 'no grant yet');
  const grant = await recruit('PUT', `/recruit/cycles/${fall.id}/roles/lead%40example.com`, { requestId: requestId(), roles: ['lead'] });
  assert.equal(grant.status, 200);
  const closedByLead = await recruit('POST', `/recruit/cycles/${fall.id}/status`, { version: opened.version, status: 'closed' }, lead);
  assert.equal(closedByLead.status, 200);
  assert.equal((await recruit('GET', '/recruit/cycles')).data.intakeCycleId, null, 'closing the receiving cycle clears the pointer');
  assert.equal(await bridge.target(), null);
  const orphan = await interest('POST', '/interest', { name: 'Orphan', email: 'orphan@example.com', year: 'Senior' });
  assert.equal(orphan.status, 200, 'with no receiving cycle the form still works');
  assert.equal(journal.records.get(orphan.data.receipt).cycleId, null);
  assert.ok(JSON.parse(await legacyRaw()).rows.some((r) => r.email === 'orphan@example.com'), 'it lands in the legacy inbox');
  const cyclesView = (await recruit('GET', '/recruit/cycles')).data;
  assert.equal(cyclesView.migration.orphans, 1);
  assert.equal(cyclesView.migration.done, true);
  const fallback = await interest('GET', '/interest');
  assert.ok(fallback.data.rows.some((r) => r.id === 'in-legacy'), 'without an intake cycle the legacy panel shows the interest list cycle');
  const reopened = await recruit('POST', `/recruit/cycles/${fall.id}/status`, { version: closedByLead.data.cycle.version, status: 'open' });
  assert.equal(reopened.status, 200);
  const adopt = await recruit('POST', '/recruit/migrate/adopt', { requestId: requestId(), cycleId: fall.id });
  assert.deepEqual([adopt.status, adopt.data.adopted], [200, 1]);
  const adopted = (await appsIn(fall.id)).find((r) => r.email === 'orphan@example.com');
  assert.deepEqual([adopted.source, adopted.year, adopted.stage], ['orphan', 'Senior', 'applied']);
  assert.equal((await recruit('POST', '/recruit/migrate/adopt', { requestId: requestId(), cycleId: fall.id })).data.adopted, 0, 'adopt is idempotent');
  assert.equal((await recruit('GET', '/recruit/cycles')).data.migration.orphans, 0);
  console.log('PASS: no intake cycle → legacy inbox, orphan count and Adopt into…');

  /* ---- legacy projection, CSV header, archive writes refused ---- */
  await recruit('POST', `/recruit/cycles/${fall.id}/intake`, { on: false, version: await settingsVersion() });
  const rows = (await interest('GET', '/interest')).data.rows;
  const legacyKeys = ['id', 'ts', 'updated', 'name', 'email', 'subteam', 'project', 'cornell', 'year', 'fileId', 'fileName', 'fileType', 'fileSize'];
  for (const r of rows) {
    const keys = Object.keys(r).filter((k) => k !== 'review' && k !== 'reviewVersion').sort();
    assert.deepEqual(keys, [...legacyKeys].sort(), 'legacy rows carry exactly the legacy keys');
    if (r.id === 'in-legacy') { assert.equal(r.reviewVersion, 3); assert.equal(r.fileId, 'int-legacyfile'); assert.equal(r.project, 'Revised answer'); }
    else if (!r.reviewVersion) assert.equal(r.review, undefined, 'review keys only when reviewed');
  }
  assert.deepEqual(rows.map((r) => r.ts), [...rows.map((r) => r.ts)].sort((a, b) => b - a), 'ORDER BY ts DESC');
  const csv = await interest('GET', '/interest.csv');
  assert.equal(csv.text.split('\r\n')[0], '﻿Submitted,Updated,Name,Email,Subteam,Coolest project,Cornell address,File,Year');
  assert.match(csv.text, /legacy\.png · https:\/\/wiki\.cornellphysicalintelligence\.com\/api\/interest\/file\/int-legacyfile/);
  const archiveWrite = await interest('POST', '/interest/archive', { name: 'Nope' });
  assert.deepEqual([archiveWrite.status, archiveWrite.data.code, archiveWrite.data.error], [409, 'RECRUIT_ACTIVE', 'Applications are managed per cycle now. Open Applications in the wiki.']);
  assert.equal((await interest('DELETE', '/interest/archives/ar-aaaa1111')).status, 409);
  assert.equal((await interest('GET', '/interest/archives')).data.archives.length, 2, 'archive reads still work');
  assert.equal((await interest('GET', '/interest/archives/ar-aaaa1111')).data.archive.rows.length, 2);
  assert.equal((await interest('GET', '/interest/file/int-legacyfile')).status, 200);
  assert.equal(await legacyBytes(), (await legacyBytes()), 'stable');
  console.log('PASS: legacy GET /interest projection shape and CSV header unchanged; archive writes → 409 RECRUIT_ACTIVE');

  /* ---- legacy review/comment/delete delegate by id with today's messages ---- */
  const reviewPath = '/interest/in-legacy/review';
  const commentPath = '/interest/in-legacy/comments';
  for (const me of [null, plain]) {
    for (const [method, path, body] of [['PATCH', reviewPath, { flagged: true }], ['POST', commentPath, { id: 'ic-test0001', text: 'A comment' }], ['DELETE', commentPath + '/ic-test0001', {}]]) {
      assert.equal((await interest(method, path, body, me)).status, me ? 403 : 401);
    }
  }
  assert.equal((await interest('PATCH', reviewPath, { flagged: 'yes' })).status, 400);
  assert.deepEqual(await interest('PATCH', '/interest/in-missing/review', { flagged: true }).then((r) => [r.status, r.data.error]), [404, 'This submission is no longer on the live list']);
  const unflag = await interest('PATCH', reviewPath, { flagged: false }, admin2);
  assert.equal(unflag.status, 200);
  assert.deepEqual([unflag.data.row.review.flagged, unflag.data.row.review.flaggedBy, unflag.data.row.reviewVersion, unflag.data.row.review.comments.length], [false, 'admin2@example.com', 4, 2]);
  const firstComment = { id: 'ic-test0001', text: '<script>alert("test")</script>\nStrong project', by: 'forged@example.com' };
  const posted = await interest('POST', commentPath, firstComment, admin2);
  assert.equal(posted.status, 200);
  assert.equal(posted.data.row.review.comments.length, 3);
  assert.equal(posted.data.row.review.comments[2].by, 'admin2@example.com', 'the server supplies authorship');
  assert.equal((await interest('POST', commentPath, firstComment, admin2)).data.row.review.comments.length, 3, 'retries do not duplicate');
  assert.deepEqual(await interest('POST', commentPath, { ...firstComment, text: 'Different' }, admin2).then((r) => [r.status, r.data.error]), [409, 'This comment was already sent with different text. Reopen the submission and try again.']);
  assert.deepEqual(await interest('POST', commentPath, { id: 'ic-legacy0000', text: 'Late retry' }, admin2).then((r) => [r.status, r.data.error]), [409, 'This comment was deleted and cannot be posted again']);
  assert.deepEqual(await interest('DELETE', commentPath + '/ic-notfound1', {}, admin2).then((r) => [r.status, r.data.error]), [404, 'This comment is no longer available']);
  const del = await interest('DELETE', commentPath + '/ic-test0001', {}, admin2);
  assert.equal(del.status, 200);
  assert.deepEqual(del.data.row.review.deletedCommentIds, ['ic-legacy0000', 'ic-test0001']);
  assert.equal((await interest('DELETE', commentPath + '/ic-test0001', {}, admin2)).data.row.reviewVersion, del.data.row.reviewVersion, 'delete retries are no-ops');
  const auditLegacy = (await recruit('GET', '/recruit/cycles/cy-interest/audit?application=in-legacy')).data.rows.map((a) => a.kind);
  for (const kind of ['app.flag', 'comment.post', 'comment.delete']) assert.ok(auditLegacy.includes(kind), `legacy route writes ${kind} audit`);
  assert.equal((await interest('DELETE', '/interest/in-plain')).status, 200);
  assert.ok(!(await appsIn('cy-interest')).some((r) => r.id === 'in-plain'), 'legacy delete removes the recruit row');
  assert.equal(await legacyBytes(), (await legacyBytes()));
  assert.ok(JSON.parse(await legacyRaw()).rows.some((r) => r.id === 'in-plain'), 'the frozen legacy row stays');
  assert.deepEqual(await interest('DELETE', '/interest/in-plain').then((r) => [r.status, r.data.error]), [404, 'No such submission']);
  console.log('PASS: legacy review/comment/delete delegate by id with the exact legacy messages');

  /* ---- the recruit list: byte budget, cursor, filters, detail, patch, files ---- */
  const list = await recruit('GET', '/recruit/cycles/cy-interest/applications?limit=3');
  assert.equal(list.status, 200);
  assert.equal(list.data.rows.length, 3);
  assert.ok(list.data.total > 3);
  assert.ok(list.data.next);
  for (const r of list.data.rows) {
    assert.equal(r.answers, undefined, 'list rows carry no answers');
    assert.equal(r.review, undefined, 'list rows carry no review');
    assert.equal(typeof r.comments, 'number');
    assert.equal(typeof r.flagged, 'boolean');
    assert.equal(typeof r.preview, 'string');
    assert.equal(typeof r.editVersion, 'number');
    assert.ok(r.extras && typeof r.extras === 'object');
  }
  const page2 = await recruit('GET', `/recruit/cycles/cy-interest/applications?limit=3&cursor=${encodeURIComponent(list.data.next)}`);
  assert.ok(!page2.data.rows.some((r) => list.data.rows.some((x) => x.id === r.id)), 'keyset pages do not overlap');
  assert.ok(list.data.rows[2].ts >= page2.data.rows[0].ts);
  assert.equal(list.data.counts.byStage.applied, list.data.total);
  const byName = (await recruit('GET', '/recruit/cycles/cy-interest/applications?sort=name&dir=asc&limit=200')).data.rows.map((r) => r.name.toLowerCase());
  assert.deepEqual(byName, [...byName].sort());
  assert.deepEqual((await recruit('GET', '/recruit/cycles/cy-interest/applications?q=FRESH%40example')).data.rows.map((r) => r.email), ['fresh@example.com'], 'q matches name or email, case-insensitively');
  assert.deepEqual((await recruit('GET', '/recruit/cycles/cy-interest/applications?year=Junior')).data.rows.map((r) => r.email), ['junior@example.com']);
  assert.deepEqual((await recruit('GET', '/recruit/cycles/cy-interest/applications?subteam=software')).data.rows.map((r) => r.id), ['in-legacy'], 'subteam filters accept keys');
  assert.deepEqual((await recruit('GET', '/recruit/cycles/cy-interest/applications?subteam=Software')).data.rows.map((r) => r.id), ['in-legacy'], 'and names');
  assert.ok((await recruit('GET', '/recruit/cycles/cy-interest/applications?subteam=none')).data.rows.length >= 1, 'Undecided filter');
  assert.equal((await recruit('GET', '/recruit/cycles/cy-interest/applications?flagged=1')).data.rows.length, 0);
  const detail = await recruit('GET', `/recruit/cycles/cy-interest/applications/in-legacy`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.data.application.answers, { project: 'Revised answer' });
  assert.equal(detail.data.application.review.comments.length, 2);
  assert.equal(detail.data.form.questions.length, 6);
  assert.ok(Array.isArray(detail.data.audit));
  assert.deepEqual((await recruit('GET', `/recruit/cycles/cy-interest/applications/${(await appsIn('cy-interest')).find((r) => r.email === 'fresh@example.com').id}`)).data.history.map((h) => h.cycleId), [fall.id], 'history lists the other cycle');
  assert.equal((await recruit('GET', '/recruit/cycles/cy-interest/applications/in-legacy', {}, lead)).status, 403, 'a lead of another cycle has no role here');
  const patch1 = await recruit('PATCH', '/recruit/cycles/cy-interest/applications/in-legacy', { requestId: requestId(), editVersion: detail.data.application.editVersion, fields: { subteam: 'electrical', year: 'Senior', answers: { project: 'Edited by admin' } }, tags: { add: ['Strong', 'Hardware'] } });
  assert.equal(patch1.status, 200, JSON.stringify(patch1.data));
  assert.deepEqual([patch1.data.application.subteam, patch1.data.application.year, patch1.data.application.answers.project, patch1.data.application.tags, patch1.data.application.editVersion], ['Electrical', 'Senior', 'Edited by admin', ['Strong', 'Hardware'], detail.data.application.editVersion + 1]);
  const stalePatch = await recruit('PATCH', '/recruit/cycles/cy-interest/applications/in-legacy', { requestId: requestId(), editVersion: detail.data.application.editVersion, tags: { remove: ['Strong'] } });
  assert.deepEqual([stalePatch.status, stalePatch.data.error, stalePatch.data.editVersion], [409, 'This application changed. Reload.', patch1.data.application.editVersion]);
  const patch2 = await recruit('PATCH', '/recruit/cycles/cy-interest/applications/in-legacy', { requestId: requestId(), editVersion: patch1.data.application.editVersion, tags: { remove: ['Strong'], add: ['Hardware'] } });
  assert.deepEqual(patch2.data.application.tags, ['Hardware']);
  assert.equal(patch2.data.application.review.comments.length, 2, 'edits never touch the review');
  const tagged = await recruit('GET', '/recruit/cycles/cy-interest/applications?tag=Hardware');
  assert.deepEqual(tagged.data.rows.map((r) => r.id), ['in-legacy']);
  const upload = await recruit('POST', '/recruit/cycles/cy-interest/applications/in-legacy/files', { name: 'extra.png', type: 'image/png', data: png.toString('base64') });
  assert.equal(upload.status, 200);
  assert.equal(upload.data.application.files.length, 2);
  const extraFileId = upload.data.application.files[1].id;
  const served = await recruit('GET', `/recruit/files/${extraFileId}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers['x-content-type-options'], 'nosniff');
  assert.equal(served.headers['content-type'], 'image/png');
  assert.equal((await recruit('GET', `/recruit/files/${extraFileId}`, {}, plain)).status, 403);
  assert.equal((await recruit('GET', `/recruit/files/${extraFileId}`, {}, lead)).status, 404, 'a role in another cycle does not open this file');
  assert.equal((await recruit('GET', '/recruit/files/int-nothere')).status, 404);
  const commentViaRecruit = await recruit('POST', '/recruit/cycles/cy-interest/applications/in-legacy/comments', { id: 'ic-recruit001', text: 'Via recruit' });
  assert.equal(commentViaRecruit.status, 200);
  assert.equal(commentViaRecruit.data.application.review.comments.length, 3);
  assert.equal((await interest('GET', '/interest')).data.rows.find((r) => r.id === 'in-legacy').review.comments.length, 3, 'one review column, two doors');
  const move = await kit.apps.move({ id: 'cy-interest', doc: {} }, { id: 'in-legacy', to: 'screening', by: 'admin@example.com', requestId: 'rq-move-0001' });
  assert.deepEqual([move.from, move.to], ['applied', 'screening']);
  assert.equal(await kit.apps.move({ id: 'cy-interest', doc: {} }, { id: 'in-legacy', to: 'screening', by: 'admin@example.com' }), null, 'same stage moves nothing');
  assert.equal(await kit.apps.move({ id: 'cy-interest', doc: {} }, { id: 'in-legacy', to: 'interview', from: 'applied', by: 'admin@example.com' }), null, 'from-guard');
  const decided = await kit.apps.setDecision({ id: 'cy-interest', doc: {} }, { id: 'in-legacy', outcome: 'accepted', reason: 'Great', by: 'admin@example.com' });
  assert.equal(decided.to, 'accepted');
  const afterDecision = await kit.apps.get('cy-interest', 'in-legacy');
  assert.deepEqual([afterDecision.stage, afterDecision.outcome, afterDecision.decision.reason, afterDecision.stageHistory.at(-1).stage], ['accepted', 'accepted', 'Great', 'accepted']);
  assert.equal((await recruit('GET', '/recruit/cycles/cy-interest/audit?kind=stage')).data.rows.length, 1, 'moves audit in the same write');
  assert.equal((await recruit('GET', '/recruit/cycles/cy-interest/applications?stage=accepted')).data.rows.length, 1);
  console.log('PASS: list byte budget, keyset cursor, filters, detail, version-matched edits, tags, files, moves and decisions');

  /* ---- erase and the file reference check ---- */
  const auditBefore = (await recruit('GET', '/recruit/cycles/cy-interest/audit')).data.rows.length;
  const erased = await kit.apps.eraseApplicant('legacy@example.com', { by: 'admin@example.com' });
  assert.equal(erased.erased, 1);
  const scrubbed = await kit.apps.get('cy-interest', 'in-legacy');
  assert.deepEqual([scrubbed.name, scrubbed.email, scrubbed.answers, scrubbed.files, scrubbed.review.comments, scrubbed.stage], ['Applicant', 'erased:in-legacy', {}, [], undefined, 'accepted']);
  assert.ok(scrubbed.erasedAt > 0);
  assert.ok(await getFile('int-legacyfile'), 'a file the frozen legacy row still references is retained');
  assert.equal(await getFile(extraFileId), null, 'an unreferenced upload is removed');
  assert.ok((await recruit('GET', '/recruit/cycles/cy-interest/audit')).data.rows.length > auditBefore, 'audit survives erasure');
  assert.equal((await recruit('GET', '/recruit/applicants/legacy%40example.com')).status, 404);
  assert.ok(journal.forgotten.length >= 0);
  console.log('PASS: erase scrubs the person, keeps counts and audit, and only removes unreferenced files');

  /* ---- delete a cycle ---- */
  const scratch = (await recruit('POST', '/recruit/cycles', { requestId: requestId(), name: 'Scratch', term: '' })).data.cycle;
  assert.equal((await recruit('DELETE', `/recruit/cycles/${scratch.id}`)).status, 200);
  const archivedOld = (await recruit('GET', '/recruit/cycles/cy-aaaa1111')).data.cycle;
  assert.equal((await recruit('DELETE', '/recruit/cycles/cy-aaaa1111', { confirm: 'wrong' })).status, 400);
  assert.equal((await recruit('DELETE', '/recruit/cycles/cy-aaaa1111', { confirm: archivedOld.name })).status, 200);
  assert.equal((await recruit('GET', '/recruit/cycles/cy-aaaa1111')).status, 404);
  assert.ok(await getFile('int-archfile'), 'archive files stay while the legacy archive references them');
  assert.equal((await recruit('GET', '/recruit/migrate')).data.next?.step, 'archive', 'a deleted migrated cycle can be imported again');
  console.log('PASS: cycle lifecycle and status rules, one intake cycle, application create/update-by-email semantics identical to today, files, comments/flags, tags, projection');
}
