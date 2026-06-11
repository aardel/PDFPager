import React, { useEffect, useRef, useState } from 'react';
import { Tag } from 'lucide-react';

interface PageContextMenuProps {
  x: number;
  y: number;
  presets: string[];
  hasTag: boolean;
  currentTag?: string;
  onSelectTag: (tag: string) => void;
  onNewTag: (name: string) => void;
  onClearTag: () => void;
  onClose: () => void;
}

export const PageContextMenu: React.FC<PageContextMenuProps> = ({
  x,
  y,
  presets,
  hasTag,
  currentTag,
  onSelectTag,
  onNewTag,
  onClearTag,
  onClose,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [showNewTag, setShowNewTag] = useState(false);
  const [newTagValue, setNewTagValue] = useState('');

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
  }, [x, y, showNewTag]);

  useEffect(() => {
    if (showNewTag) setTimeout(() => inputRef.current?.focus(), 30);
  }, [showNewTag]);

  const submitNewTag = (e?: React.FormEvent) => {
    e?.preventDefault();
    const clean = newTagValue.trim();
    if (!clean) return;
    onNewTag(clean);
    onClose();
  };

  return (
    <div ref={ref} className="page-context-menu fade-in" style={{ left: x, top: y }}>
      <div className="page-context-menu-title">
        <Tag size={12} /> Assign tag
      </div>

      {showNewTag ? (
        <form className="page-context-new-tag" onSubmit={submitNewTag}>
          <input
            ref={inputRef}
            type="text"
            value={newTagValue}
            onChange={e => setNewTagValue(e.target.value)}
            placeholder="Tag name…"
            onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
          />
          <div className="page-context-new-tag-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!newTagValue.trim()}>Add & assign</button>
          </div>
        </form>
      ) : (
        <>
          {presets.length === 0 ? (
            <div className="page-context-menu-empty">No saved tags yet — create one below.</div>
          ) : (
            presets.map((preset, idx) => (
              <button
                key={preset}
                type="button"
                className={`page-context-menu-item${currentTag?.toLowerCase() === preset.toLowerCase() ? ' active' : ''}`}
                onClick={() => { onSelectTag(preset); onClose(); }}
              >
                <span className="tag-label-text">{preset}</span>
                {idx < 9 && <span className="page-context-menu-kbd">{idx + 1}</span>}
              </button>
            ))
          )}
          <div className="page-context-menu-sep" />
          <button type="button" className="page-context-menu-item" onClick={() => setShowNewTag(true)}>
            New tag…
          </button>
          {hasTag && (
            <button type="button" className="page-context-menu-item danger" onClick={() => { onClearTag(); onClose(); }}>
              Clear tag
            </button>
          )}
        </>
      )}
    </div>
  );
};
