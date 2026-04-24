import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { FolderTreeNode } from "./FolderTreeNode";
import { ThemeToggle } from "./ThemeToggle";
import { SettingsToggle } from "./SettingsToggle";
import { CollectionsSection } from "./CollectionsSection";
import {
  ActivationToggle,
  familyState,
  useActivationLoading,
} from "./ActivationToggle";
import { ContextMenu, type MenuItem } from "./ContextMenu";

export function Sidebar() {
  const stats = useStore((s) => s.stats);
  const folderTrees = useStore((s) => s.folderTrees);
  const pickAndScan = useStore((s) => s.pickAndScan);
  const scanning = useStore((s) => s.scanning);
  const selectedFolder = useStore((s) => s.selectedFolder);
  const selectFolder = useStore((s) => s.selectFolder);
  const libraryFilter = useStore((s) => s.libraryFilter);
  const setLibraryFilter = useStore((s) => s.setLibraryFilter);
  const families = useStore((s) => s.families);
  const showGoogleFonts = useStore((s) => s.showGoogleFonts);
  const setShowGoogleFonts = useStore((s) => s.setShowGoogleFonts);
  const selectedCollection = useStore((s) => s.selectedCollection);
  const selectCollection = useStore((s) => s.selectCollection);
  const starredGoogleFamilies = useStore((s) => s.starredGoogleFamilies);
  const googleFamilies = useStore((s) => s.googleFamilies);

  const { starredFamilies, activeFamilies } = useMemo(() => {
    let starred = 0;
    let active = 0;
    for (const f of families) {
      if (f.starredCount > 0) starred++;
      if (f.activeCount > 0) active++;
    }
    // Sidebar counts local + Google starred together so users see a single
    // truthful number regardless of which source the font came from.
    starred += starredGoogleFamilies.size;
    for (const g of googleFamilies) {
      if (g.activeCount > 0) active++;
    }
    return { starredFamilies: starred, activeFamilies: active };
  }, [families, starredGoogleFamilies, googleFamilies]);

  return (
    <aside className="w-64 shrink-0 bg-[var(--color-surface)] flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <Section
          title="Library"
          tooltip="Quick filters for your whole font library. Starred = fonts you've favourited. Active = fonts currently loaded into Windows."
        >
          <Row
            label="All Fonts"
            count={stats.families}
            active={
              libraryFilter === "all" &&
              selectedFolder === null &&
              selectedCollection === null &&
              !showGoogleFonts
            }
            onClick={() => {
              setLibraryFilter("all");
              selectFolder(null);
              selectCollection(null);
              setShowGoogleFonts(false);
            }}
          />
          <Row
            label="Starred"
            count={starredFamilies}
            active={libraryFilter === "starred"}
            onClick={() =>
              setLibraryFilter(
                libraryFilter === "starred" ? "all" : "starred",
              )
            }
          />
          <Row
            label="Active"
            count={activeFamilies}
            active={libraryFilter === "active"}
            onClick={() =>
              setLibraryFilter(libraryFilter === "active" ? "all" : "active")
            }
          />
        </Section>

        <CollectionsSection />

        <GoogleFontsSidebarSection
          showGoogleFonts={showGoogleFonts}
          setShowGoogleFonts={setShowGoogleFonts}
        />

        <Section
          title="Folders"
          tooltip="Your local font folders. Click a folder to filter the list. The dot activates every font inside (including sub-folders). Drag and drop a folder onto the top bar to add. Right-click for per-folder actions."
          action={
            <button
              type="button"
              onClick={pickAndScan}
              disabled={scanning}
              className="btn-pill disabled:opacity-50"
              title="Add another folder (or drop one on the top bar)"
            >
              + Add
            </button>
          }
        >
          <div className="pt-0.5">
            {folderTrees.length === 0 ? (
              <div className="italic text-xs text-[var(--color-text-faint)] px-3 py-2">
                No folders yet
              </div>
            ) : (
              folderTrees.map((tree) => (
                <FolderTreeNode
                  key={tree.path}
                  node={tree}
                  depth={0}
                  isRoot={true}
                  ancestorLastFlags={[]}
                  isLastAmongSiblings={true}
                />
              ))
            )}
          </div>
        </Section>
      </div>
      <div className="shrink-0 p-2 flex items-center gap-1">
        <ThemeToggle />
        <SettingsToggle />
      </div>
    </aside>
  );
}

