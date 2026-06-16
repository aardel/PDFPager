import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
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
import { LargePagePreview } from './LargePagePreview';
import { SectionGridPreview } from './SectionGridPreview';
import { BasicTagsEditor } from './BasicTagsEditor';
import { WordListEditor } from './WordListEditor';
import { TagPopup } from './TagPopup';
import { PageContextMenu } from './PageContextMenu';
import type { MainViewMode, WorkspaceChrome } from './workspaceChrome';
import { ProcessedPage, loadPdfDocument } from '../utils/pdfProcessor';
import { supportsFileSystemAccess, pickOutputDirectory } from '../utils/fileSystem';
import {
  getExportFileName,
  isExportNameModified,
  sanitizeExportFileName,
  collectUsedTags,
} from '../utils/tagUtils';
import { seedWords, recordTagWords, listWords } from '../utils/wordStore';
import {
  FolderOpen,
  RotateCw,
  RotateCcw,
  Crop,
  Scan,
  FilePlus,
  Trash2,
  Settings,
  X,
  Play,
  Tag,
  Maximize2,
  Type,
  ChevronDown,
  ChevronRight,
  Undo2,
  Redo2,
  Smartphone,
  Pencil,
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
  masterExcludeTags: string[];
  onSetMasterExcludeTags: (tags: string[]) => void;
  onExport: (targetTag?: string) => void;
  onBack: () => void;
  onScanCover: () => void;
  onInsertPdf: () => void;
  isExporting: boolean;
  exportProgress: string;
  onCancelExport: () => void;
  onRequestCrop: (pageId: number) => void;
  onReadjustCover: (pageId: number) => void;
  onChromeChange?: (chrome: WorkspaceChrome | null) => void;
}

const ZOOM_STEPS = [1.0, 1.25, 1.5, 2.0, 2.5, 3.0];
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 560;
const SIDEBAR_DEFAULT = 300;

