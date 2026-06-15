import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { suggestCompletion } from '../utils/wordStore';

/**
 * Tag entry popup with inline ghost-text autocomplete. As the user types, the
 * current word is completed in grey from the frequently-used word store; Tab
 * accepts the suggestion. Enter applies the tag; preset chips give one-click
 * picks. Opens at (x, y) from a right-click.
 */
interface TagPopupProps {
  x: number;
  y: number;
  targetCount: number;
  currentTag?: string;
  presets: string[];
  onCommit: (tag: string) => void;
  onClear: () => void;
  onClose: () => void;
}

export const TagPopup: React.FC<TagPopupProps> = ({
  x, y, targetCount, currentTag, presets, onCommit, onClear, onClose,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(currentTag ?? '');
  const [pos, setPos] = useState({ left: x, top: y });

  // Current word = text after the last space; that's what we complete.
  const lastSpace = value.lastIndexOf(' ');
  const currentWord = value.slice(lastSpace + 1);
  const suggestion = currentWord ? suggestCompletion(currentWord) : null;
  const remainder = suggestion && suggestion.toLowerCase().startsWith(currentWord.toLowerCase())
    ? suggestion.slice(currentWord.length)
    : '';

  useEffect(() => {
    setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 20);
  }, []);

  // Keep the popup on-screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x, top = y;
    if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
    if (top + r.height > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const acceptSuggestion = () => {
    if (!remainder || !suggestion) return false;
    setValue(value.slice(0, value.length - currentWord.length) + suggestion);
    return true;
  };

  const commit = () => {
    const tag = value.trim();
    if (tag) onCommit(tag);
    else onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab') {
      // Tab accepts the ghost suggestion; only falls through if there's none.
      if (remainder) { e.preventDefault(); acceptSuggestion(); }
    } else if (e.key === 'ArrowRight') {
      const el = inputRef.current;
      if (remainder && el && el.selectionStart === value.length) { e.preventDefault(); acceptSuggestion(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div ref={ref} className="tag-pop" style={{ left: pos.left, top: pos.top }}>
      <div className="tag-pop-title">Tag {targetCount} page{targetCount === 1 ? '' : 's'}</div>

      <div className="tag-input-wrap">
        <div className="tag-input-ghost" aria-hidden="true">
          <span className="typed">{value}</span><span className="ghost">{remainder}</span>
        </div>
        <input
          ref={inputRef}
          className="tag-input"
          value={value}
          spellCheck={false}
          placeholder="Type a tag…"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="tag-pop-hint">
        {remainder ? <><b>Tab</b> to complete · </> : null}<b>Enter</b> to apply
      </div>

      {presets.length > 0 && (
        <div className="tag-pop-chips">
          {presets.map(p => (
            <button key={p} className="tag-pop-chip tag-label-text" onClick={() => onCommit(p)} title={p}>
              {p}
            </button>
          ))}
        </div>
      )}

      {currentTag && (
        <button className="tag-pop-remove" onClick={onClear}>Remove tag</button>
      )}
    </div>
  );
};
