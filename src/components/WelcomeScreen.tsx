import React, { useState, useRef } from 'react';
import { UploadCloud } from 'lucide-react';

interface WelcomeScreenProps {
  onFilesSelect: (files: File[]) => void;
}

const isPdf = (f: File) =>
  f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onFilesSelect }) => {
  const [isDragActive, setIsDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(e.type === 'dragenter' || e.type === 'dragover');
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
    const files = Array.from(e.dataTransfer.files).filter(isPdf);
    if (files.length > 0) onFilesSelect(files);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter(isPdf);
    if (files.length > 0) onFilesSelect(files);
    e.target.value = '';
  };

  return (
    <div className="welcome-root">
      <div className="welcome-card fade-in">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            Open scanned PDFs
          </h1>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', textAlign: 'center', maxWidth: 300, lineHeight: 1.6 }}>
            Import your scanner output to clean, tag, and export pages by document section.
          </p>
        </div>

        <div
          className={`drop-zone${isDragActive ? ' active' : ''}`}
          onDragEnter={handleDrag}
          onDragOver={handleDrag}
          onDragLeave={handleDrag}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input ref={fileInputRef} type="file" className="hidden" accept=".pdf" multiple onChange={handleChange} style={{ display: 'none' }} />
          <div className="drop-zone-icon">
            <UploadCloud size={22} />
          </div>
          <span className="drop-zone-title">Drop PDFs here</span>
          <span className="drop-zone-sub">or click to browse — multiple files become a queue</span>
        </div>
      </div>
    </div>
  );
};
