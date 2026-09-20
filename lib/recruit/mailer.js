// Pure template helpers for recruitment email. No storage, no network: a
// template plus merge values in, subject/html/text out. Every merged value is
// escaped; a field the template names but the merge cannot fill is reported
// so the sender skips that recipient instead of mailing a blank.

export const MERGE_FIELDS = [
  'name', 'firstName', 'email', 'cycle', 'term', 'subteam', 'year', 'stage', 'club', 'contactEmail',
  'sender.name', 'decision.reason', 'interview.round', 'interview.date', 'interview.time', 'interview.place', 'rsvpUrl',
];
const FIELD_SET = new Set(MERGE_FIELDS);
export const TEMPLATE_KEY = /^(received|interview_invite|offer|rejection|waitlist|custom-[a-z0-9-]{1,30})$/;
export const SUBJECT_MAX = 200;
export const BODY_MAX = 8000;
export const CLUB = 'Cornell Physical Intelligence';
export const CONTACT_EMAIL = 'cuphysint@cornell.edu';

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// {{field}}, {{button:Label|url-or-field}}. The lazy body match keeps nested
// braces out so a stray "{{" cannot swallow a paragraph.
const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;

export const DEFAULT_TEMPLATES = {
  received: {
    subject: 'We received your application to {{club}}',
    body: 'Hi {{firstName}},\n\nThanks for applying to {{club}} for {{term}}. Your application is in, and the team will read it soon.\n\nIf anything changes, reply to this email.',
    auto: true,
  },
  interview_invite: {
    subject: '{{club}}: your interview',
    body: 'Hi {{firstName}},\n\nWe would like to talk with you. Your {{interview.round}} is on {{interview.date}} at {{interview.time}}{{interview.place}}.\n\nConfirm or decline below.\n\n{{button:Respond|rsvpUrl}}',
    auto: true,
  },
  offer: {
    subject: 'Welcome to {{club}}',
    body: 'Hi {{firstName}},\n\nWe would like you to join {{club}}{{subteam}}. Reply to this email to accept, and we will get you set up.',
    auto: false,
  },
  rejection: {
    subject: 'Your application to {{club}}',
    body: 'Hi {{firstName}},\n\nThank you for applying to {{club}} for {{term}}. We are not able to offer you a place this cycle.\n\nWe hope you apply again.',
    auto: false,
  },
  waitlist: {
    subject: 'Your application to {{club}}',
    body: 'Hi {{firstName}},\n\nThank you for applying to {{club}} for {{term}}. You are on our waitlist, and we will write again if a place opens.',
    auto: false,
  },
};

function parseToken(raw) {
  if (raw.startsWith('button:')) {
    const rest = raw.slice(7);
    const bar = rest.lastIndexOf('|');
    if (bar < 0) return { kind: 'button', label: rest.trim(), target: '' };
    return { kind: 'button', label: rest.slice(0, bar).trim(), target: rest.slice(bar + 1).trim() };
  }
  return { kind: 'field', name: raw };
}

// Every merge field a template refers to, including the target of a button.
export function fieldsIn(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(TOKEN)) {
    const t = parseToken(m[1]);
    if (t.kind === 'field') out.add(t.name);
    else if (t.target && !/^https?:\/\//i.test(t.target)) out.add(t.target);
  }
  return out;
}

export function unknownFields(...texts) {
  const bad = new Set();
  for (const text of texts) for (const f of fieldsIn(text)) if (!FIELD_SET.has(f)) bad.add(f);
  return [...bad];
}

export function missingFields(tpl, merge) {
  const missing = new Set();
  for (const text of [tpl?.subject, tpl?.body]) {
    for (const f of fieldsIn(text)) if (FIELD_SET.has(f) && !String(merge?.[f] ?? '').trim()) missing.add(f);
  }
  return [...missing];
}

const trimUrl = (u) => u.replace(/[.,;:!?)]+$/, '');

// Escaped text in, escaped text with anchors out. URLs stop at whitespace and
// at the "<" that escaping turned into &lt;, so no markup can leak.
function autoLink(escaped) {
  return escaped.replace(/https?:\/\/[^\s<]+/g, (raw) => {
    const url = trimUrl(raw);
    const tail = raw.slice(url.length);
    return `<a href="${url}" style="color:#141414">${url}</a>${tail}`;
  });
}

function fillValue(name, merge) {
  return String(merge?.[name] ?? '');
}

