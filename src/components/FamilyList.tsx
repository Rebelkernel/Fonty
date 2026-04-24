import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "../store";
import { FamilyRow } from "./FamilyRow";
import { FamilyGrid } from "./FamilyGrid";
import { GoogleFontsView, GoogleFontRow } from "./GoogleFontsView";

export function FamilyList() {
  const scanning = useStore((s) => s.scanning);
  const stats = useStore((s) => s.stats);
  const showGoogleFonts = useStore((s) => s.showGoogleFonts);
  const libraryFilter = useStore((s) => s.libraryFilter);
  const selectedCollection = useStore((s) => s.selectedCollection);
  const collectionGoogleFamilies = useStore((s) => s.collectionGoogleFamilies);
  const previewBgColor = useStore((s) => s.previewBgColor);
  const previewTextColor = useStore((s) => s.previewTextColor);

  if (showGoogleFonts) {
    return (
      <div
        className="h-full w-full overflow-hidden flex flex-col rounded-3xl transition-colors"
        style={{ backgroundColor: previewBgColor, color: previewTextColor }}
      >
        <GoogleFontsView />
      </div>
    );
  }

  if (scanning) {
    return <ScanProgressView />;
  }

  // "Starred" is source-agnostic — merge local and Google starred in one list
  // so users see every starred font regardless of provenance.
  if (libraryFilter === "starred") {
    return (
      <div
        className="h-full w-full overflow-hidden flex flex-col rounded-3xl transition-colors"
        style={{ backgroundColor: previewBgColor, color: previewTextColor }}
      >
        <MergedFamilyView mode="starred" />
      </div>
    );
  }

  // When viewing a collection that has Google family members, switch to the
  // merged view so Google families show up alongside the local ones.
  if (selectedCollection !== null && collectionGoogleFamilies.length > 0) {
    return (
      <div
        className="h-full w-full overflow-hidden flex flex-col rounded-3xl transition-colors"
        style={{ backgroundColor: previewBgColor, color: previewTextColor }}
      >
        <MergedFamilyView mode="collection" />
      </div>
    );
  }

  if (stats.families === 0) {
    return <EmptyState />;
  }

  return <VirtualizedList />;
}

