import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument, degrees } from 'pdf-lib';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { getExportFileName } from './tagUtils';

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export interface ProcessedPage {
  id: number;          // Unique ID
  pageIndex: number;   // 0-indexed page in original PDF
  isDeleted: boolean;  // Marked for deletion
  isBlank: boolean;    // Auto-detected blank
  tag?: string;        // Target filename prefix tag (e.g., 'docs', 'pops')
  rotation: number;    // Rotation in degrees (0, 90, 180, 270)
}

/**
 * Loads a PDF from an ArrayBuffer safely by cloning the buffer.
 */
export async function getPdfPageCount(arrayBuffer: ArrayBuffer): Promise<number> {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer.slice(0)) });
  const pdf = await loadingTask.promise;
  return pdf.numPages;
}

/**
 * Centralized loader to load the PDF document once.
 */
export async function loadPdfDocument(arrayBuffer: ArrayBuffer): Promise<any> {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer.slice(0)) });
  return loadingTask.promise;
}

/**
 * Renders a specific page of a pre-loaded PDF onto a canvas.
 */
export async function renderPageToCanvas(
  pdfDoc: any,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  scale = 0.3
): Promise<void> {
  const page = await pdfDoc.getPage(pageIndex + 1); // PDF.js pages are 1-indexed

  const viewport = page.getViewport({ scale });
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('Could not get 2D canvas context');
  }

  canvas.height = viewport.height;
  canvas.width = viewport.width;

  await page.render({
    canvasContext: context,
    viewport: viewport
  }).promise;
}

/**
 * Detects if a page canvas is blank.
 * To handle scanned pages, we crop the outer 5% margin (where feed/binder shadows exist)
 * and analyze if the remaining pixels are above a brightness threshold.
 * 
 * @param canvas The canvas element containing the rendered page
 * @param tolerance Brightness limit (0-255, where 255 is pure white). Default 240.
 * @param blankRatio Minimum percentage of near-white pixels to classify as blank. Default 99%.
 */
export function detectIfPageIsBlank(
  canvas: HTMLCanvasElement,
  tolerance = 242,
  blankRatio = 0.992
): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  const width = canvas.width;
  const height = canvas.height;

  // Ignore 5% padding around the edges
  const insetX = Math.floor(width * 0.05);
  const insetY = Math.floor(height * 0.05);
  const scanWidth = width - (insetX * 2);
  const scanHeight = height - (insetY * 2);

  if (scanWidth <= 0 || scanHeight <= 0) return false;

  const imageData = ctx.getImageData(insetX, insetY, scanWidth, scanHeight);
  const data = imageData.data;
  let nearWhitePixels = 0;
  const totalPixels = scanWidth * scanHeight;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    
    // Grayscale brightness (Luma formula)
    const brightness = 0.299 * r + 0.587 * g + 0.114 * b;

    if (brightness >= tolerance) {
      nearWhitePixels++;
    }
  }

  const whitePercent = nearWhitePixels / totalPixels;
  return whitePercent >= blankRatio;
}

/**
 * Splices the original PDF and creates separate binary PDFs for each group.
 * Skips pages marked as deleted.
 */
export async function processAndSplitPDF(
  arrayBuffer: ArrayBuffer,
  pages: ProcessedPage[],
  exportNames: Record<string, string> = {},
  targetTag?: string
): Promise<{ fileName: string; data: Uint8Array }[]> {
  const srcDoc = await PDFDocument.load(arrayBuffer);
  const results: { fileName: string; data: Uint8Array }[] = [];

  // Filter active pages with valid tags
  const taggedPages = pages.filter(p => 
    !p.isDeleted && 
    p.tag && 
    p.tag.trim() !== '' &&
    (!targetTag || p.tag.trim().toLowerCase() === targetTag.trim().toLowerCase())
  );

  // Identify unique tags in original sequence order (preserve casing from first occurrence)
  const uniqueTags: string[] = [];
  for (const page of taggedPages) {
    const tag = page.tag!.trim();
    if (!uniqueTags.some(t => t.toLowerCase() === tag.toLowerCase())) {
      uniqueTags.push(tag);
    }
  }

  for (const tag of uniqueTags) {
    const pagesForTag = taggedPages.filter(p => p.tag!.trim().toLowerCase() === tag.toLowerCase());
    const activePageIndices = pagesForTag.map(p => p.pageIndex);

    // Create a new PDF document
    const newDoc = await PDFDocument.create();

    // Copy pages
    const copiedPages = await newDoc.copyPages(srcDoc, activePageIndices);
    
    // Append pages and apply the user rotation angles
    copiedPages.forEach((page, idx) => {
      const pageInfo = pagesForTag[idx];
      if (pageInfo && pageInfo.rotation) {
        const currentRotation = page.getRotation().angle;
        const newRotation = (currentRotation + pageInfo.rotation) % 360;
        page.setRotation(degrees(newRotation));
      }
      newDoc.addPage(page);
    });

    // Serialize to bytes
    const pdfBytes = await newDoc.save();
    const fileName = `${getExportFileName(tag, exportNames)}.pdf`;

    results.push({
      fileName,
      data: pdfBytes
    });
  }

  return results;
}