function targetUrl(target, merge) {
  if (/^https?:\/\//i.test(target)) return target;
  return fillValue(target, merge);
}

const BUTTON = (label, url) => `<p style="margin:22px 0"><a href="${esc(url)}" style="display:inline-block;background:#141414;color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:6px;font-weight:600">${esc(label)}</a></p>`;

function paragraphHtml(paragraph, merge) {
  let out = '';
  let last = 0;
  const onlyButton = paragraph.trim().match(/^\{\{\s*button:[^{}]*\}\}$/);
  for (const m of paragraph.matchAll(TOKEN)) {
    out += autoLink(esc(paragraph.slice(last, m.index))).replace(/\n/g, '<br>');
    const t = parseToken(m[1]);
    if (t.kind === 'button') {
      const url = targetUrl(t.target, merge);
      out += onlyButton ? BUTTON(t.label, url) : `<a href="${esc(url)}" style="color:#141414;font-weight:600">${esc(t.label)}</a>`;
    } else if (t.name === 'rsvpUrl') {
      const url = fillValue(t.name, merge);
      out += `<a href="${esc(url)}" style="color:#141414">${esc(url)}</a>`;
    } else {
      out += esc(fillValue(t.name, merge));
    }
    last = m.index + m[0].length;
  }
  out += autoLink(esc(paragraph.slice(last))).replace(/\n/g, '<br>');
  return onlyButton ? out : `<p style="margin:0 0 14px;line-height:1.5">${out}</p>`;
}

export function fillText(text, merge) {
  return String(text ?? '').replace(TOKEN, (_all, raw) => {
    const t = parseToken(raw);
    if (t.kind === 'button') return `${t.label}: ${targetUrl(t.target, merge)}`;
    return fillValue(t.name, merge);
  });
}

// The house shell: system-ui, 520px, the Georgia wordmark, an eyebrow naming
// the cycle, and a footer that says who wrote and how to reach them.
export function shellHtml({ eyebrow, bodyHtml }) {
  return `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:0 4px;color:#141414;background:#ffffff">
    <div style="font-size:34px;font-weight:700;font-family:Georgia,serif;margin:28px 0 4px">CUPI</div>
    <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#888;margin-bottom:18px">${esc(eyebrow || CLUB)}</div>
    ${bodyHtml}
    <p style="color:#777;font-size:12.5px;margin-top:26px">Sent by Cornell Physical Intelligence recruitment. Reply to reach the team.</p>
  </div>`;
}

export function renderTemplate(tpl, merge = {}) {
  const warnings = [];
  const subjectSrc = String(tpl?.subject ?? '').slice(0, SUBJECT_MAX);
  const bodySrc = String(tpl?.body ?? '').slice(0, BODY_MAX);
  for (const f of unknownFields(subjectSrc, bodySrc)) warnings.push(`Unknown field {{${f}}}`);
  for (const f of missingFields({ subject: subjectSrc, body: bodySrc }, merge)) warnings.push(`Missing ${f}`);
  const subject = fillText(subjectSrc, merge).replace(/\s+/g, ' ').trim();
  const paragraphs = bodySrc.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/).map((p) => p.trim()).filter(Boolean);
  const bodyHtml = paragraphs.map((p) => paragraphHtml(p, merge)).join('\n');
  const html = shellHtml({ eyebrow: merge.cycle || merge.club || CLUB, bodyHtml });
  const text = fillText(bodySrc, merge).replace(/\r\n?/g, '\n').trim();
  return { subject, html, text, warnings };
}

// Lifecycle templates key their send by template; per-booking mail carries
// the booking id; ad-hoc announcements carry the request id; "Send again"
// gets a suffix so the once-only index lets it through.
export function purposeKeyFor(templateKey, ctx = {}) {
  let key;
  if (ctx.purpose) key = String(ctx.purpose);
  else if (templateKey === 'interview_invite' && ctx.bookingId) key = `interview_invite:${ctx.bookingId}`;
  else if (templateKey === 'interview_reschedule' && ctx.bookingId) key = `interview_reschedule:${ctx.bookingId}:${ctx.version ?? 0}`;
  else if (!templateKey || templateKey === 'custom') key = `announce:${ctx.requestId || ''}`;
  else key = String(templateKey);
  if (ctx.again && ctx.batch) key += `:again-${ctx.batch}`;
  return key.slice(0, 200);
}

const stageName = (cycle, key) => (cycle?.doc?.pipeline?.stages || []).find((s) => s.key === key)?.name || key || '';
const subteamName = (cycle, key) => (cycle?.doc?.subteams || []).find((s) => s.key === key || s.name === key)?.name || key || '';

// Flat merge map (dotted keys) for one applicant in one cycle. `extra` carries
// send-time context such as the interview slot or the RSVP link.
export function mergeFor({ application, cycle, sender, extra = {} }) {
  const a = application || {};
  const name = String(a.name || '').trim();
  const decision = a.decision || {};
  const merge = {
    name,
    firstName: name.split(/\s+/)[0] || '',
    email: a.email || '',
    cycle: cycle?.name || '',
    term: cycle?.term || '',
    subteam: subteamName(cycle, a.subteam),
    year: a.year || '',
    stage: stageName(cycle, a.stage),
    club: CLUB,
    contactEmail: cycle?.doc?.comms?.replyTo || CONTACT_EMAIL,
    'sender.name': sender?.name || sender?.email || '',
    'decision.reason': decision.reason || '',
    'interview.round': '',
    'interview.date': '',
    'interview.time': '',
    'interview.place': '',
    rsvpUrl: '',
  };
  if (extra.interview) {
    merge['interview.round'] = extra.interview.round || '';
    merge['interview.date'] = extra.interview.date || '';
    merge['interview.time'] = extra.interview.time || '';
    merge['interview.place'] = extra.interview.place ? ` in ${extra.interview.place}` : '';
  }
  if (extra.rsvpUrl) merge.rsvpUrl = extra.rsvpUrl;
  if (extra['decision.reason']) merge['decision.reason'] = extra['decision.reason'];
  return merge;
}

export const SAMPLE_MERGE = {
  name: 'Sample Applicant', firstName: 'Sample', email: 'sample@cornell.edu', cycle: 'Fall 2026', term: 'Fall 2026',
  subteam: 'Software', year: 'Sophomore', stage: 'Applied', club: CLUB, contactEmail: CONTACT_EMAIL,
  'sender.name': 'The team', 'decision.reason': 'Strong project work', 'interview.round': 'Interview',
  'interview.date': 'Monday, October 5', 'interview.time': '4:00 PM', 'interview.place': ' in Upson 116',
  rsvpUrl: 'https://wiki.cornellphysicalintelligence.com/api/recruit/rsvp/0123456789abcdef0123456789abcdef',
};
