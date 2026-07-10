import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ProcessedPage } from '../utils/pdfProcessor';
import { runThumbRender, thumbRenderScale } from '../utils/thumbRender';

const GAP = 14;
const GRID_PAD = 32;
const LABEL_H = 22;
const MIN_CELL_W = 130;
const DEFAULT_ASPECT = 11 / 8.5; // portrait page h/w

interface GridLayout {
  cols: number;
  rowHeight: number;
  fitsInView: boolean;
}

/**
 * Pick column count and row height so thumbs grow/shrink with zoom.
 * When all pages fit on screen, constrain by viewport height (no scroll).
 * Many pages: fill width and scroll vertically.
 */
function computeLayout(
  width: number,
  count: number,
  aspect: number,
  zoom = 1,
): GridLayout {
  const W = Math.max(width - GRID_PAD, MIN_CELL_W);
  const minCellW = MIN_CELL_W * zoom;
  const maxCols = Math.max(1, Math.min(count, Math.floor((W + GAP) / (minCellW + GAP))));

  const layoutFor = (cols: number) => {
    const cellW = (W - (cols - 1) * GAP) / cols;
    // Size previews to fill the column width and scroll vertically — so fewer
    // columns (zoom in) directly means bigger thumbnails, instead of being
    // capped to fit the viewport height.
    const pageH = cellW * aspect;
    const rowHeight = pageH + LABEL_H;
    return { cols, pageH, rowHeight };
  };

  // Zoom is authoritative: columns = the zoom-derived cap, so zooming in
  // directly yields fewer, bigger thumbnails. (Previously a fit-maximizing
  // scorer overrode zoom, so changing zoom didn't change the columns.)
  const bestCols = maxCols;
  const final = layoutFor(bestCols);
  return {
    cols: bestCols,
    rowHeight: Math.max(final.rowHeight, 72),
    fitsInView: false,
  };
}

interface GridCellProps {
  pdfDoc: any;
  page: ProcessedPage;
  pageNum: number;
  maxPageH: number;
  scrollRoot: HTMLElement | null;
  isActive: boolean;
  isSelected: boolean;
  isDragged?: boolean;
  dragAttributes?: DraggableAttributes;
  dragListeners?: DraggableSyntheticListeners;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  cellRef?: React.Ref<HTMLButtonElement>;
}

const GridCell: React.FC<GridCellProps> = ({
  pdfDoc, page, pageNum, maxPageH, scrollRoot, isActive, isSelected, isDragged,
  dragAttributes, dragListeners, onClick, onDoubleClick, onContextMenu, cellRef,
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
        } else {
          setVisible(false);
          setRendered(false);
          const c = canvasRef.current;
          if (c && c.width > 0) {
            c.width = 0;
            c.height = 0;
          }
        }
      },
      { root: scrollRoot, rootMargin: '600px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [scrollRoot]);

  // Render the bitmap once per page — NOT on resize. The canvas is displayed
  // via CSS (width:100%, object-fit), so zooming just scales the existing
  // bitmap instead of blanking and re-rendering every visible thumbnail.
  useEffect(() => {
    if (!visible || !pdfDoc || !canvasRef.current) return;
    let active = true;
    let renderTask: any = null;

    async function render() {
      try {
        await runThumbRender(async () => {
          const p = await pdfDoc.getPage(page.pageIndex + 1);
          if (!active) return;
          const rot = (p.rotate + page.rotation) % 360;
          const native = p.getViewport({ scale: 1, rotation: rot });
          // Fixed, generous target resolution so thumbnails stay crisp even
          // when zoomed to large cells — without re-rendering on every zoom.
          const renderScale = thumbRenderScale(1000 / native.width);
          const vp = p.getViewport({ scale: renderScale, rotation: rot });
          const canvas = canvasRef.current;
          if (!canvas || !active) return;
          canvas.width = vp.width;
          canvas.height = vp.height;
          const ctx = canvas.getContext('2d');
          if (!ctx || !active) return;
          renderTask = p.render({ canvasContext: ctx, viewport: vp });
          await renderTask.promise;
          if (active) setRendered(true);
        });
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') console.error('Grid cell render failed:', err);
      }
    }

    render();
    return () => {
      active = false;
      try { renderTask?.cancel(); } catch {}
    };
  }, [visible, pdfDoc, page.pageIndex, page.rotation]);

  return (
    <button
      type="button"
      ref={cellRef}
      className={`section-grid-cell${isActive ? ' active' : ''}${isSelected ? ' selected' : ''}${isDragged ? ' drag-source' : ''}${page.isDeleted ? ' deleted' : ''}`}
      onClick={(e) => onClick(e)}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu?.(e);
      }}
      title={`Page ${pageNum}`}
      {...dragAttributes}
      {...dragListeners}
    >
      <div
        ref={wrapRef}
        className="section-grid-canvas-wrap"
        style={{ height: maxPageH }}
      >
        <canvas
          ref={canvasRef}
          className="section-grid-canvas"
          style={{ visibility: rendered ? 'visible' : 'hidden' }}
        />
        {!rendered && (
          <div className="section-grid-placeholder">
            {!visible ? null : <div className="spinner section-grid-spinner" />}
          </div>
        )}
      </div>
      <span className="section-grid-page-num">{pageNum}</span>
    </button>
  );
};

