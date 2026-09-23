// Real anonymous API requests in an isolated copy; never touches local data.
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

if (!process.env.CONTEXT_TEST_ROOT) {
  const root = await mkdtemp(join(tmpdir(), 'cupi-public-context-test-'));
  try {
    await cp(new URL('../lib', import.meta.url), join(root, 'lib'), { recursive: true });
    await cp(new URL('../api', import.meta.url), join(root, 'api'), { recursive: true });
    const { fullPage } = await import('./assemble.mjs');
    await mkdir(join(root, 'public'));
    await writeFile(join(root, 'public/wiki-shell.html'), fullPage({ remote: true }));
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, CONTEXT_TEST_ROOT: root, DEV_FAKE_AUTH: 'ab3233@cornell.edu', SESSION_SECRET: 'context-tests-only' }, stdio: 'inherit',
    });
    process.exitCode = result.status || (result.error ? 1 : 0);
  } finally { await rm(root, { recursive: true, force: true }); }
} else {
  const load = (file) => import(pathToFileURL(join(process.env.CONTEXT_TEST_ROOT, file)));
  const { default: handler } = await load('api/index.js');
  const { updateState, putFile } = await load('lib/db.js');
  delete process.env.DEV_FAKE_AUTH; // Keep isolated DB; no fake request auth.
  const admin = 'ab3233@cornell.edu';
  await updateState((s) => {
    s.pages = [
      { id: 'child', title: 'Child', parent: 'project', body: 'Child context [File](att:current-file)', revs: [{ body: 'PRIVATE_HISTORY' }] },
      { id: 'project', title: 'Project', parent: null, body: 'PROJECT_CONTEXT [[Child]] <script>window.INJECTED=1</script> $&', tags: ['robot'], owner: admin },
      { id: 'odd id/&', title: 'Odd ID', body: 'ODD_PAGE_CONTEXT' },
    ];
    s.settings = { email: { key: 'SECRET_EMAIL_KEY' }, ai: { credential: 'SECRET_AI_KEY' }, agentLinks: [{ tokenHash: 'PRIVATE_OLD_GRANT' }] };
    s.prefs = { [admin]: { secret: 'PRIVATE_PREFS' } };
    s.trash = [{ id: 'gone', title: 'PRIVATE_TRASH', body: '[Deleted attachment](att:deleted-file)' }];
    return s;
  });
  for (const id of ['current-file', 'deleted-file', 'unreferenced-file']) await putFile({ id, name: id + '.txt', type: 'text/plain', data: Buffer.from(id), size: id.length, by: admin, ts: Date.now() });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = 'GET') => fetch(base + path, { method });
  const noSecrets = (text) => {
    for (const secret of ['PRIVATE_HISTORY', 'SECRET_EMAIL_KEY', 'SECRET_AI_KEY', 'PRIVATE_PREFS', 'PRIVATE_TRASH', 'PRIVATE_OLD_GRANT']) assert.ok(!text.includes(secret), secret);
  };
  try {
    const homepage = await request('/');
    assert.equal(homepage.status, 200); assert.match(homepage.headers.get('content-type'), /text\/html/);
    assert.match(homepage.headers.get('link'), /llms-full.txt/);
    assert.match(homepage.headers.get('cache-control'), /no-store/);
    const html = await homepage.text();
    const publicText = html.match(/<main class="public-context">([\s\S]*?)<\/main>/)[1];
    assert.match(publicText, /PROJECT_CONTEXT/); assert.match(publicText, /Child context/); assert.match(publicText, /ODD_PAGE_CONTEXT/);
    assert.match(publicText, /End of context/); assert.match(publicText, /href="\/llms-full.txt"/);
    assert.match(publicText, /&lt;script&gt;window.INJECTED=1&lt;\/script&gt; \$&amp;/);
    assert.doesNotMatch(publicText, /<script>/); noSecrets(html);
    assert.match(html, /<noscript><style>#boot\{display:none\}/);
    const bot = await fetch(base + '/', { headers: { 'user-agent': 'Googlebot' } });
    assert.equal(await bot.text(), html, 'unchanged content is identical for browser and agent requests');
    assert.match(await (await request('/index.html')).text(), /PROJECT_CONTEXT/);
    const full = await request('/llms-full.txt');
    assert.equal(full.status, 200); assert.match(full.headers.get('content-type'), /text\/plain/);
    const text = await full.text(); noSecrets(text);
    assert.match(text, /PROJECT_CONTEXT/); assert.match(text, /Child context/);
    assert.match(text, /Pages in this response: 3/); assert.match(text, /End of context/);
    assert.match(text, /\/api\/context\/files\/current-file/);
    assert.match(text, /<script>window.INJECTED=1<\/script> \$&/, 'Markdown preserves exact source');
    assert.equal(await (await request('/llms-full.txt', 'HEAD')).text(), '');
    const index = await (await request('/llms.txt')).text();
    assert.match(index, /llms-full.txt\?page=child/); assert.match(index, /page=odd%20id%2F%26/); noSecrets(index);
    const single = await (await request('/llms-full.txt?page=child')).text();
    assert.match(single, /Child context/); assert.doesNotMatch(single, /PROJECT_CONTEXT/);
    assert.match(await (await request('/llms-full.txt?page=odd%20id%2F%26')).text(), /ODD_PAGE_CONTEXT/);
    assert.equal((await request('/llms-full.txt?page=missing')).status, 404);
    assert.equal((await request('/llms-full.txt?page=')).status, 404);
    assert.match(await (await request('/api/context')).text(), /PROJECT_CONTEXT/);
    assert.equal((await request('/api/context/links')).status, 404, 'old token management is removed');
    for (const path of ['/', '/llms.txt', '/llms-full.txt', '/api/context/files/current-file']) {
      assert.equal((await request(path, 'POST')).status, 405);
    }
    const file = await request('/api/context/files/current-file');
    assert.equal(file.status, 200); assert.equal(await file.text(), 'current-file');
    assert.match(file.headers.get('cache-control'), /no-store/);
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    for (const id of ['deleted-file', 'unreferenced-file', 'missing']) assert.equal((await request('/api/context/files/' + id)).status, 404);
    for (const path of ['/api/state', '/api/att/current-file', '/api/mutate']) assert.equal((await request(path)).status, 401, 'normal auth gates remain');
    await updateState((s) => { s.pages.find((p) => p.id === 'project').body = 'LIVE_UPDATE'; return s; });
    assert.match(await (await request('/')).text(), /LIVE_UPDATE/);
    assert.match(await (await request('/llms-full.txt')).text(), /LIVE_UPDATE/);
    await updateState((s) => { s.pages = s.pages.filter((p) => p.id !== 'child'); return s; });
    assert.doesNotMatch(await (await request('/llms-full.txt')).text(), /Child context/);
    assert.equal((await request('/api/context/files/current-file')).status, 404, 'deleting its last live reference removes file access');
    await updateState((s) => { s.pages = []; return s; });
    assert.match(await (await request('/llms-full.txt')).text(), /Pages in this response: 0/);
    console.log('Public context tests passed: anonymous root HTML, full Markdown, per-page fallback, escaped HTML, current updates, attachments, private-data exclusion, and existing auth gates.');
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
