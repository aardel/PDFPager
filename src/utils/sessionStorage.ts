import { ProcessedPage } from './pdfProcessor';

const SESSION_PREFIX = 'pdf_pager_session_';

export interface StoredSession {
  fileKey: string;
  fileName: string;
  pageCount: number;
  pages: ProcessedPage[];
  exportNames: Record<string, string>;
  savedAt: number;
}

/** Stable key from file metadata (no need to hash the full PDF). */
export function getFileKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function storageKey(fileKey: string): string {
  return SESSION_PREFIX + btoa(encodeURIComponent(fileKey)).replace(/=/g, '');
}

export function loadSession(fileKey: string, pageCount: number): StoredSession | null {
  try {
    const raw = localStorage.getItem(storageKey(fileKey));
    if (!raw) return null;
    const session: StoredSession = JSON.parse(raw);
    if (session.fileKey !== fileKey || session.pageCount !== pageCount) return null;
    if (!Array.isArray(session.pages) || session.pages.length !== pageCount) return null;
    return session;
  } catch {
    return null;
  }
}

export function saveSession(
  fileKey: string,
  fileName: string,
  pages: ProcessedPage[],
  exportNames: Record<string, string>
): void {
  const session: StoredSession = {
    fileKey,
    fileName,
    pageCount: pages.length,
    pages,
    exportNames,
    savedAt: Date.now(),
  };
  try {
    localStorage.setItem(storageKey(fileKey), JSON.stringify(session));
  } catch {
    // localStorage full — fail silently; in-memory state still works
  }
}

export function deleteSession(fileKey: string): void {
  localStorage.removeItem(storageKey(fileKey));
}
