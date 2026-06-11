import React, { useEffect, useRef, useState } from 'react';

interface LargePagePreviewProps {
  pdfDoc: any;
  pageIndex: number;
  rotation: number;
  zoom?: number;
}

export const LargePagePreview: React.FC<LargePagePreviewProps> = ({
  pdfDoc,
  pageIndex,
  rotation,
  zoom = 1.0,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [containerVersion, setContainerVersion] = useState(0);
  // CSS display size at zoom=1 (fit). Zoom is applied by scaling this with CSS only.
  const [fitSize, setFitSize] = useState({ w: 0, h: 0 });
  // Track whether we've rendered at least once for this page — suppresses spinner on resize
  const hasRenderedPage = useRef<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerVersion(v => v + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-render when page/rotation/container size changes — NOT when zoom changes
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current || !containerRef.current) return;
    let active = true;
    let renderTask: any = null;

    const isNewPage = hasRenderedPage.current !== pageIndex;

    async function render() {
      try {
        if (isNewPage) {
          setLoading(true);
          setError(false);
        }

        const page = await pdfDoc.getPage(pageIndex + 1);
        if (!active) return;

        const rot = (page.rotate + rotation) % 360;
        const native = page.getViewport({ scale: 1, rotation: rot });

        const container = containerRef.current!;
        const availW = Math.max(container.clientWidth - 48, 100);
        const availH = Math.max(container.clientHeight - 48, 100);

        const fitScale = Math.min(availW / native.width, availH / native.height);
        // Render at 2× for crisp quality — zoom is purely CSS, never triggers a re-render
        const renderScale = Math.min(fitScale * 2, 4.0);

        const viewport = page.getViewport({ scale: renderScale, rotation: rot });
        const canvas = canvasRef.current!;
        const ctx = canvas.getContext('2d');
        if (!ctx || !active) return;

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        renderTask = page.render({ canvasContext: ctx, viewport });
        await renderTask.promise;

        if (active) {
          hasRenderedPage.current = pageIndex;
          setFitSize({ w: native.width * fitScale, h: native.height * fitScale });
        }
      } catch (err: any) {
        if (err?.name === 'RenderingCancelledException') return;
        if (active) setError(true);
      } finally {
        if (active) setLoading(false);
      }
    }

    render();
    return () => {
      active = false;
      try { renderTask?.cancel(); } catch {}
    };
  }, [pdfDoc, pageIndex, rotation, containerVersion]); // zoom intentionally excluded

  const displayW = fitSize.w * zoom;
  const displayH = fitSize.h * zoom;

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        overflow: zoom > 1 ? 'auto' : 'hidden',
        display: 'flex',
        alignItems: zoom > 1 ? 'flex-start' : 'center',
        justifyContent: zoom > 1 ? 'flex-start' : 'center',
        padding: zoom > 1 ? 24 : 0,
        position: 'relative',
        boxSizing: 'border-box',
      }}
    >
      {loading && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2 }}>
          <div className="spinner" />
        </div>
      )}
      {error && <span style={{ color: 'var(--danger)', fontSize: 13 }}>Failed to render page.</span>}
      <canvas
        ref={canvasRef}
        style={{
          // CSS dimensions change instantly on zoom — no re-render triggered
          width: displayW > 0 ? displayW : undefined,
          height: displayH > 0 ? displayH : undefined,
          display: loading && hasRenderedPage.current !== pageIndex ? 'none' : 'block',
          flexShrink: 0,
          borderRadius: 2,
        }}
      />
    </div>
  );
};
