/**
 * "Cover and replace" text editing: covers an existing text run with a patch
 * and draws the replacement on top, rather than truly rewriting the PDF's
 * content-stream text objects. That's a deliberate choice, not a shortcut —
 * true in-place editing is unreliable across real-world PDFs: most PDFs
 * embed only the glyphs they actually use ("subsetted" fonts), so typing a
 * character the original font never needed has no glyph to render; and PDF
 * has no text reflow, so changing a run's length just overlaps or gaps
 * neighboring text either way. Cover-and-replace sidesteps both: pick any
 * font that has the glyphs you need, and only ever affects the exact box
 * you edited.
 *
 * Font matching: pdf.js's getTextContent() (used for hit-testing/position in
 * the editor UI) doesn't expose which PDF font RESOURCE a given run actually
 * used — only an internal pdf.js identifier with no public mapping back. So
 * rather than trying to pin down "the" original font per run, at bake time
 * this tries every font already embedded on that page (extracting TrueType
 * or OpenType-wrapped-CFF fonts directly from the PDF) and uses the first
 * one whose character set actually covers the typed replacement text. That's
 * both simpler and more robust than resource-key matching would be — it
 * naturally recovers when the "obvious" font is subsetted and missing a
 * glyph the edit needs, by trying the page's other embedded fonts instead.
 * Falls back to the closest of pdf-lib's 14 standard fonts (picked from the
 * edit's captured style hint) only if nothing on the page covers it.
 */
import {
  PDFDocument, PDFDict, PDFName, PDFStream, PDFRawStream, PDFFont, StandardFonts, rgb,
} from 'pdf-lib';
// @ts-ignore — no published types; the runtime default export is the fontkit instance pdf-lib expects.
import fontkit from '@pdf-lib/fontkit';
import { ProcessedPage, TextEdit } from './pdfProcessor';

const STANDARD_POST_VERSIONS = new Set([0x00010000, 0x00020000, 0x00025000, 0x00030000]);

/**
 * Some legacy Mac TrueType fonts (seen: classic "Osaka") ship a `post` table
 * version outside the four the OpenType spec defines, which fontkit doesn't
 * recognize — it fails internally trying to read italicAngle off a table it
 * couldn't parse. Overwriting it in place with a minimal, valid version-3.0
 * post table (same byte length, so no other table offset needs to move)
 * fixes embedding without touching anything the font actually needs post
 * data for (PostScript glyph names — irrelevant here).
 */
function sanitizeTrueTypePostTable(font: Uint8Array): Uint8Array {
  try {
    const buf = font.slice();
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const numTables = view.getUint16(4);
    for (let i = 0; i < numTables; i++) {
      const off = 12 + i * 16;
      const tag = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
      if (tag !== 'post') continue;
      const tableOffset = view.getUint32(off + 8);
      const tableLength = view.getUint32(off + 12);
      const version = view.getUint32(tableOffset);
      if (STANDARD_POST_VERSIONS.has(version)) return buf;
      view.setUint32(tableOffset, 0x00030000);
      buf.fill(0, tableOffset + 4, tableOffset + tableLength);
      return buf;
    }
    return buf;
  } catch {
    return font;
  }
}

async function inflateFlate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function maybeInflate(stream: PDFRawStream): Promise<Uint8Array> {
  const filter = stream.dict.get(PDFName.of('Filter'));
  const isFlate = filter?.toString() === '/FlateDecode';
  return isFlate ? inflateFlate(stream.contents) : stream.contents;
}

function lookupFontDescriptor(doc: PDFDocument, fontObj: PDFDict): PDFDict | null {
  const direct = fontObj.get(PDFName.of('FontDescriptor'));
  if (direct) return doc.context.lookup(direct, PDFDict);
  // Type0 composite fonts (CID-keyed) carry the descriptor on the descendant font.
  const descFontsRef = fontObj.get(PDFName.of('DescendantFonts'));
  if (!descFontsRef) return null;
  const descFonts = doc.context.lookup(descFontsRef) as any;
  const df = doc.context.lookup(descFonts.get(0), PDFDict);
  const descriptorRef = df.get(PDFName.of('FontDescriptor'));
  return descriptorRef ? doc.context.lookup(descriptorRef, PDFDict) : null;
}

