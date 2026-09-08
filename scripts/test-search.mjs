// Search tests use synthetic in-memory pages only. No server, filesystem data,
// applicant records, or network credentials are read by the application code.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const pages = [
  { id: 'hex', title: 'Hexapod', section: 'projects', tags: ['project', 'hexapod'], body: 'Six-legged robot. Next: contact replay.', updated: 8 },
  { id: 'scout', title: 'Scout', section: 'projects', tags: ['project', 'scout'], body: 'Quadruped platform.', updated: 2 },
  { id: 'replay', title: 'Contact replay procedure', section: 'software', tags: ['procedure', 'reviewed', 'hexapod'], body: 'Verify the Hexapod firmware revision and run the contact sequence. !file[Results](att:att-replay)', updated: 9 },
  { id: 'result', title: 'Contact trial 004', section: 'software', tags: ['test', 'needs-review', 'hexapod'], body: 'The experiment measured foot clearance.', parent: 'hex', updated: 10 },
  { id: 'decision', title: 'Use a conservative contact threshold', section: 'software', tags: ['decision', 'reviewed', 'hexapod'], body: 'Threshold approved after the contact replay.', updated: 7 },
  { id: 'scoutprocedure', title: 'Scout perception replay', section: 'software', tags: ['procedure', 'reviewed', 'scout'], body: 'Use the recorded perception sequence.', updated: 6 },
  { id: 'unreviewed', title: 'Electrical bringup', section: 'electrical', tags: ['procedure'], body: 'A reviewed procedure will be linked here later.', updated: 20 },
  { id: 'superseded', title: 'Old contact replay', section: 'software', tags: ['procedure', 'reviewed', 'superseded', 'hexapod'], body: 'Use Contact replay procedure instead.', updated: 1 },
  { id: 'child', title: 'An untagged child', section: 'software', tags: [], body: 'Wiring guidance.', parent: 'result', updated: 3 },
  { id: 'unsafe', title: '<img src=x onerror=alert(1)>', section: 'software', tags: ['test'], body: '<script>alert(1)</script> !file[Payload](att:att-xss)', updated: 0 },
  { id: 'accent', title: 'Café test', section: 'software', tags: ['test'], body: 'Diacritic test.', updated: 0 },
  { id: 'root-test', title: 'A standalone test record', section: 'projects', tags: ['test'], body: 'Top-level test, not a project.', updated: 0 },
];
const files = new Map([
  ['att-replay', { id: 'att-replay', name: 'hexapod-contact-replay-results.csv' }],
  ['att-xss', { id: 'att-xss', name: '<script>payload</script>.csv' }],
  ['att-private', { id: 'att-private', name: 'private-applicant-resume.pdf' }],
]);
const escape = (value) => String(value || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const listeners = {};
const context = vm.createContext({
  console,
  document: { activeElement: null, addEventListener(type, handler) { (listeners[type] ||= []).push(handler); } },
  Store: { s: { pages }, att: (id) => files.get(id), me: () => ({ role: 'member' }), prefs: () => ({ recents: ['scout', 'replay'] }) },
  MD: { mdToText: (text) => text, esc: escape },
  UI: { palette: { q: '', sel: 0, filters: {} } },
  SECTIONS: [{ id: 'software', name: 'Software' }, { id: 'electrical', name: 'Electrical' }, { id: 'projects', name: 'Projects' }],
  I: { page: '<svg></svg>', search: '<svg></svg>', check: '<svg></svg>', cube: '<svg></svg>', bolt: '<svg></svg>', link: '<svg></svg>', paperclip: '<svg></svg>', x: '<svg></svg>', chev: '<svg></svg>', plus: '<svg></svg>' },
  $: () => null,
  $$: () => [],
});
vm.runInContext(await readFile(new URL('../src/client/search.js', import.meta.url), 'utf8'), context);
const run = (code) => vm.runInContext(code, context);
const results = (query, filters = {}) => {
  context.UI.palette = { q: query, sel: 0, filters };
  return run('paletteResults()');
};
const ids = (query, filters) => Array.from(results(query, filters).items, (item) => item.page.id);

assert.equal(ids('Hexapod')[0], 'hex', 'exact page titles rank ahead of tags and prose');
assert.equal(ids('contact firmware')[0], 'replay', 'terms match across title and body');
assert.deepEqual(ids('contact firmware'), ['replay'], 'complete matches suppress partial noise');
assert.equal(results('contact nonexistent').partial, true, 'partial fallback is identified explicitly');
assert.equal(ids('hexpod')[0], 'hex', 'missing character is tolerated');
assert.equal(ids('hexpaod')[0], 'hex', 'transposed characters are tolerated');
assert.equal(ids('hexapxd')[0], 'hex', 'a mistyped character is tolerated');
assert.deepEqual(ids('xy'), [], 'short terms do not use fuzzy guessing');
assert.equal(ids('cafe')[0], 'accent', 'diacritics do not block matching');
assert.deepEqual(ids('csv', { project: 'hex' }), ['replay'], 'filenames are searchable');
assert.equal(results('csv', { project: 'hex' }).items[0].matchedFiles[0], 'hexapod-contact-replay-results.csv');
assert.deepEqual(ids('private-applicant-resume'), [], 'unreferenced file metadata is never indexed');
assert.deepEqual(ids('', { project: 'hex', type: 'procedure', status: 'reviewed', section: 'software' }), ['replay'], 'all four filters compose');
assert.deepEqual(ids('', { status: 'needs-review' }), ['result']);
assert.deepEqual(ids('', { status: 'superseded' }), ['superseded'], 'superseded takes precedence over reviewed');
assert.ok(ids('', { project: 'hex' }).includes('child'), 'project ancestry works without a tag on each child');
assert.ok(!ids('', { project: 'hex' }).includes('scoutprocedure'), 'project filter excludes other projects');
assert.ok(!ids('', { status: 'reviewed' }).includes('unreviewed'), 'recent edits and mentions never invent review status');
assert.equal(ids('')[0], 'scout', 'recents retain their saved order');
assert.ok(!run('WikiSearch.projectRoots(Store.s.pages)').some((page) => page.id === 'root-test'), 'standalone test records in Projects do not become project filters');
assert.deepEqual(ids('nothing matches this'), []);
assert.equal(run("WikiSearch.nearWord('firmware','fireware')"), true);
assert.equal(run("WikiSearch.nearWord('firmware','fileware')"), false);

// Broad tags are useful for discovery, but must never mix distinct projects.
pages.push(
  { id: 'alpha', title: 'Alpha', section: 'projects', tags: ['project', 'robotics'], body: '' },
  { id: 'beta', title: 'Beta', section: 'projects', tags: ['project', 'robotics'], body: '' },
  { id: 'alpha-procedure', title: 'Alpha procedure', parent: 'alpha', tags: ['procedure', 'robotics', 'beta'], body: '' },
  { id: 'beta-procedure', title: 'Beta procedure', parent: 'beta', tags: ['procedure', 'robotics', 'alpha'], body: '' },
  { id: 'nested-alpha', title: 'Nested Alpha configuration', parent: 'alpha-procedure', tags: ['configuration', 'robotics', 'beta'], body: '' },
  { id: 'shared-orphan', title: 'Unassigned procedure', tags: ['procedure', 'robotics'], body: '' },
  { id: 'explicit-beta', title: 'Explicit Beta configuration', tags: ['configuration', 'robotics', 'beta'], body: '' },
);
assert.deepEqual(ids('', { project: 'alpha' }).sort(), ['alpha', 'alpha-procedure', 'nested-alpha'], 'parent ancestry wins over conflicting project and broad tags');
assert.deepEqual(ids('', { project: 'beta' }).sort(), ['beta', 'beta-procedure', 'explicit-beta'], 'explicit project IDs work without sharing broad tags across projects');
assert.ok(!ids('', { project: 'alpha' }).includes('shared-orphan'), 'shared generic tags do not imply a project association');
assert.deepEqual(ids('', { project: 'alpha', type: 'configuration' }), ['nested-alpha'], 'configuration type composes with nested project ancestry');
assert.ok(run('WikiSearch.types').some((type) => type.id === 'configuration' && type.single === 'Configuration'));

// Broken parent cycles must not stall the search index.
pages.push({ id: 'cycle-a', parent: 'cycle-b', title: 'Cycle A', tags: [], body: '' }, { id: 'cycle-b', parent: 'cycle-a', title: 'Cycle B', tags: [], body: '' });
assert.ok(ids('cycle').length === 2);

// Reads reflect current state, without retaining removed pages or renamed files.
const removed = pages.splice(pages.findIndex((page) => page.id === 'replay'), 1)[0];
assert.ok(!ids('hexapod-contact-replay-results.csv').includes('replay'), 'deleted pages cannot remain in results');
pages.push(removed);
files.get('att-replay').name = 'hexapod-motor-current.csv';
assert.deepEqual(ids('motor-current'), ['replay'], 'attachment metadata changes are visible immediately');
assert.equal(results('hexapod-contact-replay-results.csv').items.some((item) => item.matchedFiles.includes('hexapod-contact-replay-results.csv')), false, 'old filenames are not cached');

results('payload');
const html = run('viewPalette()');
assert.ok(!html.includes('<script>'), 'page and file labels are escaped');
assert.ok(!html.includes('<img src=x'), 'result titles are escaped');
assert.ok(html.includes('&lt;script&gt;<mark>payload</mark>&lt;/script&gt;.csv'));
assert.ok(html.includes('role="combobox"') && html.includes('role="listbox"') && html.includes('role="option"'));
assert.ok(html.includes('aria-activedescendant="wiki-search-result-0"'));
assert.ok(html.includes('aria-selected="true"'));
results('no-result-phrase', { type: 'decision' });
const empty = run('viewPalette()');
assert.ok(empty.includes('Clear filters') && empty.includes('Clear search'), 'empty state provides recovery');
assert.ok(!empty.includes('aria-activedescendant='), 'empty list has no dangling active descendant');
assert.equal(run("WikiSearch.highlight('<b>contact</b>', 'contact', MD.esc)"), '&lt;b&gt;<mark>contact</mark>&lt;/b&gt;');
assert.equal(run("WikiSearch.terms('a '.repeat(5000)).length"), 1, 'query tokenization is bounded and deduplicated');

// The home view shares results without borrowing the modal's disposable state.
const home = run('viewSearchHome()');
assert.ok(home.includes('Search the wiki') && home.includes('search-home-input'));
assert.ok(home.includes('search-result--recent') && !home.includes('palette__snip'), 'home recents stay compact');
assert.ok(!home.includes('search-discovery') && !home.includes('search-status'), 'blank home does not advertise workflows');
assert.ok(home.includes('href="#/page/scout"') && !home.includes('#/project/'), 'home links open normal wiki pages');
assert.ok(!home.includes('class="search-filter-disclosure" open'), 'filters start collapsed');
run("UI.searchHome.q = 'replay'; UI.searchHome.filters = { section: 'software' }");
assert.ok(run('viewSearchHome()').includes('value="replay"'), 'query survives re-rendering');
results('csv');
assert.equal(run('searchHomeState().q'), 'replay', 'modal queries do not overwrite home state');
assert.equal(run('searchHomeState().filters.section'), 'software', 'home filters survive navigation and modal use');
run('UI.searchHome.sel = 3');
assert.equal(run("searchSetFilter('home', 'project', 'hex')"), true);
assert.equal(run('searchHomeState().q'), 'replay', 'custom filter selection preserves the query');
assert.equal(run('searchHomeState().filters.section'), 'software', 'custom filter selection preserves other filters');
assert.equal(run('searchHomeState().sel'), 0, 'a filter change resets result selection');
assert.ok(Array.from(run('searchResults(searchHomeState()).items')).every((item) => item.projects.includes('hex')));
assert.equal(run("searchSetFilter('home', 'project', 'missing-project')"), false, 'unknown choices cannot corrupt filter state');
assert.equal(run('searchHomeState().filters.project'), 'hex');
const customFilters = run('searchFilterHtml(searchHomeState())');
assert.ok(!customFilters.includes('<select'), 'filters never invoke a platform-native menu');
assert.equal((customFilters.match(/aria-haspopup="menu"/g) || []).length, 4);
assert.ok(customFilters.includes('data-search-filter="project" data-value="hex"'), 'the custom trigger exposes its current value');
const choices = run("searchFilterMenuHtml(searchFilterChoices(searchFilterGroups().find(group => group.id === 'project')), 'hex')");
assert.equal((choices.match(/aria-checked="true"/g) || []).length, 1, 'exactly one menu option is selected');
assert.ok(choices.includes('role="menuitemradio"'), 'exclusive choice semantics are exposed');
assert.equal(run("searchSetFilter('home', 'project', '')"), true);
assert.equal(run('searchHomeState().filters.project'), '', 'All projects clears only that filter');
assert.equal(run('searchHomeState().q'), 'replay');
context.Store.me = () => ({ email: 'another@example.com', role: 'member' });
assert.equal(run('searchHomeState().q'), '', 'another member does not inherit the previous search');

// Remote polling can replace the home DOM; keep an active caret without ever
// focusing the initial home page (which would open a phone keyboard on arrival).
context.UI.palette = null;
context.document.activeElement = { matches: (selector) => selector === '.search-home input', selectionStart: 2, selectionEnd: 5, selectionDirection: 'backward' };
run('viewSearchHome()');
let focusCount = 0, restoredSelection;
const homeSurface = {};
const replacementInput = { focus() { focusCount++; }, setSelectionRange(...selection) { restoredSelection = selection; }, removeAttribute() {} };
context.$ = (selector, surface) => selector === '.search-home' ? homeSurface : selector === 'input' && surface === homeSurface ? replacementInput : null;
run('mountSearchHome()');
assert.equal(focusCount, 1, 'an active home search is refocused after render');
assert.deepEqual(restoredSelection, [2, 5, 'backward'], 'the exact caret or selection is restored');
context.document.activeElement = null;
run('viewSearchHome(); mountSearchHome()');
assert.equal(focusCount, 1, 'initial home rendering never autofocuses');

// A custom dropdown owns keys before the palette. This is significant because
// the legacy palette handler otherwise also acts on arrows, Enter, and Escape.
context.$ = (selector) => selector === '.search-palette' ? {} : null;
context.UI.palette = { q: 'preserved', sel: 1, filters: {}, count: 2 };
let prevented = false, stopped = false;
const key = (tag, value) => ({
  key: value, target: { matches: () => tag === 'input', closest: () => null },
  preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; },
});
const menuHost = { isConnected: true };
let picked = -1, filterClosed = 0;
const menuButtons = ['All projects', 'Hexapod', 'Scout'].map((label, index) => ({
  focus() { context.document.activeElement = this; }, scrollIntoView() {}, click() { picked = index; },
}));
context.menuHost = menuHost;
context.fakeFilterClose = () => { filterClosed++; run('searchFilterMenu = null'); };
context.$$ = (selector, host) => selector === '[data-search-choice]' && host === menuHost ? menuButtons : [];
run("searchFilterMenu = { host: menuHost, close: fakeFilterClose, choices: [{label:'All projects'}, {label:'Hexapod'}, {label:'Scout'}], typed: '', typedAt: 0 }");
context.document.activeElement = menuButtons[0];
listeners.keydown[0](key('button', 'ArrowDown'));
assert.equal(context.document.activeElement, menuButtons[1], 'arrow keys move within the dropdown');
assert.equal(context.UI.palette.sel, 1, 'dropdown navigation cannot move palette selection');
assert.equal(prevented, true);
assert.equal(stopped, true);
listeners.keydown[0](key('button', 's'));
assert.equal(context.document.activeElement, menuButtons[2], 'typeahead reaches a choice in a long menu');
listeners.keydown[0](key('button', 'Enter'));
assert.equal(picked, 2, 'Enter chooses the focused dropdown option');
listeners.keydown[0](key('button', 'Escape'));
assert.equal(filterClosed, 1);
assert.ok(context.UI.palette, 'first Escape closes the dropdown and leaves search open');