function GoogleFontsSidebarSection({
  showGoogleFonts,
  setShowGoogleFonts,
}: {
  showGoogleFonts: boolean;
  setShowGoogleFonts: (v: boolean) => void;
}) {
  const stats = useStore((s) => s.googleLibraryStats);
  const googleFamilies = useStore((s) => s.googleFamilies);
  const loadGoogleLibrary = useStore((s) => s.loadGoogleLibrary);
  const refreshGoogleCatalog = useStore((s) => s.refreshGoogleCatalog);
  const deactivateAllGoogle = useStore((s) => s.deactivateAllGoogle);
  const activateAllGoogle = useStore((s) => s.activateAllGoogle);
  const googleFontsLoading = useStore((s) => s.googleFontsLoading);
  const expandedGoogleFonts = useStore((s) => s.expandedGoogleFonts);
  const setExpandedGoogleFonts = useStore((s) => s.setExpandedGoogleFonts);
  const selectedGoogleCategory = useStore((s) => s.selectedGoogleCategory);
  const setSelectedGoogleCategory = useStore(
    (s) => s.setSelectedGoogleCategory,
  );

  // Hydrate stats on mount so the sidebar numbers stay honest.
  useEffect(() => {
    loadGoogleLibrary();
  }, [loadGoogleLibrary]);

  // Families with at least one active variant. Matches the semantics of
  // the per-category "active/total" counter — avoids the confusing case
  // where the top row said "340/1642" (variants/families) while the
  // Monospace row said "48/84" (families/families). Now both count families.
  const activeFamilyCount = useMemo(
    () => googleFamilies.reduce((n, f) => n + (f.activeCount > 0 ? 1 : 0), 0),
    [googleFamilies],
  );
  const state = familyState(activeFamilyCount, Math.max(1, stats.families));
  const hasCatalog = stats.families > 0;
  // Distinct category keys from the catalog — used to check whether ANY
  // category (or activate-all) is in-flight. Per Adria's hierarchy: the
  // Google Fonts top row shows loading while any of its descendants
  // (category / family / variant) has pending work. We cover that by
  // checking every category target here; family-level loading is
  // transitively covered because a family's google:family target is
  // only set as part of a parent operation, never standalone at this
  // level.
  const categoryKeys = useMemo(() => {
    const s = new Set<string>();
    for (const f of googleFamilies) s.add(f.category);
    return [...s];
  }, [googleFamilies]);
  const googleLoading = useActivationLoading([
    "google-all",
    ...categoryKeys.map((c) => `google-cat:${c}`),
  ]);
  const [googleMenu, setGoogleMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const googleMenuItems: MenuItem[] = useMemo(() => {
    if (!hasCatalog) return [];
    if (state === "active") {
      return [
        {
          label: "Deactivate all Google fonts",
          onSelect: () => deactivateAllGoogle(),
        },
      ];
    }
    if (state === "inactive") {
      return [
        {
          label: "Activate all Google fonts…",
          onSelect: () => activateAllGoogle(),
        },
      ];
    }
    return [
      {
        label: "Activate remaining Google fonts…",
        onSelect: () => activateAllGoogle(),
      },
      {
        label: "Deactivate all Google fonts",
        onSelect: () => deactivateAllGoogle(),
      },
    ];
  }, [hasCatalog, state, activateAllGoogle, deactivateAllGoogle]);

  // Group the catalog by Google's `category` field. Display uses a readable
  // form (e.g. "sans-serif" → "Sans Serif") but the selection key stays the
  // raw category so filtering matches the data straight from Google.
  const categories = useMemo(() => {
    const map = new Map<string, { total: number; active: number }>();
    for (const f of googleFamilies) {
      const key = f.category || "other";
      const entry = map.get(key) ?? { total: 0, active: 0 };
      entry.total += 1;
      if (f.activeCount > 0) entry.active += 1;
      map.set(key, entry);
    }
    return [...map.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.total - a.total);
  }, [googleFamilies]);

  return (
    <Section
      title="Google Fonts"
      tooltip="Browse Google's public fonts catalog. Clicking activate on a family downloads its files just-in-time and loads them into Windows. Deactivate = files are removed and no trace is left on your disk. Nothing is downloaded until you activate."
      action={
        <button
          type="button"
          onClick={() => refreshGoogleCatalog()}
          disabled={googleFontsLoading}
          className="btn-pill disabled:opacity-50"
          title="Fetch or refresh the Google Fonts catalog"
        >
          {hasCatalog ? "↻ Sync" : "Load"}
        </button>
      }
    >
      <SidebarRow
        label="Google Fonts"
        count={
          hasCatalog
            ? activeFamilyCount > 0
              ? `${activeFamilyCount}/${stats.families}`
              : stats.families.toLocaleString()
            : "—"
        }
        active={showGoogleFonts && selectedGoogleCategory === null}
        onClick={() => {
          // Clicking the main row always shows all Google fonts; the
          // chevron beside it is what toggles the category sub-list.
          setSelectedGoogleCategory(null);
          if (!showGoogleFonts) setShowGoogleFonts(true);
        }}
        onContextMenu={(e) => {
          if (googleMenuItems.length === 0) return;
          e.preventDefault();
          e.stopPropagation();
          setGoogleMenu({ x: e.clientX, y: e.clientY });
        }}
        toggle={
          hasCatalog ? (
            <ActivationToggle
              state={state}
              loading={googleLoading}
              size={12}
              onToggle={(activate) => {
                if (activate) activateAllGoogle();
                else deactivateAllGoogle();
              }}
            />
          ) : null
        }
        trailing={
          hasCatalog && categories.length > 0 ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpandedGoogleFonts(!expandedGoogleFonts);
              }}
              className="w-5 h-5 flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] cursor-pointer"
              aria-label={expandedGoogleFonts ? "Collapse" : "Expand"}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{
                  transition: "transform 150ms ease",
                  transform: expandedGoogleFonts
                    ? "rotate(90deg)"
                    : "rotate(0deg)",
                }}
              >
                <path d="M6 4 L10 8 L6 12" />
              </svg>
            </button>
          ) : null
        }
      />
      {expandedGoogleFonts &&
        categories.map((cat, idx) => (
          <GoogleCategoryRow
            key={cat.key}
            categoryKey={cat.key}
            total={cat.total}
            active={cat.active}
            selected={
              showGoogleFonts && selectedGoogleCategory === cat.key
            }
            isLast={idx === categories.length - 1}
            onClick={() => setSelectedGoogleCategory(cat.key)}
          />
        ))}
      {googleMenu && (
        <ContextMenu
          x={googleMenu.x}
          y={googleMenu.y}
          items={googleMenuItems}
          onClose={() => setGoogleMenu(null)}
        />
      )}
    </Section>
  );
}

