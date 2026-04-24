/**
 * Top-left button that toggles the styles tray between its default 480 px
 * width and "take over the main card" full-width mode. Two chevrons pointing
 * left when collapsed (click to grow left), pointing right when expanded
 * (click to shrink back). Pinned fonts card is unaffected either way — it
 * sits below the tray's flex row.
 */
export function TrayExpandToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="shrink-0 -ml-1 w-7 h-7 rounded hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center opacity-50 hover:opacity-100 transition-opacity"
      title={
        expanded ? "Collapse tray to 480 px" : "Expand tray over main card"
      }
      aria-label={expanded ? "Collapse tray" : "Expand tray"}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          transition: "transform 180ms ease",
          transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
        }}
      >
        {/* Two left-pointing chevrons. Rotates 180° when expanded so it
            reads as two right-pointing chevrons (collapse). */}
        <path d="M7 4 L3 8 L7 12" />
        <path d="M13 4 L9 8 L13 12" />
      </svg>
    </button>
  );
}
