[![Alpha](https://img.shields.io/badge/status-alpha-orange.svg)](#status)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Windows 10+](https://img.shields.io/badge/Windows-10%20(1809%2B)%20%7C%2011-0078D6)](#system-requirements)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB)](https://tauri.app)


# <img width="40px" height="auto" alt="Frame 42" src="https://github.com/user-attachments/assets/4eb47dbf-af21-47a1-8c68-13d1c4235ea3" /> FONTY

**An open source, lightweight, font manager for Windows.**

Browse through your local font library, activate fonts only when you need them, and pull in Google Fonts on demand — all without permanently installing any font.

<img width="80%" height="auto" alt="FONTY_260424_1931" src="https://github.com/user-attachments/assets/8b907d33-d59b-49f9-b05b-92412044a578" />

> **Status:** Alpha. From designers to designers. Built with LLMs and tested on a Windows machine. Expect rough edges. File issues liberally. Feedback is very much welcome :)

---

## What it does

- **Scans your local font folders** (even 80 000+ files) and shows them grouped by family, with live per-row previews.
- **Activates fonts temporarily** for the current Windows session — Word, Affinity, Figma, etc. everything that reads DirectWrite / GDI picks them up instantly via `WM_FONTCHANGE`.
- **Deactivates cleanly** — no leftover files, no orphan registry entries, no restart required.
- **Per-user HKCU activation** — zero admin prompts, never writes to `C:\Windows\Fonts`.
- **Google Fonts built in** — browse the full catalog, activate any family or single variant, pre-fetches URLs in batches so bulk activation is fast.
- **Collections** as reusable tags (local fonts, individual styles, Google families, Google variants).
- **Pinned dock** for live preview comparison.
- **Restore on launch** — your active set survives quitting and reopening FONTY, and survives reboots via HKCU.
- **Auto-cleaning cache** — deactivated Google fonts stay on disk for 5 minutes in case you change your mind, then a background janitor reclaims the space.

## Styles & weights grouped in families

<img width="80%" height="auto" alt="FONTY_260424_1908" src="https://github.com/user-attachments/assets/dc2c414e-e8e0-4bcf-a25b-c114c274b17a" />

## Compare fonts by pinning

<img width="80%" height="auto" alt="FONTY_260424_1947" src="https://github.com/user-attachments/assets/c239751d-2fc3-403b-86c8-4c3ed9071566" />

## Why another font manager?

The font manager software landscape is outdated, with only one player delivering a "stable" and modern software. If they don't deliver, or an individual error blocks the user from utilizing the font, there is no real alternative. FONTY is the result of that frustration. Fonty is designed to cover that gap **fast**, **temporary activation**, minimal ceremony, no cloud account, and nothing stored outside `%LOCALAPPDATA%`. 

- 100% LOCAL Your tool, your power! I hope for the community to contribute to and grow this and other open-source tools.

## System requirements

- **Windows 10 version 1809 (October 2018 Update) or newer**, or Windows 11. Earlier versions can't register fonts under HKCU without admin rights.
- WebView2 runtime (installed on Windows 10 1809+ and all Windows 11 builds by default).
- No admin account needed.

## Install

1. Go to the [latest Release](../../releases/latest).
2. Download either the `.msi` or the `-setup.exe` installer.
3. Run it. Windows Defender / SmartScreen may warn that the installer isn't signed — click **More info → Run anyway**. The binary is unsigned because alpha builds don't go through a code-signing cert yet.
4. Launch FONTY from the Start menu.
5. On first run, drag any folder containing fonts into the window to add it as a library root, or let FONTY start empty and add folders from the left sidebar.

### Uninstall

Uninstall from Windows Settings → Apps like any normal application. FONTY's own settings panel has a **"Uninstall all user fonts from system"** option if you want to wipe the per-user font folder on your way out.

## Where your data lives

- **App settings + font database**: `%APPDATA%\com.fonty.app\fonty.db` (SQLite, WAL mode)
- **Google Fonts cache**: `%LOCALAPPDATA%\com.fonty.app\cache\google\<FamilyName>\`
- **Per-user font registry**: standard Windows `HKCU\Software\Microsoft\Windows NT\CurrentVersion\Fonts`

FONTY never touches `C:\Windows\Fonts`.

## Known alpha-stage limitations

- Only tested on Windows 11. Win10 1809+ should work but isn't verified.
- Complex-script fonts Windows itself refuses (e.g. Gidugu — Telugu) can't be activated; this is a GDI limitation, not a FONTY bug.
- Alpha builds are unsigned — SmartScreen will warn on first install.
- Dark-mode glyph map / variable-font axis sliders in the styles tray are still to-do.

## Development

You'll need:

- **Rust** (stable, 1.77+): install via [rustup](https://rustup.rs/).
- **Node.js** 20 LTS or newer.
- **Tauri prerequisites for Windows**: WebView2 (bundled with Win10 1809+), plus the MSVC toolchain via [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).
- **WiX Toolset v3** (for MSI bundling only — Tauri downloads it automatically on first bundle build).

Once those are in place:

```powershell
# clone
git clone https://github.com/Rebelkernel/Fonty
cd fonty

# install frontend deps
npm install

# dev-run (hot reload for frontend, cargo watch for backend)
npm run tauri dev

# release build (exe only, no installer)
npm run tauri -- build --no-bundle

# release build WITH installer bundle (MSI + NSIS)
npm run tauri -- build
```

The unbundled release exe ends up at `src-tauri\target\release\fonty.exe`. The installers land in `src-tauri\target\release\bundle\msi\` and `src-tauri\target\release\bundle\nsis\`.

### Project layout

```
src/              React + Zustand frontend (Tailwind v4, TanStack Virtual for the big list)
src-tauri/src/    Rust backend
  ├── lib.rs            # Tauri setup, tray, background restore + janitor threads
  ├── commands.rs       # All 50+ Tauri commands (activate / deactivate / scan / Google)
  ├── db.rs             # SQLite schema + all queries (WAL mode)
  ├── activator.rs      # Win32 font registration (AddFontResourceW + HKCU + WM_FONTCHANGE)
  ├── scanner.rs        # Parallel font walker (walkdir + rayon)
  ├── parser.rs         # ttf-parser metadata extraction
  └── google_fonts.rs   # Google Fonts CSS pipeline + cache management
public/           Static assets
```

### Architecture notes

**Activation model:** Files are the atomic activation unit (`AddFontResourceW` + HKCU entry per file). Families, folders, collections, and Google categories are pure *groupings* — their UI state (active / mixed / inactive dot, counters) is derived by iterating descendants. Clicking a container's dot fans out into file-level activations.

**Google Fonts pipeline:** Downloads go through `fonts.googleapis.com/css?...` with a `Java/1.6.0` User-Agent, which returns per-weight/style static TTF URLs on `fonts.gstatic.com` even for families that ship as variable fonts in the google/fonts repo. Each variant lands as its own file (`{Camel}-{Style}.ttf`), matching FontBase's naming. Bulk operations batch the CSS fetch (up to 20 families per request) and broadcast `WM_FONTCHANGE` once per batch.

**Cache policy:** Deactivating a Google family keeps its files on disk for 5 minutes (fast re-activation), then a background janitor thread reclaims the space. A per-family "Remove from PC" context action bypasses the grace period. Full cache clear + inactive-only sweep are available in Settings.

## Contributing

Alpha means: if you try it and something breaks, please file an issue with:

1. What you clicked
2. What you expected
3. What happened instead
4. The contents of Settings → Error log (copy button is built in)

PRs welcome for small fixes. For bigger changes, open an issue first so we can talk approach.

## Credits

- Built on [Tauri v2](https://tauri.app), React 19, Tailwind v4, Zustand, TanStack Virtual.
- Rust font parsing via [ttf-parser](https://github.com/RazrFalcon/ttf-parser).

## License

[MIT](LICENSE). Do what you like.
