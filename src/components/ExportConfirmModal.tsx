import React, { useMemo, useState } from 'react';
import { AlertTriangle, FileText, Save, X } from 'lucide-react';
import { ManifestEntry, suffixFileName } from '../utils/exportPlan';

export interface ResolvedFile {
  /** Index into the original manifest / processedFiles array. */
  index: number;
  /** Final relative path to write. */
  fileName: string;
}

type Action = 'save' | 'rename' | 'skip';

interface ExportConfirmModalProps {
  entries: ManifestEntry[];
  /** Original filenames (case-insensitive) that already exist in the target. */
  existing: Set<string>;
  /** Lowercased filename -> entry indices that share it (internal collisions). */
  collisions: Map<string, number[]>;
  /** Folder / destination label for the header, if known. */
  destinationLabel?: string;
  /** False when overwrites can't be detected (downloads / desktop) — show a note. */
  canDetectExisting: boolean;
  onConfirm: (resolved: ResolvedFile[], dontAskAgain: boolean) => void;
  onClose: () => void;
}

/**
 * Pre-write confirmation: shows every file that will be saved, flags name
 * collisions and existing-file overwrites, and lets the user resolve each one
 * (Overwrite / Rename / Skip) before anything touches disk.
 */
export const ExportConfirmModal: React.FC<ExportConfirmModalProps> = ({
  entries,
  existing,
  collisions,
  destinationLabel,
  canDetectExisting,
  onConfirm,
  onClose,
}) => {
  const collisionIdx = useMemo(() => {
    const s = new Set<number>();
    for (const idxs of collisions.values()) for (const i of idxs) s.add(i);
    return s;
  }, [collisions]);

  // Default decision per entry: keep the first of a collision group, auto-rename
  // the rest; overwrite existing files; save new ones.
  const [actions, setActions] = useState<Action[]>(() =>
    entries.map((e, i) => {
      if (collisionIdx.has(i)) {
        const group = collisions.get(e.fileName.toLowerCase())!;
        return group[0] === i ? 'save' : 'rename';
      }
      return 'save';
    })
  );
  const [dontAsk, setDontAsk] = useState(false);

  // Resolve final names in order: a renamed file gets the smallest " (n)" suffix
  // that clashes with neither an already-chosen name nor an existing file.
  const { resolved, finalNames, duplicate } = useMemo(() => {
    const used = new Set<string>();
    const existingLc = new Set([...existing].map(s => s.toLowerCase()));
    const out: ResolvedFile[] = [];
    const names: (string | null)[] = entries.map(() => null);
    let dup = false;
    entries.forEach((e, i) => {
      if (actions[i] === 'skip') return;
      let name = e.fileName;
      if (actions[i] === 'rename') {
        let n = 2;
        while (used.has(name.toLowerCase()) || existingLc.has(name.toLowerCase()) || name === e.fileName) {
          name = suffixFileName(e.fileName, n++);
        }
      }
      if (used.has(name.toLowerCase())) dup = true; // two 'save's onto one name
      used.add(name.toLowerCase());
      names[i] = name;
      out.push({ index: i, fileName: name });
    });
    return { resolved: out, finalNames: names, duplicate: dup };
  }, [entries, actions, existing]);

  const setAction = (i: number, a: Action) =>
    setActions(prev => prev.map((v, j) => (j === i ? a : v)));

  const statusOf = (i: number): { label: string; tone: string } => {
    if (collisionIdx.has(i)) return { label: 'Name conflict', tone: 'var(--warning)' };
    if (existing.has(entries[i].fileName)) return { label: 'Overwrites existing', tone: 'var(--warning)' };
    return { label: 'New', tone: 'var(--text-tertiary)' };
  };

  const optionsFor = (i: number): { value: Action; label: string }[] => {
    const isCollision = collisionIdx.has(i);
    const exists = existing.has(entries[i].fileName);
    const first: { value: Action; label: string } = isCollision
      ? { value: 'save', label: 'Keep name' }
      : exists
      ? { value: 'save', label: 'Overwrite' }
      : { value: 'save', label: 'Save' };
    return [first, { value: 'rename', label: 'Rename' }, { value: 'skip', label: 'Skip' }];
  };

  const savedCount = resolved.length;

  const S: Record<string, React.CSSProperties> = {
    overlay: {
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    },
    modal: {
      background: 'var(--bg-card)', borderRadius: 14,
      width: 'min(620px, 94vw)', maxHeight: '88vh', overflow: 'hidden',
      boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column',
    },
    header: {
      display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px',
      borderBottom: '1px solid var(--separator)',
    },
    body: { padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 },
    row: {
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
      border: '1px solid var(--separator)', borderRadius: 10, background: 'var(--bg-secondary)',
    },
    footer: {
      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
      borderTop: '1px solid var(--separator)',
    },
  };

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={S.header}>
          <Save size={16} style={{ color: 'var(--accent)' }} />
          <b style={{ fontSize: 14, flex: 1 }}>
            Confirm save{destinationLabel ? ` → ${destinationLabel}` : ''}
          </b>
          <button className="btn-icon" onClick={onClose} title="Close"><X size={15} /></button>
        </div>

        <div style={S.body}>
          {!canDetectExisting && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', gap: 6, alignItems: 'center' }}>
              <AlertTriangle size={13} style={{ color: 'var(--warning)' }} />
              Existing files in the destination can't be checked here — names shown will be used as-is.
            </div>
          )}
          {entries.map((e, i) => {
            const st = statusOf(i);
            const decidable = collisionIdx.has(i) || existing.has(e.fileName);
            const skipped = actions[i] === 'skip';
            return (
              <div key={i} style={{ ...S.row, opacity: skipped ? 0.5 : 1 }}>
                <FileText size={15} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {e.section}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {skipped ? <s>{e.fileName}</s> : finalNames[i]}
                    {' · '}{e.pageCount} page{e.pageCount === 1 ? '' : 's'}
                  </div>
                </div>
                <span style={{ fontSize: 11, color: st.tone, flexShrink: 0, fontWeight: 600 }}>{st.label}</span>
                {decidable && (
                  <select
                    value={actions[i]}
                    onChange={ev => setAction(i, ev.target.value as Action)}
                    style={{ fontSize: 12, padding: '3px 6px', borderRadius: 7, flexShrink: 0 }}
                  >
                    {optionsFor(i).map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                )}
              </div>
            );
          })}
        </div>

        <div style={S.footer}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
            <input type="checkbox" checked={dontAsk} onChange={e => setDontAsk(e.target.checked)} />
            Don't ask again this session
          </label>
          <button className="btn btn-sm btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-sm btn-primary"
            disabled={savedCount === 0 || duplicate}
            title={duplicate ? 'Two files would share a name — rename or skip one.' : undefined}
            onClick={() => onConfirm(resolved, dontAsk)}
          >
            Save {savedCount} file{savedCount === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
};