function MergedFamilyView({ mode }: { mode: "starred" | "collection" }) {
  const families = useStore((s) => s.families);
  const googleFamilies = useStore((s) => s.googleFamilies);
  const starredGoogleFamilies = useStore((s) => s.starredGoogleFamilies);
  const collectionGoogleFamilies = useStore((s) => s.collectionGoogleFamilies);
  const selectedCollectionName = useStore((s) => s.selectedCollectionName);
  const searchQuery = useStore((s) => s.searchQuery);
  const previewText = useStore((s) => s.previewText);
  const previewSize = useStore((s) => s.previewSize);
  const activateGoogleFamily = useStore((s) => s.activateGoogleFamily);
  const deactivateGoogleFamily = useStore((s) => s.deactivateGoogleFamily);

  const { localList, googleList, headline } = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const matches = (s: string) => !q || s.toLowerCase().includes(q);
    if (mode === "starred") {
      const local = families.filter(
        (f) => f.starredCount > 0 && matches(f.familyName),
      );
      const google = googleFamilies.filter(
        (g) =>
          starredGoogleFamilies.has(g.familyName) && matches(g.familyName),
      );
      return { localList: local, googleList: google, headline: "Starred" };
    }
    // Collection mode — families already arrived pre-filtered for the
    // selected collection via loadFamilies(). Google side comes from
    // collection_google_families names; we resolve them to GoogleFamilyRow.
    const byName = new Map(
      googleFamilies.map((g) => [g.familyName, g] as const),
    );
    const google = collectionGoogleFamilies
      .map((n) => byName.get(n))
      .filter(
        (g): g is (typeof googleFamilies)[number] =>
          Boolean(g) && matches(g!.familyName),
      );
    const local = families.filter((f) => matches(f.familyName));
    return {
      localList: local,
      googleList: google,
      headline: selectedCollectionName ?? "Collection",
    };
  }, [
    mode,
    families,
    googleFamilies,
    starredGoogleFamilies,
    collectionGoogleFamilies,
    searchQuery,
    selectedCollectionName,
  ]);

  const total = localList.length + googleList.length;
  const rowHeight = Math.max(72, previewSize + 52);

  return (
    <>
      <div
        className="text-xs px-6 py-3 shrink-0 flex items-center gap-3 min-h-[36px]"
        style={{ color: "currentColor", opacity: 0.6 }}
      >
        <span className="text-sm font-medium" style={{ opacity: 1 }}>
          {headline}
        </span>
        <span>·</span>
        <span>
          {total.toLocaleString()} famil{total === 1 ? "y" : "ies"}
        </span>
        {searchQuery && <span>· matching "{searchQuery}"</span>}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {total === 0 && (
          <div
            className="h-full flex items-center justify-center text-xs px-6"
            style={{ opacity: 0.55 }}
          >
            {mode === "starred"
              ? "No starred fonts yet. Click the star on a font to add it."
              : "This collection is empty. Right-click a font in the list to add it."}
          </div>
        )}
        {localList.map((family) => (
          <div
            key={`local:${family.repId}`}
            style={{ height: rowHeight }}
          >
            <FamilyRow family={family} />
          </div>
        ))}
        {googleList.map((family) => (
          <div
            key={`google:${family.familyName}`}
            style={{ height: rowHeight }}
          >
            <GoogleFontRow
              family={family}
              text={previewText || "The quick brown fox"}
              size={previewSize}
              onActivate={() => activateGoogleFamily(family.familyName)}
              onDeactivate={() => deactivateGoogleFamily(family.familyName)}
            />
          </div>
        ))}
      </div>
    </>
  );
}

