// Server-side mutation semantics — the single source of truth for what a
// member vs an admin may change. Every client mutation arrives as {op, args}
// and is re-applied here against the canonical state; the client's optimistic
// copy is never trusted.

const ADMIN_OPS = new Set(['addMembers', 'setRole', 'removeUser', 'purgePage', 'setEmailSettings']);

const uid = (p) => p + '-' + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);

// The reaction vocabulary is closed — a stored key is markup-adjacent data.
const REACTION_EMOJI = new Set(['👍', '🎉', '❤️', '🚀', '👀', '✅', '🦀', '😂']);


const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'p';

function log(state, entry) {
  state.activity.unshift({ ts: Date.now(), ...entry });
  state.activity.splice(400);
}

const page = (state, id) => state.pages.find((p) => p.id === id) || null;
const user = (state, email) => state.users.find((u) => u.email === email) || null;

// Each op mutates state in place and returns undefined, or returns an error string.
const OPS = {
  createPage(state, { title, section, parent, body, tags, summary }, actor) {
    title = String(title || '').trim().slice(0, 90);
    if (!title) return 'Title required';
    if (String(body || '').length > 2 * 1024 * 1024) return 'Page text is over the 2 MB limit';
    if (state.pages.some((p) => p.title.toLowerCase() === title.toLowerCase())) return 'A page with that title exists';
    let id = slugify(title);
    if (page(state, id) || state.trash.some((t) => t.id === id)) id += '-' + uid('').slice(1, 5);
    const now = Date.now();
    state.pages.push({
      id, title, section: String(section || 'projects'), parent: null,
      tags: Array.isArray(tags) ? tags.slice(0, 8).map(String) : [],
      owner: actor, created: now, updated: now, updatedBy: actor,
      order: state.pages.length + 1, body: String(body || ''),
      revs: [{ ts: now, by: actor, summary: String(summary || 'Created page').slice(0, 120), body: String(body || '') }],
    });
    log(state, { kind: 'create', by: actor, pageId: id });
  },

  savePage(state, { id, title, body, summary, section, tags, baseUpdated }, actor) {
    const p = page(state, id);
    if (!p) return 'No such page';
    // Edit conflict: the page moved on since this editor was opened — even by
    // the same person in another window. Refuse rather than silently clobber.
    if (baseUpdated && p.updated > baseUpdated && body !== undefined && body !== p.body) {
      return `Edit conflict: ${p.updatedBy} saved a newer version while you were editing. Your text is kept as a draft; review their changes, then merge yours in.`;
    }
    if (body !== undefined && String(body).length > 2 * 1024 * 1024) return 'Page text is over the 2 MB limit';
    const now = Date.now();
    const newTitle = title !== undefined ? String(title).trim().slice(0, 90) : p.title;
    if (!newTitle) return 'Title required';
    const clash = state.pages.find((q) => q.id !== id && q.title.toLowerCase() === newTitle.toLowerCase());
    if (clash) return 'A page with that title exists';
    const changed = (body !== undefined && body !== p.body) || newTitle !== p.title;
    // Renames rewrite every inbound [[link]] so links survive.
    if (newTitle !== p.title) {
      const escRe = p.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\[\\[\\s*${escRe}\\s*(?=[\\]#|])`, 'gi');
      for (const list of [state.pages, state.trash]) {
        for (const q of list) { if (re.test(q.body)) q.body = q.body.replace(re, '[[' + newTitle); re.lastIndex = 0; }
      }
    }
    p.title = newTitle;
    if (section !== undefined) p.section = String(section);
    if (tags !== undefined) p.tags = Array.isArray(tags) ? tags.slice(0, 8).map(String) : p.tags;
    if (body !== undefined) p.body = String(body);
    if (changed) {
      p.updated = now; p.updatedBy = actor;
      p.revs.push({ ts: now, by: actor, summary: String(summary || 'Edited').slice(0, 120), body: p.body });
      if (p.revs.length > 80) p.revs.splice(0, p.revs.length - 80);
      log(state, { kind: 'edit', by: actor, pageId: id, summary: String(summary || '').slice(0, 120) });
    }
  },

  toggleTask(state, { id, n }, actor) {
    const p = page(state, id);
    if (!p) return 'No such page';
    // Mirrors the client's walkTasks exactly: fence-aware (quote-stripped),
    // blockquote-aware, and only "[x] "-with-trailing-space counts as a task.
    // Divergence here flips the WRONG checkbox — silent content corruption.
    const lines = p.body.replace(/\r\n?/g, '\n').split('\n');
    let fence = null, idx = 0;
    for (let i = 0; i < lines.length; i++) {
      const bare = lines[i].replace(/^(\s*>\s?)+/, '');
      if (fence) { if (bare.startsWith(fence)) fence = null; continue; }
      const f = bare.match(/^(\`\`\`|~~~)\s*(\w*)\s*$/);
      if (f) { fence = f[1]; continue; }
      if (!/^(\s*(?:[-*+]|\d+[.)])\s+\[)( |x|X)(\])(?=\s)/.test(bare)) continue;
      if (idx === n) {
        lines[i] = lines[i].replace(/^((?:\s*>\s?)*\s*(?:[-*+]|\d+[.)])\s+\[)( |x|X)(\])(?=\s)/,
          (_, pre, st, post) => pre + (st.trim() ? ' ' : 'x') + post);
        break;
      }
      idx++;
    }
    p.body = lines.join('\n');
    p.updated = Date.now(); p.updatedBy = actor;
    const last = p.revs[p.revs.length - 1];
    if (last && last.summary === 'Checked items' && last.by === actor && Date.now() - last.ts < 600000) {
      last.body = p.body; last.ts = Date.now();
    } else {
      p.revs.push({ ts: Date.now(), by: actor, summary: 'Checked items', body: p.body });
    }
  },

  restoreRev(state, { id, revTs }, actor) {
    const p = page(state, id);
    const rev = p?.revs.find((r) => r.ts === revTs);
    if (!rev) return 'No such revision';
    p.body = rev.body; p.updated = Date.now(); p.updatedBy = actor;
    p.revs.push({ ts: Date.now(), by: actor, summary: 'Restored an earlier version', body: rev.body });
    log(state, { kind: 'restore', by: actor, pageId: id });
  },

  deletePage(state, { id }, actor) {
    const i = state.pages.findIndex((p) => p.id === id);
    if (i < 0) return 'No such page';
    const [p] = state.pages.splice(i, 1);
    state.pages.forEach((q) => { if (q.parent === id) q.parent = null; });
    p.deletedAt = Date.now(); p.deletedBy = actor;
    state.trash.push(p);
    log(state, { kind: 'delete', by: actor, title: p.title });
  },

  restorePage(state, { id }, actor) {
    const i = state.trash.findIndex((p) => p.id === id);
    if (i < 0) return 'Not in trash';
    const [p] = state.trash.splice(i, 1);
    delete p.deletedAt; delete p.deletedBy;
    // Never fork the live wiki: freshen identity if it was reused meanwhile.
    if (page(state, p.id)) p.id = p.id + '-' + uid('').slice(1, 5);
    while (state.pages.some((q) => q.title.toLowerCase() === p.title.toLowerCase())) p.title += ' (restored)';
    state.pages.push(p);
    log(state, { kind: 'restore', by: actor, pageId: p.id });
  },

  purgePage(state, { id }, actor) {
    const i = state.trash.findIndex((p) => p.id === id);
    if (i < 0) return 'Not in trash';
    const [p] = state.trash.splice(i, 1);
    log(state, { kind: 'purge', by: actor, title: p.title });
  },

  movePage(state, { id, section }, actor) {
    const p = page(state, id);
    if (!p) return 'No such page';
    p.section = String(section || p.section);
    p.parent = null;
    log(state, { kind: 'move', by: actor, pageId: id });
  },

  duplicatePage(state, { id }, actor) {
    const p = page(state, id);
    if (!p) return 'No such page';
    let title = p.title + ' (copy)', n = 2;
    while (state.pages.some((q) => q.title.toLowerCase() === title.toLowerCase())) title = `${p.title} (copy ${n++})`;
    return OPS.createPage(state, { title, section: p.section, parent: p.parent, body: p.body, tags: p.tags }, actor);
  },

  toggleReaction(state, { id, emoji }, actor) {
    const p = page(state, id);
    if (!p) return 'No such page';
    if (!REACTION_EMOJI.has(emoji)) return 'Not a supported reaction';
    if (!p.reactions) p.reactions = {};
    const list = p.reactions[emoji] || (p.reactions[emoji] = []);
    const i = list.indexOf(actor);
    if (i >= 0) { list.splice(i, 1); if (!list.length) delete p.reactions[emoji]; }
    else list.push(actor);
  },

  // Roster (admin-only, enforced in applyOp). Returns per-email results via state._result.
  // Per-deployment email identity, managed in-app so every org that runs the
  // wiki brings its own Resend account. The key lives only in server state:
  // shapeState strips it before anything reaches a client.
  setEmailSettings(state, { key, from, name }, actor) {
    const addr = String(from || '').trim().toLowerCase();
    if (addr && !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(addr)) return 'The From address must be a plain email address';
    const nm = String(name || '').trim().slice(0, 60);
    const k = String(key || '').trim();
    if (k && !/^re_[A-Za-z0-9_-]{8,}$/.test(k)) return 'That does not look like a Resend API key (they start with re_)';
    const cur = (state.settings && state.settings.email) || {};
    if (!k && !addr && !cur.key) return 'Nothing to save yet: paste an API key or a From address';
    if (!state.settings) state.settings = {};
    state.settings.email = {
      key: k || cur.key || '',
      from: addr,
      name: nm || 'CUPI Wiki',
      updatedBy: actor,
      updatedAt: Date.now(),
    };
  },

  setProfile(state, { name, subteam }, actor) {
    const u = user(state, actor);
    if (!u) return 'No such member';
    const n = String(name || '').trim();
    if (!n || n.length > 60) return 'Name must be between 1 and 60 characters';
    const st = String(subteam || '').trim().slice(0, 40);
    const before = u.name;
    u.name = n;
    u.subteam = st;
    if (before !== n) log(state, { kind: 'rename', by: actor, who: n });
  },

  addMembers(state, { emails, role }, actor) {
    const results = [];
    for (const raw of Array.isArray(emails) ? emails : []) {
      const email = String(raw).trim().toLowerCase();
      if (!email) continue;
      if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) { results.push({ email, ok: false, reason: 'Not a valid email address' }); continue; }
      if (user(state, email)) { results.push({ email, ok: false, reason: 'Already on the roster' }); continue; }
      const u = {
        email, name: email.split('@')[0], role: role === 'admin' ? 'admin' : 'member',
        status: 'invited', subteam: '', joined: null,
        invitedAt: Date.now(), invitedBy: actor,
      };
      state.users.push(u);
      log(state, { kind: 'invite', by: actor, who: email });
      results.push({ email, ok: true });
    }
    state._result = results;
  },


  setRole(state, { email, role }, actor) {
    const u = user(state, email);
    if (!u) return 'No such member';
    if (email === actor && role !== 'admin') return 'You cannot demote yourself';
    u.role = role === 'admin' ? 'admin' : 'member';
    log(state, { kind: 'role', by: actor, who: email, role: u.role });
  },

  removeUser(state, { email }, actor) {
    if (email === actor) return 'You cannot remove yourself';
    const i = state.users.findIndex((u) => u.email === email);
    if (i < 0) return 'No such member';
    state.users.splice(i, 1);
    log(state, { kind: 'remove', by: actor, who: email });
  },

  // Per-user prefs (stars, recents, watches, collapsed sections, editor mode).
  setPrefs(state, { prefs }, actor) {
    if (!state.prefs) state.prefs = {};
    const clean = {};
    const src = prefs && typeof prefs === 'object' ? prefs : {};
    for (const k of ['starred', 'recents', 'collapsed', 'watched']) {
      if (Array.isArray(src[k])) clean[k] = src[k].slice(0, 100).map(String);
    }
    if (typeof src.editorMode === 'string') clean.editorMode = src.editorMode;
    if (typeof src.inboxReadAt === 'number') clean.inboxReadAt = src.inboxReadAt;
    for (const k of Object.keys(src)) if (k.startsWith('open-')) clean[k] = !!src[k];
    state.prefs[actor] = { ...(state.prefs[actor] || {}), ...clean };
  },

  registerAttachment(state) { /* metadata lives in wiki_files; nothing to do */ },
};

export function applyOp(state, op, args, actor, role) {
  if (!OPS[op]) return { error: `Unknown op ${op}` };
  if (ADMIN_OPS.has(op) && role !== 'admin') return { error: 'Admins only' };
  delete state._result;
  const err = OPS[op](state, args || {}, actor);
  if (err) return { error: err };
  const result = state._result;
  delete state._result;
  return { result };
}
