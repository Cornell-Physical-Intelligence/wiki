// Files a bug report as a pull request: branch off the default branch, commit
// the report and its screenshots, open the PR. Degrades with a clear message
// when no token is configured. Token: GITHUB_BUG_TOKEN (fine-grained,
// Contents + Pull requests read/write on this repo).

const REPO = process.env.GITHUB_BUG_REPO || 'Cornell-Physical-Intelligence/wiki';
const API = 'https://api.github.com';

async function gh(token, path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`GitHub ${r.status}: ${detail.slice(0, 160)}`);
  }
  return r.json();
}

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

const cell = (v) => String(v || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export async function fileBugPR({ title, body, images, context, reporter }) {
  const token = process.env.GITHUB_BUG_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    return {
      error: 'Bug filing is not connected yet. An admin sets GITHUB_BUG_TOKEN in Vercel (a fine-grained token with Contents and Pull requests write access on the wiki repo) and redeploys.',
      status: 503,
    };
  }

  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'bug';
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  const branch = `bug/${stamp}-${rand}-${slug}`;
  const dir = `bugs/${stamp}-${slug}`;

  const repo = await gh(token, `/repos/${REPO}`);
  const base = repo.default_branch;
  const ref = await gh(token, `/repos/${REPO}/git/ref/${encodeURIComponent('heads/' + base)}`);
  await gh(token, `/repos/${REPO}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: ref.object.sha } });

  const shots = [];
  for (let i = 0; i < images.length; i++) {
    const name = `shot-${i + 1}${EXT[images[i].type] || '.png'}`;
    await gh(token, `/repos/${REPO}/contents/${dir}/${name}`, {
      method: 'PUT',
      body: { message: `Bug report screenshot ${i + 1}`, content: images[i].data, branch },
    });
    shots.push(name);
  }

  const contextTable = [
    '| | |',
    '|---|---|',
    `| Reporter | ${cell(reporter.name)} (${cell(reporter.email)}) |`,
    `| Page | ${cell(context.page)} |`,
    `| Viewport | ${cell(context.viewport)} |`,
    `| Browser | ${cell(context.ua)} |`,
    `| Filed | ${new Date().toISOString()} |`,
  ].join('\n');

  const report = `# ${title}\n\n${body}\n\n## Context\n\n${contextTable}\n${shots.length ? `\n## Screenshots\n\n${shots.map((n, i) => `![shot ${i + 1}](./${n})`).join('\n\n')}\n` : ''}`;
  await gh(token, `/repos/${REPO}/contents/${dir}/report.md`, {
    method: 'PUT',
    body: { message: `Bug report: ${title}`, content: Buffer.from(report, 'utf8').toString('base64'), branch },
  });

  const rawBase = `https://raw.githubusercontent.com/${REPO}/${branch}/${dir}`;
  const prBody = `${body}\n\n${contextTable}\n${shots.length ? `\n${shots.map((n, i) => `![shot ${i + 1}](${rawBase}/${n})`).join('\n\n')}\n` : ''}\nFiled from the wiki by ${cell(reporter.name)}.`;
  const pr = await gh(token, `/repos/${REPO}/pulls`, {
    method: 'POST',
    body: { title: `Bug: ${title}`, head: branch, base, body: prBody },
  });
  return { url: pr.html_url, number: pr.number };
}
