// Shared assembly for all three targets: the Vercel client (public/), the
// GitHub Pages preview (docs/), and the artifact fragment. One source of
// truth so the builds can't drift.
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../src/client/${f}`, import.meta.url), 'utf8');
const b64 = (f) => readFileSync(new URL(`../src/client/${f}`, import.meta.url)).toString('base64');

// The site's own favicon — the same rounded-square tab mark as
// cornellphysicalintelligence.com, so both CUPI tabs carry one silhouette.
export const FAVICON = `data:image/png;base64,${b64('favicon-squircle-32.png')}`;

// Public SEO surface for the production wiki only. The GitHub Pages preview
// and the artifact build stay noindexed so they can never be indexed in place
// of — or in competition with — the real deployment.
export const WIKI_URL = 'https://wiki.cornellphysicalintelligence.com';
const MAIN_SITE = 'https://cornellphysicalintelligence.com';
const WIKI_TITLE = 'CUPI Wiki | Cornell Physical Intelligence';
const WIKI_DESCRIPTION =
  'The team wiki of Cornell Physical Intelligence (CUPI), a Cornell University student robotics organization: subteam documentation, project pages, and team processes. Sign in with a cornell.edu Google account.';

// The Organization node reuses the main site's @id so Google merges the wiki
// into the same CUPI entity graph; sameAs mirrors src/seo.js on the main site.
const STRUCTURED_DATA = JSON.stringify({
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `${WIKI_URL}/#website`,
      url: `${WIKI_URL}/`,
      name: 'CUPI Wiki',
      alternateName: [
        'Cornell Physical Intelligence Wiki',
        'Cornell University Physical Intelligence Wiki',
      ],
      description: WIKI_DESCRIPTION,
      inLanguage: 'en-US',
      publisher: { '@id': `${MAIN_SITE}/#organization` },
    },
    {
      '@type': 'Organization',
      '@id': `${MAIN_SITE}/#organization`,
      name: 'Cornell Physical Intelligence',
      alternateName: ['CUPI', 'Cornell University Physical Intelligence', 'Cornell Physical Intelligence Club'],
      url: `${MAIN_SITE}/`,
      logo: `${MAIN_SITE}/favicon-cupi.png`,
      sameAs: [
        'https://cornell.campusgroups.com/cupi/home/',
        'https://github.com/Cornell-Physical-Intelligence',
        'https://www.instagram.com/cornellphysicalintelligence/',
        'https://www.linkedin.com/company/cu-physical-intelligence/',
        'https://www.youtube.com/@cornellphysicalintelligence',
        `${WIKI_URL}/`,
      ],
    },
  ],
});

// Visible, unique public prose so a logged-out fetch (no JS) is not an empty
// #app shell. Crawlers read this block in the raw HTML. A tiny inline script
// hides it for JS clients so the Voronoi sign-in title is the human landing;
// viewLogin then repeats the same sentences so a rendered snapshot matches.
export const PUBLIC_LANDING_ABOUT = `<div class="login__about">
<p>Cornell Physical Intelligence (CUPI) is a Cornell University student robotics organization in Ithaca, New York. We build robots that reason about the physical world: intelligent manipulation, autonomous perception, and navigation on aerial and ground platforms.</p>
<p>This wiki is the team's internal knowledge base. Members document CAD conventions, board bring-up, flight-test procedure, project pages, and the processes that keep Mechanical, Electrical, Software, and Business working as one team.</p>
<p>Wiki pages stay private to the CUPI roster. Sign in with a cornell.edu Google account. Access is allowlisted; once a team lead has added you, signing in is all it takes.</p>
</div>`;

export const PUBLIC_LANDING = `<section id="seo-public" class="seo-public">
<h1>CUPI Wiki</h1>
<p class="seo-public__kicker">Cornell University Physical Intelligence</p>
${PUBLIC_LANDING_ABOUT}
<p class="seo-public__links"><a href="https://cornellphysicalintelligence.com/">cornellphysicalintelligence.com</a> &middot; <a href="https://www.linkedin.com/company/cu-physical-intelligence/">LinkedIn</a></p>
</section>`;

export function styles() {
  return `@font-face{font-family:'Playfair Display';font-style:normal;font-weight:700;font-display:swap;src:url(data:font/woff2;base64,${b64('playfair.woff2')}) format('woff2');}
@font-face{font-family:'Questrial';font-style:normal;font-weight:400;font-display:swap;src:url(data:font/woff2;base64,${b64('questrial.woff2')}) format('woff2');}
${read('styles.css')}`;
}

// Binary assets are injected ahead of the app code as constants.
export function scripts({ remote = false } = {}) {
  const assets = `'use strict';
const CUPI_LOGO = 'data:image/png;base64,${b64('cupi-logo-192.png')}';
const CRAB_URI = 'data:image/webp;base64,${b64('crab-380.webp')}';
const PUBLIC_LANDING_ABOUT = ${JSON.stringify(PUBLIC_LANDING_ABOUT)};`;
  return [
    assets,
    read('icons.js'),
    read('voronoi.js'),
    read('data.js'),
    read('markdown.js'),
    read('store.js'),
    read('ui.js'),
    read('ui2.js'),
    read('ui3.js'),
    ...(remote ? [readFileSync(new URL('../src/remote.js', import.meta.url), 'utf8')] : []),
    read('main.js'),
  ].join('\n');
}

// The crawlable head. Production declares the same two-icon pattern as the
// main site: the circular 192px disc at a fetchable URL first (what Google
// uses), then the squircle as an inline data URI (what browser tabs pick).
function headFor(remote) {
  if (!remote) {
    return `<meta name="robots" content="noindex, nofollow">
<title>CUPI Wiki</title>
<link rel="icon" href="${FAVICON}">`;
  }
  return `<meta name="robots" content="index, follow, max-image-preview:large">
<title>${WIKI_TITLE}</title>
<meta name="description" content="${WIKI_DESCRIPTION}">
<link rel="canonical" href="${WIKI_URL}/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="CUPI Wiki">
<meta property="og:title" content="${WIKI_TITLE}">
<meta property="og:description" content="${WIKI_DESCRIPTION}">
<meta property="og:url" content="${WIKI_URL}/">
<meta property="og:image" content="${WIKI_URL}/favicon-cupi.png">
<meta name="twitter:card" content="summary">
<link rel="icon" type="image/png" sizes="192x192" href="/favicon-cupi.png">
<link rel="icon" type="image/png" sizes="32x32" href="${FAVICON}">
<link rel="apple-touch-icon" href="/favicon-cupi.png">
<script type="application/ld+json">${STRUCTURED_DATA}</script>`;
}

export function fullPage({ remote }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${headFor(remote)}
<style>
${styles()}
</style>
</head>
<body>
${PUBLIC_LANDING}
<script>document.getElementById('seo-public').hidden = true;</script>
<div id="app"></div>
<script>
${scripts({ remote })}
</script>
</body>
</html>`;
}
