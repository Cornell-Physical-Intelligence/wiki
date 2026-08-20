// Shared assembly for all three targets: the Vercel client (public/), the
// GitHub Pages preview (docs/), and the artifact fragment. One source of
// truth so the builds can't drift.
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../src/client/${f}`, import.meta.url), 'utf8');
const b64 = (f) => readFileSync(new URL(`../src/client/${f}`, import.meta.url)).toString('base64');

export const FAVICON = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#141414"/><text x="32" y="43" font-family="Georgia,serif" font-weight="700" font-size="30" fill="#fff" text-anchor="middle">CW</text></svg>`)}`;

export function styles() {
  return `@font-face{font-family:'Playfair Display';font-style:normal;font-weight:700;font-display:swap;src:url(data:font/woff2;base64,${b64('playfair.woff2')}) format('woff2');}
${read('styles.css')}`;
}

// Binary assets are injected ahead of the app code as constants.
export function scripts({ remote = false } = {}) {
  const assets = `'use strict';
const CUPI_LOGO = 'data:image/png;base64,${b64('cupi-logo-192.png')}';
const CRAB_URI = 'data:image/webp;base64,${b64('crab-380.webp')}';`;
  return [
    assets,
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

export function fullPage({ remote }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>CUPI Wiki</title>
<link rel="icon" href="${FAVICON}">
<style>
${styles()}
</style>
</head>
<body>
<div id="app"></div>
<script>
${scripts({ remote })}
</script>
</body>
</html>`;
}
