import { useStore } from "../store";

/**
 * Small "thinking" spinner visible whenever FONTY is doing a background
 * operation (activation, Google download, scan). Replaces the previous
 * "forbidden" cursor with an indicator that the app is working, not
 * blocked. Sits in the top bar next to the search field.
 */
export function BusySpinner() {
  const activationBusy = useStore((s) => s.activationBusy);
  const googleFontsLoading = useStore((s) => s.googleFontsLoading);
  const scanning = useStore((s) => s.scanning);
  const busy = activationBusy || googleFontsLoading || scanning;
  if (!busy) return null;
  const label = scanning
    ? "Scanning"
    : googleFontsLoading
      ? "Syncing Google Fonts"
      : "Working…";
  return (
    <div
      className="flex items-center gap-2 text-[var(--color-text-dim)]"
      title={label}
      aria-label={label}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        className="animate-spin"
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="42"
          strokeDashoffset="28"
          opacity="0.9"
        />
      </svg>
    </div>
  );
}
