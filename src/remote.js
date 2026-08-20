/* ============================================================================
   Remote adapter — loaded after the UI, before boot. Rebinds the Store to the
   server: state comes from /api/state, every mutation is re-applied server-side
   via /api/mutate (the local apply is only optimism), attachments upload to
   /api/att, and sign-in is real Google OAuth. The rest of the app is untouched.
   ========================================================================== */

'use strict';

const REMOTE = { email: null, name: null, role: null, version: 0, pending: 0 };

async function api(path, opts) {
  const r = await fetch('/api' + path, { headers: { 'content-type': 'application/json' }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status });
  return data;
}

function adoptServer(payload) {
  if (payload.version !== undefined) REMOTE.version = payload.version;
  if (payload.state) {
    Store.s = payload.state;
    if (!Store.s.prefs) Store.s.prefs = {};
    Store.reindex();
  }
  if (payload.files) {
    for (const f of payload.files) Files.mem.set(f.id, { ...f, url: '/api/att/' + f.id });
  }
}

/* ------------------------------- boot ------------------------------------- */

Store.boot = async function bootRemote() {
  try {
    const who = await api('/me');
    REMOTE.email = who.email; REMOTE.name = who.name; REMOTE.role = who.role;
  } catch (e) {
    REMOTE.email = null;
    Store.s = { users: [], pages: [], activity: [], trash: [], prefs: {} };
    return;
  }
  adoptServer(await api('/state'));
};

Store.session = () => REMOTE.email;
Store.logout = () => { location.href = '/api/auth/logout'; };
Store.reset = () => toast('Reset is a preview-only tool. The live wiki keeps everything.');

/* ------------------------------- mutations -------------------------------- */

// Prefs changes ride a debounced setPrefs; real ops go through sendOp.
let prefsTimer = null;
Store.persist = function persistRemote() {
  if (!REMOTE.email) return;
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    api('/mutate', { method: 'POST', body: JSON.stringify({ op: 'setPrefs', args: { prefs: Store.prefs() } }) })
      .catch(() => {});
  }, 1200);
};

async function sendOp(op, args, after, onError) {
  REMOTE.pending++;
  try {
    const out = await api('/mutate', { method: 'POST', body: JSON.stringify({ op, args }) });
    adoptServer(out);
    after?.(out);
    render();
  } catch (e) {
    toast(e.status === 400 || e.status === 503 ? e.message : 'Sync failed. Check your connection and retry.');
    onError?.(e);
    try { adoptServer(await api('/state')); render(); } catch (e2) { /* offline */ }
  } finally { REMOTE.pending--; }
}

// name → how to serialize the client call into op args.
const OP_MAP = {
  createPage: (a) => ({ op: 'createPage', args: a[0] }),
  toggleTask: (a) => ({ op: 'toggleTask', args: { id: a[0], n: a[1] } }),
  restoreRev: (a) => ({ op: 'restoreRev', args: { id: a[0], revTs: a[1] } }),
  deletePage: (a) => ({ op: 'deletePage', args: { id: a[0] } }),
  restorePage: (a) => ({ op: 'restorePage', args: { id: a[0] } }),
  purgePage: (a) => ({ op: 'purgePage', args: { id: a[0] } }),
  movePage: (a) => ({ op: 'movePage', args: { id: a[0], ...a[1] } }),
  // duplicatePage is NOT mapped: the client helper calls createPage internally,
  // and that wrapped call already sends the op — mapping both would duplicate twice.
  toggleReaction: (a) => ({ op: 'toggleReaction', args: { id: a[0], emoji: a[1] } }),
  setRole: (a) => ({ op: 'setRole', args: { email: a[0], role: a[1] } }),
  removeUser: (a) => ({ op: 'removeUser', args: { email: a[0] } }),
};

for (const [name, toOp] of Object.entries(OP_MAP)) {
  const orig = Store[name].bind(Store);
  Store[name] = (...args) => {
    const r = orig(...args);          // optimistic local apply
    const { op, args: a } = toOp(args);
    sendOp(op, a);
    return r;
  };
}

