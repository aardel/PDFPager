/**
 * IndexedDB vault for the pristine bytes of each opened PDF. On first open a
 * file's original bytes are copied here (keyed by the session fileKey); the
 * "Restore original / start over" action reads them back to discard every
 * edit, tag, cover and insert and return the document untouched.
 *
 * This is the closest a sandboxed web app can get to the requested "hidden
 * folder holding the original": invisible to the user, persistent across
 * reloads, and recoverable on demand.
 */

import { openDb, txDone, ORIGINALS_STORE as STORE } from './idb';

interface OriginalRecord {
  fileKey: string;
  fileName: string;
  bytes: ArrayBuffer;
  savedAt: number;
}

/** Store the pristine original for `fileKey` if not already present. */
export async function saveOriginal(fileKey: string, fileName: string, bytes: ArrayBuffer): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    // Clone the buffer so a later detach/transfer of the caller's copy can't
    // corrupt the stored record.
    const rec: OriginalRecord = { fileKey, fileName, bytes: bytes.slice(0), savedAt: Date.now() };
    tx.objectStore(STORE).put(rec);
    await txDone(tx);
  } finally {
    db.close();
  }
}

/** True if a pristine original is already vaulted for this file. */
export async function hasOriginal(fileKey: string): Promise<boolean> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const key: any = await new Promise((resolve, reject) => {
      const req = tx.objectStore(STORE).getKey(fileKey);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return key !== undefined;
  } finally {
    db.close();
  }
}

/** Read back the pristine original bytes, or null if none vaulted. */
export async function loadOriginal(fileKey: string): Promise<{ bytes: ArrayBuffer; fileName: string } | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const rec: OriginalRecord | undefined = await new Promise((resolve, reject) => {
      const req = tx.objectStore(STORE).get(fileKey);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return rec && rec.bytes ? { bytes: rec.bytes, fileName: rec.fileName } : null;
  } finally {
    db.close();
  }
}

/** Drop a file's vaulted original (e.g. when its queue entry is removed). */
export async function deleteOriginal(fileKey: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(fileKey);
    await txDone(tx);
  } finally {
    db.close();
  }
}
