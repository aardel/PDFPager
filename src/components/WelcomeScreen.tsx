import React, { useState, useRef } from 'react';
import { UploadCloud } from 'lucide-react';

interface WelcomeScreenProps {
  onFileSelect: (file: File) => void;
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onFileSelect }) => {
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
    const file = e.dataTransfer.files[0];
    if (file && (file.type === 'application/pdf' || file.name.endsWith('.pdf'))) {
      onFileSelect(file);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFileSelect(file);
  };

  return (
    <div className="welcome-root">
      <div className="welcome-card fade-in">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            Open a scanned PDF
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
          <input ref={fileInputRef} type="file" className="hidden" accept=".pdf" onChange={handleChange} style={{ display: 'none' }} />
          <div className="drop-zone-icon">
            <UploadCloud size={22} />
          </div>
          <span className="drop-zone-title">Drop PDF here</span>
          <span className="drop-zone-sub">or click to browse</span>
        </div>
      </div>
    </div>
  );
};
