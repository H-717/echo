// A ~1KB promise wrapper over IndexedDB. Shared by the page and the sync worker,
// so both talk to the same schema without pulling in a library.

export const DB_NAME = 'songbase';
export const DB_VERSION = 1;

/** Stores: songs (bodies), meta (sync state + index), local (per-device edits). */
export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'i' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('local')) db.createObjectStore('local');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const done = (tx) => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onabort = tx.onerror = () => rej(tx.error);
});

export function get(db, store, key) {
  return new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export function getAll(db, store) {
  return new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function set(db, store, key, value) {
  const tx = db.transaction(store, 'readwrite');
  // meta/local are out-of-line keyed; songs uses an inline keyPath.
  if (key === undefined) tx.objectStore(store).put(value);
  else tx.objectStore(store).put(value, key);
  return done(tx);
}

export async function del(db, store, key) {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
}

/**
 * Write many records in bounded batches. Each batch is its own transaction so
 * the event loop gets a turn between them — this is what keeps a 9k-song sync
 * from locking the UI, even though the worker runs off the main thread anyway.
 */
export async function bulkPut(db, store, records, batch = 250) {
  for (let i = 0; i < records.length; i += batch) {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const rec of records.slice(i, i + batch)) os.put(rec);
    await done(tx);
  }
}
