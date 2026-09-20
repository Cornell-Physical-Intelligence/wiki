// Static contract for recruit modules: loads every server module in
// lib/recruit/modules and every client module in src/client (recruit-*.js,
// in a vm sandbox) and checks the shapes the registry and RECRUIT rely on.
// No storage, no network, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('..', import.meta.url));
const modulesDir = join(root, 'lib/recruit/modules');
const clientDir = join(root, 'src/client');
const { compileRoute } = await import(pathToFileURL(join(root, 'lib/recruit/registry.js')));
const { ACCESS_LEVELS } = await import(pathToFileURL(join(root, 'lib/recruit/permissions.js')));

const serverFiles = existsSync(modulesDir) ? readdirSync(modulesDir).filter((f) => f.endsWith('.js')).sort() : [];
const clientFiles = existsSync(clientDir) ? readdirSync(clientDir).filter((f) => /^recruit-[a-z]+\.js$/.test(f) && f !== 'recruit-core.js').sort() : [];
const ALLOWED_IMPORTS = /^(node:[a-z_/]+|\.\.\/fixed-form\.js|\.\.\/sections\.js|\.\.\/mailer\.js|\.\.\/migrate\.js|\.\.\/permissions\.js)$/;
const KERNEL = new Set(['cycles', 'applications', 'roles', 'site']);

