import { useEffect, useState } from "react";
import { useStore } from "../store";
import { FontPreview } from "./FontPreview";
import type { FontRow } from "../types";
import { ActivationToggle, useActivationLoading } from "./ActivationToggle";
import { StarButton } from "./StarButton";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { buildAddToCollectionItems } from "./collectionMenuItems";
import { PinButton } from "./PinButton";
import { TrayExpandToggle } from "./TrayExpandToggle";
import { useTrayExpansion } from "./useTrayExpansion";

export function FamilyDetail() {
  const selectedFamily = useStore((s) => s.selectedFamily);
  const familyStyles = useStore((s) => s.familyStyles);
  const loading = useStore((s) => s.loadingFamilyStyles);
  const closeFamily = useStore((s) => s.closeFamily);
  const previewBgColor = useStore((s) => s.previewBgColor);
  const previewTextColor = useStore((s) => s.previewTextColor);
  const collectionsForFamily = useStore((s) => s.collectionsForFamily);
  const selectCollection = useStore((s) => s.selectCollection);
  const removeFamilyFromCollection = useStore(
    (s) => s.removeFamilyFromCollection,
  );
  const trayExpanded = useStore((s) => s.trayExpanded);
  const toggleTrayExpanded = useStore((s) => s.toggleTrayExpanded);
  const expansion = useTrayExpansion(trayExpanded);
  const [familyCollections, setFamilyCollections] = useState<
    import("../types").Collection[]
  >([]);

  useEffect(() => {
    if (!selectedFamily) {
      setFamilyCollections([]);
      return;
    }
    collectionsForFamily(selectedFamily).then(setFamilyCollections);
  }, [selectedFamily, collectionsForFamily]);

  if (!selectedFamily) return null;

  return (
    <aside
      className="flex flex-col min-h-0 rounded-3xl overflow-hidden"
      style={{
        backgroundColor: previewBgColor,
        color: previewTextColor,
        ...expansion.style,
      }}
    >
      <header
        className="px-5 py-3 flex items-start gap-3 shrink-0"
        style={{ borderBottom: "1px solid currentColor", borderColor: "rgba(128,128,128,0.15)" }}
      >
        <TrayExpandToggle
          expanded={trayExpanded}
          onToggle={toggleTrayExpanded}
        />
        <div className="flex-1 min-w-0">
          <div
            className="text-[10px] uppercase tracking-wider"
            style={{ opacity: 0.45 }}
          >
            Family
          </div>
          <div className="text-base font-medium truncate">
            {selectedFamily}
          </div>
          <div
            className="text-xs mt-0.5"
            style={{ opacity: 0.45 }}
          >
            {loading
              ? "Loading styles…"
              : `${familyStyles.length} style${familyStyles.length === 1 ? "" : "s"}`}
          </div>
          {familyCollections.length > 0 && (
            <div className="flex items-center flex-wrap gap-1.5 mt-2">
              {familyCollections.map((c) => (
                <span
                  key={c.id}
                  className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border border-current"
                  style={{ opacity: 0.7 }}
                  title={`In collection: ${c.name}`}
                >
                  <button
                    type="button"
                    onClick={() => selectCollection(c.id)}
                    className="hover:opacity-100 focus:outline-none"
                    style={{ opacity: 0.9 }}
                  >
                    {c.name}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await removeFamilyFromCollection(
                        c.id,
                        selectedFamily,
                      );
                      setFamilyCollections((prev) =>
                        prev.filter((p) => p.id !== c.id),
                      );
                    }}
                    title={`Remove "${selectedFamily}" from "${c.name}"`}
                    className="hover:opacity-100"
                    style={{ opacity: 0.6 }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={closeFamily}
          className="text-lg leading-none px-2 py-1 rounded hover:bg-black/5 dark:hover:bg-white/5 opacity-60 hover:opacity-100"
          title="Close"
          aria-label="Close family detail"
        >
          ×
        </button>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && familyStyles.length === 0 && (
          <div className="p-5 text-xs" style={{ opacity: 0.5 }}>
            Loading…
          </div>
        )}
        {!loading && familyStyles.length === 0 && (
          <div className="p-5 text-xs" style={{ opacity: 0.5 }}>
            No styles found.
          </div>
        )}
        <ul>
          {familyStyles.map((s) => (
            <StyleRow key={s.id} style={s} />
          ))}
        </ul>
      </div>
    </aside>
  );
}

function StyleRow({ style }: { style: FontRow }) {
  const previewText = useStore((s) => s.previewText);
  const previewSize = useStore((s) => s.previewSize);
  const activeIds = useStore((s) => s.activeIds);
  const starredIds = useStore((s) => s.starredIds);
  const activateFonts = useStore((s) => s.activateFonts);
  const deactivateFonts = useStore((s) => s.deactivateFonts);
  const starFonts = useStore((s) => s.starFonts);
  const unstarFonts = useStore((s) => s.unstarFonts);
  const collections = useStore((s) => s.collections);
  const toggleFontInCollection = useStore((s) => s.toggleFontInCollection);
  const collectionsForFont = useStore((s) => s.collectionsForFont);
  const selectCollection = useStore((s) => s.selectCollection);
  const pinnedStyles = useStore((s) => s.pinnedStyles);
  const togglePinStyle = useStore((s) => s.togglePinStyle);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [styleCollections, setStyleCollections] = useState<
    import("../types").Collection[]
  >([]);
  const isStylePinned = pinnedStyles.some((s) => s.id === style.id);

  // Per-style collection membership so we can paint pills on the row and
  // check-mark already-added collections in the context menu. Reloaded
  // whenever the collections list changes (add/remove/toggle).
  useEffect(() => {
    let cancelled = false;
    collectionsForFont(style.id).then((list) => {
      if (!cancelled) setStyleCollections(list);
    });
    return () => {
      cancelled = true;
    };
  }, [style.id, collectionsForFont, collections]);

  // No upper clamp — the slider's own 8-200 range governs.
  const displaySize = Math.max(14, previewSize);
  const fileName =
    style.filePath.split(/[\\/]/).pop() ?? style.filePath;
  const state = activeIds.has(style.id) ? "active" : "inactive";
  const isStarred = starredIds.has(style.id);
  const loading = useActivationLoading([
    `font:${style.id}`,
    `family:${style.familyName}`,
  ]);

  const menuItems: MenuItem[] = [
    {
      label: state === "active" ? `Deactivate "${fileName}"` : `Activate "${fileName}"`,
      onSelect: () => {
        if (state === "active") deactivateFonts([style.id]);
        else activateFonts([style.id]);
      },
    },
    { separator: true, label: "" },
    {
      label: "Copy style name",
      onSelect: () =>
        navigator.clipboard.writeText(fileName).catch(() => {}),
    },
    ...buildAddToCollectionItems({
      collections,
      existingCollectionIds: new Set(styleCollections.map((c) => c.id)),
      onToggle: (collectionId, c) =>
        toggleFontInCollection(collectionId, style.id, c.name),
    }),
  ];

  return (
    <li
      className="hover-reveal-parent px-5 py-3 hover:bg-black/5 dark:hover:bg-white/5"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div
        className="text-xs mb-1 flex items-center gap-1.5"
        style={{ opacity: 0.6 }}
      >
        <ActivationToggle
          state={state}
          loading={loading}
          onToggle={(activate) => {
            if (activate) activateFonts([style.id]);
            else deactivateFonts([style.id]);
          }}
        />
        <span className="truncate" title={style.filePath}>
          {fileName}
        </span>
        <span>·</span>
        <span>{style.weight}</span>
        {style.italic && <span className="italic">italic</span>}
        {styleCollections.length > 0 && (
          <span className="flex items-center gap-1 flex-wrap">
            {styleCollections.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  selectCollection(c.id);
                }}
                className="btn-pill btn-pill-sm"
                style={{ textTransform: "none" }}
                title={`In collection: ${c.name}`}
              >
                {c.name}
              </button>
            ))}
          </span>
        )}
        <div className="flex-1" />
        <span className={isStarred ? "" : "hover-reveal"}>
          <StarButton
            starred={isStarred}
            onToggle={() => {
              if (isStarred) unstarFonts([style.id]);
              else starFonts([style.id]);
            }}
          />
        </span>
        <span className={isStylePinned ? "" : "hover-reveal"}>
          <PinButton
            pinned={isStylePinned}
            onToggle={() => togglePinStyle(style)}
          />
        </span>
      </div>
      <div
        className="text-[10px] truncate mb-1"
        title={style.filePath}
        style={{ opacity: 0.35 }}
      >
        {style.filePath}
        {style.ttcIndex > 0 ? ` (#${style.ttcIndex})` : ""}
      </div>
      <div>
        <FontPreview
          repId={style.id}
          filePath={style.filePath}
          ttcIndex={style.ttcIndex}
          text={previewText || "The quick brown fox"}
          size={displaySize}
        />
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </li>
  );
}
