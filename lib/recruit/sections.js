// A cycle's stages: any number, each a step of the flow chart. A stage may
// have a form the website renders (the interest form, a coffee chat request,
// the application) and a checklist the team fills in for each person (chat
// completed, interviewer, score). Stored under doc.site.sections, the name
// the website forms have always had. Pure helper: defaults, merging with a
// cycle's saved settings, the public shape the website reads, and validation
// of edits. flow.js owns the graph and the checklist fields.

import { FIXED_FORM_V1, SUBTEAMS, YEARS, SYSTEM_KEYS, EMAIL_RE, validateFormDoc } from './fixed-form.js';
import { STAGE_KINDS, SPLIT_TYPES, cleanFields, cleanSplit, doneFieldOf, edgesOf, loopIn, reaches, splitOptions, splitTargets } from './flow.js';

// The stages every cycle has unless it dropped them. A cycle adds stages of
// its own (an interview, a second coffee chat round) and drops any stage once
// nobody's answers or checklist entries sit there. The interest form, while
// it exists, keeps the website's fixed questions: the site's fallback posts them.
export const SECTION_KEYS = ['interest', 'coffee', 'application'];
export const SECTION_LABELS = { interest: 'Interest form', coffee: 'Coffee chats', application: 'Application form' };
export const FIXED_FORM = 'interest';
export const FORM_KEY = /^[a-z][a-z0-9_-]{0,39}$/;

const clone = (v) => JSON.parse(JSON.stringify(v));
const isObject = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const fail = (status, error) => Object.assign(new Error(error), { status, error });
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
// Who a form emails: only the addresses it lists.
export const NOTIFY_MAX = 10;
const cleanRecipients = (list) => (Array.isArray(list) ? [...new Set(list.map((e) => clip(e, 120).toLowerCase()).filter((e) => EMAIL_RE.test(e)))].slice(0, NOTIFY_MAX) : []);

// The old POST adapter requires the historical keys. Modern editors only
// lock identity fields; the adapter never dictates the editable schema.
export const hasSystemKeys = (section) => Array.isArray(section?.form?.questions) && SYSTEM_KEYS.every((k) => section.form.questions.some((q) => q.key === k));
export const requiredKeysFor = () => ['name', 'email'];

// The form a stored row belongs to; when that form is gone, a stand-in
// built from the row's own answers so they still read.
export function formForRow(sections, app) {
  if (Array.isArray(app?.formSnapshot?.questions)) return clone(app.formSnapshot);
  const own = sections[app?.section || 'interest'];
  if (own?.form) return own.form;
  const base = defaultQuestions();
  const known = new Set(base.map((q) => q.key));
  return { questions: [...base, ...Object.keys(app?.answers || {}).filter((k) => !known.has(k)).map((k) => ({ key: k, type: 'long', label: k }))] };
}
const q = (key, type, label, extra = {}) => ({ key, type, label, help: '', required: false, ...extra });
// What applicants read after sending each default form; a form the team
// adds says whatever its editor writes, and the site has a plain fallback.
const DEFAULT_THANKS = {
  interest: 'We read every one of these. Keep an eye on your inbox when recruiting opens.',
  coffee: 'A member will email you to find a time.',
  application: "Thanks for applying. We'll be in touch by email.",
};
// The interest form as the website has always worded it; the fixed vocabulary
// keeps its keys, the site shows these labels and requires a year.
const INTEREST_SITE = {
  year: { label: 'Year', required: true },
  subteam: { label: 'Subteam of interest' },
  project: { label: "What's the coolest project you've done?", help: 'Tell us about it, or drop a photo or PDF right here...' },
  file: { label: 'Photo or PDF of it' },
};

// Checklist fields: what the team records for a person at a stage.
const field = (key, type, label, extra = {}) => ({ key, type, label, ...extra });

