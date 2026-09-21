// The fixed website form (form_version 0) and the answer validator. Pure:
// no storage, no imports beyond Node. The vocabularies mirror interest.js
// exactly (the kernel test asserts the two never drift), so the public POST
// keeps validating against the same names the website ships.

export const SUBTEAMS = ['Mechanical', 'Electrical', 'Software', 'Creative', 'Business & Marketing'];
export const YEARS = ['Freshman', 'Sophomore', 'Junior', 'Senior', 'Grad'];
export const FILE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'];
export const MAX_FILE = 2.5 * 1024 * 1024;
export const INTAKE_VOCAB = { SUBTEAMS: new Set(SUBTEAMS), YEARS: new Set(YEARS), FILE_TYPES: new Set(FILE_TYPES), MAX_FILE };

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const QUESTION_KEY = /^[a-z][a-z0-9_]{0,39}$/;
export const QUESTION_TYPES = ['short', 'long', 'email', 'single', 'multi', 'checkbox', 'link', 'file'];
export const SYSTEM_KEYS = ['name', 'email', 'subteam', 'year', 'project', 'file'];
export const COLUMN_KEYS = ['name', 'email', 'subteam', 'year'];

export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const isCornell = (email) => String(email || '').endsWith('@cornell.edu') || String(email || '').endsWith('.cornell.edu');

export const DEFAULT_SUBTEAMS = SUBTEAMS.map((name) => ({ key: slug(name), name, capacity: 0, leads: [] }));

// Fallback stage list used by the kernel when the pipeline module is not
// mounted; the pipeline module's own defaults are authoritative for cycles.
export const DEFAULT_STAGES = [
  { key: 'applied', name: 'Applied', kind: 'open' },
  { key: 'screening', name: 'Screening', kind: 'open' },
  { key: 'interview', name: 'Interview', kind: 'open' },
  { key: 'decision', name: 'Decision', kind: 'open' },
  { key: 'offer', name: 'Offer', kind: 'open' },
  { key: 'waitlisted', name: 'Waitlisted', kind: 'hold', outcome: 'waitlisted' },
  { key: 'accepted', name: 'Accepted', kind: 'closed', outcome: 'accepted' },
  { key: 'declined', name: 'Declined', kind: 'closed', outcome: 'declined' },
  { key: 'rejected', name: 'Rejected', kind: 'closed', outcome: 'rejected' },
];

export const FIXED_FORM_V1 = Object.freeze({
  version: 0,
  sections: [{ key: 'about', title: 'About you', subteam: null }],
  questions: [
    { key: 'name', type: 'short', label: 'Name', help: '', required: true, system: true, max: 100, section: 'about', subteamOnly: null },
    { key: 'email', type: 'email', label: 'Email', help: '', required: true, system: true, max: 200, section: 'about', subteamOnly: null },
    { key: 'subteam', type: 'single', label: 'Subteam', help: '', required: false, system: true, options: [...SUBTEAMS], section: 'about', subteamOnly: null },
    { key: 'year', type: 'single', label: 'Year', help: '', required: false, system: true, options: [...YEARS], section: 'about', subteamOnly: null },
    { key: 'project', type: 'long', label: 'Coolest project', help: '', required: false, system: true, max: 1000, section: 'about', subteamOnly: null },
    { key: 'file', type: 'file', label: 'File', help: '', required: false, system: true, accept: [...FILE_TYPES], maxBytes: MAX_FILE, section: 'about', subteamOnly: null },
  ],
});

// The fixed form with the cycle's own subteam names as the subteam options.
export function fixedFormFor(cycle) {
  const doc = JSON.parse(JSON.stringify(FIXED_FORM_V1));
  const subteams = Array.isArray(cycle?.doc?.subteams) ? cycle.doc.subteams.map((s) => s?.name).filter(Boolean) : [];
  if (subteams.length) doc.questions.find((q) => q.key === 'subteam').options = subteams;
  return doc;
}

const err = (error, status = 400) => ({ error, status });
const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isPlainObject = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));

// Which sections are visible for the chosen subteam. A section pinned to a
// subteam is visible only when the applicant picked that subteam (by key or
// by name); questions marked subteamOnly follow the same rule.
function visibleFor(formDoc, subteamAnswer) {
  const picked = slug(subteamAnswer);
  const sections = new Map((formDoc.sections || []).map((s) => [s.key, s]));
  return (q) => {
    const sec = sections.get(q.section);
    if (sec?.subteam && slug(sec.subteam) !== picked) return false;
    if (q.subteamOnly && slug(q.subteamOnly) !== picked) return false;
    return true;
  };
}

