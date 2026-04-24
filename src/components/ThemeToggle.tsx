import { useStore } from "../store";

/**
 * Sun icon where spike length telegraphs the *next* state.
 * - Light mode active → short spikes (click → darkness = shrink)
 * - Dark mode active  → long spikes (click → sun rises)
 */
export function ThemeToggle() {
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const isDark = theme === "dark";
  const spikeLen = isDark ? 3.2 : 1.6;
  const spikeOffset = 8 - spikeLen / 2;

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="inline-flex items-center justify-center rounded-full w-8 h-8 text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle color mode"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        className="pointer-events-none"
      >
        <circle cx="8" cy="8" r="3" fill="currentColor" />
        {/* 8 spikes whose length we animate */}
        {Array.from({ length: 8 }).map((_, i) => {
          const angle = (i * Math.PI) / 4;
          const x1 = 8 + Math.cos(angle) * 4.5;
          const y1 = 8 + Math.sin(angle) * 4.5;
          const x2 = 8 + Math.cos(angle) * (4.5 + spikeLen);
          const y2 = 8 + Math.sin(angle) * (4.5 + spikeLen);
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              style={{
                transition: "all 220ms ease",
              }}
            />
          );
        })}
        {/* touch offset reference (avoid warning) */}
        <g style={{ display: "none" }}>
          <rect x={spikeOffset} y="0" width="0" height="0" />
        </g>
      </svg>
    </button>
  );
}
