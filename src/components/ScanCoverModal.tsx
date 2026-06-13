import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Smartphone, X, Check, Loader2, Move } from 'lucide-react';

/**
 * Pairs this desktop session with a phone for cover scanning.
 *
 * Lifecycle: create a scan session (QR + short URL + 4-digit PIN) → poll →
 * when the phone uploads, show the image with an "insert where?" choice →
 * insert → keep polling for further covers. Sessions are destroyed on close.
 *
 * The modal also has a corner editor (adjust phase): raw uploads (phone's
 * "Send original") open it automatically, and any scan can be re-adjusted.
 * Detection and the homography flatten run in the same /scan-worker.js the
 * phone page uses — OpenCV stays off the UI thread.
 */

interface ScanCoverModalProps {
  /** Ordered unique tags currently present in the document (section list). */
  tags: string[];
  onInsert: (imageBytes: ArrayBuffer, mime: string, tag: string | null) => Promise<void>;
  onClose: () => void;
}

interface ScanSession {
  token: string;
  code: string;
  pin: string;
  quickUrl: string;
  shortUrl: string;
  qrDataUrl: string;
}

type Phase = 'creating' | 'waiting' | 'imageReady' | 'adjust' | 'inserting' | 'error';

interface Pt { x: number; y: number }

/* ---------------- shared scan worker (module singleton) ---------------- */

let scanWorker: Worker | null = null;
let scanWorkerReady = false;
let scanWorkerFailed = false;
let scanReqId = 0;
const scanPending = new Map<number, (m: any) => void>();

function ensureScanWorker() {
  if (scanWorker || scanWorkerFailed) return;
  try {
    scanWorker = new Worker('/scan-worker.js');
    scanWorker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') { scanWorkerReady = true; return; }
      if (m.type === 'error') { scanWorkerFailed = true; return; }
      const r = scanPending.get(m.id);
      if (r) { scanPending.delete(m.id); r(m); }
    };
    scanWorker.onerror = () => { scanWorkerFailed = true; };
  } catch {
    scanWorkerFailed = true;
  }
}

async function waitForScanWorker(maxMs = 8000): Promise<boolean> {
  ensureScanWorker();
  const t0 = Date.now();
  while (!scanWorkerReady && !scanWorkerFailed && Date.now() - t0 < maxMs) {
    await new Promise(r => setTimeout(r, 200));
  }
  return scanWorkerReady;
}

function scanWorkerCall(msg: Record<string, unknown>, transfers: Transferable[], timeoutMs = 15000): Promise<any> {
  return new Promise((resolve) => {
    if (!scanWorker || !scanWorkerReady) return resolve(null);
    const id = ++scanReqId;
    const timer = setTimeout(() => { scanPending.delete(id); resolve(null); }, timeoutMs);
    scanPending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    try {
      scanWorker.postMessage({ ...msg, id }, transfers);
    } catch {
      clearTimeout(timer);
      scanPending.delete(id);
      resolve(null);
    }
  });
}

/* ------------------------------ component ------------------------------ */

