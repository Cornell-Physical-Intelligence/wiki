// Forms module: versioned application forms per cycle. Version 0 is always
// the fixed website form (lib/recruit/fixed-form.js); drafts are edited in
// place, publishing swaps the published version in one statement and stamps
// the cycle's form_version. The public GET /recruit/form read is the only
// anonymous route here and carries no counts and no applicant data.

import { FIXED_FORM_V1 } from '../fixed-form.js';

const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const FORM_ID = /^fm-[a-z0-9]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LINK = /^https?:\/\/\S+$/i;
const BASE64 = /^[A-Za-z0-9+/=]+$/;
const TYPES = new Set(['short', 'long', 'email', 'single', 'multi', 'checkbox', 'link', 'file']);
export const FILE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);
export const MAX_FILE = 2621440;
const MAX_QUESTIONS = 60;
const MAX_SECTIONS = 20;
const MAX_OPTIONS = 40;
// System questions map to application columns; the first four must stay,
// project and file may be dropped but never retyped.
const SYSTEM_TYPES = { name: 'short', email: 'email', subteam: 'single', year: 'single', project: 'long', file: 'file' };
const REQUIRED_SYSTEM = ['name', 'email', 'subteam', 'year'];
const ALWAYS_REQUIRED = ['name', 'email'];
const DEFAULT_MAX = { short: 200, long: 1000, email: 200, link: 500 };

const fail = (status, error) => Object.assign(new Error(error), { status, error });
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const clipText = (v, n) => String(v ?? '').trim().slice(0, n);
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const copy = (v) => JSON.parse(JSON.stringify(v));

const cycleSubteams = (cycle) => (Array.isArray(cycle?.doc?.subteams) ? cycle.doc.subteams : []).map((s) => ({ key: String(s.key || ''), name: String(s.name || s.key || '') }));

/* ------------------------------ definitions ----------------------------- */

// Version 0: the fixed form with the cycle's own subteam names as options.
export function fixedForm(cycle) {
  const doc = copy(FIXED_FORM_V1);
  doc.sections ||= [];
  doc.questions ||= [];
  const subteams = cycleSubteams(cycle);
  const q = doc.questions.find((x) => x.key === 'subteam');
  if (q && subteams.length) q.options = subteams.map((s) => s.name);
  return { id: null, cycleId: cycle?.id || null, version: 0, status: 'published', created: null, createdBy: '', published: null, doc };
}