export function defaultSections() {
  return {
    interest: {
      submitLabel: 'Join the interest list', successLabel: "You're on the list", title: 'Interest form', description: 'Fill in the information below to display interest in applying to CUPI.', open: true,
      kind: 'form', fields: [], done: null,
      form: { questions: clone(FIXED_FORM_V1.questions).map(({ section, subteamOnly, system, ...rest }) => ({ ...rest, ...(INTEREST_SITE[rest.key] || {}) })) },
    },
    // A request on the website, and whether the chat then happened.
    coffee: {
      submitLabel: 'Request a coffee chat', successLabel: 'Request sent', title: 'Coffee chats', description: 'Grab a coffee with a current member before you apply.', open: false,
      kind: 'meeting', done: 'completed',
      fields: [field('completed', 'check', 'Chat completed'), field('met_with', 'text', 'Met with'), field('notes', 'note', 'Notes')],
      form: { questions: [
        q('name', 'short', 'Name', { required: true, max: 100 }),
        q('email', 'email', 'Email', { required: true, max: 200 }),
        q('subteam', 'single', 'Subteam you want to hear about', { options: [...SUBTEAMS] }),
        q('availability', 'long', 'When are you free this week?', { required: true, max: 1000 }),
        q('topics', 'long', 'Anything you want to talk about?', { max: 1000 }),
      ] },
    },
    application: {
      submitLabel: 'Send application', successLabel: 'Application sent', title: 'Application form', description: '', open: false,
      kind: 'form', done: null,
      fields: [field('score', 'rating', 'Score', { max: 5, each: true }), field('notes', 'note', 'Review notes', { each: true })],
      form: { questions: [
        q('name', 'short', 'Name', { required: true, max: 100 }),
        q('email', 'email', 'Email', { required: true, max: 200 }),
        q('year', 'single', 'Year', { required: true, options: [...YEARS] }),
        q('subteam', 'single', 'Subteam', { required: true, options: [...SUBTEAMS] }),
        q('why', 'long', 'Why do you want to join CUPI?', { required: true, max: 2000 }),
        q('project', 'long', 'Tell us about something you built', { max: 2000 }),
        q('links', 'link', 'Portfolio, GitHub, or LinkedIn'),
        q('resume', 'file', 'Résumé (PDF)', { accept: ['application/pdf'], maxBytes: 2621440 }),
      ] },
    },
  };
}

// The flow a brand-new cycle starts with: the three website forms, coffee
// chats optional, then an interview the team runs. Written into the new
// cycle's doc, so cycles made before the flow chart keep their own stages.
export function newCycleSite() {
  return {
    sections: {
      interest: { next: ['coffee', 'application'] },
      coffee: { next: ['application'] },
      application: { next: ['interview'] },
      interview: {
        title: 'Interview', description: '', open: false, kind: 'meeting', form: null, next: [], done: 'completed',
        fields: [field('interviewer', 'member', 'Interviewer'), field('completed', 'check', 'Interview completed'), field('score', 'rating', 'Score', { max: 5, each: true }), field('notes', 'note', 'Notes', { each: true })],
      },
    },
    order: ['interest', 'coffee', 'application', 'interview'],
  };
}

const savedSections = (cycle) => (isObject(cycle?.doc?.site?.sections) ? cycle.doc.site.sections : {});
// A default form the cycle dropped is stored as null, so it stays dropped.
const isDropped = (saved, key) => Object.prototype.hasOwnProperty.call(saved, key) && saved[key] === null;
export const defaultQuestions = () => [q('name', 'short', 'Name', { required: true, max: 100 }), q('email', 'email', 'Email', { required: true, max: 200 })];

// The cycle's forms in display order: its saved order first, then whatever
// is unordered (the defaults, then its own forms as they were added).
export function sectionKeysFor(cycle) {
  const saved = savedSections(cycle);
  const known = [...SECTION_KEYS, ...Object.keys(saved).filter((k) => !SECTION_KEYS.includes(k) && FORM_KEY.test(k) && !['__proto__', 'prototype', 'constructor'].includes(k) && isObject(saved[k]))];
  const live = known.filter((k) => !isDropped(saved, k));
  const order = Array.isArray(cycle?.doc?.site?.order) ? cycle.doc.site.order.filter((k) => live.includes(k)) : [];
  return [...order, ...live.filter((k) => !order.includes(k))];
}

