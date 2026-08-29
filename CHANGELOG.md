# Changelog

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
