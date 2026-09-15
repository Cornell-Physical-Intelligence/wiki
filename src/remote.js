/* ============================================================================
   Remote adapter — loaded after the UI, before boot. Rebinds the Store to the
   server: state comes from /api/state, every mutation is re-applied server-side
   via /api/mutate (the local apply is only optimism), attachments upload to
   /api/att, and sign-in is real Google OAuth. The rest of the app is untouched.
   ========================================================================== */

'use strict';

const REMOTE = { email: null, name: null, role: null, version: 0, pending: 0 };
let savedPrefs = null;
let prefsInFlight = false;
let prefsVersion = 0;
let independentPrefsVersion = false;
let prefsQueued = false;
let prefsFailures = 0;
let prefsRetryAfter = 0;
let prefsEditVersion = 0;
let observedPrefs = null;
const prefsFingerprint = (prefs) => JSON.stringify(Object.fromEntries(Object.keys(prefs).sort().map((key) => [key, prefs[key]])));
function noteLocalPrefs(fingerprint) {
  if (observedPrefs !== null && observedPrefs !== fingerprint) prefsEditVersion++;
  observedPrefs = fingerprint;
}

function responsePrefsVersion(payload) {
  if (Number.isFinite(payload.prefsVersion)) {
    if (!independentPrefsVersion) {
      // A rollout can switch this open tab from a shared revision to a small
      // per-user revision. Those counters cannot be compared to one another.
      independentPrefsVersion = true;
      prefsVersion = -1;
    }
    return payload.prefsVersion;
  }
  // Older servers remain usable on initial load. Once separate revisions are
  // known, a delayed legacy response cannot rewind the newer preferences.
  return independentPrefsVersion ? null : (payload.version ?? REMOTE.version);
}

async function api(path, opts) {
  const r = await fetch('/api' + path, { headers: { 'content-type': 'application/json' }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status });
  return data;
}

function adoptServer(payload) {
  const localPrefs = REMOTE.email && savedPrefs !== null ? prefsFingerprint(Store.prefs()) : null;
  const hasPrefs = REMOTE.email && (payload.prefs !== undefined || payload.state);
  const incomingPrefsVersion = hasPrefs ? responsePrefsVersion(payload) : null;
  const acceptPrefs = hasPrefs && incomingPrefsVersion !== null && incomingPrefsVersion >= prefsVersion;
  const keepPrefs = localPrefs !== null && (!acceptPrefs || prefsInFlight || localPrefs !== savedPrefs);
  // Content and preferences can arrive out of order independently. An older
  // content response may still carry a newer preference revision, and vice versa.
  const acceptContent = payload.version === undefined || payload.version >= REMOTE.version;
  let changed = false;
  if (payload.state && acceptContent) {
    Store.s = payload.state;
    if (!Store.s.prefs) Store.s.prefs = {};
    Store.reindex();
    if (payload.version !== undefined) REMOTE.version = payload.version;
    changed = true;
  }
  if (REMOTE.email && (hasPrefs || payload.state)) {
    if (!Store.s.prefs) Store.s.prefs = {};
    if (acceptPrefs) {
      Store.s.prefs[REMOTE.email] = payload.prefs ?? payload.state?.prefs?.[REMOTE.email] ?? {};
      savedPrefs = prefsFingerprint(Store.prefs());
      prefsVersion = incomingPrefsVersion;
    }
    if (keepPrefs) Store.s.prefs[REMOTE.email] = JSON.parse(localPrefs);
    observedPrefs = prefsFingerprint(Store.prefs());
    changed ||= observedPrefs !== localPrefs;
    if (!prefsInFlight && !prefsTimer && observedPrefs !== savedPrefs) Store.persist();
  }
  if (payload.files && acceptContent) {
    for (const f of payload.files) Files.mem.set(f.id, { ...f, url: '/api/att/' + f.id });
  }
  return changed;
}

/* ------------------------------- boot ------------------------------------- */

Store.boot = async function bootRemote() {
  try {
    const who = await api('/me');
    REMOTE.email = who.email; REMOTE.name = who.name; REMOTE.role = who.role;
  } catch (e) {
    REMOTE.email = null;
    Store.s = { users: [], pages: [], activity: [], trash: [], prefs: {} };
    if (e.status !== 401) UI.loginError = 'The wiki is temporarily unavailable. Please try again shortly.';
    return;
  }
  try {
    adoptServer(await api('/state'));
  } catch (e) {
    REMOTE.email = null;
    Store.s = { users: [], pages: [], activity: [], trash: [], prefs: {} };
    UI.loginError = 'The wiki is temporarily unavailable. Please try again shortly.';
  }
};

Store.session = () => REMOTE.email;
Store.logout = () => { location.href = '/api/auth/logout'; };
Store.reset = () => toast('Reset is a preview-only tool. The live wiki keeps everything.');

/* ------------------------------- mutations -------------------------------- */

