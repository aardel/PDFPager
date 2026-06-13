export type ScanFilter = 'original' | 'enhance' | 'gray' | 'bw';

export const SCAN_FILTER_LABELS: Record<ScanFilter, string> = {
  original: 'Original',
  enhance: 'Enhance',
  gray: 'Grayscale',
  bw: 'B&W',
};

function loadImage(bytes: ArrayBuffer, mime: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode the image')); };
    img.src = url;
  });
}

/**
 * Auto-contrast / white-balance: stretch each channel so its 1st–99th
 * percentile spans the full range. Photographed paper under home lighting
 * comes out grey-beige; this pulls the paper back to white per channel,
 * which also corrects the color cast.
 */
function enhance(d: Uint8ClampedArray) {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < d.length; i += 4) {
    hist[0][d[i]]++; hist[1][d[i + 1]]++; hist[2][d[i + 2]]++;
  }
  const n = d.length / 4;
  const lo = [0, 0, 0], hi = [255, 255, 255];
  for (let c = 0; c < 3; c++) {
    const cut = n * 0.01;
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[c][v]; if (acc > cut) { lo[c] = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[c][v]; if (acc > cut) { hi[c] = v; break; } }
    if (hi[c] - lo[c] < 10) { lo[c] = 0; hi[c] = 255; } // near-flat channel: leave alone
  }
  const scale = [255 / (hi[0] - lo[0]), 255 / (hi[1] - lo[1]), 255 / (hi[2] - lo[2])];
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.max(0, Math.min(255, (d[i] - lo[0]) * scale[0]));
    d[i + 1] = Math.max(0, Math.min(255, (d[i + 1] - lo[1]) * scale[1]));
    d[i + 2] = Math.max(0, Math.min(255, (d[i + 2] - lo[2]) * scale[2]));
  }
}

function toGray(d: Uint8ClampedArray): Uint8Array {
  const g = new Uint8Array(d.length / 4);
  for (let i = 0; i < d.length; i += 4) {
    g[i >> 2] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
  }
  return g;
}

function grayscale(d: Uint8ClampedArray) {
  const g = toGray(d);
  // Mild contrast stretch on the luma so the result reads "scanned", not washed out.
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  const cut = g.length * 0.01;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > cut) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > cut) { hi = v; break; } }
  if (hi - lo < 10) { lo = 0; hi = 255; }
  const k = 255 / (hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const y = Math.max(0, Math.min(255, (g[i >> 2] - lo) * k));
    d[i] = d[i + 1] = d[i + 2] = y;
  }
}

/**
 * Bradley adaptive threshold: each pixel is compared against the mean of a
 * window around it (window = width/8), so text stays crisp even when the
 * lighting falls off across the page — a global threshold can't do that.
 */
function blackWhite(d: Uint8ClampedArray, w: number, h: number) {
  const g = toGray(d);
  // Summed-area table with a 1-pixel border of zeros.
  const iw = w + 1;
  const integral = new Float64Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += g[y * w + x];
      integral[(y + 1) * iw + (x + 1)] = integral[y * iw + (x + 1)] + rowSum;
    }
  }
  const s = Math.max(16, (w / 8) | 0);
  const half = s >> 1;
  const t = 0.15;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(w - 1, x + half);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = integral[(y1 + 1) * iw + (x1 + 1)] - integral[y0 * iw + (x1 + 1)]
                - integral[(y1 + 1) * iw + x0] + integral[y0 * iw + x0];
      const v = g[y * w + x] * count < sum * (1 - t) ? 0 : 255;
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
}

/**
 * Apply a scan filter to image bytes; always starts from the bytes given
 * (filters never compound). Returns re-encoded JPEG.
 */
export async function applyScanFilter(
  bytes: ArrayBuffer,
  mime: string,
  filter: ScanFilter
): Promise<{ bytes: ArrayBuffer; mime: string; blob: Blob }> {
  const img = await loadImage(bytes, mime);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);

  if (filter === 'enhance') enhance(id.data);
  else if (filter === 'gray') grayscale(id.data);
  else if (filter === 'bw') blackWhite(id.data, canvas.width, canvas.height);

  ctx.putImageData(id, 0, 0);
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not encode the image'))), 'image/jpeg', 0.92)
  );
  return { bytes: await blob.arrayBuffer(), mime: 'image/jpeg', blob };
}
