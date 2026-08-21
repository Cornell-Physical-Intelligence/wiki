/* ============================================================================
   Markdown engine. Standard Markdown plus the team dialect:
     [[Page]] wiki links · ::: callouts · task lists that stay interactive in
     read mode · att: images with captions · !file[label](att:id) cards ·
     bare Onshape / Altium 365 URLs become rich cards · ``` or ~~~ fences.
   render(src, ctx) returns { html, toc, tasks } — ctx resolves pages and
   attachments so the engine stays pure.
   ========================================================================== */

'use strict';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'p';

/* ------------------------------- syntax highlight ------------------------ */

const KEYWORDS = 'if else for while return def class import from const let var function async await new try catch switch case break continue struct void int float double bool true false null None nullptr public private static include using namespace pass raise with lambda yield fn match pub mut'.split(' ');

function highlight(code, lang) {
  // Tokenize raw text, escape per token. Comments and strings win over keywords.
  const rules = [
    { re: /(#|\/\/)[^\n]*/y, cls: 'tok-c' },
    { re: /\/\*[\s\S]*?\*\//y, cls: 'tok-c' },
    { re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/y, cls: 'tok-s' },
    { re: /\b\d+(?:\.\d+)?\b/y, cls: 'tok-n' },
    { re: /[A-Za-z_][A-Za-z0-9_]*/y, cls: null }, // maybe keyword
    { re: /[\s\S]/y, cls: null },
  ];
  let out = '', i = 0;
  while (i < code.length) {
    let matched = false;
    for (const r of rules) {
      r.re.lastIndex = i;
      const m = r.re.exec(code);
      if (m && m.index === i) {
        const t = m[0];
        if (r.cls) out += `<span class="${r.cls}">${esc(t)}</span>`;
        else if (/^[A-Za-z_]/.test(t) && KEYWORDS.includes(t)) out += `<span class="tok-k">${esc(t)}</span>`;
        else out += esc(t);
        i += t.length; matched = true; break;
      }
    }
    if (!matched) { out += esc(code[i]); i++; }
  }
  return out;
}

/* ------------------------------- embeds ---------------------------------- */

// Video links on their own line become players. IDs are extracted by these
// regexes and the embed URL is rebuilt from the ID alone — raw input never
// reaches an iframe src. Rendering is synchronous, so the facade starts with
// a generic provider label and the sharpest guessable thumbnail; at view time
// mountVideoMeta (ui2.js) swaps in the real title via oEmbed and walks the
// thumbnail down to a size the video actually has.
function parseVideoUrl(url) {
  let m = url.match(/^https:\/\/(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)([\w-]{11})/i)
       || url.match(/^https:\/\/youtu\.be\/([\w-]{11})/i);
  if (m) return { provider: 'youtube', id: m[1], watch: `https://www.youtube.com/watch?v=${m[1]}`, thumb: `https://i.ytimg.com/vi/${m[1]}/maxresdefault.jpg`, label: 'YouTube video' };
  m = url.match(/^https:\/\/(?:www\.)?vimeo\.com\/(\d{6,12})/);
  if (m) return { provider: 'vimeo', id: m[1], watch: `https://vimeo.com/${m[1]}`, thumb: null, label: 'Vimeo video' };
  m = url.match(/^https:\/\/(?:www\.)?loom\.com\/share\/([a-f0-9]{32})/i);
  if (m) return { provider: 'loom', id: m[1], watch: `https://www.loom.com/share/${m[1]}`, thumb: null, label: 'Loom recording' };
  return null;
}

const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>';

function videoEmbed(v) {
  // Click-to-play facade: nothing loads from the provider until asked.
  return `<div class="video-embed">
    <button type="button" class="video-embed__face" data-action="video-play" data-provider="${v.provider}" data-vid="${esc(v.id)}" aria-label="Play ${esc(v.label)}">
      ${v.thumb ? `<img class="video-embed__thumb" src="${esc(v.thumb)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      <span class="video-embed__btn">${PLAY_ICON}</span>
      <span class="video-embed__tag">${esc(v.label)}</span>
    </button>
    <a class="video-embed__ext" href="${esc(v.watch)}" target="_blank" rel="noreferrer">Open&nbsp;&#8599;</a>
  </div>`;
}

function parseEmbedUrl(url) {
  let m = url.match(/^https:\/\/cad\.onshape\.com\/documents\/([a-f0-9]+)(?:\/[wv]\/([a-f0-9]+))?(?:\/e\/([a-f0-9]+))?/i);
  if (m) return { kind: 'onshape', label: 'Onshape document', ref: `doc ${m[1].slice(0, 8)}…${m[3] ? ' · element ' + m[3].slice(0, 6) + '…' : ''}`, url };
  m = url.match(/^https:\/\/([a-z0-9-]+)\.altium\.com\/designs\/([A-Za-z0-9-]+)/i);
  if (m) return { kind: 'altium', label: 'Altium 365 design', ref: `${m[1]} · ${m[2].slice(0, 8)}…`, url };
  return null;
}

const EMBED_ICONS = {
  onshape: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2.5l8 4.6v9.3l-8 4.6-8-4.6V7.1z"/><path d="M12 2.5v9.2m0 0l8-4.6m-8 4.6l-8-4.6" opacity=".55"/></svg>',
  altium: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3.5" y="3.5" width="17" height="17" rx="2"/><circle cx="9" cy="9" r="1.6"/><circle cx="15" cy="15" r="1.6"/><path d="M9 10.6V15h4.4"/></svg>',
};

function embedCard(e) {
  return `<div class="embed-card embed-card--${e.kind}">
    <span class="embed-card__icon">${EMBED_ICONS[e.kind]}</span>
    <span class="embed-card__meta"><b>${esc(e.label)}</b><span class="embed-card__ref">${esc(e.ref)}</span></span>
    <span class="embed-card__note">live viewer on production</span>
    <a class="btn btn--sm" href="${esc(e.url)}" target="_blank" rel="noreferrer">Open&nbsp;&#8599;</a>
  </div>`;
}

/* ------------------------------- inline ---------------------------------- */

const FILE_ICONS = {
  cad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2.5l8 4.6v9.3l-8 4.6-8-4.6V7.1z"/><path d="M12 21V11.7m0 0L4 7.1m8 4.6l8-4.6"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 2.8h8l4 4v14.4H6z"/><path d="M14 2.8v4h4"/><path d="M9 13h6M9 16.5h6"/></svg>',
  ecad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h4m8 0h4M12 4v4m0 8v4"/><circle cx="12" cy="12" r="2.4"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 2.8h8l4 4v14.4H6z"/><path d="M14 2.8v4h4"/></svg>',
};

function fileKind(name, type) {
  const n = (name || '').toLowerCase();
  if (/\.(stl|obj)$/.test(n) || /^model\//.test(type || '')) return { icon: 'cad', tag: n.endsWith('.obj') ? 'OBJ' : 'STL', viewer: true };
  if (/\.(step|stp|f3d|iges|igs|sldprt|3mf)$/.test(n)) return { icon: 'cad', tag: n.split('.').pop().toUpperCase(), viewer: false };
  if (/\.(schdoc|pcbdoc|prjpcb|kicad_sch|kicad_pcb)$/.test(n)) return { icon: 'ecad', tag: n.split('.').pop().replace('kicad_', '').toUpperCase(), viewer: false };
  if (/\.pdf$/.test(n)) return { icon: 'pdf', tag: 'PDF', viewer: false };
  return { icon: 'file', tag: (n.split('.').pop() || 'file').toUpperCase().slice(0, 6), viewer: false };
}

function fmtSize(b) {
  if (b == null) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function fileCard(label, att) {
  if (!att) return `<span class="missing-att">missing attachment</span>`;
  const k = fileKind(att.name, att.type);
  const body = `<span class="filecard__icon">${FILE_ICONS[k.icon]}</span>
    <span class="filecard__meta"><b>${esc(label || att.name)}</b><span>${esc(att.name)} · ${k.tag} · ${fmtSize(att.size)}</span></span>`;
  if (k.viewer) {
    return `<div class="cad-embed" data-att="${esc(att.id)}"><div class="cad-embed__head">${body}<span class="cad-embed__hint">drag to orbit · scroll to zoom</span></div><div class="cad-embed__stage"><canvas></canvas></div></div>`;
  }
  return `<div class="filecard" data-att="${esc(att.id)}">${body}<button class="btn btn--sm" data-action="att-open" data-id="${esc(att.id)}">Open</button></div>`;
}

function renderInline(src, ctx, opts = {}) {
  let s = esc(src);

  // Backslash escapes (GFM): \* renders a literal *, never emphasis.
  const escStash = [];
  s = s.replace(/\\([\\`*_~\[\]()#!|{}<>+.-])/g, (_, ch) => { escStash.push(esc(ch)); return `\x02${escStash.length - 1}\x02`; });

  // Protect code spans first.
  const stash = [];
  // Double-backtick spans first (GFM: allows single backticks inside).
  s = s.replace(/``([^\n]+?)``/g, (_, c) => { stash.push(`<code>${c.trim()}</code>`); return `\x00${stash.length - 1}\x00`; });
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { stash.push(`<code>${c}</code>`); return ` ${stash.length - 1} `; });

  // Images: ![alt](src "caption")
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*?)&quot;)?\)/g, (whole, alt, url, cap) => {
    let srcUri = url;
    if (url.startsWith('att:')) {
      const att = ctx.att(url.slice(4));
      if (!att) return `<span class="missing-att">missing attachment</span>`;
      srcUri = att.dataUri || att.url;
    }
    // Unsupported scheme: show the author their literal syntax, never half of it.
    if (!/^(data:|https?:|\/api\/att\/)/.test(srcUri)) return whole;
    const img = `<img src="${srcUri}" alt="${alt}" loading="lazy" data-action="lightbox">`;
    return cap ? `<figure>${img}<figcaption>${cap}</figcaption></figure>` : img;
  });

  // Links [text](url) — external only; internal linking is [[...]].
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s\x00]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noreferrer" class="ext">${t}</a>`);

  // Wiki links [[Title]] or [[Title|label]] or [[Title#Anchor|label]]
  s = s.replace(/\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g, (_, title, anchor, label) => {
    const t = title.trim();
    const page = ctx.pageByTitle(t);
    const text = label ? label.trim() : t;
    if (page) {
      const hash = anchor ? '#' + slugify(anchor) : '';
      return `<a href="#/page/${page.id}${hash}" class="wikilink">${esc(text)}</a>`;
    }
    return `<a href="#/new?title=${encodeURIComponent(t)}" class="wikilink wikilink--missing" title="Page doesn't exist yet. Click to create it">${esc(text)}</a>`;
  });

  // Autolinks
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)\x00]+)/g, (_, pre, u) => {
    // GFM: trailing punctuation belongs to the sentence, not the URL.
    const m = u.match(/[.,;:!?]+$/);
    const trail = m ? m[0] : '';
    if (trail) u = u.slice(0, -trail.length);
    return `${pre}<a href="${u}" target="_blank" rel="noreferrer" class="ext">${u.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a>${trail}`;
  });

  // Emphasis / strike
  s = s.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(>])__([^\n]+?)__(?![\w])/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[\s(>])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(>])_([^_\n]+)_(?![\w])/g, '$1<em>$2</em>'); // no intra-word emphasis (GFM)
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  if (!opts.noBreaks) s = s.replace(/\n/g, '<br>');

  s = s.replace(/ (\d+) /g, (_, i) => stash[+i]);
  s = s.replace(/\x02(\d+)\x02/g, (_, i) => escStash[+i]);
  return s;
}

