// A cycle's forms: any number, each a form the website renders and a list
// the wiki reviews; three defaults for a new cycle (interest form, coffee
// chats, application form). Pure helper: defaults, merging with a cycle's
// saved settings, the public shape the website reads, and validation of
// edits.

import { FIXED_FORM_V1, SUBTEAMS, YEARS, SYSTEM_KEYS, EMAIL_RE, validateFormDoc } from './fixed-form.js';

// The forms every cycle starts with. A cycle can add forms of its own (a
// second coffee chat round, a technical interview form) and drop any of
// these once they have no responses. The interest form, while it exists,
// keeps the website's fixed questions: the site's own fallback posts them.
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

// The interest form the website's old route posts to is the one that still
// carries every fixed question; any other form only needs a name and an
// email. That decides which questions an editor cannot remove.
export const hasSystemKeys = (section) => Array.isArray(section?.form?.questions) && SYSTEM_KEYS.every((k) => section.form.questions.some((q) => q.key === k));
export const requiredKeysFor = (key, section) => (key === FIXED_FORM && hasSystemKeys(section) ? [...SYSTEM_KEYS] : ['name', 'email']);

// The form a stored row belongs to; when that form is gone, a stand-in
// built from the row's own answers so they still read.
export function formForRow(sections, app) {
  const own = sections[app?.section || 'interest'];
  if (own) return own.form;
  const base = defaultQuestions();
  const known = new Set(base.map((q) => q.key));
  return { questions: [...base, ...Object.keys(app?.answers || {}).filter((k) => !known.has(k)).map((k) => ({ key: k, type: 'long', label: k }))] };
}
const q = (key, type, label, extra = {}) => ({ key, type, label, help: '', required: false, ...extra });
// The interest form as the website has always worded it; the fixed vocabulary
// keeps its keys, the site shows these labels and requires a year.
const INTEREST_SITE = {
  year: { label: 'Year', required: true },
  subteam: { label: 'Subteam of interest' },
  project: { label: "What's the coolest project you've done?", help: 'Tell us about it, or drop a photo or PDF right here...' },
  file: { label: 'Photo or PDF of it' },
};

