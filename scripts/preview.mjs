// Serves dist/ the way GitHub Pages does, so a subpath deploy can be checked
// before it is pushed: files under /<base>/, and 404.html (with the URL left
// intact) for anything that isn't a file.
//
//   node scripts/build-site.mjs --base songbase
//   node scripts/preview.mjs --base songbase     -> http://localhost:4174/songbase/

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 4174);

const arg = process.argv.indexOf('--base');
let base = arg > -1 ? process.argv[arg + 1] : '/';
if (!base.startsWith('/')) base = '/' + base;
if (!base.endsWith('/')) base += '/';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (!url.pathname.startsWith(base)) {
    res.writeHead(302, { Location: base });
    res.end();
    return;
  }

  // normalize('') is '.', which would resolve to the directory, not the page.
  let rel = normalize(url.pathname.slice(base.length)).replace(/^([/\\])+/, '');
  if (rel === '' || rel === '.') rel = 'index.html';
  const target = join(DIST, rel);

  let file = null;
  if (target.startsWith(DIST)) {
    try { if ((await stat(target)).isFile()) file = target; } catch { /* not a file */ }
  }

  // Pages serves 404.html for unknown paths, keeping the requested URL.
  const notFound = !file;
  if (notFound) file = join(DIST, '404.html');

  const body = await readFile(file);
  res.writeHead(notFound ? 404 : 200, {
    'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
    'Content-Length': body.length,
  });
  res.end(body);
}).listen(PORT, () => {
  console.log(`preview -> http://localhost:${PORT}${base}`);
});