export function validateFormDoc(input, cycle) {
  if (!isObject(input)) throw fail(400, 'The form must be an object with sections and questions');
  const subteamKeys = new Set(cycleSubteams(cycle).map((s) => s.key));
  const sections = [];
  const sectionKeys = new Set();
  if (input.sections !== undefined && !Array.isArray(input.sections)) throw fail(400, 'Sections must be a list');
  if ((input.sections || []).length > MAX_SECTIONS) throw fail(400, `Keep it to ${MAX_SECTIONS} sections`);
  for (const raw of input.sections || []) {
    if (!isObject(raw)) throw fail(400, 'Each section needs a key and a title');
    const key = String(raw.key || '');
    if (!KEY.test(key)) throw fail(400, `Section key "${key.slice(0, 40)}" must be lowercase letters, digits or underscores`);
    if (sectionKeys.has(key)) throw fail(400, `Section key "${key}" is used twice`);
    sectionKeys.add(key);
    const title = clip(raw.title, 80);
    if (!title) throw fail(400, `Give section "${key}" a title`);
    const subteam = raw.subteam == null || raw.subteam === '' ? null : String(raw.subteam);
    if (subteam && subteamKeys.size && !subteamKeys.has(subteam)) throw fail(400, `Section "${title}" points at an unknown subteam`);
    sections.push({ key, title, subteam });
  }
  if (!Array.isArray(input.questions) || !input.questions.length) throw fail(400, 'Add at least one question');
  if (input.questions.length > MAX_QUESTIONS) throw fail(400, `Keep it to ${MAX_QUESTIONS} questions`);
  const seen = new Set();
  const questions = input.questions.map((raw) => {
    if (!isObject(raw)) throw fail(400, 'Each question needs a key, a type and a label');
    const key = String(raw.key || '');
    if (!KEY.test(key)) throw fail(400, `Question key "${key.slice(0, 40)}" must be lowercase letters, digits or underscores`);
    if (seen.has(key)) throw fail(400, `Question key "${key}" is used twice`);
    seen.add(key);
    const type = String(raw.type || '');
    if (!TYPES.has(type)) throw fail(400, `Question "${key}" has an unknown type`);
    const system = Object.hasOwn(SYSTEM_TYPES, key);
    if (system && SYSTEM_TYPES[key] !== type) throw fail(400, `"${key}" is a system question and stays a ${SYSTEM_TYPES[key]} field`);
    const label = clip(raw.label, 120);
    if (!label) throw fail(400, `Give question "${key}" a label`);
    const q = {
      key, type, label,
      help: clip(raw.help, 300),
      required: ALWAYS_REQUIRED.includes(key) ? true : raw.required === true,
      system,
      options: [],
      max: null,
      accept: [],
      maxBytes: null,
      section: raw.section == null || raw.section === '' ? null : String(raw.section),
      subteamOnly: raw.subteamOnly == null || raw.subteamOnly === '' ? null : String(raw.subteamOnly),
    };
    if (q.section && !sectionKeys.has(q.section)) throw fail(400, `Question "${label}" points at an unknown section`);
    if (q.subteamOnly && subteamKeys.size && !subteamKeys.has(q.subteamOnly)) throw fail(400, `Question "${label}" points at an unknown subteam`);
    if (type === 'single' || type === 'multi') {
      if (!Array.isArray(raw.options)) throw fail(400, `Question "${label}" needs choices`);
      q.options = [...new Set(raw.options.map((o) => clip(o, 80)).filter(Boolean))];
      if (!q.options.length) throw fail(400, `Question "${label}" needs at least one choice`);
      if (q.options.length > MAX_OPTIONS) throw fail(400, `Question "${label}" can offer at most ${MAX_OPTIONS} choices`);
    }
    if (type === 'short' || type === 'long' || type === 'email' || type === 'link') {
      const cap = type === 'long' ? 4000 : 500;
      const max = raw.max == null || raw.max === '' ? DEFAULT_MAX[type] : Number(raw.max);
      if (!Number.isInteger(max) || max < 1 || max > cap) throw fail(400, `Question "${label}" length limit is 1 to ${cap}`);
      q.max = max;
    }
    if (type === 'file') {
      const accept = Array.isArray(raw.accept) && raw.accept.length ? raw.accept.map(String) : [...FILE_TYPES];
      for (const t of accept) if (!FILE_TYPES.has(t)) throw fail(400, `Question "${label}" accepts an unsupported file type`);
      q.accept = [...new Set(accept)];
      const maxBytes = raw.maxBytes == null || raw.maxBytes === '' ? MAX_FILE : Number(raw.maxBytes);
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FILE) throw fail(400, `Question "${label}" file limit is at most ${MAX_FILE} bytes`);
      q.maxBytes = maxBytes;
    }
    return q;
  });
  for (const key of REQUIRED_SYSTEM) if (!seen.has(key)) throw fail(400, `The "${key}" question cannot be removed`);
  return { sections, questions };
}

// What the website sees: the definition only.
export function publicForm(cycle, form) {
  const doc = form.doc || {};
  return {
    version: form.version,
    sections: (doc.sections || []).map((s) => ({ key: s.key, title: s.title, subteam: s.subteam ?? null })),
    questions: (doc.questions || []).map((q) => ({
      key: q.key, type: q.type, label: q.label, help: q.help || '', required: q.required === true,
      options: q.options || [], max: q.max ?? null, accept: q.accept || [], maxBytes: q.maxBytes ?? null,
      section: q.section ?? null, subteamOnly: q.subteamOnly ?? null,
    })),
  };
}

/* --------------------------------- answers ------------------------------ */

const subteamKeyOf = (cycle, value) => {
  const v = String(value || '').trim();
  if (!v) return null;
  return cycleSubteams(cycle).find((s) => s.key === v || s.name === v)?.key || null;
};

