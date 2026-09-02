// Downloads song bodies into IndexedDB, off the main thread.
//
// The old site parsed 3.4MB of JSON and wrote 3,266 rows in one transaction on
// the main thread, freezing the tab for tens of seconds. Here the fetch, the
// parse and the write all happen in a worker, one shard at a time, so the page
// stays responsive and songs become readable as they land.

import { openDb, get, set, bulkPut } from './idb.js';
import { fold } from './fold.js';

const post = (type, data) => self.postMessage({ type, ...data });

let db;

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'sync') await sync(msg.base || '');
    else if (msg.type === 'search') await search(msg);
  } catch (err) {
    post('error', { message: String(err && err.message || err) });
  }
};

/**
 * Scan every stored lyric for a folded substring.
 *
 * A cursor is used rather than getAll so the 9MB of bodies is never held in
 * memory at once, and the walk stops as soon as enough matches are found.
 * Running here rather than on the page is what keeps typing responsive.
 */
async function search({ token, q, limit, exclude }) {
  if (!db) db = await openDb();
  const skip = new Set(exclude || []);
  const hits = [];

  await new Promise((resolve, reject) => {
    const req = db.transaction('songs').objectStore('songs').openCursor();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur || hits.length >= limit) return resolve();
      const row = cur.value;
      if (!skip.has(row.i)) {
        const folded = fold(row.y);
        const at = folded.indexOf(q);
        if (at !== -1) hits.push({ id: row.i, snippet: snippet(folded, at, q.length) });
      }
      cur.continue();
    };
  });

  post('results', { token, hits });
}

function snippet(folded, at, len) {
  const from = Math.max(0, at - 34);
  const text = folded.slice(from, at + len + 46).trim();
  return (from > 0 ? '…' : '') + text + '…';
}

async function sync(base) {
  db = await openDb();

  const manifest = await getJson(`${base}data/manifest.json`);
  const have = (await get(db, 'meta', 'syncedShards')) || {};
  const version = await get(db, 'meta', 'version');

  // A new build invalidates every shard.
  const stale = version !== manifest.version;
  const shards = manifest.shards.filter((s) => stale || have[s.file] !== s.count);

  if (!shards.length) {
    post('done', { songCount: manifest.songCount, fresh: true });
    return;
  }

  post('start', { total: shards.length });

  const synced = stale ? {} : have;
  let n = 0;

  const failed = [];

  for (const shard of shards) {
    try {
      const rows = await getJson(`${base}data/songs/${shard.file}`);
      await bulkPut(db, 'songs', rows);
      synced[shard.file] = shard.count;
    } catch (err) {
      // One bad shard must not abandon the other 35.
      failed.push(shard.file);
    }
    n++;
    // Checkpoint as we go: an interrupted sync resumes instead of restarting.
    await set(db, 'meta', 'syncedShards', synced);
    post('progress', { done: n, total: shards.length, lang: shard.lang });
  }

  if (!failed.length) await set(db, 'meta', 'version', manifest.version);
  post('done', { songCount: manifest.songCount, fresh: false, failed });
}

/** Fetch JSON, treating a non-200 as an error instead of parsing the response. */
async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}
