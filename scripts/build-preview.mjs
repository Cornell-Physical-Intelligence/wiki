// Builds docs/index.html (GitHub Pages preview: whole app, browser-local mode)
// and dist/artifact.html (the same app as a Claude artifact fragment).
import { writeFileSync, mkdirSync } from 'node:fs';
import { fullPage, styles, scripts } from './assemble.mjs';

mkdirSync(new URL('../docs', import.meta.url), { recursive: true });
const page = fullPage({ remote: false });
writeFileSync(new URL('../docs/index.html', import.meta.url), page);
console.log('docs/index.html', page.length, 'bytes');

// Artifact hosting wraps the file in its own document skeleton — emit a fragment.
mkdirSync(new URL('../dist', import.meta.url), { recursive: true });
const fragment = `<title>CUPI Wiki</title>
<style>
${styles()}
</style>
<div id="app"></div>
<script>
${scripts({ remote: false })}
</script>
`;
writeFileSync(new URL('../dist/artifact.html', import.meta.url), fragment);
console.log('dist/artifact.html', fragment.length, 'bytes');
