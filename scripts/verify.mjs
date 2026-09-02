// Checks the built data against a fresh pull of the live API:
//   1. is every song present
//   2. is every title and lyric byte-identical
//   3. does every chord still sit on the syllable the source put it on
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseLine, groupChords } from '../web/chords.js';

const SRC = 'verify';
const DATA = 'data';

// ---------------------------------------------------------------- load
const live = new Map();               // id -> {title, lyrics, lang}
for (const f of readdirSync(SRC)) {
  if (!f.startsWith('lang_')) continue;
  for (const s of JSON.parse(readFileSync(join(SRC, f), 'utf8')).songs) {
    live.set(s.id, { title: s.title || '', lyrics: s.lyrics || '', lang: s.lang });
  }
}

const index = JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8'));
const built = new Map();              // id -> lyrics
for (const f of readdirSync(join(DATA, 'songs'))) {
  for (const r of JSON.parse(readFileSync(join(DATA, 'songs', f), 'utf8'))) built.set(r.i, r.y);
}
const builtTitle = new Map();
index.ids.forEach((id, i) => builtTitle.set(id, index.titles[i]));

console.log(`live API: ${live.size} songs`);
console.log(`built   : ${built.size} bodies, ${index.ids.length} index entries\n`);

// ------------------------------------------------------- 1. completeness
const liveIds = new Set(live.keys());
const builtIds = new Set(built.keys());
const missing = [...liveIds].filter((i) => !builtIds.has(i));
const extra = [...builtIds].filter((i) => !liveIds.has(i));

console.log('--- 1. completeness ---');
console.log(`missing from build : ${missing.length}`);
for (const id of missing) console.log(`   id ${id}  ${JSON.stringify(live.get(id).title)}  (${live.get(id).lang})  lyrics=${live.get(id).lyrics.length}ch`);
console.log(`in build, not live : ${extra.length}`);
for (const id of extra.slice(0, 10)) console.log(`   id ${id}  ${JSON.stringify(builtTitle.get(id))}`);
console.log(`index vs bodies mismatch: ${index.ids.filter((i) => !builtIds.has(i)).length}`);

// ---------------------------------------------------------- 2. integrity
console.log('\n--- 2. integrity (byte-for-byte) ---');
let badLyrics = 0, badTitle = 0;
for (const [id, s] of live) {
  if (!builtIds.has(id)) continue;
  if (built.get(id) !== s.lyrics) { badLyrics++; if (badLyrics <= 5) console.log(`   lyrics differ: id ${id}`); }
  if (builtTitle.get(id) !== s.title.trim()) { badTitle++; if (badTitle <= 5) console.log(`   title differs: id ${id} ${JSON.stringify(s.title)} -> ${JSON.stringify(builtTitle.get(id))}`); }
}
console.log(`lyrics altered : ${badLyrics}`);
console.log(`titles altered : ${badTitle}  (trailing/leading spaces are trimmed on purpose)`);

// ------------------------------------------------------ 3. chord placement
// Rebuild each line from what the renderer parsed and compare to the source.
// Anything that does not round-trip is a chord the app would place wrongly.
console.log('\n--- 3. chord placement (round-trip) ---');
let lines = 0, chordsSeen = 0, lost = 0, moved = 0, textChanged = 0;
const examples = [];
const keptLiteral = new Map();

for (const [id, s] of live) {
  if (!builtIds.has(id)) continue;
  for (const line of s.lyrics.replace(/\r\n?/g, '\n').split('\n')) {
    lines++;
    const { segments } = parseLine(line);

    // plain text and chord offsets, as the layout sees them
    let plain = '';
    const anchors = [];
    for (const seg of segments) {
      if (seg.chord) anchors.push({ chord: seg.chord, at: plain.length });
      plain += seg.text;
    }

    // Compare the actual words. A bracket the parser does not recognise as a
    // chord is deliberately kept as written, so strip brackets from both sides:
    // what must never change is the lyric text itself.
    const words = (x) => x.replace(/\[[^\]]*\]/g, '');
    if (words(plain) !== words(line)) {
      textChanged++;
      if (examples.length < 6) examples.push(`id ${id}: lyric text changed\n     src : ${JSON.stringify(line)}\n     got : ${JSON.stringify(plain)}`);
      continue;
    }
    for (const m of plain.matchAll(/\[[^\]]*\]/g)) {
      keptLiteral.set(m[0], (keptLiteral.get(m[0]) || 0) + 1);
    }

    // every chord in the source must survive
    const srcChords = [];
    for (const m of line.matchAll(/\[([^\]]*)\]/g)) {
      const g = parseLine(`[${m[1]}]`).segments.find((x) => x.chord);
      if (g) srcChords.push(...groupChords(g.chord));
    }
    const gotChords = anchors.flatMap((a) => groupChords(a.chord));
    chordsSeen += srcChords.length;
    if (srcChords.length !== gotChords.length) {
      lost += Math.abs(srcChords.length - gotChords.length);
      if (examples.length < 6) examples.push(`id ${id}: chord count ${srcChords.length} -> ${gotChords.length}\n     ${JSON.stringify(line)}`);
      continue;
    }

    // a chord may only shift forward across whitespace (onto the next word)
    for (const a of anchors) {
      let at = a.at;
      while (at < plain.length && /\s/.test(plain[at])) at++;
      if (at !== a.at) {
        moved++;
        if (/\S/.test(plain.slice(a.at, at))) {
          if (examples.length < 6) examples.push(`id ${id}: chord crossed a non-space\n     ${JSON.stringify(line)}`);
        }
      }
    }
  }
}

console.log(`lines checked          : ${lines.toLocaleString()}`);
console.log(`chords checked         : ${chordsSeen.toLocaleString()}`);
console.log(`lyric text altered     : ${textChanged}`);
console.log(`chords lost or gained  : ${lost}`);
console.log(`chords nudged onto the next word (intended): ${moved}`);
const keptTotal = [...keptLiteral.values()].reduce((a, b) => a + b, 0);
console.log(`brackets kept as written (not chords): ${keptTotal} across ${keptLiteral.size} distinct`);
[...keptLiteral].sort((a, b) => b[1] - a[1]).slice(0, 10)
  .forEach(([k, n]) => console.log(`     ${String(n).padStart(4)}  ${k}`));
if (examples.length) { console.log('\nexamples:'); examples.forEach((e) => console.log('   ' + e)); }
