// Dev server. Mirrors what production should do: long-lived caching for the
// data build, SPA fallback for deep links, gzip where we have it.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const PORT = Number(process.env.PORT || 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

const cache = new Map();

async function resolve(pathname) {
  // data/ is served from the build output, everything else from web/
  // normalize() yields backslashes on Windows, so compare on a slashed copy.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const base = rel.replace(/\\/g, '/').startsWith('data/') ? ROOT : WEB;
  const file = join(base, rel);
  if (!file.startsWith(ROOT)) return null;
  try {
    const s = await stat(file);
    if (s.isFile()) return file;
  } catch { /* fall through */ }
  return null;
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = await resolve(url.pathname === '/' ? '/index.html' : url.pathname);

  // Anything that looks like a file must 404 rather than fall through to the
  // SPA shell. Serving index.html as app.css is how a deep link silently loses
  // its stylesheet, and how a broken shard becomes unparseable HTML.
  if (!file && (url.pathname.startsWith('/data/') || /\.[a-z0-9]{2,5}$/i.test(url.pathname))) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }

  // Deep links (/1482/amazing-grace) are app routes.
  if (!file) file = join(WEB, 'index.html');

  const ext = extname(file);
  const type = TYPES[ext] || 'application/octet-stream';

  // Keyed on mtime so editing a file during development actually shows up.
  const mtime = (await stat(file)).mtimeMs;
  let entry = cache.get(file);
  if (!entry || entry.mtime !== mtime) {
    const buf = await readFile(file);
    entry = { mtime, buf, gz: gzipSync(buf, { level: 6 }) };
    cache.set(file, entry);
  }

  const wantsGz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = wantsGz ? entry.gz : entry.buf;

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    ...(wantsGz ? { 'Content-Encoding': 'gzip' } : {}),
    'Vary': 'Accept-Encoding',
    // Shards are immutable for a given build. manifest.json is the pointer to
    // which build is current, so it must never be cached that way.
    'Cache-Control': url.pathname.startsWith('/data/songs/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}).listen(PORT, () => {
  console.log(`songbase dev  ->  http://localhost:${PORT}`);
});
