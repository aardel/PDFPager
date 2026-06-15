import React from 'react';
import { Columns2, LayoutGrid, LayoutList, List, Maximize2 } from 'lucide-react';
import type { WorkspaceChrome } from './workspaceChrome';

interface WorkspaceViewBarProps {
  chrome: WorkspaceChrome;
}

export const WorkspaceViewBar: React.FC<WorkspaceViewBarProps> = ({ chrome }) => {
  const {
    mainView,
    sidebarView,
    inGridMode,
    canSplit,
    zoomIdx,
    zoomMax,
    zoomLabel,
    setMainView,
    setSidebarView,
    setZoomIdx,
  } = chrome;

  return (
    <div className="workspace-view-bar">
      {!inGridMode && (
        <div className="view-mode-group" role="group" aria-label="Sidebar layout">
          <button
            type="button"
            className={`view-mode-btn${sidebarView === 'pages' ? ' view-mode-btn-active' : ''}`}
            disabled={sidebarView === 'pages'}
            title="Page order in sidebar"
            onClick={() => setSidebarView('pages')}
          >
            <List size={13} /> Pages
          </button>
          <button
            type="button"
            className={`view-mode-btn${sidebarView === 'groups' ? ' view-mode-btn-active' : ''}`}
            disabled={sidebarView === 'groups'}
            title="Grouped by tag in sidebar"
            onClick={() => setSidebarView('groups')}
          >
            <LayoutList size={13} /> Groups
          </button>
        </div>
      )}

      <div className="view-mode-group" role="group" aria-label="Main view">
        <button
          type="button"
          className={`view-mode-btn${mainView === 'grid' ? ' view-mode-btn-active' : ''}`}
          disabled={mainView === 'grid'}
          title="Multipage grid — select and tag"
          onClick={() => setMainView('grid')}
        >
          <LayoutGrid size={13} /> Grid
        </button>
        <button
          type="button"
          className={`view-mode-btn${mainView === 'page' ? ' view-mode-btn-active' : ''}`}
          disabled={mainView === 'page'}
          title="Single page view"
          onClick={() => setMainView('page')}
        >
          <Maximize2 size={13} /> Page
        </button>
        <button
          type="button"
          className={`view-mode-btn${mainView === 'split' ? ' view-mode-btn-active' : ''}`}
          disabled={mainView === 'split' || !canSplit}
          title={canSplit ? 'Compare two pages side by side' : 'Exit grid view to use split'}
          onClick={() => setMainView('split')}
        >
          <Columns2 size={13} /> Split
        </button>
      </div>

      <div className="header-zoom" title="Thumb / page zoom (Ctrl + mouse wheel)">
        <span className="header-zoom-label">{zoomLabel}</span>
        <input
          type="range"
          className="header-zoom-slider"
          min={0}
          max={zoomMax}
          step={1}
          value={zoomIdx}
          onChange={(e) => setZoomIdx(Number(e.target.value))}
          aria-label="Zoom"
        />
      </div>
    </div>
  );
};
