// Assembles the deployable site into dist/.
//
//   node scripts/build-site.mjs                 -> served from a domain root
//   node scripts/build-site.mjs --base /songbase/   -> served from a subpath
//
// GitHub Pages project sites live under /<repo>/, so the base path is stamped
// into <base href> and every asset reference is relative to it. That way the
// same source works from a root domain and from a project subpath.

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const DATA = join(ROOT, 'data');
const DIST = join(ROOT, 'dist');

const arg = process.argv.indexOf('--base');
let base = arg > -1 ? process.argv[arg + 1] : (process.env.SITE_BASE || '/');
if (!base.startsWith('/')) base = '/' + base;
if (!base.endsWith('/')) base += '/';

if (!existsSync(DATA)) {
  console.error('data/ is missing — run: node scripts/build-data.mjs');
  process.exit(1);
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

cpSync(WEB, DIST, { recursive: true });
cpSync(DATA, join(DIST, 'data'), { recursive: true });

// Stamp the base path.
const indexPath = join(DIST, 'index.html');
let html = readFileSync(indexPath, 'utf8');
html = html.replace(/<base href="[^"]*">/, `<base href="${base}">`);
writeFileSync(indexPath, html);

// GitHub Pages has no rewrite rules: an unknown path serves 404.html with the
// URL left intact. Shipping the app as 404.html is what makes a deep link like
// /1482/amazing-grace load instead of showing a Not Found page.
writeFileSync(join(DIST, '404.html'), html);

// Keep Pages from running the files through Jekyll.
writeFileSync(join(DIST, '.nojekyll'), '');

// Tie the service worker cache to the data build so a deploy invalidates it.
const { version } = JSON.parse(readFileSync(join(DATA, 'manifest.json'), 'utf8'));
const swPath = join(DIST, 'sw.js');
writeFileSync(swPath, readFileSync(swPath, 'utf8').replace(
  /const VERSION = '[^']*';/, `const VERSION = 'sb-${version}';`
));

// The manifest's start_url and scope have to match where the site actually is.
const manPath = join(DIST, 'manifest.webmanifest');
const man = JSON.parse(readFileSync(manPath, 'utf8'));
man.start_url = base;
man.scope = base;
writeFileSync(manPath, JSON.stringify(man, null, 2));

console.log(`dist/ built for base "${base}" (data version ${version})`);
