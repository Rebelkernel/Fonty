import { useStore } from "../store";
import { ColorSwatch } from "./ColorSwatch";
import { ViewModeToggle } from "./ViewModeToggle";
import { BusySpinner } from "./BusySpinner";
import logoDarkBlock from "../assets/logo-dark-block.svg";
import logoLightBlock from "../assets/logo-light-block.svg";

export function TopBar() {
  const theme = useStore((s) => s.theme);
  // "Opposite of the mode" — dark-block logo on light theme, light-block
  // logo on dark theme — so the mark always contrasts with the surface.
  const logoSrc = theme === "light" ? logoDarkBlock : logoLightBlock;
  const previewText = useStore((s) => s.previewText);
  const previewSize = useStore((s) => s.previewSize);
  const searchQuery = useStore((s) => s.searchQuery);
  const previewTextColor = useStore((s) => s.previewTextColor);
  const previewBgColor = useStore((s) => s.previewBgColor);
  const stats = useStore((s) => s.stats);
  const dragActive = useStore((s) => s.dragActive);
  const setPreviewText = useStore((s) => s.setPreviewText);
  const setPreviewSize = useStore((s) => s.setPreviewSize);
  const setSearchQuery = useStore((s) => s.setSearchQuery);
  const setPreviewTextColor = useStore((s) => s.setPreviewTextColor);
  const setPreviewBgColor = useStore((s) => s.setPreviewBgColor);
  const resetPreviewColors = useStore((s) => s.resetPreviewColors);

  return (
    <header
      className={`pt-3 shrink-0 bg-[var(--color-surface)] flex items-stretch transition-colors ${
        dragActive ? "dropzone-active" : ""
      }`}
      style={{ minHeight: 68 }}
      title={dragActive ? "Drop folder to add to FONTY" : undefined}
    >
      {/* Left block mirrors the sidebar width so the right block's left edge
          lines up with the main rendering card. Counters shrink with the
          available space if the logo grows. */}
      <div className="w-64 shrink-0 pl-5 pr-3 flex items-center gap-3 min-w-0">
        <img
          src={logoSrc}
          alt="FONTY"
          className="fonty-mark-img"
          draggable={false}
        />
        <div className="text-[10px] text-[var(--color-text-faint)] flex flex-col leading-tight min-w-0">
          <span className="truncate">
            {stats.families.toLocaleString()} families
          </span>
          <span className="truncate">
            {stats.fonts.toLocaleString()} styles
          </span>
        </div>
      </div>

      {/* Right block: starts exactly at the main card's left edge (sidebar
          width + main's pl). Tight leading padding keeps that alignment. */}
      <div className="flex-1 min-w-0 flex items-center gap-4 pl-1 pr-5">
        <input
          type="text"
          value={previewText}
          onChange={(e) => setPreviewText(e.currentTarget.value)}
          placeholder="Preview text"
          className="flex-1 min-w-0 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)] transition-colors"
        />

        <div className="flex items-center gap-3 shrink-0">
          <input
            type="range"
            min={8}
            max={200}
            value={previewSize}
            onChange={(e) =>
              setPreviewSize(parseInt(e.currentTarget.value, 10))
            }
            className="fonty-slider w-36"
          />
          <span className="text-xs text-[var(--color-text-dim)] w-10 text-right tabular-nums">
            {previewSize}px
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <ColorSwatch
            value={previewTextColor}
            onChange={setPreviewTextColor}
            label="Preview text color"
          />
          <ColorSwatch
            value={previewBgColor}
            onChange={setPreviewBgColor}
            label="Preview background color"
          />
          <button
            type="button"
            onClick={resetPreviewColors}
            className="text-[var(--color-text-faint)] hover:text-[var(--color-text)] text-xs px-1"
            title="Reset preview colors"
          >
            ↻
          </button>
        </div>

        <ViewModeToggle />
        <BusySpinner />

        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.currentTarget.value)}
          placeholder="Search Font Name…"
          className="w-64 shrink-0 bg-[var(--color-input-bg)] border-none rounded-full px-4 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40 transition-colors"
        />
      </div>
    </header>
  );
}