// Drop target wrapping a tag group's pages, so a page can be dropped onto an
// (otherwise empty) area of the group, not just onto another page.
const GroupDropZone: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={`sidebar-group-pages${isOver ? ' drop-over' : ''}`}>
      {children}
    </div>
  );
};

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
  masterExcludeTags,
  onSetMasterExcludeTags,
  onExport,
  onBack,
  onScanCover,
  onInsertPdf,
  isExporting,
  exportProgress,
  onCancelExport,
  onRequestCrop,
  onReadjustCover,
  onChromeChange,
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
  const [excludeTagInput, setExcludeTagInput] = useState('');
  const [showWordsPanel, setShowWordsPanel] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const wordsPanelRef = useRef<HTMLDivElement>(null);
  const topPaneRef = useRef<HTMLDivElement>(null);

  const lastGridSectionRef = useRef('__untagged__');
  // Sidebar view: 'pages' = flat ordered list, 'groups' = grouped by tag
  // Seed the autocomplete word store from the tag presets so suggestions
  // work from the first use.
  useEffect(() => { seedWords(presets); }, [presets]);

  const [sidebarView, setSidebarView] = useState<'pages' | 'groups'>('groups');
  // Tagged sections start collapsed; only Untagged is open until the user expands others.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [untaggedCollapsed, setUntaggedCollapsed] = useState(false);
  const toggleGroup = (key: string) => {
    if (key === '__untagged__') {
      setUntaggedCollapsed(prev => !prev);
      return;
    }
    setExpandedGroups(prev => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  };

  // Section grid in the main preview (opened from the Sections list).
  const [sectionGrid, setSectionGrid] = useState<{
    key: string;
    label: string;
    entries: { page: ProcessedPage; idx: number }[];
  } | null>(null);
  const inGridMode = sectionGrid !== null;

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
  const [tagEditorMenu, setTagEditorMenu] = useState<{
    x: number;
    y: number;
    pageIdx: number;
    initialValue?: string;
  } | null>(null);

  // Inline export-name edit in group header (keyed by tag string)
  const [editingExportTag, setEditingExportTag] = useState<string | null>(null);
  const [exportEditValue, setExportEditValue] = useState('');
  // Inline rename of a section (the tag itself) in the bottom sections pane.
  const [renamingSection, setRenamingSection] = useState<string | null>(null);
  const [renameSectionValue, setRenameSectionValue] = useState('');
  // Re-tag conflict prompt: tagging pages with a tag already used elsewhere.
  const [tagConflict, setTagConflict] = useState<{ tag: string; targets: Set<number> } | null>(null);

  // Close words panel on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wordsPanelRef.current && !wordsPanelRef.current.contains(e.target as Node))
        setShowWordsPanel(false);
    };
    if (showWordsPanel) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showWordsPanel]);

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

  // New file → open untagged grid (primary tagging surface).
  useEffect(() => {
    const entries = pages
      .map((page, idx) => ({ page, idx }))
      .filter(({ page }) => !page.isDeleted && !page.tag);
    setSectionGrid({ key: '__untagged__', label: 'Untagged', entries: [] });
    setSplitIndex(null);
    setActivePaneIsLeft(true);
    if (entries.length) {
      setSelectedIds(new Set([entries[0].page.id]));
      setPrimaryIndex(entries[0].idx);
      setLastClickedIndex(entries[0].idx);
    } else {
      setSelectedIds(new Set());
      setPrimaryIndex(0);
      setLastClickedIndex(null);
    }
  }, [pdfBuffer]);

  // Keyboard shortcuts
  useEffect(() => {
    function navIndices(): number[] {
      if (!sectionGrid) return pages.map((_, i) => i);
      if (sectionGrid.key === '__untagged__') {
        return pages.flatMap((p, i) => (!p.isDeleted && !p.tag ? [i] : []));
      }
      if (sectionGrid.key === '__deleted__') {
        return pages.flatMap((p, i) => (p.isDeleted ? [i] : []));
      }
      return pages.flatMap((p, i) => (!p.isDeleted && p.tag === sectionGrid.key ? [i] : []));
    }

    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

      const isDown = e.key === 'ArrowDown' || e.key === 'ArrowRight';
      const isUp = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
      const nav = navIndices();

      if (e.shiftKey && (isDown || isUp)) {
        e.preventDefault();
        const anchor = lastClickedIndex ?? primaryIndex;
        let pos = nav.indexOf(primaryIndex);
        if (pos < 0) pos = 0;
        const delta = isDown ? 1 : -1;
        const nextPos = Math.max(0, Math.min(nav.length - 1, pos + delta));
        if (nav.length === 0) return;
        const next = nav[nextPos];
        const anchorPos = nav.indexOf(anchor);
        const a = anchorPos >= 0 ? anchorPos : pos;
        const minPos = Math.min(a, nextPos);
        const maxPos = Math.max(a, nextPos);
        setSelectedIds(new Set(nav.slice(minPos, maxPos + 1).map(i => pages[i].id)));
        if (lastClickedIndex === null) setLastClickedIndex(anchor);
        setPrimaryIndex(next);
        return;
      }

      if (isDown || isUp) {
        e.preventDefault();
        if (!nav.length) return;
        let pos = nav.indexOf(primaryIndex);
        if (pos < 0) pos = isDown ? 0 : nav.length - 1;
        else pos = Math.max(0, Math.min(nav.length - 1, pos + (isDown ? 1 : -1)));
        setPrimaryIndex(nav[pos]);
        setSelectedIds(new Set([pages[nav[pos]].id]));
        setLastClickedIndex(nav[pos]);
        return;
      }

      if (e.key === 'd' || e.key === 'D') {
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
  }, [primaryIndex, pages, presets, selectedIds, lastClickedIndex, sectionGrid]);

  // Ctrl+wheel zoom
  const wheelLockRef = useRef(0);
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setActiveZoomIdx(i => e.deltaY < 0
        ? Math.min(i + 1, ZOOM_STEPS.length - 1)
        : Math.max(i - 1, 0));
      return;
    }
    if (inGridMode) return; // grid scrolls natively

    // If the hovered page is zoomed enough to scroll, let native scrolling
    // handle it; otherwise turn the wheel into page navigation.
    const scroller = (e.target as HTMLElement).closest('.large-page-preview') as HTMLElement | null;
    if (scroller && scroller.scrollHeight > scroller.clientHeight + 2) return;

    const now = Date.now();
    if (now < wheelLockRef.current) return;
    wheelLockRef.current = now + 110; // ~one page per wheel tick
    const dir = e.deltaY > 0 ? 1 : -1;
    const step = (i: number) => {
      let n = i + dir;
      while (n >= 0 && n < pages.length && pages[n].isDeleted) n += dir;
      return (n >= 0 && n < pages.length && !pages[n].isDeleted) ? n : i;
    };
    if (isSplitView && !activePaneIsLeft) setSplitIndex(i => (i == null ? i : step(i)));
    else setPrimaryIndex(step);
  }, [inGridMode, isSplitView, activePaneIsLeft, pages]);

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
      if (sectionGrid) lastGridSectionRef.current = sectionGrid.key;
      setSectionGrid(null);
      setSelectedIds(new Set([pageId]));
      if (isSplitView && !activePaneIsLeft) {
        setSplitIndex(idx);
      } else {
        setPrimaryIndex(idx);
      }
    }

    setLastClickedIndex(idx);
  }, [pages, lastClickedIndex, isSplitView, activePaneIsLeft, sectionGrid]);

  const handleGridPageClick = useCallback((idx: number, e: React.MouseEvent) => {
    e.preventDefault();
    const pageId = pages[idx].id;
    const nav = sectionGrid
      ? (sectionGrid.key === '__untagged__'
        ? pages.flatMap((p, i) => (!p.isDeleted && !p.tag ? [i] : []))
        : sectionGrid.key === '__deleted__'
          ? pages.flatMap((p, i) => (p.isDeleted ? [i] : []))
          : pages.flatMap((p, i) => (!p.isDeleted && p.tag === sectionGrid.key ? [i] : [])))
      : pages.map((_, i) => i);

    if (e.shiftKey && lastClickedIndex !== null) {
      const a = nav.indexOf(lastClickedIndex);
      const b = nav.indexOf(idx);
      if (a >= 0 && b >= 0) {
        const [min, max] = a < b ? [a, b] : [b, a];
        setSelectedIds(prev => new Set([...prev, ...nav.slice(min, max + 1).map(i => pages[i].id)]));
      }
    } else if (e.metaKey || e.ctrlKey) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(pageId)) next.delete(pageId);
        else next.add(pageId);
        return next;
      });
    } else {
      setSelectedIds(new Set([pageId]));
      setPrimaryIndex(idx);
    }
    setLastClickedIndex(idx);
  }, [pages, lastClickedIndex, sectionGrid]);

  const exitGridToPageView = useCallback((idx?: number) => {
    if (sectionGrid) lastGridSectionRef.current = sectionGrid.key;
    if (idx !== undefined) {
      setPrimaryIndex(idx);
      setLastClickedIndex(idx);
      setSelectedIds(new Set([pages[idx].id]));
    }
    setSectionGrid(null);
  }, [pages, sectionGrid]);

  // Tag selected pages, or the active page when nothing is selected
  // Actually assign the tag and auto-advance. (tagPages decides first whether
  // to ask about a re-tag conflict.)
  const applyTag = useCallback((tag: string | undefined, targets: Set<number>) => {
    if (!targets.size) return;

    const updated = pages.map(p => targets.has(p.id) ? { ...p, tag } : p);
    onSetPages(updated);
    recordTagWords(tag); // learn the words for autocomplete

    // After assigning a tag, jump to the next still-untagged page (past the
    // last one we just tagged), select + highlight it, and scroll to it — so
    // tagging a run of pages flows without manual navigation. Skipped when
    // clearing a tag.
    if (tag) {
      const lastTaggedIdx = updated.reduce((m, p, i) => (targets.has(p.id) ? i : m), -1);
      let next = lastTaggedIdx + 1;
      while (next < updated.length && (updated[next].isDeleted || updated[next].tag)) next++;
      if (next < updated.length) {
        setSelectedIds(new Set([updated[next].id]));
        setLastClickedIndex(next);
        setPrimaryIndex(next);
      } else {
        setSelectedIds(new Set());
      }
      // Stay on untagged grid — tagged pages disappear from the grid.
      setSectionGrid({ key: '__untagged__', label: 'Untagged', entries: [] });
    }
  }, [pages, onSetPages]);

  // Tag selected pages, or the active page when nothing is selected. If the
  // tag already exists on other, non-adjacent pages, ask whether to merge into
  // that section or split off a new one (so a re-used tag isn't silently
  // lumped into one export file).
  const tagPages = useCallback((tag: string | undefined, overrideTargets?: Set<number>) => {
    const targets = overrideTargets ?? (
      selectedIds.size > 0
        ? selectedIds
        : new Set(pages[primaryIndex] ? [pages[primaryIndex].id] : [])
    );
    if (!targets.size) return;

    if (tag) {
      const existingIdx = new Set(
        pages.map((p, i) => (p.tag?.toLowerCase() === tag.toLowerCase() && !targets.has(p.id)) ? i : -1)
          .filter(i => i >= 0)
      );
      if (existingIdx.size) {
        const targetIdx = pages.map((p, i) => targets.has(p.id) ? i : -1).filter(i => i >= 0);
        const adjacent = targetIdx.some(i => existingIdx.has(i - 1) || existingIdx.has(i + 1));
        if (!adjacent) { setTagConflict({ tag, targets }); return; }
      }
    }
    applyTag(tag, targets);
  }, [pages, primaryIndex, selectedIds, applyTag]);

  // Build a distinct variant like "MINUTES (2)" not already used as a tag/preset.
  const nextTagVariant = useCallback((base: string): string => {
    const taken = (t: string) =>
      presets.some(p => p.toLowerCase() === t.toLowerCase()) ||
      pages.some(p => p.tag?.toLowerCase() === t.toLowerCase());
    for (let n = 2; n < 1000; n++) {
      const cand = `${base} (${n})`;
      if (!taken(cand)) return cand;
    }
    return `${base} (${Date.now()})`;
  }, [presets, pages]);

  const getContextMenuTargets = useCallback((pageIdx: number): Set<number> => {
    const page = pages[pageIdx];
    if (!page) return new Set();
    if (selectedIds.size > 1 && selectedIds.has(page.id)) return selectedIds;
    return new Set([page.id]);
  }, [pages, selectedIds]);

  const getContextMenuPageIds = useCallback((pageIdx: number): number[] => {
    const targets = getContextMenuTargets(pageIdx);
    return pages.filter(p => targets.has(p.id)).map(p => p.id);
  }, [pages, getContextMenuTargets]);

  const rotateTargets = useCallback((pageIdx: number, degrees: number) => {
    const targets = getContextMenuTargets(pageIdx);
    onSetPages(pages.map(p => (
      targets.has(p.id) ? { ...p, rotation: (p.rotation + degrees + 360) % 360 } : p
    )));
  }, [pages, onSetPages, getContextMenuTargets]);

  const toggleDeleteTargets = useCallback((pageIdx: number) => {
    const targets = getContextMenuTargets(pageIdx);
    const anyActive = pages.some(p => targets.has(p.id) && !p.isDeleted);
    onSetPages(pages.map(p => (
      targets.has(p.id) ? { ...p, isDeleted: anyActive } : p
    )));
  }, [pages, onSetPages, getContextMenuTargets]);

  const toggleBlankTargets = useCallback((pageIdx: number) => {
    const targets = getContextMenuTargets(pageIdx);
    const anyBlank = pages.some(p => targets.has(p.id) && p.isBlank);
    onSetPagesSilent(pages.map(p => (
      targets.has(p.id) ? { ...p, isBlank: !anyBlank } : p
    )));
  }, [pages, onSetPagesSilent, getContextMenuTargets]);

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

  // Commit a tag from the popup: remember it as a preset (new tags persist),
  // then assign it (which may raise the merge/new conflict prompt).
  const commitTagFromPopup = useCallback((tag: string, targets: Set<number>) => {
    const clean = tag.trim();
    if (!clean) return;
    if (!presets.some(p => p.toLowerCase() === clean.toLowerCase())) {
      onSetPresets([...presets, clean]);
    }
    tagPages(clean, targets);
  }, [presets, onSetPresets, tagPages]);

  const handleThumbContextMenu = useCallback((idx: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const page = pages[idx];
    if (!page) return;
    if (!page.isDeleted && !selectedIds.has(page.id)) {
      setSelectedIds(new Set([page.id]));
      setLastClickedIndex(idx);
    }
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

  const handleGridReorder = useCallback((
    dragIds: Set<number>,
    overPageId: number,
    insertAfter: boolean,
  ) => {
    const picked = pages.filter(p => dragIds.has(p.id));
    if (!picked.length) return;
    const rest = pages.filter(p => !dragIds.has(p.id));
    let insertAt = rest.findIndex(p => p.id === overPageId);
    if (insertAt < 0) insertAt = rest.length;
    else if (insertAfter) insertAt++;
    const next = [...rest.slice(0, insertAt), ...picked, ...rest.slice(insertAt)];
    onSetPages(next);
    const focusId = pages[primaryIndex]?.id;
    if (focusId != null) {
      const newIdx = next.findIndex(p => p.id === focusId);
      if (newIdx >= 0) setPrimaryIndex(newIdx);
    }
  }, [pages, onSetPages, primaryIndex]);

  // Which group a page belongs to in the grouped view.
  const pageGroupKey = (p: ProcessedPage): string =>
    p.isDeleted ? '__deleted__' : (p.tag ?? '__untagged__');

  // Reorder within the grouped view. Dropping a page onto another page (or
  // onto a group's drop zone) moves it there; landing in a different tag's
  // section re-tags it. The deleted group is never a source or a target.
  const handleGroupDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const activeId = Number(active.id);
    const activePage = pages.find(p => p.id === activeId);
    if (!activePage || activePage.isDeleted) return;

    const overStr = String(over.id);
    let destKey: string;
    let overPageId: number | null = null;
    if (overStr.startsWith('group:')) {
      destKey = overStr.slice(6);
    } else {
      overPageId = Number(overStr);
      if (overPageId === activeId) return;
      const overPage = pages.find(p => p.id === overPageId);
      if (!overPage) return;
      destKey = pageGroupKey(overPage);
    }
    if (destKey === '__deleted__') return;

    const destTag = destKey === '__untagged__' ? undefined : destKey;
    const without = pages.filter(p => p.id !== activeId);
    const moved: ProcessedPage = { ...activePage, tag: destTag };

    let insertAt: number;
    if (overPageId != null) {
      insertAt = without.findIndex(p => p.id === overPageId);
      if (insertAt < 0) insertAt = without.length;
    } else {
      // Group drop zone → after that group's last page in the array.
      let last = -1;
      without.forEach((p, i) => { if (pageGroupKey(p) === destKey) last = i; });
      insertAt = last >= 0 ? last + 1 : without.length;
    }

    const next = [...without.slice(0, insertAt), moved, ...without.slice(insertAt)];
    onSetPages(next);
    const newPrimary = next.findIndex(p => p.id === activeId);
    if (newPrimary >= 0) setPrimaryIndex(newPrimary);
  };

  // Clicking a section: show all its pages in a grid in the main preview.
  const openSectionGrid = (
    groupKey: string,
    label: string,
    entries: { page: ProcessedPage; idx: number }[],
    forceOpen = false,
  ) => {
    if (!entries.length && groupKey !== '__untagged__') return;
    if (!forceOpen && sectionGrid?.key === groupKey) {
      exitGridToPageView(entries[0]?.idx);
      return;
    }
    setSectionGrid({ key: groupKey, label, entries });
    const focus = entries.find(e => e.idx === primaryIndex) ?? entries[0];
    if (focus) {
      setSelectedIds(new Set([focus.page.id]));
      setLastClickedIndex(focus.idx);
      setPrimaryIndex(focus.idx);
    } else {
      setSelectedIds(new Set());
    }
    setSplitIndex(null);
    setActivePaneIsLeft(true);
  };

  const exitSectionGrid = () => exitGridToPageView(primaryIndex);

  const startSectionRename = (tag: string) => {
    setRenamingSection(tag);
    setRenameSectionValue(tag);
  };
  const commitSectionRename = (oldTag: string) => {
    const v = renameSectionValue.trim();
    if (v && v !== oldTag) handlePresetRename(oldTag, v);
    setRenamingSection(null);
  };

  // Stats
  const activePage = pages[primaryIndex];
  const splitPage = splitIndex !== null ? pages[splitIndex] : null;
  const deletedCount = pages.filter(p => p.isDeleted).length;
  const blankCount = pages.filter(p => p.isBlank && !p.isDeleted).length;
  const activeCount = pages.length - deletedCount;
  const taggedCount = pages.filter(p => !p.isDeleted && p.tag).length;
  const multiSelected = selectedIds.size > 1;

  // Tags already on pages in this file — for the right-click “used in this file” list.
  const usedInFileTags = useMemo(() => collectUsedTags(pages), [pages]);
  const tagWords = useMemo(() => listWords(), [contextMenu, tagEditorMenu, pages]);

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
    const untaggedEntries = byTag.get(null) ?? [];
    if (pages.some(p => !p.isDeleted)) {
      result.push({ key: '__untagged__', entries: untaggedEntries });
    } else if (untaggedEntries.length) {
      result.push({ key: '__untagged__', entries: untaggedEntries });
    }

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

  // Keep the grid in sync as pages move between sections.
  const activeSectionGrid = useMemo(() => {
    if (!sectionGrid) return null;
    if (sectionGrid.key === '__untagged__') {
      const entries = pages
        .map((page, idx) => ({ page, idx }))
        .filter(({ page }) => !page.isDeleted && !page.tag);
      return { key: '__untagged__', label: 'Untagged', entries };
    }
    const group = sidebarGroups.find(g => g.key === sectionGrid.key);
    if (!group?.entries.length) return null;
    const isDeleted = group.key === '__deleted__';
    const label = isDeleted ? 'Deleted' : group.tag!;
    return { key: group.key, label, entries: group.entries };
  }, [sectionGrid, sidebarGroups, pages]);

  useEffect(() => {
    if (!sectionGrid || sectionGrid.key === '__untagged__') return;
    const group = sidebarGroups.find(g => g.key === sectionGrid.key);
    if (!group?.entries.length) setSectionGrid(null);
  }, [sectionGrid, sidebarGroups]);

  const returnToGridView = () => {
    const key = lastGridSectionRef.current;
    if (key === '__untagged__') {
      const entries = pages
        .map((page, idx) => ({ page, idx }))
        .filter(({ page }) => !page.isDeleted && !page.tag);
      openSectionGrid('__untagged__', 'Untagged', entries, true);
      return;
    }
    const group = sidebarGroups.find(g => g.key === key);
    if (group) {
      const label = group.key === '__untagged__' ? 'Untagged'
        : group.key === '__deleted__' ? 'Deleted'
        : group.tag!;
      openSectionGrid(group.key, label, group.entries, true);
      return;
    }
    const entries = pages
      .map((page, idx) => ({ page, idx }))
      .filter(({ page }) => !page.isDeleted && !page.tag);
    openSectionGrid('__untagged__', 'Untagged', entries, true);
  };

  const openGridForPage = (page: ProcessedPage) => {
    const key = page.isDeleted ? '__deleted__' : (page.tag ?? '__untagged__');
    const group = sidebarGroups.find(g => g.key === key);
    if (!group) return;
    const label = group.key === '__untagged__' ? 'Untagged'
      : group.key === '__deleted__' ? 'Deleted'
      : group.tag!;
    openSectionGrid(group.key, label, group.entries, true);
  };

  const mainView: MainViewMode = inGridMode ? 'grid' : isSplitView ? 'split' : 'page';

  useEffect(() => {
    if (!onChromeChange) return;
    onChromeChange({
      mainView,
      sidebarView,
      inGridMode,
      canSplit: !inGridMode,
      zoomIdx: activeZoomIdx,
      zoomMax: ZOOM_STEPS.length - 1,
      zoomLabel: activeZoomIdx === 0
        ? (inGridMode ? 'Small' : 'Fit')
        : `${Math.round(ZOOM_STEPS[activeZoomIdx] * 100)}%`,
      setMainView: (mode: MainViewMode) => {
        if (mode === 'grid') {
          returnToGridView();
          return;
        }
        if (mode === 'page') {
          if (isSplitView) {
            setSplitIndex(null);
            setActivePaneIsLeft(true);
            setRightZoomIdx(0);
          }
          if (sectionGrid) exitGridToPageView(primaryIndex);
          return;
        }
        if (mode === 'split') {
          if (sectionGrid) exitGridToPageView(primaryIndex);
          if (!isSplitView) {
            const next = primaryIndex + 1 < pages.length ? primaryIndex + 1 : Math.max(0, primaryIndex - 1);
            setSplitIndex(next !== primaryIndex ? next : 0);
            setActivePaneIsLeft(true);
          }
        }
      },
      setSidebarView,
      setZoomIdx: (idx: number) => setActiveZoomIdx(() => idx),
    });
    return () => onChromeChange(null);
  }, [
    onChromeChange,
    mainView,
    sidebarView,
    inGridMode,
    isSplitView,
    activeZoomIdx,
    primaryIndex,
    pages.length,
    sectionGrid,
  ]);

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
      <aside className={`sidebar${inGridMode ? ' grid-mode' : ''}`}>
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
          </div>
        </div>

        {/* Top pane — thumbnails hidden in grid mode */}
        {!inGridMode && (
          <div className="sidebar-top-pane" ref={topPaneRef}>
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
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleGroupDragEnd}
          >
          <div className="sidebar-scroll">
            {sidebarGroups.map(group => {
              const isDeleted = group.key === '__deleted__';
              const isUntagged = group.key === '__untagged__';
              const collapsed = isUntagged ? untaggedCollapsed : !expandedGroups.has(group.key);
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
                    <GroupDropZone id={`group:${group.key}`}>
                      <SortableContext
                        items={group.entries.map(({ page }) => String(page.id))}
                        strategy={verticalListSortingStrategy}
                      >
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
                            disableDrag={isDeleted}
                            onToggleDelete={() => toggleDelete(page.id)}
                            onMarkBlank={(isBlank) => onSetPagesSilent(pages.map(p => p.id === page.id ? { ...p, isBlank } : p))}
                            onClick={(e) => handleThumbClick(idx, e)}
                            onContextMenu={(e) => handleThumbContextMenu(idx, e)}
                          />
                        ))}
                      </SortableContext>
                    </GroupDropZone>
                  )}
                </div>
              );
            })}
          </div>
          </DndContext>
        )}
          </div>
        )}

        {/* Bottom pane — section names (fixed ~50%, scrolls independently) so
            thumbnails above are never pushed out of view. */}
        <div className="sidebar-sections-pane">
          <div className="sidebar-sections-title">Sections</div>
          {sidebarGroups.length === 0 && (
            <div className="sidebar-sections-empty">No pages yet.</div>
          )}
          {sidebarGroups.map(group => {
            const isDeleted = group.key === '__deleted__';
            const isUntagged = group.key === '__untagged__';
            const tag = group.tag;
            const name = isUntagged ? 'Untagged' : isDeleted ? 'Deleted' : tag!;
            const active = sectionGrid?.key === group.key;
            const modified = tag ? isExportNameModified(tag, exportNames) : false;
            return (
              <div
                key={group.key}
                className={`sidebar-section-row${active ? ' active' : ''}${isDeleted ? ' deleted' : ''}${isUntagged ? ' untagged' : ''}`}
                onClick={() => {
                  if (renamingSection !== tag) {
                    openSectionGrid(group.key, name, group.entries);
                  }
                }}
                title="Show all pages in this section"
              >
                {renamingSection === tag && tag ? (
                  <input
                    type="text"
                    className="sidebar-section-rename-input tag-label-text"
                    value={renameSectionValue}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameSectionValue(e.target.value)}
                    onBlur={() => commitSectionRename(tag)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitSectionRename(tag);
                      if (e.key === 'Escape') setRenamingSection(null);
                    }}
                  />
                ) : (
                  <span className="sidebar-section-name tag-label-text">
                    {name}{modified && tag ? ` → ${getExportFileName(tag, exportNames)}` : ''}
                  </span>
                )}
                <span className="sidebar-section-count">{group.entries.length}p</span>
                {!isDeleted && !isUntagged && tag && renamingSection !== tag && (
                  <button
                    className="btn-icon btn-sm"
                    title="Rename section"
                    onClick={(e) => { e.stopPropagation(); startSectionRename(tag); }}
                  >
                    <Pencil size={12} />
                  </button>
                )}
                {!isDeleted && !isUntagged && (
                  <button
                    className="btn btn-secondary btn-sm"
                    style={{ flexShrink: 0, padding: '2px 8px' }}
                    onClick={(e) => { e.stopPropagation(); onExport(tag); }}
                    disabled={isExporting}
                  >
                    Save
                  </button>
                )}
              </div>
            );
          })}
        </div>

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
          <div className="preview-page-info">
            <span className="preview-page-num">
              {activeSectionGrid
                ? `${activeSectionGrid.entries.length} pages in section`
                : multiSelected
                  ? `${selectedIds.size} pages selected`
                  : `Page ${primaryIndex + 1} of ${pages.length}`}
            </span>
            {!multiSelected && !activeSectionGrid && activePage && (
              activePage.tag ? (
                <button
                  type="button"
                  className="preview-page-tag preview-page-tag-btn"
                  onClick={() => openGridForPage(activePage)}
                  title="Show all pages in this section"
                >
                  <span className="tag-label-text">{activePage.tag}</span>
                  {isExportNameModified(activePage.tag, exportNames) && (
                    <>
                      <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>→</span>
                      <span className="export-name-text">{getExportFileName(activePage.tag, exportNames)}</span>
                    </>
                  )}
                </button>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>untagged — right-click for options</span>
              )
            )}
            {activeSectionGrid && (
              <span className="preview-page-tag">
                <span className="tag-label-text">{activeSectionGrid.label}</span>
                {activeSectionGrid.key === '__untagged__' && (
                  <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 400 }}>
                    · click to select · right-click for options
                  </span>
                )}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
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
            <button
              className="btn-icon"
              title="Crop page"
              onClick={() => activePage && onRequestCrop(activePage.id)}
              disabled={!activePage || activePage.isDeleted}
            >
              <Crop size={15} />
            </button>
            {activePage?.isCover && (
              <button
                className="btn-icon"
                title="Re-adjust cover corners"
                onClick={() => onReadjustCover(activePage.id)}
              >
                <Scan size={15} />
              </button>
            )}
            <div style={{ width: 1, height: 18, background: 'var(--separator)' }} />
            <button
              className="btn-icon"
              title="Insert PDF page"
              onClick={onInsertPdf}
            >
              <FilePlus size={15} />
            </button>
            <button
              className="btn-icon"
              title="Scan cover with phone"
              onClick={onScanCover}
            >
              <Smartphone size={15} />
            </button>
            <div className="tags-toolbar-wrap" ref={wordsPanelRef}>
              <button
                className={`btn btn-sm btn-secondary${showWordsPanel ? ' tags-panel-open' : ''}`}
                title="Manage autocomplete words for tagging"
                onClick={() => setShowWordsPanel(v => !v)}
              >
                <Type size={13} />
                Words
              </button>
              {showWordsPanel && (
                <div className="tags-panel-dropdown fade-in">
                  <div className="tags-panel-header">
                    <span style={{ fontWeight: 600, fontSize: 13 }}>Tag words</span>
                    <button type="button" className="btn-icon btn-sm" onClick={() => setShowWordsPanel(false)}>
                      <X size={14} />
                    </button>
                  </div>
                  <WordListEditor />
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
          </div>
        </div>

        {/* Preview canvas zone — single or split */}
        <div className={`preview-canvas-zone${isSplitView && !activeSectionGrid ? ' split' : ''}`}>
          {/* Primary pane */}
          <div
            className={`preview-pane${isSplitView && !activeSectionGrid ? ' split-pane' : ''}${isSplitView && activePaneIsLeft ? ' pane-active' : ''}${activeSectionGrid ? ' section-grid-pane' : ''}`}
            onClick={() => isSplitView && !activeSectionGrid && setActivePaneIsLeft(true)}
          >
            {pages.some(p => !p.isDeleted) ? (
              activeSectionGrid ? (
                <SectionGridPreview
                  pdfDoc={pdfDoc}
                  label={activeSectionGrid.label}
                  entries={activeSectionGrid.entries}
                  activeIndex={primaryIndex}
                  selectedIds={selectedIds}
                  zoom={ZOOM_STEPS[leftZoomIdx]}
                  onPageClick={handleGridPageClick}
                  onPageDoubleClick={(idx) => exitGridToPageView(idx)}
                  onPageContextMenu={handleThumbContextMenu}
                  onReorder={handleGridReorder}
                  onClose={exitSectionGrid}
                  emptyHint={
                    activeSectionGrid.key === '__untagged__'
                      ? 'All pages are tagged — pick a section below, or double-click a page in another section.'
                      : undefined
                  }
                />
              ) : activePage ? (
                <LargePagePreview
                  pdfDoc={pdfDoc}
                  pageIndex={activePage.pageIndex}
                  rotation={activePage.rotation}
                  zoom={ZOOM_STEPS[leftZoomIdx]}
                  onContextMenu={(e) => handleThumbContextMenu(primaryIndex, e)}
                />
              ) : (
                <div className="empty-state">
                  <Tag size={28} style={{ opacity: 0.25 }} />
                  <span>No pages</span>
                </div>
              )
            ) : (
              <div className="empty-state">
                <Tag size={28} style={{ opacity: 0.25 }} />
                <span>No pages</span>
              </div>
            )}
            {isSplitView && !activeSectionGrid && (
              <div className="split-pane-label">
                Page {primaryIndex + 1}
                {activePage?.tag && (
                  <span style={{ marginLeft: 6, opacity: 0.7 }}>· {activePage.tag}</span>
                )}
              </div>
            )}
          </div>

          {/* Split divider */}
          {isSplitView && !activeSectionGrid && <div className="split-divider" />}

          {/* Secondary pane */}
          {isSplitView && !activeSectionGrid && (
            <div
              className={`preview-pane split-pane${!activePaneIsLeft ? ' pane-active' : ''}`}
              style={{ position: 'relative' }}
              onClick={() => setActivePaneIsLeft(false)}
            >
              {splitPage ? (
                <LargePagePreview
                  pdfDoc={pdfDoc}
                  pageIndex={splitPage.pageIndex}
                  rotation={splitPage.rotation}
                  zoom={ZOOM_STEPS[rightZoomIdx]}
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
            <div className="settings-section-title">Section shortcuts</div>
            <BasicTagsEditor
              presets={presets}
              onSetPresets={onSetPresets}
              onRename={handlePresetRename}
            />
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
            <div className="settings-section-title">Exclude from full file (ORG SCAN)</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
              Sections whose name contains any of these are left out of the full file.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
              {masterExcludeTags.length === 0 && (
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>None — full file includes everything.</span>
              )}
              {masterExcludeTags.map(t => (
                <span key={t} className="tag-pop-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'default' }}>
                  {t}
                  <button
                    title="Remove"
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 0, lineHeight: 1 }}
                    onClick={() => onSetMasterExcludeTags(masterExcludeTags.filter(x => x !== t))}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
            <input
              type="text"
              value={excludeTagInput}
              placeholder="Add a tag to exclude, then Enter"
              onChange={e => setExcludeTagInput(e.target.value.toUpperCase())}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  const v = excludeTagInput.trim();
                  if (v) onSetMasterExcludeTags([...masterExcludeTags, v]);
                  setExcludeTagInput('');
                }
              }}
              style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '6px 8px', border: '1px solid var(--separator)', borderRadius: 6, textTransform: 'uppercase' }}
            />
          </div>

          <div>
            <div className="settings-section-title">File</div>
            <button className="btn btn-danger-ghost btn-sm" style={{ width: '100%', justifyContent: 'center' }} onClick={onBack}>
              Close file
            </button>
          </div>
        </div>
      )}

      {/* Right-click page menu */}
      {contextMenu && (() => {
        const page = pages[contextMenu.pageIdx];
        if (!page) return null;
        const targetIds = getContextMenuPageIds(contextMenu.pageIdx);
        const targetPages = pages.filter(p => targetIds.includes(p.id));
        const canCrop = targetPages.length === 1 && !targetPages[0].isDeleted;
        const canReadjustCover = targetPages.length === 1 && !!targetPages[0].isCover;
        const isBlank = targetPages.length > 0 && targetPages.every(p => p.isBlank);
        return (
          <PageContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            targetCount={targetIds.length}
            words={tagWords}
            usedInFile={usedInFileTags}
            currentTag={page.tag}
            isDeleted={page.isDeleted}
            isBlank={isBlank}
            canCrop={canCrop}
            canReadjustCover={canReadjustCover}
            onSelectTag={(tag) => commitTagFromPopup(tag, getContextMenuTargets(contextMenu.pageIdx))}
            onWordSelect={(word) => {
              const base = page.tag?.trim();
              const next = base ? `${base} ${word}` : word;
              setTagEditorMenu({
                x: contextMenu.x,
                y: contextMenu.y,
                pageIdx: contextMenu.pageIdx,
                initialValue: next,
              });
            }}
            onOpenTagEditor={() => setTagEditorMenu({
              x: contextMenu.x,
              y: contextMenu.y,
              pageIdx: contextMenu.pageIdx,
            })}
            onClearTag={() => tagPages(undefined, getContextMenuTargets(contextMenu.pageIdx))}
            onRotate={(deg) => rotateTargets(contextMenu.pageIdx, deg)}
            onCrop={() => { if (canCrop) onRequestCrop(targetPages[0].id); }}
            onReadjustCover={() => { if (canReadjustCover) onReadjustCover(targetPages[0].id); }}
            onToggleBlank={() => toggleBlankTargets(contextMenu.pageIdx)}
            onToggleDelete={() => toggleDeleteTargets(contextMenu.pageIdx)}
            onClose={() => setContextMenu(null)}
          />
        );
      })()}

      {tagEditorMenu && (
        <TagPopup
          x={tagEditorMenu.x}
          y={tagEditorMenu.y}
          targetCount={getContextMenuTargets(tagEditorMenu.pageIdx).size}
          currentTag={pages[tagEditorMenu.pageIdx]?.tag}
          initialValue={tagEditorMenu.initialValue}
          usedInFile={usedInFileTags}
          onCommit={(tag) => { commitTagFromPopup(tag, getContextMenuTargets(tagEditorMenu.pageIdx)); setTagEditorMenu(null); }}
          onClear={() => { tagPages(undefined, getContextMenuTargets(tagEditorMenu.pageIdx)); setTagEditorMenu(null); }}
          onClose={() => setTagEditorMenu(null)}
        />
      )}

      {/* Re-tag conflict prompt */}
      {tagConflict && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setTagConflict(null)}
        >
          <div
            style={{ background: 'var(--bg-card)', borderRadius: 14, width: 'min(420px, 92vw)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <b style={{ fontSize: 15 }}>“{tagConflict.tag}” is already used</b>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.5 }}>
                Some other pages are already tagged <b>{tagConflict.tag}</b>. Merge these {tagConflict.targets.size} page(s) into that section (one export file), or keep them separate as a new section?
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                className="btn btn-primary"
                onClick={() => { applyTag(tagConflict.tag, tagConflict.targets); setTagConflict(null); }}
              >
                Merge into “{tagConflict.tag}”
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  const newTag = nextTagVariant(tagConflict.tag);
                  if (!presets.some(p => p.toLowerCase() === newTag.toLowerCase())) onSetPresets([...presets, newTag]);
                  applyTag(newTag, tagConflict.targets);
                  setTagConflict(null);
                }}
              >
                Create new section “{nextTagVariant(tagConflict.tag)}”
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setTagConflict(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Export progress toast */}
      {isExporting && exportProgress && (
        <div className="export-toast">
          <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2, borderColor: 'rgba(255,255,255,0.3)', borderTopColor: 'white' }} />
          {exportProgress}
          {!/^(Done|Cancelling)/.test(exportProgress) && (
            <button
              onClick={onCancelExport}
              style={{
                marginLeft: 10, padding: '2px 10px', borderRadius: 6, fontSize: 12,
                fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
                background: 'rgba(255,255,255,0.15)', color: '#fff',
                border: '1px solid rgba(255,255,255,0.35)',
              }}
            >
              Cancel
            </button>
          )}
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