// A cycle's stages: saved settings over the defaults, with the cycle's own
// subteam names as the options of every subteam question. Ordered. A stage
// saved with `form: null` has no website form; its checklist is what the
// team fills in.
export function sectionsFor(cycle) {
  const base = defaultSections();
  const saved = savedSections(cycle);
  const subteams = Array.isArray(cycle?.doc?.subteams) ? cycle.doc.subteams.map((s) => s?.name).filter(Boolean) : [];
  const out = {};
  for (const key of sectionKeysFor(cycle)) {
    const def = base[key] || { title: key, description: '', open: false, kind: 'form', fields: [], done: null, form: { questions: defaultQuestions() } };
    const own = isObject(saved[key]) ? saved[key] : {};
    const s = { thanks: DEFAULT_THANKS[key] || '', ...def, ...own };
    s.title = clip(s.title, 80) || def.title;
    s.thanks = String(s.thanks ?? '').trim().slice(0, 300);
    s.form = own.form === null ? null : { questions: clone(Array.isArray(s.form?.questions) && s.form.questions.length ? s.form.questions : def.form.questions) };
    // Only unsaved defaults inherit the cycle's teams. Saved question options
    // are the form's own contract and must never be overwritten on read.
    if (s.form && !own.form && subteams.length) for (const qq of s.form.questions) if (qq.key === 'subteam' && qq.type === 'single') qq.options = [...subteams];
    s.kind = STAGE_KINDS.includes(s.kind) ? s.kind : s.form ? 'form' : 'step';
    s.fields = cleanFields(s.fields, { lenient: true });
    s.done = doneFieldOf(s) ? s.done : null;
    if (Array.isArray(s.next)) s.next = [...new Set(s.next.map(String))].filter((k) => k !== key); else delete s.next;
    // Only a stage with a form can be open on the website.
    s.open = Boolean(s.form) && s.open === true;
    // Per form: a cap on responses (0 = none), whether the team is emailed
    // for each one, and whether a second submission replaces the first.
    s.capacity = Number.isInteger(Number(s.capacity)) && Number(s.capacity) > 0 ? Number(s.capacity) : 0;
    s.notify = s.notify !== false;
    s.notifyTo = cleanRecipients(s.notifyTo);
    s.replace = s.replace !== false;
    s.required = s.form ? requiredKeysFor(key, s) : [];
    // How /apply lists the form when applicants choose between several.
    s.choiceLabel = clip(s.choiceLabel, 40);
    out[key] = s;
  }
  // Connections to stages the cycle no longer has are dropped on read, and
  // so are the answers of a split that led there. A split's stages are
  // always among the stage's connections.
  const live = new Set(Object.keys(out));
  for (const s of Object.values(out)) {
    if (s.next) s.next = s.next.filter((k) => live.has(k));
    const split = cleanSplit(s.split, { live, lenient: true });
    if (split) { s.split = split; if (s.next) s.next = [...new Set([...s.next, ...splitTargets(split)])]; } else delete s.split;
  }
  return out;
}

const publicQuestion = (qq) => {
  const o = { key: qq.key, type: qq.type, label: qq.label || qq.key, required: qq.required === true };
  if (qq.help) o.help = qq.help;
  if (Array.isArray(qq.options)) o.options = [...qq.options];
  if (qq.max) o.max = Number(qq.max);
  if (Array.isArray(qq.accept)) o.accept = [...qq.accept];
  if (qq.maxBytes) o.maxBytes = Number(qq.maxBytes);
  return o;
};

// What the website is allowed to see: stages with a form, and of those only
// the wording and questions. No settings, no checklist, no people.
export function publicSections(cycle) {
  return Object.entries(sectionsFor(cycle)).filter(([, s]) => s.form).map(([key, s]) => ({ key, title: s.title, description: s.description, thanks: s.thanks, submitLabel: s.submitLabel || 'Send', successLabel: s.successLabel || 'Sent', replace: false, open: s.open, form: { questions: s.form.questions.map(publicQuestion) } }));
}

