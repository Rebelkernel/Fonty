import { useStore } from "../store";

export function ViewModeToggle() {
  const viewMode = useStore((s) => s.viewMode);
  const toggleViewMode = useStore((s) => s.toggleViewMode);
  const isGrid = viewMode === "grid";
  return (
    <button
      type="button"
      onClick={toggleViewMode}
      className="inline-flex items-center justify-center rounded-md w-8 h-8 text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
      title={isGrid ? "Switch to list view" : "Switch to grid view"}
      aria-label="Toggle view mode"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {isGrid ? (
          <>
            <line x1="2.5" y1="4" x2="13.5" y2="4" />
            <line x1="2.5" y1="8" x2="13.5" y2="8" />
            <line x1="2.5" y1="12" x2="13.5" y2="12" />
          </>
        ) : (
          <>
            <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
            <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
            <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
            <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
          </>
        )}
      </svg>
    </button>
  );
}
