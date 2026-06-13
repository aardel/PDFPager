/**
 * IndexedDB store for phone-scanned cover images, so covers survive closing
 * and reopening a file. localStorage can't hold them (JPEG bytes blow past
 * its ~5MB quota immediately); IndexedDB stores the ArrayBuffers natively.
 *
 * Each record: { coverId, fileKey, bytes, mime, savedAt }. The session
 * (localStorage) keeps the cover's position/tag and references it by
 * coverId; the bytes live here.
 */

const DB_NAME = 'pdfpager';
const STORE = 'covers';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'coverId' });
        store.createIndex('fileKey', 'fileKey', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function saveCoverImage(
  coverId: string,
  fileKey: string,
  bytes: ArrayBuffer,
  mime: string
): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ coverId, fileKey, bytes, mime, savedAt: Date.now() });
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function loadCoverImage(
  coverId: string
): Promise<{ bytes: ArrayBuffer; mime: string } | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const rec: any = await new Promise((resolve, reject) => {
      const req = tx.objectStore(STORE).get(coverId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return rec && rec.bytes ? { bytes: rec.bytes, mime: rec.mime || 'image/jpeg' } : null;
  } finally {
    db.close();
  }
}

/**
 * Delete this file's covers that the session no longer references —
 * called on file load, so discarded/stale covers don't accumulate.
 */
export async function pruneCoverImages(fileKey: string, keepIds: Set<string>): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const idx = tx.objectStore(STORE).index('fileKey');
    await new Promise<void>((resolve, reject) => {
      const req = idx.openCursor(IDBKeyRange.only(fileKey));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        if (!keepIds.has(cursor.value.coverId)) cursor.delete();
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
    await txDone(tx);
  } finally {
    db.close();
  }
}