export const ScanCoverModal: React.FC<ScanCoverModalProps> = ({ tags, onInsert, onClose }) => {
  const [phase, setPhase] = useState<Phase>('creating');
  const [session, setSession] = useState<ScanSession | null>(null);
  const [phoneConnected, setPhoneConnected] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null); // null = untagged
  const [insertedCount, setInsertedCount] = useState(0);
  const [adjustBusy, setAdjustBusy] = useState(false);

  const imageRef = useRef<{ bytes: ArrayBuffer; mime: string } | null>(null);
  const consumedRef = useRef<number | null>(null);
  const phaseRef = useRef<Phase>('creating');
  phaseRef.current = phase;

  // Adjust phase state
  const adjustImgRef = useRef<HTMLImageElement | null>(null);
  const adjustCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cornersRef = useRef<Pt[]>([]);
  const dragIdxRef = useRef(-1);
  const [, bumpAdjust] = useState(0); // re-render trigger after corner edits

  /* ------------------------- session lifecycle ------------------------- */

  useEffect(() => {
    let cancelled = false;
    let token: string | null = null;
    (async () => {
      try {
        const r = await fetch('/api/scan/session', { method: 'POST' });
        const j = await r.json();
        if (!r.ok || !j.success) throw new Error(j.error || 'Could not create scan session');
        if (cancelled) return;
        token = j.token;
        setSession(j);
        setPhase('waiting');
      } catch (e: any) {
        if (!cancelled) {
          setErrorMsg(e.message || 'Could not reach the scan service.');
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
      if (token) fetch(`/api/scan/session/${token}`, { method: 'DELETE' }).catch(() => {});
    };
  }, []);

  // Poll while waiting (paused in every other phase so a second upload
  // can't swap the image mid-decision).
  useEffect(() => {
    if (!session) return;
    const iv = setInterval(async () => {
      if (phaseRef.current !== 'waiting') return;
      try {
        const r = await fetch(`/api/scan/session/${session.token}`);
        if (r.status === 404) {
          setErrorMsg('Scan session expired. Close and start a new one.');
          setPhase('error');
          return;
        }
        const j = await r.json();
        if (!j.success) return;
        setPhoneConnected(!!j.connected);
        if (j.hasImage && j.uploadedAt && j.uploadedAt !== consumedRef.current) {
          const ir = await fetch(`/api/scan/session/${session.token}/image`);
          if (!ir.ok) return;
          const mime = ir.headers.get('content-type') || 'image/jpeg';
          const bytes = await ir.arrayBuffer();
          consumedRef.current = j.uploadedAt;
          imageRef.current = { bytes, mime };
          setPreviewUrl(prev => {
            if (prev) URL.revokeObjectURL(prev);
            return URL.createObjectURL(new Blob([bytes], { type: mime }));
          });
          if (j.isRaw) {
            // Phone sent the unedited capture — straight into the editor.
            openAdjust();
          } else {
            setPhase('imageReady');
          }
        }
      } catch {
        /* transient network failure — next tick retries */
      }
    }, 2500);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  /* --------------------------- adjust phase ---------------------------- */

  const drawAdjust = useCallback(() => {
    const canvas = adjustCanvasRef.current;
    const img = adjustImgRef.current;
    if (!canvas || !img) return;
    const maxW = Math.min(620, window.innerWidth * 0.86);
    const maxH = window.innerHeight * 0.5;
    const k = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(img.naturalWidth * k * dpr);
    canvas.height = Math.round(img.naturalHeight * k * dpr);
    canvas.style.width = `${Math.round(img.naturalWidth * k)}px`;
    canvas.style.height = `${Math.round(img.naturalHeight * k)}px`;
    (canvas as any)._scale = k;

    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(img, 0, 0, img.naturalWidth * k, img.naturalHeight * k);

    const cs = cornersRef.current;
    if (cs.length !== 4) return;

    // dim outside the quad
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, img.naturalWidth * k, img.naturalHeight * k);
    ctx.moveTo(cs[0].x * k, cs[0].y * k);
    for (let i = 3; i >= 0; i--) ctx.lineTo(cs[i].x * k, cs[i].y * k);
    ctx.closePath();
    (ctx as any).fill('evenodd');
    ctx.restore();

    ctx.strokeStyle = '#007AFF';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cs[0].x * k, cs[0].y * k);
    for (let i = 1; i < 4; i++) ctx.lineTo(cs[i].x * k, cs[i].y * k);
    ctx.closePath();
    ctx.stroke();

    for (const c of cs) {
      ctx.beginPath();
      ctx.arc(c.x * k, c.y * k, 11, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,122,255,0.25)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(c.x * k, c.y * k, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = '#007AFF';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Loupe while dragging (Adobe Scan-style): magnified circle above the
    // grabbed corner with crosshair + quad edges for precise placement.
    const di = dragIdxRef.current;
    if (di >= 0) {
      const c = cs[di];
      const R = 48, Z = 2.2;
      const canvasW = img.naturalWidth * k, canvasH = img.naturalHeight * k;
      const cx = c.x * k, cy = c.y * k;
      let lx = cx, ly = cy - R - 28;
      if (ly < R + 4) ly = Math.min(cy + R + 28, canvasH - R - 4);
      lx = Math.max(R + 4, Math.min(canvasW - R - 4, lx));

      const srcW = (2 * R) / (k * Z);
      ctx.save();
      ctx.beginPath();
      ctx.arc(lx, ly, R, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = '#fff';
      ctx.fillRect(lx - R, ly - R, 2 * R, 2 * R);
      ctx.drawImage(img, c.x - srcW / 2, c.y - srcW / 2, srcW, srcW, lx - R, ly - R, 2 * R, 2 * R);
      ctx.strokeStyle = 'rgba(0,122,255,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = cs[i], b = cs[(i + 1) % 4];
        ctx.moveTo(lx + (a.x - c.x) * k * Z, ly + (a.y - c.y) * k * Z);
        ctx.lineTo(lx + (b.x - c.x) * k * Z, ly + (b.y - c.y) * k * Z);
      }
      ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(lx, ly, R, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(lx, ly, R, 0, Math.PI * 2);
      ctx.strokeStyle = '#007AFF';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(lx - 10, ly); ctx.lineTo(lx + 10, ly);
      ctx.moveTo(lx, ly - 10); ctx.lineTo(lx, ly + 10);
      ctx.strokeStyle = '#FF3B30';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }, []);

  useEffect(() => {
    if (phase === 'adjust') requestAnimationFrame(drawAdjust);
  }, [phase, drawAdjust]);

  const openAdjust = useCallback(() => {
    const current = imageRef.current;
    if (!current) return;
    ensureScanWorker();
    const blob = new Blob([current.bytes], { type: current.mime });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = async () => {
      URL.revokeObjectURL(url);
      adjustImgRef.current = img;
      const w = img.naturalWidth, h = img.naturalHeight;
      cornersRef.current = [
        { x: w * 0.08, y: h * 0.08 },
        { x: w * 0.92, y: h * 0.08 },
        { x: w * 0.92, y: h * 0.92 },
        { x: w * 0.08, y: h * 0.92 },
      ];
      setPhase('adjust');
      // Auto-detect asynchronously; refine the provisional corners on success.
      if (await waitForScanWorker()) {
        const k = Math.min(1, 800 / Math.max(w, h));
        const small = document.createElement('canvas');
        small.width = Math.max(2, Math.round(w * k));
        small.height = Math.max(2, Math.round(h * k));
        const sctx = small.getContext('2d', { willReadFrequently: true })!;
        sctx.drawImage(img, 0, 0, small.width, small.height);
        const image = sctx.getImageData(0, 0, small.width, small.height);
        const res = await scanWorkerCall({ type: 'detect', image }, [image.data.buffer], 6000);
        if (res?.corners && phaseRef.current === 'adjust' && adjustImgRef.current === img) {
          cornersRef.current = res.corners.map((c: Pt) => ({ x: c.x / k, y: c.y / k }));
          drawAdjust();
        }
      }
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }, [drawAdjust]);

  const canvasPoint = (e: React.PointerEvent): Pt => {
    const canvas = adjustCanvasRef.current!;
    const k = (canvas as any)._scale || 1;
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  };

  const onAdjustDown = (e: React.PointerEvent) => {
    const p = canvasPoint(e);
    const canvas = adjustCanvasRef.current!;
    const grabR = 26 / ((canvas as any)._scale || 1);
    let best = -1, bestD = Infinity;
    cornersRef.current.forEach((c, i) => {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < grabR && d < bestD) { best = i; bestD = d; }
    });
    if (best >= 0) {
      dragIdxRef.current = best;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  };

  const onAdjustMove = (e: React.PointerEvent) => {
    if (dragIdxRef.current < 0) return;
    const img = adjustImgRef.current!;
    const p = canvasPoint(e);
    cornersRef.current[dragIdxRef.current] = {
      x: Math.max(0, Math.min(img.naturalWidth, p.x)),
      y: Math.max(0, Math.min(img.naturalHeight, p.y)),
    };
    drawAdjust();
    e.preventDefault();
  };

  const onAdjustUp = () => { dragIdxRef.current = -1; drawAdjust(); /* clears the loupe */ bumpAdjust(n => n + 1); };

  const applyAdjust = async () => {
    const img = adjustImgRef.current;
    const cs = cornersRef.current;
    if (!img || cs.length !== 4) return;
    setAdjustBusy(true);
    try {
      if (!(await waitForScanWorker())) {
        throw new Error('The straightening engine is unavailable — insert without adjustment or retry.');
      }
      const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);
      let outW = Math.round(Math.max(dist(cs[0], cs[1]), dist(cs[3], cs[2])));
      let outH = Math.round(Math.max(dist(cs[0], cs[3]), dist(cs[1], cs[2])));
      if (outW < 8 || outH < 8) throw new Error('Corners are too close together.');
      const cap = 2400;
      const k = Math.min(1, cap / Math.max(outW, outH));
      outW = Math.round(outW * k);
      outH = Math.round(outH * k);

      const full = document.createElement('canvas');
      full.width = img.naturalWidth;
      full.height = img.naturalHeight;
      const fctx = full.getContext('2d', { willReadFrequently: true })!;
      fctx.drawImage(img, 0, 0);
      const image = fctx.getImageData(0, 0, full.width, full.height);

      const res = await scanWorkerCall({ type: 'flatten', image, corners: cs, outW, outH }, [image.data.buffer]);
      if (!res?.image) throw new Error('Straightening failed — adjust the corners and retry.');

      const out = document.createElement('canvas');
      out.width = res.image.width;
      out.height = res.image.height;
      out.getContext('2d')!.putImageData(res.image, 0, 0);
      const blob: Blob = await new Promise((resolve, reject) =>
        out.toBlob(b => (b ? resolve(b) : reject(new Error('Could not encode the result'))), 'image/jpeg', 0.92)
      );
      const bytes = await blob.arrayBuffer();
      imageRef.current = { bytes, mime: 'image/jpeg' };
      setPreviewUrl(prev => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
      setPhase('imageReady');
    } catch (e: any) {
      alert(e.message || 'Straightening failed.');
    } finally {
      setAdjustBusy(false);
    }
  };

  /* ----------------------------- insert ------------------------------- */

  const handleInsert = async () => {
    if (!imageRef.current) return;
    setPhase('inserting');
    try {
      await onInsert(imageRef.current.bytes, imageRef.current.mime, target);
      setInsertedCount(n => n + 1);
      imageRef.current = null;
      setPhase('waiting'); // ready for the next scan
    } catch (e: any) {
      setErrorMsg(e.message || 'Failed to insert the cover.');
      setPhase('error');
    }
  };

  const handleDiscard = () => {
    imageRef.current = null;
    setPhase('waiting');
  };

  /* ------------------------------ render ------------------------------ */

  const S: Record<string, React.CSSProperties> = {
    overlay: {
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    },
    modal: {
      background: 'var(--bg-card)', borderRadius: 14,
      width: phase === 'adjust' ? 'min(680px, 94vw)' : 'min(440px, 92vw)',
      maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      display: 'flex', flexDirection: 'column',
    },
    header: {
      display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px',
      borderBottom: '1px solid var(--separator)',
    },
    body: { padding: 20, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 },
    code: {
      fontFamily: 'ui-monospace, monospace', fontSize: 15, background: 'var(--bg-hover)',
      border: '1px solid var(--separator)', borderRadius: 8, padding: '6px 12px',
    },
    status: { fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 },
    radioRow: {
      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
      border: '1px solid var(--separator)', borderRadius: 8, cursor: 'pointer', fontSize: 13,
      width: '100%',
    },
  };

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={S.header}>
          <Smartphone size={16} style={{ color: 'var(--accent)' }} />
          <b style={{ fontSize: 14, flex: 1 }}>Scan cover with phone</b>
          {insertedCount > 0 && (
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {insertedCount} inserted ✓
            </span>
          )}
          <button className="btn-icon" onClick={onClose} title="Close">
            <X size={15} />
          </button>
        </div>

        <div style={S.body}>
          {phase === 'creating' && (
            <div style={S.status}><Loader2 size={14} className="spin" /> Creating scan session…</div>
          )}

          {phase === 'error' && (
            <>
              <span style={{ fontSize: 28 }}>⚠️</span>
              <p style={{ fontSize: 13, color: 'var(--danger)', textAlign: 'center' }}>{errorMsg}</p>
              <button className="btn btn-sm btn-secondary" onClick={onClose}>Close</button>
            </>
          )}

          {phase === 'waiting' && session && (
            <>
              <img src={session.qrDataUrl} alt="Scan QR" width={190} height={190}
                   style={{ borderRadius: 10, border: '1px solid var(--separator)' }} />
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                or on the phone, open
                <span style={{ ...S.code, fontSize: 13, padding: '2px 8px', margin: '0 5px' }}>
                  {session.quickUrl || session.shortUrl.replace(/^https?:\/\//, '')}
                </span>
                and enter:
              </div>
              <div style={{
                fontFamily: 'ui-monospace, monospace', fontSize: 34, fontWeight: 700,
                letterSpacing: 10, color: 'var(--accent)', background: 'var(--bg-hover)',
                border: '1px solid var(--separator)', borderRadius: 10,
                padding: '6px 10px 6px 20px',
              }}>
                {session.pin}
              </div>
              <div style={S.status}>
                {phoneConnected
                  ? <><Check size={14} style={{ color: 'var(--tag-1, #34C759)' }} /> Phone connected — waiting for the scan…</>
                  : <><Loader2 size={14} className="spin" /> Waiting for the phone…</>}
              </div>
            </>
          )}

          {phase === 'adjust' && (
            <>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Move size={13} /> Drag the corners to the cover's edges, then straighten.
              </div>
              <canvas
                ref={adjustCanvasRef}
                style={{ borderRadius: 8, border: '1px solid var(--separator)', touchAction: 'none', cursor: 'crosshair' }}
                onPointerDown={onAdjustDown}
                onPointerMove={onAdjustMove}
                onPointerUp={onAdjustUp}
                onPointerCancel={onAdjustUp}
              />
              <div style={{ display: 'flex', gap: 8, width: '100%' }}>
                <button className="btn btn-sm btn-secondary" style={{ flex: 1 }} disabled={adjustBusy}
                        onClick={() => setPhase('imageReady')}>
                  Skip
                </button>
                <button className="btn btn-sm btn-primary" style={{ flex: 2 }} disabled={adjustBusy}
                        onClick={applyAdjust}>
                  {adjustBusy ? 'Straightening…' : 'Straighten & continue'}
                </button>
              </div>
            </>
          )}

          {(phase === 'imageReady' || phase === 'inserting') && previewUrl && (
            <>
              <img src={previewUrl} alt="Scanned cover"
                   style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 8,
                            border: '1px solid var(--separator)', boxShadow: '0 2px 10px rgba(0,0,0,0.12)' }} />
              <button className="btn btn-sm btn-secondary" onClick={openAdjust} disabled={phase === 'inserting'}>
                <Move size={13} /> Adjust corners
              </button>
              <div style={{ fontSize: 13, fontWeight: 600, alignSelf: 'flex-start' }}>Insert at the top of:</div>
              <label style={{ ...S.radioRow, borderColor: target === null ? 'var(--accent)' : 'var(--separator)' }}>
                <input type="radio" name="scan-target" checked={target === null} onChange={() => setTarget(null)} />
                Document (untagged)
              </label>
              {tags.map(t => (
                <label key={t} style={{ ...S.radioRow, borderColor: target === t ? 'var(--accent)' : 'var(--separator)' }}>
                  <input type="radio" name="scan-target" checked={target === t} onChange={() => setTarget(t)} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t}</span>
                </label>
              ))}
              <div style={{ display: 'flex', gap: 8, width: '100%', marginTop: 4 }}>
                <button className="btn btn-sm btn-secondary" style={{ flex: 1 }}
                        onClick={handleDiscard} disabled={phase === 'inserting'}>
                  Discard
                </button>
                <button className="btn btn-sm btn-primary" style={{ flex: 2 }}
                        onClick={handleInsert} disabled={phase === 'inserting'}>
                  {phase === 'inserting' ? 'Inserting…' : 'Insert cover'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
