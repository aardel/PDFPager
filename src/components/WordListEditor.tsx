import React, { useState } from 'react';
import { X, Plus } from 'lucide-react';
import { addWord, listWords, removeWord } from '../utils/wordStore';

/**
 * Manages the autocomplete word vocabulary used by the tag popup — single
 * words, not full section names.
 */
export const WordListEditor: React.FC = () => {
  const [newWord, setNewWord] = useState('');
  const [words, setWords] = useState(listWords);

  const refresh = () => setWords(listWords());

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newWord.trim().toUpperCase();
    if (!clean || /\s/.test(clean)) return;
    if (addWord(clean)) {
      setNewWord('');
      refresh();
    }
  };

  const handleRemove = (word: string) => {
    removeWord(word);
    refresh();
  };

  return (
    <div className="basic-tags-editor">
      <p className="basic-tags-hint">
        Words suggested when you tag a page (right-click → type, <kbd>Tab</kbd> to complete).
        Tags are built from words separated by spaces. New words are learned as you tag.
      </p>

      <div className="basic-tags-list">
        {words.length === 0 && (
          <p className="basic-tags-empty">No words yet — tag a page or add one below.</p>
        )}
        {words.map(({ w, n }) => (
          <div key={w.toLowerCase()} className="basic-tags-row">
            <span className="basic-tags-name tag-label-text" style={{ flex: 1, textAlign: 'left', cursor: 'default' }}>
              {w}
            </span>
            {n > 1 && (
              <span style={{ fontSize: 10, color: 'var(--text-tertiary)', minWidth: 20, textAlign: 'right' }}>
                ×{n}
              </span>
            )}
            <button type="button" className="btn-icon btn-xs tag-remove-btn" onClick={() => handleRemove(w)} title="Remove word">
              <X size={11} />
            </button>
          </div>
        ))}
      </div>

      <form className="basic-tags-add" onSubmit={handleAdd}>
        <input
          type="text"
          value={newWord}
          onChange={e => setNewWord(e.target.value.toUpperCase())}
          placeholder="Add word…"
          spellCheck={false}
          style={{ flex: 1, fontSize: 12, textTransform: 'uppercase' }}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!newWord.trim() || /\s/.test(newWord.trim())}>
          <Plus size={12} /> Add
        </button>
      </form>
    </div>
  );
};
