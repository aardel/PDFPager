import React, { useEffect, useRef, useState } from 'react';
import { ProcessedPage } from '../utils/pdfProcessor';

interface PageSlotProps {
  pdfDoc: any;
  page: ProcessedPage;
  zoom: number;
  isActive: boolean;
  containerWidth: number;
  containerHeight: number;
  defaultH: number;
  onRendered: (pageId: number, w: number, h: number) => void;
  slotRef: (el: HTMLDivElement | null) => void;
}

const PageSlot: React.FC<PageSlotProps> = ({
  pdfDoc, page, zoom, isActive, containerWidth, containerHeight, defaultH, onRendered, slotRef,
}) => {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [shouldRender, setShouldRender] = useState(false);
  const [fitSize, setFitSize] = useState<{ w: number; h: number } | null>(null);
  const lastRenderedKey = useRef('');

  const setRef = (el: HTMLDivElement | null) => {
    outerRef.current = el;
    slotRef(el);
  };

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShouldRender(true);
        } else {
          // Page scrolled far off-screen: release the canvas backing store
          // (full-res canvases are ~10MB+ each — keeping all of them alive
          // breaks 200+ page documents). fitSize is kept so the placeholder
          // holds its exact dimensions and scroll position doesn't jump;
          // re-entering the margin re-renders via the same observer.
          setShouldRender(false);
          const c = canvasRef.current;
          if (c && c.width > 0) {
            c.width = 0;
            c.height = 0;
          }
          lastRenderedKey.current = '';
        }
      },
      { rootMargin: '800px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const renderKey = `${page.pageIndex}-${page.rotation}-${containerWidth}-${containerHeight}`;
  useEffect(() => {
    if (lastRenderedKey.current && lastRenderedKey.current !== renderKey) {
      setShouldRender(true);
    }
  }, [renderKey]);

  useEffect(() => {
    if (!shouldRender || !pdfDoc || !canvasRef.current || containerWidth < 10) return;
    let active = true;
    let renderTask: any = null;

    async function doRender() {
      try {
        const p = await pdfDoc.getPage(page.pageIndex + 1);
        if (!active) return;
        const rot = (p.rotate + page.rotation) % 360;
        const native = p.getViewport({ scale: 1, rotation: rot });
        const availW = Math.max(containerWidth - 48, 100);
        const availH = Math.max(containerHeight - 24, 100);
        const fitScale = Math.min(availW / native.width, availH / native.height);
        const renderScale = Math.min(fitScale * 2, 4.0);
        const vp = p.getViewport({ scale: renderScale, rotation: rot });
        if (!active || !canvasRef.current) return;
        const canvas = canvasRef.current;
        canvas.width = vp.width;
        canvas.height = vp.height;
        const ctx = canvas.getContext('2d');
        if (!ctx || !active) return;
        renderTask = p.render({ canvasContext: ctx, viewport: vp });
        await renderTask.promise;
        if (active) {
          const fw = native.width * fitScale;
          const fh = native.height * fitScale;
          lastRenderedKey.current = renderKey;
          setFitSize({ w: fw, h: fh });
          onRendered(page.id, fw, fh);
        }
      } catch (err: any) {
        if (err?.name === 'RenderingCancelledException') return;
      }
    }
    doRender();
    return () => { active = false; try { renderTask?.cancel(); } catch {} };
  }, [shouldRender, pdfDoc, page.pageIndex, page.rotation, containerWidth, containerHeight]);

  const displayW = fitSize ? fitSize.w * zoom : Math.max(containerWidth - 48, 100);
  const displayH = fitSize ? fitSize.h * zoom : defaultH * zoom;

  return (
    <div
      ref={setRef}
      style={{
        display: 'flex',
        justifyContent: 'center',
        padding: '12px 24px',
        minWidth: displayW + 48,
        boxSizing: 'border-box',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          width: displayW,
          height: displayH,
          // White paper placeholder while the canvas buffer is released
          // (released canvases are transparent).
          background: '#fff',
          borderRadius: 3,
          flexShrink: 0,
          boxShadow: isActive
            ? '0 0 0 2px var(--accent), 0 4px 24px rgba(0,0,0,0.18)'
            : '0 2px 12px rgba(0,0,0,0.12)',
          transition: 'box-shadow 0.15s',
        }}
      />
    </div>
  );
};

