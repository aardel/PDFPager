// Web (Chrome/Edge) File System Access helpers.
//
// In the hosted browser build there is no Electron `savePDFs` IPC, but Chromium
// browsers expose the File System Access API, which lets the user pick a folder
// once and have the split PDFs written straight into it — mirroring the desktop
// app. Safari/Firefox don't support this; callers fall back to per-file
// downloads when `supportsFileSystemAccess()` returns false.

type WritableFile = { fileName: string; data: Uint8Array };

// Module-scoped so the chosen folder is shared between the "choose folder"
// button (Workspace) and the export action (App) for the lifetime of the tab.
// The handle is intentionally not persisted: browsers require it to be
// re-granted on each new session via a user gesture.
let dirHandle: any = null;

export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export function supportsSaveFilePicker(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

// Remembered single-file save targets for the session, keyed by the active
// file. Lets "save" overwrite the same file silently after the first pick.
const saveHandles = new Map<string, any>();

export function hasSaveTarget(key: string): boolean {
  return saveHandles.has(key);
}
export function forgetSaveTarget(key: string): void {
  saveHandles.delete(key);
}

async function ensureRW(handle: any): Promise<boolean> {
  try {
    if ((await handle.queryPermission?.({ mode: 'readwrite' })) === 'granted') return true;
    if ((await handle.requestPermission?.({ mode: 'readwrite' })) === 'granted') return true;
  } catch { /* needs a user gesture — treat as denied */ }
  return false;
}

/**
 * Save one PDF via the native Save As picker. Reuses the remembered target for
 * `key` (silent overwrite); `forcePick` ignores it (Save As… to a new name).
 * Returns 'saved' | 'cancelled' | 'unsupported'.
 */
export async function saveSinglePdf(
  key: string, data: Uint8Array, suggestedName: string, forcePick = false,
): Promise<'saved' | 'cancelled' | 'unsupported'> {
  if (!supportsSaveFilePicker()) return 'unsupported';
  let handle = forcePick ? null : saveHandles.get(key);
  if (!handle) {
    try {
      handle = await (window as any).showSaveFilePicker({
        suggestedName,
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') return 'cancelled';
      throw err;
    }
  }
  if (!(await ensureRW(handle))) return 'cancelled';
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
  saveHandles.set(key, handle);
  return 'saved';
}

export function hasOutputDirectory(): boolean {
  return !!dirHandle;
}

export function getOutputDirectoryName(): string {
  return dirHandle?.name || '';
}

async function ensurePermission(handle: any): Promise<boolean> {
  const opts = { mode: 'readwrite' };
  try {
    if ((await handle.queryPermission?.(opts)) === 'granted') return true;
    if ((await handle.requestPermission?.(opts)) === 'granted') return true;
  } catch {
    // Permission APIs throw if invoked outside a user gesture — treat as denied.
  }
  return false;
}

// Prompts for a destination folder. Returns the folder name, or null if the
// user cancelled (or the API is unsupported).
export async function pickOutputDirectory(): Promise<string | null> {
  if (!supportsFileSystemAccess()) return null;
  try {
    const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
    if (!handle) return null;
    dirHandle = handle;
    return handle.name as string;
  } catch (err: any) {
    if (err && err.name === 'AbortError') return null; // user dismissed picker
    throw err;
  }
}

// Writes each file into the previously chosen folder. A fileName may
// contain "/" path segments (e.g. "org scan/file.pdf") — intermediate
// subfolders are created as needed.
export async function writeFilesToDirectory(
  files: WritableFile[],
  onProgress?: (done: number, total: number, fileName: string) => void
): Promise<void> {
  if (!dirHandle) throw new Error('No output folder selected.');
  if (!(await ensurePermission(dirHandle))) {
    throw new Error('Permission to write to the selected folder was denied.');
  }
  let done = 0;
  for (const file of files) {
    onProgress?.(done++, files.length, file.fileName);
    const parts = file.fileName.split('/').filter(Boolean);
    const name = parts.pop()!;
    let dir = dirHandle;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: true });
    }
    const fileHandle = await dir.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(file.data);
    await writable.close();
  }
}
