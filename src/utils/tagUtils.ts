/** Strip characters illegal in Windows filenames. */
export function sanitizeExportFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim();
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

/** Keep only plain tags (no ***placeholder*** templates). */
export function filterBasicPresets(presets: string[]): string[] {
  return presets.filter(p => !/\*\*\*[^*]+\*\*\*/.test(p));
}
