# DEADPIXEL

DEADPIXEL is a local-first raster editor for the browser and Windows. It includes layers, selections, brushes, text, filters, multi-snapshot crash recovery, offline PWA support, native Save/Save As where supported, and a nondestructive Signal Rack with painted masks and worker-backed document or per-layer processing.

## Development

Serve `site/` from a local HTTP server, or run the Electron shell:

```sh
cd desktop
npm start
```

Run verification from the repository root:

```sh
npm install
npm test
npm run test:e2e
npm run bench
```

Build the Windows installer from `desktop/` with `npm run dist`.

## Project format

`.dpx` files are ZIP archives containing `doc.json`, PNG raster layers, and—when used—PNG Signal Rack masks. Format version 2 remains backward-compatible with version 1 projects produced by DEADPIXEL v1.0–v1.5. Unknown future format versions, malformed metadata, oversized canvases, and excessive layer counts are rejected before document construction.

All editing and recovery data stays on the local machine. DEADPIXEL has no account system, uploads, or telemetry.
