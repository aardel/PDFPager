import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { WelcomeScreen } from './components/WelcomeScreen';
import { Workspace } from './components/Workspace';
import { WorkspaceViewBar } from './components/WorkspaceViewBar';
import type { WorkspaceChrome } from './components/workspaceChrome';
import { getPdfPageCount, processAndSplitPDF, buildCleanedDocument, appendImagePage, appendPdfPages, bakeCrops, cropSignature, ProcessedPage, CropRect, ExportCancelled, isAppendedPage } from './utils/pdfProcessor';
import { ScanCoverModal } from './components/ScanCoverModal';
import { InsertPdfModal } from './components/InsertPdfModal';
import { CropModal } from './components/CropModal';
import { filterBasicPresets, getExportFileName, sanitizeExportFileName } from './utils/tagUtils';
import { getFileKey, loadSession, saveSession } from './utils/sessionStorage';
import { saveCoverImage, loadCoverImage, loadCoverRaw, pruneCoverImages } from './utils/coverStore';
import {
  supportsFileSystemAccess,
  hasOutputDirectory,
  pickOutputDirectory,
  writeFilesToDirectory,
  getOutputDirectoryName,
} from './utils/fileSystem';
import { FileText, X, Plus, LogOut } from 'lucide-react';
import { useAuth } from './components/AuthGate';
import { authRequired } from './utils/auth';

