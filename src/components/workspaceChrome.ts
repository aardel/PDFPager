export type MainViewMode = 'grid' | 'page' | 'split';
export type SidebarViewMode = 'pages' | 'groups';

export interface WorkspaceChrome {
  mainView: MainViewMode;
  sidebarView: SidebarViewMode;
  inGridMode: boolean;
  canSplit: boolean;
  zoomIdx: number;
  zoomMax: number;
  zoomLabel: string;
  setMainView: (mode: MainViewMode) => void;
  setSidebarView: (mode: SidebarViewMode) => void;
  setZoomIdx: (idx: number) => void;
}
