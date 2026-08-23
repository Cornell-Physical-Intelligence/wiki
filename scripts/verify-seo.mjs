// Verifies the built SEO surface: the production shell is indexable with the
// right metadata, the preview builds can never be, and the crawl files are
// exactly what we intend. Run after build.mjs and build-preview.mjs.
import { readFileSync } from 'node:fs';
import { WIKI_URL } from './assemble.mjs';

const MAIN_SITE = 'https://cornellphysicalintelligence.com';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/* ------------------------- production shell (public/) --------------------- */
const page = read('public/index.html');

assert(
  page.includes('<meta name="robots" content="index, follow, max-image-preview:large">'),
  'production shell is not indexable',
);
assert(!page.includes('noindex'), 'production shell still contains a noindex directive');
assert(
  page.includes('<title>CUPI Wiki | Cornell Physical Intelligence</title>'),
  'production shell has the wrong title',
);
assert(page.includes('<meta name="description" content="'), 'production shell is missing its description');
assert(
  page.includes(`<link rel="canonical" href="${WIKI_URL}/">`),
  'production shell is missing its canonical URL',
);
assert(page.includes(`<meta property="og:url" content="${WIKI_URL}/">`), 'production shell is missing og:url');

const icons = page.match(/<link rel="icon"[^>]+>/g) ?? [];
assert(
  icons.length === 2 &&
    icons[0] === '<link rel="icon" type="image/png" sizes="192x192" href="/favicon-cupi.png">' &&
    icons[1].startsWith('<link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,'),
  'production shell does not pair the crawlable circular icon with the inline squircle tab icon',
);
assert(
  page.includes('<link rel="apple-touch-icon" href="/favicon-cupi.png">'),
  'production shell is missing the circular touch icon',
);

const ld = page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
assert(ld, 'production shell is missing structured data');
const graph = JSON.parse(ld)['@graph'];
const website = graph.find((n) => n['@type'] === 'WebSite');
const organization = graph.find((n) => n['@type'] === 'Organization');
assert(website?.name === 'CUPI Wiki', 'WebSite node is missing or misnamed');
assert(
  website?.publisher?.['@id'] === `${MAIN_SITE}/#organization`,
  'WebSite publisher does not reference the main-site Organization entity',
);
assert(
  organization?.['@id'] === `${MAIN_SITE}/#organization`,
  'Organization @id does not match the main-site entity graph',
);
assert(
  organization?.sameAs?.includes('https://www.linkedin.com/company/cu-physical-intelligence/'),
  'Organization sameAs is missing the LinkedIn entity URL',
);

// SEO stays in the document head. The signed-out interface must contain only
// the real wiki login experience, never additional crawl-oriented prose.
assert(
  !page.includes('registered student organization'),
  'the shell claims registered status, which is unsupported while Cornell registration is pending',
);
assert(
  !page.includes('id="seo-public"') && !page.includes('login__about'),
  'production shell contains an SEO-only visible content block',
);
assert(
  !page.includes('Cornell University student robotics organization in Ithaca') &&
    !page.includes('Access is allowlisted'),
  'production shell contains the removed crawl-oriented landing prose',
);

/* ------------------------ preview builds stay private --------------------- */
const preview = read('docs/index.html');
assert(
  preview.includes('<meta name="robots" content="noindex, nofollow">'),
  'the GitHub Pages preview must remain noindexed',
);
assert(
  !preview.includes('registered student organization'),
  'the preview claims registered status, which is unsupported while Cornell registration is pending',
);
assert(!preview.includes('id="seo-public"'), 'preview contains an SEO-only visible content block');
assert(
  !preview.includes('Cornell University student robotics organization in Ithaca') &&
    !preview.includes('Access is allowlisted'),
  'preview contains the removed landing prose',
);

/* ------------------------------ crawl files ------------------------------- */
const robots = read('public/robots.txt');
assert(/(^|\n)Allow: \/(\n|$)/.test(robots), 'robots.txt does not allow the site');
assert(robots.includes('Disallow: /api/'), 'robots.txt does not shield the API');
assert(robots.includes(`Sitemap: ${WIKI_URL}/sitemap.xml`), 'robots.txt does not advertise the sitemap');

const sitemap = read('public/sitemap.xml');
const locs = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
assert(
  locs.length === 1 && locs[0] === `${WIKI_URL}/`,
  'sitemap.xml must list only the wiki root',
);

const shipped = readFileSync(new URL('../public/favicon-cupi.png', import.meta.url));
const master = readFileSync(new URL('../src/client/favicon-cupi-192.png', import.meta.url));
assert(shipped.equals(master), 'shipped favicon bytes do not match the source asset');

console.log('Wiki verification passed: head-only SEO, no visible SEO copy, noindexed previews, robots, sitemap, favicon.');
