/**
 * Shared IndexedDB handle for PDFPager. A single database ("pdfpager") holds
 * every store so the app only ever opens one version — opening the same DB at
 * two different versions from different modules throws a VersionError.
 *
 *  v1: `covers`    — scanned cover / inserted-PDF bytes (see coverStore.ts)
 *  v2: `originals` — the pristine bytes of each opened file, for "restore
 *                    original / start over" (see originalStore.ts)
 *
 * Bumping DB_VERSION here and adding the store inside `onupgradeneeded` is the
 * only correct way to add a store: existing v1 databases upgrade in place,
 * keeping their covers.
 */

const DB_NAME = 'pdfpager';
const DB_VERSION = 2;

export const COVERS_STORE = 'covers';
export const ORIGINALS_STORE = 'originals';

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(COVERS_STORE)) {
        const store = db.createObjectStore(COVERS_STORE, { keyPath: 'coverId' });
        store.createIndex('fileKey', 'fileKey', { unique: false });
      }
      if (!db.objectStoreNames.contains(ORIGINALS_STORE)) {
        db.createObjectStore(ORIGINALS_STORE, { keyPath: 'fileKey' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
