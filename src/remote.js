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
    Store.s = { users: [], pages: [], comments: [], activity: [], trash: [], prefs: {} };
    return;
  }
  adoptServer(await api('/state'));
};

Store.session = () => REMOTE.email;
Store.logout = () => { location.href = '/api/auth/logout'; };
Store.reset = () => toast('Reset is a preview-only tool — the live wiki keeps everything.');

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

async function sendOp(op, args, after) {
  REMOTE.pending++;
  try {
    const out = await api('/mutate', { method: 'POST', body: JSON.stringify({ op, args }) });
    adoptServer(out);
    after?.(out);
    render();
  } catch (e) {
    toast(e.status === 400 ? e.message : 'Sync failed — check your connection and retry.');
    try { adoptServer(await api('/state')); render(); } catch (e2) { /* offline */ }
  } finally { REMOTE.pending--; }
}

// name → how to serialize the client call into op args.
const OP_MAP = {
  createPage: (a) => ({ op: 'createPage', args: a[0] }),
  savePage: (a) => ({ op: 'savePage', args: { id: a[0], ...a[1] } }),
  toggleTask: (a) => ({ op: 'toggleTask', args: { id: a[0], n: a[1] } }),
  restoreRev: (a) => ({ op: 'restoreRev', args: { id: a[0], revIdx: a[1] } }),
  deletePage: (a) => ({ op: 'deletePage', args: { id: a[0] } }),
  restorePage: (a) => ({ op: 'restorePage', args: { id: a[0] } }),
  purgePage: (a) => ({ op: 'purgePage', args: { id: a[0] } }),
  movePage: (a) => ({ op: 'movePage', args: { id: a[0], ...a[1] } }),
  // duplicatePage is NOT mapped: the client helper calls createPage internally,
  // and that wrapped call already sends the op — mapping both would duplicate twice.
  deleteComment: (a) => ({ op: 'deleteComment', args: { id: a[0] } }),
  resendInvite: (a) => ({ op: 'resendInvite', args: { email: a[0] } }),
  revokeInvite: (a) => ({ op: 'revokeInvite', args: { email: a[0] } }),
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

// Comments carry the client id so optimistic and canonical rows match.
{
  const orig = Store.addComment.bind(Store);
  Store.addComment = (pageId, text) => {
    const c = orig(pageId, text);
    sendOp('addComment', { pageId, text, cid: c.id });
    return c;
  };
}

// Invites need the server's codes and email-send results.
{
  const orig = Store.addMembers.bind(Store);
  Store.addMembers = (emails, role) => {
    const local = orig(emails, role);
    sendOp('addMembers', { emails, role }, (out) => {
      for (const e of out.emailed || []) {
        if (!e.sent) toast(`${e.email}: invite created — share the code from Pending (email: ${e.reason})`);
      }
    });
    return local;
  };
}

/* ------------------------------- attachments ------------------------------ */

Store.addAttachment = async function addAttachmentRemote(file) {
  if (file.size > 4 * 1048576) throw new Error('File is over the 4 MB upload cap.');
  const data = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
  const meta = await api('/att', { method: 'POST', body: JSON.stringify({ name: file.name, type: file.type, data }) });
  const att = { ...meta, url: meta.url };
  Files.put ? Files.mem.set(att.id, att) : Files.mem.set(att.id, att);
  return att;
};

/* ------------------------------- login view ------------------------------- */

viewLogin = function viewLoginRemote() {
  const params = new URLSearchParams(location.search);
  const denied = params.get('denied');
  const reason = params.get('reason');
  return `<div class="login">
    <h1 class="login__wordmark">CUPI</h1>
    <p class="login__sub">Cornell University Physical Intelligence — Internal Wiki</p>
    <div class="login__card">
      ${UI.loginError ? `<div class="login__error">${UI.loginError}</div>` : ''}
      ${denied !== null ? `<div class="login__error">${reason ? MD.esc(reason) + ' ' : ''}<b>${MD.esc(denied || 'That account')}</b> isn't on the member list yet. Ask any admin to add you — you'll get an invite email.</div>` : ''}
      <a class="login__google" href="/api/auth/login">${I.google} Continue with Google</a>
      <p class="login__hint">Use your <b>@cornell.edu</b> account. Access is limited to the CUPI roster.</p>
      <div class="login__rule">or</div>
      <form class="login__invite" data-action="redeem-form">
        <input class="text-input" name="code" placeholder="Invite code — CUPI-XXXX-XXXX" autocomplete="off" spellcheck="false" aria-label="Invite code">
        <button class="btn" type="submit">Join</button>
      </form>
      <p class="login__hint">New members: the code is in your invite email.</p>
    </div>
    <p class="login__foot">CUPI is a registered student organization of Cornell University.</p>
  </div>`;
};

// Redeem posts to the server, then reloads into the signed-in session.
document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('[data-action="redeem-form"]');
  if (!form || !location.pathname) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  const code = form.code.value.trim();
  if (!code) return;
  api('/redeem', { method: 'POST', body: JSON.stringify({ code }) })
    .then(() => { location.href = '/'; })
    .catch((e) => { UI.loginError = MD.esc(e.message); render(); });
}, true);

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
