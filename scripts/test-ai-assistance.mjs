// Pure fixtures and injected transports; never use credentials or the network.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { generateChangeSummary as generateTrackedSummary, validateChangeSummary } from '../lib/change-summary.js';
import { reviewPage, validatePageReview, pageReviewSuggestions } from '../lib/page-review.js';
import { meaningSearch, validateMeaningSearch } from '../lib/meaning-search.js';

// Provider contracts inject accounting; concurrent spend enforcement is tested separately.
const generateChangeSummary = (input, options) => generateTrackedSummary(input, { actor: 'synthetic@example.test', ledger: { reserve: async () => ({ allowed: true, id: 'fixture' }), settle: async () => true }, ...options });

const input = { title: 'Wiring', beforeTitle: 'Wiring', section: 'Electrical', beforeSection: 'Electrical', diff: '- 5V\n+ 3.3V', isNew: false, truncated: false };
assert.deepEqual(validateChangeSummary(input), input);
for (const bad of [null, [], { ...input, diff: 'x'.repeat(12001) }, { ...input, title: '' }, { ...input, isNew: 'yes' }]) assert.equal(validateChangeSummary(bad), null);
assert.deepEqual(await generateChangeSummary(input, { apiKey: '' }), { available: false, reason: 'not_configured' });
let calls = 0;
const options = { apiKey: 'synthetic-summary', fetchImpl: async (url, init) => {
  calls++;
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(init.headers.authorization, 'Bearer synthetic-summary');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'gpt-5.6-luna'); assert.equal(body.store, false);
  assert.equal(body.reasoning.effort, 'none'); assert.equal(body.max_output_tokens, 160);
  assert.deepEqual(JSON.parse(body.input), input);
  return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Changed the sensor supply to 3.3V' }] }] }) };
} };
const summaries = await Promise.all([generateChangeSummary(input, options), generateChangeSummary(input, options)]);
assert.equal(calls, 1, 'simultaneous previews coalesce');
assert.equal(summaries[0].summary, 'Changed the sensor supply to 3.3V');
for (const [name, response] of [['error', { ok: false }], ['incomplete', { ok: true, json: async () => ({ status: 'incomplete' }) }], ['long', { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'x'.repeat(121) }] }] }) }]]) {
  assert.equal((await generateChangeSummary(input, { apiKey: `synthetic-${name}`, fetchImpl: async () => response })).available, false);
}
assert.equal((await generateChangeSummary(input, { apiKey: 'synthetic-timeout', fetchImpl: async () => { throw new Error('timeout'); } })).available, false);

// The selected model and effort belong in both transport and cache identity.
let selectedCalls = 0;
const selectedFetch = async (_, init) => {
  selectedCalls++;
  const body = JSON.parse(init.body);
  assert.equal(body.reasoning.effort, 'low');
  assert.equal(body.max_output_tokens, 1024);
  return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Updated selected model' }] }] }) };
};
await generateChangeSummary(input, { apiKey: 'selected-fixture', model: 'gpt-5.6-luna', effort: 'low', fetchImpl: selectedFetch });
await generateChangeSummary(input, { apiKey: 'selected-fixture', model: 'gpt-6-astra', effort: 'low', fetchImpl: selectedFetch });
assert.equal(selectedCalls, 2, 'model changes cannot reuse another model’s cached response');

const page = { title: 'Sensor wiring', body: 'Example page', section: 'creative', truncated: false };
assert.deepEqual(validatePageReview(page), page);
assert.equal(validatePageReview({ ...page, body: 'x'.repeat(18001) }), null);
assert.equal(validatePageReview({ ...page, section: '__proto__' }), null);
const answers = { section: { type: 'choice', choice: 'electrical', probabilities: { electrical: .99 }, confidence: .95 }, unfinished: { type: 'noul', noul: .99 }, unowned: { type: 'noul', noul: .95 } };
assert.deepEqual(pageReviewSuggestions(answers, page), [{ kind: 'section', section: 'electrical' }, { kind: 'unfinished' }, { kind: 'unowned' }]);
assert.deepEqual(pageReviewSuggestions(answers, { ...page, truncated: true }), [{ kind: 'unfinished' }]);
assert.deepEqual(pageReviewSuggestions({ section: { ...answers.section, confidence: .6 }, unfinished: { type: 'noul', noul: .4 } }, page), []);
assert.deepEqual(pageReviewSuggestions({ section: { ...answers.section, choice: 'bad' }, unfinished: { type: 'noul', noul: '1' }, unowned: { type: 'noul', noul: 9 } }, page), []);
let reviews = 0;
const reviewOptions = { apiKey: 'synthetic-review', fetchImpl: async (url, init) => {
  reviews++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  const body = JSON.parse(init.body); assert.equal(body.model, 'jev-latest'); assert.equal(Object.keys(body.questions).length, 3);
  return { ok: true, json: async () => ({ answers }) };
} };
await Promise.all([reviewPage(page, reviewOptions), reviewPage(page, reviewOptions)]);
assert.equal(reviews, 1);
assert.equal((await reviewPage(page, { apiKey: 'synthetic-review-timeout', fetchImpl: async () => { throw new Error('timeout'); } })).available, false);

