import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Event name used to enforce one-context-menu-at-a-time. A new menu
 * dispatches this event with its own id; any other mounted menu whose id
 * differs closes itself. */
const CONTEXT_MENU_EVENT = "fonty:context-menu-opened";

export type MenuItem =
  | {
      label: string;
      onSelect: () => void;
      destructive?: boolean;
      disabled?: boolean;
      separator?: false;
    }
  | {
      separator: true;
      label?: string;
    };

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      x: Math.min(x, vw - w - 4),
      y: Math.min(y, vh - h - 4),
    });
  }, [x, y]);

  // Unique id so the one-menu-at-a-time mutex can discriminate between
  // this instance and siblings.
  const myId = useMemo(
    () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    [],
  );

  useEffect(() => {
    const close = () => onClose();
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const handleOtherOpened = (e: Event) => {
      const ce = e as CustomEvent<{ id: string }>;
      if (ce.detail && ce.detail.id !== myId) onClose();
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", escape);
    window.addEventListener(CONTEXT_MENU_EVENT, handleOtherOpened);
    // Announce ourselves so any already-open menus step aside.
    window.dispatchEvent(
      new CustomEvent(CONTEXT_MENU_EVENT, { detail: { id: myId } }),
    );
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", escape);
      window.removeEventListener(CONTEXT_MENU_EVENT, handleOtherOpened);
    };
  }, [onClose, myId]);

  return createPortal(
    <div
      ref={ref}
      className="fixed z-50 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded shadow-xl py-1 min-w-[180px]"
      style={{ top: pos.y, left: pos.x }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.separator) {
          return item.label ? (
            <div
              key={i}
              className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-wider text-[var(--color-text-faint)]"
            >
              {item.label}
            </div>
          ) : (
            <div
              key={i}
              className="mx-2 my-1 h-px bg-[var(--color-border)]"
            />
          );
        }
        return (
          <button
            key={i}
            type="button"
            disabled={item.disabled}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
            className="w-full text-left text-sm px-3 py-1.5 hover:bg-[var(--color-surface)] disabled:opacity-40 disabled:cursor-not-allowed"
            style={
              item.destructive
                ? { color: "var(--color-danger)" }
                : { color: "var(--color-text-dim)" }
            }
          >
            {item.label}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