export function defaultSections() {
  return {
    interest: {
      title: 'Interest form', description: 'Fill in the information below to display interest in applying to CUPI.', open: true,
      form: { questions: clone(FIXED_FORM_V1.questions).map(({ section, subteamOnly, system, ...rest }) => ({ ...rest, ...(INTEREST_SITE[rest.key] || {}) })) },
    },
    coffee: {
      title: 'Coffee chats', description: 'Grab a coffee with a current member before you apply.', open: false,
      form: { questions: [
        q('name', 'short', 'Name', { required: true, max: 100 }),
        q('email', 'email', 'Email', { required: true, max: 200 }),
        q('subteam', 'single', 'Subteam you want to hear about', { options: [...SUBTEAMS] }),
        q('availability', 'long', 'When are you free this week?', { required: true, max: 1000 }),
        q('topics', 'long', 'Anything you want to talk about?', { max: 1000 }),
      ] },
    },
    application: {
      title: 'Application form', description: '', open: false,
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

const savedSections = (cycle) => (isObject(cycle?.doc?.site?.sections) ? cycle.doc.site.sections : {});
// A default form the cycle dropped is stored as null, so it stays dropped.
const isDropped = (saved, key) => Object.prototype.hasOwnProperty.call(saved, key) && saved[key] === null;
export const defaultQuestions = () => [q('name', 'short', 'Name', { required: true, max: 100 }), q('email', 'email', 'Email', { required: true, max: 200 })];

// The cycle's forms in display order: its saved order first, then whatever
// is unordered (the defaults, then its own forms as they were added).
export function sectionKeysFor(cycle) {
  const saved = savedSections(cycle);
  const known = [...SECTION_KEYS, ...Object.keys(saved).filter((k) => !SECTION_KEYS.includes(k) && FORM_KEY.test(k) && isObject(saved[k]))];
  const live = known.filter((k) => !isDropped(saved, k));
  const order = Array.isArray(cycle?.doc?.site?.order) ? cycle.doc.site.order.filter((k) => live.includes(k)) : [];
  return [...order, ...live.filter((k) => !order.includes(k))];
}

// A cycle's sections: saved settings over the defaults, with the cycle's own
// subteam names as the options of every subteam question. Ordered.
export function sectionsFor(cycle) {
  const base = defaultSections();
  const saved = savedSections(cycle);
  const subteams = Array.isArray(cycle?.doc?.subteams) ? cycle.doc.subteams.map((s) => s?.name).filter(Boolean) : [];
  const out = {};
  for (const key of sectionKeysFor(cycle)) {
    const def = base[key] || { title: key, description: '', open: false, form: { questions: defaultQuestions() } };
    const s = { ...def, ...(isObject(saved[key]) ? saved[key] : {}) };
    s.title = clip(s.title, 80) || def.title;
    s.form = { questions: clone(Array.isArray(s.form?.questions) && s.form.questions.length ? s.form.questions : def.form.questions) };
    if (subteams.length) for (const qq of s.form.questions) if (qq.key === 'subteam' && qq.type === 'single') qq.options = [...subteams];
    s.open = s.open === true;
    // Per form: a cap on responses (0 = none), whether the team is emailed
    // for each one, and whether a second submission replaces the first.
    s.capacity = Number.isInteger(Number(s.capacity)) && Number(s.capacity) > 0 ? Number(s.capacity) : 0;
    s.notify = s.notify !== false;
    s.notifyTo = cleanRecipients(s.notifyTo);
    s.replace = s.replace !== false;
    s.required = requiredKeysFor(key, s);
    out[key] = s;
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

// What the website is allowed to see: no settings, no people.
export function publicSections(cycle) {
  return Object.entries(sectionsFor(cycle)).map(([key, s]) => ({ key, title: s.title, description: s.description, open: s.open, form: { questions: s.form.questions.map(publicQuestion) } }));
}

const cleanQuestion = (qq) => {
  const out = { key: qq.key, type: qq.type, label: clip(qq.label, 120) || qq.key, help: clip(qq.help, 300), required: qq.required === true };
  if (Array.isArray(qq.options)) out.options = qq.options.map((o) => clip(o, 80)).filter(Boolean);
  if (qq.max !== undefined) out.max = Number(qq.max);
  if (Array.isArray(qq.accept)) out.accept = [...qq.accept];
  if (qq.maxBytes !== undefined) out.maxBytes = Number(qq.maxBytes);
  return out;
};

// Which form /apply shows: the one chosen for the cycle, else the first
// open one in section order, else nothing.
export function landingFor(cycle, sections = sectionsFor(cycle)) {
  const chosen = cycle?.doc?.site?.landing;
  if (sections[chosen]?.open) return chosen;
  return Object.keys(sections).find((key) => sections[key]?.open) || null;
}

// Edits from the Form view: partial per form, merged over what the cycle
// has now; new forms by a key of their own; `remove` drops forms (the route
// refuses one with responses); `order` sorts
// them; `landing` is the /apply choice. The interest form keeps the
// website's fixed questions; every other form only needs a name and an email.
export function validateSite(next, cycle = null) {
  if (!isObject(next)) throw fail(400, 'Sections must be an object');
  const given = isObject(next.sections) ? next.sections : next;
  const current = sectionsFor(cycle);
  const saved = savedSections(cycle);
  const removeList = Array.isArray(next.remove) ? next.remove.map(String) : [];
  const out = {};
  for (const k of Object.keys(saved)) if (isDropped(saved, k) && !isObject(given[k])) out[k] = null;
  const keys = [...new Set([...Object.keys(current), ...Object.keys(given).filter((k) => isObject(given[k])), ...removeList])];
  for (const key of keys) {
    if (!FORM_KEY.test(key)) throw fail(400, 'A form key is lowercase letters and digits, with - or _');
    if (removeList.includes(key)) {
      if (SECTION_KEYS.includes(key)) out[key] = null;
      continue;
    }
    const s = given[key];
    const existing = current[key];
    if (!existing && s === undefined) continue;
    if (!existing && !clip(s.title, 80)) throw fail(400, 'A new form needs a title');
    const base = existing || { title: clip(s.title, 80), description: '', open: false, capacity: 0, notify: true, notifyTo: [], replace: true, form: { questions: defaultQuestions() } };
    const cur = { title: base.title, description: base.description, open: base.open, capacity: base.capacity || 0, notify: base.notify !== false, notifyTo: cleanRecipients(base.notifyTo), replace: base.replace !== false, form: { questions: base.form.questions.map(cleanQuestion) } };
    if (s !== undefined) {
      if (!isObject(s)) throw fail(400, `${cur.title} settings must be an object`);
      if (s.title !== undefined) cur.title = clip(s.title, 80) || SECTION_LABELS[key] || key;
      if (s.description !== undefined) cur.description = String(s.description ?? '').trim().slice(0, 600);
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
      if (s.form !== undefined) {
        let v;
        try { v = validateFormDoc({ questions: Array.isArray(s.form?.questions) ? s.form.questions : [] }, { required: requiredKeysFor(key, existing) }); }
        catch (e) { throw fail(e.status || 400, e.error || e.message || 'Invalid form'); }
        cur.form = { questions: v.questions.map(cleanQuestion) };
      }
    }
    out[key] = cur;
  }
  const liveKeys = Object.keys(out).filter((k) => out[k]);
  let landing = cycle?.doc?.site?.landing || null;
  if (next.landing !== undefined) landing = next.landing === null || next.landing === '' ? null : String(next.landing);
  if (landing !== null && !out[landing]) throw fail(400, "The form shown at /apply must be one of this cycle's forms");
  let order = Array.isArray(cycle?.doc?.site?.order) ? cycle.doc.site.order.map(String) : [];
  if (next.order !== undefined) {
    if (!Array.isArray(next.order) || next.order.some((k) => !out[k])) throw fail(400, 'The order names forms this cycle does not have');
    order = [...new Set(next.order.map(String))];
  }
  order = order.filter((k) => liveKeys.includes(k));
  return { sections: out, landing, order };
}