function useDeactivateCategory(categoryKey: string) {
  const googleFamilies = useStore((s) => s.googleFamilies);
  const deactivateGoogleFamily = useStore((s) => s.deactivateGoogleFamily);
  return async () => {
    const targets = googleFamilies.filter(
      (g) => g.category === categoryKey && g.activeCount > 0,
    );
    // Mark the category group as deactivating so the category row's dot
    // shows a CCW loading arc for the duration of the batch.
    const store = useStore.getState();
    const cur = new Set(store.deactivatingTargets);
    cur.add(`google-cat:${categoryKey}`);
    useStore.setState({ deactivatingTargets: cur });
    try {
      for (const f of targets) {
        await deactivateGoogleFamily(f.familyName);
      }
    } finally {
      const after = new Set(useStore.getState().deactivatingTargets);
      after.delete(`google-cat:${categoryKey}`);
      useStore.setState({ deactivatingTargets: after });
    }
  };
}

function useToggleCategory(categoryKey: string) {
  const activateGoogleCategory = useStore((s) => s.activateGoogleCategory);
  const deactivateCategory = useDeactivateCategory(categoryKey);
  return (activate: boolean) => {
    if (activate) activateGoogleCategory(categoryKey);
    else deactivateCategory();
  };
}

function formatCategory(cat: string): string {
  if (cat === "sans-serif") return "Sans Serif";
  if (cat === "serif") return "Serif";
  if (cat === "display") return "Display";
  if (cat === "handwriting") return "Handwriting";
  if (cat === "monospace") return "Monospace";
  return cat.replace(/(^|-)([a-z])/g, (_, sep, ch) =>
    (sep ? " " : "") + ch.toUpperCase(),
  );
}

