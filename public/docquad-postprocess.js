/* DocQuadNet-256 product post-processing (port of MakeACopy DocQuadPostprocessor). */
'use strict';

const DocQuadPostprocess = (() => {
  const HARD_PENALTY_THRESHOLD = 1e5;
  const AGREEMENT_MAX_CORNER_DIST = 32.0;
  const MASK_SCORE_MARGIN = 50.0;

  class Letterbox {
    constructor(srcW, srcH, dstW, dstH, scale, offsetX, offsetY) {
      this.srcW = srcW;
      this.srcH = srcH;
      this.dstW = dstW;
      this.dstH = dstH;
      this.scale = scale;
      this.offsetX = offsetX;
      this.offsetY = offsetY;
    }

    static create(srcW, srcH, dstW = 256, dstH = 256) {
      const scale = Math.min(dstW / srcW, dstH / srcH);
      const newW = srcW * scale;
      const newH = srcH * scale;
      const offsetX = (dstW - newW) / 2;
      const offsetY = (dstH - newH) / 2;
      return new Letterbox(srcW, srcH, dstW, dstH, scale, offsetX, offsetY);
    }

    forward(x, y) {
      return [x * this.scale + this.offsetX, y * this.scale + this.offsetY];
    }

    inverse(x, y) {
      return [(x - this.offsetX) / this.scale, (y - this.offsetY) / this.scale];
    }
  }

  function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
  }

  function shoelaceArea(pts) {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      s += x1 * y2 - y1 * x2;
    }
    return Math.abs(s) * 0.5;
  }

  function cross(ax, ay, bx, by, cx, cy) {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  }

  function isConvexQuad(pts, eps = 1e-9) {
    const signs = [];
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % 4];
      const [cx, cy] = pts[(i + 2) % 4];
      const z = cross(ax, ay, bx, by, cx, cy);
      if (Math.abs(z) <= eps) continue;
      signs.push(z > 0 ? 1 : -1);
    }
    if (!signs.length) return false;
    return signs.every(s => s === signs[0]);
  }

  function onSegment(ax, ay, bx, by, px, py, eps) {
    if (Math.min(ax, bx) - eps <= px && px <= Math.max(ax, bx) + eps &&
        Math.min(ay, by) - eps <= py && py <= Math.max(ay, by) + eps) {
      return Math.abs(cross(ax, ay, bx, by, px, py)) <= eps;
    }
    return false;
  }

  function segmentsIntersect(a, b, c, d, eps = 1e-9) {
    const [ax, ay] = a, [bx, by] = b, [cx, cy] = c, [dx, dy] = d;
    const o1 = cross(ax, ay, bx, by, cx, cy);
    const o2 = cross(ax, ay, bx, by, dx, dy);
    const o3 = cross(cx, cy, dx, dy, ax, ay);
    const o4 = cross(cx, cy, dx, dy, bx, by);
    const sgn = z => (Math.abs(z) <= eps ? 0 : (z > 0 ? 1 : -1));
    const s1 = sgn(o1), s2 = sgn(o2), s3 = sgn(o3), s4 = sgn(o4);
    if (s1 && s2 && s3 && s4) return s1 !== s2 && s3 !== s4;
    if (s1 === 0 && onSegment(ax, ay, bx, by, cx, cy, eps)) return true;
    if (s2 === 0 && onSegment(ax, ay, bx, by, dx, dy, eps)) return true;
    if (s3 === 0 && onSegment(cx, cy, dx, dy, ax, ay, eps)) return true;
    if (s4 === 0 && onSegment(cx, cy, dx, dy, bx, by, eps)) return true;
    return false;
  }

  function isSelfIntersectingQuad(pts) {
    const e01 = [pts[0], pts[1]], e12 = [pts[1], pts[2]], e23 = [pts[2], pts[3]], e30 = [pts[3], pts[0]];
    if (segmentsIntersect(e01[0], e01[1], e23[0], e23[1])) return true;
    if (segmentsIntersect(e12[0], e12[1], e30[0], e30[1])) return true;
    return false;
  }

  function canonicalizeQuadOrderV1(pts) {
    if (pts.length !== 4) throw new Error('pts must have exactly 4 points');
    const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
    const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
    const ordered = [0, 1, 2, 3];
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        const a = ordered[i], b = ordered[j];
        const angA = Math.atan2(pts[a][1] - cy, pts[a][0] - cx);
        const angB = Math.atan2(pts[b][1] - cy, pts[b][0] - cx);
        let swap = angB < angA || (angB === angA && b < a);
        if (swap) { ordered[i] = b; ordered[j] = a; }
      }
    }
    let tlPos = 0, bestSum = Infinity;
    for (let k = 0; k < 4; k++) {
      const idx = ordered[k];
      const s = pts[idx][0] + pts[idx][1];
      if (s < bestSum || (s === bestSum && k < tlPos)) { bestSum = s; tlPos = k; }
    }
    const out = [];
    for (let i = 0; i < 4; i++) out.push(pts[ordered[(tlPos + i) % 4]]);
    return out;
  }

  function oob1d(v, minV, maxV) {
    if (v < minV) return minV - v;
    if (v > maxV) return v - maxV;
    return 0;
  }

  function oobSum(quad, w, h, tolPx) {
    const left = -tolPx, top = -tolPx, right = (w - 1) + tolPx, bottom = (h - 1) + tolPx;
    let s = 0;
    for (const [x, y] of quad) s += oob1d(x, left, right) + oob1d(y, top, bottom);
    return s;
  }

  function oobMax(quad, w, h, tolPx) {
    const left = -tolPx, top = -tolPx, right = (w - 1) + tolPx, bottom = (h - 1) + tolPx;
    let m = 0;
    for (const [x, y] of quad) {
      const v = oob1d(x, left, right) + oob1d(y, top, bottom);
      if (v > m) m = v;
    }
    return m;
  }

  function edgeLengthMin(quad) {
    let m = Infinity;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      m = Math.min(m, Math.hypot(quad[j][0] - quad[i][0], quad[j][1] - quad[i][1]));
    }
    return m;
  }

  function edgeLengthMax(quad) {
    let m = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      m = Math.max(m, Math.hypot(quad[j][0] - quad[i][0], quad[j][1] - quad[i][1]));
    }
    return m;
  }

  function pointInPolyInclusive(poly, px, py) {
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % 4];
      if (onSegment(ax, ay, bx, by, px, py, 1e-9)) return true;
    }
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      const intersect = ((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function quadPenaltyGeometry(quad256) {
    if (!quad256 || quad256.length !== 4) return 1e6;
    for (const p of quad256) {
      if (!p || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return 1e6;
    }
    let penalty = 0;
    const w = 256, h = 256, tol = 2, hard = 16, kSoft = 10, kHard = 1000;
    const oobSumVal = oobSum(quad256, w, h, tol);
    if (oobSumVal > 0) penalty += oobSumVal * kSoft;
    const oobMaxVal = oobMax(quad256, w, h, tol);
    if (oobMaxVal > hard) penalty += 1e5 + (oobMaxVal - hard) * kHard;
    if (isSelfIntersectingQuad(quad256)) penalty += 1e6;
    if (!isConvexQuad(quad256)) penalty += 1e6;
    if (!(shoelaceArea(quad256) > 1)) penalty += 1e6;
    const edgeMin = edgeLengthMin(quad256);
    const edgeMax = edgeLengthMax(quad256);
    if (edgeMin < 8) penalty += (8 - edgeMin) * 1000;
    const r = edgeMax / Math.max(edgeMin, 1e-9);
    if (r > 25) penalty += (r - 25) * 100;
    return penalty;
  }

  function maskDisagreementPenaltyForCorners(quadCorners256, maskLogits) {
    const quad64 = quadCorners256.map(([x, y]) => [x / 4, y / 4]);
    const grid = [0, 8, 16, 24, 32, 40, 48, 56];
    let disagree = 0;
    const m = maskLogits;
    for (const gy of grid) {
      for (const gx of grid) {
        const px = gx + 0.5, py = gy + 0.5;
        const inQuad = pointInPolyInclusive(quad64, px, py);
        const inMask = sigmoid(m[gy * 64 + gx]) > 0.5;
        if (inQuad !== inMask) disagree++;
      }
    }
    return disagree * 10;
  }

  function refineCorners64To256_3x3(cornerHeatmaps) {
    const corners256 = [];
    for (let c = 0; c < 4; c++) {
      const hm = cornerHeatmaps[c];
      let best = -Infinity, bestX = 0, bestY = 0;
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const v = hm[y * 64 + x];
          if (v > best) { best = v; bestX = x; bestY = y; }
        }
      }
      const x0 = Math.max(0, bestX - 1), x1 = Math.min(63, bestX + 1);
      const y0 = Math.max(0, bestY - 1), y1 = Math.min(63, bestY + 1);
      let maxLogit = -Infinity;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) maxLogit = Math.max(maxLogit, hm[y * 64 + x]);
      }
      let sumW = 0, sumX = 0, sumY = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const w = Math.exp(hm[y * 64 + x] - maxLogit);
          sumW += w; sumX += w * (x + 0.5); sumY += w * (y + 0.5);
        }
      }
      let x64, y64;
      if (sumW === 0 || !Number.isFinite(sumW)) { x64 = bestX + 0.5; y64 = bestY + 0.5; }
      else { x64 = sumX / sumW; y64 = sumY / sumW; }
      corners256.push([x64 * 4, y64 * 4]);
    }
    return corners256;
  }

  function computeQuadFromMask256(maskLogits, fallbackCorners256) {
    let maskCount = 0, sumX = 0, sumY = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (sigmoid(maskLogits[y * 64 + x]) > 0.5) {
          maskCount++; sumX += x + 0.5; sumY += y + 0.5;
        }
      }
    }
    if (!maskCount) return { quad: fallbackCorners256, usedFallback: true };
    const cx = sumX / maskCount, cy = sumY / maskCount;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return { quad: fallbackCorners256, usedFallback: true };

    let sxx = 0, sxy = 0, syy = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (sigmoid(maskLogits[y * 64 + x]) > 0.5) {
          const dx = (x + 0.5) - cx, dy = (y + 0.5) - cy;
          sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
        }
      }
    }
    sxx /= maskCount; sxy /= maskCount; syy /= maskCount;
    const trace = sxx + syy;
    if (!Number.isFinite(trace) || trace < 1e-12) return { quad: fallbackCorners256, usedFallback: true };

    const det = sxx * syy - sxy * sxy;
    const disc = Math.sqrt(Math.max(0, trace * trace / 4 - det));
    const lambda1 = trace / 2 + disc;
    let v1x, v1y;
    if (Math.abs(sxy) > 1e-12) { v1x = lambda1 - syy; v1y = sxy; }
    else if (sxx >= syy) { v1x = 1; v1y = 0; }
    else { v1x = 0; v1y = 1; }
    const n = Math.hypot(v1x, v1y);
    if (!n || !Number.isFinite(n)) return { quad: fallbackCorners256, usedFallback: true };
    v1x /= n; v1y /= n;
    const v2x = -v1y, v2y = v1x;

    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (sigmoid(maskLogits[y * 64 + x]) > 0.5) {
          const px = (x + 0.5) - cx, py = (y + 0.5) - cy;
          const u = px * v1x + py * v1y, v = px * v2x + py * v2y;
          uMin = Math.min(uMin, u); uMax = Math.max(uMax, u);
          vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
        }
      }
    }
    if (![uMin, uMax, vMin, vMax].every(Number.isFinite) || uMax - uMin < 1e-12 || vMax - vMin < 1e-12) {
      return { quad: fallbackCorners256, usedFallback: true };
    }
    const quad64 = [
      [cx + uMax * v1x + vMax * v2x, cy + uMax * v1y + vMax * v2y],
      [cx + uMin * v1x + vMax * v2x, cy + uMin * v1y + vMax * v2y],
      [cx + uMin * v1x + vMin * v2x, cy + uMin * v1y + vMin * v2y],
      [cx + uMax * v1x + vMin * v2x, cy + uMax * v1y + vMin * v2y],
    ];
    return { quad: quad64.map(([x, y]) => [x * 4, y * 4]), usedFallback: false };
  }

  function maxCornerDistance(quad1, quad2) {
    let m = 0;
    for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(quad1[i][0] - quad2[i][0], quad1[i][1] - quad2[i][1]));
    return m;
  }

  function choosePath(quadCorners256, quadFromMask256, quadFromMaskUsedFallback, maskLogits) {
    const pAGeom = quadPenaltyGeometry(quadCorners256);
    const pA = pAGeom + maskDisagreementPenaltyForCorners(quadCorners256, maskLogits);
    if (quadFromMaskUsedFallback) return { quad: quadCorners256, source: 'CORNERS', penaltyCorners: pA, penaltyMask: Infinity };
    const pB = quadPenaltyGeometry(quadFromMask256);
    if (pAGeom >= HARD_PENALTY_THRESHOLD && pB < HARD_PENALTY_THRESHOLD) {
      return { quad: quadFromMask256, source: 'MASK', penaltyCorners: pA, penaltyMask: pB };
    }
    if (pB >= HARD_PENALTY_THRESHOLD) {
      return { quad: quadCorners256, source: 'CORNERS', penaltyCorners: pA, penaltyMask: pB };
    }
    if (maxCornerDistance(quadCorners256, quadFromMask256) > AGREEMENT_MAX_CORNER_DIST) {
      return { quad: quadCorners256, source: 'CORNERS', penaltyCorners: pA, penaltyMask: pB };
    }
    if (pB < pAGeom - MASK_SCORE_MARGIN) {
      return { quad: quadFromMask256, source: 'MASK', penaltyCorners: pA, penaltyMask: pB };
    }
    return { quad: quadCorners256, source: 'CORNERS', penaltyCorners: pA, penaltyMask: pB };
  }

  function applyProductPostprocessing(cornerHeatmapsFlat, maskLogitsFlat, lb) {
    const corners256 = refineCorners64To256_3x3(cornerHeatmapsFlat);
    const { quad: quadFromMask256, usedFallback } = computeQuadFromMask256(maskLogitsFlat, corners256);
    const chosen = choosePath(corners256, quadFromMask256, usedFallback, maskLogitsFlat);
    const cornersOriginal = chosen.quad.map(([x, y]) => lb.inverse(x, y));
    return {
      cornersOriginal: canonicalizeQuadOrderV1(cornersOriginal),
      chosenSource: chosen.source,
      penaltyCorners: chosen.penaltyCorners,
      penaltyMask: chosen.penaltyMask,
    };
  }

  /** Render letterboxed RGB into NCHW float32 tensor [1,3,256,256]. */
  function imageDataToTensor(imageData, lb, dstW, dstH) {
    const srcCanvas = new OffscreenCanvas(imageData.width, imageData.height);
    const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
    srcCtx.putImageData(imageData, 0, 0);

    const dstCanvas = new OffscreenCanvas(dstW, dstH);
    const dstCtx = dstCanvas.getContext('2d', { willReadFrequently: true });
    dstCtx.fillStyle = '#000';
    dstCtx.fillRect(0, 0, dstW, dstH);
    const newW = Math.round(lb.srcW * lb.scale);
    const newH = Math.round(lb.srcH * lb.scale);
    dstCtx.drawImage(srcCanvas, 0, 0, lb.srcW, lb.srcH, lb.offsetX, lb.offsetY, newW, newH);

    const px = dstCtx.getImageData(0, 0, dstW, dstH).data;
    const n = dstW * dstH;
    const tensor = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      tensor[i] = px[j] / 255;
      tensor[n + i] = px[j + 1] / 255;
      tensor[2 * n + i] = px[j + 2] / 255;
    }
    return tensor;
  }

  function penaltyToConfidence(penalty) {
    if (penalty < 100) return 0.95;
    if (penalty < 2000) return 0.8;
    if (penalty < 10000) return 0.55;
    return 0.3;
  }

  return {
    Letterbox,
    canonicalizeQuadOrderV1,
    quadPenaltyGeometry,
    shoelaceArea,
    isConvexQuad,
    isSelfIntersectingQuad,
    imageDataToTensor,
    applyProductPostprocessing,
    penaltyToConfidence,
  };
})();

if (typeof self !== 'undefined') self.DocQuadPostprocess = DocQuadPostprocess;