/* ------------------------------- blocks ---------------------------------- */

const CALLOUT_ICONS = {
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 11.5V16"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3.5l9.5 16.5H2.5z"/><path d="M12 10v4m0 3h.01"/></svg>',
  tip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18h6m-5 3h4M12 3a6 6 0 013.6 10.8c-.7.6-1.1 1.3-1.1 2.2H9.5c0-.9-.4-1.6-1.1-2.2A6 6 0 0112 3z"/></svg>',
};

function mdRender(src, ctx) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const toc = [];
  // The task counter is shared across nested renders (callouts, blockquotes)
  // so every checkbox's index matches its position in document order — the
  // same order walkTasks() sees. Diverging here silently flips wrong lines.
  const counter = ctx._taskCounter || (ctx._taskCounter = { i: 0 });
  let html = '';
  let i = 0;
  const usedIds = new Set();

  const headingId = (text) => {
    let id = slugify(text.replace(/\[\[|\]\]|[*_`]/g, ''));
    while (usedIds.has(id)) id += '-x';
    usedIds.add(id);
    return id;
  };

  function listAt(start, baseIndent) {
    // Parses a (possibly nested) list starting at `start`. Returns [html, next].
    let out = '', k = start, ordered = null, open = false, startNum = 1;
    const itemRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    while (k < lines.length) {
      const m = lines[k].match(itemRe);
      if (!m) break;
      const ind = m[1].length;
      if (ind < baseIndent) break;
      if (ind > baseIndent) { // nested list inside previous item
        const [inner, next] = listAt(k, ind);
        out = out.replace(/<\/li>\s*$/, '') + inner + '</li>';
        k = next; continue;
      }
      const isOrd = /\d/.test(m[2][0]);
      if (!open) { ordered = isOrd; open = true; if (isOrd) startNum = parseInt(m[2], 10) || 1; }
      let body = m[3];
      const task = body.match(/^\[( |x|X)\]\s+(.*)$/);
      if (task) {
        const done = task[1].toLowerCase() === 'x';
        const idx = counter.i++;
        out += `<li class="task${done ? ' done' : ''}"><input type="checkbox" data-task="${idx}" ${done ? 'checked' : ''} ${ctx.readonly ? 'disabled' : ''}><span class="task-text">${renderInline(task[2], ctx)}</span></li>`;
      } else {
        out += `<li>${renderInline(body, ctx)}</li>`;
      }
      k++;
    }
    const tag = ordered ? 'ol' : 'ul';
    const attr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
    return [`<${tag}${attr}>${out}</${tag}>`, k];
  }

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // Fences
    let m = line.match(/^(```|~~~)\s*(\w*)\s*$/);
    if (m) {
      const fence = m[1], lang = m[2];
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) { buf.push(lines[i]); i++; }
      i++;
      const code = buf.join('\n');
      html += `<pre>${lang ? `<span class="codelang">${esc(lang)}</span>` : ''}<code>${lang ? highlight(code, lang) : esc(code)}</code></pre>`;
      continue;
    }

    // Callouts ::: kind Title? ... :::
    m = line.match(/^:::\s*(note|warn|tip)\s*(.*)$/);
    if (m) {
      const kind = m[1], title = m[2].trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^:::\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      const inner = mdRender(buf.join('\n'), { ...ctx, _nested: true });
      html += `<div class="callout callout--${kind}">${CALLOUT_ICONS[kind]}<div>${title ? `<p class="callout__title">${renderInline(title, ctx)}</p>` : ''}${inner.html}</div></div>`;
      continue;
    }

    // Headings
    m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const lvl = Math.min(4, Math.max(2, m[1].length)); // h1 is the page title; deep levels clamp to h4
      const text = m[2].trim();
      // Headings can carry inline markup (links, wikilinks, emphasis). The
      // TOC and the anchor id want the plain words, not the syntax.
      const plain = text
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
        .replace(/\[\[([^\]|]+)\]\]/g, '$1')
        .replace(/[*_`~]/g, '')
        .trim();
      const id = headingId(plain);
      if (lvl <= 3) toc.push({ lvl, id, text: plain });
      // Full-route href when the page is known, so copied links and reloads work.
      const hhref = ctx.pageId ? `#/page/${ctx.pageId}#${id}` : `#${id}`;
      html += `<h${lvl} id="${id}"><a class="hlink" href="${hhref}" aria-label="Link to section"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 14a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7M14 10a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7"/></svg></a>${renderInline(text, ctx)}</h${lvl}>`;
      i++;
      continue;
    }

    // HR
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { html += '<hr>'; i++; continue; }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      const inner = mdRender(buf.join('\n'), { ...ctx, _nested: true });
      html += `<blockquote>${inner.html}</blockquote>`;
      continue;
    }

    // Table — rows tolerate a missing trailing pipe rather than vanishing.
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const heads = line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      // GFM alignment row: :--- left, :---: center, ---: right.
      const aligns = lines[i + 1].replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => {
        c = c.trim();
        if (/^:-+:$/.test(c)) return 'center';
        if (/^-+:$/.test(c)) return 'right';
        return null;
      });
      const al = (k) => aligns[k] ? ` style="text-align:${aligns[k]}"` : '';
      i += 2;
      let rows = '';
      while (i < lines.length && /^\|/.test(lines[i]) && lines[i].trim() !== '') {
        const cells = lines[i].replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
        rows += `<tr>${cells.map((c, k) => `<td${al(k)}>${renderInline(c, ctx, { noBreaks: true })}</td>`).join('')}</tr>`;
        i++;
      }
      html += `<div class="tablewrap"><table><thead><tr>${heads.map((h, k) => `<th${al(k)}>${renderInline(h, ctx, { noBreaks: true })}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
      continue;
    }

    // Lists
    if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) {
      const [out, next] = listAt(i, line.match(/^(\s*)/)[1].length);
      html += out;
      i = next;
      continue;
    }

    // File card on its own line
    m = line.match(/^!file\[([^\]]*)\]\(att:([^)\s]+)\)\s*$/);
    if (m) { html += fileCard(m[1], ctx.att(m[2])); i++; continue; }

    // Bare embed URL on its own line
    if (/^https:\/\/\S+$/.test(line.trim())) {
      const v = parseVideoUrl(line.trim());
      if (v) { html += videoEmbed(v); i++; continue; }
      const e = parseEmbedUrl(line.trim());
      if (e) { html += embedCard(e); i++; continue; }
    }

    // Paragraph: gather until blank or a structural line
    const buf = [line];
    i++;
    while (
      i < lines.length && lines[i].trim() &&
      !/^(#{1,4}\s|>\s?|(\s*)([-*+]|\d+[.)])\s|```|~~~|:::|\|.*\||!file\[|(-{3,}|\*{3,})\s*$)/.test(lines[i]) &&
      !/^https:\/\/\S+$/.test(lines[i].trim())
    ) { buf.push(lines[i]); i++; }
    html += `<p>${renderInline(buf.join('\n'), ctx)}</p>`;
  }

  return { html, toc, tasks: counter.i };
}

