// Builds public/index.html — the whole client in one self-contained file.
// Runs as the Vercel buildCommand and locally via `npm run build`.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../src/client/${f}`, import.meta.url), 'utf8');
const font = (f) => readFileSync(new URL(`../src/client/${f}`, import.meta.url)).toString('base64');

const fonts = `@font-face{font-family:'Questrial';font-style:normal;font-weight:400;font-display:swap;src:url(data:font/woff2;base64,${font('questrial.woff2')}) format('woff2');}
@font-face{font-family:'Playfair Display';font-style:normal;font-weight:700;font-display:swap;src:url(data:font/woff2;base64,${font('playfair.woff2')}) format('woff2');}`;

const FAVICON = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#141414"/><text x="32" y="43" font-family="Georgia,serif" font-weight="700" font-size="30" fill="#fff" text-anchor="middle">CW</text></svg>`)}`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>CUPI Wiki</title>
<link rel="icon" href="${FAVICON}">
<style>
${fonts}
${read('styles.css')}
</style>
</head>
<body>
<div id="app"></div>
<script>
${read('data.js')}
${read('markdown.js')}
${read('store.js')}
${read('ui.js')}
${read('ui2.js')}
${read('ui3.js')}
${readFileSync(new URL('../src/remote.js', import.meta.url), 'utf8')}
${read('main.js')}
</script>
</body>
</html>`;

mkdirSync(new URL('../public', import.meta.url), { recursive: true });
writeFileSync(new URL('../public/index.html', import.meta.url), html);
console.log('public/index.html', html.length, 'bytes');
