// Helpers for the pre-write confirm modal. The manifest itself is built in App
// directly from the produced `processedFiles` (each carries its section label
// and page count), so the list the user confirms is exactly what gets written —
// no parallel derivation that could drift from processAndSplitPDF.

export interface ManifestEntry {
  /** Human label for the modal: the tag, or "Master (ORG SCAN)". */
  section: string;
  /** Final relative path written to disk, e.g. "Letters.pdf" or "ORG SCAN/x.pdf". */
  fileName: string;
  pageCount: number;
  isMaster: boolean;
}

/** Lowercased filename -> entry indices sharing it; only groups of 2+ kept. */
export function detectCollisions(entries: ManifestEntry[]): Map<string, number[]> {
  const collisions = new Map<string, number[]>();
  entries.forEach((e, i) => {
    const key = e.fileName.toLowerCase();
    const arr = collisions.get(key);
    if (arr) arr.push(i);
    else collisions.set(key, [i]);
  });
  for (const [k, idxs] of collisions) if (idxs.length < 2) collisions.delete(k);
  return collisions;
}

/** Append " (n)" before the .pdf extension, preserving any folder prefix. */
export function suffixFileName(fileName: string, n: number): string {
  const slash = fileName.lastIndexOf('/');
  const dir = slash >= 0 ? fileName.slice(0, slash + 1) : '';
  const base = slash >= 0 ? fileName.slice(slash + 1) : fileName;
  const dot = base.toLowerCase().lastIndexOf('.pdf');
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  return `${dir}${stem} (${n}).pdf`;
}
