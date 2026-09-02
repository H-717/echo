import { readFileSync, readdirSync } from 'node:fs';
import { parseBracket } from '../web/chords.js';
const counts = new Map();
let total = 0, chordy = 0, empty = 0;
for (const f of readdirSync('raw')) {
  if (!f.startsWith('lang_')) continue;
  for (const s of JSON.parse(readFileSync('raw/' + f, 'utf8')).songs) {
    for (const m of (s.lyrics || '').matchAll(/\[([^\]]*)\]/g)) {
      total++;
      const body = m[1];
      if (!body.trim()) { empty++; continue; }
      if (parseBracket(body)) { chordy++; continue; }
      counts.set(body, (counts.get(body) || 0) + 1);
    }
  }
}
const rest = [...counts].sort((a, b) => b[1] - a[1]);
console.log(`total brackets ${total} | valid chords ${chordy} | empty [] ${empty} | other ${total - chordy - empty} across ${rest.length} distinct`);
console.log('\ntop non-chord bracket contents:');
for (const [k, n] of rest.slice(0, 30)) console.log(`  ${String(n).padStart(5)}  ${JSON.stringify(k).slice(0, 70)}`);
