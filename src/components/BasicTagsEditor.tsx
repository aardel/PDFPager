import React, { useState } from 'react';
import { X, Plus, Copy } from 'lucide-react';

interface BasicTagsEditorProps {
  presets: string[];
  onSetPresets: (presets: string[]) => void;
  onRename?: (oldName: string, newName: string) => void;
}

export const BasicTagsEditor: React.FC<BasicTagsEditorProps> = ({ presets, onSetPresets, onRename }) => {
  const [newTag, setNewTag] = useState('');
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');

  const trimTag = (s: string) => s.trim();
  const isDuplicate = (name: string, skipIdx?: number) =>
    presets.some((p, i) => i !== skipIdx && p.toLowerCase() === name.toLowerCase());

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = trimTag(newTag);
    if (!clean || isDuplicate(clean)) return;
    onSetPresets([...presets, clean]);
    setNewTag('');
  };

  const handleRemove = (idx: number) => {
    onSetPresets(presets.filter((_, i) => i !== idx));
    if (editingIdx === idx) setEditingIdx(null);
  };

  const handleDuplicate = (idx: number) => {
    const base = presets[idx];
    let candidate = `${base}_copy`;
    let n = 2;
    while (presets.some(p => p.toLowerCase() === candidate.toLowerCase())) {
      candidate = `${base}_copy${n++}`;
    }
    const next = [...presets];
    next.splice(idx + 1, 0, candidate);
    onSetPresets(next);
  };

  const moveUp = (idx: number) => {
    if (idx === 0) return;
    const next = [...presets];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    onSetPresets(next);
    if (editingIdx === idx) setEditingIdx(idx - 1);
    else if (editingIdx === idx - 1) setEditingIdx(idx);
  };

  const moveDown = (idx: number) => {
    if (idx === presets.length - 1) return;
    const next = [...presets];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    onSetPresets(next);
    if (editingIdx === idx) setEditingIdx(idx + 1);
    else if (editingIdx === idx + 1) setEditingIdx(idx);
  };

  const startRename = (idx: number) => {
    setEditingIdx(idx);
    setEditValue(presets[idx]);
  };

  const commitRename = (idx: number) => {
    const clean = trimTag(editValue);
    if (!clean) {
      setEditingIdx(null);
      return;
    }
    if (isDuplicate(clean, idx)) {
      setEditingIdx(null);
      return;
    }
    const oldName = presets[idx];
    const next = [...presets];
    next[idx] = clean;
    onSetPresets(next);
    setEditingIdx(null);
    if (oldName.toLowerCase() !== clean.toLowerCase()) onRename?.(oldName, clean);
  };

  return (
    <div className="basic-tags-editor">
      <p className="basic-tags-hint">
        Plain tag names for grouping pages. Assign via right-click on a page.
        Keys <kbd>1</kbd>–<kbd>9</kbd> match list order.
      </p>

      <div className="basic-tags-list">
        {presets.length === 0 && (
          <p className="basic-tags-empty">No tags yet. Add one below.</p>
        )}
        {presets.map((preset, idx) => (
          <div key={`${preset}-${idx}`} className="basic-tags-row">
            <div className="basic-tags-grip">
              <button type="button" className="btn-icon btn-xs" onClick={() => moveUp(idx)} disabled={idx === 0} title="Move up">▲</button>
              <button type="button" className="btn-icon btn-xs" onClick={() => moveDown(idx)} disabled={idx === presets.length - 1} title="Move down">▼</button>
            </div>
            <span className="basic-tags-key">{idx < 9 ? idx + 1 : '·'}</span>
            {editingIdx === idx ? (
              <input
                type="text"
                className="basic-tags-rename-input"
                value={editValue}
                autoFocus
                onChange={e => setEditValue(e.target.value)}
                onBlur={() => commitRename(idx)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename(idx);
                  if (e.key === 'Escape') setEditingIdx(null);
                }}
              />
            ) : (
              <button
                type="button"
                className="basic-tags-name tag-label-text"
                onDoubleClick={() => startRename(idx)}
                title="Double-click to rename"
              >
                {preset}
              </button>
            )}
            <button type="button" className="btn-icon btn-xs" onClick={() => handleDuplicate(idx)} title="Duplicate">
              <Copy size={11} />
            </button>
            <button type="button" className="btn-icon btn-xs tag-remove-btn" onClick={() => handleRemove(idx)} title="Remove">
              <X size={11} />
            </button>
          </div>
        ))}
      </div>

      <form className="basic-tags-add" onSubmit={handleAdd}>
        <input
          type="text"
          value={newTag}
          onChange={e => setNewTag(e.target.value)}
          placeholder="New tag name…"
          style={{ flex: 1, fontSize: 12 }}
        />
        <button type="submit" className="btn btn-primary btn-sm">
          <Plus size={12} /> Add
        </button>
      </form>
    </div>
  );
};