interface ScrollablePreviewProps {
  pdfDoc: any;
  pages: ProcessedPage[];
  activeIndex: number;
  zoom: number;
  onActiveIndexChange: (idx: number) => void;
  scrollToRef: React.MutableRefObject<((idx: number) => void) | null>;
}

export const ScrollablePreview: React.FC<ScrollablePreviewProps> = ({
  pdfDoc, pages, activeIndex, zoom, onActiveIndexChange, scrollToRef,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const slotEls = useRef<(HTMLDivElement | null)[]>([]);
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [pageSizes, setPageSizes] = useState<Record<number, { w: number; h: number }>>({});
  const isProgrammatic = useRef(false);

  const pagesRef = useRef(pages);
  const visiblePagesRef = useRef<ProcessedPage[]>([]);
  useEffect(() => {
    pagesRef.current = pages;
    visiblePagesRef.current = pages.filter(p => !p.isDeleted);
  });

  const visiblePages = pages.filter(p => !p.isDeleted);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setContainerWidth(w => {
        if (Math.abs(w - el.clientWidth) > 4) setPageSizes({});
        return el.clientWidth;
      });
      setContainerHeight(el.clientHeight);
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    setContainerHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    scrollToRef.current = (globalIdx: number) => {
      const vp = visiblePagesRef.current;
      const pg = pagesRef.current;
      const visIdx = vp.findIndex(p => pg.indexOf(p) === globalIdx);
      if (visIdx < 0) return;
      const el = slotEls.current[visIdx];
      if (!el || !containerRef.current) return;
      isProgrammatic.current = true;
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setTimeout(() => { isProgrammatic.current = false; }, 900);
    };
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      if (isProgrammatic.current) return;
      const top = container.getBoundingClientRect().top;
      const h = container.clientHeight;

      let bestIdx = 0;
      let bestPx = -1;
      slotEls.current.forEach((el, visIdx) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const visTop = Math.max(r.top, top);
        const visBot = Math.min(r.bottom, top + h);
        const px = Math.max(0, visBot - visTop);
        if (px > bestPx) { bestPx = px; bestIdx = visIdx; }
      });

      const vp = visiblePagesRef.current;
      const pg = pagesRef.current;
      if (vp[bestIdx]) {
        const globalIdx = pg.indexOf(vp[bestIdx]);
        if (globalIdx !== -1) onActiveIndexChange(globalIdx);
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [onActiveIndexChange]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', overflowY: 'auto', overflowX: 'auto' }}
    >
      <div style={{ paddingTop: 4, paddingBottom: 24 }}>
        {visiblePages.map((page, visIdx) => {
          const globalIdx = pages.indexOf(page);
          const stored = pageSizes[page.id];
          const availW = Math.max(containerWidth - 48, 100);
          const availH = Math.max(containerHeight - 24, 100);
          const defaultFitW = Math.min(availW, availH / 1.414);
          const defaultH = stored ? stored.h : defaultFitW * 1.414;
          return (
            <PageSlot
              key={page.id}
              pdfDoc={pdfDoc}
              page={page}
              zoom={zoom}
              isActive={globalIdx === activeIndex}
              containerWidth={containerWidth}
              containerHeight={containerHeight}
              defaultH={defaultH}
              onRendered={(id, w, h) => setPageSizes(prev => ({ ...prev, [id]: { w, h } }))}
              slotRef={(el) => { slotEls.current[visIdx] = el; }}
            />
          );
        })}
      </div>
    </div>
  );
};
