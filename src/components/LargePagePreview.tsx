import React, { useEffect, useRef, useState } from 'react';

interface LargePagePreviewProps {
  pdfDoc: any;
  pageIndex: number;
  rotation: number;
  zoom?: number;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export const LargePagePreview: React.FC<LargePagePreviewProps> = ({
  pdfDoc,
  pageIndex,
  rotation,
  zoom = 1.0,
  onContextMenu,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  // CSS display size at zoom=1 (fit). Zoom is applied when painting to screen.
  const [fitSize, setFitSize] = useState({ w: 0, h: 0 });
  const hasRenderedPage = useRef<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-render PDF when page/rotation/container size changes — NOT when zoom changes
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current || containerSize.w < 10 || containerSize.h < 10) return;
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

        const availW = Math.max(containerSize.w, 100);
        const availH = Math.max(containerSize.h, 100);

        const fitScale = Math.min(availW / native.width, availH / native.height);
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
  }, [pdfDoc, pageIndex, rotation, containerSize.w, containerSize.h]);

  let displayW = fitSize.w * zoom;
  let displayH = fitSize.h * zoom;
  const needsScroll = zoom > 1.001;

  // At fit zoom, never exceed the visible pane (guards layout timing / toolbar resize).
  if (!needsScroll && containerSize.w > 0 && containerSize.h > 0 && fitSize.w > 0) {
    const scale = Math.min(
      1,
      containerSize.w / displayW,
      containerSize.h / displayH,
    );
    displayW *= scale;
    displayH *= scale;
  }

  return (
    <div
      ref={containerRef}
      className="large-page-preview"
      style={{
        overflow: needsScroll ? 'auto' : 'hidden',
        alignItems: needsScroll ? 'flex-start' : 'center',
        justifyContent: needsScroll ? 'flex-start' : 'center',
        padding: needsScroll ? 12 : 0,
      }}
      onContextMenu={onContextMenu}
    >
      {loading && (
        <div className="large-page-preview-loading">
          <div className="spinner" />
        </div>
      )}
      {error && <span style={{ color: 'var(--danger)', fontSize: 13 }}>Failed to render page.</span>}
      <canvas
        ref={canvasRef}
        style={{
          width: displayW > 0 ? displayW : undefined,
          height: displayH > 0 ? displayH : undefined,
          maxWidth: needsScroll ? undefined : '100%',
          maxHeight: needsScroll ? undefined : '100%',
          display: loading && hasRenderedPage.current !== pageIndex ? 'none' : 'block',
          flexShrink: 0,
          borderRadius: 2,
          background: '#fff',
          boxShadow: '0 2px 12px rgba(0,0,0,0.12)',
        }}
      />
    </div>
  );
};
