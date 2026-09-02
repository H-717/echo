// Chord theory + ChordPro parsing. Shared by the build script and the web app.

export const SHARP_KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_KEYS  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

const PITCH = {
  'C': 0, 'B#': 0,
  'C#': 1, 'Db': 1,
  'D': 2,
  'D#': 3, 'Eb': 3,
  'E': 4, 'Fb': 4,
  'F': 5, 'E#': 5,
  'F#': 6, 'Gb': 6,
  'G': 7,
  'G#': 8, 'Ab': 8,
  'A': 9,
  'A#': 10, 'Bb': 10,
  'B': 11, 'Cb': 11,
};

// root + quality/extension + optional bass note
const CHORD_RE = /^([A-G](?:#|b)?)([^/\s]*)(?:\/([A-G](?:#|b)?))?$/;

/** Parse a bracket body into a chord, or null if it isn't one. */
export function parseChord(text) {
  let t = (text || '').trim();
  if (!t) return null;
  // A few hundred brackets in the corpus are written lowercase ("g", "am").
  // Only retry short tokens, so words are still rejected below.
  if (t.length <= 3 && /^[a-g]/.test(t)) t = t[0].toUpperCase() + t.slice(1);
  const m = CHORD_RE.exec(t);
  if (!m) return null;
  const [, root, suffix, bass] = m;
  if (PITCH[root] === undefined) return null;
  if (bass && PITCH[bass] === undefined) return null;
  // Reject things like "Ebenezer" that start like a chord but are words.
  if (suffix && /^[a-z]{3,}$/.test(suffix) && !KNOWN_SUFFIX.has(suffix)) return null;
  return { root, suffix: suffix || '', bass: bass || null };
}

const KNOWN_SUFFIX = new Set([
  'm', 'maj', 'min', 'dim', 'aug', 'sus', 'sus2', 'sus4', 'add9', 'add11',
  'maj7', 'maj9', 'min7', 'm7', 'm9', 'm11', 'm6', 'mmaj7', 'dim7', 'aug7', 'halfdim',
]);

export function chordToString(c) {
  return c.root + c.suffix + (c.bass ? '/' + c.bass : '');
}

/**
 * A bracket may hold more than one chord: the corpus uses "C-C/B-Am", "G D",
 * "(G)" and "-D7" to mean a run of changes over a single syllable. Parse the
 * whole bracket into an ordered list of chords and the literal glue between
 * them, so every chord still transposes and nothing is dropped.
 *
 * Returns null when the bracket holds no chord at all.
 */
export function parseBracket(body) {
  const raw = (body || '').trim();
  if (!raw) return null;

  const tokens = [];
  let found = 0;
  // Split on runs of separators, keeping them so the label reads as written.
  for (const part of raw.split(/(\s*[-–—]\s*|\s+|[()])/)) {
    if (part === '' || part === undefined) continue;
    const c = parseChord(part);
    if (c) { tokens.push({ chord: c }); found++; }
    else if (/^(\s*[-–—]\s*|\s+|[()])$/.test(part)) tokens.push({ lit: part });
    else return null;   // real words in the bracket: not a chord group
  }
  return found ? { tokens } : null;
}

/** Render a bracket group back to text, transposing every chord in it. */
export function groupToString(group, steps = 0, prefer = 'sharp') {
  return group.tokens
    .map((t) => (t.chord ? chordToString(transposeChord(t.chord, steps, prefer)) : t.lit))
    .join('');
}

/** Every chord inside a bracket group. */
export function groupChords(group) {
  return group.tokens.filter((t) => t.chord).map((t) => t.chord);
}

/** Transpose a parsed chord by `steps` semitones. `prefer` is 'sharp' | 'flat'. */
export function transposeChord(c, steps, prefer = 'sharp') {
  if (!steps) return c;
  const table = prefer === 'flat' ? FLAT_KEYS : SHARP_KEYS;
  const shift = (n) => table[(((PITCH[n] + steps) % 12) + 12) % 12];
  return { root: shift(c.root), suffix: c.suffix, bass: c.bass ? shift(c.bass) : null };
}

export function transposeKey(key, steps, prefer = 'sharp') {
  const c = parseChord(key);
  if (!c) return key;
  return chordToString(transposeChord(c, steps, prefer));
}

/**
 * Split one ChordPro line into segments.
 * Returns { segments: [{chord, text}], hasChord } where each segment's chord
 * sits directly above the first character of its text.
 */
export function parseLine(line) {
  const segments = [];
  let hasChord = false;
  let i = 0, pendingChord = null, buf = '';

  while (i < line.length) {
    const ch = line[i];
    if (ch === '[') {
      const close = line.indexOf(']', i);
      if (close === -1) { buf += line.slice(i); break; }
      const body = line.slice(i + 1, close);
      const group = parseBracket(body);
      // "[]" and "[-]" are spacing markers, not content: drop them silently.
      if (!group && /[\p{L}\p{N}]/u.test(body)) {
        // Not chords and not an empty marker — keep the author's text verbatim.
        buf += line.slice(i, close + 1);
        i = close + 1;
        continue;
      }
      // Flush what we have; a chord always starts a new segment.
      if (buf || pendingChord) segments.push({ chord: pendingChord, text: buf });
      buf = '';
      pendingChord = group;          // empty [] markers drop out here
      if (group) hasChord = true;
      i = close + 1;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf || pendingChord) segments.push({ chord: pendingChord, text: buf });
  if (!segments.length) segments.push({ chord: null, text: '' });
  return { segments, hasChord };
}

/** All chords in a lyric body, in order. */
export function extractChords(lyrics) {
  const out = [];
  for (const line of (lyrics || '').split('\n')) {
    for (const seg of parseLine(line).segments) {
      if (seg.chord) out.push(...groupChords(seg.chord));
    }
  }
  return out;
}

/**
 * Guess the key. The tonic is usually the first and last chord of a song;
 * frequency breaks the tie. Returns null when the song has no chords.
 */
export function detectKey(lyrics) {
  const chords = extractChords(lyrics);
  if (!chords.length) return null;

  const score = new Map();
  const bump = (c, n) => {
    const name = c.root + (c.suffix.startsWith('m') && !c.suffix.startsWith('maj') ? 'm' : '');
    score.set(name, (score.get(name) || 0) + n);
  };
  for (const c of chords) bump(c, 1);
  bump(chords[0], chords.length * 0.35);
  bump(chords[chords.length - 1], chords.length * 0.5);

  let best = null, bestN = -1;
  for (const [name, n] of score) if (n > bestN) { best = name; bestN = n; }
  return best;
}

/** Does this lyric body use flats more than sharps? Drives accidental spelling. */
export function prefersFlats(lyrics) {
  let sharps = 0, flats = 0;
  for (const c of extractChords(lyrics)) {
    if (c.root.includes('#')) sharps++;
    if (c.root.includes('b')) flats++;
  }
  return flats > sharps;
}