const related = [{ id: 'sensor-test', title: 'Sensor test', excerpt: 'Apply 5V to the supply.' }];
const changedPage = { ...page, diff: '- Supply: 5V\n+ Supply: 3.3V', related };
assert.deepEqual(validatePageReview(changedPage), changedPage);
assert.deepEqual(pageReviewSuggestions({ impact_0: { type: 'noul', noul: .98 } }, changedPage), [{ kind: 'impact', pageId: 'sensor-test' }]);
assert.deepEqual(pageReviewSuggestions({ impact_0: { type: 'noul', noul: .8 } }, changedPage), []);
assert.deepEqual(pageReviewSuggestions({ impact_0: { type: 'noul', noul: .99 } }, { ...changedPage, diff: '' }), []);
assert.equal(validatePageReview({ ...changedPage, related: [...related, ...related] }), null, 'related page IDs must be unique');
await reviewPage(changedPage, { apiKey: 'synthetic-impact', fetchImpl: async (_, init) => {
  assert.equal(JSON.parse(init.body).questions.impact_0.type, 'noul');
  return { ok: true, json: async () => ({ answers: {} }) };
} });

const searchInput = { query: 'The robot restarts when the wheels start moving', candidates: [
  { id: 'power', title: 'Power integrity', excerpt: 'Brownouts during motor startup: scope the regulator output.' },
  { id: 'logo', title: 'Branding', excerpt: 'Approved team colors and fonts.' },
  { id: 'wheels', title: 'Wheel drawings', excerpt: 'Machining tolerances.' },
] };
assert.deepEqual(validateMeaningSearch(searchInput), searchInput);
for (const bad of [{ ...searchInput, candidates: [] }, { ...searchInput, candidates: [...searchInput.candidates, searchInput.candidates[0]] }, { ...searchInput, query: 'x'.repeat(301) }]) assert.equal(validateMeaningSearch(bad), null);
const searchOut = await meaningSearch(searchInput, { apiKey: 'synthetic-meaning', fetchImpl: async (_, init) => {
  const body = JSON.parse(init.body); assert.equal(Object.keys(body.questions).length, 3);
  return { ok: true, json: async () => ({ answers: { page_0: { type: 'noul', noul: .99 }, page_1: { type: 'noul', noul: '1' }, page_2: { type: 'noul', noul: .5 }, page_100: { type: 'noul', noul: 1 } } }) };
} });
assert.deepEqual(searchOut, { available: true, ids: ['power'] }, 'only supplied IDs with strong valid evidence can be returned');
assert.deepEqual(await meaningSearch(searchInput, { apiKey: '' }), { available: false, ids: [] });