// Clicking an expanded trigger closes it on pointerdown; its subsequent click
// must not accidentally reopen it after mountMenu's outside-click handler ran.
const trigger = {};
context.fakeTrigger = trigger;
run('searchFilterMenu = { host: menuHost, anchor: fakeTrigger, close: fakeFilterClose }');
const click = { target: { closest: () => trigger }, preventDefault() {}, stopImmediatePropagation() {} };
listeners.pointerdown[0](click);
listeners.click[0](click);
assert.equal(filterClosed, 2, 'the expanded trigger toggles closed once');
assert.equal(run('searchFilterMenu'), null);

// mountMenu may close itself on outside pointerdown; its focus restoration
// must clear the custom trigger's expanded state as well.
const triggerAttrs = {};
context.detachedMenu = { isConnected: false };
context.cleanupTrigger = { setAttribute(name, value) { triggerAttrs[name] = value; }, removeAttribute(name) { delete triggerAttrs[name]; } };
run('searchFilterMenu = { host: detachedMenu, anchor: cleanupTrigger }');
listeners.focusin[0]({ target: {} });
assert.equal(triggerAttrs['aria-expanded'], 'false');
assert.equal(run('searchFilterMenu'), null, 'outside-close cannot leave an orphan menu reference');
prevented = false; stopped = false;
listeners.keydown[0](key('button', 'Enter'));
assert.equal(prevented, false, 'native button activation is preserved');
assert.equal(stopped, true);
context.Store.me = () => null;
assert.equal(run('paletteResults().items.length'), 0, 'logged-out searches expose no cached pages');
console.log('PASS: search relevance and visibility, custom filter values and menu lifecycle, keyboard ownership, compact home, independent state and caret restoration');
