# PDFPager

Desktop app for digitising paper archives: clean up scanned PDFs, tag pages, set export filenames, and split into one PDF per tag.

## Stack

- Electron + React + TypeScript + Vite
- pdfjs-dist (preview), pdf-lib (export)

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run package
```

Portable Windows executable output: `dist-electron/`.

## Docs

See [HANDOVER.md](./HANDOVER.md) for architecture, data model, and workflow details.
