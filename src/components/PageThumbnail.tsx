import React, { useEffect, useRef, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { detectIfPageIsBlank } from '../utils/pdfProcessor';
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
  onToggleDelete,
  onMarkBlank,
  onClick,
  onContextMenu,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  useEffect(() => {
    if (!pdfDoc) return;
    let active = true;
    let renderTask: any = null;

    async function loadThumbnail() {
      if (!canvasRef.current) return;
      try {
        setLoading(true);
        const page = await pdfDoc.getPage(pageIndex + 1);
        if (!active) return;

        const viewport = page.getViewport({ scale: 0.28, rotation: (page.rotate + rotation) % 360 });
        const ctx = canvasRef.current.getContext('2d');
        if (!ctx) return;

        canvasRef.current.height = viewport.height;
        canvasRef.current.width = viewport.width;

        renderTask = page.render({ canvasContext: ctx, viewport });
        await renderTask.promise;

        if (active && canvasRef.current) {
          const detectedBlank = detectIfPageIsBlank(canvasRef.current);
          if (detectedBlank && !isBlank) onMarkBlank(true);
        }
      } catch (err: any) {
        if (err?.name === 'RenderingCancelledException') return;
      } finally {
        if (active) setLoading(false);
      }
    }

    loadThumbnail();
    return () => {
      active = false;
      try { renderTask?.cancel(); } catch {}
    };
  }, [pageIndex, pdfDoc, rotation]);

  return (
    <div
      ref={setNodeRef}
      style={style}
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
          // Simulate a ctrl-click to toggle selection without changing preview
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

      {/* Meta */}
      <div className="thumb-meta">
        <span className="thumb-num">Page {pageIndex + 1}</span>
        {tag && !isDeleted && (
          <span className="thumb-tag-pill tag-label-text">{tag}</span>
        )}
      </div>

      {/* Delete / restore button */}
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
