// Search folding, shared by the page and the worker.
//
// Accent- and punctuation-insensitive, so "cancion" finds "canción". Chord
// brackets are stripped so a lyric search never matches chord letters. This is
// only ever used for substring comparison — a query is never compiled into a
// regular expression, so no input can throw or blow up.

export function fold(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
