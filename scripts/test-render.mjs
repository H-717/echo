import { layoutLine, renderSong } from '../web/render.js';
import { groupToString } from '../web/chords.js';

const show = (line) => {
  const L = layoutLine(line);
  if (!L.hasChord) return console.log(`  [no chords] indent=${L.indent} "${L.text}"`);
  const parts = L.words.map(w =>
    w.pieces.map(p => (p.chord ? `{${groupToString(p.chord)}}` : '') + p.text).join('')
  );
  console.log(`  indent=${L.indent} | ` + parts.join(' · '));
};

console.log('--- chord mid-word must not split the word ---');
show('Won[G]derful grace of [C]Jesus');
console.log('--- chord before a space belongs to the next word ---');
show('Amazing [G] grace how [C]sweet');
console.log('--- chord at end of line ---');
show('the sound[G]');
console.log('--- indented refrain ---');
show('  [D7]Since Jesus came into my heart!');
console.log('--- empty [] and non-chords dropped, text kept ---');
show('Left foot[] and [Repeat] right [A7]foot');
console.log('--- slash chord ---');
show('[G/B]Praise [D7sus4]Him');
console.log('--- compound chord groups must survive ---');
show('[C-C/B-Am]Praise [G D]the [(A)]Lord [-D7]now');
console.log('--- real words in brackets are kept as text ---');
show('Left foot[] and [Repeat] right [A7]foot');
