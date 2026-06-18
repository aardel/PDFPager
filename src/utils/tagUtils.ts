/** Strip characters illegal in Windows filenames. */
export function sanitizeExportFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}

/** Characters that can't appear in a Windows/macOS filename. Tags and export
 *  names become filenames, so we block these at input time (typing them is
 *  simply ignored) — that way a tag maps 1:1 to a valid filename and two tags
 *  can't collapse onto the same name via sanitisation (e.g. "A/B" vs "A:B"). */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001F]/g;

/** Remove filename-illegal characters from typed input (keeps spaces/casing). */
export function stripUnsafeFileNameChars(name: string): string {
  return name.replace(UNSAFE_FILENAME_CHARS, '');
}

/** Return the export filename base (no .pdf) for a tag group. */
export function getExportFileName(tag: string, exportNames: Record<string, string>): string {
  const custom = exportNames[tag]?.trim();
  return sanitizeExportFileName(custom || tag);
}

/** True when the user has set a custom export name that differs from the tag. */
export function isExportNameModified(tag: string, exportNames: Record<string, string>): boolean {
  const custom = exportNames[tag]?.trim();
  if (!custom) return false;
  return custom.toLowerCase() !== tag.trim().toLowerCase();
}

/** A tag made up entirely of digits, e.g. "030218" or "030". */
export function isNumericTag(tag: string): boolean {
  return /^\d+$/.test(tag.trim());
}

/** Numeric tags greater than 999 (dates, long IDs like "030218") are noise:
 *  never saved as a preset or learned as an autocomplete word. Numeric tags
 *  <= 999 stay usable as section tags but are hidden from the right-click
 *  suggestions (see callers in Workspace). */
export function isIgnoredTag(tag: string): boolean {
  const t = tag.trim();
  return /^\d+$/.test(t) && parseInt(t, 10) > 999;
}

/** Keep only plain tags (no ***placeholder*** templates), dropping noisy
 *  numeric tags (> 999) — also used to clean already-saved presets. */
export function filterBasicPresets(presets: string[]): string[] {
  return presets.filter(p => !/\*\*\*[^*]+\*\*\*/.test(p) && !isIgnoredTag(p));
}

/** Unique tags assigned to non-deleted pages, in first-seen document order. */
export function collectUsedTags(
  pages: { isDeleted?: boolean; tag?: string }[]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of pages) {
    if (p.isDeleted || !p.tag?.trim()) continue;
    const t = p.tag.trim();
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}
