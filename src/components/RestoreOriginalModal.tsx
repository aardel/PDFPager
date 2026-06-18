import React from 'react';
import { RotateCcw, AlertTriangle, X } from 'lucide-react';

interface RestoreOriginalModalProps {
  fileName: string;
  /** Discard all edits and reopen the pristine original. */
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Confirmation for "Restore original / start over". Restoring is destructive —
 * it throws away every tag, cover, inserted page, crop and edit for this file —
 * so it always asks first.
 */
export const RestoreOriginalModal: React.FC<RestoreOriginalModalProps> = ({
  fileName,
  onConfirm,
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
    body: { padding: 20, display: 'flex', flexDirection: 'column', gap: 16 },
  };

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={S.header}>
          <RotateCcw size={16} style={{ color: 'var(--accent)' }} />
          <b style={{ fontSize: 14, flex: 1 }}>Restore original & start over</b>
          <button className="btn-icon" onClick={onClose} title="Close"><X size={15} /></button>
        </div>

        <div style={S.body}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            This reopens the untouched original of{' '}
            <b style={{ color: 'var(--text-primary)' }}>{fileName}</b> and{' '}
            <b style={{ color: 'var(--text-primary)' }}>permanently discards</b> all tags,
            scanned covers, inserted pages, crops, rotations and deletions for this file.
          </div>
          <div style={{ fontSize: 12, color: 'var(--warning)', display: 'flex', gap: 6, alignItems: 'center' }}>
            <AlertTriangle size={14} style={{ flexShrink: 0 }} />
            This can't be undone.
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-sm btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn-sm btn-danger" onClick={onConfirm}>Restore original</button>
          </div>
        </div>
      </div>
    </div>
  );
};
