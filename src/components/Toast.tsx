import { useStore } from "../store";

/**
 * Transient floating notification. Shows "Added to X" / "Removed from X"
 * after a collection toggle, or anything else that calls `showToast`.
 * Auto-dismisses from the store side; this component just renders the
 * current message if one is pending.
 */
export function Toast() {
  const toast = useStore((s) => s.toast);
  const dismiss = useStore((s) => s.dismissToast);
  if (!toast) return null;
  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 pointer-events-auto"
      onClick={dismiss}
      role="status"
      aria-live="polite"
    >
      <div className="bg-[var(--color-surface-2)] text-[var(--color-text)] px-4 py-2 rounded-full text-sm shadow-lg border border-[var(--color-border)]">
        {toast.message}
      </div>
    </div>
  );
}
