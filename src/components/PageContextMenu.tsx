import React, { useEffect, useRef } from 'react';
import {
  Crop,
  RotateCcw,
  RotateCw,
  Scan,
  Tag,
  Trash2,
  Type,
} from 'lucide-react';

export interface WordEntry {
  w: string;
  n: number;
}

export interface PageContextMenuProps {
  x: number;
  y: number;
  targetCount: number;
  words: WordEntry[];
  usedInFile: string[];
  currentTag?: string;
  isDeleted: boolean;
  isBlank: boolean;
  canCrop: boolean;
  canReadjustCover: boolean;
  onSelectTag: (tag: string) => void;
  onWordSelect: (word: string) => void;
  onOpenTagEditor: () => void;
  onClearTag: () => void;
  onRotate: (degrees: number) => void;
  onCrop: () => void;
  onReadjustCover: () => void;
  onToggleBlank: () => void;
  onToggleDelete: () => void;
  onClose: () => void;
}

export const PageContextMenu: React.FC<PageContextMenuProps> = ({
  x,
  y,
  targetCount,
  words,
  usedInFile,
  currentTag,
  isDeleted,
  isBlank,
  canCrop,
  canReadjustCover,
  onSelectTag,
  onWordSelect,
  onOpenTagEditor,
  onClearTag,
  onRotate,
  onCrop,
  onReadjustCover,
  onToggleBlank,
  onToggleDelete,
  onClose,
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
    if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8;
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;
  }, [x, y, words.length, usedInFile.length, isDeleted]);

  const pageLabel = targetCount === 1 ? '1 page' : `${targetCount} pages`;

  if (isDeleted) {
    return (
      <div ref={ref} className="page-context-menu fade-in" style={{ left: x, top: y }}>
        <div className="page-context-menu-title">Deleted · {pageLabel}</div>
        <button type="button" className="page-context-menu-item" onClick={() => { onToggleDelete(); onClose(); }}>
          <span>Restore page{targetCount === 1 ? '' : 's'}</span>
        </button>
      </div>
    );
  }

  return (
    <div ref={ref} className="page-context-menu fade-in" style={{ left: x, top: y }}>
      <div className="page-context-menu-title">{pageLabel}</div>

      <button type="button" className="page-context-menu-item" onClick={() => { onOpenTagEditor(); onClose(); }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Type size={13} /> Type tag…
        </span>
      </button>

      <div className="page-context-menu-sep" />

      <div className="page-context-menu-title sub">
        <Tag size={12} /> Assign tag
      </div>

      {words.length > 0 && (
        <div className="page-context-menu-tags">
          <div className="tag-pop-section-label">Words</div>
          <div className="tag-pop-chips">
            {words.map(({ w, n }) => (
              <button
                key={w.toLowerCase()}
                type="button"
                className="tag-pop-chip tag-label-text"
                title={n > 1 ? `Used ${n} times` : w}
                onClick={() => { onWordSelect(w); onClose(); }}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
      )}

      {usedInFile.length > 0 && (
        <div className="page-context-menu-tags">
          <div className="tag-pop-section-label">Used in this file</div>
          <ul className="tag-pop-used-list">
            {usedInFile.map(tag => (
              <li key={tag}>
                <button
                  type="button"
                  className={`tag-pop-used-item tag-label-text${currentTag?.toLowerCase() === tag.toLowerCase() ? ' active' : ''}`}
                  onClick={() => { onSelectTag(tag); onClose(); }}
                  title={tag}
                >
                  {tag}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {words.length === 0 && usedInFile.length === 0 && (
        <div className="page-context-menu-empty">No words or sections yet — type a tag above.</div>
      )}

      {currentTag && (
        <button type="button" className="page-context-menu-item danger" onClick={() => { onClearTag(); onClose(); }}>
          Clear tag
        </button>
      )}

      <div className="page-context-menu-sep" />

      <button type="button" className="page-context-menu-item" onClick={() => { onRotate(-90); onClose(); }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <RotateCcw size={13} /> Rotate left
        </span>
      </button>
      <button type="button" className="page-context-menu-item" onClick={() => { onRotate(90); onClose(); }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <RotateCw size={13} /> Rotate right
        </span>
      </button>
      <button
        type="button"
        className="page-context-menu-item"
        disabled={!canCrop}
        onClick={() => { if (canCrop) { onCrop(); onClose(); } }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Crop size={13} /> Crop page
        </span>
      </button>
      {canReadjustCover && (
        <button type="button" className="page-context-menu-item" onClick={() => { onReadjustCover(); onClose(); }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Scan size={13} /> Re-adjust cover
          </span>
        </button>
      )}
      <button type="button" className="page-context-menu-item" onClick={() => { onToggleBlank(); onClose(); }}>
        <span>{isBlank ? 'Unmark as blank' : 'Mark as blank'}</span>
      </button>

      <div className="page-context-menu-sep" />

      <button type="button" className="page-context-menu-item danger" onClick={() => { onToggleDelete(); onClose(); }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Trash2 size={13} /> Delete page{targetCount === 1 ? '' : 's'}
        </span>
      </button>
    </div>
  );
};
