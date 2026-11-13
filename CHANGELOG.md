# Changelog

## 2.0.0

### Added

- Selection refinement: SELECT ▸ Feather… (gaussian-style blur of the selection mask), Expand… and Contract… (exact Euclidean distance transform, rounded corners, soft 1px rims via the new pure-math `pixelops.js` module).
- Quick Mask (SELECT ▸ Quick Mask or Q): paint the selection with the brush, pencil, or eraser over a red rubylith preview — light fg adds coverage, dark fg or the eraser carves it away; exiting bakes the working mask into the document selection as one history entry.
- Transform modes (Ctrl+T options bar): SCALE (as before), SKEW (corner drag shears the quad, ±45° clamp), and DISTORT (four free corners mapped per-triangle for true perspective).
- Retouch tools: Healing Brush (J — per-dab median blending for blemish removal), Dodge, Burn, and Sponge (O cycles — live color-dodge / color-burn / saturation stroke dabs with exposure/flow control).
- Pen tool (P; SHAPE is now keyless): click anchors, drag for curve handles, click the first anchor to close; buttons convert the path to a selection, stroke it with the current brush, or delete it.

### Changed

- Select By Color lost its Q keybinding to Quick Mask (it stays reachable from the SELECT menu and the toolbar).
- The transform tool gained a MODE segment (Scale / Skew / Distort) in its options bar; switching modes resets the corresponding state.

### Compatibility

- All new features operate on the existing document, selection, and history primitives; .dpx project files are unchanged and fully compatible.

## 1.9.0

### Added

- Adjustment layers: non-destructive filter layers built on the 11 adjust-group kernels (Brightness/Contrast, Hue/Saturation, Levels, Invert, Desaturate, Posterize, Threshold, Colorize), plus three new filters — Vibrance, Photo Filter, and Exposure.
- LAYER ▸ NEW ADJUSTMENT LAYER submenu with live parameter preview, per-layer masking, group support, and parameter history.
- Pass Through group blending: groups with Pass Through render children directly against layers below the group instead of onto the flattened group contents.
- Navigator panel: live composite thumbnail with a draggable viewport box and zoom −/FIT/+ controls.
- Histogram panel: luminance and RGB views with mean/median readout.
- .dpx project format v4 storing adjustment layers with parameters and masks.

### Changed

- Layer panel thumbnails distinguish adjustment layers with an ƒ badge that opens the parameter dialog; blend select offers Pass Through for groups and coerces it on pixel layers.
- Painting, filters, transforming, moving, and nudging guard against adjustment layers, which have no pixel canvas; their masks remain paintable.

### Compatibility

- Documents carrying adjustment layers serialize as v4 bytes and require DEADPIXEL 1.9+ to edit; v1, v2, and v3 projects keep opening, and treeless documents without adjustment layers still serialize as v2.
- Adjustment layers merge onto pixel layers only; flattening bakes them into the flattened result.

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
