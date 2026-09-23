// Local dev/test server: static client + the real API handler with the
// in-memory database. DEV_FAKE_AUTH=<email> skips OAuth for local testing.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import handler from './api/index.js';

const PORT = process.env.PORT || 4870;

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/') || ['/', '/index.html', '/context', '/llms.txt', '/llms-full.txt'].includes(path)) return handler(req, res);
  res.setHeader('content-type', 'text/html');
  res.end(readFileSync(new URL('public/wiki-shell.html', import.meta.url)));
}).listen(PORT, () => console.log(`CUPI wiki dev server → http://localhost:${PORT}  (auth: ${process.env.DEV_FAKE_AUTH || 'real OAuth'})`));
