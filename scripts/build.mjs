// Builds public/ — the Vercel (multi-user) client plus its crawl surface:
// robots.txt, sitemap.xml, and the fetchable circular favicon. Static files
// in public/ are served ahead of the SPA rewrite, so these win over the shell.
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fullPage, aboutPage, WIKI_URL } from './assemble.mjs';

// The date the signed-out public surface last materially changed. Update it
// when that page or its metadata really changes — never to simulate freshness.
const PUBLIC_SURFACE_MODIFIED = '2026-08-21';

// IndexNow key: the file at this exact URL must serve the key verbatim.
const INDEXNOW_KEY = '614d4186b0a00e9f4760e52e3a0a931d';

const out = (f) => new URL(`../public/${f}`, import.meta.url);
mkdirSync(new URL('../public', import.meta.url), { recursive: true });

const html = fullPage({ remote: true });
writeFileSync(out('index.html'), html);

// A static about/ directory: Vercel serves output files before the SPA
// rewrite, so /about resolves to this page and never reaches index.html.
mkdirSync(new URL('../public/about', import.meta.url), { recursive: true });
const about = aboutPage();
writeFileSync(out('about/index.html'), about);

copyFileSync(new URL('../src/client/favicon-cupi-192.png', import.meta.url), out('favicon-cupi.png'));
// The welcome email references this PNG — email clients can't be trusted with webp.
copyFileSync(new URL('../src/client/welcome-crab.png', import.meta.url), out('welcome-crab.png'));

// OAuth Client ID Metadata Document: the deployment's own domain is its Resend
// client identity, so "Connect Resend" needs no registration anywhere.
mkdirSync(new URL('../public/oauth', import.meta.url), { recursive: true });
writeFileSync(out('oauth/client.json'), JSON.stringify({
  client_id: `${WIKI_URL}/oauth/client.json`,
  client_name: 'CUPI Wiki',
  client_uri: WIKI_URL,
  redirect_uris: [`${WIKI_URL}/api/resend/callback`],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  scope: 'emails:send full_access',
}, null, 2) + '\n');

writeFileSync(
  out('robots.txt'),
  `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${WIKI_URL}/sitemap.xml\n`,
);

writeFileSync(
  out('sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${WIKI_URL}/</loc>\n    <lastmod>${PUBLIC_SURFACE_MODIFIED}</lastmod>\n  </url>\n  <url>\n    <loc>${WIKI_URL}/about</loc>\n    <lastmod>${PUBLIC_SURFACE_MODIFIED}</lastmod>\n  </url>\n</urlset>\n`,
);

writeFileSync(out(`${INDEXNOW_KEY}.txt`), INDEXNOW_KEY);

console.log('public/index.html', html.length, 'bytes (+ about/index.html,', about.length, 'bytes, robots.txt, sitemap.xml, favicon-cupi.png)');