// Dynamic validation for POST /recruit/apply: unknown keys dropped, required
// questions checked only in visible sections, values coerced and clipped,
// system keys mirrored to columns. Returns { columns, answers, files } or { error }.
export function validateAnswers(formDoc, body, cycle) {
  const doc = formDoc?.doc || formDoc || {};
  const questions = Array.isArray(doc.questions) ? doc.questions : [];
  const sections = Array.isArray(doc.sections) ? doc.sections : [];
  const raw = isObject(body?.answers) ? body.answers : {};
  const rawFiles = isObject(body?.files) ? body.files : {};
  const subteams = cycleSubteams(cycle);
  const subteamQ = questions.find((q) => q.key === 'subteam');
  const subteamValue = String(raw.subteam ?? '').trim();
  let subteamName = '';
  if (subteamValue) {
    // The cycle's subteams win; otherwise the question's own option list.
    const match = subteams.find((s) => s.key === subteamValue || s.name === subteamValue)
      || ((subteamQ?.options || []).includes(subteamValue) ? { key: subteamKeyOf(cycle, subteamValue), name: subteamValue } : null);
    if (!match) return { error: 'Choose a subteam from the list' };
    subteamName = match.name;
  }
  const chosenKey = subteamName ? (subteams.find((s) => s.name === subteamName)?.key || null) : null;
  const visibleSection = (key) => {
    if (!key) return true;
    const s = sections.find((x) => x.key === key);
    if (!s) return true;
    return !s.subteam || s.subteam === chosenKey;
  };
  const answers = {};
  const columns = { name: '', email: '', subteam: subteamName, year: null, cornell: false };
  const files = [];
  for (const q of questions) {
    const visible = visibleSection(q.section) && (!q.subteamOnly || q.subteamOnly === chosenKey);
    let value = raw[q.key];
    if (q.key === 'subteam') { if (q.required && visible && !subteamName) return { error: `${q.label} is required` }; continue; }
    if (q.type === 'file') {
      const f = rawFiles[q.key];
      if (!f || !f.data) { if (q.required && visible) return { error: `${q.label} is required` }; continue; }
      if (!visible) continue;
      const data = String(f.data);
      if (!BASE64.test(data)) return { error: 'The file did not decode' };
      const size = Buffer.from(data, 'base64').length;
      if (!size) continue;
      if (size > (q.maxBytes || MAX_FILE)) return { error: `${q.label} is capped at ${Math.round((q.maxBytes || MAX_FILE) / 1024 / 1024 * 10) / 10} MB` };
      const type = String(f.type || '');
      if (!(q.accept?.length ? q.accept : [...FILE_TYPES]).includes(type)) return { error: `${q.label} accepts ${(q.accept?.length ? q.accept : [...FILE_TYPES]).join(', ')}` };
      files.push({ question: q.key, name: clip(f.name, 200) || 'file', type, size, data });
      continue;
    }
    if (!visible) continue;
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length) || (q.type === 'checkbox' && value !== true && value !== 'true' && value !== 1);
    if (empty) {
      if (q.required) return { error: `${q.label} is required` };
      if (q.type === 'checkbox') value = false; else continue;
    }
    switch (q.type) {
      case 'short': value = clip(value, q.max || DEFAULT_MAX.short); break;
      case 'long': value = clipText(value, q.max || DEFAULT_MAX.long); break;
      case 'email': {
        value = String(value).trim().toLowerCase().slice(0, q.max || DEFAULT_MAX.email);
        if (!EMAIL.test(value)) return { error: `${q.label} needs a valid email address` };
        break;
      }
      case 'link': {
        value = String(value).trim().slice(0, q.max || DEFAULT_MAX.link);
        if (!LINK.test(value)) return { error: `${q.label} must start with http:// or https://` };
        break;
      }
      case 'single': {
        value = String(value).trim();
        if (!(q.options || []).includes(value)) return { error: `Choose ${q.label} from the list` };
        break;
      }
      case 'multi': {
        const list = Array.isArray(value) ? value : [value];
        value = [...new Set(list.map((v) => String(v).trim()))];
        if (value.some((v) => !(q.options || []).includes(v))) return { error: `Choose ${q.label} from the list` };
        break;
      }
      case 'checkbox': value = value === true || value === 'true' || value === 1; break;
      default: continue;
    }
    if (value === '' && q.type !== 'checkbox') continue;
    if (q.key === 'name') { columns.name = value; if (!columns.name) return { error: 'Name is required' }; continue; }
    if (q.key === 'email') { columns.email = value; columns.cornell = value.endsWith('@cornell.edu') || value.endsWith('.cornell.edu'); continue; }
    if (q.key === 'year') { columns.year = value; continue; }
    answers[q.key] = value;
  }
  if (!columns.name) return { error: 'Name is required' };
  if (!columns.email) return { error: 'A valid email is required' };
  return { columns, answers, files };
}

/* -------------------------------- storage ------------------------------- */

const asRow = (r) => ({
  id: r.id, cycleId: r.cycle_id, version: Number(r.version), status: r.status,
  created: r.created == null ? null : Number(r.created), createdBy: r.created_by || '',
  published: r.published == null ? null : Number(r.published),
  doc: typeof r.doc === 'string' ? JSON.parse(r.doc) : (r.doc || {}),
});
const summaryOf = (f) => ({ id: f.id, version: f.version, status: f.status, created: f.created, createdBy: f.createdBy, published: f.published });
const memForms = (kit, cycle) => (kit.mem.forms || []).filter((f) => f.cycleId === cycle.id);

