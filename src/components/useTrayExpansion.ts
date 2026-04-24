/**
 * Drives the smooth left-edge slide on styles trays using pure CSS — no
 * ResizeObserver, no measurement, no ref. The tray's width transitions
 * between a fixed 480 px and `calc(100% - 12px)` (the flex row's full width
 * minus the `gap-3` separator). Works because:
 *   - `flex: 0 0 auto` makes the aside honour its `width` value exactly.
 *   - The sibling FamilyList has `flex-1 min-w-0` and shrinks to 0 as the
 *     tray grows.
 *   - `width` transitions interpolate between px and calc values because
 *     both resolve to pixels at compute time.
 *
 * 800 ms cubic-bezier matches Adria's brief ("smooth slide, both directions").
 * PinnedDock sits below the flex row so it's never affected.
 */
export const TRAY_COLLAPSED_WIDTH = 480;
export const TRAY_TRANSITION =
  "width 800ms cubic-bezier(0.22, 1, 0.36, 1)";

export function useTrayExpansion(expanded: boolean) {
  return {
    style: {
      width: expanded ? "calc(100% - 12px)" : `${TRAY_COLLAPSED_WIDTH}px`,
      flex: "0 0 auto",
      transition: TRAY_TRANSITION,
    } as React.CSSProperties,
  };
}
