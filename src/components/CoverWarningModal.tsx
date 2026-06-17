import React from 'react';
import { AlertTriangle, Camera, FilePlus, X } from 'lucide-react';

interface CoverWarningModalProps {
  /** Proceed with the export despite the missing cover. */
  onExportAnyway: () => void;
  /** Cancel the export and open the phone-scan cover flow. */
  onScan: () => void;
  /** Cancel the export and open the insert-PDF picker. */
  onInsertPdf: () => void;
  onClose: () => void;
}

/**
 * Pre-export guard shown when the MINUTES section has no cover (neither a
 * scanned cover nor an inserted PDF). Lets the user add one now or export
 * anyway.
 */
export const CoverWarningModal: React.FC<CoverWarningModalProps> = ({
  onExportAnyway,
  onScan,
  onInsertPdf,
  onClose,
}) => {
  const S: Record<string, React.CSSProperties> = {
    overlay: {
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    },
    modal: {
      background: 'var(--bg-card)', borderRadius: 14,
      width: 'min(440px, 92vw)', maxHeight: '90vh', overflowY: 'auto',
      boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column',
    },
    header: {
      display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px',
      borderBottom: '1px solid var(--separator)',
    },
    body: { padding: 20, display: 'flex', flexDirection: 'column', gap: 14 },
  };

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={S.header}>
          <AlertTriangle size={16} style={{ color: 'var(--warning)' }} />
          <b style={{ fontSize: 14, flex: 1 }}>No cover in MINUTES</b>
          <button className="btn-icon" onClick={onClose} title="Close">
            <X size={15} />
          </button>
        </div>

        <div style={S.body}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            The <b style={{ color: 'var(--text-primary)' }}>MINUTES</b> section doesn't have a
            cover yet — no scanned cover and no inserted PDF cover. Add one now, or export anyway.
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-sm btn-secondary"
              style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              onClick={onScan}
            >
              <Camera size={14} /> Scan cover
            </button>
            <button
              className="btn btn-sm btn-secondary"
              style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              onClick={onInsertPdf}
            >
              <FilePlus size={14} /> Insert PDF
            </button>
          </div>

          <button className="btn btn-sm btn-primary" onClick={onExportAnyway}>
            Export anyway
          </button>
        </div>
      </div>
    </div>
  );
};
