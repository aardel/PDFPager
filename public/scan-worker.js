/* PDFPager scan worker.
 *
 * OpenCV's ~9MB WASM compile froze the UI thread for tens of seconds on
 * budget Androids (buttons visible but unresponsive). Everything OpenCV —
 * compile, contour detection, perspective warp — runs in this worker;
 * the page only ships small ImageData frames back and forth.
 *
 * Messages in:
 *   { type: 'detect',  id, image: ImageData }
 *   { type: 'flatten', id, image: ImageData, corners: [TL,TR,BR,BL], outW, outH }
 * Messages out:
 *   { type: 'ready' } | { type: 'error', message }
 *   { type: 'result', id, corners | image }
 */
'use strict';

let scanner = null;

try {
  importScripts('/vendor/opencv.js');
} catch (e) {
  self.postMessage({ type: 'error', message: 'opencv.js failed to load' });
}

function whenCvReady(cb) {
  if (typeof cv === 'undefined') {
    self.postMessage({ type: 'error', message: 'cv global missing' });
    return;
  }
  if (typeof cv.then === 'function') {
    cv.then((mod) => { self.cv = mod; cb(); });
  } else if (cv.Mat) {
    cb();
  } else {
    cv.onRuntimeInitialized = cb;
  }
}

whenCvReady(() => {
  try {
    importScripts('/vendor/jscanify.min.js');
    scanner = new self.jscanify();
    self.postMessage({ type: 'ready' });
  } catch (e) {
    self.postMessage({ type: 'error', message: 'jscanify init: ' + e.message });
  }
});

// Contour detection → [TL,TR,BR,BL] or null. Rejects degenerate quads
// (shoelace area < 8% of the frame).
function detect(image) {
  let img = null, contour = null;
  try {
    img = cv.matFromImageData(image);
    contour = scanner.findPaperContour(img);
    if (!contour) return null;
    const p = scanner.getCornerPoints(contour);
    if (!p || !p.topLeftCorner || !p.topRightCorner || !p.bottomRightCorner || !p.bottomLeftCorner) return null;
    const quad = [p.topLeftCorner, p.topRightCorner, p.bottomRightCorner, p.bottomLeftCorner];
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const a = quad[i], b = quad[(i + 1) % 4];
      area += a.x * b.y - b.x * a.y;
    }
    if (Math.abs(area) / 2 < image.width * image.height * 0.08) return null;
    return quad.map(c => ({ x: c.x, y: c.y }));
  } catch {
    return null;
  } finally {
    if (img) img.delete();
    if (contour) contour.delete();
  }
}

// True homography flatten → ImageData(outW × outH) or null.
function flatten(image, corners, outW, outH) {
  let src = null, dst = null, srcTri = null, dstTri = null, M = null;
  try {
    src = cv.matFromImageData(image);
    dst = new cv.Mat();
    const [c0, c1, c2, c3] = corners;
    srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [c0.x, c0.y, c1.x, c1.y, c2.x, c2.y, c3.x, c3.y]);
    dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
    M = cv.getPerspectiveTransform(srcTri, dstTri);
    cv.warpPerspective(src, dst, M, new cv.Size(outW, outH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
    return new ImageData(new Uint8ClampedArray(dst.data), dst.cols, dst.rows);
  } catch {
    return null;
  } finally {
    [src, dst, srcTri, dstTri, M].forEach(m => { try { if (m) m.delete(); } catch {} });
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (!scanner) {
    self.postMessage({ type: 'result', id: m.id, corners: null, image: null });
    return;
  }
  if (m.type === 'detect') {
    self.postMessage({ type: 'result', id: m.id, corners: detect(m.image) });
  } else if (m.type === 'flatten') {
    const out = flatten(m.image, m.corners, m.outW, m.outH);
    if (out) {
      self.postMessage({ type: 'result', id: m.id, image: out }, [out.data.buffer]);
    } else {
      self.postMessage({ type: 'result', id: m.id, image: null });
    }
  }
};
