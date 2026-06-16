// Frequency store of individual WORDS used in tags (not whole tag strings),
// powering the tag popup's inline autocomplete. Every committed tag is split
// into words whose counts are bumped; typing a prefix suggests the most-used
// word that starts with it.

const KEY = 'pdf_pager_word_freq';

type Entry = { w: string; n: number };       // w = display word (preserves case), n = count
type Store = Record<string, Entry>;           // keyed by lowercase word

function load(): Store {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') as Store; } catch { return {}; }
}

// Local edits notify subscribers (App) so the change can be pushed to the
// server-side tag store. `silent` skips the notification for writes that came
// FROM the server (importWords), so loading can't bounce straight back up.
const listeners = new Set<() => void>();
export function onWordsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function save(s: Store, silent = false): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* quota — non-fatal */ }
  if (!silent) for (const fn of listeners) fn();
}

// Words worth remembering: drop 1-char noise; keep the original casing.
function tokenize(text: string): string[] {
  return text.split(/\s+/).map(w => w.trim()).filter(w => w.length >= 2);
}

/** Record the words of a committed tag, bumping their frequencies. */
export function recordTagWords(tag: string | undefined): void {
  if (!tag) return;
  const s = load();
  for (const w of tokenize(tag)) {
    const k = w.toLowerCase();
    if (s[k]) { s[k].n++; s[k].w = w; }
    else s[k] = { w, n: 1 };
  }
  save(s);
}

/** Seed words from existing tags/presets (count 1) so suggestions work from
 *  the first use. Only adds words not already known. */
export function seedWords(tags: string[]): void {
  const s = load();
  let changed = false;
  for (const tag of tags) {
    for (const w of tokenize(tag)) {
      const k = w.toLowerCase();
      if (!s[k]) { s[k] = { w, n: 1 }; changed = true; }
    }
  }
  if (changed) save(s);
}

/** Most-used stored word starting with `prefix` (excluding an exact match),
 *  or null. Ties break toward the shorter word. */
export function suggestCompletion(prefix: string): string | null {
  const p = prefix.trim().toLowerCase();
  if (!p) return null;
  const s = load();
  let best: Entry | null = null;
  for (const k in s) {
    if (k === p || !k.startsWith(p)) continue;
    const e = s[k];
    if (!best || e.n > best.n || (e.n === best.n && e.w.length < best.w.length)) best = e;
  }
  return best ? best.w : null;
}

/** All stored words, most-used first. */
export function listWords(): Entry[] {
  const s = load();
  return Object.values(s).sort((a, b) => b.n - a.n || a.w.localeCompare(b.w));
}

/** Add a word to the store (or bump its count if it already exists). */
export function addWord(word: string): boolean {
  const w = word.trim();
  if (w.length < 2 || /\s/.test(w)) return false;
  const s = load();
  const k = w.toLowerCase();
  if (s[k]) { s[k].n++; s[k].w = w; }
  else s[k] = { w, n: 1 };
  save(s);
  return true;
}

/** Remove a word from the store. */
export function removeWord(word: string): void {
  const s = load();
  delete s[word.trim().toLowerCase()];
  save(s);
}

/** Snapshot every stored word for syncing up to the server. */
export function exportWords(): Entry[] {
  return Object.values(load());
}

/** Replace the local store with the server's copy (no change notification). */
export function importWords(entries: Entry[]): void {
  const s: Store = {};
  for (const e of entries) {
    if (e && typeof e.w === 'string' && Number.isFinite(e.n)) {
      const w = e.w.trim();
      if (w.length >= 2) s[w.toLowerCase()] = { w, n: e.n };
    }
  }
  save(s, true);
}
