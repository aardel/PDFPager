import React, { useEffect, useRef, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { detectIfPageIsBlank } from '../utils/pdfProcessor';
import { runThumbRender, SIDEBAR_THUMB_SCALE } from '../utils/thumbRender';
import { X, Check } from 'lucide-react';

interface PageThumbnailProps {
  id: string;
  pageIndex: number;
  pdfDoc: any;
  isDeleted: boolean;
  isBlank: boolean;
  rotation: number;
  tag?: string;
  isActive: boolean;
  isSelected: boolean;
  isSplitActive?: boolean;
  disableDrag?: boolean;
  onToggleDelete: () => void;
  onMarkBlank: (isBlank: boolean) => void;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export const PageThumbnail: React.FC<PageThumbnailProps> = ({
  id,
  pageIndex,
  pdfDoc,
  isDeleted,
  isBlank,
  rotation,
  tag,
  isActive,
  isSelected,
  isSplitActive,
  disableDrag,
  onToggleDelete,
  onMarkBlank,
  onClick,
  onContextMenu,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(false);

  // Keep blank-detection callbacks out of the render effect's deps — they
  // change identity every parent render and would otherwise cancel/restart
  // every thumbnail render on each keystroke (thrashes large documents).
  const isBlankRef = useRef(isBlank);
  isBlankRef.current = isBlank;
  const onMarkBlankRef = useRef(onMarkBlank);
  onMarkBlankRef.current = onMarkBlank;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: disableDrag });

  const setRef = (el: HTMLDivElement | null) => {
    rootRef.current = el;
    setNodeRef(el);
  };

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: '200px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!pdfDoc || !visible) return;
    let active = true;
    let renderTask: any = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    async function loadThumbnail(attempt: number) {
      if (!canvasRef.current) return;
      try {
        setLoading(true);
        await runThumbRender(async () => {
          const page = await pdfDoc.getPage(pageIndex + 1);
          if (!active || !canvasRef.current) return;

          const viewport = page.getViewport({
            scale: SIDEBAR_THUMB_SCALE,
            rotation: (page.rotate + rotation) % 360,
          });
          const ctx = canvasRef.current.getContext('2d');
          if (!ctx) return;

          canvasRef.current.height = viewport.height;
          canvasRef.current.width = viewport.width;

          renderTask = page.render({ canvasContext: ctx, viewport });
          await renderTask.promise;

          if (active && canvasRef.current) {
            const detectedBlank = detectIfPageIsBlank(canvasRef.current);
            if (detectedBlank && !isBlankRef.current) onMarkBlankRef.current(true);
          }
        });
      } catch (err: any) {
        if (err?.name === 'RenderingCancelledException') return;
        console.error(`Thumbnail render failed (page ${pageIndex + 1}, rotation ${rotation}, attempt ${attempt + 1}):`, err);
        if (active && attempt < 1) {
          retryTimer = setTimeout(() => { if (active) loadThumbnail(attempt + 1); }, 250);
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    loadThumbnail(0);
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      try { renderTask?.cancel(); } catch {}
    };
  }, [pageIndex, pdfDoc, rotation, visible]);

  return (
    <div
      ref={setRef}
      style={style}
      data-thumb-id={id}
      className={`thumb-card${isActive ? ' active' : ''}${isSelected ? ' selected' : ''}${isSplitActive ? ' split-active' : ''}${isDeleted ? ' deleted' : ''}${isDragging ? ' dragging' : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e); } : undefined}
      {...attributes}
      {...listeners}
    >
      {/* Selection indicator */}
      <div
        className={`thumb-select-dot${isSelected ? ' checked' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          onClick({ ...e, ctrlKey: true } as React.MouseEvent);
        }}
      >
        {isSelected && <Check size={9} strokeWidth={3} />}
      </div>

      {/* Thumbnail canvas */}
      <div className="thumb-canvas-wrap">
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}>
            <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
          </div>
        )}
        <canvas ref={canvasRef} />
        {isBlank && !isDeleted && <span className="blank-badge">blank</span>}
        {isDeleted && <div className="thumb-deleted-line" />}
      </div>

      {tag && !isDeleted && (
        <div className="thumb-meta">
          <span className="thumb-tag-pill tag-label-text">{tag}</span>
        </div>
      )}

      <button
        className="thumb-delete-btn"
        style={isDeleted ? { opacity: 1, background: 'var(--danger)', color: 'white', borderColor: 'var(--danger)' } : {}}
        title={isDeleted ? 'Restore page' : 'Delete page'}
        onClick={(e) => { e.stopPropagation(); onToggleDelete(); }}
      >
        <X size={11} />
      </button>
    </div>
  );
};
