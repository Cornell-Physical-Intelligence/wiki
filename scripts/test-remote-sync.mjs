// Real remote adapter, synthetic browser/state, controlled responses and clock.
// No production data, network, browser storage or credentials are accessed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/remote.js', import.meta.url), 'utf8');
const EMAIL = 'synthetic@example.test';
const prefs = (star = '') => ({ starred: star ? [star] : [], recents: [], collapsed: [], editorMode: 'split' });
const state = (star = '', body = 'Initial content') => ({ users: [], pages: [{ id: 'page', body }], trash: [], activity: [], prefs: { [EMAIL]: prefs(star) } });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  let now = 1800000000000, timerId = 0, renders = 0;
  const timers = new Map(), calls = [], errors = [], documentEvents = new Map(), windowEvents = new Map();
  const listen = (events) => (type, handler) => events.set(type, [...(events.get(type) || []), handler]);
  const store = {
    s: state(), reindex() {}, session: () => EMAIL,
    prefs() {
      const p = this.s.prefs[this.session()] ||= {};
      for (const key of ['starred', 'recents', 'collapsed']) if (!Array.isArray(p[key])) p[key] = [];
      if (!p.editorMode) p.editorMode = 'split';
      return p;
    },
  };
  for (const name of ['createPage', 'toggleTask', 'restoreRev', 'deletePage', 'restorePage', 'purgePage', 'movePage', 'toggleReaction', 'setProfile', 'setEmailSettings', 'setRole', 'removeUser', 'savePage', 'addMembers']) store[name] = () => ({});
  const context = vm.createContext({
    Store: store, UI: { editor: null }, Files: { mem: new Map() },
    document: { hidden: false, addEventListener: listen(documentEvents) },
    window: { addEventListener: listen(windowEvents) },
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() {},
    fetch(url, options) {
      return new Promise((resolve, reject) => calls.push({ url, body: options?.body ? JSON.parse(options.body) : null, resolve, reject }));
    },
    render() { renders++; }, toast() {}, viewLogin() {},
  });
  const run = (code) => vm.runInContext(code, context);
  vm.runInContext(source, context);
  run(`REMOTE.email = ${JSON.stringify(EMAIL)}; adoptServer(${JSON.stringify({ version: 1, state: state() })});`);
  return {
    run, calls, timers, context,
    get renders() { return renders; },
    values: () => JSON.parse(run('JSON.stringify(Store.prefs())')),
    adopt(version, star = '', body = 'Updated content') { run(`adoptServer(${JSON.stringify({ version, state: state(star, body) })})`); },
    change(star) { run(`Store.prefs().starred = [${JSON.stringify(star)}]; Store.persist();`); },
    fire(type, surface = 'document') {
      for (const handler of (surface === 'document' ? documentEvents : windowEvents).get(type) || []) handler();
    },
    async tick(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, value] = next;
        timers.delete(id); now = value.at;
        const result = value.fn();
        result?.catch((error) => errors.push(error));
        await settle();
      }
      now = until;
      await settle();
      assert.deepEqual(errors, []);
    },
    async reply(index, data, status = 200) {
      calls[index].resolve({ ok: status >= 200 && status < 300, status, json: async () => data });
      await settle();
    },
  };
}

// Quiet tabs do no work; resuming activity starts one poll, with overlap guards.
{
  const f = fixture();
  f.context.document.hidden = true;
  await f.run('pollOnce()'); assert.equal(f.calls.length, 0);
  f.context.document.hidden = false;
  await f.tick(300000);
  await f.run('pollOnce()'); assert.equal(f.calls.length, 0, 'idle visible tabs stop polling');
  f.fire('pointerdown'); f.fire('focus', 'window'); f.fire('visibilitychange');
  assert.equal(f.calls.length, 1, 'resume triggers one request despite overlapping events');
  assert.equal(f.calls[0].url, '/api/state?since=1');
  await f.reply(0, { unchanged: true, version: 1 });
  assert.equal(f.renders, 0);
}

// Failed polls back off; successful polls clear the delay.
{
  const f = fixture();
  f.run('pollOnce()'); await f.reply(0, { error: 'Temporarily unavailable' }, 503);
  await f.run('pollOnce()'); assert.equal(f.calls.length, 1);
  await f.tick(49999); await f.run('pollOnce()'); assert.equal(f.calls.length, 1);
  await f.tick(1); f.run('pollOnce()'); assert.equal(f.calls.length, 2);
  await f.reply(1, { unchanged: true, version: 1 });
  assert.equal(f.run('pollFailures'), 0); assert.equal(f.run('pollAfter'), 0);
}

