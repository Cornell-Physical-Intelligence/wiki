// Builds public/index.html — the Vercel (multi-user) client.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fullPage } from './assemble.mjs';

const html = fullPage({ remote: true });
mkdirSync(new URL('../public', import.meta.url), { recursive: true });
writeFileSync(new URL('../public/index.html', import.meta.url), html);
console.log('public/index.html', html.length, 'bytes');