const cleanQuestion = (qq) => {
  const out = { key: qq.key, type: qq.type, label: clip(qq.label, 120) || qq.key, help: clip(qq.help, 300), required: qq.required === true };
  if (Array.isArray(qq.options)) out.options = qq.options.map((o) => clip(o, 80)).filter(Boolean);
  if (qq.max !== undefined) out.max = Number(qq.max);
  if (Array.isArray(qq.accept)) out.accept = [...qq.accept];
  if (qq.maxBytes !== undefined) out.maxBytes = Number(qq.maxBytes);
  return out;
};

// The forms the team marked for /apply, saved as one key before several
// could be marked.
export const applyKeysOf = (cycle) => {
  const v = cycle?.doc?.site?.landing;
  return [...new Set((Array.isArray(v) ? v : v ? [v] : []).map(String))];
};
export const APPLY_QUESTION = 'What are you applying for?';

// Which form /apply shows when it shows one: the first marked form that is
// open, else the first open one in stage order, else nothing.
export function landingFor(cycle, sections = sectionsFor(cycle)) {
  const marked = new Set(applyKeysOf(cycle));
  const open = Object.keys(sections).filter((key) => sections[key]?.open);
  return open.find((key) => marked.has(key)) || open[0] || null;
}

// What /apply asks when more than one marked form is open: a question, and
// each form under its label (its title unless the team named it for /apply),
// in stage order. The site picks among those it can still take.
export function applyFor(cycle, sections = sectionsFor(cycle)) {
  const marked = new Set(applyKeysOf(cycle));
  const choices = Object.keys(sections).filter((key) => marked.has(key) && sections[key]?.open).map((key) => ({ key, label: sections[key].choiceLabel || sections[key].title }));
  return { question: clip(cycle?.doc?.site?.question, 120) || APPLY_QUESTION, choices };
}