// A resumed poll cannot clobber an edit/save or newer state arriving in flight.
for (const during of ['UI.editor = {dirty:true}', 'REMOTE.pending++', `adoptServer(${JSON.stringify({ version: 3, state: state('', 'Newer state') })})`]) {
  const f = fixture();
  f.run('pollOnce()'); f.run(during);
  await f.reply(0, { version: 2, state: state('', 'Stale poll') });
  assert.notEqual(f.run('Store.s.pages[0].body'), 'Stale poll');
}
{
  const f = fixture();
  f.adopt(3, '', 'Newest response'); f.adopt(2, '', 'Older operation response');
  assert.equal(f.run('REMOTE.version'), 3);
  assert.equal(f.run('Store.s.pages[0].body'), 'Newest response');
}

// Equal preferences send nothing; rapid changes serialize and keep the latest.
{
  const f = fixture();
  f.run('Store.persist(); Store.s.prefs[REMOTE.email] = Object.fromEntries(Object.entries(Store.prefs()).reverse()); Store.persist();');
  await f.tick(1200); assert.equal(f.calls.length, 0);
  f.change('B'); await f.tick(1199); assert.equal(f.calls.length, 0);
  await f.tick(1); assert.equal(f.calls.length, 1);
  f.change('C'); await f.tick(1200); assert.equal(f.calls.length, 1, 'one preferences request at a time');
  await f.reply(0, { ok: true, version: 2 });
  assert.equal(f.run('REMOTE.version'), 1, 'compact acknowledgments cannot advance content version');
  await f.tick(1200); assert.deepEqual(f.calls[1].body.args.prefs.starred, ['C']);
  await f.reply(1, { ok: true, version: 3 });
  assert.equal(f.timers.size, 0);
  f.run('pollOnce()'); assert.equal(f.calls[2].url, '/api/state?since=1');
  await f.reply(2, { version: 3, state: state('C', 'Concurrent content change') });
  assert.equal(f.run('Store.s.pages[0].body'), 'Concurrent content change');
}

// Adopting a full response preserves changes waiting for the debounce/request.
for (const inFlight of [false, true]) {
  const f = fixture();
  f.change('B');
  if (inFlight) await f.tick(1200);
  f.adopt(2);
  assert.deepEqual(f.values().starred, ['B']);
  if (!inFlight) await f.tick(1200);
  assert.deepEqual(f.calls[0].body.args.prefs.starred, ['B']);
  await f.reply(0, { ok: true, version: 3 });
  assert.equal(f.timers.size, 0, 'stale adopted preferences must not be written back as a rollback');
  f.adopt(2, '', 'Older snapshot arriving after acknowledgment');
  assert.deepEqual(f.values().starred, ['B'], 'a late snapshot cannot rewind acknowledged preferences');
  assert.equal(f.timers.size, 0);
}

// Newer server prefs win over an older ack, except edits made after that request.
for (const newerLocal of [false, true]) {
  const f = fixture();
  f.change('B'); await f.tick(1200);
  f.adopt(5, 'C');
  if (newerLocal) f.change('D');
  await f.reply(0, { ok: true, version: 4 });
  assert.deepEqual(f.values().starred, [newerLocal ? 'D' : 'C']);
  if (newerLocal) {
    await f.tick(1200); assert.deepEqual(f.calls[1].body.args.prefs.starred, ['D']);
    await f.reply(1, { ok: true, version: 6 });
  } else assert.equal(f.timers.size, 0);
}

// A persist requested during a failing request is retained and retried with spacing.
{
  const f = fixture();
  f.change('B'); await f.tick(1200);
  f.change('C'); await f.tick(1200);
  await f.reply(0, { error: 'Offline' }, 503);
  assert.deepEqual(f.values().starred, ['C']);
  await f.tick(4999); assert.equal(f.calls.length, 1);
  await f.tick(1); assert.deepEqual(f.calls[1].body.args.prefs.starred, ['C']);
  await f.reply(1, { ok: true, version: 2 });
  assert.equal(f.run('REMOTE.pending'), 0); assert.equal(f.timers.size, 0);
}

// An unconfirmed response stays dirty, and a later persist can retry it.
{
  const f = fixture();
  f.change('B'); await f.tick(1200); await f.reply(0, {});
  assert.deepEqual(f.values().starred, ['B']);
  assert.notEqual(f.run('savedPrefs'), f.run('prefsFingerprint(Store.prefs())'));
  f.run('Store.persist()'); await f.tick(5000);
  await f.reply(1, { version: 2, state: state('B') }); // Compatible older backend response.
  assert.equal(f.run('savedPrefs'), f.run('prefsFingerprint(Store.prefs())'));
  assert.equal(f.run('REMOTE.version'), 1);
}

console.log('PASS: hidden/idle/resumed polling, backoff/stale-response guards, prefs deduplication/serialization, adoption races, failures and compact acknowledgments.');
