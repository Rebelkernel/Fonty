import { useStore } from "../store";
import type { ActivationState } from "../types";

export type LoadingDirection = "activating" | "deactivating";

/**
 * Returns the active loading direction for any of the provided target
 * keys — first match wins. Target keys mirror the store's activating/
 * deactivatingTargets sets: "family:X", "font:123", "folder:…",
 * "collection:5", "google:X", "google-variant:X:700italic", "google-all",
 * "google-cat:serif".
 */
export function useActivationLoading(
  targets: string[],
): LoadingDirection | undefined {
  const activating = useStore((s) => s.activatingTargets);
  const deactivating = useStore((s) => s.deactivatingTargets);
  for (const t of targets) {
    if (activating.has(t)) return "activating";
    if (deactivating.has(t)) return "deactivating";
  }
  return undefined;
}

export function ActivationToggle({
  state,
  disabled,
  onToggle,
  size = 16,
  loading,
}: {
  state: ActivationState;
  disabled?: boolean;
  onToggle: (nextActive: boolean) => void;
  size?: number;
  /** When set, render a blue spinning arc instead of the dot. Direction
   *  tells us whether the animation should rotate clockwise (activating)
   *  or counter-clockwise (deactivating). */
  loading?: LoadingDirection;
}) {
  const label = loading
    ? loading === "activating"
      ? "Activating…"
      : "Deactivating…"
    : state === "active"
      ? "Active — click to deactivate"
      : state === "mixed"
        ? "Some active — click to activate all"
        : "Inactive — click to activate";

  return (
    <button
      type="button"
      disabled={disabled || loading !== undefined}
      onClick={(e) => {
        e.stopPropagation();
        // active → deactivate; inactive/mixed → activate
        onToggle(state !== "active");
      }}
      className={`inline-flex items-center justify-center shrink-0 rounded-full transition-colors ${
        disabled || loading !== undefined
          ? "cursor-progress"
          : "cursor-pointer"
      } ${disabled && !loading ? "opacity-60" : ""}`}
      style={{ width: size, height: size }}
      title={label}
      aria-label={label}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        className="pointer-events-none"
      >
        {loading ? (
          <g
            style={{
              transformOrigin: "8px 8px",
              animation: `fonty-spin-${
                loading === "activating" ? "cw" : "ccw"
              } 900ms linear infinite`,
            }}
          >
            {/* 3/4 arc — same stroke weight as the inactive dot so the
                loading state reads as a recognisable sibling. */}
            <path
              d="M 8 2.5 A 5.5 5.5 0 1 1 2.5 8"
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </g>
        ) : state === "inactive" ? (
          <circle
            cx="8"
            cy="8"
            r="5.5"
            fill="none"
            stroke="var(--color-text-faint)"
            strokeWidth="1.5"
          />
        ) : state === "active" ? (
          <circle cx="8" cy="8" r="6" fill="var(--color-accent)" />
        ) : (
          <>
            <circle
              cx="8"
              cy="8"
              r="5.5"
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="1.5"
            />
            <path d="M 8 2 A 6 6 0 0 1 8 14 Z" fill="var(--color-accent)" />
          </>
        )}
      </svg>
    </button>
  );
}

export function familyState(
  activeCount: number,
  total: number,
): ActivationState {
  if (activeCount <= 0) return "inactive";
  if (activeCount >= total) return "active";
  return "mixed";
}
