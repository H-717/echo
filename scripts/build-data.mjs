// Turns the raw per-language API dumps in raw/ into the static files the app ships.
//
//   data/manifest.json      versions + shard list
//   data/index.json         every song: id, title, lang, key, flags  (loads first)
//   data/books.json         all books with their song->number maps
//   data/songs/<lang>.<n>.json   song bodies, chunked
//
// No server is involved at runtime; these are plain files on a CDN.

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { detectKey, prefersFlats, extractChords } from '../web/chords.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'raw');
const OUT = join(ROOT, 'data');

const CHUNK = 400; // songs per shard

const slug = (s) => s.toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// ---------------------------------------------------------------- load

const langs = JSON.parse(readFileSync(join(RAW, 'languages.json'), 'utf8')).languages;

const songs = [];
const books = [];
const seen = new Set();

for (const f of readdirSync(RAW)) {
  if (!f.startsWith('lang_')) continue;
  const d = JSON.parse(readFileSync(join(RAW, f), 'utf8'));
  for (const s of d.songs) {
    if (seen.has(s.id)) continue;   // ids are globally unique; guard anyway
    seen.add(s.id);
    songs.push(s);
  }
  for (const b of d.books) books.push(b);
}

songs.sort((a, b) => a.id - b.id);
console.log(`loaded ${songs.length} songs, ${books.length} books, ${langs.length} languages`);

// ------------------------------------------------------- book back-refs

// book.songs is { songId: hymnNumber }. Invert it so a song knows its books.
const refsBySong = new Map();
for (const b of books) {
  for (const [songId, number] of Object.entries(b.songs)) {
    const id = Number(songId);
    if (!refsBySong.has(id)) refsBySong.set(id, []);
    refsBySong.get(id).push([b.slug, String(number)]);
  }
}

// -------------------------------------------------------------- build

// The index loads before anything else, so it is stored columnar: parallel
// arrays instead of 9k repeated object keys. Slugs are derived at runtime and
// book references live in books.json, so neither is duplicated here.
const langCodes = [...new Set(songs.map((s) => s.lang))];
const idx = { ids: [], titles: [], langs: [], keys: [], flats: [] };

const bodiesByLang = new Map();
let withChords = 0;

for (const s of songs) {
  const title = (s.title || '').trim();
  const lyrics = s.lyrics || '';
  const chords = extractChords(lyrics);
  if (chords.length) withChords++;

  idx.ids.push(s.id);
  idx.titles.push(title);
  idx.langs.push(langCodes.indexOf(s.lang));
  idx.keys.push(chords.length ? detectKey(lyrics) : null);
  idx.flats.push(prefersFlats(lyrics) ? 1 : 0);

  if (!bodiesByLang.has(s.lang)) bodiesByLang.set(s.lang, []);
  bodiesByLang.get(s.lang).push({ i: s.id, y: lyrics });
}

const index = { langCodes, ...idx };

// -------------------------------------------------------------- write

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'songs'), { recursive: true });

const write = (rel, obj) => {
  const json = JSON.stringify(obj);
  writeFileSync(join(OUT, rel), json);
  return { bytes: Buffer.byteLength(json), gz: gzipSync(json, { level: 9 }).length };
};

const shards = [];
let bodyBytes = 0, bodyGz = 0;

for (const [lang, list] of [...bodiesByLang].sort((a, b) => b[1].length - a[1].length)) {
  // Non-Latin language names slug to nothing, so every shard is prefixed with
  // the language's index. Without it 한국어, 繁體中文 and العربية all collide on
  // the same filename and silently overwrite one another.
  const tag = `${langCodes.indexOf(lang)}-${slug(lang) || 'x'}`;
  for (let n = 0; n * CHUNK < list.length; n++) {
    const part = list.slice(n * CHUNK, (n + 1) * CHUNK);
    const name = `${tag}.${n}.json`;
    const { bytes, gz } = write(join('songs', name), part);
    shards.push({ lang, file: name, count: part.length, gz });
    bodyBytes += bytes; bodyGz += gz;
  }
}

const idxw = write('index.json', index);
const bks = write('books.json', books.map((b) => ({
  id: b.id, slug: b.slug, name: b.name, lang: b.lang || null, songs: b.songs,
})));

// Every song must be reachable in exactly one shard. A filename collision or a
// dropped language would otherwise only show up as songs quietly missing.
const files = new Set(shards.map((s) => s.file));
if (files.size !== shards.length) {
  throw new Error(`shard filename collision: ${shards.length} shards, ${files.size} distinct files`);
}
const sharded = shards.reduce((a, s) => a + s.count, 0);
if (sharded !== songs.length) {
  throw new Error(`shards cover ${sharded} songs but the corpus has ${songs.length}`);
}

const counts = {};
for (const [lang, list] of bodiesByLang) counts[lang] = list.length;

// Content-derived, not date-derived: rebuilding twice in one day has to
// invalidate the clients that already synced the earlier build.
const version = createHash('sha256')
  .update(JSON.stringify(shards))
  .update(String(songs.length))
  .digest('hex')
  .slice(0, 12);

const manifest = {
  version,
  songCount: songs.length,
  bookCount: books.length,
  languages: langs.filter((l) => counts[l]),
  counts,
  shards,
};
const man = write('manifest.json', manifest);

// -------------------------------------------------------------- report

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(`
  songs with chords   ${withChords} (${Math.round(100 * withChords / songs.length)}%)
  keys detected       ${index.keys.filter(Boolean).length}

  index.json          ${kb(idxw.bytes)}  ->  ${kb(idxw.gz)} gz   (loads first)
  books.json          ${kb(bks.bytes)}  ->  ${kb(bks.gz)} gz
  manifest.json       ${kb(man.bytes)}  ->  ${kb(man.gz)} gz
  ${shards.length} body shards       ${kb(bodyBytes)}  ->  ${kb(bodyGz)} gz  (streams in behind)
`);