// validateAnswers(formDoc, body, cycle) → { columns, answers, files } | { error, status }
// body: { answers:{ key:value }, files:{ key:{ name, type, data } } } or the
// flat legacy shape { name, email, subteam, year, project, file }. Unknown
// keys are dropped, types coerced and clipped, system keys mirrored to columns.
export function validateAnswers(formDoc, body, cycle = null) {
  const form = formDoc || fixedFormFor(cycle);
  const src = isPlainObject(body) ? body : {};
  const given = isPlainObject(src.answers) ? src.answers : {};
  const filesGiven = isPlainObject(src.files) ? src.files : {};
  const valueOf = (key) => (Object.hasOwn(given, key) ? given[key] : src[key]);
  const hasKey = (key) => Object.hasOwn(given, key) || Object.hasOwn(src, key);
  const fileOf = (key) => filesGiven[key] ?? (key === 'file' ? src.file : undefined);

  // Subteam first: it decides which sections are visible.
  const subteamQ = (form.questions || []).find((q) => q.key === 'subteam');
  const subteamRaw = text(valueOf('subteam'), 80);
  const subteamOptions = subteamQ?.options || SUBTEAMS;
  const subteamMatch = subteamOptions.find((o) => o === subteamRaw || slug(o) === slug(subteamRaw));
  const subteam = subteamMatch || '';
  const visible = visibleFor(form, subteam);

  const columns = { name: '', email: '', cornell: false, subteam, year: null, hasYear: hasKey('year') };
  const answers = {};
  const files = [];

  for (const q of form.questions || []) {
    if (!q || !QUESTION_KEY.test(String(q.key || ''))) continue;
    const key = q.key;
    const label = q.label || key;
    if (!visible(q)) continue;
    if (key === 'subteam') { continue; }
    const raw = valueOf(key);
    const present = raw !== undefined && raw !== null && raw !== '';
    if (q.type === 'file') {
      const f = fileOf(key);
      if (f && typeof f === 'object' && f.data) {
        const data = String(f.data);
        if (!/^[A-Za-z0-9+/=]+$/.test(data)) return err('The file did not decode');
        const buf = Buffer.from(data, 'base64');
        if (buf.length) {
          const maxBytes = Number(q.maxBytes) > 0 ? Math.min(Number(q.maxBytes), MAX_FILE) : MAX_FILE;
          if (buf.length > maxBytes) return err(maxBytes === MAX_FILE ? 'Files are capped at 2.5 MB' : `Files for ${label} are capped at ${Math.round(maxBytes / 1024)} KB`, 413);
          const type = String(f.type || '');
          const accept = Array.isArray(q.accept) && q.accept.length ? q.accept.filter((t) => FILE_TYPES.includes(t)) : FILE_TYPES;
          if (!accept.includes(type)) return err('Images or PDF only');
          files.push({ question: key, name: String(f.name || 'project').slice(0, 200), type, size: buf.length, data: buf });
          continue;
        }
      }
      if (q.required && !files.some((x) => x.question === key)) return err(`Attach a file for ${label}`);
      continue;
    }
    if (key === 'name') {
      columns.name = text(raw, q.max || 100);
      if (!columns.name) return err('Tell us your name');
      continue;
    }
    if (key === 'email') {
      columns.email = String(raw ?? '').trim().toLowerCase().slice(0, q.max || 200);
      if (!EMAIL_RE.test(columns.email)) return err('That email does not look right');
      columns.cornell = isCornell(columns.email);
      continue;
    }
    if (key === 'year') {
      if (columns.hasYear && raw != null && raw !== '' && !(q.options || YEARS).includes(raw)) {
        const opts = q.options || YEARS;
        return err(`Choose ${opts.slice(0, -1).join(', ')}, or ${opts[opts.length - 1]} for ${q.key}`);
      }
      columns.year = (q.options || YEARS).includes(raw) ? raw : null;
      continue;
    }
    switch (q.type) {
      case 'short': case 'long': case 'email': {
        const v = q.type === 'long' ? String(raw ?? '').trim().slice(0, q.max || 1000) : text(raw, q.max || (q.type === 'email' ? 200 : 200));
        if (q.type === 'email' && v && !EMAIL_RE.test(v.toLowerCase())) return err(`That email for ${label} does not look right`);
        if (q.required && !v) return err(`${label} is required`);
        if (present || q.required) answers[key] = q.type === 'email' ? v.toLowerCase() : v;
        break;
      }
      case 'single': {
        const v = text(raw, 120);
        const opts = Array.isArray(q.options) ? q.options : [];
        if (v && !opts.includes(v)) return err(`Choose one of the options for ${label}`);
        if (q.required && !v) return err(`Choose an option for ${label}`);
        if (present) answers[key] = v;
        break;
      }
      case 'multi': {
        const list = Array.isArray(raw) ? raw : (present ? [raw] : []);
        const opts = Array.isArray(q.options) ? q.options : [];
        const v = [...new Set(list.map((x) => text(x, 120)).filter(Boolean))];
        if (v.some((x) => !opts.includes(x))) return err(`Choose from the options for ${label}`);
        if (q.required && !v.length) return err(`Choose at least one option for ${label}`);
        if (present) answers[key] = v;
        break;
      }
      case 'checkbox': {
        const v = raw === true || raw === 'true' || raw === 'on' || raw === 1;
        if (q.required && !v) return err(`${label} must be checked`);
        if (present) answers[key] = v;
        break;
      }
      case 'link': {
        const v = text(raw, q.max || 500);
        if (v && !/^https?:\/\/\S+$/i.test(v)) return err(`${label} must start with http:// or https://`);
        if (q.required && !v) return err(`${label} is required`);
        if (present || q.required) answers[key] = v;
        break;
      }
      default:
        break;
    }
  }
  if (!columns.email) return err('That email does not look right');
  if (!columns.name) return err('Tell us your name');
  return { columns, answers, files };
}