function VirtualizedList() {
  const families = useStore((s) => s.families);
  const searchQuery = useStore((s) => s.searchQuery);
  const previewSize = useStore((s) => s.previewSize);
  const previewBgColor = useStore((s) => s.previewBgColor);
  const previewTextColor = useStore((s) => s.previewTextColor);
  const viewMode = useStore((s) => s.viewMode);

  const libraryFilter = useStore((s) => s.libraryFilter);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let list = families;
    if (libraryFilter === "starred") {
      list = list.filter((f) => f.starredCount > 0);
    } else if (libraryFilter === "active") {
      list = list.filter((f) => f.activeCount > 0);
    }
    if (q) {
      list = list.filter((f) => f.familyName.toLowerCase().includes(q));
    }
    return list;
  }, [families, searchQuery, libraryFilter]);

  const rowHeight = Math.max(72, previewSize + 52);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  return (
    <div
      className="h-full w-full overflow-hidden flex flex-col rounded-3xl transition-colors"
      style={{ backgroundColor: previewBgColor, color: previewTextColor }}
    >
      <FilterBar count={filtered.length} searchQuery={searchQuery} />
      {viewMode === "grid" ? (
        <FamilyGrid families={filtered} />
      ) : (
          <div ref={parentRef} className="flex-1 min-h-0 overflow-auto">
            <div
              style={{
                height: virtualizer.getTotalSize(),
                position: "relative",
                width: "100%",
              }}
            >
              {virtualizer.getVirtualItems().map((v) => {
                const family = filtered[v.index];
                return (
                  <div
                    key={family.repId}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: v.size,
                      transform: `translateY(${v.start}px)`,
                    }}
                  >
                    <FamilyRow family={family} />
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}

function FilterBar({
  count,
  searchQuery,
}: {
  count: number;
  searchQuery: string;
}) {
  const selectedFolder = useStore((s) => s.selectedFolder);
  const selectFolder = useStore((s) => s.selectFolder);
  const selectedCollection = useStore((s) => s.selectedCollection);
  const selectedCollectionName = useStore((s) => s.selectedCollectionName);
  const selectCollection = useStore((s) => s.selectCollection);
  return (
    <div
      className="text-xs px-6 py-3 shrink-0 flex items-center gap-3 min-h-[36px]"
      style={{ color: "currentColor", opacity: 0.6 }}
    >
      {selectedCollection !== null && selectedCollectionName ? (
        <>
          <span className="text-sm font-medium" style={{ opacity: 1 }}>
            {selectedCollectionName}
          </span>
          <span>·</span>
          <span>
            {count.toLocaleString()} famil{count === 1 ? "y" : "ies"}
          </span>
          {searchQuery && (
            <>
              <span>·</span>
              <span>matching "{searchQuery}"</span>
            </>
          )}
          <button
            type="button"
            onClick={() => selectCollection(null)}
            className="hover:opacity-100"
            title="Clear collection filter"
          >
            ×
          </button>
        </>
      ) : (
        <>
          <span>
            {count.toLocaleString()} famil{count === 1 ? "y" : "ies"}
            {searchQuery ? ` matching "${searchQuery}"` : ""}
          </span>
          {selectedFolder && (
            <span className="flex items-center gap-1.5">
              <span>in</span>
              <span
                className="truncate max-w-md"
                title={selectedFolder}
                style={{ opacity: 0.8 }}
              >
                {selectedFolder}
              </span>
              <button
                type="button"
                onClick={() => selectFolder(null)}
                className="hover:opacity-100"
                title="Clear folder filter"
              >
                ×
              </button>
            </span>
          )}
        </>
      )}
    </div>
  );
}

function EmptyState() {
  const pickAndScan = useStore((s) => s.pickAndScan);
  return (
    <div className="h-full w-full flex items-center justify-center">
      <div className="text-center max-w-md">
        <div className="text-lg font-medium mb-2">No font library loaded</div>
        <div className="text-sm text-[var(--color-text-dim)] mb-6">
          Point FONTY at a folder on your PC to scan it (and all sub-folders)
          for fonts. Nothing gets installed until you explicitly activate it.
        </div>
        <button
          type="button"
          onClick={pickAndScan}
          className="px-4 py-2 rounded text-sm bg-[var(--color-accent)] text-[var(--color-bg)] font-medium hover:bg-[var(--color-accent-hover)]"
        >
          Pick a font folder…
        </button>
      </div>
    </div>
  );
}

function ScanProgressView() {
  const progress = useStore((s) => s.progress);

  const phase = progress?.phase ?? "walking";
  const phaseLabel: Record<string, string> = {
    walking: "Looking for font files…",
    parsing: "Reading font metadata",
    saving: "Saving to local cache",
    done: "Done",
  };

  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.processed / progress.total) * 100))
      : 0;

  return (
    <div className="h-full w-full flex items-center justify-center">
      <div className="w-[min(520px,80%)]">
        <div className="text-sm font-medium mb-1">{phaseLabel[phase]}</div>
        <div className="text-xs text-[var(--color-text-faint)] mb-3">
          {progress && progress.total > 0
            ? `${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()} files`
            : "Scanning folder tree…"}
          {progress && progress.errors > 0
            ? ` · ${progress.errors.toLocaleString()} skipped`
            : ""}
        </div>
        <div className="h-1.5 w-full bg-[var(--color-surface-2)] rounded overflow-hidden">
          <div
            className="h-full bg-[var(--color-accent)] transition-[width] duration-150"
            style={{
              width: phase === "walking" ? "30%" : `${pct}%`,
            }}
          />
        </div>
        {progress?.current && (
          <div
            className="text-[10px] text-[var(--color-text-faint)] mt-3 truncate"
            title={progress.current}
          >
            {progress.current}
          </div>
        )}
      </div>
    </div>
  );
}
