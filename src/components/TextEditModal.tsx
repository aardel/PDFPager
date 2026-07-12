import React, { useEffect, useRef, useState } from 'react';
import { Type as TypeIcon, X } from 'lucide-react';
import { loadPdfDocument, TextEdit } from '../utils/pdfProcessor';
import { makeTextEditId } from '../utils/textEdit';

/**
 * "Cover and replace" text editor: click any text run rendered from the
 * page's real text layer to turn it into a normal text input — click to
 * place the caret, drag/shift-click to select, type over the selection,
 * backspace — all native browser text-field behavior, not a custom editor.
 * Committing a change doesn't touch the PDF yet; it just updates this
 * modal's local list. Saving hands the accumulated edits back to the
 * caller, which is what actually bakes them into the page (see
 * utils/textEdit.ts) at export time.
 *
 * Only text that already exists as real PDF text objects is clickable —
 * scanned/image-only pages have nothing here, since there's no text layer
 * to edit (see utils/textEdit.ts's module doc for why this is cover-and-
 * replace rather than a true content edit).
 */

interface TextEditModalProps {
  sourceBuffer: ArrayBuffer;
  pageIndex: number;
  rotation: number;
  existingEdits: TextEdit[];
  onSave: (edits: TextEdit[]) => void;
  onClose: () => void;
}

interface HitRegion {
  key: string;
  text: string;
  originalText: string;
  x: number; y: number; width: number; height: number; // PDF user-space
  fontSize: number;
  fontFamilyHint: string;
  screenLeft: number; screenTop: number; screenWidth: number; screenHeight: number;
  editId?: string;
}