// Validate a form document as stored in recruit_forms.doc. Throws { status, error }.
export function validateFormDoc(doc, { required = SYSTEM_KEYS } = {}) {
  if (!isPlainObject(doc)) throw err('The form must be an object');
  const sections = Array.isArray(doc.sections) ? doc.sections : [];
  const questions = Array.isArray(doc.questions) ? doc.questions : [];
  if (questions.length > 60) throw err('Keep it to 60 questions');
  const sectionKeys = new Set();
  for (const s of sections) {
    if (!isPlainObject(s) || !QUESTION_KEY.test(String(s.key || ''))) throw err('Each section needs a key');
    if (sectionKeys.has(s.key)) throw err(`Section "${s.key}" is listed twice`);
    sectionKeys.add(s.key);
  }
  const seen = new Set();
  const system = new Map(FIXED_FORM_V1.questions.map((q) => [q.key, q]));
  for (const q of questions) {
    if (!isPlainObject(q) || !QUESTION_KEY.test(String(q.key || ''))) throw err('Each question needs a key of lowercase letters, digits or underscores');
    if (seen.has(q.key)) throw err(`Question "${q.key}" is listed twice`);
    seen.add(q.key);
    if (!QUESTION_TYPES.includes(q.type)) throw err(`Question "${q.key}" has an unknown type`);
    if (required.includes(q.key) && system.has(q.key) && system.get(q.key).type !== q.type) throw err(`The ${q.key} question cannot change type`);
    if (String(q.label || '').length > 120) throw err(`The label for "${q.key}" is too long`);
    if (String(q.help || '').length > 300) throw err(`The help text for "${q.key}" is too long`);
    if (q.options !== undefined && (!Array.isArray(q.options) || q.options.length > 40)) throw err(`"${q.key}" may have up to 40 options`);
    if (q.max !== undefined && !(Number(q.max) > 0 && Number(q.max) <= 20000)) throw err(`"${q.key}" has an invalid length limit`);
    if (q.maxBytes !== undefined && !(Number(q.maxBytes) > 0 && Number(q.maxBytes) <= 2621440)) throw err(`"${q.key}" files are capped at 2.5 MB`);
    if (q.accept !== undefined && (!Array.isArray(q.accept) || q.accept.some((t) => !FILE_TYPES.includes(t)))) throw err(`"${q.key}" accepts images or PDF only`);
    if (q.section !== undefined && q.section !== null && !sectionKeys.has(q.section)) throw err(`"${q.key}" points at a missing section`);
  }
  for (const key of required) if (!seen.has(key)) throw err(`The ${key} question cannot be removed`);
  return { sections, questions };
}
