import { useState, useEffect, useRef, useCallback } from 'react';
import { WelcomeScreen } from './components/WelcomeScreen';
import { Workspace } from './components/Workspace';
import { getPdfPageCount, processAndSplitPDF, appendImagePage, ProcessedPage } from './utils/pdfProcessor';
import { ScanCoverModal } from './components/ScanCoverModal';
import { filterBasicPresets, getExportFileName } from './utils/tagUtils';
import { getFileKey, loadSession, saveSession } from './utils/sessionStorage';
import {
  supportsFileSystemAccess,
  hasOutputDirectory,
  pickOutputDirectory,
  writeFilesToDirectory,
} from './utils/fileSystem';
import { FileText, X, Plus } from 'lucide-react';

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

export default function App() {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfBuffer, setPdfBuffer] = useState<ArrayBuffer | null>(null);
  const [pages, setPages] = useState<ProcessedPage[]>([]);
  const [presets, setPresets] = useState<string[]>([]);
  const [exportNames, setExportNames] = useState<Record<string, string>>({});
  const [outputDirectory, setOutputDirectory] = useState<string>('');
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState('');
  const activeFileKeyRef = useRef<string | null>(null);

  // Multi-file queue. The active file's buffer/pages live in the states
  // above; everything else is just File handles until switched to.
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Monotonic token so a slow FileReader can't clobber a newer switch.
  const loadTokenRef = useRef(0);
  const addInputRef = useRef<HTMLInputElement>(null);

  // Mobile cover scanning
  const [showScanModal, setShowScanModal] = useState(false);

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
    const saved = localStorage.getItem('pdf_pager_presets');
    if (saved) {
      try {
        setPresets(filterBasicPresets(JSON.parse(saved)));
      } catch {
        setPresets(['docs', 'pops']);
      }
    } else {
      const defaults = ['docs', 'pops'];
      setPresets(defaults);
      localStorage.setItem('pdf_pager_presets', JSON.stringify(defaults));
    }
    const savedDir = localStorage.getItem('pdf_pager_output_dir');
    if (savedDir) setOutputDirectory(savedDir);
  }, []);

  const handleSetPresets = (p: string[]) => {
    const basic = filterBasicPresets(p);
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
  // are stripped: they reference pages appended to the in-memory buffer
  // only, and saving them would also break the session's pageCount check
  // against the original file (v1: covers are re-scanned after reopening).
  useEffect(() => {
    const fileKey = activeFileKeyRef.current;
    if (!fileKey || !pdfFile || pages.length === 0) return;
    const timer = setTimeout(() => {
      saveSession(fileKey, pdfFile.name, pages.filter(p => !p.isCover), exportNames);
    }, 400);
    return () => clearTimeout(timer);
  }, [pages, exportNames, pdfFile]);

  const saveActiveSession = () => {
    if (pdfFile && activeFileKeyRef.current && pages.length > 0) {
      saveSession(activeFileKeyRef.current, pdfFile.name, pages.filter(p => !p.isCover), exportNames);
    }
  };

  // Inserts a phone-scanned cover: the image becomes a real PDF page
  // appended at the END of the buffer (existing pageIndex values stay
  // valid), and its entry goes to the top of the chosen tag section —
  // array order is export order, so the cover exports on top.
  const handleInsertCover = useCallback(async (imageBytes: ArrayBuffer, mime: string, tag: string | null) => {
    if (!pdfBuffer) throw new Error('No document is open.');
    const { buffer, pageIndex } = await appendImagePage(pdfBuffer, imageBytes, mime);
    const current = pagesRef.current;
    const newPage: ProcessedPage = {
      id: current.reduce((m, p) => Math.max(m, p.id), 0) + 1,
      pageIndex,
      isDeleted: false,
      isBlank: false,
      rotation: 0,
      tag: tag ?? undefined,
      isCover: true,
    };
    let insertAt = 0;
    if (tag) {
      const idx = current.findIndex(p => p.tag === tag && !p.isDeleted);
      insertAt = idx >= 0 ? idx : 0;
    }
    const next = [...current.slice(0, insertAt), newPage, ...current.slice(insertAt)];
    setPdfBuffer(buffer);
    handleSetPages(next); // records undo history
  }, [pdfBuffer, handleSetPages]);

  // Reads a file's bytes and makes it the active document. Per-file tags and
  // progress are restored from the saved session (keyed by file metadata).
  const loadFile = (file: File) => {
    const token = ++loadTokenRef.current;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const buffer = reader.result as ArrayBuffer;
        const pageCount = await getPdfPageCount(buffer);
        if (token !== loadTokenRef.current) return; // superseded by a newer switch
        const fileKey = getFileKey(file);
        const saved = loadSession(fileKey, pageCount);

        const initialPages: ProcessedPage[] = saved?.pages ?? Array.from(
          { length: pageCount },
          (_, idx) => ({
            id: idx + 1,
            pageIndex: idx,
            isDeleted: false,
            isBlank: false,
            rotation: 0,
          })
        );

        activeFileKeyRef.current = fileKey;
        resetHistory();
        setPdfBuffer(buffer);
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
    setPdfBuffer(null);
    setPages([]);
    setExportNames({});
    activeFileKeyRef.current = null;
    setActiveKey(null);
    setQueue([]);
    resetHistory();
  };

  const handleExport = async (targetTag?: string) => {
    if (!pdfBuffer || pages.length === 0) return;

    try {
      setIsExporting(true);
      const exportLabel = targetTag ? getExportFileName(targetTag, exportNames) : '';
      setExportProgress(targetTag ? `Saving ${exportLabel}.pdf…` : 'Processing…');

      const processedFiles = await processAndSplitPDF(pdfBuffer, pages, exportNames, targetTag);

      if (processedFiles.length === 0) {
        alert(targetTag ? `No active pages tagged as "${targetTag}".` : 'No tagged pages to export.');
        setIsExporting(false);
        setExportProgress('');
        return;
      }

      setExportProgress(`Saving ${processedFiles.length} file(s)…`);

      if (window.electronAPI) {
        // Desktop (Electron): native folder picker + write via IPC.
        let targetDir = outputDirectory;
        if (!targetDir) {
          const selected = await window.electronAPI.selectDirectory();
          if (!selected) { setIsExporting(false); setExportProgress(''); return; }
          targetDir = selected;
          handleSetOutputDirectory(selected);
        }
        const result = await window.electronAPI.savePDFs(targetDir, processedFiles);
        if (result.success) {
          setExportProgress('Done!');
          setTimeout(() => { setIsExporting(false); setExportProgress(''); }, 1200);
        } else {
          throw new Error(result.error || 'Failed to write files');
        }
      } else if (supportsFileSystemAccess()) {
        // Browser (Chrome/Edge): write straight into a user-chosen folder.
        if (!hasOutputDirectory()) {
          const name = await pickOutputDirectory();
          if (!name) { setIsExporting(false); setExportProgress(''); return; }
          handleSetOutputDirectory(name);
        }
        await writeFilesToDirectory(processedFiles);
        setExportProgress('Done!');
        setTimeout(() => { setIsExporting(false); setExportProgress(''); }, 1200);
      } else {
        // Older browsers (Safari/Firefox): download each file individually.
        for (const file of processedFiles) {
          const blob = new Blob([file.data.buffer as ArrayBuffer], { type: 'application/pdf' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = file.fileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
        setTimeout(() => { setIsExporting(false); setExportProgress(''); }, 1200);
      }
    } catch (error: any) {
      alert(`Export failed: ${error.message}`);
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

        {/* Right side — empty, settings gear lives inside Workspace */}
        <div style={{ width: 80 }} />
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
            isExporting={isExporting}
            exportProgress={exportProgress}
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
    </div>
  );
}
