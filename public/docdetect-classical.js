/* Classical document quad detection via OpenCV.js (approxPolyDP pipeline). */
'use strict';

const DocDetectClassical = (() => {
  function angle(p1, p2, p0) {
    const dx1 = p1.x - p0.x, dy1 = p1.y - p0.y;
    const dx2 = p2.x - p0.x, dy2 = p2.y - p0.y;
    const den = Math.hypot(dx1, dy1) * Math.hypot(dx2, dy2);
    if (den < 1e-9) return 1;
    return Math.abs((dx1 * dx2 + dy1 * dy2) / den);
  }

  function contourToPoints(contour) {
    const pts = [];
    for (let i = 0; i < contour.rows; i++) {
      const x = contour.intPtr(i, 0)[0];
      const y = contour.intPtr(i, 0)[1];
      pts.push({ x, y });
    }
    return pts;
  }

  function approxToQuad(contour, cv) {
    const peri = cv.arcLength(contour, true);
    for (const eps of [0.02, 0.03, 0.04, 0.05, 0.06, 0.08]) {
      const approx = new cv.Mat();
      try {
        cv.approxPolyDP(contour, approx, eps * peri, true);
        if (approx.rows !== 4) continue;
        const pts = contourToPoints(approx);
        let maxCos = 0;
        for (let j = 2; j < 5; j++) {
          maxCos = Math.max(maxCos, angle(pts[j % 4], pts[j - 2], pts[j - 1]));
        }
        if (maxCos >= 0.35) continue;
        return pts;
      } finally {
        approx.delete();
      }
    }
    return null;
  }

  function scoreQuad(pts, w, h) {
    if (!pts || pts.length !== 4) return Infinity;
    const ordered = pts.map(p => [p.x, p.y]);
    const DQ = self.DocQuadPostprocess;
    if (!DQ.isConvexQuad(ordered) || DQ.isSelfIntersectingQuad(ordered)) return Infinity;
    const area = DQ.shoelaceArea(ordered);
    const imgArea = w * h;
    if (area < imgArea * 0.08 || area > imgArea * 0.98) return Infinity;
    let maxCos = 0;
    for (let j = 2; j < 5; j++) {
      maxCos = Math.max(maxCos, angle(pts[j % 4], pts[j - 2], pts[j - 1]));
    }
    return maxCos * 1000 - area;
  }

  function findBestQuad(contours, cv, w, h, topN = 12) {
    const ranked = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      ranked.push({ i, area: cv.contourArea(c) });
    }
    ranked.sort((a, b) => b.area - a.area);
    let best = null, bestScore = Infinity;
    for (let k = 0; k < Math.min(topN, ranked.length); k++) {
      const contour = contours.get(ranked[k].i);
      const quad = approxToQuad(contour, cv);
      if (!quad) continue;
      const s = scoreQuad(quad, w, h);
      if (s < bestScore) { bestScore = s; best = quad; }
    }
    return best;
  }

  function detectOnEdges(cv, imageData, mode) {
    const src = cv.matFromImageData(imageData);
    const gray = new cv.Mat();
    const blurred = new cv.Mat();
    const work = new cv.Mat();
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
      if (mode === 'canny') {
        cv.Canny(blurred, work, 50, 150);
        cv.dilate(work, work, kernel);
        cv.morphologyEx(work, work, cv.MORPH_CLOSE, kernel);
      } else {
        cv.adaptiveThreshold(blurred, work, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 11, 2);
        cv.morphologyEx(work, work, cv.MORPH_CLOSE, kernel);
      }
      cv.findContours(work, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      const quad = findBestQuad(contours, cv, imageData.width, imageData.height);
      if (!quad) return null;
      const ordered = self.DocQuadPostprocess.canonicalizeQuadOrderV1(quad.map(p => [p.x, p.y]));
      return ordered.map(([x, y]) => ({ x, y }));
    } finally {
      src.delete(); gray.delete(); blurred.delete(); work.delete();
      kernel.delete(); contours.delete(); hierarchy.delete();
    }
  }

  function detect(cv, imageData) {
    if (!cv || !imageData) return null;
    return detectOnEdges(cv, imageData, 'canny') || detectOnEdges(cv, imageData, 'adaptive');
  }

  function classicalConfidence(quad, w, h) {
    const s = scoreQuad(quad, w, h);
    if (!Number.isFinite(s) || s === Infinity) return 0.5;
    return s < 500 ? 0.72 : 0.58;
  }

  return { detect, classicalConfidence, scoreQuad };
})();

if (typeof self !== 'undefined') self.DocDetectClassical = DocDetectClassical;
