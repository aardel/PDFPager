import { useState, useEffect, useRef, useCallback } from 'react';
import { WelcomeScreen } from './components/WelcomeScreen';
import { Workspace } from './components/Workspace';
import { getPdfPageCount, processAndSplitPDF, ProcessedPage } from './utils/pdfProcessor';
import { filterBasicPresets, getExportFileName } from './utils/tagUtils';
import { getFileKey, loadSession, saveSession } from './utils/sessionStorage';
import {
  supportsFileSystemAccess,
  hasOutputDirectory,
  pickOutputDirectory,
  writeFilesToDirectory,
} from './utils/fileSystem';
import { FileText } from 'lucide-react';

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

  // Auto-save page tags, order, and export names per file
  useEffect(() => {
    const fileKey = activeFileKeyRef.current;
    if (!fileKey || !pdfFile || pages.length === 0) return;
    const timer = setTimeout(() => {
      saveSession(fileKey, pdfFile.name, pages, exportNames);
    }, 400);
    return () => clearTimeout(timer);
  }, [pages, exportNames, pdfFile]);

  const handleFileSelect = (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const buffer = reader.result as ArrayBuffer;
        const pageCount = await getPdfPageCount(buffer);
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
        setPdfBuffer(buffer);
        setPages(initialPages);
        setExportNames(saved?.exportNames ?? {});
        setPdfFile(file);
      } catch {
        alert('Could not parse the selected PDF file. Please ensure it is a valid, unencrypted PDF.');
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleBackToWelcome = () => {
    if (!pdfFile || !activeFileKeyRef.current) {
      setPdfFile(null);
      setPdfBuffer(null);
      setPages([]);
      setExportNames({});
      activeFileKeyRef.current = null;
      return;
    }
    if (confirm('Close this file? Your tags and progress are saved for next time.')) {
      saveSession(activeFileKeyRef.current, pdfFile.name, pages, exportNames);
      setPdfFile(null);
      setPdfBuffer(null);
      setPages([]);
      setExportNames({});
      activeFileKeyRef.current = null;
    }
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

        {pdfFile && (
          <div className="file-chip">
            <FileText size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            <span>{pdfFile.name}</span>
          </div>
        )}

        {/* Right side — empty, settings gear lives inside Workspace */}
        <div style={{ width: 80 }} />
      </header>

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {!pdfFile || !pdfBuffer ? (
          <WelcomeScreen onFileSelect={handleFileSelect} />
        ) : (
          <Workspace
            pdfFile={pdfFile}
            pdfBuffer={pdfBuffer}
            pages={pages}
            presets={presets}
            exportNames={exportNames}
            outputDirectory={outputDirectory}
            onSetPages={setPages}
            onSetPresets={handleSetPresets}
            onSetExportNames={handleSetExportNames}
            onSetOutputDirectory={handleSetOutputDirectory}
            onExport={handleExport}
            onBack={handleBackToWelcome}
            isExporting={isExporting}
            exportProgress={exportProgress}
          />
        )}
      </div>
    </div>
  );
}
