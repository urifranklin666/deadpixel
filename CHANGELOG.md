# Changelog

## 1.8.0

### Added

- Layer groups: nest, reorder, toggle, move whole subtrees, group blend/opacity/lock.
- Layer masks: reveal-all / hide-all / from selection, brush and eraser mask painting, apply, delete, disable.
- Clipping masks with Photoshop-style clip chains.
- Layer panel rebuilt as a Photoshop-style tree with drag-drop reparenting, mask thumbnails, and a layer-mask popover.
- Arrow-key nudging and free transform for whole groups.
- .dpx project format v3 storing layer trees, layer masks, and clip state.

### Changed

- Neutral Photoshop-style dark UI replaces CRT chrome; menus follow Photoshop naming with a Layer Mask submenu.
- Panels reorganized into stacked tab groups (Color/Brush/Signal Rack above Layers/History).

### Compatibility

- Documents that use no tree features still serialize as v2 bytes, so existing DEADPIXEL versions open new files.
- Format-version-1 and v2 projects keep opening; masks and clipping only appear in v3 files.

## 1.5.0

### Added

- Memory-budgeted undo history.
- Worker-backed filters, Signal Rack processing, PNG encoding, and DPX compression.
- Incremental autosave with three rotating recovery generations and visible status.
- Document-level and active-layer Signal Racks.
- Per-module mix, luminance/alpha masks, mask inversion, and A/B snapshots.
- Reduced-resolution previews for large documents and cancellation of superseded jobs.
- DPX metadata validation and compatibility coverage.
- Unit and Playwright browser test suites, including offline startup.

### Changed

- Desktop shell navigation, local file serving, external URL handling, and response headers are hardened.
- Desktop, PWA cache, boot screen, and About version are aligned at 1.5.

### Compatibility

- Existing format-version-1 projects remain supported.
- New layer-rack metadata is optional and ignored by older project contents when absent.
- No project format version bump was required.
