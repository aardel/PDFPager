import React, { useEffect, useRef, useState } from 'react';
import { Smartphone, X, Check, Loader2 } from 'lucide-react';

/**
 * Pairs this desktop session with a phone for cover scanning.
 *
 * Lifecycle: create a scan session (QR + short URL) → poll it → when the
 * phone uploads, show the image with an "insert where?" choice → insert →
 * keep polling so further covers can be scanned in the same session.
 * The session is destroyed on close.
 */

interface ScanCoverModalProps {
  /** Ordered unique tags currently present in the document (section list). */
  tags: string[];
  onInsert: (imageBytes: ArrayBuffer, mime: string, tag: string | null) => Promise<void>;
  onClose: () => void;
}

interface ScanSession {
  token: string;
  code: string;
  shortUrl: string;
  qrDataUrl: string;
}

type Phase = 'creating' | 'waiting' | 'imageReady' | 'inserting' | 'error';

export const ScanCoverModal: React.FC<ScanCoverModalProps> = ({ tags, onInsert, onClose }) => {
  const [phase, setPhase] = useState<Phase>('creating');
  const [session, setSession] = useState<ScanSession | null>(null);
  const [phoneConnected, setPhoneConnected] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null); // null = untagged
  const [insertedCount, setInsertedCount] = useState(0);

  const imageRef = useRef<{ bytes: ArrayBuffer; mime: string } | null>(null);
  // uploadedAt of the upload we already consumed — a newer timestamp means
  // the phone sent another scan.
  const consumedRef = useRef<number | null>(null);
  const phaseRef = useRef<Phase>('creating');
  phaseRef.current = phase;

  // Create the session once; destroy it on unmount.
  useEffect(() => {
    let cancelled = false;
    let token: string | null = null;
    (async () => {
      try {
        const r = await fetch('/api/scan/session', { method: 'POST' });
        const j = await r.json();
        if (!r.ok || !j.success) throw new Error(j.error || 'Could not create scan session');
        if (cancelled) return;
        token = j.token;
        setSession(j);
        setPhase('waiting');
      } catch (e: any) {
        if (!cancelled) {
          setErrorMsg(e.message || 'Could not reach the scan service.');
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
      if (token) fetch(`/api/scan/session/${token}`, { method: 'DELETE' }).catch(() => {});
    };
  }, []);

  // Poll while the modal is open (paused during insert-choice/inserting so a
  // second phone upload can't swap the image mid-decision).
  useEffect(() => {
    if (!session) return;
    const iv = setInterval(async () => {
      if (phaseRef.current === 'imageReady' || phaseRef.current === 'inserting') return;
      try {
        const r = await fetch(`/api/scan/session/${session.token}`);
        if (r.status === 404) {
          setErrorMsg('Scan session expired. Close and start a new one.');
          setPhase('error');
          return;
        }
        const j = await r.json();
        if (!j.success) return;
        setPhoneConnected(!!j.connected);
        if (j.hasImage && j.uploadedAt && j.uploadedAt !== consumedRef.current) {
          const ir = await fetch(`/api/scan/session/${session.token}/image`);
          if (!ir.ok) return;
          const mime = ir.headers.get('content-type') || 'image/jpeg';
          const bytes = await ir.arrayBuffer();
          consumedRef.current = j.uploadedAt;
          imageRef.current = { bytes, mime };
          setPreviewUrl(prev => {
            if (prev) URL.revokeObjectURL(prev);
            return URL.createObjectURL(new Blob([bytes], { type: mime }));
          });
          setPhase('imageReady');
        }
      } catch {
        /* transient network failure — next tick retries */
      }
    }, 2500);
    return () => clearInterval(iv);
  }, [session]);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const handleInsert = async () => {
    if (!imageRef.current) return;
    setPhase('inserting');
    try {
      await onInsert(imageRef.current.bytes, imageRef.current.mime, target);
      setInsertedCount(n => n + 1);
      imageRef.current = null;
      setPhase('waiting'); // ready for the next scan
    } catch (e: any) {
      setErrorMsg(e.message || 'Failed to insert the cover.');
      setPhase('error');
    }
  };

  const handleDiscard = () => {
    imageRef.current = null;
    setPhase('waiting');
  };

  const S: Record<string, React.CSSProperties> = {
    overlay: {
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    },
    modal: {
      background: 'var(--bg-card)', borderRadius: 14, width: 'min(440px, 92vw)',
      maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      display: 'flex', flexDirection: 'column',
    },
    header: {
      display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px',
      borderBottom: '1px solid var(--separator)',
    },
    body: { padding: 20, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 },
    code: {
      fontFamily: 'ui-monospace, monospace', fontSize: 15, background: 'var(--bg-hover)',
      border: '1px solid var(--separator)', borderRadius: 8, padding: '6px 12px',
    },
    status: { fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 },
    radioRow: {
      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
      border: '1px solid var(--separator)', borderRadius: 8, cursor: 'pointer', fontSize: 13,
      width: '100%',
    },
  };

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={S.header}>
          <Smartphone size={16} style={{ color: 'var(--accent)' }} />
          <b style={{ fontSize: 14, flex: 1 }}>Scan cover with phone</b>
          {insertedCount > 0 && (
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {insertedCount} inserted ✓
            </span>
          )}
          <button className="btn-icon" onClick={onClose} title="Close">
            <X size={15} />
          </button>
        </div>

        <div style={S.body}>
          {phase === 'creating' && (
            <div style={S.status}><Loader2 size={14} className="spin" /> Creating scan session…</div>
          )}

          {phase === 'error' && (
            <>
              <span style={{ fontSize: 28 }}>⚠️</span>
              <p style={{ fontSize: 13, color: 'var(--danger)', textAlign: 'center' }}>{errorMsg}</p>
              <button className="btn btn-sm btn-secondary" onClick={onClose}>Close</button>
            </>
          )}

          {phase === 'waiting' && session && (
            <>
              <img src={session.qrDataUrl} alt="Scan QR" width={210} height={210}
                   style={{ borderRadius: 10, border: '1px solid var(--separator)' }} />
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                or type this on the phone:
              </div>
              <div style={S.code}>{session.shortUrl.replace(/^https?:\/\//, '')}</div>
              <div style={S.status}>
                {phoneConnected
                  ? <><Check size={14} style={{ color: 'var(--tag-1, #34C759)' }} /> Phone connected — waiting for the scan…</>
                  : <><Loader2 size={14} className="spin" /> Waiting for the phone to open the link…</>}
              </div>
            </>
          )}

          {(phase === 'imageReady' || phase === 'inserting') && previewUrl && (
            <>
              <img src={previewUrl} alt="Scanned cover"
                   style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 8,
                            border: '1px solid var(--separator)', boxShadow: '0 2px 10px rgba(0,0,0,0.12)' }} />
              <div style={{ fontSize: 13, fontWeight: 600, alignSelf: 'flex-start' }}>Insert at the top of:</div>
              <label style={{ ...S.radioRow, borderColor: target === null ? 'var(--accent)' : 'var(--separator)' }}>
                <input type="radio" name="scan-target" checked={target === null} onChange={() => setTarget(null)} />
                Document (untagged)
              </label>
              {tags.map(t => (
                <label key={t} style={{ ...S.radioRow, borderColor: target === t ? 'var(--accent)' : 'var(--separator)' }}>
                  <input type="radio" name="scan-target" checked={target === t} onChange={() => setTarget(t)} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t}</span>
                </label>
              ))}
              <div style={{ display: 'flex', gap: 8, width: '100%', marginTop: 4 }}>
                <button className="btn btn-sm btn-secondary" style={{ flex: 1 }}
                        onClick={handleDiscard} disabled={phase === 'inserting'}>
                  Discard
                </button>
                <button className="btn btn-sm btn-primary" style={{ flex: 2 }}
                        onClick={handleInsert} disabled={phase === 'inserting'}>
                  {phase === 'inserting' ? 'Inserting…' : 'Insert cover'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
