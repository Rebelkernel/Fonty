import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "../store";
import type { GoogleFamilyRow } from "../types";
import {
  ActivationToggle,
  familyState,
  useActivationLoading,
} from "./ActivationToggle";
import { PinButton } from "./PinButton";
import { StarButton } from "./StarButton";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { buildAddToCollectionItems } from "./collectionMenuItems";

export function GoogleFontsView() {
  const families = useStore((s) => s.googleFamilies);
  const stats = useStore((s) => s.googleLibraryStats);
  const loading = useStore((s) => s.googleFontsLoading);
  const refresh = useStore((s) => s.refreshGoogleCatalog);
  const loadLibrary = useStore((s) => s.loadGoogleLibrary);
  const activateGoogleFamily = useStore((s) => s.activateGoogleFamily);
  const deactivateGoogleFamily = useStore((s) => s.deactivateGoogleFamily);
  const searchQuery = useStore((s) => s.searchQuery);
  const previewText = useStore((s) => s.previewText);
  const previewSize = useStore((s) => s.previewSize);
  const viewMode = useStore((s) => s.viewMode);
  const starredGoogleFamilies = useStore((s) => s.starredGoogleFamilies);
  const libraryFilter = useStore((s) => s.libraryFilter);
  const selectedGoogleCategory = useStore((s) => s.selectedGoogleCategory);

  // Active-FAMILIES count so the main-card header matches the sidebar's
  // "X/Y" semantics. stats.active is the total active VARIANT count, which
  // is useful context but needs an explicit label to avoid confusion.
  const activeFamilyCount = useMemo(
    () => families.reduce((n, f) => n + (f.activeCount > 0 ? 1 : 0), 0),
    [families],
  );

  useEffect(() => {
    loadLibrary();
  }, [loadLibrary]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let list = families;
    if (selectedGoogleCategory) {
      list = list.filter((f) => f.category === selectedGoogleCategory);
    }
    if (libraryFilter === "starred") {
      list = list.filter((f) => starredGoogleFamilies.has(f.familyName));
    } else if (libraryFilter === "active") {
      list = list.filter((f) => f.activeCount > 0);
    }
    if (q) list = list.filter((f) => f.familyName.toLowerCase().includes(q));
    return list;
  }, [
    families,
    searchQuery,
    libraryFilter,
    starredGoogleFamilies,
    selectedGoogleCategory,
  ]);

  const empty = !loading && families.length === 0;

  return (
    <div className="h-full w-full flex flex-col">
      <div
        className="text-xs px-6 py-3 shrink-0 flex items-center gap-3 min-h-[36px]"
        style={{ opacity: 0.6 }}
      >
        <span style={{ opacity: 0.8 }}>Google Fonts</span>
        {stats.families > 0 && (
          <>
            <span>· {stats.families.toLocaleString()} families</span>
            {activeFamilyCount > 0 && (
              <span>
                · {activeFamilyCount.toLocaleString()} active (
                {stats.active.toLocaleString()} variant
                {stats.active === 1 ? "" : "s"})
              </span>
            )}
          </>
        )}
        {loading && <span>· syncing…</span>}
        <button
          type="button"
          onClick={() => refresh()}
          disabled={loading}
          className="ml-auto text-[10px] px-2.5 py-1 rounded-full border border-current opacity-60 hover:opacity-100 disabled:opacity-30"
          title="Fetch the latest Google Fonts catalog"
        >
          {stats.families === 0 ? "Load catalog" : "Refresh catalog"}
        </button>
      </div>
      {empty ? (
        <div
          className="flex-1 flex items-center justify-center text-xs"
          style={{ opacity: 0.55 }}
        >
          Click <span className="mx-1 font-medium">Load catalog</span> to pull
          the latest Google Fonts list.
        </div>
      ) : viewMode === "grid" ? (
        <GoogleFontsGrid
          families={filtered}
          text={previewText}
          size={previewSize}
          onActivate={activateGoogleFamily}
          onDeactivate={deactivateGoogleFamily}
        />
      ) : (
        <GoogleFontsList
          families={filtered}
          text={previewText}
          size={previewSize}
          onActivate={activateGoogleFamily}
          onDeactivate={deactivateGoogleFamily}
        />
      )}
    </div>
  );
}

