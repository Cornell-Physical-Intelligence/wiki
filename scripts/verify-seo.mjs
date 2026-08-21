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

// The signed-out view must carry the visible cross-links and no claims we
// cannot support while Cornell registration is pending.
assert(
  page.includes('href="https://cornellphysicalintelligence.com/"'),
  'signed-out view is missing the main-site link',
);
assert(
  page.includes('href="https://www.linkedin.com/company/cu-physical-intelligence/"'),
  'signed-out view is missing the LinkedIn link',
);
assert(
  !page.includes('registered student organization'),
  'the shell claims registered status, which is unsupported while Cornell registration is pending',
);

const UNIQUE = 'Cornell Physical Intelligence (CUPI) is a Cornell University student robotics organization';
assert(page.includes('id="seo-public"'), 'production shell is missing the crawlable public landing');
assert(page.includes(UNIQUE), 'production shell is missing unique public prose about CUPI');
assert(
  page.includes('This wiki is the team\'s internal knowledge base'),
  'production shell is missing wiki-specific public prose',
);
assert(
  page.includes('<a href="/about">About this wiki</a>'),
  'production shell does not link the /about page',
);

/* ------------------------------ about page -------------------------------- */
const about = read('public/about/index.html');

assert(about.includes('<meta name="robots" content="index, follow">'), '/about is not indexable');
assert(!about.includes('noindex'), '/about contains a noindex directive');
assert(
  about.includes('<title>About the CUPI Wiki | Cornell Physical Intelligence</title>'),
  '/about has the wrong title',
);
assert(about.includes('<meta name="description" content="'), '/about is missing its description');
assert(
  about.includes(`<link rel="canonical" href="${WIKI_URL}/about">`),
  '/about is missing its canonical URL',
);
assert(
  about.includes(`<meta property="og:url" content="${WIKI_URL}/about">`),
  '/about is missing og:url',
);
assert(
  about.includes(`<meta property="og:image" content="${WIKI_URL}/favicon-cupi.png">`),
  '/about is missing og:image',
);

const aboutLd = about.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
assert(aboutLd, '/about is missing structured data');
const aboutGraph = JSON.parse(aboutLd)['@graph'];
const webPage = aboutGraph.find((n) => n['@type'] === 'WebPage');
const breadcrumbs = aboutGraph.find((n) => n['@type'] === 'BreadcrumbList');
assert(webPage?.url === `${WIKI_URL}/about`, 'WebPage node is missing or mis-URLed');
assert(
  webPage?.publisher?.['@id'] === `${MAIN_SITE}/#organization`,
  'WebPage publisher does not reference the main-site Organization entity',
);
assert(
  webPage?.isPartOf?.['@id'] === `${WIKI_URL}/#website`,
  'WebPage is not tied to the wiki WebSite entity',
);
assert(breadcrumbs, '/about is missing its BreadcrumbList');
assert(
  JSON.stringify(breadcrumbs).includes(`{"@type":"ListItem","position":1,"name":"Home","item":"${WIKI_URL}/"}`),
  'BreadcrumbList does not start at Home',
);

// /about must be pure static: no SPA shell, so hydration can never bounce a
// crawler toward sign-in, and unique factual prose in the raw HTML.
assert(!about.includes('id="app"'), '/about must not ship the SPA app shell');
assert(!about.includes('Store.boot'), '/about must not ship SPA boot code');
assert(
  about.includes('The CUPI Wiki is the team knowledge base of Cornell Physical Intelligence (CUPI)'),
  '/about is missing unique prose about the wiki',
);
assert(
  about.includes('<link rel="canonical" href=') && about.includes(`<a href="/">the landing page</a>`),
  '/about does not link back to the landing',
);
assert(
  about.includes('href="https://cornellphysicalintelligence.com/"'),
  '/about does not link the main site',
);
assert(
  about.includes('https://cornell.campusgroups.com/cupi/home/'),
  '/about is missing the Campus Groups listing link',
);
assert(
  about.includes('mailto:cuphysint@cornell.edu'),
  '/about is missing the contact email link',
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
assert(preview.includes('id="seo-public"'), 'preview is missing the crawlable public landing');
assert(preview.includes(UNIQUE), 'preview is missing unique public prose about CUPI');

/* ------------------------------ crawl files ------------------------------- */
const robots = read('public/robots.txt');
assert(/(^|\n)Allow: \/(\n|$)/.test(robots), 'robots.txt does not allow the site');
assert(robots.includes('Disallow: /api/'), 'robots.txt does not shield the API');
assert(robots.includes(`Sitemap: ${WIKI_URL}/sitemap.xml`), 'robots.txt does not advertise the sitemap');

const sitemap = read('public/sitemap.xml');
const locs = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
assert(
  locs.length === 2 && locs[0] === `${WIKI_URL}/` && locs[1] === `${WIKI_URL}/about`,
  'sitemap.xml must list exactly the root and /about',
);

const shipped = readFileSync(new URL('../public/favicon-cupi.png', import.meta.url));
const master = readFileSync(new URL('../src/client/favicon-cupi-192.png', import.meta.url));
assert(shipped.equals(master), 'shipped favicon bytes do not match the source asset');

console.log('Wiki SEO verification passed: indexable shell + /about, noindexed previews, robots, sitemap, favicon.');
