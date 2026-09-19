import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/client/ui2.js', import.meta.url), 'utf8');
const rows = [
  { id: 'a', name: 'Ada', email: 'ada@example.test', subteam: 'Electrical', year: 'Junior', ts: 1, review: { flagged: true, comments: [{}] } },
  { id: 'b', name: 'Bo', email: 'bo@example.test', subteam: 'Mechanical', year: 'Senior', ts: 2, review: { flagged: true, comments: [] } },
  { id: 'c', name: 'Cy', email: 'cy@example.test', subteam: 'Electrical', year: 'Junior', ts: 3, review: { comments: [] } },
  { id: 'd', name: 'Dee', email: 'dee@example.test', subteam: '', ts: 4 },
];
const label = {}, host = { querySelector: () => label };
let menu, renders = 0;
const context = vm.createContext({ UI: {}, I: { check: 'check' }, interestSource: () => rows,
  interestYears: ['Freshman', 'Sophomore', 'Junior', 'Senior', 'Grad'],
  openMenu(items, anchor) { menu = items; assert.equal(anchor, host); }, renderInterestRows() { renders++; },
});
vm.runInContext(source.slice(source.indexOf('function interestFilterOptions'), source.indexOf('// Compact columns')), context);
const run = (code) => vm.runInContext(code, context);
const ids = () => Array.from(run('interestVisible()'), (r) => r.id);
assert.deepEqual(ids(), ['d', 'c', 'b', 'a']);
context.UI.interestSubteam = 'Electrical';
assert.deepEqual(ids(), ['c', 'a']);
context.UI.interestFilter = 'flagged';
assert.deepEqual(ids(), ['a']);
assert.equal(run('interestFilterLabel()'), 'Flagged · Electrical');
context.UI.interestQuery = 'BO';
assert.deepEqual(ids(), [], 'search and subteam/review constraints are combined');
context.UI.interestQuery = 'ada';
assert.deepEqual(ids(), ['a']);
context.UI.interestQuery = '';
context.UI.interestFilter = 'comments';
assert.deepEqual(ids(), ['a']);
context.UI.interestSubteam = '__undecided';
context.UI.interestFilter = 'all';
assert.deepEqual(ids(), ['d']);
assert.equal(run('interestFilterLabel()'), 'Undecided');
run('openInterestFilter')(host);
assert.equal(menu.filter((o) => o.selected).length, 2, 'each independent filter has its own selected choice');
assert.equal(menu.filter((o) => o.label === 'Electrical').length, 1, 'subteam choices are deduplicated');
menu.find((o) => o.label === 'Mechanical').run();
assert.equal(label.textContent, 'Mechanical');
assert.deepEqual(ids(), ['b']);
menu.find((o) => o.label === 'All subteams').run();
assert.equal(label.textContent, 'All people');
assert.equal(renders, 2, 'menu changes only patch the list');
assert.deepEqual(ids(), ['d', 'c', 'b', 'a']);
context.interestSource = () => [{ id: 'archive', name: 'Archived', email: 'archive@example.test', subteam: 'Software', ts: 1 }];
assert.deepEqual(Array.from(run('interestFilterOptions()').filter((o) => o.group === 'subteam'), (o) => o.label), ['All subteams', 'Software'], 'archived filters use the archived list');
console.log('PASS: subteam choices, combined search/review filters, undecided, reset, local row updates and archived sources');