function GoogleFontsList({
  families,
  text,
  size,
  onActivate,
  onDeactivate,
}: {
  families: GoogleFamilyRow[];
  text: string;
  size: number;
  onActivate: (f: string) => void;
  onDeactivate: (f: string) => void;
}) {
  const rowHeight = Math.max(72, size + 52);
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: families.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  return (
    <div ref={parentRef} className="flex-1 min-h-0 overflow-auto">
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {virtualizer.getVirtualItems().map((v) => {
          const f = families[v.index];
          return (
            <div
              key={f.familyName}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: v.size,
                transform: `translateY(${v.start}px)`,
              }}
            >
              <GoogleFontRow
                family={f}
                text={text || "The quick brown fox"}
                size={size}
                onActivate={() => onActivate(f.familyName)}
                onDeactivate={() => onDeactivate(f.familyName)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Grid layout mirrors FamilyGrid shape for a consistent feel between the two
// sections. Columns auto-size to a target width so the preview stays readable.
const CELL_TARGET_WIDTH = 340;
const CELL_GAP = 10;
const CONTAINER_PADDING = 16;
const CELL_CHROME = 88;

function GoogleFontsGrid({
  families,
  text,
  size,
  onActivate,
  onDeactivate,
}: {
  families: GoogleFamilyRow[];
  text: string;
  size: number;
  onActivate: (f: string) => void;
  onDeactivate: (f: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!parentRef.current) return;
    const ro = new ResizeObserver(() => {
      if (parentRef.current) setWidth(parentRef.current.clientWidth);
    });
    ro.observe(parentRef.current);
    setWidth(parentRef.current.clientWidth);
    return () => ro.disconnect();
  }, []);

  const cellPreviewSize = Math.min(size, 96);
  const cellHeight = Math.max(
    140,
    Math.round(cellPreviewSize * 1.6 + CELL_CHROME),
  );
  const rowStride = cellHeight + CELL_GAP;

  const innerWidth = Math.max(0, width - CONTAINER_PADDING * 2);
  const columnCount = Math.max(
    1,
    Math.floor((innerWidth + CELL_GAP) / (CELL_TARGET_WIDTH + CELL_GAP)),
  );
  const rowCount = Math.ceil(families.length / Math.max(1, columnCount));

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowStride,
    overscan: 4,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [columnCount, rowStride, virtualizer]);

  return (
    <div ref={parentRef} className="flex-1 min-h-0 overflow-auto">
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
          padding: `0 ${CONTAINER_PADDING}px`,
        }}
      >
        {virtualizer.getVirtualItems().map((v) => {
          const startIdx = v.index * columnCount;
          const items = families.slice(startIdx, startIdx + columnCount);
          return (
            <div
              key={v.key}
              style={{
                position: "absolute",
                top: 0,
                left: CONTAINER_PADDING,
                right: CONTAINER_PADDING,
                height: cellHeight,
                transform: `translateY(${v.start}px)`,
                display: "grid",
                gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                gap: `${CELL_GAP}px`,
              }}
            >
              {items.map((f) => (
                <GoogleGridCell
                  key={f.familyName}
                  family={f}
                  text={text || "Aa Bb Cc"}
                  size={cellPreviewSize}
                  height={cellHeight}
                  onActivate={() => onActivate(f.familyName)}
                  onDeactivate={() => onDeactivate(f.familyName)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function useGoogleFontLink(family: string) {
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
      family,
    )}&display=block`;
    link.setAttribute("data-google-font", family);
    document.head.appendChild(link);
    return () => {
      link.remove();
    };
  }, [family]);
}

export function GoogleFontRow({
  family,
  text,
  size,
  onActivate,
  onDeactivate,
}: {
  family: GoogleFamilyRow;
  text: string;
  size: number;
  onActivate: () => void;
  onDeactivate: () => void;
}) {
  const openGoogleFamily = useStore((s) => s.openGoogleFamily);
  const pinnedGoogleFamilies = useStore((s) => s.pinnedGoogleFamilies);
  const togglePinGoogleFamily = useStore((s) => s.togglePinGoogleFamily);
  const starredGoogleFamilies = useStore((s) => s.starredGoogleFamilies);
  const toggleStarGoogleFamily = useStore((s) => s.toggleStarGoogleFamily);
  const collections = useStore((s) => s.collections);
  const toggleGoogleFamilyInCollection = useStore(
    (s) => s.toggleGoogleFamilyInCollection,
  );
  const collectionsForGoogleFamily = useStore(
    (s) => s.collectionsForGoogleFamily,
  );
  const removeGoogleFamily = useStore((s) => s.removeGoogleFamily);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [existingIds, setExistingIds] = useState<Set<number>>(new Set());
  const isPinned = pinnedGoogleFamilies.includes(family.familyName);
  const isStarred = starredGoogleFamilies.has(family.familyName);
  useGoogleFontLink(family.familyName);

  const state = familyState(family.activeCount, family.variantCount);
  // Only check this family's own target. Parent targets (google-cat:*,
  // google-all) are pre-added and cleared at their own level — each level
  // flips independently when its own work completes. This is how a family
  // can show "active" while its category is still processing siblings.
  const loading = useActivationLoading([`google:${family.familyName}`]);

  const activationItems: MenuItem[] =
    state === "active"
      ? [
          {
            label: `Deactivate "${family.familyName}"`,
            onSelect: onDeactivate,
          },
        ]
      : state === "inactive"
        ? [
            {
              label: `Activate "${family.familyName}"`,
              onSelect: onActivate,
            },
          ]
        : [
            {
              label: "Activate remaining styles",
              onSelect: onActivate,
            },
            {
              label: `Deactivate "${family.familyName}"`,
              onSelect: onDeactivate,
            },
          ];
  const menuItems: MenuItem[] = [
    ...activationItems,
    { separator: true, label: "" },
    {
      label: "Open family info",
      onSelect: () => openGoogleFamily(family.familyName),
    },
    {
      label: "Copy family name",
      onSelect: () => {
        navigator.clipboard
          .writeText(family.familyName)
          .catch((e) => console.error(e));
      },
    },
    ...buildAddToCollectionItems({
      collections,
      existingCollectionIds: existingIds,
      onToggle: (collectionId, c) =>
        toggleGoogleFamilyInCollection(collectionId, family.familyName, c.name),
    }),
    { separator: true, label: "" },
    {
      label: "Remove from PC",
      destructive: true,
      onSelect: () => removeGoogleFamily(family.familyName),
    },
  ];

  return (
    <div
      className="hover-reveal-parent h-full px-6 py-3 flex flex-col gap-1.5 cursor-pointer"
      onClick={() => openGoogleFamily(family.familyName)}
      onContextMenu={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const list = await collectionsForGoogleFamily(family.familyName);
        setExistingIds(new Set(list.map((c) => c.id)));
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div
        className="flex items-center gap-2 text-xs min-w-0"
        style={{ opacity: 0.6 }}
      >
        <ActivationToggle
          state={state}
          loading={loading}
          size={12}
          onToggle={(activate) => {
            if (activate) onActivate();
            else onDeactivate();
          }}
        />
        <span className="truncate">{family.familyName}</span>
        <span>·</span>
        <span>
          {family.activeCount > 0
            ? `${family.activeCount}/${family.variantCount}`
            : family.variantCount}{" "}
          style{family.variantCount === 1 ? "" : "s"}
        </span>
        <span>·</span>
        <span className="uppercase tracking-wider">Google</span>
        <span>·</span>
        <span className="uppercase tracking-wider">{family.category}</span>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <div className={isStarred ? "" : "hover-reveal"}>
            <StarButton
              starred={isStarred}
              onToggle={() => toggleStarGoogleFamily(family.familyName)}
            />
          </div>
          <div className={isPinned ? "" : "hover-reveal"}>
            <PinButton
              pinned={isPinned}
              onToggle={() => togglePinGoogleFamily(family.familyName)}
            />
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openGoogleFamily(family.familyName);
            }}
            className="btn-pill btn-pill-sm hover-reveal"
          >
            Open Info
          </button>
        </div>
      </div>
      <div
        style={{
          fontFamily: `'${family.familyName}', sans-serif`,
          fontSize: size,
          lineHeight: 1.15,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {text}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function GoogleGridCell({
  family,
  text,
  size,
  height,
  onActivate,
  onDeactivate,
}: {
  family: GoogleFamilyRow;
  text: string;
  size: number;
  height: number;
  onActivate: () => void;
  onDeactivate: () => void;
}) {
  const openGoogleFamily = useStore((s) => s.openGoogleFamily);
  const pinnedGoogleFamilies = useStore((s) => s.pinnedGoogleFamilies);
  const togglePinGoogleFamily = useStore((s) => s.togglePinGoogleFamily);
  const starredGoogleFamilies = useStore((s) => s.starredGoogleFamilies);
  const toggleStarGoogleFamily = useStore((s) => s.toggleStarGoogleFamily);
  const collections = useStore((s) => s.collections);
  const toggleGoogleFamilyInCollection = useStore(
    (s) => s.toggleGoogleFamilyInCollection,
  );
  const collectionsForGoogleFamily = useStore(
    (s) => s.collectionsForGoogleFamily,
  );
  const removeGoogleFamily = useStore((s) => s.removeGoogleFamily);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [existingIds, setExistingIds] = useState<Set<number>>(new Set());
  const isPinned = pinnedGoogleFamilies.includes(family.familyName);
  const isStarred = starredGoogleFamilies.has(family.familyName);
  useGoogleFontLink(family.familyName);

  const state = familyState(family.activeCount, family.variantCount);
  // Only check this family's own target. Parent targets (google-cat:*,
  // google-all) are pre-added and cleared at their own level — each level
  // flips independently when its own work completes. This is how a family
  // can show "active" while its category is still processing siblings.
  const loading = useActivationLoading([`google:${family.familyName}`]);

  const activationItems: MenuItem[] =
    state === "active"
      ? [
          {
            label: `Deactivate "${family.familyName}"`,
            onSelect: onDeactivate,
          },
        ]
      : state === "inactive"
        ? [
            {
              label: `Activate "${family.familyName}"`,
              onSelect: onActivate,
            },
          ]
        : [
            {
              label: "Activate remaining styles",
              onSelect: onActivate,
            },
            {
              label: `Deactivate "${family.familyName}"`,
              onSelect: onDeactivate,
            },
          ];
  const menuItems: MenuItem[] = [
    ...activationItems,
    { separator: true, label: "" },
    {
      label: "Open family info",
      onSelect: () => openGoogleFamily(family.familyName),
    },
    ...buildAddToCollectionItems({
      collections,
      existingCollectionIds: existingIds,
      onToggle: (collectionId, c) =>
        toggleGoogleFamilyInCollection(collectionId, family.familyName, c.name),
    }),
    { separator: true, label: "" },
    {
      label: "Remove from PC",
      destructive: true,
      onSelect: () => removeGoogleFamily(family.familyName),
    },
  ];

  return (
    <div
      className="hover-reveal-parent relative border border-black/10 dark:border-white/10 rounded-lg p-3 flex flex-col gap-2 cursor-pointer overflow-hidden min-w-0 hover:border-current"
      style={{ height }}
      onClick={() => openGoogleFamily(family.familyName)}
      onContextMenu={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const list = await collectionsForGoogleFamily(family.familyName);
        setExistingIds(new Set(list.map((c) => c.id)));
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div
        className="flex items-center gap-2 text-xs min-w-0"
        style={{ opacity: 0.6 }}
      >
        <ActivationToggle
          state={state}
          loading={loading}
          size={12}
          onToggle={(activate) => {
            if (activate) onActivate();
            else onDeactivate();
          }}
        />
        <span className="truncate flex-1">{family.familyName}</span>
        <span className="flex items-center gap-1.5 shrink-0">
          <span className={isStarred ? "" : "hover-reveal"}>
            <StarButton
              starred={isStarred}
              onToggle={() => toggleStarGoogleFamily(family.familyName)}
            />
          </span>
          <span className={isPinned ? "" : "hover-reveal"}>
            <PinButton
              pinned={isPinned}
              onToggle={() => togglePinGoogleFamily(family.familyName)}
            />
          </span>
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden flex items-center">
        <div
          style={{
            width: "100%",
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
            fontFamily: `'${family.familyName}', sans-serif`,
            fontSize: size,
            lineHeight: 1.15,
          }}
        >
          {text}
        </div>
      </div>
      <div
        className="text-[10px] truncate"
        style={{ opacity: 0.4 }}
      >
        {family.variantCount} style{family.variantCount === 1 ? "" : "s"} ·{" "}
        <span className="uppercase tracking-wider">Google</span> ·{" "}
        <span className="uppercase tracking-wider">{family.category}</span>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
