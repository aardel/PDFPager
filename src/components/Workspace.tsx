import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { PageThumbnail } from './PageThumbnail';
import { ScrollablePreview } from './ScrollablePreview';
import { BasicTagsEditor } from './BasicTagsEditor';
import { PageContextMenu } from './PageContextMenu';
import { ProcessedPage, loadPdfDocument } from '../utils/pdfProcessor';
import { supportsFileSystemAccess, pickOutputDirectory } from '../utils/fileSystem';
import {
  getExportFileName,
  isExportNameModified,
  sanitizeExportFileName,
} from '../utils/tagUtils';
import {
  FolderOpen,
  RotateCw,
  RotateCcw,
  Trash2,
  Settings,
  X,
  Play,
  Tag,
  Columns2,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Tags,
  ChevronDown,
  ChevronRight,
  List,
  LayoutList,
  Undo2,
  Redo2,
} from 'lucide-react';

interface WorkspaceProps {
  pdfFile?: File;
  pdfBuffer: ArrayBuffer;
  pages: ProcessedPage[];
  presets: string[];
  exportNames: Record<string, string>;
  outputDirectory: string;
  onSetPages: (pages: ProcessedPage[]) => void;
  /** Updates pages without recording undo history (blank auto-detection). */
  onSetPagesSilent: (pages: ProcessedPage[]) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSetPresets: (presets: string[]) => void;
  onSetExportNames: (names: Record<string, string>) => void;
  onSetOutputDirectory: (dir: string) => void;
  onExport: (targetTag?: string) => void;
  onBack: () => void;
  isExporting: boolean;
  exportProgress: string;
}

const ZOOM_STEPS = [1.0, 1.25, 1.5, 2.0, 2.5, 3.0];
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 560;
const SIDEBAR_DEFAULT = 300;