export const TextEditModal: React.FC<TextEditModalProps> = ({
  sourceBuffer, pageIndex, rotation, existingEdits, onSave, onClose,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [regions, setRegions] = useState<HitRegion[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoading(true);
        setError('');
        const pdfDoc = await loadPdfDocument(sourceBuffer);
        if (!active) return;
        const page = await pdfDoc.getPage(pageIndex + 1);
        if (!active) return;

        const rot = (page.rotate + rotation) % 360;
        const native = page.getViewport({ scale: 1, rotation: rot });
        const containerW = Math.min(containerRef.current?.clientWidth || 800, 900);
        const scale = Math.max(containerW / native.width, 0.1);
        const viewport = page.getViewport({ scale, rotation: rot });

        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: ctx, viewport }).promise;
        if (!active) return;

        const textContent = await page.getTextContent();
        const newRegions: HitRegion[] = [];
        (textContent.items as any[]).forEach((item, idx) => {
          if (!item.str || !item.str.trim()) return; // skip whitespace-only runs — nothing to click
          const ux = item.transform[4];
          const uy = item.transform[5];
          const p1 = viewport.convertToViewportPoint(ux, uy);
          const p2 = viewport.convertToViewportPoint(ux + item.width, uy + item.height);
          const left = Math.min(p1[0], p2[0]);
          const top = Math.min(p1[1], p2[1]);
          const w = Math.max(Math.abs(p2[0] - p1[0]), 6);
          const h = Math.max(Math.abs(p2[1] - p1[1]), 6);
          const existing = existingEdits.find(
            e => e.originalText === item.str && Math.abs(e.x - ux) < 1 && Math.abs(e.y - uy) < 1,
          );
          const fontSize = Math.hypot(item.transform[2], item.transform[3]) || item.height || 10;
          newRegions.push({
            key: `t${idx}`,
            text: existing?.newText ?? item.str,
            originalText: item.str,
            x: ux, y: uy, width: item.width, height: item.height,
            fontSize,
            fontFamilyHint: textContent.styles?.[item.fontName]?.fontFamily || '',
            screenLeft: left, screenTop: top, screenWidth: w, screenHeight: h,
            editId: existing?.id,
          });
        });
        if (active) setRegions(newRegions);
      } catch (e: any) {
        if (active) setError(e?.message || 'Failed to load this page for editing.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceBuffer, pageIndex, rotation]);

  const commitRegion = (key: string, value: string) => {
    setRegions(prev => prev.map(r => (r.key === key ? { ...r, text: value } : r)));
    setEditingKey(null);
  };

  const handleSave = () => {
    const edits: TextEdit[] = regions
      .filter(r => r.text !== r.originalText)
      .map(r => ({
        id: r.editId || makeTextEditId(),
        originalText: r.originalText,
        newText: r.text,
        x: r.x, y: r.y, width: r.width, height: r.height,
        fontSize: r.fontSize,
        fontFamilyHint: r.fontFamilyHint,
      }));
    onSave(edits);
  };

  const editedCount = regions.filter(r => r.text !== r.originalText).length;

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        style={{ background: 'var(--bg-card)', borderRadius: 14, width: 'min(960px, 96vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--separator)' }}>
          <TypeIcon size={16} style={{ color: 'var(--accent)' }} />
          <b style={{ fontSize: 14, flex: 1 }}>Edit text</b>
          <button className="btn-icon" onClick={onClose} title="Close"><X size={15} /></button>
        </div>

        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, overflowY: 'auto' }}>
          {error ? (
            <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>
          ) : (
            <>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center', margin: 0 }}>
                Click any text to edit it — select and type, or backspace and retype, just like a text field.
                Scanned pages with no real text layer have nothing clickable here.
              </p>
              <div ref={containerRef} style={{ position: 'relative', width: '100%', display: 'flex', justifyContent: 'center', minHeight: loading ? 300 : undefined }}>
                {loading && <div className="spinner" style={{ marginTop: 100 }} />}
                <canvas ref={canvasRef} style={{ display: loading ? 'none' : 'block', maxWidth: '100%', boxShadow: '0 2px 12px rgba(0,0,0,0.12)' }} />
                {!loading && regions.map(r => (
                  editingKey === r.key ? (
                    <input
                      key={r.key}
                      autoFocus
                      defaultValue={r.text}
                      style={{
                        position: 'absolute',
                        left: r.screenLeft, top: r.screenTop - 2,
                        width: Math.max(r.screenWidth, 60), height: r.screenHeight + 4,
                        fontSize: Math.max(r.screenHeight * 0.85, 10),
                        fontFamily: r.fontFamilyHint || 'sans-serif',
                        border: '1px solid var(--accent)', outline: 'none',
                        background: '#fff', color: '#000', padding: '0 2px',
                        boxSizing: 'content-box', zIndex: 2,
                      }}
                      onFocus={e => e.target.select()}
                      onBlur={e => commitRegion(r.key, e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
                        if (e.key === 'Escape') { e.preventDefault(); setEditingKey(null); }
                      }}
                    />
                  ) : (
                    <div
                      key={r.key}
                      title={r.text !== r.originalText ? `"${r.originalText}" → "${r.text}"` : 'Click to edit'}
                      onClick={() => setEditingKey(r.key)}
                      style={{
                        position: 'absolute',
                        left: r.screenLeft, top: r.screenTop,
                        width: r.screenWidth, height: r.screenHeight,
                        cursor: 'text',
                        background: r.text !== r.originalText ? 'rgba(52,199,89,0.18)' : 'transparent',
                        border: r.text !== r.originalText ? '1px solid rgba(52,199,89,0.6)' : '1px solid transparent',
                      }}
                      onMouseEnter={e => {
                        if (r.text === r.originalText) (e.currentTarget as HTMLDivElement).style.background = 'rgba(0,122,255,0.12)';
                      }}
                      onMouseLeave={e => {
                        if (r.text === r.originalText) (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                      }}
                    />
                  )
                ))}
              </div>
            </>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderTop: '1px solid var(--separator)' }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1 }}>
            {editedCount > 0 ? `${editedCount} change${editedCount === 1 ? '' : 's'}` : 'No changes yet'}
          </span>
          <button className="btn-sm btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-sm btn-primary" onClick={handleSave} disabled={editedCount === 0 && existingEdits.length === 0}>
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
};