function GoogleCategoryRow({
  categoryKey,
  total,
  active,
  selected,
  isLast,
  onClick,
}: {
  categoryKey: string;
  total: number;
  active: number;
  selected: boolean;
  isLast: boolean;
  onClick: () => void;
}) {
  const toggleCategory = useToggleCategory(categoryKey);
  const activateGoogleCategory = useStore((s) => s.activateGoogleCategory);
  const deactivateGoogleCategoryFn = useDeactivateCategory(categoryKey);
  const state = familyState(active, Math.max(1, total));
  // Only check this category's own target. google-all clears at the end
  // of an activate-all, but each individual category clears the moment
  // its last family completes — so this category flips to its final
  // state independently of other categories / the whole-Google bucket.
  const loading = useActivationLoading([`google-cat:${categoryKey}`]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const label = formatCategory(categoryKey);
  const menuItems: MenuItem[] =
    state === "active"
      ? [
          {
            label: `Deactivate all "${label}"`,
            onSelect: () => deactivateGoogleCategoryFn(),
          },
        ]
      : state === "inactive"
        ? [
            {
              label: `Activate all "${label}"…`,
              onSelect: () => activateGoogleCategory(categoryKey),
            },
          ]
        : [
            {
              label: `Activate remaining "${label}"…`,
              onSelect: () => activateGoogleCategory(categoryKey),
            },
            {
              label: `Deactivate all "${label}"`,
              onSelect: () => deactivateGoogleCategoryFn(),
            },
          ];
  // Same structure as FolderTreeNode depth=1: guides column outside the
  // highlight pill so hover/selected indents with the category. Dot
  // reflects how many families in the category are active. Clicking it
  // activates ALL families in the category (after a confirm — that can
  // trigger many downloads) or deactivates all of them.
  return (
    <div
      className="group flex items-stretch cursor-pointer ml-2"
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="flex items-stretch shrink-0">
        <div className={`tree-guide turn ${!isLast ? "continue" : ""}`} />
      </div>
      <div
        className={`flex-1 min-w-0 flex items-center py-1.5 rounded-md text-sm transition-colors ${
          selected
            ? "bg-[var(--color-row-selected)] text-[var(--color-row-selected-text)]"
            : "text-[var(--color-text)] hover:bg-[var(--color-row-hover)]"
        }`}
        style={{ paddingLeft: 10, paddingRight: 10, marginRight: 8 }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 mr-1.5 w-3 flex items-center justify-center"
        >
          <ActivationToggle
            state={state}
            loading={loading}
            size={12}
            onToggle={toggleCategory}
          />
        </div>
        <span className="flex-1 truncate">{label}</span>
        <span className="text-xs text-[var(--color-text-faint)] tabular-nums ml-2">
          {active > 0 ? `${active}/${total}` : total.toLocaleString()}
        </span>
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

export function Section({
  title,
  action,
  tooltip,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  tooltip?: string;
  children: React.ReactNode;
}) {
  // Title's left edge aligns with the activation dot column beneath it:
  // aside_left + 8 (row ml-2) + 10 (pill pl) = 18 px. pr-2 puts the action
  // pill's right edge flush with the highlight box's right edge on rows.
  return (
    <div className="py-2">
      <div
        className="pr-2 py-1 flex items-center justify-between"
        style={{ paddingLeft: 18 }}
      >
        <span
          className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-faint)] font-medium cursor-help"
          title={tooltip}
        >
          {title}
        </span>
        {action}
      </div>
      {children}
    </div>
  );
}

function Row({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number | null;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <SidebarRow
      label={label}
      count={count !== null ? count.toLocaleString() : null}
      active={active}
      onClick={onClick}
    />
  );
}

/**
 * Shared row primitive used across Library, Google Fonts, and Collections so
 * vertical rhythm and column alignment stay consistent across sections.
 * `toggle` optionally displays an activation dot on the left.
 * A fixed-width trailing slot keeps counts in the same column as folder rows
 * (which render a chevron there). `indentLevel` pushes the highlight box to
 * the right so nested rows' hover/selected state matches their indent.
 */
export function SidebarRow({
  label,
  count,
  active,
  onClick,
  onContextMenu,
  toggle,
  trailing,
  indentLevel = 0,
}: {
  label: string;
  count: number | string | null;
  active?: boolean;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  toggle?: React.ReactNode;
  trailing?: React.ReactNode;
  indentLevel?: number;
}) {
  // 12px per depth level matches the tree-guide column width.
  const indentPx = indentLevel * 12;
  // Symmetric 10px padding on both sides of the highlight pill so content
  // has equal breathing room on left and right. Dot column aligns with
  // folder rows' dots (both at aside_left + 8 (ml) + 10 (pl) = 18). When
  // `toggle` is absent we also drop the 12px dot spacer so the label's
  // left edge sits on the same column as neighbouring rows' activation
  // dots (All Fonts/Starred/Active → dots).
  return (
    <div
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`flex items-center py-1.5 mr-2 rounded-md text-sm transition-colors ${
        onClick ? "cursor-pointer" : ""
      } ${
        active
          ? "bg-[var(--color-row-selected)] text-[var(--color-row-selected-text)]"
          : "text-[var(--color-text)] hover:bg-[var(--color-row-hover)]"
      }`}
      style={{
        marginLeft: 8 + indentPx,
        paddingLeft: 10,
        paddingRight: 10,
      }}
    >
      {toggle && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 mr-1.5 w-3 flex items-center justify-center"
        >
          {toggle}
        </div>
      )}
      <span className="flex-1 truncate">{label}</span>
      {count !== null && (
        <span className="text-xs text-[var(--color-text-faint)] tabular-nums ml-2">
          {count}
        </span>
      )}
      {trailing && (
        <div className="shrink-0 ml-1 w-5 flex items-center justify-center">
          {trailing}
        </div>
      )}
    </div>
  );
}