interface SortableGridCellProps extends Omit<GridCellProps, 'cellRef'> {
  dragIds: Set<number>;
  overPageId: number | null;
  activePageId: number | null;
  insertAfter: boolean;
  forwardRef?: React.Ref<HTMLButtonElement>;
}

const SortableGridCell: React.FC<SortableGridCellProps> = ({
  page,
  dragIds,
  overPageId,
  activePageId,
  insertAfter,
  forwardRef,
  ...cellProps
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: String(page.id),
  });

  const setRef = (el: HTMLButtonElement | null) => {
    setNodeRef(el);
    if (typeof forwardRef === 'function') forwardRef(el);
    else if (forwardRef) (forwardRef as React.MutableRefObject<HTMLButtonElement | null>).current = el;
  };

  const isDragged = dragIds.has(page.id);
  const isOver = overPageId === page.id && activePageId != null && !isDragged;

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    position: 'relative',
    minWidth: 0,
    minHeight: 0,
  };

  if (isDragging || isDragged) {
    style.opacity = 0.38;
  }

  return (
    <div className="sortable-grid-cell" style={style}>
      {isOver && !insertAfter && <div className="grid-insert-line grid-insert-line-before" aria-hidden />}
      {isOver && insertAfter && <div className="grid-insert-line grid-insert-line-after" aria-hidden />}
      <GridCell
        {...cellProps}
        page={page}
        isDragged={isDragged}
        dragAttributes={attributes}
        dragListeners={listeners}
        cellRef={setRef}
      />
    </div>
  );
};

export interface SectionGridEntry {
  page: ProcessedPage;
  idx: number;
}

interface SectionGridPreviewProps {
  pdfDoc: any;
  label: string;
  entries: SectionGridEntry[];
  activeIndex: number;
  selectedIds: Set<number>;
  zoom: number;
  onPageClick: (idx: number, e: React.MouseEvent) => void;
  onPageDoubleClick?: (idx: number) => void;
  onPageContextMenu?: (idx: number, e: React.MouseEvent) => void;
  onReorder?: (dragIds: Set<number>, overPageId: number, insertAfter: boolean) => void;
  onClose: () => void;
  emptyHint?: string;
}