/* ------------------------------- source helpers -------------------------- */

// Walk task lines exactly the way the renderer encounters them: skip fenced
// code (the renderer never renders checkboxes there) and see through
// blockquote '>' prefixes (the renderer does render those). Callout bodies
// are ordinary lines, so document order alone keeps parity.
function walkTasks(src, visit) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  let fence = null, idx = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Fence tracking works on the quote-stripped line so fences inside
    // blockquotes are honored — the renderer's nested pass skips them too.
    const bare = line.replace(/^(\s*>\s?)+/, '');
    if (fence) { if (bare.startsWith(fence)) fence = null; continue; }
    const f = bare.match(/^(```|~~~)\s*(\w*)\s*$/); // must mirror the renderer's fence rule exactly
    if (f) { fence = f[1]; continue; }
    // (?=\s): the renderer only treats "[x] " (with a following space) as a task.
    const m = bare.match(/^(\s*(?:[-*+]|\d+[.)])\s+\[)( |x|X)(\])(?=\s)/);
    if (!m) continue;
    const out = visit(idx, m[2], line, i);
    if (out !== undefined) { lines[i] = out; return lines.join('\n'); }
    idx++;
  }
  return null;
}

// Flip the nth task checkbox in a markdown source (nth in render order).
function toggleTaskInSource(src, n) {
  const out = walkTasks(src, (idx, state, line) => {
    if (idx !== n) return undefined;
    return line.replace(/^((?:\s*>\s?)*\s*(?:[-*+]|\d+[.)])\s+\[)( |x|X)(\])(?=\s)/, (_, pre, st, post) =>
      pre + (st.trim() ? ' ' : 'x') + post);
  });
  return out === null ? String(src) : out;
}

// Task totals for the page-head meter, fence-aware like the renderer.
function countTasks(src) {
  let total = 0, done = 0;
  walkTasks(src, (idx, state) => { total++; if (state.trim()) done++; return undefined; });
  return { total, done };
}

// Outgoing wiki-link titles, for backlink indexing.
function extractWikiLinks(src) {
  const out = new Set();
  const clean = String(src || '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, '');
  let m;
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  while ((m = re.exec(clean))) out.add(m[1].trim().toLowerCase());
  return [...out];
}

// Plain text for search indexing and snippets.
function mdToText(src) {
  return String(src || '')
    .replace(/^(```|~~~).*$/gm, ' ') // keep code content searchable, drop the fences
    .replace(/!file\[([^\]]*)\]\([^)]*\)/g, ' $1 ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, ' $1 ')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, t, l) => l || t)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^:::.*$|^[#>|*+-]+\s*/gm, ' ')
    .replace(/\[( |x|X)\]\s*/g, ' ')
    .replace(/[`*~]/g, '') // keep underscores — identifiers like TAU_COMMIT must stay searchable
    .replace(/\s+/g, ' ')
    .trim();
}

const MD = { render: mdRender, renderInline, slugify, esc, toggleTaskInSource, countTasks, extractWikiLinks, mdToText, fmtSize, fileKind, parseEmbedUrl };