export const Workspace: React.FC<WorkspaceProps> = ({
  pdfBuffer,
  pages,
  presets,
  exportNames,
  outputDirectory,
  onSetPages,
  onSetPagesSilent,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSetPresets,
  onSetExportNames,
  onSetOutputDirectory,
  onExport,
  onBack,
  isExporting,
  exportProgress,
}) => {
  // Primary preview index
  const [primaryIndex, setPrimaryIndex] = useState(0);
  // Secondary split pane index (null = single view)
  const [splitIndex, setSplitIndex] = useState<number | null>(null);
  // Which pane is "active" — thumbnail clicks load into the active pane
  const [activePaneIsLeft, setActivePaneIsLeft] = useState(true);
  const isSplitView = splitIndex !== null;
  // Multi-select
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);
  // Zoom — independent per pane
  const [leftZoomIdx, setLeftZoomIdx] = useState(0);
  const [rightZoomIdx, setRightZoomIdx] = useState(0);
  const activeZoomIdx = activePaneIsLeft ? leftZoomIdx : rightZoomIdx;
  const setActiveZoomIdx = (fn: (i: number) => number) => {
    if (activePaneIsLeft) setLeftZoomIdx(fn);
    else setRightZoomIdx(fn);
  };
  // PDF
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [loadingPdf, setLoadingPdf] = useState(true);
  // Settings panel
  const [showSettings, setShowSettings] = useState(false);
  const [showTagsPanel, setShowTagsPanel] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const tagsPanelRef = useRef<HTMLDivElement>(null);

  // Scroll-to functions exposed by each ScrollablePreview
  const scrollToPageRef = useRef<((idx: number) => void) | null>(null);
  const scrollToSplitRef = useRef<((idx: number) => void) | null>(null);
  // Set to true before a programmatic index change so the effect can trigger a scroll
  const shouldScrollRef = useRef(false);
  const shouldScrollSplitRef = useRef(false);

  // When primaryIndex changes programmatically, scroll left pane
  useEffect(() => {
    if (shouldScrollRef.current) {
      shouldScrollRef.current = false;
      scrollToPageRef.current?.(primaryIndex);
    }
  }, [primaryIndex]);

  // When splitIndex changes programmatically, scroll right pane
  useEffect(() => {
    if (shouldScrollSplitRef.current && splitIndex !== null) {
      shouldScrollSplitRef.current = false;
      scrollToSplitRef.current?.(splitIndex);
    }
  }, [splitIndex]);

  // Sidebar view: 'pages' = flat ordered list, 'groups' = grouped by tag
  const [sidebarView, setSidebarView] = useState<'pages' | 'groups'>('groups');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) =>
    setCollapsedGroups(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });

  // Resizable sidebar width
  const workspaceRef = useRef<HTMLDivElement>(null);
  const isResizingSidebar = useRef(false);
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('pdf_pager_sidebar_width');
    const n = saved ? parseInt(saved, 10) : SIDEBAR_DEFAULT;
    const w = Number.isFinite(n) ? n : SIDEBAR_DEFAULT;
    return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));
  });
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  sidebarWidthRef.current = sidebarWidth;

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isResizingSidebar.current || !workspaceRef.current) return;
      const left = workspaceRef.current.getBoundingClientRect().left;
      const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX - left));
      setSidebarWidth(w);
    };
    const onUp = () => {
      if (!isResizingSidebar.current) return;
      isResizingSidebar.current = false;
      setIsSidebarResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('pdf_pager_sidebar_width', String(sidebarWidthRef.current));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    isResizingSidebar.current = true;
    setIsSidebarResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // Right-click tag menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; pageIdx: number } | null>(null);

  // Inline export-name edit in group header (keyed by tag string)
  const [editingExportTag, setEditingExportTag] = useState<string | null>(null);
  const [exportEditValue, setExportEditValue] = useState('');

  // Close tags panel on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (tagsPanelRef.current && !tagsPanelRef.current.contains(e.target as Node))
        setShowTagsPanel(false);
    };
    if (showTagsPanel) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showTagsPanel]);

  // Close settings on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setShowSettings(false);
      }
    };
    if (showSettings) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSettings]);

  // Load PDF
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        setLoadingPdf(true);
        const doc = await loadPdfDocument(pdfBuffer);
        if (active) setPdfDoc(doc);
      } finally {
        if (active) setLoadingPdf(false);
      }
    }
    load();
    return () => { active = false; };
  }, [pdfBuffer]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        shouldScrollRef.current = true;
        setPrimaryIndex(i => Math.min(i + 1, pages.length - 1));
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        shouldScrollRef.current = true;
        setPrimaryIndex(i => Math.max(i - 1, 0));
      } else if (e.key === 'd' || e.key === 'D') {
        const page = pages[primaryIndex];
        if (page) toggleDelete(page.id);
      } else if (e.key === 'Escape') {
        setSelectedIds(new Set());
      } else if ((e.key === '+' || e.key === '=') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setActiveZoomIdx(i => Math.min(i + 1, ZOOM_STEPS.length - 1));
      } else if (e.key === '-' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setActiveZoomIdx(i => Math.max(i - 1, 0));
      } else if (e.key === '0' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setActiveZoomIdx(() => 0);
      } else if (!isNaN(parseInt(e.key)) && parseInt(e.key) >= 1 && parseInt(e.key) <= presets.length) {
        const tag = presets[parseInt(e.key) - 1];
        tagPages(tag);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [primaryIndex, pages, presets, selectedIds]);

  // Ctrl+wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setActiveZoomIdx(i => e.deltaY < 0
      ? Math.min(i + 1, ZOOM_STEPS.length - 1)
      : Math.max(i - 1, 0));
  }, [activePaneIsLeft]);

  // Thumbnail click — supports Shift/Cmd multi-select; otherwise loads into active pane
  const handleThumbClick = useCallback((idx: number, e: React.MouseEvent) => {
    e.preventDefault();
    const pageId = pages[idx].id;

    if (e.shiftKey && lastClickedIndex !== null) {
      // Range select for bulk tagging
      const min = Math.min(lastClickedIndex, idx);
      const max = Math.max(lastClickedIndex, idx);
      setSelectedIds(prev => new Set([...prev, ...pages.slice(min, max + 1).map(p => p.id)]));
    } else if (e.metaKey || e.ctrlKey) {
      // Toggle individual for bulk tagging
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(pageId)) next.delete(pageId);
        else next.add(pageId);
        return next;
      });
    } else {
      // Normal click — load into whichever pane is active
      setSelectedIds(new Set([pageId]));
      if (isSplitView && !activePaneIsLeft) {
        shouldScrollSplitRef.current = true;
        setSplitIndex(idx);
      } else {
        shouldScrollRef.current = true;
        setPrimaryIndex(idx);
      }
    }

    setLastClickedIndex(idx);
  }, [pages, lastClickedIndex, isSplitView, activePaneIsLeft]);

  // Tag selected pages, or the active page when nothing is selected
  const tagPages = useCallback((tag: string | undefined, overrideTargets?: Set<number>) => {
    const targets = overrideTargets ?? (
      selectedIds.size > 0
        ? selectedIds
        : new Set(pages[primaryIndex] ? [pages[primaryIndex].id] : [])
    );
    if (!targets.size) return;

    onSetPages(pages.map(p => targets.has(p.id) ? { ...p, tag } : p));

    // Auto-advance after tagging a single page
    if (targets.size === 1) {
      const taggedIdx = pages.findIndex(p => p.id === [...targets][0]);
      let next = taggedIdx + 1;
      while (next < pages.length && pages[next].isDeleted) next++;
      if (next < pages.length) {
        shouldScrollRef.current = true;
        setPrimaryIndex(next);
      }
    }
  }, [pages, primaryIndex, selectedIds, onSetPages]);

  const getContextMenuTargets = useCallback((pageIdx: number): Set<number> => {
    const page = pages[pageIdx];
    if (!page) return new Set();
    if (selectedIds.size > 1 && selectedIds.has(page.id)) return selectedIds;
    return new Set([page.id]);
  }, [pages, selectedIds]);

  const toggleDelete = useCallback((pageId: number) => {
    onSetPages(pages.map(p => p.id === pageId ? { ...p, isDeleted: !p.isDeleted } : p));
  }, [pages, onSetPages]);

  const rotatePage = useCallback((pageId: number, degrees: number) => {
    onSetPages(pages.map(p => p.id === pageId ? { ...p, rotation: (p.rotation + degrees + 360) % 360 } : p));
  }, [pages, onSetPages]);

  const autoDeleteBlanks = () => {
    onSetPages(pages.map(p => p.isBlank ? { ...p, isDeleted: true } : p));
  };

  const handleSelectDirectory = async () => {
    if (window.electronAPI) {
      const path = await window.electronAPI.selectDirectory();
      if (path) onSetOutputDirectory(path);
    } else if (supportsFileSystemAccess()) {
      const name = await pickOutputDirectory();
      if (name) onSetOutputDirectory(name);
    } else {
      onSetOutputDirectory('C:/Mock/PDFPager/Output');
    }
  };

  const handlePresetRename = useCallback((oldName: string, newName: string) => {
    onSetPages(pages.map(p =>
      p.tag?.toLowerCase() === oldName.toLowerCase() ? { ...p, tag: newName } : p
    ));
    onSetExportNames((() => {
      const next = { ...exportNames };
      const key = Object.keys(next).find(k => k.toLowerCase() === oldName.toLowerCase());
      if (key) {
        next[newName] = next[key];
        delete next[key];
      }
      return next;
    })());
  }, [pages, exportNames, onSetPages, onSetExportNames]);

  const createAndAssignTag = useCallback((name: string, assignToPageIdx: number) => {
    const clean = name.trim();
    if (!clean) return;
    if (!presets.some(p => p.toLowerCase() === clean.toLowerCase())) {
      onSetPresets([...presets, clean]);
    }
    const page = pages[assignToPageIdx];
    if (!page || page.isDeleted) return;
    const targets = selectedIds.size > 1 && selectedIds.has(page.id)
      ? selectedIds
      : new Set([page.id]);
    tagPages(clean, targets);
  }, [presets, pages, selectedIds, onSetPresets, tagPages]);

  const handleThumbContextMenu = useCallback((idx: number, e: React.MouseEvent) => {
    const page = pages[idx];
    if (!page || page.isDeleted) return;
    if (!selectedIds.has(page.id)) {
      setSelectedIds(new Set([page.id]));
      setLastClickedIndex(idx);
    }
    shouldScrollRef.current = true;
    setPrimaryIndex(idx);
    setContextMenu({ x: e.clientX, y: e.clientY, pageIdx: idx });
  }, [pages, selectedIds]);

  const startExportNameEdit = (tag: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingExportTag(tag);
    setExportEditValue(exportNames[tag] ?? tag);
  };

  const commitExportNameEdit = (tag: string) => {
    const clean = sanitizeExportFileName(exportEditValue);
    if (!clean) {
      setEditingExportTag(null);
      return;
    }
    const next = { ...exportNames };
    if (clean.toLowerCase() === tag.toLowerCase()) delete next[tag];
    else next[tag] = clean;
    onSetExportNames(next);
    setEditingExportTag(null);
  };

  // dnd-kit
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = pages.findIndex(p => String(p.id) === active.id);
    const newIdx = pages.findIndex(p => String(p.id) === over.id);
    if (oldIdx !== -1 && newIdx !== -1) {
      onSetPages(arrayMove(pages, oldIdx, newIdx));
      setPrimaryIndex(newIdx);
    }
  };

  // Stats
  const activePage = pages[primaryIndex];
  const splitPage = splitIndex !== null ? pages[splitIndex] : null;
  const deletedCount = pages.filter(p => p.isDeleted).length;
  const blankCount = pages.filter(p => p.isBlank && !p.isDeleted).length;
  const activeCount = pages.length - deletedCount;
  const taggedCount = pages.filter(p => !p.isDeleted && p.tag).length;
  const multiSelected = selectedIds.size > 1;

  const tagCounts: Record<string, number> = {};
  pages.forEach(p => {
    if (!p.isDeleted && p.tag) tagCounts[p.tag] = (tagCounts[p.tag] || 0) + 1;
  });

  // Sidebar grouped view — untagged → preset order → orphan tags → deleted
  const sidebarGroups = useMemo(() => {
    type Group = { key: string; tag?: string; entries: { page: ProcessedPage; idx: number }[] };
    const byTag = new Map<string | null, { page: ProcessedPage; idx: number }[]>();
    pages.forEach((page, idx) => {
      const k = page.isDeleted ? '__deleted__' : (page.tag ?? null);
      if (!byTag.has(k)) byTag.set(k, []);
      byTag.get(k)!.push({ page, idx });
    });

    const result: Group[] = [];
    if (byTag.has(null) && byTag.get(null)!.length)
      result.push({ key: '__untagged__', entries: byTag.get(null)! });

    const placed = new Set<string>();
    presets.forEach(preset => {
      byTag.forEach((entries, tag) => {
        if (!tag || tag === '__deleted__' || placed.has(tag)) return;
        if (tag.toLowerCase() === preset.toLowerCase()) {
          placed.add(tag);
          result.push({ key: tag, tag, entries });
        }
      });
    });

    byTag.forEach((entries, tag) => {
      if (tag && tag !== '__deleted__' && !placed.has(tag))
        result.push({ key: tag, tag, entries });
    });

    if (byTag.has('__deleted__') && byTag.get('__deleted__')!.length)
      result.push({ key: '__deleted__', entries: byTag.get('__deleted__')! });

    return result;
  }, [pages, presets]);

  if (loadingPdf) {
    return (
      <div className="loading-screen">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div className="spinner" />
          <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading PDF…</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`workspace-root${isSidebarResizing ? ' sidebar-resizing' : ''}`} ref={workspaceRef} onWheel={handleWheel}>

      {/* ── Left Thumbnail Sidebar (resizable) ── */}
      <div className="sidebar-panel" style={{ width: sidebarWidth }}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-stats">
            <span className="sidebar-stat">
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{pages.length}</span> pages
            </span>
            {deletedCount > 0 && (
              <span className="sidebar-stat" style={{ color: 'var(--danger)' }}>{deletedCount} deleted</span>
            )}
            {blankCount > 0 && (
              <button className="btn-ghost btn-sm" style={{ color: 'var(--warning)', padding: '2px 6px', fontSize: 11 }}
                onClick={autoDeleteBlanks} title={`Remove ${blankCount} blank pages`}>
                {blankCount} blank — remove
              </button>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6 }}>
            {multiSelected && (
              <>
                <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, flex: 1 }}>
                  {selectedIds.size} selected
                </span>
                <button className="btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 6px' }}
                  onClick={() => setSelectedIds(new Set())}>Clear</button>
              </>
            )}
            {/* View toggle */}
            <button
              className={`btn-icon btn-sm${sidebarView === 'pages' ? ' active' : ''}`}
              title="Page order view" onClick={() => setSidebarView('pages')}
            ><List size={13} /></button>
            <button
              className={`btn-icon btn-sm${sidebarView === 'groups' ? ' active' : ''}`}
              title="Grouped by tag" onClick={() => setSidebarView('groups')}
            ><LayoutList size={13} /></button>
          </div>
        </div>

        {/* Sortable thumbnails — Pages view */}
        <div className="sidebar-scroll" style={{ display: sidebarView === 'pages' ? undefined : 'none' }}>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={pages.map(p => String(p.id))}
              strategy={verticalListSortingStrategy}
            >
              <div className="thumbnail-strip">
                {pages.map((page, idx) => (
                  <PageThumbnail
                    key={page.id}
                    id={String(page.id)}
                    pageIndex={page.pageIndex}
                    pdfDoc={pdfDoc}
                    isDeleted={page.isDeleted}
                    isBlank={page.isBlank}
                    rotation={page.rotation}
                    tag={page.tag}
                    isActive={primaryIndex === idx}
                    isSplitActive={splitIndex === idx}
                    isSelected={selectedIds.has(page.id)}
                    onToggleDelete={() => toggleDelete(page.id)}
                    onMarkBlank={(isBlank) => onSetPagesSilent(pages.map(p => p.id === page.id ? { ...p, isBlank } : p))}
                    onClick={(e) => handleThumbClick(idx, e)}
                    onContextMenu={(e) => handleThumbContextMenu(idx, e)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>

        {/* Groups view */}
        {sidebarView === 'groups' && (
          <div className="sidebar-scroll">
            {sidebarGroups.map(group => {
              const collapsed = collapsedGroups.has(group.key);
              const isDeleted = group.key === '__deleted__';
              const isUntagged = group.key === '__untagged__';
              const tag = group.tag;
              const exportModified = tag ? isExportNameModified(tag, exportNames) : false;
              const exportLabel = tag ? getExportFileName(tag, exportNames) : '';
              return (
                <div key={group.key} className="sidebar-group">
                  <div className={`sidebar-group-header${isDeleted ? ' deleted' : ''}${isUntagged ? ' untagged' : ''}`}>
                    <button
                      type="button"
                      className="sidebar-group-chevron-btn"
                      onClick={() => toggleGroup(group.key)}
                      title={collapsed ? 'Expand' : 'Collapse'}
                    >
                      {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    </button>
                    {isUntagged ? (
                      <span className="sidebar-group-label">Untagged</span>
                    ) : isDeleted ? (
                      <span className="sidebar-group-label">Deleted</span>
                    ) : editingExportTag === tag ? (
                      <input
                        type="text"
                        className="sidebar-group-export-input export-name-text"
                        value={exportEditValue}
                        autoFocus
                        onChange={e => setExportEditValue(e.target.value)}
                        onBlur={() => tag && commitExportNameEdit(tag)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && tag) commitExportNameEdit(tag);
                          if (e.key === 'Escape') setEditingExportTag(null);
                        }}
                        onClick={e => e.stopPropagation()}
                      />
                    ) : (
                      <button
                        type="button"
                        className="sidebar-group-names"
                        onClick={e => tag && startExportNameEdit(tag, e)}
                        title="Click to edit export filename"
                      >
                        <span className="tag-label-text">{tag}</span>
                        {exportModified && (
                          <>
                            <span className="sidebar-group-arrow">→</span>
                            <span className="export-name-text">{exportLabel}</span>
                          </>
                        )}
                      </button>
                    )}
                    <span className="sidebar-group-count">{group.entries.length}</span>
                  </div>
                  {!collapsed && (
                    <div className="sidebar-group-pages">
                      {group.entries.map(({ page, idx }) => (
                        <PageThumbnail
                          key={page.id}
                          id={String(page.id)}
                          pageIndex={page.pageIndex}
                          pdfDoc={pdfDoc}
                          isDeleted={page.isDeleted}
                          isBlank={page.isBlank}
                          rotation={page.rotation}
                          tag={page.tag}
                          isActive={primaryIndex === idx}
                          isSplitActive={splitIndex === idx}
                          isSelected={selectedIds.has(page.id)}
                          onToggleDelete={() => toggleDelete(page.id)}
                          onMarkBlank={(isBlank) => onSetPagesSilent(pages.map(p => p.id === page.id ? { ...p, isBlank } : p))}
                          onClick={(e) => handleThumbClick(idx, e)}
                          onContextMenu={(e) => handleThumbContextMenu(idx, e)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Footer */}
        <div className="sidebar-footer">
          <div className="folder-row">
            <FolderOpen size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
            <span className={`folder-path${outputDirectory ? '' : ' empty'}`}>
              {outputDirectory || 'No folder selected'}
            </span>
            <button className="btn-icon btn-sm" onClick={handleSelectDirectory} title="Choose output folder">
              <FolderOpen size={13} />
            </button>
          </div>

          {Object.keys(tagCounts).length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="settings-section-title">Export groups</span>
              {Object.entries(tagCounts).map(([tag]) => {
                const modified = isExportNameModified(tag, exportNames);
                const fileName = getExportFileName(tag, exportNames);
                return (
                  <div key={tag} className="sidebar-export-row">
                    <div className="sidebar-export-labels">
                      <span className="tag-label-text" style={{ fontSize: 12, fontWeight: 600 }}>{tag}</span>
                      {modified && (
                        <>
                          <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>→</span>
                          <span className="export-name-text" style={{ fontSize: 12, fontWeight: 500 }}>{fileName}</span>
                        </>
                      )}
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{tagCounts[tag]}p</span>
                    </div>
                    <button className="btn btn-secondary btn-sm" onClick={() => onExport(tag)} disabled={isExporting} style={{ flexShrink: 0 }}>
                      Save
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <button
            className="btn btn-primary"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={() => onExport()}
            disabled={isExporting || activeCount === 0}
          >
            <Play size={12} fill="white" />
            {isExporting ? 'Exporting…' : `Export all (${taggedCount} tagged)`}
          </button>
        </div>
      </aside>
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onMouseDown={startSidebarResize}
      />
      </div>

      {/* ── Main preview area ── */}
      <main className="preview-area">

        {/* Toolbar */}
        <div className="preview-toolbar">
          {/* Left: page info */}
          <div className="preview-page-info">
            <span className="preview-page-num">
              {multiSelected
                ? `${selectedIds.size} pages selected`
                : `Page ${primaryIndex + 1} of ${pages.length}`}
            </span>
            {!multiSelected && activePage && (
              activePage.tag ? (
                <span className="preview-page-tag">
                  <span className="tag-label-text">{activePage.tag}</span>
                  {isExportNameModified(activePage.tag, exportNames) && (
                    <>
                      <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>→</span>
                      <span className="export-name-text">{getExportFileName(activePage.tag, exportNames)}</span>
                    </>
                  )}
                </span>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>untagged — right-click page to tag</span>
              )
            )}
          </div>

          {/* Center: zoom controls (always for the active pane) */}
          <div className="zoom-controls">
            <button
              className="btn-icon"
              title="Zoom out (Ctrl −)"
              onClick={() => setActiveZoomIdx(i => Math.max(i - 1, 0))}
              disabled={activeZoomIdx === 0}
            >
              <ZoomOut size={14} />
            </button>
            <button
              className="zoom-label"
              title="Reset to fit (Ctrl 0)"
              onClick={() => setActiveZoomIdx(() => 0)}
            >
              {activeZoomIdx === 0 ? 'Fit' : `${Math.round(ZOOM_STEPS[activeZoomIdx] * 100)}%`}
            </button>
            <button
              className="btn-icon"
              title="Zoom in (Ctrl +)"
              onClick={() => setActiveZoomIdx(i => Math.min(i + 1, ZOOM_STEPS.length - 1))}
              disabled={activeZoomIdx === ZOOM_STEPS.length - 1}
            >
              <ZoomIn size={14} />
            </button>
          </div>

          {/* Right: page actions + split toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              className="btn-icon"
              title="Undo (Ctrl+Z)"
              onClick={onUndo}
              disabled={!canUndo}
            >
              <Undo2 size={15} />
            </button>
            <button
              className="btn-icon"
              title="Redo (Ctrl+Shift+Z)"
              onClick={onRedo}
              disabled={!canRedo}
            >
              <Redo2 size={15} />
            </button>
            <div style={{ width: 1, height: 18, background: 'var(--separator)' }} />
            <button
              className="btn-icon"
              title="Rotate counter-clockwise"
              onClick={() => activePage && rotatePage(activePage.id, -90)}
            >
              <RotateCcw size={15} />
            </button>
            <button
              className="btn-icon"
              title="Rotate clockwise"
              onClick={() => activePage && rotatePage(activePage.id, 90)}
            >
              <RotateCw size={15} />
            </button>
            <div className="tags-toolbar-wrap" ref={tagsPanelRef}>
              <button
                className={`btn btn-sm btn-secondary${showTagsPanel ? ' tags-panel-open' : ''}`}
                title="Manage tags — right-click a page to assign"
                onClick={() => setShowTagsPanel(v => !v)}
              >
                <Tags size={13} />
                Tags
              </button>
              {showTagsPanel && (
                <div className="tags-panel-dropdown fade-in">
                  <div className="tags-panel-header">
                    <span style={{ fontWeight: 600, fontSize: 13 }}>Saved tags</span>
                    <button type="button" className="btn-icon btn-sm" onClick={() => setShowTagsPanel(false)}>
                      <X size={14} />
                    </button>
                  </div>
                  <BasicTagsEditor
                    presets={presets}
                    onSetPresets={onSetPresets}
                    onRename={handlePresetRename}
                  />
                </div>
              )}
            </div>
            <button
              className={`btn btn-sm${activePage?.isDeleted ? ' btn-primary' : ' btn-danger-ghost'}`}
              style={activePage?.isDeleted ? { background: 'var(--danger)' } : {}}
              onClick={() => activePage && toggleDelete(activePage.id)}
            >
              <Trash2 size={13} />
              {activePage?.isDeleted ? 'Restore' : 'Delete'}
            </button>
            <div style={{ width: 1, height: 20, background: 'var(--separator)', margin: '0 2px' }} />
            <button
              className={`btn btn-sm btn-secondary${isSplitView ? ' split-active' : ''}`}
              title={isSplitView ? 'Close split view' : 'Open split view — click a second thumbnail to compare'}
              onClick={() => {
                if (isSplitView) {
                  setSplitIndex(null);
                  setActivePaneIsLeft(true);
                  setRightZoomIdx(0);
                } else {
                  // Pick the adjacent page as a sensible default for the right pane
                  const next = primaryIndex + 1 < pages.length ? primaryIndex + 1 : Math.max(0, primaryIndex - 1);
                  setSplitIndex(next !== primaryIndex ? next : 0);
                  setActivePaneIsLeft(true); // left pane active by default
                }
              }}
              style={isSplitView ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-light)' } : {}}
            >
              <Columns2 size={13} />
              {isSplitView ? 'Close split' : 'Split view'}
            </button>
          </div>
        </div>

        {/* Preview canvas zone — single or split */}
        <div className={`preview-canvas-zone${isSplitView ? ' split' : ''}`}>
          {/* Primary pane */}
          <div
            className={`preview-pane${isSplitView ? ' split-pane' : ''}${isSplitView && activePaneIsLeft ? ' pane-active' : ''}`}
            onClick={() => isSplitView && setActivePaneIsLeft(true)}
          >
            {pages.some(p => !p.isDeleted) ? (
              <ScrollablePreview
                pdfDoc={pdfDoc}
                pages={pages}
                activeIndex={primaryIndex}
                zoom={ZOOM_STEPS[leftZoomIdx]}
                onActiveIndexChange={(idx) => {
                  // Don't overwrite when user has deliberately selected a deleted page via thumbnail
                  if (!pages[primaryIndex]?.isDeleted) setPrimaryIndex(idx);
                }}
                scrollToRef={scrollToPageRef}
              />
            ) : (
              <div className="empty-state">
                <Tag size={28} style={{ opacity: 0.25 }} />
                <span>No pages</span>
              </div>
            )}
            {isSplitView && (
              <div className="split-pane-label">
                Page {primaryIndex + 1}
                {activePage?.tag && (
                  <span style={{ marginLeft: 6, opacity: 0.7 }}>· {activePage.tag}</span>
                )}
              </div>
            )}
          </div>

          {/* Split divider */}
          {isSplitView && <div className="split-divider" />}

          {/* Secondary pane */}
          {isSplitView && (
            <div
              className={`preview-pane split-pane${!activePaneIsLeft ? ' pane-active' : ''}`}
              style={{ position: 'relative' }}
              onClick={() => setActivePaneIsLeft(false)}
            >
              {pages.some(p => !p.isDeleted) ? (
                <ScrollablePreview
                  pdfDoc={pdfDoc}
                  pages={pages}
                  activeIndex={splitIndex ?? 0}
                  zoom={ZOOM_STEPS[rightZoomIdx]}
                  onActiveIndexChange={(idx) => {
                    if (splitIndex === null || !pages[splitIndex]?.isDeleted) setSplitIndex(idx);
                  }}
                  scrollToRef={scrollToSplitRef}
                />
              ) : (
                <div className="empty-state">
                  <Maximize2 size={28} style={{ opacity: 0.25 }} />
                  <span style={{ textAlign: 'center', maxWidth: 180 }}>No pages</span>
                </div>
              )}
              <button
                className="split-close-btn"
                onClick={() => setSplitIndex(null)}
                title="Close split view"
              >
                <X size={12} />
              </button>
              {splitPage && (
                <div className="split-pane-label">
                  Page {splitIndex! + 1}
                  {splitPage.tag && (
                    <span style={{ marginLeft: 6, opacity: 0.7 }}>· {splitPage.tag}</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

      </main>

      {/* Settings panel */}
      {showSettings && (
        <div className="settings-panel fade-in" ref={settingsRef}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Settings</span>
            <button className="btn-icon" onClick={() => setShowSettings(false)}>
              <X size={14} />
            </button>
          </div>

          <div>
            <div className="settings-section-title">Output folder</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6, wordBreak: 'break-all' }}>
              {outputDirectory || 'Not set — will prompt on export'}
            </div>
            <button className="btn btn-secondary btn-sm" onClick={handleSelectDirectory}>
              <FolderOpen size={12} /> Choose folder
            </button>
          </div>

          <div>
            <div className="settings-section-title">File</div>
            <button className="btn btn-danger-ghost btn-sm" style={{ width: '100%', justifyContent: 'center' }} onClick={onBack}>
              Close file
            </button>
          </div>
        </div>
      )}

      {/* Right-click tag menu */}
      {contextMenu && (
        <PageContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          presets={presets}
          hasTag={(() => {
            const targets = selectedIds.size > 1 ? selectedIds : new Set([pages[contextMenu.pageIdx]?.id]);
            return [...targets].some(id => !!pages.find(pg => pg.id === id)?.tag);
          })()}
          currentTag={pages[contextMenu.pageIdx]?.tag}
          onSelectTag={(tag) => tagPages(tag, getContextMenuTargets(contextMenu.pageIdx))}
          onNewTag={(name) => createAndAssignTag(name, contextMenu.pageIdx)}
          onClearTag={() => tagPages(undefined, getContextMenuTargets(contextMenu.pageIdx))}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Export progress toast */}
      {isExporting && exportProgress && (
        <div className="export-toast">
          <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2, borderColor: 'rgba(255,255,255,0.3)', borderTopColor: 'white' }} />
          {exportProgress}
        </div>
      )}

      {/* Floating settings button */}
      <button
        className="btn-icon"
        style={{
          position: 'fixed',
          top: 10,
          right: 16,
          zIndex: 300,
          background: showSettings ? 'var(--accent-light)' : undefined,
          color: showSettings ? 'var(--accent)' : undefined,
        }}
        title="Settings"
        onClick={() => setShowSettings(v => !v)}
      >
        <Settings size={16} />
      </button>
    </div>
  );
};
