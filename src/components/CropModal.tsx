import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Crop as CropIcon, X } from 'lucide-react';
import { loadPdfDocument, CropRect } from '../utils/pdfProcessor';

/**
 * Rectangular crop editor for any page. Renders the page from the UNCROPPED
 * source (so an existing crop can be expanded back out), lets the user drag a
 * crop box, and returns a normalized CropRect in the page's unrotated space.
 * The page is shown at its current display rotation; the rect is converted
 * back to unrotated coordinates on apply.
 */

interface CropModalProps {
  sourceBuffer: ArrayBuffer;
  pageIndex: number;
  userRotation: number;            // user rotation in our page model (0/90/180/270)
  initialCrop: CropRect | null;
  onApply: (crop: CropRect | null) => void;
  onClose: () => void;
}

type Rot = 0 | 90 | 180 | 270;

// Unrotated → displayed (clockwise by r) and its inverse, on unit-square
// fractions with top-left origin.
function rotPt(x: number, y: number, r: Rot): [number, number] {
  if (r === 90) return [1 - y, x];
  if (r === 180) return [1 - x, 1 - y];
  if (r === 270) return [y, 1 - x];
  return [x, y];
}
function invRotPt(x: number, y: number, r: Rot): [number, number] {
  if (r === 90) return [y, 1 - x];
  if (r === 180) return [1 - x, 1 - y];
  if (r === 270) return [1 - y, x];
  return [x, y];
}

const MIN_FRAC = 0.05; // smallest crop side, as a fraction of the page

