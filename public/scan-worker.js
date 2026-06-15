/* PDFPager scan worker.
 *
 * Hybrid document detection: DocQuadNet-256 (ONNX) + classical OpenCV fallback.
 * Perspective warp uses OpenCV WASM.
 *
 * Messages in:
 *   { type: 'detect',  id, image: ImageData }
 *   { type: 'flatten', id, image: ImageData, corners: [TL,TR,BR,BL], outW, outH }
 * Messages out:
 *   { type: 'ready' } | { type: 'error', message }
 *   { type: 'result', id, corners, confidence, method, image }
 */
'use strict';

const MODEL_SIZE = 256;
let cvReady = false;
let ortReady = false;
let ortSession = null;

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

async function initOrt() {
  try {
    importScripts('/docquad-postprocess.js', '/docdetect-classical.js');
  } catch (e) {
    console.warn('Detection helpers failed to load:', e.message || e);
  }
  try {
    importScripts('/vendor/ort/ort.wasm.min.js');
    ort.env.wasm.wasmPaths = '/vendor/ort/';
    ort.env.wasm.numThreads = 1;
    ortSession = await ort.InferenceSession.create('/vendor/docquadnet256.onnx', {
      executionProviders: ['wasm'],
    });
    ortReady = true;
  } catch (e) {
    ortSession = null;
    ortReady = false;
    console.warn('DocQuadNet ONNX unavailable:', e.message || e);
  }
}

whenCvReady(() => {
  cvReady = true;
  initOrt().finally(() => {
    self.postMessage({ type: 'ready', ort: ortReady });
  });
});

function validateQuad(corners, image) {
  if (!corners || corners.length !== 4) return false;
  const pts = corners.map(c => [c.x, c.y]);
  const DQ = self.DocQuadPostprocess;
  if (!DQ) return false;
  const area = DQ.shoelaceArea(pts);
  if (area < image.width * image.height * 0.08) return false;
  if (!DQ.isConvexQuad(pts) || DQ.isSelfIntersectingQuad(pts)) return false;
  return corners.every(c => Number.isFinite(c.x) && Number.isFinite(c.y));
}

async function detectDocQuad(image) {
  if (!ortSession || !self.DocQuadPostprocess) return null;
  const DQ = self.DocQuadPostprocess;
  const lb = DQ.Letterbox.create(image.width, image.height, MODEL_SIZE, MODEL_SIZE);
  const inputData = DQ.imageDataToTensor(image, lb, MODEL_SIZE, MODEL_SIZE);
  const inputName = ortSession.inputNames[0];
  const inputTensor = new ort.Tensor('float32', inputData, [1, 3, MODEL_SIZE, MODEL_SIZE]);
  const outputs = await ortSession.run({ [inputName]: inputTensor });

  const cornerTensor = outputs[ortSession.outputNames[0]];
  const maskTensor = outputs[ortSession.outputNames[1]];
  const cornerChannels = [];
  const plane = MODEL_SIZE * MODEL_SIZE / 16; // 64*64
  for (let c = 0; c < 4; c++) {
    cornerChannels.push(cornerTensor.data.subarray(c * plane, (c + 1) * plane));
  }

  const post = DQ.applyProductPostprocessing(cornerChannels, maskTensor.data, lb);
  const corners = post.cornersOriginal.map(([x, y]) => ({ x, y }));
  return {
    corners,
    confidence: DQ.penaltyToConfidence(post.penaltyCorners),
    method: 'docquad',
    source: post.chosenSource,
    penalty: post.penaltyCorners,
  };
}

function detectClassical(image) {
  if (!self.DocDetectClassical) return null;
  const corners = self.DocDetectClassical.detect(cv, image);
  if (!corners) return null;
  return {
    corners,
    confidence: self.DocDetectClassical.classicalConfidence(corners, image.width, image.height),
    method: 'classical',
  };
}

async function detect(image) {
  let ml = null;
  let classical = null;

  if (ortReady) {
    try { ml = await detectDocQuad(image); } catch { ml = null; }
  }
  if (cvReady) {
    try { classical = detectClassical(image); } catch { classical = null; }
  }

  const candidates = [];
  if (ml?.corners && validateQuad(ml.corners, image)) candidates.push(ml);
  if (classical?.corners && validateQuad(classical.corners, image)) candidates.push(classical);

  if (!candidates.length) {
    return { corners: null, confidence: 0, method: 'none' };
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0];
  return {
    corners: best.corners,
    confidence: best.confidence,
    method: best.method,
  };
}

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

self.onmessage = async (e) => {
  const m = e.data;
  if (!cvReady) {
    self.postMessage({ type: 'result', id: m.id, corners: null, image: null, confidence: 0, method: 'none' });
    return;
  }
  if (m.type === 'detect') {
    const result = await detect(m.image);
    self.postMessage({
      type: 'result',
      id: m.id,
      corners: result.corners,
      confidence: result.confidence,
      method: result.method,
    });
  } else if (m.type === 'flatten') {
    const out = flatten(m.image, m.corners, m.outW, m.outH);
    if (out) {
      self.postMessage({ type: 'result', id: m.id, image: out }, [out.data.buffer]);
    } else {
      self.postMessage({ type: 'result', id: m.id, image: null });
    }
  }
};