// Prefs changes ride a debounced setPrefs; real ops go through sendOp.
let prefsTimer = null;
async function flushPrefs() {
  prefsTimer = null;
  if (!REMOTE.email) return;
  if (prefsInFlight) { prefsQueued = true; return; }
  const fingerprint = prefsFingerprint(Store.prefs());
  noteLocalPrefs(fingerprint);
  const editVersion = prefsEditVersion;
  if (fingerprint === savedPrefs) { prefsQueued = false; return; }
  prefsInFlight = true;
  prefsQueued = false;
  REMOTE.pending++;
  let succeeded = false;
  try {
    const out = await api('/mutate', { method: 'POST', body: JSON.stringify({ op: 'setPrefs', args: { prefs: JSON.parse(fingerprint) } }) });
    if ((out.ok !== true && !out.state) || !Number.isFinite(out.version)) throw new Error('Preferences were not confirmed');
    const acknowledgedVersion = responsePrefsVersion(out);
    if (acknowledgedVersion === null) throw new Error('Preferences revision was not confirmed');
    if (acknowledgedVersion >= prefsVersion) {
      savedPrefs = fingerprint;
      prefsVersion = acknowledgedVersion;
      if (out.prefs && typeof out.prefs === 'object' && !Array.isArray(out.prefs)) {
        const current = prefsFingerprint(Store.prefs());
        // Read the server's sanitized values through the normal Store defaults
        // before remembering what was actually saved (e.g. the 100-star cap).
        Store.s.prefs[REMOTE.email] = out.prefs;
        savedPrefs = prefsFingerprint(Store.prefs());
        if (prefsEditVersion !== editVersion || current !== fingerprint) {
          Store.s.prefs[REMOTE.email] = JSON.parse(current);
        }
        observedPrefs = prefsFingerprint(Store.prefs());
        if (observedPrefs !== current) render();
      }
    } else if (prefsEditVersion === editVersion && prefsFingerprint(Store.prefs()) === fingerprint) {
      // A newer complete snapshot already includes a subsequent preferences
      // write. Preserve any edits made after this request, otherwise use it.
      Store.s.prefs[REMOTE.email] = JSON.parse(savedPrefs);
      observedPrefs = savedPrefs;
      render();
    }
    succeeded = true;
    prefsFailures = 0;
    prefsRetryAfter = 0;
    // Do not adopt the compact response's version: a concurrent content change
    // may be included in it, and the next poll must still fetch that content.
  } catch (e) {
    // Keep local values, and space retries requested by later edits or syncs.
    prefsFailures++;
    prefsRetryAfter = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(prefsFailures - 1, 6));
  }
  finally {
    prefsInFlight = false;
    REMOTE.pending--;
    const current = prefsFingerprint(Store.prefs());
    if (current !== savedPrefs && (succeeded || prefsQueued || current !== fingerprint)) Store.persist();
  }
}
Store.persist = function persistRemote() {
  if (!REMOTE.email) return;
  const fingerprint = prefsFingerprint(Store.prefs());
  noteLocalPrefs(fingerprint);
  clearTimeout(prefsTimer);
  prefsTimer = null;
  if (!prefsInFlight && fingerprint === savedPrefs) { prefsQueued = false; return; }
  prefsQueued = true;
  prefsTimer = setTimeout(flushPrefs, Math.max(1200, prefsRetryAfter - Date.now()));
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
  setProfile: (a) => ({ op: 'setProfile', args: { name: a[0], subteam: a[1] } }),
  setEmailSettings: (a) => ({ op: 'setEmailSettings', args: a[0] }),
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
    <h1 class="login__title"><span class="visually-hidden">Cornell Physical Intelligence (CUPI)</span><span class="vt-title" aria-hidden="true"><canvas class="vt-title__canvas"></canvas></span></h1>
    <p class="login__caption">(Cornell University Physical Intelligence)</p>
    <div class="login__card">
      ${UI.loginError ? `<div class="login__error">${UI.loginError}</div>` : ''}
      ${denied !== null ? `<div class="login__error">${reason ? MD.esc(reason) + ' ' : ''}<b>${MD.esc(denied || 'That account')}</b> isn't on the member list yet. Ask any admin to add you. Once you're added, this same button will work.</div>` : ''}
      <p class="login__welcome">Welcome to the CUPI knowledge base. Sign in with Google to access.</p>
      <a class="login__google" href="/api/auth/login">${I.google} Continue with Google</a>
    </div>
    ${loginFooter('')}
  </div>`;
};


/* ------------------------------- live sync -------------------------------- */

let pollInFlight = false;
let pollFailures = 0;
let pollAfter = 0;
const IDLE_POLL_PAUSE_MS = 5 * 60 * 1000;
let lastActivity = Date.now();

function noteActivity() {
  const wasIdle = Date.now() - lastActivity >= IDLE_POLL_PAUSE_MS;
  lastActivity = Date.now();
  if (wasIdle) pollOnce();
}

async function pollOnce() {
  if (document.hidden || Date.now() - lastActivity >= IDLE_POLL_PAUSE_MS || pollInFlight || Date.now() < pollAfter || !REMOTE.email || REMOTE.pending || UI.editor?.dirty) return;
  pollInFlight = true;
  const version = REMOTE.version;
  try {
    const out = await api('/state?since=' + version + '&prefsSince=' + (independentPrefsVersion ? prefsVersion : -1));
    pollFailures = 0;
    pollAfter = 0;
    // A save or edit may have begun while the request was in flight.
    if (!REMOTE.pending && !UI.editor?.dirty) {
      let changed = false;
      if (REMOTE.version === version) changed = adoptServer(out);
      else if (Number.isFinite(out.prefsVersion)) {
        // An operation supplied newer content while this poll was in flight;
        // its separately versioned preferences may still be useful.
        const prefs = out.prefs ?? out.state?.prefs?.[REMOTE.email];
        if (prefs !== undefined) changed = adoptServer({ prefsVersion: out.prefsVersion, prefs });
      }
      if (changed) render();
    }
  } catch (e) {
    pollFailures++;
    pollAfter = Date.now() + Math.min(300000, 25000 * 2 ** Math.min(pollFailures, 4));
  } finally {
    pollInFlight = false;
  }
}
setInterval(pollOnce, 25000);
for (const event of ['pointerdown', 'keydown', 'scroll']) document.addEventListener(event, noteActivity, { passive: true, capture: true });
window.addEventListener('focus', () => { lastActivity = Date.now(); pollOnce(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { lastActivity = Date.now(); pollOnce(); }
});
