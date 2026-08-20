/* ============================================================================
   Store — state, persistence, history, search, diff, auth, roster.
   Documents live in localStorage (text, small); attachments live in
   IndexedDB (binary, potentially many MB) behind an in-memory map so the
   renderer stays synchronous. Production swaps this file for an API client
   with the same surface.
   ========================================================================== */

'use strict';

const LS_KEY = 'cupi-wiki-v2';
const SESSION_KEY = 'cupi-wiki-session';
const IDB_NAME = 'cupi-wiki-files';

const uid = (p) => p + '-' + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);


/* ------------------------------- time ------------------------------------ */

function relTime(ts) {
  const d = Date.now() - ts;
  const m = Math.round(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  const days = Math.round(h / 24);
  if (days < 14) return days + 'd ago';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined });
}
const fmtDateTime = (ts) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtDay = (ts) => {
  const d = new Date(ts), t = new Date();
  const today = d.toDateString() === t.toDateString();
  const yd = new Date(t - 864e5).toDateString() === d.toDateString();
  return today ? 'Today' : yd ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
};

/* ------------------------------- diff ------------------------------------ */

// LCS line diff. Ops: 0 same, 1 add, -1 del.
function diffLines(a, b) {
  const A = String(a || '').split('\n'), B = String(b || '').split('\n');
  const n = A.length, m = B.length;
  if (n * m > 4000000) {
    // Degenerate fallback for huge docs: whole-body replace.
    return { ops: [...A.map((l) => [-1, l]), ...B.map((l) => [1, l])], add: m, del: n };
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0, add = 0, del = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push([0, A[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push([-1, A[i]]); i++; del++; }
    else { ops.push([1, B[j]]); j++; add++; }
  }
  while (i < n) { ops.push([-1, A[i++]]); del++; }
  while (j < m) { ops.push([1, B[j++]]); add++; }
  return { ops, add, del };
}

/* ------------------------------- IndexedDB files ------------------------- */

const Files = {
  db: null,
  mem: new Map(),
  open() {
    return new Promise((res) => {
      const rq = indexedDB.open(IDB_NAME, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('files', { keyPath: 'id' });
      rq.onsuccess = () => { Files.db = rq.result; res(); };
      rq.onerror = () => res(); // degrade to memory-only
    });
  },
  loadAll() {
    return new Promise((res) => {
      if (!Files.db) return res();
      const tx = Files.db.transaction('files').objectStore('files').getAll();
      tx.onsuccess = () => { (tx.result || []).forEach((f) => Files.mem.set(f.id, f)); res(); };
      tx.onerror = () => res();
    });
  },
  put(f, onFail) {
    Files.mem.set(f.id, f);
    if (!Files.db) { onFail && onFail(); return; }
    try {
      const rq = Files.db.transaction('files', 'readwrite').objectStore('files').put(f);
      rq.onerror = () => onFail && onFail();
    } catch (e) { onFail && onFail(); }
  },
  remove(id) {
    Files.mem.delete(id);
    if (Files.db) try { Files.db.transaction('files', 'readwrite').objectStore('files').delete(id); } catch (e) {}
  },
  get: (id) => Files.mem.get(id) || null,
  totalBytes: () => [...Files.mem.values()].reduce((s, f) => s + (f.size || 0), 0),
};

/* ------------------------------- store ----------------------------------- */

const Store = {
  s: null,
  onError: null,

  async boot() {
    await Files.open();
    await Files.loadAll();
    let raw = null;
    try { raw = localStorage.getItem(LS_KEY); } catch (e) {}
    if (raw) {
      try { Store.s = JSON.parse(raw); } catch (e) { Store.s = null; }
    }
    if (!Store.s || !Store.s.pages) Store.seed();
    if (Files.mem.size === 0) SEED_ATTACHMENTS.forEach((a) => Files.put(a));
    // Purge trash older than 30 days.
    const cut = Date.now() - 30 * 864e5;
    Store.s.trash = (Store.s.trash || []).filter((p) => p.deletedAt > cut);
    Store.reindex();
  },

  seed() {
    Store.s = {
      users: SEED_USERS.map((u) => ({ ...u })),
      pages: SEED_PAGES.map((p) => {
        const revs = (p.revs || []).map((r) => ({ ...r, body: r.body == null ? p.body : r.body }));
        if (!revs.length || revs[revs.length - 1].body !== p.body) {
          revs.push({ ts: p.updated, by: p.updatedBy, summary: revs.length ? 'Edited' : 'Created page', body: p.body });
        }
        return { ...p, revs };
      }),
      activity: SEED_ACTIVITY.map((a) => ({ ...a })),
      trash: [],
      prefs: {},
    };
    Store.persist();
  },

  reset() {
    const who = Store.session();
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
    [...Files.mem.keys()].forEach((id) => Files.remove(id));
    SEED_ATTACHMENTS.forEach((a) => Files.put(a));
    Store.seed();
    Store.reindex();
    // Restoring content is not signing out — keep the session when the
    // seeded roster still knows this person.
    if (who && !Store.s.users.some((u) => u.email === who)) {
      try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    }
  },

  lastPersistOk: true,
  _adopting: false, // true while rendering state adopted from another tab
  persist() {
    if (Store._adopting) return true; // never write back what another tab just wrote
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(Store.s));
      Store.lastPersistOk = true;
    } catch (e) {
      Store.lastPersistOk = false;
      Store.onError && Store.onError('This browser is out of storage, so the change was not saved. Shorten the page or remove large attachments.');
    }
    return Store.lastPersistOk;
  },

  /* --------------------------- indexes ----------------------------------- */

  titleIndex: new Map(),  // lower title -> page
  linkIndex: new Map(),   // pageId -> Set(lower titles it links to)

  reindex() {
    Store.titleIndex.clear();
    Store.linkIndex.clear();
    for (const p of Store.s.pages) Store.titleIndex.set(p.title.toLowerCase(), p);
    for (const p of Store.s.pages) Store.linkIndex.set(p.id, new Set(MD.extractWikiLinks(p.body)));
  },

  pageByTitle: (t) => Store.titleIndex.get(String(t).toLowerCase()) || null,
  page: (id) => Store.s.pages.find((p) => p.id === id) || null,

  backlinks(pageId) {
    const p = Store.page(pageId);
    if (!p) return [];
    const key = p.title.toLowerCase();
    return Store.s.pages.filter((q) => q.id !== pageId && Store.linkIndex.get(q.id)?.has(key));
  },

  childrenOf: (id) => Store.s.pages.filter((p) => p.parent === id).sort((a, b) => a.order - b.order),
  inSection: (sec) => Store.s.pages.filter((p) => p.section === sec).sort((a, b) => a.order - b.order),

  /* --------------------------- auth -------------------------------------- */

  session() {
    try { return localStorage.getItem(SESSION_KEY) || null; } catch (e) { return null; }
  },
  me() {
    const email = Store.session();
    return email ? Store.s.users.find((u) => u.email === email && u.status === 'active') || null : null;
  },
  isAdmin: () => Store.me()?.role === 'admin',

  login(email) {
    const u = Store.s.users.find((x) => x.email === email);
    if (!u) return { ok: false, reason: 'not-listed' };
    if (u.status === 'invited') {
      // Parity with production: OAuth proves the address, so being on the
      // roster is all it takes — the first sign-in activates the account.
      u.status = 'active';
      u.joined = Date.now();
      Store.log({ kind: 'join', by: u.email });
      Store.persist();
    }
    try { localStorage.setItem(SESSION_KEY, email); } catch (e) {}
    return { ok: true, user: u };
  },

  logout() { try { localStorage.removeItem(SESSION_KEY); } catch (e) {} },

  /* --------------------------- pages ------------------------------------- */

  createPage({ title, section, parent, body, tags, summary }) {
    const me = Store.me();
    const slug = MD.slugify(title);
    // IDs must be unique across live pages AND trash, or a later restore forks the wiki.
    const taken = (id) => Store.page(id) || Store.s.trash.some((t) => t.id === id);
    const id = taken(slug) ? slug + '-' + uid('').slice(1, 5) : slug;
    const now = Date.now();
    const p = {
      id, title, section, parent: parent || null, tags: tags || [],
      owner: me.email, created: now, updated: now, updatedBy: me.email,
      order: Store.s.pages.length + 1,
      body: body || '',
      revs: [{ ts: now, by: me.email, summary: summary || 'Created page', body: body || '' }],
    };
    Store.s.pages.push(p);
    Store.log({ kind: 'create', by: me.email, pageId: id });
    Store.reindex();
    Store.persist();
    return p;
  },

  // Renames rewrite every inbound [[link]] so links survive — page titles are
  // the link namespace, and breaking them on rename is how wikis rot.
  rewriteLinks(oldTitle, newTitle) {
    const escRe = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\[\\[\\s*${escRe}\\s*(?=[\\]#|])`, 'gi');
    for (const list of [Store.s.pages, Store.s.trash]) {
      for (const q of list) {
        if (re.test(q.body)) q.body = q.body.replace(re, '[[' + newTitle);
        re.lastIndex = 0;
      }
    }
  },

  savePage(id, { title, body, summary, section, tags }) {
    const p = Store.page(id);
    if (!p) return null;
    if (body !== undefined && body.length > 2 * 1024 * 1024) {
      Store.onError && Store.onError('That page is over the 2 MB text limit. Attach big content as files instead.');
      return null;
    }
    const me = Store.me();
    const now = Date.now();
    const changedBody = body !== undefined && body !== p.body;
    const changedTitle = title !== undefined && title !== p.title;
    if (changedTitle) {
      Store.rewriteLinks(p.title, title);
      // The incoming editor body may carry self-links under the old title too.
      if (body !== undefined) {
        const escRe = p.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        body = body.replace(new RegExp(`\\[\\[\\s*${escRe}\\s*(?=[\\]#|])`, 'gi'), '[[' + title);
      }
    }
    if (title !== undefined) p.title = title;
    if (section !== undefined) p.section = section;
    if (tags !== undefined) p.tags = tags;
    if (body !== undefined) p.body = body;
    if (changedBody || changedTitle) {
      p.updated = now;
      p.updatedBy = me.email;
      p.revs.push({ ts: now, by: me.email, summary: summary || (changedTitle && !changedBody ? 'Renamed' : 'Edited'), body: p.body });
      if (p.revs.length > 80) p.revs.splice(0, p.revs.length - 80);
      Store.log({ kind: 'edit', by: me.email, pageId: id, summary: summary || '' });
    }
    Store.reindex();
    Store.persist();
    return p;
  },

  toggleTask(pageId, n) {
    const p = Store.page(pageId);
    if (!p) return;
    p.body = MD.toggleTaskInSource(p.body, n);
    p.updated = Date.now();
    p.updatedBy = Store.me().email;
    // Checkbox flips are lightweight — fold into the last rev if it was also
    // a checkbox flip by the same person within 10 minutes; else new rev.
    const last = p.revs[p.revs.length - 1];
    if (last && last.summary === 'Checked items' && last.by === p.updatedBy && Date.now() - last.ts < 600000) {
      last.body = p.body; last.ts = Date.now();
    } else {
      p.revs.push({ ts: Date.now(), by: p.updatedBy, summary: 'Checked items', body: p.body });
    }
    Store.persist();
  },

  restoreRev(pageId, revTs) {
    const p = Store.page(pageId);
    const rev = p?.revs.find((r) => r.ts === revTs);
    if (!rev) return;
    const me = Store.me();
    p.body = rev.body;
    p.updated = Date.now();
    p.updatedBy = me.email;
    p.revs.push({ ts: Date.now(), by: me.email, summary: `Restored version from ${fmtDateTime(rev.ts)}`, body: rev.body });
    Store.log({ kind: 'restore', by: me.email, pageId });
    Store.reindex();
    Store.persist();
  },

  deletePage(id) {
    const idx = Store.s.pages.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const [p] = Store.s.pages.splice(idx, 1);
    // Orphan children up a level rather than cascading the delete.
    Store.s.pages.forEach((q) => { if (q.parent === id) q.parent = null; });
    p.deletedAt = Date.now();
    p.deletedBy = Store.me().email;
    Store.s.trash.push(p);
    Store.log({ kind: 'delete', by: p.deletedBy, title: p.title });
    Store.reindex();
    Store.persist();
    return p;
  },

  restorePage(id) {
    const idx = Store.s.trash.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const [p] = Store.s.trash.splice(idx, 1);
    delete p.deletedAt; delete p.deletedBy;
    // If the id or title was reused while this sat in Trash, the restored copy
    // gets a fresh identity instead of silently forking the live page.
    if (Store.page(p.id)) p.id = p.id + '-' + uid('').slice(1, 5);
    while (Store.pageByTitle(p.title)) p.title = p.title + ' (restored)';
    Store.s.pages.push(p);
    Store.log({ kind: 'restore', by: Store.me().email, pageId: p.id });
    Store.reindex();
    Store.persist();
    return p;
  },

  purgePage(id) {
    const idx = Store.s.trash.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const [p] = Store.s.trash.splice(idx, 1);
    Store.log({ kind: 'purge', by: Store.me().email, title: p.title });
    Store.sweepAttachments();
    Store.persist();
  },

  /* --------------------------- reactions --------------------------------- */

  // Slack-style: one emoji, many people. Stored on the page itself so a
  // reaction travels with the page through moves, trash, and restore.
  toggleReaction(pageId, emoji) {
    const p = Store.page(pageId);
    if (!p) return false;
    if (!p.reactions) p.reactions = {};
    const me = Store.me().email;
    const list = p.reactions[emoji] || (p.reactions[emoji] = []);
    const i = list.indexOf(me);
    if (i >= 0) { list.splice(i, 1); if (!list.length) delete p.reactions[emoji]; }
    else list.push(me);
    Store.persist();
    return i < 0;
  },

  /* --------------------------- roster ------------------------------------ */

  user: (email) => Store.s.users.find((u) => u.email === email) || null,
  userName(email) { return Store.user(email)?.name || email; },
  initials(email) {
    const n = Store.userName(email);
    return n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  },

  setProfile(name, subteam) {
    const u = Store.me();
    const n = String(name || '').trim();
    if (!n) return false;
    const before = u.name;
    u.name = n.slice(0, 60);
    u.subteam = String(subteam || '').trim().slice(0, 40);
    if (before !== u.name) Store.log({ kind: 'rename', by: u.email, who: u.name });
    Store.persist();
    return true;
  },

  addMembers(emails, role) {
    const me = Store.me();
    const results = [];
    for (const raw of emails) {
      const email = raw.trim().toLowerCase();
      if (!email) continue;
      if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) { results.push({ email, ok: false, reason: 'Not a valid email address' }); continue; }
      if (Store.user(email)) { results.push({ email, ok: false, reason: 'Already on the roster' }); continue; }
      const u = {
        email, name: email.split('@')[0], role: role || 'member', status: 'invited',
        subteam: '', joined: null, invitedAt: Date.now(), invitedBy: me.email,
      };
      Store.s.users.push(u);
      Store.log({ kind: 'invite', by: me.email, who: email });
      results.push({ email, ok: true, user: u });
    }
    Store.persist();
    return results;
  },



  setRole(email, role) {
    const u = Store.user(email);
    if (u) { u.role = role; Store.log({ kind: 'role', by: Store.me().email, who: email, role }); Store.persist(); }
  },

  removeUser(email) {
    const i = Store.s.users.findIndex((u) => u.email === email);
    if (i >= 0) {
      Store.s.users.splice(i, 1);
      Store.log({ kind: 'remove', by: Store.me().email, who: email });
      Store.persist();
    }
  },

  /* --------------------------- activity ---------------------------------- */

  log(entry) { Store.s.activity.unshift({ ts: Date.now(), ...entry }); Store.s.activity.splice(400); },
  activity: () => [...Store.s.activity].sort((a, b) => b.ts - a.ts),

  /* --------------------------- prefs (per user) --------------------------- */

  prefs() {
    const email = Store.session() || '_';
    const p = Store.s.prefs[email] || (Store.s.prefs[email] = {});
    if (!Array.isArray(p.starred)) p.starred = [];
    if (!Array.isArray(p.recents)) p.recents = [];
    if (!Array.isArray(p.collapsed)) p.collapsed = [];
    if (!p.editorMode) p.editorMode = 'split';
    return p;
  },
  toggleStar(id) {
    const p = Store.prefs();
    const i = p.starred.indexOf(id);
    if (i >= 0) p.starred.splice(i, 1); else p.starred.unshift(id);
    Store.persist();
    return i < 0;
  },
  touchRecent(id) {
    const p = Store.prefs();
    if (p.recents[0] === id) return; // re-render of the same page: nothing to write
    const i = p.recents.indexOf(id);
    if (i >= 0) p.recents.splice(i, 1);
    p.recents.unshift(id);
    p.recents.splice(8);
    Store.persist();
  },

  /* --------------------------- attachments ------------------------------- */

  att: (id) => Files.get(id),
  attTotal: () => Files.totalBytes(),

  async addAttachment(file) {
    if (file.size > 25 * 1048576) throw new Error('File is over the 25 MB preview cap.');
    const dataUri = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(new Error('Could not read file'));
      r.readAsDataURL(file);
    });
    const a = { id: uid('att'), name: file.name, type: file.type || 'application/octet-stream', size: file.size, dataUri, by: Store.me().email, ts: Date.now() };
    Files.put(a, () => Store.onError && Store.onError(`${file.name} could not be stored durably and will vanish on reload.`));
    return a;
  },

  // Drop attachments nothing references any more (run after purges).
  sweepAttachments() {
    const referenced = new Set();
    for (const list of [Store.s.pages, Store.s.trash]) {
      for (const p of list) {
        for (const m of p.body.matchAll(/att:([A-Za-z0-9-]+)/g)) referenced.add(m[1]);
        for (const rev of p.revs || []) for (const m of String(rev.body).matchAll(/att:([A-Za-z0-9-]+)/g)) referenced.add(m[1]);
      }
    }
    for (const id of [...Files.mem.keys()]) if (!referenced.has(id)) Files.remove(id);
  },

  /* --------------------------- search ------------------------------------ */

  search(q) {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const terms = query.split(/\s+/).filter(Boolean);
    const out = [];
    for (const p of Store.s.pages) {
      const title = p.title.toLowerCase();
      const text = MD.mdToText(p.body).toLowerCase();
      // OR-scored with an all-terms bonus: "buck converter" still surfaces the
      // page that only says "buck" instead of returning nothing.
      let score = 0, hits = 0;
      for (const t of terms) {
        let hit = 0;
        if (title === t) hit += 120;
        else if (title.startsWith(t)) hit += 60;
        else if (title.includes(t)) hit += 40;
        const n = text.split(t).length - 1;
        if (n) hit += Math.min(24, 8 + n * 2);
        if (hit) hits++;
        score += hit;
      }
      if (!hits) continue;
      if (hits === terms.length) score *= 2; // full matches rank first
      else score = Math.round(score * (hits / terms.length));
      // Snippet centered on the first body hit.
      const raw = MD.mdToText(p.body).replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, ' ').replace(/\s*\|\s*/g, ' · ');
      const pos = raw.toLowerCase().indexOf(terms[0]);
      let snip = '';
      if (pos >= 0) {
        const start = Math.max(0, pos - 44);
        snip = (start > 0 ? '…' : '') + raw.slice(start, pos + 96) + '…';
      } else snip = raw.slice(0, 120);
      out.push({ page: p, score, snip });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 12);
  },

  // Subsequence fuzzy for the quick switcher (empty query → recents).
  quick(q) {
    const query = q.trim().toLowerCase();
    if (!query) {
      return Store.prefs().recents.map((id) => Store.page(id)).filter(Boolean).map((p) => ({ page: p, score: 0 }));
    }
    const out = [];
    for (const p of Store.s.pages) {
      const t = p.title.toLowerCase();
      let qi = 0, run = 0, score = 0;
      for (let i = 0; i < t.length && qi < query.length; i++) {
        if (t[i] === query[qi]) { qi++; run++; score += 2 + run; }
        else run = 0;
      }
      if (qi === query.length) out.push({ page: p, score: score + (t.startsWith(query) ? 40 : 0) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 8);
  },
};
