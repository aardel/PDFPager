// Server-side sync for the tag store (presets + learned words), so they follow
// the single user across browsers, devices, and the three pdfpager domains.
//
// localStorage stays the offline cache and source-of-truth-while-running; this
// module fetches the server copy on load and pushes a debounced snapshot on
// every local change. The server is only authoritative at load time — see
// App.tsx's reconciliation. Electron (no backend / no token) degrades to a
// no-op, leaving the existing localStorage behaviour untouched.

import { getToken } from './auth';

type WordEntry = { w: string; n: number };
export type TagBundle = { presets: string[]; words: WordEntry[] };

/** GET the server copy, or null if there is no token / it is unreachable. */
export async function fetchTags(): Promise<TagBundle | null> {
  const token = getToken();
  if (!token) return null;
  try {
    const r = await fetch('/api/tags', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j || !j.success) return null;
    return {
      presets: Array.isArray(j.presets) ? j.presets : [],
      words: Array.isArray(j.words) ? j.words : [],
    };
  } catch {
    return null; // offline → keep using localStorage
  }
}

// Pushes are gated until load-time reconciliation finishes, so the boot-time
// seed can't clobber an existing server store before we've read it.
let ready = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let pending: TagBundle | null = null;

export function markSyncReady(): void {
  ready = true;
}

export function scheduleSaveTags(bundle: TagBundle): void {
  if (!ready) return;
  pending = bundle;
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, 800);
}

async function flush(): Promise<void> {
  timer = undefined;
  const body = pending;
  pending = null;
  const token = getToken();
  if (!token || !body) return;
  try {
    await fetch('/api/tags', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    /* offline — localStorage already holds the change; next edit retries */
  }
}
