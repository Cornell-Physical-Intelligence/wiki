// The three sections every cycle has: the interest form, coffee chats, and
// the application. Each is a form the website renders and a list the wiki
// reviews. Pure helper: defaults, merging with a cycle's saved settings, the
// public shape the website reads, and validation of edits.

import { FIXED_FORM_V1, SUBTEAMS, YEARS, SYSTEM_KEYS, validateFormDoc } from './fixed-form.js';

export const SECTION_KEYS = ['interest', 'coffee', 'application'];
export const SECTION_LABELS = { interest: 'Interest form', coffee: 'Coffee chats', application: 'Applications' };

const clone = (v) => JSON.parse(JSON.stringify(v));
const isObject = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const fail = (status, error) => Object.assign(new Error(error), { status, error });
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
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
      title: 'Application', description: '', open: false,
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

// A cycle's sections: saved settings over the defaults, with the cycle's own
// subteam names as the options of every subteam question.
export function sectionsFor(cycle) {
  const base = defaultSections();
  const saved = cycle?.doc?.site?.sections;
  const subteams = Array.isArray(cycle?.doc?.subteams) ? cycle.doc.subteams.map((s) => s?.name).filter(Boolean) : [];
  const out = {};
  for (const key of SECTION_KEYS) {
    const s = { ...base[key], ...(isObject(saved?.[key]) ? saved[key] : {}) };
    s.form = { questions: clone(Array.isArray(s.form?.questions) && s.form.questions.length ? s.form.questions : base[key].form.questions) };
    if (subteams.length) for (const qq of s.form.questions) if (qq.key === 'subteam' && qq.type === 'single') qq.options = [...subteams];
    s.open = s.open === true;
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
  const sections = sectionsFor(cycle);
  return SECTION_KEYS.map((key) => ({ key, title: sections[key].title, description: sections[key].description, open: sections[key].open, form: { questions: sections[key].form.questions.map(publicQuestion) } }));
}

const cleanQuestion = (qq) => {
  const out = { key: qq.key, type: qq.type, label: clip(qq.label, 120) || qq.key, help: clip(qq.help, 300), required: qq.required === true };
  if (Array.isArray(qq.options)) out.options = qq.options.map((o) => clip(o, 80)).filter(Boolean);
  if (qq.max !== undefined) out.max = Number(qq.max);
  if (Array.isArray(qq.accept)) out.accept = [...qq.accept];
  if (qq.maxBytes !== undefined) out.maxBytes = Number(qq.maxBytes);
  return out;
};

// Edits from the Settings tab: partial per section, merged over what the
// cycle has now. The interest form keeps the website's fixed questions; the
// other two only need a name and an email.
export function validateSite(next, cycle = null) {
  if (!isObject(next)) throw fail(400, 'Sections must be an object');
  const given = isObject(next.sections) ? next.sections : next;
  const current = sectionsFor(cycle);
  const out = {};
  for (const key of SECTION_KEYS) {
    const s = given[key];
    const cur = { title: current[key].title, description: current[key].description, open: current[key].open, form: { questions: current[key].form.questions.map(cleanQuestion) } };
    if (s !== undefined) {
      if (!isObject(s)) throw fail(400, `${SECTION_LABELS[key]} settings must be an object`);
      if (s.title !== undefined) cur.title = clip(s.title, 80) || SECTION_LABELS[key];
      if (s.description !== undefined) cur.description = String(s.description ?? '').trim().slice(0, 600);
      if (s.open !== undefined) cur.open = s.open === true;
      if (s.form !== undefined) {
        let v;
        try { v = validateFormDoc({ questions: Array.isArray(s.form?.questions) ? s.form.questions : [] }, { required: key === 'interest' ? SYSTEM_KEYS : ['name', 'email'] }); }
        catch (e) { throw fail(e.status || 400, e.error || e.message || 'Invalid form'); }
        cur.form = { questions: v.questions.map(cleanQuestion) };
      }
    }
    out[key] = cur;
  }
  return { sections: out };
}
