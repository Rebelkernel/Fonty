# Changelog

All notable changes to FONTY land here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-alpha] — 2026-04-23

First public Alpha. Single-developer, single-machine verified (Windows 11). Everything works; edges are rough.

### Local font library
- Parallel scan of arbitrary-sized font folders (tested on ~80 000 TTF/OTF).
- SQLite index with WAL mode; multi-root library; folder tree sidebar with tri-state activation dots.
- Virtualised main list (TanStack Virtual); list + grid views.
- Family detail tray with per-style rows, star / pin / add-to-collection context actions.
- Search across families; filters for Starred / Active.

### Activation
- Per-user HKCU registration via `AddFontResourceW` + HKCU entry + `WM_FONTCHANGE` broadcast.
- Ref-counted `RemoveFontResourceW` drain so Word / Affinity release handles on deactivate.
- Batched HKCU writes on deactivation; streaming per-variant activation on Google.
- Hierarchical activation model: files are the atomic unit; families / folders / categories / collections are derived groupings.
- Restore-on-launch: active set survives app quit and system reboot.
- Background restore thread so launch never blocks on a large active set.

### Google Fonts
- Full catalog via `fonts.google.com/metadata/fonts`; per-category sidebar.
- Per-style static TTF downloads via `fonts.googleapis.com/css` + `Java/1.6.0` User-Agent (same mechanism as FontBase). No API key required.
- Primary path plus fallbacks (google/fonts GitHub raw, Google Webfonts Helper ZIP, google.com/download ZIP).
- Batched CSS prefetch (up to 20 families per HTTP request) so bulk activation — category or all-Google — doesn't pay a per-family round-trip.
- Parallel variant downloads via a dedicated 32-thread rayon pool; family-level concurrency of 8 via a `pMap` helper on the frontend.
- Streaming per-variant activation: each TTF triggers its GDI + HKCU + DB + UI event the moment it lands on disk, not at end-of-family.
- Variable-font named instances parsed from the cached TTF's fvar table and surfaced in the styles tray (Inconsolata Condensed, Bold Wide, etc.).
- Per-family "Remove from PC" action; 5-minute grace timer before a deactivated family's cache is wiped; Settings "Clear inactive" sweep.
- One `WM_FONTCHANGE` broadcast per batch instead of per-family — large bulk ops no longer spam Word with refresh messages.
- CSS URL response cache (1-hour TTL) — reactivation within the session is zero-network.

### UI
- Pinned fonts dock for live preview comparison.
- Expand-to-full-width toggle on both styles trays with smooth 800 ms transition.
- Collections: tag-based groupings for local fonts, individual styles, Google families, Google variants.
- Theme toggle (light / dark), custom preview text + colours, preview-size slider up to 200 px.
- Loading-arc animation on activation dots (CW = activating, CCW = deactivating); per-level independent clearing so a family row flips active the moment its own variants are done, even if sibling families are still loading.
- Settings panel with restore-on-launch toggle, maintenance actions (deactivate all, uninstall user fonts, clear cache), in-app error log with Copy button, Google cache size readout.

### Developer
- DevTools enabled (F12) in release builds for user-side debugging.
- Tracing logs for janitor ticks, restore-on-launch timing, Google download strategy outcomes.

### Known limitations
- Unsigned installer — SmartScreen will warn.
- Complex-script fonts Windows refuses (Gidugu / Telugu etc.) surface a friendly error but cannot be activated.
- Glyph map view and VF axis sliders in the styles tray still deferred.

[0.1.0-alpha]: https://github.com/Rebelkernel/Fonty/releases/tag/v0.1.0-alpha