test('every server module file exports the module object shape', async () => {
  assert.ok(serverFiles.length >= 3, 'the kernel modules exist');
  const names = new Set();
  const routeKeys = new Set();
  for (const file of serverFiles) {
    const source = readFileSync(join(modulesDir, file), 'utf8');
    for (const m of source.matchAll(/^\s*import\s+[^'"]*['"]([^'"]+)['"]/gm)) {
      assert.match(m[1], ALLOWED_IMPORTS, `${file} imports ${m[1]}; modules import only node built-ins and the pure helpers`);
    }
    assert.doesNotMatch(source, /import\(\s*['"]\.\.?\/modules\//, `${file} must not import a sibling module`);
    assert.doesNotMatch(source, /['"]\.\.\/\.\.\/db\.js['"]/, `${file} must not import db.js`);
    const mod = (await import(pathToFileURL(join(modulesDir, file)))).default;
    assert.ok(mod && typeof mod === 'object', `${file} default-exports an object`);
    assert.match(String(mod.name), /^[a-z]+$/, `${file}: name`);
    assert.equal(mod.name, file.replace(/\.js$/, ''), `${file}: the file is named after the module`);
    assert.ok(!names.has(mod.name), `${file}: duplicate module name`);
    names.add(mod.name);
    assert.equal(typeof mod.kernel, 'boolean', `${file}: kernel flag`);
    assert.equal(mod.kernel, KERNEL.has(mod.name), `${file}: only cycles/applications/roles are kernel`);
    assert.equal(typeof mod.order, 'number', `${file}: order`);
    if (mod.kernel) assert.ok(mod.order >= 0 && mod.order <= 20, `${file}: kernel order 0-20`);
    const schema = typeof mod.schema === 'function' ? mod.schema([]) : mod.schema;
    assert.ok(Array.isArray(schema) && schema.every((s) => typeof s === 'string'), `${file}: schema strings`);
    for (const s of schema) {
      assert.match(s, /^\s*(CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS|CREATE UNIQUE INDEX IF NOT EXISTS|ALTER TABLE .* ADD COLUMN IF NOT EXISTS|ALTER TABLE .* DROP CONSTRAINT IF EXISTS|INSERT INTO recruit_settings .* ON CONFLICT DO NOTHING)/s, `${file}: schema is additive only`);
      assert.doesNotMatch(s.replace(/DROP CONSTRAINT IF EXISTS \w+/i, ''), /\b(DROP|RENAME|BEGIN|COMMIT)\b/i, `${file}: schema never drops tables or renames`);
    }
    assert.ok(mod.memory && typeof mod.memory === 'object', `${file}: memory collections`);
    assert.equal(typeof mod.defaults, 'function', `${file}: defaults(cycle)`);
    assert.equal(typeof mod.validateSettings, 'function', `${file}: validateSettings`);
    assert.ok(Array.isArray(mod.routes), `${file}: routes`);
    assert.ok(mod.hooks && typeof mod.hooks === 'object', `${file}: hooks`);
    assert.ok(mod.collect && typeof mod.collect === 'object', `${file}: collect`);
    assert.ok(Array.isArray(mod.auditKinds), `${file}: auditKinds`);
    for (const r of mod.routes) {
      assert.match(r.method, /^(GET|POST|PUT|PATCH|DELETE)$/, `${file}: ${r.path} method`);
      assert.match(String(r.path), /^\/[A-Za-z0-9:._\/-]*$/, `${file}: ${r.path} is an anchored relative path`);
      assert.doesNotThrow(() => compileRoute(r, mod), `${file}: ${r.path} uses known params`);
      assert.ok(ACCESS_LEVELS.includes(r.access), `${file}: ${r.method} ${r.path} declares access`);
      assert.equal(typeof r.handler, 'function', `${file}: ${r.method} ${r.path} handler`);
      const key = `${r.method} ${r.path}`;
      assert.ok(!routeKeys.has(key), `${key} declared twice`);
      routeKeys.add(key);
      if (r.cap !== undefined) assert.ok(r.cap > 0 && r.cap <= 3600000, `${file}: ${r.path} cap`);
    }
    // Every audit kind the source writes must be declared.
    const literals = new Set();
    for (const m of source.matchAll(/audit\s*(?::|\()\s*\{[^}]*?kind:\s*(?:'([^']+)'|`([^`]+)`)/g)) {
      const kind = (m[1] || m[2]).replace(/\$\{.*$/, '').replace(/\.$/, '');
      literals.add(kind);
    }
    for (const kind of literals) {
      assert.ok(mod.auditKinds.some((k) => k === kind || k.startsWith(kind) || kind.startsWith(k)), `${file}: audit kind "${kind}" is not in auditKinds`);
    }
    for (const [event, fn] of Object.entries(mod.hooks)) assert.equal(typeof fn, 'function', `${file}: hook ${event}`);
    for (const [event, fn] of Object.entries(mod.collect)) {
      assert.equal(typeof fn, 'function', `${file}: collector ${event}`);
      assert.ok(['scope.applications', 'application.extras', 'csv.columns', 'purge'].includes(event), `${file}: unknown collect event ${event}`);
    }
  }
  for (const k of KERNEL) assert.ok(names.has(k), `kernel module ${k} exists`);
});

test('the kernel modules provide the kit facades', async () => {
  const cycles = (await import(pathToFileURL(join(modulesDir, 'cycles.js')))).default;
  const applications = (await import(pathToFileURL(join(modulesDir, 'applications.js')))).default;
  assert.equal(typeof cycles.provide, 'function');
  assert.equal(typeof applications.provide, 'function');
  const fakeKit = { mode: 'memory', modules: [cycles, applications], tables: new Set(), mem: { settings: null, cycles: [], applications: [], applicants: [], receipts: {}, audit: [], roles: [] }, memSave() {}, cached: (k, t, f) => f(), uncache() {}, id: () => 'x', now: () => 0, build: () => {}, asArray: (v) => v, asObject: (v) => v, files: {} };
  const c = cycles.provide(fakeKit).cycles;
  for (const fn of ['get', 'intakeTarget', 'enabled', 'list', 'settings', 'migrated', 'defaultDoc']) assert.equal(typeof c[fn], 'function', `kit.cycles.${fn}`);
  const a = applications.provide({ ...fakeKit, cycles: c }).apps;
  for (const fn of ['get', 'list', 'commitIntake', 'move', 'setDecision', 'patch', 'remove', 'toLegacyRow', 'updateReview', 'ids', 'findByEmail', 'count']) assert.equal(typeof a[fn], 'function', `kit.apps.${fn}`);
});

// A permissive sandbox: any global the client file touches at load time
// resolves to an inert stub, except RECRUIT which captures registrations.
function sandbox(captured) {
  const stub = new Proxy(function stubFn() { return stub; }, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : k === Symbol.iterator ? function* () {} : stub),
    apply: () => stub, construct: () => stub, has: () => true,
  });
  const RECRUIT = { modules: [], register(m) { captured.push(m); }, find() { return null; } };
  const own = { RECRUIT, console, Set, Map, Array, Object, JSON, String, Number, Boolean, Math, Date, Promise, Error, Symbol, RegExp, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, AbortSignal, crypto: globalThis.crypto, undefined };
  return vm.createContext(new Proxy(own, {
    has: () => true,
    get: (t, k) => (k in t ? t[k] : k === Symbol.unscopables ? undefined : stub),
  }));
}

test('every client module registers exactly once with recruit- prefixed keys', () => {
  if (!clientFiles.length) { console.log('no client module files yet; skipped'); return; }
  const core = join(clientDir, 'recruit-core.js');
  assert.ok(existsSync(core), 'recruit-core.js exists when module files do');
  assert.match(readFileSync(core, 'utf8'), /function validateRecruitModule/, 'recruit-core.js validates registrations');
  const names = new Set();
  for (const file of clientFiles) {
    const source = readFileSync(join(clientDir, file), 'utf8');
    assert.equal((source.match(/RECRUIT\.register\(/g) || []).length, 1, `${file}: exactly one RECRUIT.register`);
    assert.doesNotMatch(source, /<select\b|<datalist\b/i, `${file}: no native select or datalist`);
    const captured = [];
    vm.runInContext(source, sandbox(captured), { filename: file });
    assert.equal(captured.length, 1, `${file}: register ran once at load`);
    const m = captured[0];
    assert.match(String(m.name), /^[a-z]+$/, `${file}: name`);
    assert.equal(file, `recruit-${m.name}.js`, `${file}: the file is named after the module`);
    assert.ok(!names.has(m.name), `${file}: duplicate name`);
    names.add(m.name);
    assert.equal(typeof m.order, 'number', `${file}: order`);
    for (const group of ['actions', 'inputs', 'dd', 'modals']) {
      for (const key of Object.keys(m[group] || {})) assert.ok(key.startsWith('recruit-'), `${file}: ${group} key ${key} must start with recruit-`);
    }
    if (m.panel) assert.equal(typeof m.panel.when, 'function', `${file}: panel.when`);
  }
});