const ui = await readFile(new URL('../src/client/ui2.js', import.meta.url), 'utf8');
const store = await readFile(new URL('../src/client/store.js', import.meta.url), 'utf8');
const helpers = ui.slice(ui.indexOf('function edChangePreview'), ui.indexOf('async function edCommit'));
const modalView = ui.slice(ui.indexOf('function viewModal()'), ui.indexOf('/* ------------------------------- video hydration'));
const diff = store.slice(store.indexOf('function diffLines'), store.indexOf('/* ------------------------------- IndexedDB'));
const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  let now = 100000, timerId = 0;
  const timers = new Map();
  const timer = (fn, delay = 0) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; };
  const requests = [], fields = { summary: { value: '', placeholder: '' }, status: { textContent: '', hidden: true }, save: { disabled: false }, review: { innerHTML: '', hidden: true } };
  const editor = { title: 'Wiring', origTitle: 'Wiring', body: 'Use 3.3V', origBody: 'Use 5V', section: 'electrical', origSection: 'electrical', isNew: false };
  const ctx = vm.createContext({ UI: { editor }, REMOTE: {}, AbortSignal, AbortController, setTimeout: timer, clearTimeout: (id) => timers.delete(id), Date: class extends Date { static now() { return now; } }, document: { hidden: false },
    SECTIONS: [{ id: 'electrical', name: 'Electrical' }, { id: 'software', name: 'Software' }],
    Store: { s: {}, pageByTitle() { return null; }, backlinks() { return []; } }, MD: { esc: (s) => s, extractWikiLinks: () => [], mdToText: (s) => s }, I: { x: '' },
    $: (selector) => selector.includes('[data-m="summary"]') ? fields.summary : selector.includes('save-commit') ? fields.save : selector.includes('data-page-review') ? fields.review : fields.status,
    showModal(m) { ctx.UI.modal = m; fields.summary.value = m.summary; fields.summary.placeholder = m.suggestedSummary; }, toast() {},
    api(url, opts) { return new Promise((resolve) => requests.push({ url, opts, resolve })); },
  });
  vm.runInContext(diff + helpers + modalView, ctx);
  return { ctx, requests, fields, run: (code) => vm.runInContext(code, ctx),
    async advance(ms) {
      const end = now + ms;
      for (let count = 0; count < 100; count++) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { now = end; return; }
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await settle();
      }
      throw new Error('Timers did not settle');
    },
  };
}
{
  const f = fixture();
  f.run('edSave()'); assert.equal(f.requests.length, 2, 'one summary and one independent review');
  assert.equal(f.fields.summary.value, '', 'the suggestion is never inserted as user-authored text');
  assert.equal(f.fields.summary.placeholder, 'Updated Wiring');
  const initial = f.run('viewModal()');
  assert.match(initial, /data-m="summary" value="" placeholder="Updated Wiring"/);
  assert.doesNotMatch(initial, /Summarizing changes|Automatic summary unavailable/);
  f.ctx.UI.modal.summaryEdited = true; f.ctx.UI.modal.summary = 'My wording'; f.fields.summary.value = 'My wording';
  f.requests.find((r) => r.url === '/change-summary').resolve({ available: true, summary: 'Generated wording' });
  f.requests.find((r) => r.url === '/page-review').resolve({ available: true, suggestions: [] }); await settle();
  assert.equal(f.fields.summary.value, 'My wording', 'late responses never overwrite manual edits');
  assert.equal(f.fields.summary.placeholder, 'Generated wording', 'clearing manual text reveals the latest suggestion');
  assert.equal(f.ctx.UI.modal.suggestedSummary, 'Generated wording');
  assert.equal(f.fields.save.disabled, false);
  f.ctx.UI.modal = null; f.run('edSave()'); await settle(); assert.equal(f.requests.length, 2, 'unchanged previews reuse requests');
  assert.equal(f.fields.summary.value, '');
  assert.equal(f.fields.summary.placeholder, 'Generated wording');
  assert.equal(f.run("edSummaryValue('')"), 'Generated wording', 'an empty field saves the generated suggestion');
  assert.equal(f.run("edSummaryValue('  My wording  ')"), 'My wording', 'manual wording overrides the suggestion');
  assert.equal(f.run("edSummaryValue('   ')"), 'Generated wording', 'clearing the field restores the suggested summary');
}
{
  const f = fixture(); f.run('edSave()'); f.ctx.UI.modal = null;
  f.requests.forEach((r) => r.resolve({ available: true, summary: 'Late', suggestions: [] })); await settle();
  assert.equal(f.ctx.UI.modal, null, 'late results never reopen a closed preview');
}
{
  const f = fixture(); f.run('edSave()');
  f.requests.forEach((r) => r.resolve({ available: false })); await settle();
  assert.equal(f.fields.save.disabled, false); assert.equal(f.fields.summary.value, '');
  assert.equal(f.fields.summary.placeholder, 'Updated Wiring');
  assert.equal(f.run("edSummaryValue('')"), 'Updated Wiring', 'a failed generation silently uses the basic suggestion');
  assert.equal(f.fields.status.hidden, true);
  assert.equal(f.fields.status.textContent, '');
  f.ctx.UI.modal.error = 'Could not save. Your draft is kept.';
  assert.match(f.run('viewModal()'), /role="alert" >Could not save\. Your draft is kept\./, 'durable save errors remain visible');
}
{
  const f = fixture(); f.run('edSave()');
  f.ctx.UI.editor.saving = true;
  f.ctx.UI.modal.summaryEdited = true;
  f.fields.save.disabled = true;
  f.requests.forEach((r) => r.resolve({ available: true, summary: 'Late summary', suggestions: [{ kind: 'unfinished' }] }));
  await settle();
  assert.equal(f.fields.save.disabled, true, 'late assistance cannot unlock Save during an active write');
  assert.equal(f.fields.review.hidden, true, 'late review cannot add active controls during a write');
}
{
  const f = fixture();
  assert.equal(f.run('edChangePreview(UI.editor).add'), 1);
  assert.equal(f.run('edChangePreview(UI.editor).del'), 1);
  f.run("UI.editor.body = UI.editor.origBody");
  assert.equal(f.run('edChangePreview(UI.editor).hasChanges'), false);
  f.run("UI.editor.section = 'software'");
  assert.equal(f.run('edChangePreview(UI.editor).sectionChanged'), true);
  f.run("UI.editor.origBody = Array(4000).fill('unchanged').join('\\n'); UI.editor.body = UI.editor.origBody + '\\nnew text'");
  assert.equal(f.run('edChangePreview(UI.editor).add'), 1, 'a small edit to a long page stays a small diff');
  f.run("UI.editor.body = 'x'.repeat(100000)");
  assert.ok(f.run('edChangePreview(UI.editor).input.diff.length') <= 12000);
  assert.equal(f.run('edChangePreview(UI.editor).truncated'), true);
  f.run("UI.editor.body = '![file](data:image/png;base64,PRIVATE_BYTES)'");
  assert.equal(f.run("edChangePreview(UI.editor).input.diff.includes('PRIVATE_BYTES')"), false);
}
{
  const f = fixture();
  let scheduled;
  f.ctx.setTimeout = (fn) => { scheduled = fn; return 1; };
  f.ctx.clearTimeout = () => {};
  f.run('schedulePageReview()');
  assert.equal(f.requests.length, 0, 'typing is debounced');
  scheduled();
  assert.equal(f.requests.length, 1, 'review starts in the background');
  f.requests[0].resolve({ available: true, suggestions: [{ kind: 'unfinished' }] }); await settle();
  f.run('edSave()');
  assert.equal(f.requests.filter((r) => r.url === '/page-review').length, 1, 'saving reuses the completed background review');
  assert.equal(f.ctx.UI.modal.reviewSuggestions[0].kind, 'unfinished');
  assert.ok(!f.fields.review.innerHTML.includes('Checking'), 'no background status UI');
  f.ctx.UI.modal = null;
  f.run("UI.editor.body += ' More details'; schedulePageReview()"); scheduled();
  assert.equal(f.requests.filter((r) => r.url === '/page-review').length, 2, 'edits invalidate the previous review');
  f.run('UI.editor = null; syncPageReview()');
}
// Background summary scheduling uses virtual time and controlled transport.
const summaryRequests = (f) => f.requests.filter((r) => r.url === '/change-summary');
{
  const f = fixture();
  f.run('scheduleChangeSummary()');
  await f.advance(1000);
  f.run("UI.editor.body += ' and check polarity'; scheduleChangeSummary()");
  await f.advance(1599); assert.equal(summaryRequests(f).length, 0, 'typing restarts the idle delay');
  await f.advance(1); assert.equal(summaryRequests(f).length, 1, 'generation starts before Save');
  assert.equal(f.ctx.UI.modal, undefined, 'background work adds no UI');
  summaryRequests(f)[0].resolve({ available: true, summary: 'Updated voltage and polarity checks' }); await settle();
  f.run('edSave()');
  assert.equal(f.fields.summary.placeholder, 'Updated voltage and polarity checks', 'cached wording appears in the first render');
  assert.equal(f.ctx.UI.modal.loading, false);
  assert.equal(summaryRequests(f).length, 1, 'Save does not spend a second request');
  assert.doesNotMatch(f.run('viewModal()'), /data-action="save-commit"[^>]*disabled/, 'Save is never gated by generation');
}
{
  const f = fixture(); f.run('scheduleChangeSummary()'); await f.advance(1600);
  f.run('edSave()');
  assert.equal(summaryRequests(f).length, 1, 'Save joins an in-flight prefetch');
  assert.doesNotMatch(f.run('viewModal()'), /data-action="save-commit"[^>]*disabled/);
  f.ctx.UI.modal.summaryEdited = true; f.fields.summary.value = 'My summary';
  summaryRequests(f)[0].resolve({ available: true, summary: 'Suggested voltage update' }); await settle();
  assert.equal(f.fields.summary.value, 'My summary');
  assert.equal(f.fields.summary.placeholder, 'Suggested voltage update');
}
{
  const f = fixture(); f.run('scheduleChangeSummary()'); await f.advance(1600);
  const old = summaryRequests(f)[0];
  f.run("UI.editor.body = 'Use 12V and a fuse'; scheduleChangeSummary()");
  await f.advance(10000);
  assert.equal(summaryRequests(f).length, 1, 'background requests do not overlap');
  old.resolve({ available: true, summary: 'Changed voltage to 3.3V' }); await settle(); await f.advance(0);
  assert.equal(summaryRequests(f).length, 2, 'only the latest draft follows a slow request');
  assert.match(JSON.parse(summaryRequests(f)[1].opts.body).diff, /12V and a fuse/);
  f.run('edSave()'); assert.equal(f.fields.summary.placeholder, 'Updated Wiring', 'old wording is never shown for newer edits');
  summaryRequests(f)[1].resolve({ available: true, summary: 'Updated the voltage and added a fuse' }); await settle();
  assert.equal(f.fields.summary.placeholder, 'Updated the voltage and added a fuse');
  f.ctx.UI.modal = null;
  f.run("UI.editor.body = 'Use 3.3V'; scheduleChangeSummary()"); await f.advance(10000);
  f.run('edSave()');
  assert.equal(summaryRequests(f).length, 2, 'Undo reuses the earlier exact summary');
  assert.equal(f.fields.summary.placeholder, 'Changed voltage to 3.3V');
}
{
  const f = fixture(); f.run('scheduleChangeSummary()'); await f.advance(1600);
  summaryRequests(f)[0].resolve({ available: true, summary: 'Changed voltage' }); await settle();
  f.run("UI.editor.title = 'New wiring'; scheduleChangeSummary()"); await f.advance(9999);
  assert.equal(summaryRequests(f).length, 1, 'successive editing pauses share the ten-second minimum interval');
  await f.advance(1); assert.equal(summaryRequests(f).length, 2);
}
{
  for (const condition of ['document.hidden = true', 'UI.editor.composing = true', 'UI.editor.uploads = 1', 'Store.s.settings = {ai:{connected:false}}', "UI.editor.body = UI.editor.origBody"]) {
    const f = fixture(); f.run(condition + '; scheduleChangeSummary()'); await f.advance(60000);
    assert.equal(summaryRequests(f).length, 0, condition);
  }
  const f = fixture(); f.run('UI.editor.dirty = true; document.hidden = true; scheduleChangeSummary()'); await f.advance(5000);
  f.run('document.hidden = false; syncChangeSummary()'); await f.advance(0);
  assert.equal(summaryRequests(f).length, 1, 'returning to the tab resumes a dirty draft');
  f.run('UI.editor = null; syncChangeSummary()');
  assert.equal(summaryRequests(f)[0].opts.signal.aborted, true, 'leaving the editor cancels pending transport');
  summaryRequests(f)[0].resolve({ available: true, summary: 'Late' }); await settle();
  assert.equal(f.ctx.UI.modal, undefined);
}
{
  const f = fixture(); f.run('scheduleChangeSummary()'); await f.advance(1600);
  summaryRequests(f)[0].resolve({ available: false }); await settle();
  f.run("UI.editor.body += ' new text'; scheduleChangeSummary()"); await f.advance(29999);
  assert.equal(summaryRequests(f).length, 1, 'failed generation backs off during further typing');
  await f.advance(1); assert.equal(summaryRequests(f).length, 2);
  summaryRequests(f)[1].resolve({ available: true, summary: 'Updated wiring' }); await settle();
  f.ctx.Store.s.settings = { ai: { revision: 2, model: 'gpt-5.6-luna', effort: 'none' } };
  f.run('scheduleChangeSummary()'); await f.advance(10000);
  assert.equal(summaryRequests(f).length, 3, 'owner configuration changes invalidate cached wording');
}
console.log('AI assistance tests passed: bounded requests, server-only providers, coalescing, confidence gates, outages, stale responses, manual edits and change previews');
