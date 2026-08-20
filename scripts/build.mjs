// Builds public/ — the Vercel (multi-user) client plus its crawl surface:
// robots.txt, sitemap.xml, and the fetchable circular favicon. Static files
// in public/ are served ahead of the SPA rewrite, so these win over the shell.
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fullPage, WIKI_URL } from './assemble.mjs';

// The date the signed-out public surface last materially changed. Update it
// when that page or its metadata really changes — never to simulate freshness.
const PUBLIC_SURFACE_MODIFIED = '2026-08-20';

const out = (f) => new URL(`../public/${f}`, import.meta.url);
mkdirSync(new URL('../public', import.meta.url), { recursive: true });

const html = fullPage({ remote: true });
writeFileSync(out('index.html'), html);

copyFileSync(new URL('../src/client/favicon-cupi-192.png', import.meta.url), out('favicon-cupi.png'));

writeFileSync(
  out('robots.txt'),
  `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${WIKI_URL}/sitemap.xml\n`,
);

writeFileSync(
  out('sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${WIKI_URL}/</loc>\n    <lastmod>${PUBLIC_SURFACE_MODIFIED}</lastmod>\n  </url>\n</urlset>\n`,
);

console.log('public/index.html', html.length, 'bytes (+ robots.txt, sitemap.xml, favicon-cupi.png)');