/** All pages in a section laid out in a scrollable grid. */
export const SectionGridPreview: React.FC<SectionGridPreviewProps> = ({
  pdfDoc,
  entries,
  activeIndex,
  selectedIds,
  zoom,
  onPageClick,
  onPageDoubleClick,
  onPageContextMenu,
  onReorder,
  emptyHint,
}) => {
  const activeRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const [layout, setLayout] = useState<GridLayout>({ cols: 2, rowHeight: 160, fitsInView: false });
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  const [dragIds, setDragIds] = useState<Set<number>>(new Set());
  const [activeDragId, setActiveDragId] = useState<number | null>(null);
  const [overPageId, setOverPageId] = useState<number | null>(null);
  const [insertAfter, setInsertAfter] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const entryIndexByPageId = useCallback((pageId: number) => (
    entries.findIndex(e => e.page.id === pageId)
  ), [entries]);

  const resetDrag = () => {
    setDragIds(new Set());
    setActiveDragId(null);
    setOverPageId(null);
    setInsertAfter(false);
  };

  const handleDragStart = (event: DragStartEvent) => {
    const pageId = Number(event.active.id);
    const inGrid = entries.some(e => e.page.id === pageId);
    if (!inGrid) return;

    const ids = selectedIds.has(pageId) && selectedIds.size > 1
      ? new Set([...selectedIds].filter(id => entries.some(e => e.page.id === id)))
      : new Set([pageId]);

    setDragIds(ids);
    setActiveDragId(pageId);
  };

  const handleDragOver = (event: DragOverEvent) => {
    if (!event.over || activeDragId == null) return;
    const overId = Number(event.over.id);
    if (dragIds.has(overId)) return;

    const activeIdx = entryIndexByPageId(activeDragId);
    const overIdx = entryIndexByPageId(overId);
    if (activeIdx < 0 || overIdx < 0) return;

    setOverPageId(overId);
    setInsertAfter(activeIdx < overIdx);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { over } = event;
    if (over && activeDragId != null && onReorder) {
      const overId = Number(over.id);
      if (!dragIds.has(overId)) {
        const activeIdx = entryIndexByPageId(activeDragId);
        const overIdx = entryIndexByPageId(overId);
        if (activeIdx >= 0 && overIdx >= 0) {
          onReorder(dragIds, overId, activeIdx < overIdx);
        }
      }
    }
    resetDrag();
  };

  const sortableIds = entries.map(e => String(e.page.id));
  const activeEntry = activeDragId != null
    ? entries.find(e => e.page.id === activeDragId)
    : null;

  // Must run before GridCell's own effect (which creates its IntersectionObserver
  // using this as `root`) sees its first pass — otherwise every cell briefly
  // observes against the wrong root (root: null → viewport) and gets torn down
  // and recreated a tick later. That handoff is a real race: occasionally the
  // corrected observer's first intersection check doesn't land, leaving a cell
  // permanently unrendered until the whole grid unmounts/remounts (switching to
  // Page view and back). useLayoutEffect forces this update to commit — ref and
  // all — before any passive effect (including GridCell's) runs, so GridCell
  // only ever sees the real scroll container, never null.
  useLayoutEffect(() => {
    setScrollRoot(scrollRef.current);
  }, []);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeIndex]);

  useEffect(() => {
    if (!pdfDoc || !entries[0]) return;
    let alive = true;
    (async () => {
      try {
        const p = await pdfDoc.getPage(entries[0].page.pageIndex + 1);
        const page = entries[0].page;
        const vp = p.getViewport({ scale: 1, rotation: (p.rotate + page.rotation) % 360 });
        if (alive && vp.width > 0) setAspect(vp.height / vp.width);
      } catch { /* keep default */ }
    })();
    return () => { alive = false; };
  }, [pdfDoc, entries]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      setLayout(computeLayout(el.clientWidth, entries.length, aspect, zoom));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [entries.length, aspect, zoom]);

  const maxPageH = Math.max(layout.rowHeight - LABEL_H, 48);

  if (entries.length === 0) {
    return (
      <div className="section-grid-preview">
        <div className="section-grid-empty">
          {emptyHint ?? 'No pages in this section.'}
        </div>
      </div>
    );
  }

  return (
    <div className="section-grid-preview">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={resetDrag}
      >
        <div
          ref={scrollRef}
          className={`section-grid-scroll${layout.fitsInView ? ' section-grid-scroll-fit' : ''}`}
          onContextMenu={(e) => e.preventDefault()}
        >
          <SortableContext items={sortableIds} strategy={rectSortingStrategy}>
            <div
              className={`section-grid${layout.fitsInView ? ' section-grid-fit' : ''}`}
              style={{
                gridTemplateColumns: `repeat(${layout.cols}, 1fr)`,
                gridAutoRows: `${layout.rowHeight}px`,
              }}
            >
              {entries.map(({ page, idx }) => (
                <SortableGridCell
                  key={page.id}
                  pdfDoc={pdfDoc}
                  page={page}
                  pageNum={idx + 1}
                  maxPageH={maxPageH}
                  scrollRoot={scrollRoot}
                  isActive={activeIndex === idx}
                  isSelected={selectedIds.has(page.id)}
                  dragIds={dragIds}
                  overPageId={overPageId}
                  activePageId={activeDragId}
                  insertAfter={insertAfter}
                  forwardRef={activeIndex === idx ? activeRef : undefined}
                  onClick={(e) => onPageClick(idx, e)}
                  onDoubleClick={onPageDoubleClick ? () => onPageDoubleClick(idx) : undefined}
                  onContextMenu={onPageContextMenu ? (e) => onPageContextMenu(idx, e) : undefined}
                />
              ))}
            </div>
          </SortableContext>
        </div>
        <DragOverlay dropAnimation={null}>
          {activeEntry ? (
            <div className="grid-drag-overlay">
              <span className="grid-drag-overlay-label">
                {dragIds.size > 1 ? `${dragIds.size} pages` : `Page ${activeEntry.idx + 1}`}
              </span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
};
