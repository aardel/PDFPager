# PDFPager — Handover Document

## What This App Does

PDFPager is a desktop tool for digitising physical paper archives. The typical workflow:

1. Scan a physical paper file on a flatbed scanner — produces one large multi-page PDF
2. Optionally prepend a cover page photographed with a phone
3. Open the combined PDF in PDFPager
4. Review pages: delete blanks, rotate mis-scans, reorder by dragging
5. Tag each page (or group of pages) with a document label (e.g. `APPLICATION_211013`)
6. Export — produces one PDF file per unique tag, saved to a chosen output folder

The app runs two ways:

1. **Windows desktop** — Electron application (original form)
2. **Web app** — the same React UI deployed as a static site at
   `https://pdf.myalbum.world` (alternates: `pdf.aarondelia.com`,
   `www.aarondelia.com`), served by the shared edge-nginx on the
   servicelc server. In Chrome/Edge, export writes split PDFs straight
   into a user-chosen folder via the File System Access API
   (`src/utils/fileSystem.ts`); Safari/Firefox fall back to per-file
   downloads. No login.

The only backend is `server/` (`pdfpager-api` container) — a tiny
rendezvous service for mobile cover scanning (see "Scan API" below).
Everything else is client-side.

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Desktop shell | Electron | 31 |
| UI framework | React 18 + TypeScript | — |
| Build tool | Vite | 5 |
| PDF rendering (preview) | pdfjs-dist | 4.5 |
| PDF writing (export) | pdf-lib | 1.17 |
| Drag-and-drop | @dnd-kit/core, sortable, modifiers | 6/10/9 |
| Icons | lucide-react | 0.435 |
| Styles | Plain CSS (no framework) | — |

**To run in development:**
```
npm install
npm run dev
```

**To build a portable Windows executable:**
```
npm run package
```
Output lands in `dist-electron/`.

---

## Repository Layout

```
PDFPager/
├── main.js              Electron main process (window creation, IPC, file save dialog)
├── preload.js           Electron preload — exposes window.electronAPI to the renderer
├── server/              pdfpager-api: scan rendezvous backend (Express, Dockerfile)
├── public/              Static assets copied verbatim into dist/ (scan.html lives here)
├── src/
│   ├── main.tsx         React entry point
│   ├── App.tsx          Root component — file loading, export orchestration, preset persistence
│   ├── index.css        All styles (macOS light design system)
│   ├── components/
│   │   ├── WelcomeScreen.tsx     Drop-zone shown before a file is loaded
│   │   ├── Workspace.tsx         Main UI — sidebar, preview, toolbar, tag overlay
│   │   ├── PageThumbnail.tsx     Individual draggable thumbnail card
│   │   ├── ScrollablePreview.tsx Scrollable multi-page preview (left + right panes)
│   │   ├── LargePagePreview.tsx  Single-page fit-to-window renderer (kept, unused in main flow)
│   │   └── TagOrganizer.tsx      Inline panel for creating / editing tag presets
│   └── utils/
│       ├── pdfProcessor.ts       PDF load, blank detection, export/split logic
│       ├── tagUtils.ts           Tag template parsing (***hint*** syntax)
│       ├── sessionStorage.ts     Per-file session persistence (tags/order/names)
│       └── fileSystem.ts         File System Access API (Chrome web export)
```

---

## Data Model

Everything flows through a single array of `ProcessedPage` objects held in `App.tsx` state and passed down as props:

```typescript
interface ProcessedPage {
  id: number;          // Stable identity (assigned once on file load, 1-based)
  pageIndex: number;   // 0-based index into the original PDF (unchanged even after reorder)
  isDeleted: boolean;  // Hidden from preview and excluded from export
  isBlank: boolean;    // Auto-detected — shown as "blank" badge on thumbnail
  tag?: string;        // Assigned label — determines output filename (e.g. "APPLICATION_211013")
  rotation: number;    // User-applied rotation in degrees: 0 / 90 / 180 / 270
}
```

Reordering pages (drag-and-drop) changes the **array order** of `ProcessedPage` objects — pages are exported in array order, not by `pageIndex`. The `pageIndex` always points back to the correct page in the source PDF regardless of reordering.

Presets (tag names) and the last-used output folder are persisted to `localStorage` and survive restarts.

---

## Tag System

### Plain Tags

A plain tag like `MINUTES` or `APPLICATION` is a literal string. All pages sharing the same tag are exported as one PDF named `minutes.pdf` or `application.pdf` (lowercased).

### Template Tags — `***hint***` syntax

A tag containing `***hint***` is a template. The `***hint***` portion is a variable placeholder — the hint text is shown as a guide in the input field. Everything outside `***..***` is fixed text.

**Examples:**

| Template | Example filled value | Resulting tag |
|----------|---------------------|---------------|
| `APPLICATION_***date***` | `211013` | `APPLICATION_211013` |
| `***ref***_MINUTES` | `000` | `000_MINUTES` |
| `***num***_CASE_REVIEW_***date***` | `013` / `181119` | `013_CASE_REVIEW_181119` |

