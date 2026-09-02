// Chord chart layout.
//
// The whole point of a chord chart is that the chord stays above the syllable it
// belongs to, at every window width. So a line is never laid out as "a row of
// chords above a row of words" — that construction breaks the moment the line
// wraps. Instead each *word* becomes one unwrappable inline-block carrying its
// own chords, and the browser wraps between words. A chord can therefore never
// be separated from the syllable underneath it.

import { parseLine, groupToString } from './chords.js';

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Resolve one ChordPro line into an indent, plus words that each own their chords.
 * Returns { indent, hasChord, words } where a word is { text, pieces }.
 */
export function layoutLine(line) {
  const { segments, hasChord } = parseLine(line);

  // Flatten to plain text plus chord anchors at character offsets.
  let plain = '';
  const anchors = [];
  for (const seg of segments) {
    if (seg.chord) anchors.push({ chord: seg.chord, at: plain.length });
    plain += seg.text;
  }

  const indent = /^[ \t]*/.exec(plain)[0].length;

  if (!hasChord) return { indent, hasChord: false, words: null, text: plain.trim() };

  // A chord written just before a space belongs to the word after it.
  for (const a of anchors) {
    while (a.at < plain.length && /\s/.test(plain[a.at])) a.at++;
  }

  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(plain))) {
    const start = m.index, end = start + m[0].length;
    const here = anchors.filter((a) => a.at >= start && a.at < end).sort((x, y) => x.at - y.at);

    // Split the word at each chord position; the chunk before the first chord
    // (if any) carries no chord of its own.
    const pieces = [];
    let cursor = start;
    if (!here.length || here[0].at > start) {
      const stop = here.length ? here[0].at : end;
      pieces.push({ chord: null, text: plain.slice(cursor, stop) });
      cursor = stop;
    }
    for (let i = 0; i < here.length; i++) {
      const stop = i + 1 < here.length ? here[i + 1].at : end;
      pieces.push({ chord: here[i].chord, text: plain.slice(cursor, stop) });
      cursor = stop;
    }
    words.push({ pieces });
  }

  // Chords that land past the last character (a change on the final beat).
  const trailing = anchors.filter((a) => a.at >= plain.length);
  for (const a of trailing) words.push({ pieces: [{ chord: a.chord, text: '' }] });

  return { indent, hasChord: true, words, text: plain.trim() };
}

/** One line of HTML. `steps` transposes, `flat` picks the accidental spelling. */
function lineHtml(line, steps, flat, showChords) {
  const L = layoutLine(line);
  const pad = L.indent ? ` style="padding-left:${(L.indent * 0.55).toFixed(2)}em"` : '';

  if (!L.hasChord || !showChords) {
    const text = L.hasChord ? L.text : L.text;
    if (!text) return '<div class="ln blank"></div>';
    return `<div class="ln"${pad}>${esc(text)}</div>`;
  }

  const words = L.words.map((w) => {
    const pieces = w.pieces.map((p) => {
      const name = p.chord
        ? esc(groupToString(p.chord, steps, flat ? 'flat' : 'sharp'))
        : '';
      // Every piece carries a chord slot, so text baselines stay aligned
      // whether or not that particular piece has a chord over it.
      return `<span class="pc"><span class="cd">${name}</span><span class="tx">${esc(p.text)}</span></span>`;
    }).join('');
    return `<span class="wd">${pieces}</span>`;
  }).join(' ');

  return `<div class="ln chorded"${pad}>${words}</div>`;
}

/**
 * Render a full lyric body.
 * Stanzas separated by blank lines; indented stanzas read as refrains and are
 * left unnumbered, matching how these songbooks have always been set.
 */
export function renderSong(lyrics, { steps = 0, flat = false, showChords = true } = {}) {
  const stanzas = (lyrics || '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
  let verseNo = 0;
  const out = [];

  for (const stanza of stanzas) {
    let lines = stanza.split('\n').filter((l, i, a) => l.trim() || (i > 0 && i < a.length - 1));
    if (!lines.length) continue;

    // 86% of these songs write the verse number on its own line. Where the
    // author numbered a verse, that number is the label — don't print it twice
    // and don't renumber it. Only unnumbered verses get counted automatically.
    let label = null;
    const firstIdx = lines.findIndex((l) => l.trim());
    const m = firstIdx >= 0 && /^\(?(\d{1,2})[.):]?$/.exec(lines[firstIdx].trim());
    if (m) {
      label = m[1];
      verseNo = Number(m[1]);
      lines = lines.filter((_, i) => i !== firstIdx);
    }
    if (!lines.some((l) => l.trim())) continue;

    const isRefrain = lines.every((l) => !l.trim() || /^[ \t]{2,}/.test(l));
    if (label === null) label = isRefrain ? '' : String(++verseNo);

    const body = lines.map((l) => lineHtml(l, steps, flat, showChords)).join('');
    out.push(
      `<div class="st${isRefrain ? ' refrain' : ''}">` +
      `<div class="no">${label}</div><div class="bd">${body}</div></div>`
    );
  }
  return out.join('');
}
