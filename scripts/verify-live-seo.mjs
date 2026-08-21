// Verifies the deployed wiki's crawl surface: indexable shell, working
// robots/sitemap/favicon, gated API, and Googlebot parity. Network-only —
// safe to run from anywhere with the repo checked out.
import { readFileSync } from 'node:fs';
import { WIKI_URL } from './assemble.mjs';

const ORIGIN = (process.env.LIVE_WIKI_ORIGIN ?? WIKI_URL).replace(/\/$/, '');
const GOOGLEBOT =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const request = async (url, options = {}) => {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
        ...options,
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await response.body?.cancel();
        await sleep(attempt * 1_000);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 1_000);
    }
  }
  throw lastError;
};

const home = await request(`${ORIGIN}/`);
const homeHtml = await home.text();
assert(home.status === 200, `wiki homepage returned HTTP ${home.status}`);
assert(
  homeHtml.includes('<meta name="robots" content="index, follow, max-image-preview:large">'),
  'live wiki shell is not indexable',
);
assert(!homeHtml.includes('noindex'), 'live wiki shell still contains a noindex directive');
assert(
  homeHtml.includes('<title>CUPI Wiki | Cornell Physical Intelligence</title>'),
  'live wiki shell has the wrong title',
);
assert(
  homeHtml.includes(`<link rel="canonical" href="${WIKI_URL}/">`),
  'live wiki shell is missing its canonical URL',
);
assert(
  homeHtml.includes('id="seo-public"'),
  'live wiki shell is missing the crawlable public landing',
);
assert(
  homeHtml.includes('Cornell Physical Intelligence (CUPI) is a Cornell University student robotics organization'),
  'live wiki shell is missing unique public prose about CUPI',
);
assert(
  homeHtml.includes('<link rel="icon" type="image/png" sizes="192x192" href="/favicon-cupi.png">'),
  'live wiki shell is missing the crawlable circular favicon',
);
assert(
  homeHtml.includes('<a href="/about">About this wiki</a>'),
  'live wiki shell does not link the /about page',
);

const googlebot = await request(`${ORIGIN}/`, { headers: { 'user-agent': GOOGLEBOT } });
assert((await googlebot.text()) === homeHtml, 'Googlebot received different wiki HTML');

// The second indexable public page: served as a static file ahead of the SPA
// rewrite, so it must carry its own metadata and no sign-in redirect surface.
const about = await request(`${ORIGIN}/about`);
const aboutHtml = await about.text();
assert(about.status === 200, `/about returned HTTP ${about.status}`);
assert(!about.headers.get('x-robots-tag'), '/about must not carry an X-Robots-Tag header');
assert(
  aboutHtml.includes('<meta name="robots" content="index, follow">'),
  '/about is not indexable',
);
assert(!aboutHtml.includes('noindex'), '/about contains a noindex directive');
assert(
  aboutHtml.includes('<title>About the CUPI Wiki | Cornell Physical Intelligence</title>'),
  '/about has the wrong title',
);
assert(
  aboutHtml.includes(`<link rel="canonical" href="${WIKI_URL}/about">`),
  '/about is missing its canonical URL',
);
assert(
  aboutHtml.includes('The CUPI Wiki is the team knowledge base of Cornell Physical Intelligence (CUPI)'),
  '/about is missing unique public prose',
);
assert(!aboutHtml.includes('id="app"'), '/about must not ship the SPA app shell');
const googlebotAbout = await request(`${ORIGIN}/about`, { headers: { 'user-agent': GOOGLEBOT } });
assert((await googlebotAbout.text()) === aboutHtml, 'Googlebot received different /about HTML');

// Any deep path serves the shell; the canonical tag must consolidate it.
const deep = await request(`${ORIGIN}/some-internal-path`);
assert(deep.status === 200, `deep path returned HTTP ${deep.status}`);
assert(
  (await deep.text()).includes(`<link rel="canonical" href="${WIKI_URL}/">`),
  'deep paths do not canonicalize to the root',
);

const robots = await request(`${ORIGIN}/robots.txt`);
const robotsText = await robots.text();
assert(robots.status === 200, `robots.txt returned HTTP ${robots.status}`);
assert(!robotsText.includes('<'), 'robots.txt is serving HTML, not the static file');
assert(robotsText.includes('Disallow: /api/'), 'live robots.txt does not shield the API');
assert(
  robotsText.includes(`Sitemap: ${WIKI_URL}/sitemap.xml`),
  'live robots.txt does not advertise the sitemap',
);

const sitemap = await request(`${ORIGIN}/sitemap.xml`);
const sitemapText = await sitemap.text();
assert(sitemap.status === 200, `sitemap.xml returned HTTP ${sitemap.status}`);
const locs = [...sitemapText.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
assert(
  locs.length === 2 && locs[0] === `${WIKI_URL}/` && locs[1] === `${WIKI_URL}/about`,
  'live sitemap does not list exactly the root and /about',
);

const favicon = await request(`${ORIGIN}/favicon-cupi.png`);
assert(favicon.status === 200, `favicon returned HTTP ${favicon.status}`);
assert(
  favicon.headers.get('content-type')?.includes('image/png'),
  'favicon did not return a PNG content type',
);
const liveFavicon = Buffer.from(await favicon.arrayBuffer());
const master = readFileSync(new URL('../src/client/favicon-cupi-192.png', import.meta.url));
assert(liveFavicon.equals(master), 'live favicon bytes do not match the source asset');

// Privacy gate: the state API must refuse anonymous readers.
const state = await request(`${ORIGIN}/api/state`);
assert(
  state.status === 401 || state.status === 403,
  `anonymous /api/state returned HTTP ${state.status}; expected 401/403`,
);

console.log('Live wiki SEO verification passed: indexable shell + /about, crawl files, favicon, gated API.');