Template tags appear in the floating tag overlay with each placeholder shown as a labelled input box. When all placeholders are filled and Assign is pressed, the resolved string becomes the page's tag.

The parsing logic lives in `src/utils/tagUtils.ts`. Key functions:

| Function | Purpose |
|----------|---------|
| `isTemplate(tag)` | Returns true if the string contains `***…***` |
| `parseTemplate(tag)` | Returns array of `{type:'fixed', text}` and `{type:'var', hint, key}` parts |
| `resolveTemplate(tag, vals)` | Replaces each `***…***` with the corresponding value from `vals` map |
| `tagMatchesTemplate(tag, preset)` | Tests whether a resolved tag was produced by a given template |
| `extractVarsFromTag(tag, preset)` | Reverse: extracts variable values from a resolved tag |
| `getTagColorIndex(tag, presets)` | Finds the preset index (for colour assignment) even for template-resolved tags |

---

## UI Architecture

### App.tsx
Top-level orchestrator. Owns:
- `pdfBuffer` — raw `ArrayBuffer` of the opened file (never mutated)
- `pages` — the `ProcessedPage[]` array
- `presets` — ordered list of tag names (plain and templates)
- `outputDirectory` — destination folder path
- Export state (`isExporting`, `exportProgress`)
- `queue` / `activeKey` — **multi-file queue**: several PDFs open as header
  chips; only the active file's bytes are in memory (queued files are just
  `File` handles). Switching saves/restores per-file sessions.
- **Undo/redo**: history stack (max 100) of `pages` snapshots. Ctrl+Z /
  Ctrl+Shift+Z / Ctrl+Y + toolbar buttons. User mutations go through
  `handleSetPages` (records history); blank auto-detection uses
  `handleSetPagesSilent` (no history). Restored snapshots re-merge current
  `isBlank` flags.

The `handleExport(targetTag?)` function calls `processAndSplitPDF` then either uses `window.electronAPI.savePDFs` (Electron) or triggers browser downloads (web fallback).

### Workspace.tsx
All editing UI. Key state:

| State | Purpose |
|-------|---------|
| `primaryIndex` | Which page is active/visible in the left pane |
| `splitIndex` | Right pane page index (`null` = single-pane mode) |
| `activePaneIsLeft` | Which pane receives thumbnail clicks |
| `leftZoomIdx` / `rightZoomIdx` | Independent zoom levels per pane (indexes into `ZOOM_STEPS`) |
| `selectedIds` | Set of page IDs for multi-select bulk tagging |
| `sidebarView` | `'pages'` (flat drag list) or `'groups'` (tag-grouped) |
| `collapsedGroups` | Set of group keys that are currently collapsed |
| `showTagOverlay` | Whether the floating tag panel is open |
| `overlayExpanded` | Which template preset is expanded for input inside the overlay |
| `showTagOrganizer` | Whether the Organise Tags panel is visible in the sidebar |

Zoom steps: `[1.0, 1.25, 1.5, 2.0, 2.5, 3.0]` — zoom is CSS-only (no canvas re-render), Ctrl+scroll also works.

Keyboard shortcuts:
- `↑ / ↓` — navigate pages
- `D` — delete/restore active page
- `1–9` — quick-assign preset tag by index
- `Ctrl +/-/0` — zoom in/out/reset (active pane)
- `Esc` — clear multi-selection

### ScrollablePreview.tsx
Renders all non-deleted pages stacked vertically in a scrollable container. Each `PageSlot`:
- Lazy-renders via `IntersectionObserver` (±800 px root margin — pages load before they scroll into view)
- Renders canvas at `2× fitScale` for sharpness, then applies zoom via CSS width/height only (no re-render on zoom change)
- `fitScale = min(availW / pageW, availH / pageH)` — each page fits entirely in the viewport at zoom = 1
- `renderKey` tracks `pageIndex + rotation + containerWidth + containerHeight` — re-renders when container resizes or page rotates, but **keeps old `fitSize` until new render lands** (prevents stretch flash during split↔single toggle)
- Scroll spy fires on `scroll` events — finds the most-visible page and calls `onActiveIndexChange`
- `scrollToRef` is an imperative handle; parent sets `isProgrammatic = true` to suppress scroll spy during programmatic navigation

### TagOrganizer.tsx
Inline sidebar panel. Lets the user:
- Reorder presets (▲/▼ buttons)
- Remove presets
- Add new presets (plain string or `***hint***` template)
- See a colour dot and "template" badge per preset
- View the syntax help box

### PageThumbnail.tsx
Draggable card (dnd-kit `useSortable`). Renders at scale 0.28. Auto-detects blank pages using `detectIfPageIsBlank` after first render. Shows: thumbnail canvas, page number, tag pill, blank badge, selection dot (top-left), delete/restore button (top-right).