async function listForms(kit, cycle) {
  if (kit.mode === 'memory') return memForms(kit, cycle).sort((a, b) => a.version - b.version).map((f) => ({ ...f }));
  const s = await kit.sql();
  const r = await s`SELECT * FROM recruit_forms WHERE cycle_id = ${cycle.id} ORDER BY version`;
  return r.rows.map(asRow);
}

async function getForm(kit, cycle, { id = null, version = null }) {
  if (version === 0) return fixedForm(cycle);
  if (kit.mode === 'memory') {
    const f = memForms(kit, cycle).find((x) => (id ? x.id === id : x.version === version));
    return f ? { ...f } : null;
  }
  const s = await kit.sql();
  const r = await s`SELECT * FROM recruit_forms WHERE cycle_id = ${cycle.id} AND (${id}::text IS NULL OR id = ${id}) AND (${version}::int IS NULL OR version = ${version}) LIMIT 1`;
  return r.rows[0] ? asRow(r.rows[0]) : null;
}

async function createDraft(kit, cycle, doc, me) {
  const now = kit.now();
  if (kit.mode === 'memory') {
    kit.mem.forms ||= [];
    const version = memForms(kit, cycle).reduce((m, f) => Math.max(m, f.version), 0) + 1;
    const row = { id: kit.id('fm'), cycleId: cycle.id, version, status: 'draft', created: now, createdBy: me, published: null, doc };
    kit.mem.forms.push(row);
    kit.memSave();
    return { ...row };
  }
  const s = await kit.sql();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await s`INSERT INTO recruit_forms (id, cycle_id, version, status, created, created_by, doc)
        SELECT ${kit.id('fm')}, ${cycle.id}, COALESCE(MAX(version), 0) + 1, 'draft', ${now}, ${me}, ${JSON.stringify(doc)}::jsonb
        FROM recruit_forms WHERE cycle_id = ${cycle.id} RETURNING *`;
      return asRow(r.rows[0]);
    } catch (e) {
      if (e?.code !== '23505' || attempt) throw e;
    }
  }
  return null;
}

async function updateDraft(kit, cycle, id, doc) {
  if (kit.mode === 'memory') {
    const f = memForms(kit, cycle).find((x) => x.id === id);
    if (!f) throw fail(404, 'No such form');
    if (f.status !== 'draft') throw fail(409, 'Only drafts can be edited');
    f.doc = doc;
    kit.memSave();
    return { ...f };
  }
  const s = await kit.sql();
  const r = await s`UPDATE recruit_forms SET doc = ${JSON.stringify(doc)}::jsonb WHERE id = ${id} AND cycle_id = ${cycle.id} AND status = 'draft' RETURNING *`;
  if (r.rows[0]) return asRow(r.rows[0]);
  const current = await getForm(kit, cycle, { id });
  if (!current) throw fail(404, 'No such form');
  throw fail(409, 'Only drafts can be edited');
}

// One statement swaps the published version; the cycle pointer follows.
async function publishForm(kit, cycle, id) {
  const now = kit.now();
  if (kit.mode === 'memory') {
    let target = null;
    for (const f of memForms(kit, cycle)) {
      if (f.id === id) { f.status = 'published'; f.published = now; target = f; }
      else if (f.status === 'published') f.status = 'superseded';
    }
    if (!target) throw fail(404, 'No such form');
    const c = (kit.mem.cycles || []).find((x) => x.id === cycle.id);
    if (c && (c.formVersion ?? 0) < target.version) c.formVersion = target.version;
    kit.memSave();
    return { ...target };
  }
  const s = await kit.sql();
  const r = await s`UPDATE recruit_forms SET status = CASE WHEN id = ${id} THEN 'published' WHEN status = 'published' THEN 'superseded' ELSE status END,
      published = CASE WHEN id = ${id} THEN ${now} ELSE published END
    WHERE cycle_id = ${cycle.id} AND (id = ${id} OR status = 'published') RETURNING id, status, version`;
  const target = r.rows.find((x) => x.id === id);
  if (!target) throw fail(404, 'No such form');
  const version = Number(target.version);
  await s`UPDATE recruit_cycles SET form_version = ${version} WHERE id = ${cycle.id} AND form_version < ${version}`;
  const row = await getForm(kit, cycle, { id });
  return row || { id, cycleId: cycle.id, version, status: 'published', published: now };
}

/* -------------------------------- routes -------------------------------- */

const PUBLIC_HEADERS = { 'cache-control': 'public, max-age=60' };