// Edits from the flow chart and a stage's page: partial per stage, merged
// over what the cycle has now; new stages by a key of their own; `remove`
// drops stages (the route refuses one with responses or checklist entries);
// `order` sorts them; `landing` lists the forms /apply shows and `question`
// is what it asks when applicants choose between them. A stage with a form
// keeps name and email; `form: null` takes a stage off the website (the
// route refuses it while the form has responses). Connections must name
// stages of this cycle and may never loop back.
export function validateSite(next, cycle = null) {
  if (!isObject(next)) throw fail(400, 'Sections must be an object');
  const given = isObject(next.sections) ? next.sections : next;
  const current = sectionsFor(cycle);
  const saved = savedSections(cycle);
  const removeList = Array.isArray(next.remove) ? next.remove.map(String) : [];
  const out = {};
  const nextGiven = new Set();
  const splitGiven = new Set();
  for (const k of Object.keys(saved)) if (isDropped(saved, k) && !isObject(given[k])) out[k] = null;
  const keys = [...new Set([...Object.keys(current), ...Object.keys(given).filter((k) => isObject(given[k])), ...removeList])];
  for (const key of keys) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw fail(400, 'Choose a different stage key');
    if (key === 'people' && !Object.hasOwn(current, key)) throw fail(400, 'The stage key people is reserved; use people-form');
    if (!FORM_KEY.test(key)) throw fail(400, 'A stage key is lowercase letters and digits, with - or _');
    if (removeList.includes(key)) {
      if (SECTION_KEYS.includes(key)) out[key] = null;
      continue;
    }
    const s = given[key];
    const existing = current[key];
    if (!existing && s === undefined) continue;
    if (!existing && !clip(s.title, 80)) throw fail(400, 'A new stage needs a name');
    const base = existing || { title: clip(s.title, 80), description: '', thanks: '', open: false, capacity: 0, notify: true, notifyTo: [], replace: true, kind: 'form', fields: [], done: null, form: { questions: defaultQuestions() } };
    const cur = {
      submitLabel: base.submitLabel || 'Send', successLabel: base.successLabel || 'Sent', title: base.title, description: base.description, thanks: String(base.thanks ?? '').trim().slice(0, 300),
      open: base.open, capacity: base.capacity || 0, notify: base.notify !== false, notifyTo: cleanRecipients(base.notifyTo), replace: base.replace !== false,
      form: base.form ? { questions: base.form.questions.map(cleanQuestion) } : null,
      kind: STAGE_KINDS.includes(base.kind) ? base.kind : 'form', fields: cleanFields(base.fields, { lenient: true }), done: base.done ?? null,
      choiceLabel: clip(base.choiceLabel, 40),
      ...(Array.isArray(base.next) ? { next: [...base.next] } : {}),
      ...(base.split ? { split: clone(base.split) } : {}),
    };
    let doneGiven = false;
    if (s !== undefined) {
      if (!isObject(s)) throw fail(400, `${cur.title} settings must be an object`);
      if (s.title !== undefined) cur.title = clip(s.title, 80) || SECTION_LABELS[key] || key;
      if (s.description !== undefined) cur.description = String(s.description ?? '').trim().slice(0, 600);
      for (const field of ['submitLabel', 'successLabel']) if (s[field] !== undefined) cur[field] = clip(s[field], 80) || (field === 'submitLabel' ? 'Send' : 'Sent');
      if (s.thanks !== undefined) cur.thanks = String(s.thanks ?? '').trim().slice(0, 300);
      if (s.open !== undefined) cur.open = s.open === true;
      if (s.capacity !== undefined) {
        const n = s.capacity === null || s.capacity === '' ? 0 : Number(s.capacity);
        if (!Number.isInteger(n) || n < 0 || n > 100000) throw fail(400, `${cur.title}: stop accepting after a whole number of responses, up to 100,000`);
        cur.capacity = n;
      }
      if (s.notify !== undefined) cur.notify = s.notify === true;
      if (s.notifyTo !== undefined) {
        if (!Array.isArray(s.notifyTo)) throw fail(400, `${cur.title}: recipients must be a list of addresses`);
        const list = [...new Set(s.notifyTo.map((e) => clip(e, 120).toLowerCase()).filter(Boolean))];
        const badOne = list.find((e) => !EMAIL_RE.test(e));
        if (badOne) throw fail(400, `${cur.title}: "${badOne}" is not an email address`);
        if (list.length > NOTIFY_MAX) throw fail(400, `${cur.title}: up to ${NOTIFY_MAX} addresses`);
        cur.notifyTo = list;
      }
      if (s.replace !== undefined) cur.replace = s.replace === true;
      if (s.choiceLabel !== undefined) cur.choiceLabel = clip(s.choiceLabel, 40);
      if (s.form === null) cur.form = null;
      else if (s.form !== undefined) {
        let v;
        try { v = validateFormDoc({ questions: Array.isArray(s.form?.questions) ? s.form.questions : [] }, { required: requiredKeysFor(key, existing) }); }
        catch (e) { throw fail(e.status || 400, e.error || e.message || 'Invalid form'); }
        cur.form = { questions: v.questions.map(cleanQuestion) };
      }
      if (s.kind !== undefined) {
        if (!STAGE_KINDS.includes(s.kind)) throw fail(400, `${cur.title}: choose form, meeting, review or step`);
        cur.kind = s.kind;
      }
      if (s.fields !== undefined) cur.fields = cleanFields(s.fields);
      if (s.done !== undefined) { cur.done = s.done === null || s.done === '' ? null : String(s.done); doneGiven = true; }
      if (s.next !== undefined) {
        if (s.next !== null && !Array.isArray(s.next)) throw fail(400, `${cur.title}: connections must be a list of stages`);
        if (s.next === null) delete cur.next; else { cur.next = [...new Set(s.next.map(String))]; nextGiven.add(key); }
      }
      if (s.split !== undefined) {
        if (s.split === null) delete cur.split; else { cur.split = s.split; splitGiven.add(key); }
      }
    }
    if (!cur.form) {
      if (s?.open === true) throw fail(400, `${cur.title} has no form to open on the website`);
      cur.open = false;
    }
    if (cur.done && !doneFieldOf(cur)) {
      if (doneGiven) throw fail(400, `${cur.title}: only one of its own checkboxes can mark it done`);
      cur.done = null;
    }
    if (!cur.choiceLabel) delete cur.choiceLabel;
    out[key] = cur;
  }
  const liveKeys = Object.keys(out).filter((k) => out[k]);
  // The forms at /apply: a list given here replaces the saved one (one key
  // or null still work); a saved form that was removed or lost its form drops out.
  let landing = applyKeysOf(cycle).filter((k) => out[k]?.form);
  if (next.landing !== undefined) {
    const list = next.landing === null || next.landing === '' ? [] : Array.isArray(next.landing) ? next.landing : [next.landing];
    landing = [...new Set(list.map(String))];
    for (const k of landing) {
      if (!out[k]) throw fail(400, "The form shown at /apply must be one of this cycle's forms");
      if (!out[k].form) throw fail(400, 'The stage shown at /apply needs a form');
    }
  }
  let question = clip(cycle?.doc?.site?.question, 120);
  if (next.question !== undefined) question = clip(next.question, 120);
  let order = Array.isArray(cycle?.doc?.site?.order) ? cycle.doc.site.order.map(String) : [];
  if (next.order !== undefined) {
    if (!Array.isArray(next.order) || next.order.some((k) => !out[k])) throw fail(400, 'The order names stages this cycle does not have');
    order = [...new Set(next.order.map(String))];
  }
  order = order.filter((k) => liveKeys.includes(k));
  // Connections: every stage named must exist (a removed stage's are
  // dropped), none leads to itself, and the whole never loops back.
  for (const key of liveKeys) {
    const s = out[key];
    if (!Array.isArray(s.next)) continue;
    if (s.next.includes(key)) throw fail(400, `${s.title} cannot lead to itself`);
    if (nextGiven.has(key)) {
      const unknown = s.next.find((k) => !liveKeys.includes(k));
      if (unknown) throw fail(400, `${s.title} leads to a stage this cycle does not have`);
    }
    s.next = s.next.filter((k) => liveKeys.includes(k));
  }
  // Splits: a split sent in this edit is checked in full; one already saved
  // quietly drops answers that led to a stage removed now. Every stage a
  // split sends people to becomes one of the stage's connections.
  const live = new Set(liveKeys);
  for (const key of liveKeys) {
    const s = out[key];
    if (!s.split) continue;
    const given = splitGiven.has(key);
    let split = cleanSplit(s.split, { live, lenient: !given, title: s.title });
    if (split && !given && nextGiven.has(key)) {
      // Connections sent without the split win: answers that led to a
      // stage no longer connected are dropped.
      const keep = new Set(s.next || []);
      const routes = Object.fromEntries(Object.entries(split.routes).filter(([, to]) => keep.has(to)));
      split = Object.keys(routes).length ? { ...split, routes, otherwise: split.otherwise && keep.has(split.otherwise) ? split.otherwise : null } : null;
    }
    if (!split) { delete s.split; continue; }
    if (given) {
      const source = out[split.stage];
      const question = source?.form?.questions?.find((qq) => qq.key === split.q);
      if (!question || !SPLIT_TYPES.includes(question.type)) throw fail(400, `${s.title}: split by a choice or a checkbox on one of this cycle's forms`);
      const offered = splitOptions(question);
      const stray = Object.keys(split.routes).find((a) => !offered.includes(a));
      if (stray) throw fail(400, `${s.title}: "${stray}" is not an answer to ${question.label || question.key}`);
      if (splitTargets(split).has(key)) throw fail(400, `${s.title} cannot lead to itself`);
    }
    s.split = split;
    const base = Array.isArray(s.next) ? s.next : edgesOf(current).get(key) || [];
    s.next = [...new Set([...base, ...splitTargets(split)])].filter((k) => live.has(k) && k !== key);
  }
  const ordered = {};
  for (const k of [...order, ...liveKeys.filter((k) => !order.includes(k))]) ordered[k] = out[k];
  const edges = edgesOf(ordered);
  const loop = loopIn(edges);
  if (loop) throw fail(400, `That connection would loop back to ${out[loop].title}`);
  // A split reads a question people have answered by the time they get
  // there: on this stage's form, or on a form before it.
  for (const key of splitGiven) {
    const split = out[key]?.split;
    if (split && split.stage !== key && !reaches(edges, split.stage, key)) throw fail(400, `${out[key].title}: split by a question people answer before they reach it`);
  }
  return { sections: out, landing: landing.length ? landing : null, order, ...(question ? { question } : {}) };
}
