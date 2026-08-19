// Local dev/test server: static client + the real API handler with the
// in-memory database. DEV_FAKE_AUTH=<email> skips OAuth for local testing.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import handler from './api/index.js';

const PORT = process.env.PORT || 4870;

createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) return handler(req, res);
  res.setHeader('content-type', 'text/html');
  res.end(readFileSync(new URL('public/index.html', import.meta.url)));
}).listen(PORT, () => console.log(`CUPI wiki dev server → http://localhost:${PORT}  (auth: ${process.env.DEV_FAKE_AUTH || 'real OAuth'})`));
