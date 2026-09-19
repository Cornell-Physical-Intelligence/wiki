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

function fixture({ independent = false, initialPrefsVersion = 0 } = {}) {
  let now = 1800000000000, timerId = 0, renders = 0;
  const timers = new Map(), calls = [], errors = [], documentEvents = new Map(), windowEvents = new Map();
  const listen = (events) => (type, handler) => events.set(type, [...(events.get(type) || []), handler]);
  const store = {
    s: state(), reindex() {}, me: () => ({ email: EMAIL }), session: () => EMAIL,
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
  run(`REMOTE.email = ${JSON.stringify(EMAIL)}; adoptServer(${JSON.stringify({ version: 1, state: state(), ...(independent ? { prefsVersion: initialPrefsVersion } : {}) })});`);
  return {
    run, calls, timers, context,
    get renders() { return renders; },
    values: () => JSON.parse(run('JSON.stringify(Store.prefs())')),
    adopt(version, star = '', body = 'Updated content', prefsVersion) { run(`adoptServer(${JSON.stringify({ version, state: state(star, body), ...(prefsVersion !== undefined ? { prefsVersion } : {}) })})`); },
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
  assert.equal(f.calls[0].url, '/api/state?since=1&prefsSince=-1');
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
  f.run('pollOnce()'); assert.equal(f.calls[2].url, '/api/state?since=1&prefsSince=-1');
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

// Re-selecting the original value is still a newer user edit, even when its
// fingerprint happens to equal the request that is finishing.
{
  const f = fixture();
  f.change('B'); await f.tick(1200);
  f.adopt(5, 'C'); f.change('D'); f.change('B');
  await f.reply(0, { ok: true, version: 4 });
  assert.deepEqual(f.values().starred, ['B']);
  await f.tick(1200); assert.deepEqual(f.calls[1].body.args.prefs.starred, ['B']);
  await f.reply(1, { ok: true, version: 6 });
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

// Preference-only changes sync between devices without replacing any content.
{
  const f = fixture({ independent: true });
  const pages = f.context.Store.s.pages;
  f.run('pollOnce()'); assert.equal(f.calls[0].url, '/api/state?since=1&prefsSince=0');
  await f.reply(0, { unchanged: true, version: 1, prefsVersion: 1, prefs: prefs('Other device') });
  assert.deepEqual(f.values().starred, ['Other device']);
  assert.equal(f.context.Store.s.pages, pages, 'prefs-only polls keep the existing content object');
  assert.equal(f.run('REMOTE.version'), 1); assert.equal(f.run('prefsVersion'), 1);
  assert.equal(f.renders, 1); assert.equal(f.timers.size, 0, 'received prefs are not echoed back');
  f.run('pollOnce()'); assert.equal(f.calls[1].url, '/api/state?since=1&prefsSince=1');
  await f.reply(1, { unchanged: true, version: 1, prefsVersion: 1 });
  assert.equal(f.renders, 1, 'an unchanged paired-version response causes no render');
}

// Content and preference revisions are independent, including reversed responses.
{
  const f = fixture({ independent: true, initialPrefsVersion: 2 });
  f.adopt(80, '', 'Content eighty', 2);
  f.change('B'); await f.tick(1200);
  await f.reply(0, { ok: true, version: 81, prefsVersion: 3 });
  assert.equal(f.run('REMOTE.version'), 80, 'a compact ack does not skip concurrent content');
  assert.equal(f.run('prefsVersion'), 3, 'small own revision is not confused with global 81');
  f.adopt(81, '', 'Content eighty-one', 2);
  assert.equal(f.run('Store.s.pages[0].body'), 'Content eighty-one');
  assert.deepEqual(f.values().starred, ['B'], 'newer content cannot rewind acknowledged preferences');
  f.adopt(80, 'C', 'Stale content eighty', 4);
  assert.equal(f.run('Store.s.pages[0].body'), 'Content eighty-one');
  assert.deepEqual(f.values().starred, ['C'], 'older content response can contain newer preferences');
  assert.equal(f.timers.size, 0);

  f.run('pollOnce()');
  f.adopt(82, 'C', 'Current content eighty-two', 4);
  await f.reply(1, { version: 81, prefsVersion: 5, state: state('D', 'Old poll content') });
  assert.equal(f.run('Store.s.pages[0].body'), 'Current content eighty-two');
  assert.deepEqual(f.values().starred, ['D'], 'a poll superseded for content can still update preferences');
}

// Local debounced/in-flight edits survive a prefs-only update; an older ack
// yields to newer saved values unless the user edited again during the request.
for (const newerLocal of [false, true]) {
  const f = fixture({ independent: true });
  f.adopt(30, '', 'Unchanged content', 0);
  f.change('B'); await f.tick(1200);
  f.run(`adoptServer(${JSON.stringify({ unchanged: true, version: 30, prefsVersion: 2, prefs: prefs('C') })})`);
  assert.deepEqual(f.values().starred, ['B']);
  if (newerLocal) { f.change('D'); f.change('B'); }
  await f.reply(0, { ok: true, version: 30, prefsVersion: 1, prefs: prefs('B') });
  assert.deepEqual(f.values().starred, [newerLocal ? 'B' : 'C']);
  if (newerLocal) {
    await f.tick(1200); assert.deepEqual(f.calls[1].body.args.prefs.starred, ['B']);
    await f.reply(1, { ok: true, version: 30, prefsVersion: 3 });
  }
  assert.equal(f.timers.size, 0);
}

// The new protocol can appear after a tab has already read a high legacy
// revision. A late legacy response cannot overwrite separate preferences.
{
  const f = fixture();
  f.adopt(150, 'Legacy', 'Legacy content');
  f.adopt(150, 'Migrated', 'Current content', 0);
  assert.equal(f.run('independentPrefsVersion'), true);
  assert.equal(f.run('prefsVersion'), 0); assert.deepEqual(f.values().starred, ['Migrated']);
  f.adopt(151, 'Stale legacy prefs', 'Newer content from older server');
  assert.equal(f.run('Store.s.pages[0].body'), 'Newer content from older server');
  assert.deepEqual(f.values().starred, ['Migrated']);
  assert.equal(f.run('prefsVersion'), 0); assert.equal(f.timers.size, 0);
}

// Canonical acknowledgments reconcile the visible values with server limits
// and Store defaults, instead of treating unsaved values as confirmed.
{
  const f = fixture({ independent: true });
  const stars = Array.from({ length: 101 }, (_, index) => `page-${index}`);
  f.run(`Store.prefs().starred = ${JSON.stringify(stars)}; Store.persist();`);
  await f.tick(1200);
  assert.equal(f.calls[0].body.args.prefs.starred.length, 101);
  await f.reply(0, { ok: true, version: 1, prefsVersion: 1, prefs: { starred: stars.slice(0, 100) } });
  assert.deepEqual(f.values().starred, stars.slice(0, 100));
  assert.equal(f.values().editorMode, 'split', 'canonical values receive the normal local defaults');
  assert.equal(f.run('savedPrefs'), f.run('prefsFingerprint(Store.prefs())'));
  assert.equal(f.renders, 1); assert.equal(f.timers.size, 0, 'sanitized values do not create a save loop');
  f.run('pollOnce()'); assert.equal(f.calls[1].url, '/api/state?since=1&prefsSince=1');
  await f.reply(1, { unchanged: true, version: 1, prefsVersion: 1 });
  assert.equal(f.renders, 1);
}

// A sanitized reply acknowledges its own values without replacing edits made
// while it was in flight, including reselecting the original sent value.
for (const returnToSent of [false, true]) {
  const f = fixture({ independent: true });
  f.change('B'); await f.tick(1200);
  f.change('D');
  if (returnToSent) f.change('B');
  await f.reply(0, { ok: true, version: 1, prefsVersion: 1, prefs: prefs('Canonical B') });
  const expected = returnToSent ? 'B' : 'D';
  assert.deepEqual(f.values().starred, [expected]);
  assert.deepEqual(JSON.parse(f.run('savedPrefs')).starred, ['Canonical B']);
  await f.tick(1200);
  assert.deepEqual(f.calls[1].body.args.prefs.starred, [expected]);
  await f.reply(1, { ok: true, version: 1, prefsVersion: 2, prefs: prefs(expected) });
  assert.equal(f.timers.size, 0); assert.equal(f.run('savedPrefs'), f.run('prefsFingerprint(Store.prefs())'));
}

// A paired-version prefs-only response never invents possession of content
// that was not included, even if the server reports a newer global revision.
{
  const f = fixture({ independent: true });
  f.run(`adoptServer(${JSON.stringify({ version: 5, unchanged: true, prefsVersion: 1, prefs: prefs('B') })})`);
  assert.equal(f.run('REMOTE.version'), 1);
  assert.deepEqual(f.values().starred, ['B']);
}

// A live response is adopted without rebuilding an open discussion/composer.
{
  const f = fixture();
  f.context.UI.modal = { kind: 'interest-row', id: 'synthetic' };
  f.run('pollOnce()');
  await f.reply(0, { version: 2, state: state('', 'Updated while discussing') });
  assert.equal(f.renders, 0, 'background sync cannot flash or remount a dialog');
  assert.equal(f.context.Store.s.pages[0].body, 'Updated while discussing');
  f.context.Store.me = () => null;
  f.run('pollOnce()');
  await f.reply(1, { version: 3, state: state('', 'Revoked access') });
  assert.equal(f.renders, 1, 'lost membership still redraws immediately');
}

console.log('PASS: hidden/idle/resumed polling, backoff, independent content/preferences versions, legacy fallback, serialization, adoption races and durable acknowledgments.');