export const CropModal: React.FC<CropModalProps> = ({
  sourceBuffer, pageIndex, userRotation, initialCrop, onApply, onClose,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLCanvasElement | null>(null); // rendered page (offscreen)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Crop rect in DISPLAYED fractions {l,t,r,b}.
  const rectRef = useRef({ l: 0, t: 0, r: 1, b: 1 });
  const [, bump] = useState(0);
  const dragRef = useRef<{ mode: string; ox: number; oy: number; start: any } | null>(null);

  const totalRotRef = useRef<Rot>(0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, W, H);

    const { l, t, r, b } = rectRef.current;
    const x = l * W, y = t * H, w = (r - l) * W, h = (b - t) * H;

    // dim outside the crop
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(x, y, w, h);
    ctx.fill('evenodd');
    ctx.restore();

    // crop border
    ctx.strokeStyle = '#007AFF';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    // rule-of-thirds guides
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(x + (w * i) / 3, y); ctx.lineTo(x + (w * i) / 3, y + h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y + (h * i) / 3); ctx.lineTo(x + w, y + (h * i) / 3); ctx.stroke();
    }

    // corner handles
    const cs = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    for (const [hx, hy] of cs) {
      ctx.beginPath();
      ctx.arc(hx, hy, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#007AFF';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }, []);

  // Load + render the page once.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const doc = await loadPdfDocument(sourceBuffer);
        if (!alive) return;
        const page = await doc.getPage(pageIndex + 1);
        const total = (((page.rotate || 0) + userRotation) % 360 + 360) % 360 as Rot;
        totalRotRef.current = total;

        const base = page.getViewport({ scale: 1, rotation: total });
        const maxW = Math.min(700, window.innerWidth * 0.86);
        const maxH = window.innerHeight * 0.6;
        const scale = Math.min(maxW / base.width, maxH / base.height);
        const dpr = window.devicePixelRatio || 1;
        const vp = page.getViewport({ scale: scale * dpr, rotation: total });

        const off = document.createElement('canvas');
        off.width = Math.round(vp.width);
        off.height = Math.round(vp.height);
        await page.render({ canvasContext: off.getContext('2d')!, viewport: vp }).promise;
        if (!alive) return;
        imgRef.current = off;

        const canvas = canvasRef.current!;
        canvas.width = off.width;
        canvas.height = off.height;
        canvas.style.width = `${Math.round(off.width / dpr)}px`;
        canvas.style.height = `${Math.round(off.height / dpr)}px`;

        // Initialize the rect from an existing crop (mapped to displayed space).
        if (initialCrop) {
          const [dx1, dy1] = rotPt(initialCrop.x, initialCrop.y, total);
          const [dx2, dy2] = rotPt(initialCrop.x + initialCrop.w, initialCrop.y + initialCrop.h, total);
          rectRef.current = {
            l: Math.min(dx1, dx2), t: Math.min(dy1, dy2),
            r: Math.max(dx1, dx2), b: Math.max(dy1, dy2),
          };
        } else {
          rectRef.current = { l: 0, t: 0, r: 1, b: 1 };
        }
        setLoading(false);
        requestAnimationFrame(draw);
      } catch (e: any) {
        if (alive) { setError(e?.message || 'Could not load the page.'); setLoading(false); }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const frac = (e: React.PointerEvent) => {
    const canvas = canvasRef.current!;
    const box = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (e.clientY - box.top) / box.height)),
    };
  };

  const hitTest = (fx: number, fy: number): string => {
    const { l, t, r, b } = rectRef.current;
    const box = canvasRef.current!.getBoundingClientRect();
    const tol = 14 / box.width; // ~14px grab radius in fractions
    const nearX = (v: number) => Math.abs(fx - v) < tol;
    const nearY = (v: number) => Math.abs(fy - v) < tol;
    if (nearX(l) && nearY(t)) return 'nw';
    if (nearX(r) && nearY(t)) return 'ne';
    if (nearX(r) && nearY(b)) return 'se';
    if (nearX(l) && nearY(b)) return 'sw';
    if (nearX(l) && fy > t && fy < b) return 'w';
    if (nearX(r) && fy > t && fy < b) return 'e';
    if (nearY(t) && fx > l && fx < r) return 'n';
    if (nearY(b) && fx > l && fx < r) return 's';
    if (fx > l && fx < r && fy > t && fy < b) return 'move';
    return '';
  };

  const onDown = (e: React.PointerEvent) => {
    const { x, y } = frac(e);
    const mode = hitTest(x, y);
    if (!mode) return;
    dragRef.current = { mode, ox: x, oy: y, start: { ...rectRef.current } };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const { x, y } = frac(e);
    const s = d.start;
    let { l, t, r, b } = s;
    const dx = x - d.ox, dy = y - d.oy;
    if (d.mode === 'move') {
      const w = r - l, h = b - t;
      l = Math.max(0, Math.min(1 - w, s.l + dx)); r = l + w;
      t = Math.max(0, Math.min(1 - h, s.t + dy)); b = t + h;
    } else {
      if (d.mode.includes('w')) l = Math.min(r - MIN_FRAC, Math.max(0, s.l + dx));
      if (d.mode.includes('e')) r = Math.max(l + MIN_FRAC, Math.min(1, s.r + dx));
      if (d.mode.includes('n')) t = Math.min(b - MIN_FRAC, Math.max(0, s.t + dy));
      if (d.mode.includes('s')) b = Math.max(t + MIN_FRAC, Math.min(1, s.b + dy));
    }
    rectRef.current = { l, t, r, b };
    draw();
    e.preventDefault();
  };

  const onUp = () => { dragRef.current = null; };

  const reset = () => { rectRef.current = { l: 0, t: 0, r: 1, b: 1 }; draw(); bump(n => n + 1); };

  const apply = () => {
    const R = totalRotRef.current;
    const { l, t, r, b } = rectRef.current;
    const [ux1, uy1] = invRotPt(l, t, R);
    const [ux2, uy2] = invRotPt(r, b, R);
    const x = Math.min(ux1, ux2), y = Math.min(uy1, uy2);
    const w = Math.abs(ux2 - ux1), h = Math.abs(uy2 - uy1);
    // Treat a near-full selection as "no crop".
    if (x < 0.01 && y < 0.01 && w > 0.98 && h > 0.98) { onApply(null); return; }
    onApply({ x, y, w, h });
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        style={{ background: 'var(--bg-card)', borderRadius: 14, width: 'min(760px, 94vw)', maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--separator)' }}>
          <CropIcon size={16} style={{ color: 'var(--accent)' }} />
          <b style={{ fontSize: 14, flex: 1 }}>Crop page</b>
          <button className="btn-icon" onClick={onClose} title="Close"><X size={15} /></button>
        </div>

        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          {error ? (
            <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>
          ) : (
            <>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                Drag the edges or corners to set the crop. The crop is non-destructive and re-editable.
              </div>
              <div style={{ position: 'relative' }}>
                {loading && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 260, minHeight: 200 }}>
                    <div className="spinner" />
                  </div>
                )}
                <canvas
                  ref={canvasRef}
                  style={{ display: loading ? 'none' : 'block', borderRadius: 6, border: '1px solid var(--separator)', touchAction: 'none', cursor: 'crosshair', boxShadow: '0 2px 12px rgba(0,0,0,0.12)' }}
                  onPointerDown={onDown}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onPointerCancel={onUp}
                />
              </div>
            </>
          )}
        </div>

        {!error && (
          <div style={{ display: 'flex', gap: 8, padding: '0 18px 18px', width: '100%' }}>
            <button className="btn btn-sm btn-secondary" style={{ flex: 1 }} onClick={reset} disabled={loading}>
              Reset (full page)
            </button>
            <button className="btn btn-sm btn-secondary" style={{ flex: 1 }} onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-sm btn-primary" style={{ flex: 2 }} onClick={apply} disabled={loading}>
              Apply crop
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
