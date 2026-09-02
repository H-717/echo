// Everything the app knows about songs. Reads never touch the network once the
// first sync has finished — that is what makes /1232 -> /1482 instant.

import { openDb, get, set, del } from './idb.js';
import { fold } from './fold.js';

export { fold };

export const slug = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export class Store {
  constructor(base = '') {
    this.base = base;
    this.db = null;
    this.index = null;      // columnar arrays from data/index.json
    this.folded = null;     // folded titles, parallel to index.titles
    this.books = null;
    this.byId = new Map();  // song id -> position in the index arrays
    this.refs = new Map();  // song id -> [[bookSlug, number], ...]
    this.listeners = new Set();
    this.syncState = { phase: 'idle', done: 0, total: 0 };
    this._searchToken = 0;
    this._pendingSearch = null;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { for (const fn of this.listeners) fn(ev); }

  // ---------------------------------------------------------------- boot

  async init() {
    this.db = await openDb();

    // The index is small and cached in IndexedDB, so repeat visits skip the
    // network entirely — including the very first paint of the song list.
    let index = await get(this.db, 'meta', 'index');
    let books = await get(this.db, 'meta', 'books');

    if (!index) {
      index = await fetch(`${this.base}data/index.json`).then((r) => r.json());
      await set(this.db, 'meta', 'index', index);
    }
    if (!books) {
      books = await fetch(`${this.base}data/books.json`).then((r) => r.json());
      await set(this.db, 'meta', 'books', books);
    }

    this.index = index;
    this.books = books;
    this.hydrate();
    this.startSync();
    return this;
  }

  /** Build the in-memory lookups that every read and search goes through. */
  hydrate() {
    const index = this.index;
    this.byId = new Map();
    this.refs = new Map();
    this.folded = index.titles.map(fold);
    for (let i = 0; i < index.ids.length; i++) this.byId.set(index.ids[i], i);

    // Sorting 9k titles with localeCompare on every keystroke is far too slow,
    // so the alphabetical order is computed once here and then just filtered.
    // Sort on the folded title, not the raw one: otherwise leading punctuation
    // (the Spanish "¡" and "¿") sorts ahead of every letter and those
    // titles all pile up at the top of the list instead of under their letter.
    const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
    this.alpha = index.titles.map((_, i) => i)
      .sort((a, b) => collator.compare(this.folded[a], this.folded[b]));

    for (const b of this.books) {
      for (const [songId, number] of Object.entries(b.songs)) {
        const id = Number(songId);
        if (!this.refs.has(id)) this.refs.set(id, []);
        this.refs.get(id).push([b.slug, String(number)]);
      }
    }
  }

  /**
   * The cached index is served instantly and offline, so a new build has to be
   * picked up afterwards rather than blocking the first paint on a check.
   */
  async refreshIndexIfStale() {
    try {
      const manifest = await this.manifest();
      const cachedAt = await get(this.db, 'meta', 'indexVersion');
      if (cachedAt === manifest.version) return;

      const [index, books] = await Promise.all([
        fetch(`${this.base}data/index.json`, { cache: 'no-store' }).then((r) => r.json()),
        fetch(`${this.base}data/books.json`, { cache: 'no-store' }).then((r) => r.json()),
      ]);
      await set(this.db, 'meta', 'index', index);
      await set(this.db, 'meta', 'books', books);
      await set(this.db, 'meta', 'indexVersion', manifest.version);

      this.index = index;
      this.books = books;
      this.hydrate();
      this.emit({ type: 'index' });
    } catch { /* offline: keep using what we have */ }
  }

  startSync() {
    const w = new Worker(`${this.base}sync-worker.js`, { type: 'module' });
    this.worker = w;
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'start') this.syncState = { phase: 'syncing', done: 0, total: m.total };
      else if (m.type === 'progress') this.syncState = { phase: 'syncing', done: m.done, total: m.total };
      else if (m.type === 'done') {
        this.syncState = { phase: 'ready', done: 0, total: 0, failed: m.failed || [] };
        this.refreshIndexIfStale();
      } else if (m.type === 'error') this.syncState = { phase: 'error', message: m.message };
      this.emit({ type: 'sync', state: this.syncState });
    };
    w.postMessage({ type: 'sync', base: this.base });
  }

  // ------------------------------------------------------------- lookup

  meta(id) {
    const i = this.byId.get(Number(id));
    if (i === undefined) return null;
    const x = this.index;
    return {
      id: x.ids[i],
      title: x.titles[i],
      lang: x.langCodes[x.langs[i]],
      key: x.keys[i],
      flat: !!x.flats[i],
      slug: slug(x.titles[i]),
      refs: this.refs.get(x.ids[i]) || [],
    };
  }

  /** Meta for a position in the index arrays (not a song id). */
  metaAt(i) { return this.meta(this.index.ids[i]); }

  bookName(slugName) {
    const b = this.books.find((x) => x.slug === slugName);
    return b ? b.name : slugName;
  }

  /** Lyrics for a song: the local edit if there is one, else the shipped body. */
  async lyrics(id) {
    id = Number(id);
    const local = await this.getLocal(id);
    if (local && local.lyrics) return { text: local.lyrics, edited: true };

    const row = await get(this.db, 'songs', id);
    if (row) return { text: row.y, edited: false };

    // Not synced yet — fetch just this song's shard so the page still works.
    const m = this.meta(id);
    if (!m) return null;
    const manifest = await this.manifest();
    for (const s of manifest.shards.filter((s) => s.lang === m.lang)) {
      const rows = await fetch(`${this.base}data/songs/${s.file}`).then((r) => r.json());
      const hit = rows.find((r) => r.i === id);
      if (hit) return { text: hit.y, edited: false };
    }
    return null;
  }

  async manifest() {
    if (!this._manifest) {
      this._manifest = await fetch(`${this.base}data/manifest.json`).then((r) => r.json());
    }
    return this._manifest;
  }

  // ------------------------------------------------------------- search

  /**
   * Title search over the in-memory index. Substring matching on folded text —
   * no regex is ever built from user input, so no query can throw or explode.
   * Ranked: whole-title match, then prefix, then word-start, then anywhere.
   */
  searchTitles(query, { langs = null } = {}) {
    const q = fold(query);
    if (!q) return this.browse({ langs });

    const x = this.index;
    const scored = [];
    for (let i = 0; i < this.folded.length; i++) {
      if (langs && !langs.has(x.langCodes[x.langs[i]])) continue;
      const t = this.folded[i];
      const at = t.indexOf(q);
      if (at === -1) continue;
      const rank = t === q ? 0 : at === 0 ? 1 : t[at - 1] === ' ' ? 2 : 3;
      scored.push([rank, at, t.length, i]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    return { hits: scored.map((r) => r[3]), total: scored.length };
  }

  browse({ langs = null } = {}) {
    const x = this.index;
    const hits = langs
      ? this.alpha.filter((i) => langs.has(x.langCodes[x.langs[i]]))
      : this.alpha;
    return { hits, total: hits.length };
  }

  /**
   * Full-text pass over synced bodies. This runs in the worker: scanning every
   * lyric is far too much work for the main thread and would stall typing.
   */
  searchLyrics(query, { langs = null, limit = 60, exclude = new Set() } = {}) {
    const q = fold(query);
    if (q.length < 3 || !this.worker) return Promise.resolve([]);

    return new Promise((resolve) => {
      const token = ++this._searchToken;
      this._pendingSearch = { token, resolve };
      this.worker.postMessage({
        type: 'search',
        token,
        q,
        limit,
        exclude: [...exclude],
      });
    });
  }

  /** Turn worker hits (id + snippet) into rows the list can render. */
  resolveHits(hits, langs) {
    const out = [];
    for (const h of hits) {
      const m = this.meta(h.id);
      if (!m || (langs && !langs.has(m.lang))) continue;
      out.push({ ...m, snippet: h.snippet });
    }
    return out;
  }

  snippet(raw, folded, at, len) {
    const from = Math.max(0, at - 34);
    const text = folded.slice(from, at + len + 46).trim();
    return (from > 0 ? '…' : '') + text + '…';
  }

  // -------------------------------------------------- per-device layer

  // Personal settings never leave the device and cost nothing to store.
  async getLocal(id) { return (await get(this.db, 'local', `song:${Number(id)}`)) || null; }

  async setLocal(id, patch) {
    const key = `song:${Number(id)}`;
    const cur = (await get(this.db, 'local', key)) || {};
    const next = { ...cur, ...patch };
    for (const k of Object.keys(next)) if (next[k] == null) delete next[k];
    if (!Object.keys(next).length) await del(this.db, 'local', key);
    else await set(this.db, 'local', key, next);
    return next;
  }

  async prefs() { return (await get(this.db, 'meta', 'prefs')) || {}; }
  async setPrefs(patch) {
    const next = { ...(await this.prefs()), ...patch };
    await set(this.db, 'meta', 'prefs', next);
    return next;
  }
}
