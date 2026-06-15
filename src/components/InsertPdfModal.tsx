import React, { useState } from 'react';
import { FilePlus, X, Loader2 } from 'lucide-react';

interface InsertPdfModalProps {
  /** Ordered unique tags currently present in the document (section list). */
  tags: string[];
  fileName: string;
  pageCount: number;
  onInsert: (tag: string | null) => Promise<void>;
  onClose: () => void;
}

/**
 * Tag picker for inserting an external PDF at the top of a section — same
 * placement rules as the phone-scan cover flow, without camera/QR steps.
 */
export const InsertPdfModal: React.FC<InsertPdfModalProps> = ({
  tags,
  fileName,
  pageCount,
  onInsert,
  onClose,
}) => {
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleInsert = async () => {
    setBusy(true);
    setError('');
    try {
      await onInsert(target);
      onClose();
    } catch (e: any) {
      setError(e.message || 'Failed to insert the PDF.');
      setBusy(false);
    }
  };

  const S: Record<string, React.CSSProperties> = {
    overlay: {
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    },
    modal: {
      background: 'var(--bg-card)', borderRadius: 14,
      width: 'min(440px, 92vw)', maxHeight: '90vh', overflowY: 'auto',
      boxShadow: '0 20px 60px rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column',
    },
    header: {
      display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px',
      borderBottom: '1px solid var(--separator)',
    },
    body: { padding: 20, display: 'flex', flexDirection: 'column', gap: 10 },
    radioRow: {
      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
      border: '1px solid var(--separator)', borderRadius: 8, cursor: 'pointer', fontSize: 13,
      width: '100%',
    },
  };

  const pageLabel = pageCount === 1 ? '1 page' : `${pageCount} pages`;

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={S.header}>
          <FilePlus size={16} style={{ color: 'var(--accent)' }} />
          <b style={{ fontSize: 14, flex: 1 }}>Insert PDF</b>
          <button className="btn-icon" onClick={onClose} title="Close" disabled={busy}>
            <X size={15} />
          </button>
        </div>

        <div style={S.body}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center' }}>
            <span style={{ fontWeight: 600, color: 'var(--text-primary, inherit)' }}>{fileName}</span>
            <br />
            {pageLabel} will be added at the top of the chosen section.
          </div>

          <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>Insert at the top of:</div>
          <label style={{ ...S.radioRow, borderColor: target === null ? 'var(--accent)' : 'var(--separator)' }}>
            <input type="radio" name="insert-target" checked={target === null} onChange={() => setTarget(null)} disabled={busy} />
            Document (untagged)
          </label>
          {tags.map(t => (
            <label key={t} style={{ ...S.radioRow, borderColor: target === t ? 'var(--accent)' : 'var(--separator)' }}>
              <input type="radio" name="insert-target" checked={target === t} onChange={() => setTarget(t)} disabled={busy} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t}</span>
            </label>
          ))}

          {error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="btn btn-sm btn-secondary" style={{ flex: 1 }} onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-sm btn-primary" style={{ flex: 2 }} onClick={handleInsert} disabled={busy}>
              {busy ? <><Loader2 size={13} className="spin" /> Inserting…</> : 'Insert PDF'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