// Saves carry their base revision; a server-side edit conflict re-stashes the
// attempted text as a draft so nothing the author wrote is lost.
{
  const orig = Store.savePage.bind(Store);
  Store.savePage = (id, args) => {
    const r = orig(id, args);
    sendOp('savePage', { id, ...args }, null, () => {
      draftStash.set(id, { title: args.title, body: args.body, section: args.section, origBody: Store.page(id)?.body ?? '' });
      persistDrafts();
      toast('Your version is saved as a draft', { label: 'Open draft', run: () => startEdit(id, false) });
    });
    return r;
  };
}


// Invites need the server's codes and email-send results.
{
  const orig = Store.addMembers.bind(Store);
  Store.addMembers = (emails, role) => {
    const local = orig(emails, role);
    sendOp('addMembers', { emails, role }, (out) => {
      for (const e of out.emailed || []) {
        if (!e.sent) toast(`${e.email} is added and can sign in now. Welcome email not sent: ${e.reason}.`);
      }
    });
    return local;
  };
}

/* ------------------------------- attachments ------------------------------ */

// Uploads are chunked under Vercel's ~4.5 MB request ceiling, so a 25 MB STEP
// export goes through in ~2.8 MB parts and is assembled server-side.
Store.addAttachment = async function addAttachmentRemote(file) {
  if (file.size > 25 * 1048576) throw new Error('File is over the 25 MB upload cap.');
  const data = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
  const CHUNK = 2800000; // base64 chars per part (~2.1 MB binary)
  if (data.length <= CHUNK) {
    const meta = await api('/att', { method: 'POST', body: JSON.stringify({ name: file.name, type: file.type, data }) });
    const att = { ...meta, url: meta.url };
    Files.mem.set(att.id, att);
    return att;
  }
  const { uploadId } = await api('/att/begin', { method: 'POST', body: JSON.stringify({}) });
  for (let seq = 0; seq * CHUNK < data.length; seq++) {
    await api('/att/part', { method: 'POST', body: JSON.stringify({ uploadId, seq, data: data.slice(seq * CHUNK, (seq + 1) * CHUNK) }) });
    toast(`Uploading ${file.name}… ${Math.min(100, Math.round(((seq + 1) * CHUNK / data.length) * 100))}%`);
  }
  const meta = await api('/att/finish', { method: 'POST', body: JSON.stringify({ uploadId, name: file.name, type: file.type }) });
  const att = { ...meta, url: meta.url };
  Files.mem.set(att.id, att);
  return att;
};

/* ------------------------------- login view ------------------------------- */

viewLogin = function viewLoginRemote() {
  const params = new URLSearchParams(location.search);
  const denied = params.get('denied');
  const reason = params.get('reason');
  return `<div class="login">
    <h1 class="login__wordmark">CUPI</h1>
    <p class="login__sub">Cornell Physical Intelligence &middot; Internal Wiki</p>
    <p class="login__mission">We build robots that reason about the physical world. This wiki is the team's collective memory: CAD conventions, board bring-up rituals, flight test procedure, and everything we learn the hard way.</p>
    <img class="login__crab" src="${CRAB_URI}" alt="The CUPI crab, resting on a beach" draggable="false">
    <div class="login__card">
      ${UI.loginError ? `<div class="login__error">${UI.loginError}</div>` : ''}
      ${denied !== null ? `<div class="login__error">${reason ? MD.esc(reason) + ' ' : ''}<b>${MD.esc(denied || 'That account')}</b> isn't on the member list yet. Ask any admin to add you. Once you're added, this same button will work.</div>` : ''}
      <a class="login__google" href="/api/auth/login">${I.google} Continue with Google</a>
      <p class="login__hint">Use your <b>@cornell.edu</b> account. Access is limited to the CUPI roster. If you've been added, signing in is all it takes.</p>
    </div>
    <p class="login__pillars">Mechanical &middot; Electrical &middot; Software &middot; Business</p>
    <p class="login__foot">CUPI is a student robotics organization at Cornell University.<br>
    <a href="https://cornellphysicalintelligence.com/">cornellphysicalintelligence.com</a> &middot; <a href="https://www.linkedin.com/company/cu-physical-intelligence/">LinkedIn</a></p>
  </div>`;
};


/* ------------------------------- live sync -------------------------------- */

async function pollOnce() {
  if (!REMOTE.email || REMOTE.pending || UI.editor?.dirty) return;
  try {
    const out = await api('/state?since=' + REMOTE.version);
    if (!out.unchanged) { adoptServer(out); render(); }
  } catch (e) { /* transient */ }
}
setInterval(pollOnce, 25000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollOnce(); });