async function publicRead(rq, kit) {
  let target = null;
  try { target = await kit.cycles.intakeTarget(); } catch { target = null; }
  if (!target?.cycleId) return { status: 200, body: { open: false }, headers: PUBLIC_HEADERS };
  const cycle = await kit.cycles.get(target.cycleId);
  if (!cycle || cycle.status !== 'open') return { status: 200, body: { open: false }, headers: PUBLIC_HEADERS };
  const version = Number(target.formVersion ?? cycle.formVersion ?? 0) || 0;
  let form = version > 0 ? await getForm(kit, cycle, { version }) : null;
  if (!form || form.status !== 'published') form = fixedForm(cycle);
  return {
    status: 200,
    headers: PUBLIC_HEADERS,
    body: {
      open: true,
      cycle: { id: cycle.id, name: cycle.name, term: cycle.term || '', closesAt: cycle.closesAt ?? null, subteams: cycleSubteams(cycle) },
      form: publicForm(cycle, form),
    },
  };
}

async function list(rq, kit) {
  const forms = await listForms(kit, rq.cycle);
  const published = forms.filter((f) => f.status === 'published').reduce((m, f) => Math.max(m, f.version), 0);
  return { status: 200, body: { forms: [summaryOf(fixedForm(rq.cycle)), ...forms.map(summaryOf)], current: published || Number(rq.cycle.formVersion || 0) } };
}

async function read(rq, kit) {
  const version = Number(rq.params.version);
  const form = await getForm(kit, rq.cycle, { version });
  if (!form) throw fail(404, 'No such form version');
  return { status: 200, body: { form } };
}

async function create(rq, kit) {
  const body = await rq.body();
  let doc;
  if (body.doc !== undefined) doc = validateFormDoc(body.doc, rq.cycle);
  else {
    const from = body.from === undefined ? Number(rq.cycle.formVersion || 0) : Number(body.from);
    if (!Number.isInteger(from) || from < 0) throw fail(400, 'Choose a version to copy');
    const base = await getForm(kit, rq.cycle, { version: from });
    if (!base) throw fail(404, 'No such form version');
    doc = validateFormDoc(base.doc, rq.cycle);
  }
  const form = await createDraft(kit, rq.cycle, doc, rq.me.email);
  if (!form) throw fail(409, 'Another draft was created at the same time. Try again.');
  return { status: 201, body: { form } };
}

async function patch(rq, kit) {
  const body = await rq.body();
  const doc = validateFormDoc(body.doc, rq.cycle);
  const form = await updateDraft(kit, rq.cycle, rq.params.form, doc);
  return { status: 200, body: { form } };
}

async function publish(rq, kit) {
  const current = await getForm(kit, rq.cycle, { id: rq.params.form });
  if (!current) throw fail(404, 'No such form');
  if (current.status === 'published') return { status: 200, body: { form: current, current: current.version } };
  if (current.status !== 'draft') throw fail(409, 'This version was superseded. Copy it into a new draft to publish it again.');
  validateFormDoc(current.doc, rq.cycle);
  const form = await publishForm(kit, rq.cycle, current.id);
  return { status: 200, body: { form, current: form.version }, audit: { kind: 'form.publish', target: null, detail: { formId: form.id, version: form.version } } };
}

export default {
  name: 'forms',
  kernel: false,
  order: 40,
  schema: [
    `CREATE TABLE IF NOT EXISTS recruit_forms (id text PRIMARY KEY, cycle_id text NOT NULL, version int NOT NULL, status text NOT NULL DEFAULT 'draft', created bigint, created_by text, published bigint, doc jsonb NOT NULL, UNIQUE (cycle_id, version))`,
  ],
  memory: { forms: [] },
  defaults: () => ({}),
  validateSettings: (next) => { if (next !== undefined && !isObject(next)) throw fail(400, 'Form settings must be an object'); return {}; },
  routes: [
    { method: 'GET', path: '/form', public: true, access: 'public', handler: publicRead },
    { method: 'GET', path: '/cycles/:cycle/forms', access: 'lead', handler: list },
    { method: 'GET', path: '/cycles/:cycle/forms/:version', access: 'role', handler: read },
    { method: 'POST', path: '/cycles/:cycle/forms', access: 'lead', mutates: true, cap: 262144, handler: create },
    { method: 'PATCH', path: '/cycles/:cycle/forms/:form', access: 'lead', mutates: true, cap: 262144, handler: patch },
    { method: 'POST', path: '/cycles/:cycle/forms/:form/publish', access: 'lead', mutates: true, handler: publish },
  ],
  hooks: {},
  collect: {},
  auditKinds: ['form.publish'],
};