async function extractEmbeddedFontBytes(doc: PDFDocument, fontObj: PDFDict): Promise<Uint8Array | null> {
  const fd = lookupFontDescriptor(doc, fontObj);
  if (!fd) return null;

  const ff2 = fd.get(PDFName.of('FontFile2'));
  if (ff2) {
    const stream = doc.context.lookup(ff2, PDFStream) as PDFRawStream;
    const bytes = await maybeInflate(stream);
    return sanitizeTrueTypePostTable(bytes);
  }

  const ff3 = fd.get(PDFName.of('FontFile3'));
  if (ff3) {
    const stream = doc.context.lookup(ff3, PDFStream) as PDFRawStream;
    const subtype = stream.dict.get(PDFName.of('Subtype'))?.toString();
    if (subtype === '/OpenType') return maybeInflate(stream);
    // Bare CFF (/Type1C, /CIDFontType0C) isn't directly embeddable via
    // pdf-lib — would need hand-building an sfnt wrapper. Skip.
    return null;
  }

  return null;
}

function pickStandardFont(styleHint: string | undefined): StandardFonts {
  const hint = (styleHint || '').toLowerCase();
  const bold = /bold/.test(hint);
  const italic = /italic|oblique/.test(hint);
  const monospace = /mono/.test(hint);
  const serif = /serif/.test(hint) && !/sans/.test(hint);
  if (monospace) {
    if (bold && italic) return StandardFonts.CourierBoldOblique;
    if (bold) return StandardFonts.CourierBold;
    if (italic) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }
  if (serif) {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic;
    if (bold) return StandardFonts.TimesRomanBold;
    if (italic) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }
  if (bold && italic) return StandardFonts.HelveticaBoldOblique;
  if (bold) return StandardFonts.HelveticaBold;
  if (italic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

interface PageFontCandidate {
  font: PDFFont;
  characterSet: Set<number>;
}

/** All directly-embeddable fonts already used on a page, keyed by page index
 * so repeated edits on the same page don't re-extract/re-embed repeatedly. */
async function getPageFontCandidates(
  doc: PDFDocument, page: ReturnType<PDFDocument['getPage']>, pageIndex: number,
  cache: Map<number, PageFontCandidate[]>,
): Promise<PageFontCandidate[]> {
  const cached = cache.get(pageIndex);
  if (cached) return cached;

  const candidates: PageFontCandidate[] = [];
  try {
    const resources = page.node.Resources();
    const fontDict = resources?.lookup(PDFName.of('Font'), PDFDict);
    if (fontDict) {
      for (const key of fontDict.keys()) {
        try {
          const ref = fontDict.get(key);
          const fontObj = doc.context.lookup(ref, PDFDict);
          const bytes = await extractEmbeddedFontBytes(doc, fontObj);
          if (!bytes) continue;
          const font = await doc.embedFont(bytes, { subset: true });
          candidates.push({ font, characterSet: new Set(font.getCharacterSet()) });
        } catch {
          // Unusable font (unsupported table format, malformed, etc.) — skip it.
        }
      }
    }
  } catch {
    // No resources / no fonts on this page — candidates stays empty, falls back below.
  }

  cache.set(pageIndex, candidates);
  return candidates;
}

function textCodePoints(text: string): number[] {
  return Array.from(text).map(ch => ch.codePointAt(0)!);
}

interface ResolvedFont { font: PDFFont; isExactMatch: boolean }

async function resolveFontForEdit(
  doc: PDFDocument, page: ReturnType<PDFDocument['getPage']>, pageIndex: number,
  edit: TextEdit, candidateCache: Map<number, PageFontCandidate[]>, fallbackCache: Map<string, PDFFont>,
): Promise<ResolvedFont> {
  const candidates = await getPageFontCandidates(doc, page, pageIndex, candidateCache);
  const needed = textCodePoints(edit.newText);
  for (const c of candidates) {
    if (needed.every(cp => c.characterSet.has(cp))) {
      return { font: c.font, isExactMatch: true };
    }
  }
  const std = pickStandardFont(edit.fontFamilyHint);
  let font = fallbackCache.get(std);
  if (!font) {
    font = await doc.embedFont(std);
    fallbackCache.set(std, font);
  }
  return { font, isExactMatch: false };
}

export interface BakeTextEditsResult {
  buffer: ArrayBuffer;
  /** True if every edit found a page font that truly covers its text — for
   * surfacing "used an approximate font" in the UI when false for any edit. */
  allExactMatches: boolean;
}

async function bakeOnce(arrayBuffer: ArrayBuffer, pages: ProcessedPage[], useExtractedFonts: boolean): Promise<BakeTextEditsResult> {
  const doc = await PDFDocument.load(arrayBuffer.slice(0), { ignoreEncryption: true });
  doc.registerFontkit(fontkit);
  const candidateCache = new Map<number, PageFontCandidate[]>();
  const fallbackCache = new Map<string, PDFFont>();
  let allExactMatches = true;

  for (const p of pages) {
    if (!p.textEdits?.length) continue;
    const page = doc.getPage(p.pageIndex);
    for (const edit of p.textEdits) {
      const { font, isExactMatch } = useExtractedFonts
        ? await resolveFontForEdit(doc, page, p.pageIndex, edit, candidateCache, fallbackCache)
        : { font: await (async () => {
            const std = pickStandardFont(edit.fontFamilyHint);
            let f = fallbackCache.get(std);
            if (!f) { f = await doc.embedFont(std); fallbackCache.set(std, f); }
            return f;
          })(), isExactMatch: false };
      if (!isExactMatch) allExactMatches = false;
      // Cover with generous padding for descenders/ascenders (pdf.js's item
      // height approximates the font bbox, not exact per-glyph extents).
      page.drawRectangle({
        x: edit.x - 1,
        y: edit.y - edit.height * 0.3,
        width: edit.width + 2,
        height: edit.height * 1.4,
        color: rgb(1, 1, 1),
      });
      page.drawText(edit.newText, {
        x: edit.x,
        y: edit.y,
        size: edit.fontSize,
        font,
        color: rgb(0, 0, 0),
      });
    }
  }

  const bytes = await doc.save();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return { buffer, allExactMatches };
}

export async function bakeTextEdits(arrayBuffer: ArrayBuffer, pages: ProcessedPage[]): Promise<BakeTextEditsResult> {
  const hasEdits = pages.some(p => p.textEdits && p.textEdits.length > 0);
  if (!hasEdits) return { buffer: arrayBuffer, allExactMatches: true };

  try {
    return await bakeOnce(arrayBuffer, pages, true);
  } catch (err) {
    // Embedding/subsetting a real-world font can fail in ways specific to
    // that exact font file (seen: a legacy Mac TrueType `post` table variant
    // fontkit's subset builder chokes on even after sanitizing the header —
    // rare, but export must never just break because of it). Retry once with
    // only pdf-lib's built-in standard fonts — no custom embedding at all —
    // so the edit always makes it into the export, just with a less exact
    // font match, rather than the whole export failing.
    console.error('bakeTextEdits: custom font embedding failed, retrying with standard fonts only:', err);
    return bakeOnce(arrayBuffer, pages, false);
  }
}

/** Stable id for a newly-created edit (not the pdf.js item index, which
 * isn't stable across re-renders — just needs to be unique within a page). */
export function makeTextEditId(): string {
  return `te_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export type { TextEdit };