interface ElectronAPI {
  selectDirectory: () => Promise<string | null>;
  savePDFs: (
    folderPath: string,
    files: { fileName: string; data: Uint8Array }[]
  ) => Promise<{ success: boolean; savedFiles?: string[]; error?: string }>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

// A queued file holds only the File handle — bytes are read lazily when the
// file becomes active, so a long scanning queue doesn't pile up ArrayBuffers.
interface QueueItem {
  file: File;
  key: string;
}

// Starting tag list. Seeded once (keyed by SEED_VERSION) so existing installs
// pick it up too; users can add more from here and additions persist. Bump
// SEED_VERSION to re-seed if this list changes.
const SEED_TAGS = [
  'MINUTES',
  'APPLICATION',
  'ETC JOB HISTORY',
  'HSBC STATEMENT',
  'WITHDRAWAL ADVICE',
  'BANK BALANCE',
  'HSBC CONSOLIDATED SHEET',
  'MEDICAL BOARD REPORT',
  'CASE REVIEW + ID CARDS',
];
const SEED_VERSION = '2026-06-13-casefiles';

// The full cleaned master saved into ORG SCAN omits this section.
const MASTER_EXCLUDE_TAG = 'MINUTES';
// Subfolder (next to the split files) holding the cleaned master.
const ORG_SCAN_FOLDER = 'ORG SCAN';

// Case-insensitive dedupe, preserving first occurrence and order.
function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

export default function App() {
  const { logout } = useAuth();
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  // sourceBuffer = uncropped (original + scanned covers). pdfBuffer = the
  // baked buffer with crops applied as CropBoxes; it's what the preview,
  // thumbnails and exports consume. The crop editor reads sourceBuffer so a
  // crop can always be re-edited (even expanded back out).
  const [sourceBuffer, setSourceBuffer] = useState<ArrayBuffer | null>(null);
  const [pdfBuffer, setPdfBuffer] = useState<ArrayBuffer | null>(null);
  const sourceBufferRef = useRef<ArrayBuffer | null>(null);
  useEffect(() => { sourceBufferRef.current = sourceBuffer; }, [sourceBuffer]);
  const [cropTargetId, setCropTargetId] = useState<number | null>(null);
  const [pages, setPages] = useState<ProcessedPage[]>([]);
  const [presets, setPresets] = useState<string[]>([]);
  const [exportNames, setExportNames] = useState<Record<string, string>>({});
  const [outputDirectory, setOutputDirectory] = useState<string>('');
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState('');
  // Checked between files during export; Cancel in the progress toast sets it.
  const exportCancelRef = useRef(false);
  const activeFileKeyRef = useRef<string | null>(null);
  const [workspaceChrome, setWorkspaceChrome] = useState<WorkspaceChrome | null>(null);

  // Multi-file queue.
  // above; everything else is just File handles until switched to.
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Monotonic token so a slow FileReader can't clobber a newer switch.
  const loadTokenRef = useRef(0);
  const addInputRef = useRef<HTMLInputElement>(null);

  // Mobile cover scanning
  const [showScanModal, setShowScanModal] = useState(false);

  // Insert external PDF at top of a tag section
  const insertPdfInputRef = useRef<HTMLInputElement>(null);
  const [insertPdfPending, setInsertPdfPending] = useState<{
    bytes: ArrayBuffer; name: string; pageCount: number;
  } | null>(null);

  // Undo/redo history for page mutations (delete, rotate, tag, reorder).
  // Snapshots are just the pages array (small metadata objects, no canvases),
  // so keeping up to MAX_HISTORY of them is cheap. Export-name edits are
  // per-keystroke inputs and deliberately not tracked.
  const MAX_HISTORY = 100;
  const historyRef = useRef<ProcessedPage[][]>([]);
  const futureRef = useRef<ProcessedPage[][]>([]);
  // Ref mirror of `pages` so stable callbacks can read the latest array
  // without stale closures (and without side effects inside setState updaters).
  const pagesRef = useRef<ProcessedPage[]>([]);
  useEffect(() => { pagesRef.current = pages; }, [pages]);

  // Re-bake crops into pdfBuffer whenever the source buffer or the crop set
  // changes (covers undo/redo and crop edits alike). loadFile bakes inline
  // and records the key here so this effect doesn't redundantly re-bake on
  // first load.
  const cropSig = useMemo(() => cropSignature(pages), [pages]);
  const lastBakeRef = useRef<{ src: ArrayBuffer | null; sig: string }>({ src: null, sig: '' });
  useEffect(() => {
    if (!sourceBuffer) return;
    if (lastBakeRef.current.src === sourceBuffer && lastBakeRef.current.sig === cropSig) return;
    let alive = true;
    (async () => {
      const baked = await bakeCrops(sourceBuffer, pagesRef.current);
      if (!alive) return;
      lastBakeRef.current = { src: sourceBuffer, sig: cropSig };
      setPdfBuffer(baked);
    })();
    return () => { alive = false; };
  }, [sourceBuffer, cropSig]);

  const resetHistory = () => {
    historyRef.current = [];
    futureRef.current = [];
  };

  // User-initiated page changes go through here and record history.
  const handleSetPages = useCallback((next: ProcessedPage[]) => {
    historyRef.current.push(pagesRef.current);
    if (historyRef.current.length > MAX_HISTORY) historyRef.current.shift();
    futureRef.current = [];
    setPages(next);
  }, []);

  // Blank auto-detection is a render side-effect, not a user action — it
  // updates pages without polluting the history stack.
  const handleSetPagesSilent = useCallback((next: ProcessedPage[]) => {
    setPages(next);
  }, []);

  // isBlank flags are detected lazily as thumbnails render, possibly after a
  // snapshot was taken. Carry the freshest flags into restored snapshots so
  // undo doesn't make "blank" badges vanish.
  const withCurrentBlanks = (snap: ProcessedPage[], current: ProcessedPage[]) => {
    const blanks = new Map(current.map(p => [p.id, p.isBlank]));
    return snap.map(p => {
      const b = blanks.get(p.id);
      return b !== undefined && b !== p.isBlank ? { ...p, isBlank: b } : p;
    });
  };

  const undo = useCallback(() => {
    const prev = historyRef.current.pop();
    if (!prev) return;
    futureRef.current.push(pagesRef.current);
    setPages(withCurrentBlanks(prev, pagesRef.current));
  }, []);

  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) return;
    historyRef.current.push(pagesRef.current);
    setPages(withCurrentBlanks(next, pagesRef.current));
  }, []);

  // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl+Y = redo. Skipped while
  // typing in inputs so native text-field undo keeps working.
  useEffect(() => {
    if (!pdfFile) return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pdfFile, undo, redo]);

  useEffect(() => {
    let existing: string[] = [];
    const saved = localStorage.getItem('pdf_pager_presets');
    if (saved) {
      try { existing = filterBasicPresets(JSON.parse(saved)); } catch { existing = []; }
    }

    if (localStorage.getItem('pdf_pager_presets_seed') !== SEED_VERSION) {
      // One-time seed: replace whatever was saved with exactly SEED_TAGS.
      const seeded = dedupeTags(SEED_TAGS);
      setPresets(seeded);
      localStorage.setItem('pdf_pager_presets', JSON.stringify(seeded));
      localStorage.setItem('pdf_pager_presets_seed', SEED_VERSION);
    } else {
      setPresets(existing);
    }

    const savedDir = localStorage.getItem('pdf_pager_output_dir');
    if (savedDir) setOutputDirectory(savedDir);
  }, []);

  const handleSetPresets = (p: string[]) => {
    const basic = dedupeTags(filterBasicPresets(p));
    setPresets(basic);
    localStorage.setItem('pdf_pager_presets', JSON.stringify(basic));
  };

  const handleSetOutputDirectory = (dir: string) => {
    setOutputDirectory(dir);
    localStorage.setItem('pdf_pager_output_dir', dir);
  };

  const handleSetExportNames = useCallback((names: Record<string, string>) => {
    setExportNames(names);
  }, []);

  // Auto-save page tags, order, and export names per file. Scanned covers
  // are saved too: their position/tag lives in the session (referencing the
  // image bytes in IndexedDB by coverId), and loadFile re-appends them to
  // the fresh buffer on reopen.
  useEffect(() => {
    const fileKey = activeFileKeyRef.current;
    if (!fileKey || !pdfFile || pages.length === 0) return;
    const timer = setTimeout(() => {
      saveSession(fileKey, pdfFile.name, pages, exportNames);
    }, 400);
    return () => clearTimeout(timer);
  }, [pages, exportNames, pdfFile]);

  const saveActiveSession = () => {
    if (pdfFile && activeFileKeyRef.current && pages.length > 0) {
      saveSession(activeFileKeyRef.current, pdfFile.name, pages, exportNames);
    }
  };

  // Inserts a phone-scanned cover: the image becomes a real PDF page
  // appended at the END of the buffer (existing pageIndex values stay
  // valid), and its entry goes to the top of the chosen tag section —
  // array order is export order, so the cover exports on top.
  const handleInsertCover = useCallback(async (
    imageBytes: ArrayBuffer, mime: string, tag: string | null,
    rawBytes?: ArrayBuffer, rawMime?: string,
  ) => {
    const src = sourceBufferRef.current;
    if (!src) throw new Error('No document is open.');
    const { buffer, pageIndex } = await appendImagePage(src, imageBytes, mime);
    // Persist the flattened image (so the cover survives reload) plus the raw
    // capture (so its corners can be re-adjusted later). Best-effort: if
    // IndexedDB is unavailable the insert still works.
    const coverId = crypto.randomUUID();
    const fileKey = activeFileKeyRef.current;
    if (fileKey) {
      try { await saveCoverImage(coverId, fileKey, imageBytes, mime, rawBytes, rawMime); } catch { /* see above */ }
    }
    const current = pagesRef.current;
    const newPage: ProcessedPage = {
      id: current.reduce((m, p) => Math.max(m, p.id), 0) + 1,
      pageIndex,
      isDeleted: false,
      isBlank: false,
      rotation: 0,
      tag: tag ?? undefined,
      isCover: true,
      coverId,
    };
    let insertAt = 0;
    if (tag) {
      const idx = current.findIndex(p => p.tag === tag && !p.isDeleted);
      insertAt = idx >= 0 ? idx : 0;
    }
    const next = [...current.slice(0, insertAt), newPage, ...current.slice(insertAt)];
    setSourceBuffer(buffer); // rebake effect derives the new pdfBuffer
    handleSetPages(next);    // records undo history
  }, [handleSetPages]);

  // Inserts page(s) from an external PDF using the same buffer-append +
  // array-position rules as handleInsertCover. Source bytes are stored in
  // IndexedDB so inserts survive closing and reopening the file.
  const handleInsertPdf = useCallback(async (pdfBytes: ArrayBuffer, tag: string | null) => {
    const src = sourceBufferRef.current;
    if (!src) throw new Error('No document is open.');
    const { buffer, pageIndices } = await appendPdfPages(src, pdfBytes);
    const insertId = crypto.randomUUID();
    const fileKey = activeFileKeyRef.current;
    if (fileKey) {
      try { await saveCoverImage(insertId, fileKey, pdfBytes, 'application/pdf'); } catch { /* best-effort */ }
    }
    const current = pagesRef.current;
    let nextId = current.reduce((m, p) => Math.max(m, p.id), 0);
    const newPages: ProcessedPage[] = pageIndices.map(pageIndex => ({
      id: ++nextId,
      pageIndex,
      isDeleted: false,
      isBlank: false,
      rotation: 0,
      tag: tag ?? undefined,
      isInserted: true,
      insertId,
    }));
    let insertAt = 0;
    if (tag) {
      const idx = current.findIndex(p => p.tag === tag && !p.isDeleted);
      insertAt = idx >= 0 ? idx : 0;
    }
    const next = [...current.slice(0, insertAt), ...newPages, ...current.slice(insertAt)];
    setSourceBuffer(buffer);
    handleSetPages(next);
  }, [handleSetPages]);

  const handleInsertPdfFileSelect = (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const bytes = reader.result as ArrayBuffer;
        const pageCount = await getPdfPageCount(bytes);
        if (pageCount === 0) throw new Error('The PDF has no pages.');
        setInsertPdfPending({ bytes, name: file.name, pageCount });
      } catch {
        alert(`Could not read "${file.name}". Please ensure it is a valid, unencrypted PDF.`);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // Sets/clears a page's crop. The rebake effect picks up the metadata change
  // and re-derives pdfBuffer; export inherits the crop via the baked CropBox.
  const handleCropPage = useCallback((pageId: number, crop: CropRect | null) => {
    const next = pagesRef.current.map(p =>
      p.id === pageId ? { ...p, crop: crop ?? undefined } : p
    );
    handleSetPages(next);
    setCropTargetId(null);
  }, [handleSetPages]);

  // Re-adjust the perspective of an already-inserted cover using its stored
  // raw capture. Opens the corner editor (ScanCoverModal in seed mode).
  const [readjust, setReadjust] = useState<
    { pageId: number; coverId: string; rawBytes: ArrayBuffer; rawMime: string } | null
  >(null);

  const handleReadjustCover = useCallback(async (pageId: number) => {
    const page = pagesRef.current.find(p => p.id === pageId);
    if (!page?.coverId) return;
    const raw = await loadCoverRaw(page.coverId).catch(() => null);
    if (!raw) {
      alert("This cover was scanned before re-adjust was added, so its original photo isn't stored. Re-scan the cover to enable corner editing.");
      return;
    }
    setReadjust({ pageId, coverId: page.coverId, rawBytes: raw.bytes, rawMime: raw.mime });
  }, []);

  // Replaces a cover's flattened image with a freshly re-adjusted one: append
  // the new image (the old page is left orphaned and disappears on reload),
  // repoint the cover's ProcessedPage, and update its stored bytes (raw kept).
  const replaceCover = useCallback(async (
    pageId: number, coverId: string, bytes: ArrayBuffer, mime: string,
    rawBytes: ArrayBuffer, rawMime: string,
  ) => {
    const src = sourceBufferRef.current;
    if (!src) return;
    const { buffer, pageIndex } = await appendImagePage(src, bytes, mime);
    const fileKey = activeFileKeyRef.current;
    if (fileKey) {
      try { await saveCoverImage(coverId, fileKey, bytes, mime, rawBytes, rawMime); } catch { /* best-effort */ }
    }
    setSourceBuffer(buffer);
    const next = pagesRef.current.map(p => p.id === pageId ? { ...p, pageIndex } : p);
    handleSetPages(next);
  }, [handleSetPages]);

  // Reads a file's bytes and makes it the active document. Per-file tags and
  // progress are restored from the saved session (keyed by file metadata).
  const loadFile = (file: File) => {
    const token = ++loadTokenRef.current;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        // Feed the original bytes straight to pdf.js — it decrypts standard
        // encryption natively. (Re-saving through pdf-lib first corrupts
        // encrypted streams, since pdf-lib can't decrypt them.)
        const buffer = reader.result as ArrayBuffer;
        const pageCount = await getPdfPageCount(buffer);
        if (token !== loadTokenRef.current) return; // superseded by a newer switch
        const fileKey = getFileKey(file);
        const saved = loadSession(fileKey, pageCount);

        let initialPages: ProcessedPage[] = saved?.pages ?? Array.from(
          { length: pageCount },
          (_, idx) => ({
            id: idx + 1,
            pageIndex: idx,
            isDeleted: false,
            isBlank: false,
            rotation: 0,
          })
        );

        // Restore appended pages (phone covers + inserted PDFs): re-append
        // bytes from IndexedDB onto the freshly loaded buffer. Saved
        // pageIndex values are stale — appending assigns the real ones.
        let workingBuffer = buffer;
        if (initialPages.some(isAppendedPage)) {
          const restored: ProcessedPage[] = [];
          // Keep every blob the session still references, regardless of whether
          // this load could read it — a transient IndexedDB miss must not cause
          // pruneCoverImages to delete a cover/insert permanently (it can
          // recover on the next reload).
          const keep = new Set<string>();
          for (const p of initialPages) {
            if (p.isCover && p.coverId) keep.add(p.coverId);
            if (p.isInserted && p.insertId) keep.add(p.insertId);
          }
          const insertIndices = new Map<string, number[]>();
          const insertCounters = new Map<string, number>();
          for (const p of initialPages) {
            if (!isAppendedPage(p)) { restored.push(p); continue; }
            if (p.isCover) {
              if (!p.coverId) continue;
              const img = await loadCoverImage(p.coverId).catch(() => null);
              if (!img) continue;
              const res = await appendImagePage(workingBuffer, img.bytes, img.mime);
              workingBuffer = res.buffer;
              restored.push({ ...p, pageIndex: res.pageIndex });
              keep.add(p.coverId);
              continue;
            }
            if (p.isInserted) {
              if (!p.insertId) continue;
              if (!insertIndices.has(p.insertId)) {
                const pdf = await loadCoverImage(p.insertId).catch(() => null);
                if (!pdf) continue;
                const res = await appendPdfPages(workingBuffer, pdf.bytes);
                workingBuffer = res.buffer;
                insertIndices.set(p.insertId, res.pageIndices);
                insertCounters.set(p.insertId, 0);
                keep.add(p.insertId);
              }
              const indices = insertIndices.get(p.insertId)!;
              const n = insertCounters.get(p.insertId)!;
              if (n >= indices.length) continue;
              restored.push({ ...p, pageIndex: indices[n] });
              insertCounters.set(p.insertId, n + 1);
            }
          }
          initialPages = restored;
          pruneCoverImages(fileKey, keep).catch(() => {});
          if (token !== loadTokenRef.current) return; // superseded during restore
        } else {
          pruneCoverImages(fileKey, new Set()).catch(() => {});
        }

        // Bake any saved crops inline so the workspace opens already-cropped
        // (no blank-buffer flash), and record the key so the rebake effect
        // doesn't immediately re-bake the same thing.
        const baked = await bakeCrops(workingBuffer, initialPages);
        if (token !== loadTokenRef.current) return;

        activeFileKeyRef.current = fileKey;
        resetHistory();
        lastBakeRef.current = { src: workingBuffer, sig: cropSignature(initialPages) };
        setSourceBuffer(workingBuffer);
        setPdfBuffer(baked);
        setPages(initialPages);
        setExportNames(saved?.exportNames ?? {});
        setPdfFile(file);
        setActiveKey(fileKey);
      } catch {
        alert(`Could not parse "${file.name}". Please ensure it is a valid, unencrypted PDF.`);
        setQueue(q => q.filter(i => i.key !== getFileKey(file)));
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // Adds PDFs to the queue (deduped by file identity) and activates the
  // first one if nothing is open yet.
  const handleFilesSelect = (files: File[]) => {
    const pdfs = files.filter(
      f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
    );
    if (pdfs.length === 0) return;
    const items = pdfs.map(f => ({ file: f, key: getFileKey(f) }));
    setQueue(q => {
      const existing = new Set(q.map(i => i.key));
      return [...q, ...items.filter(i => !existing.has(i.key))];
    });
    if (!pdfFile) loadFile(pdfs[0]);
  };

  const switchToFile = (key: string) => {
    if (key === activeKey) return;
    const item = queue.find(i => i.key === key);
    if (!item) return;
    saveActiveSession();
    loadFile(item.file);
  };

  const removeFromQueue = (key: string) => {
    const remaining = queue.filter(i => i.key !== key);
    setQueue(remaining);
    if (key !== activeKey) return;
    saveActiveSession();
    if (remaining.length > 0) {
      loadFile(remaining[0].file);
    } else {
      loadTokenRef.current++; // cancel any in-flight load
      setPdfFile(null);
      setSourceBuffer(null);
      setPdfBuffer(null);
      setPages([]);
      setExportNames({});
      activeFileKeyRef.current = null;
      setActiveKey(null);
      resetHistory();
    }
  };

  const handleBackToWelcome = () => {
    if (pdfFile && activeFileKeyRef.current) {
      const msg = queue.length > 1
        ? 'Close all files? Tags and progress are saved for next time.'
        : 'Close this file? Your tags and progress are saved for next time.';
      if (!confirm(msg)) return;
      saveActiveSession();
    }
    loadTokenRef.current++; // cancel any in-flight load
    setPdfFile(null);
    setSourceBuffer(null);
    setPdfBuffer(null);
    setPages([]);
    setExportNames({});
    activeFileKeyRef.current = null;
    setActiveKey(null);
    setQueue([]);
    resetHistory();
  };

  const cancelExport = () => {
    exportCancelRef.current = true;
    setExportProgress('Cancelling…');
  };

  const handleExport = async (targetTag?: string) => {
    if (!pdfBuffer || pages.length === 0) return;

    try {
      setIsExporting(true);
      exportCancelRef.current = false;
      const exportLabel = targetTag ? getExportFileName(targetTag, exportNames) : '';
      setExportProgress(targetTag ? `Saving ${exportLabel}.pdf…` : 'Processing…');

      const shouldCancel = () => exportCancelRef.current;
      const processedFiles = await processAndSplitPDF(
        pdfBuffer, pages, exportNames, targetTag,
        (done, total, name) => setExportProgress(`Building ${name} (${done + 1}/${total})…`),
        shouldCancel
      );

      if (processedFiles.length === 0) {
        alert(targetTag ? `No active pages tagged as "${targetTag}".` : 'No tagged pages to export.');
        setIsExporting(false);
        setExportProgress('');
        return;
      }

      // Resolve the destination folder up front — the full export's master is
      // named after it. Returns null if the user cancelled the picker; '' if
      // there's no real folder (download fallback → master keeps source name).
      let electronDir = '';
      let folderName = (pdfFile?.name.replace(/\.pdf$/i, '')) || 'document';
      if (window.electronAPI) {
        electronDir = outputDirectory;
        if (!electronDir) {
          const selected = await window.electronAPI.selectDirectory();
          if (!selected) { setIsExporting(false); setExportProgress(''); return; }
          electronDir = selected;
          handleSetOutputDirectory(selected);
        }
        folderName = electronDir.split(/[\\/]/).filter(Boolean).pop() || folderName;
      } else if (supportsFileSystemAccess()) {
        if (!hasOutputDirectory()) {
          const name = await pickOutputDirectory();
          if (!name) { setIsExporting(false); setExportProgress(''); return; }
          handleSetOutputDirectory(name);
        }
        folderName = getOutputDirectoryName() || folderName;
      }

      // Full exports also archive a cleaned master: one complete PDF (covers
      // included, deleted pages removed, rotations applied) in ORG SCAN,
      // named after the chosen folder and excluding the MINUTES section.
      if (!targetTag) {
        if (shouldCancel()) throw new ExportCancelled();
        setExportProgress('Building the cleaned master (ORG SCAN)…');
        const masterPages = pages.filter(
          p => (p.tag ?? '').toLowerCase() !== MASTER_EXCLUDE_TAG.toLowerCase()
        );
        const cleaned = await buildCleanedDocument(pdfBuffer, masterPages);
        if (cleaned) {
          processedFiles.push({
            fileName: `${ORG_SCAN_FOLDER}/${sanitizeExportFileName(folderName)}.pdf`,
            data: cleaned,
          });
        }
      }

      if (shouldCancel()) throw new ExportCancelled();
      setExportProgress(`Saving ${processedFiles.length} file(s)…`);

      if (window.electronAPI) {
        const result = await window.electronAPI.savePDFs(electronDir, processedFiles);
        if (result.success) {
          setExportProgress('Done!');
          setTimeout(() => { setIsExporting(false); setExportProgress(''); }, 1200);
        } else {
          throw new Error(result.error || 'Failed to write files');
        }
      } else if (supportsFileSystemAccess()) {
        await writeFilesToDirectory(processedFiles, (done, total, name) => {
          if (exportCancelRef.current) throw new ExportCancelled();
          setExportProgress(`Writing ${name} (${done + 1}/${total})…`);
        });
        setExportProgress('Done!');
        setTimeout(() => { setIsExporting(false); setExportProgress(''); }, 1200);
      } else {
        // Older browsers (Safari/Firefox): download each file individually.
        for (const file of processedFiles) {
          const blob = new Blob([file.data.buffer as ArrayBuffer], { type: 'application/pdf' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          // Downloads can't create folders — flatten "org scan/x.pdf".
          a.download = file.fileName.replace(/\//g, ' - ');
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
        setTimeout(() => { setIsExporting(false); setExportProgress(''); }, 1200);
      }
    } catch (error: any) {
      if (!(error instanceof ExportCancelled)) {
        alert(`Export failed: ${error.message}`);
      }
      setIsExporting(false);
      setExportProgress('');
    }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Header */}
      <header className="app-header">
        <div className="logo-lockup">
          <div className="logo-icon">P</div>
          <span className="logo-text">PDFPager</span>
        </div>

        {queue.length > 0 && (
          <div className="queue-bar">
            {queue.map(item => (
              <button
                key={item.key}
                className={`queue-chip${item.key === activeKey ? ' active' : ''}`}
                onClick={() => switchToFile(item.key)}
                title={item.file.name}
              >
                <FileText size={12} style={{ flexShrink: 0 }} />
                <span className="queue-chip-name">{item.file.name}</span>
                <span
                  className="queue-chip-close"
                  title="Remove from queue"
                  onClick={(e) => { e.stopPropagation(); removeFromQueue(item.key); }}
                >
                  <X size={11} />
                </span>
              </button>
            ))}
            <button
              className="queue-chip queue-chip-add"
              onClick={() => addInputRef.current?.click()}
              title="Add more PDFs to the queue"
            >
              <Plus size={12} />
              <span>Add</span>
            </button>
            <input
              ref={addInputRef}
              type="file"
              accept=".pdf"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files) handleFilesSelect(Array.from(e.target.files));
                e.target.value = '';
              }}
            />
          </div>
        )}

        {/* Right side — view controls + logout; settings gear is fixed top-right in Workspace */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, marginRight: pdfFile ? 44 : 8 }}>
          {workspaceChrome && <WorkspaceViewBar chrome={workspaceChrome} />}
          {authRequired() && (
            <button
              className="btn btn-sm btn-secondary"
              onClick={logout}
              title="Sign out"
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <LogOut size={14} /> Sign out
            </button>
          )}
        </div>
      </header>

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {!pdfFile || !pdfBuffer ? (
          <WelcomeScreen onFilesSelect={handleFilesSelect} />
        ) : (
          <Workspace
            pdfFile={pdfFile}
            pdfBuffer={pdfBuffer}
            pages={pages}
            presets={presets}
            exportNames={exportNames}
            outputDirectory={outputDirectory}
            onSetPages={handleSetPages}
            onSetPagesSilent={handleSetPagesSilent}
            canUndo={historyRef.current.length > 0}
            canRedo={futureRef.current.length > 0}
            onUndo={undo}
            onRedo={redo}
            onSetPresets={handleSetPresets}
            onSetExportNames={handleSetExportNames}
            onSetOutputDirectory={handleSetOutputDirectory}
            onExport={handleExport}
            onBack={handleBackToWelcome}
            onScanCover={() => setShowScanModal(true)}
            onInsertPdf={() => insertPdfInputRef.current?.click()}
            onRequestCrop={(pageId) => setCropTargetId(pageId)}
            onReadjustCover={handleReadjustCover}
            onChromeChange={setWorkspaceChrome}
            isExporting={isExporting}
            exportProgress={exportProgress}
            onCancelExport={cancelExport}
          />
        )}
      </div>

      {showScanModal && pdfFile && (
        <ScanCoverModal
          tags={[...new Set(pages.filter(p => p.tag && !p.isDeleted).map(p => p.tag as string))]}
          onInsert={handleInsertCover}
          onClose={() => setShowScanModal(false)}
        />
      )}

      <input
        ref={insertPdfInputRef}
        type="file"
        accept=".pdf,application/pdf"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) handleInsertPdfFileSelect(file);
        }}
      />

      {insertPdfPending && pdfFile && (
        <InsertPdfModal
          tags={[...new Set(pages.filter(p => p.tag && !p.isDeleted).map(p => p.tag as string))]}
          fileName={insertPdfPending.name}
          pageCount={insertPdfPending.pageCount}
          onInsert={async (tag) => {
            await handleInsertPdf(insertPdfPending.bytes, tag);
            setInsertPdfPending(null);
          }}
          onClose={() => setInsertPdfPending(null)}
        />
      )}

      {readjust && (
        <ScanCoverModal
          tags={[]}
          onInsert={handleInsertCover}
          seed={{
            rawBytes: readjust.rawBytes,
            rawMime: readjust.rawMime,
            onReplace: (bytes, mime) =>
              replaceCover(readjust.pageId, readjust.coverId, bytes, mime, readjust.rawBytes, readjust.rawMime),
          }}
          onClose={() => setReadjust(null)}
        />
      )}

      {cropTargetId != null && sourceBuffer && (() => {
        const page = pages.find(p => p.id === cropTargetId);
        if (!page) return null;
        return (
          <CropModal
            sourceBuffer={sourceBuffer}
            pageIndex={page.pageIndex}
            userRotation={page.rotation}
            initialCrop={page.crop ?? null}
            onApply={(crop) => handleCropPage(cropTargetId, crop)}
            onClose={() => setCropTargetId(null)}
          />
        );
      })()}
    </div>
  );
}