---

## Export Logic (`pdfProcessor.ts → processAndSplitPDF`)

1. Load the source PDF with pdf-lib
2. Collect all non-deleted pages that have a tag (filter by `targetTag` if exporting a single group)
3. Walk the array in order, collecting unique tag strings
4. For each unique tag: create a new `PDFDocument`, copy the matching pages, apply any user rotations, serialize to `Uint8Array`
5. Return `{ fileName: '<tag>.pdf', data: Uint8Array }[]`

The caller (`App.tsx`) then writes the files via Electron IPC or triggers browser download links.

**Blank detection** (`detectIfPageIsBlank`): renders the page, crops the outer 5% margin (avoids scanner feed shadows), computes per-pixel brightness using the Luma formula, and flags the page blank if ≥ 99.2% of pixels exceed brightness 242/255.

---

## Electron IPC Surface

Defined in `main.js`, exposed via `preload.js` as `window.electronAPI`:

| Method | Description |
|--------|-------------|
| `selectDirectory()` | Opens a native folder picker, returns absolute path string or `null` |
| `savePDFs(folderPath, files)` | Writes `{ fileName, data: Uint8Array }[]` to disk under `folderPath`, returns `{ success, savedFiles?, error? }` |

The renderer checks `window.electronAPI` before calling — if undefined (browser mode) it falls back to `<a download>` links.

---

## CSS Design System (`index.css`)

macOS light theme. Key variables:

| Variable | Value | Use |
|----------|-------|-----|
| `--bg-app` | `#F2F2F7` | Window background |
| `--bg-card` | `#FFFFFF` | Cards, panels |
| `--accent` | `#007AFF` | Buttons, active states, selection rings |
| `--danger` | `#FF3B30` | Delete, restore |
| `--tag-0…7` | Blue / Green / Orange / Red / Purple / Sky / Yellow / Coral | Tag colour palette (8 colours) |
| `--separator` | `#E5E5EA` | Borders between sections |

Tag colour is determined by the preset's **index in the presets array** — same index = same colour across the app. Template-resolved tags inherit the colour of their parent template.

---

## Scan API (mobile cover scanning)

Hard covers are photographed with a phone. The desktop shows a QR code /
short URL; the phone opens `/scan.html`, captures + flattens the cover,
and uploads it; the desktop polls and inserts the result.

Backend: `server/index.js` → `pdfpager-api` container (Express,
in-memory sessions, 15-min TTL, no DB). nginx proxies `/api/scan/` and
`/s/` on the PDFPager vhosts (variable upstream so nginx tolerates the
container being down).

| Endpoint | Who | Purpose |
|---|---|---|
| `POST /api/scan/session` | desktop | create session → token, 5-char code, short URL, QR data URL |
| `GET /s/:code` | phone | short URL → 302 to `/scan.html?token=…` |
| `POST /api/scan/session/:token/connected` | phone | presence ping ("phone connected" UI) |
| `POST /api/scan/upload/:token` | phone | multipart `image` (JPEG/PNG/WEBP, 10 MB cap) |
| `GET /api/scan/session/:token` | desktop | poll: `connected`, `hasImage` |
| `GET /api/scan/session/:token/image` | desktop | fetch uploaded image |
| `DELETE /api/scan/session/:token` | desktop | consume/close session |

Corner detection + perspective flatten run **on the phone** in
`public/scan.html` (vanilla JS, ported from the tripplanner travel app:
grayscale → Gaussian blur → Sobel edges → bounding quad → draggable
corners → inverse-bilinear flatten).

Cover insertion model (desktop): the flattened image is appended via
pdf-lib as a real page at the **end** of the active buffer (so no
existing `pageIndex` shifts), and its `ProcessedPage` entry is inserted
at the **top of the chosen tag section** in the array — array order is
export order, so the cover exports on top. v1: covers do not persist
across file close (re-scan after reopening is acceptable).

## Known Limitations / Future Work

- **Export filename casing**: tags are lowercased for filenames. A tag `APPLICATION_211013` exports as `application_211013.pdf`. Change `processAndSplitPDF` to preserve casing if needed.
- **Drag-and-drop only in Pages view**: the Groups sidebar view is read-only; reordering requires switching to Pages view.
- **No password-protected PDFs**: `pdfjs-dist` will fail on encrypted files; the app shows a generic error alert.
- **Scanned covers don't persist (v1)**: closing a file discards inserted covers; only tags/order survive in the session. v2 plan: store cover images in IndexedDB keyed by fileKey.
- **`LargePagePreview.tsx`** is no longer used in the main flow (replaced by `ScrollablePreview`) but is kept as it may be useful for a single-page mode.

Resolved (2026-06): ~~No undo~~ (history stack), ~~single file at a
time~~ (multi-file queue), ~~large-PDF RAM~~ (off-screen canvases are
released and re-rendered on approach).
