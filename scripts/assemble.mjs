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
const ABOUT_TITLE = 'About the CUPI Wiki | Cornell Physical Intelligence';
const ABOUT_DESCRIPTION =
  'What the CUPI Wiki is: the team knowledge base of Cornell Physical Intelligence, holding Mechanical, Electrical, Software, and Business & Marketing documentation, project pages, and team processes — plus where to find the club itself.';

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
<p class="seo-public__links"><a href="/about">About this wiki</a> &middot; <a href="https://cornellphysicalintelligence.com/">cornellphysicalintelligence.com</a> &middot; <a href="https://www.linkedin.com/company/cu-physical-intelligence/">LinkedIn</a></p>
</section>`;

// The /about page is pure static HTML: the same design system, but none of the
// SPA bundle, so a crawler or human can never be bounced toward sign-in.
const ABOUT_PROSE = `<p>The CUPI Wiki is the team knowledge base of Cornell Physical Intelligence (CUPI), a Cornell University student robotics organization based in Ithaca, New York. It is where the team keeps the written record of what it builds and how it works.</p>
<p>This site holds the club&rsquo;s working documentation. Each subteam &mdash; Mechanical, Electrical, Software, and Business &amp; Marketing &mdash; keeps its own section, alongside project pages covering the robots the team builds and the team processes that hold the organization together. Together these pages capture how CUPI designs, builds, and operates its robots, and how it runs itself from one project cycle to the next.</p>
<p>The wiki is written by members, for members. Reading its pages requires signing in with a cornell.edu Google account, so nearly everything stays private to the CUPI roster. The only public pages here are <a href="/">the landing page</a> and this one.</p>
<p>If you came looking for the club itself rather than its internal documentation, visit <a href="https://cornellphysicalintelligence.com/">cornellphysicalintelligence.com</a>. It introduces the team, publishes its technical reports &mdash; including the deterministic VQ1 policy developed for the Anduril AI Grand Prix and Racing Without a Map &mdash; and carries application information. CUPI also keeps a <a href="https://cornell.campusgroups.com/cupi/home/">Campus Groups listing</a>. For anything else, write to <a href="mailto:cuphysint@cornell.edu">cuphysint@cornell.edu</a>.</p>`;

const ABOUT_STRUCTURED_DATA = JSON.stringify({
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebPage',
      '@id': `${WIKI_URL}/about#webpage`,
      url: `${WIKI_URL}/about`,
      name: ABOUT_TITLE,
      description: ABOUT_DESCRIPTION,
      inLanguage: 'en-US',
      isPartOf: { '@id': `${WIKI_URL}/#website` },
      publisher: { '@id': `${MAIN_SITE}/#organization` },
      breadcrumb: { '@id': `${WIKI_URL}/about#breadcrumb` },
    },
    {
      '@type': 'BreadcrumbList',
      '@id': `${WIKI_URL}/about#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${WIKI_URL}/` },
        { '@type': 'ListItem', position: 2, name: 'About' },
      ],
    },
  ],
});

export function aboutPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="index, follow">
<title>${ABOUT_TITLE}</title>
<meta name="description" content="${ABOUT_DESCRIPTION}">
<link rel="canonical" href="${WIKI_URL}/about">
<meta property="og:type" content="website">
<meta property="og:site_name" content="CUPI Wiki">
<meta property="og:title" content="${ABOUT_TITLE}">
<meta property="og:description" content="${ABOUT_DESCRIPTION}">
<meta property="og:url" content="${WIKI_URL}/about">
<meta property="og:image" content="${WIKI_URL}/favicon-cupi.png">
<meta name="twitter:card" content="summary">
<link rel="icon" type="image/png" sizes="192x192" href="/favicon-cupi.png">
<link rel="icon" type="image/png" sizes="32x32" href="${FAVICON}">
<link rel="apple-touch-icon" href="/favicon-cupi.png">
<script type="application/ld+json">${ABOUT_STRUCTURED_DATA}</script>
<style>
${styles()}
</style>
</head>
<body>
<main id="seo-about" class="seo-public">
<h1>About the CUPI Wiki</h1>
<p class="seo-public__kicker">Cornell University Physical Intelligence</p>
<div class="login__about">
${ABOUT_PROSE}
</div>
<p class="seo-public__links"><a href="/">&larr; Wiki home</a> &middot; <a href="https://cornellphysicalintelligence.com/">cornellphysicalintelligence.com</a></p>
</main>
</body>
</html>`;
}

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
