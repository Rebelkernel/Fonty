import { useEffect, useState } from "react";
import { useStore } from "../store";
import { ActivationToggle, useActivationLoading } from "./ActivationToggle";
import { StarButton } from "./StarButton";
import { PinButton } from "./PinButton";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { buildAddToCollectionItems } from "./collectionMenuItems";
import { TrayExpandToggle } from "./TrayExpandToggle";
import { useTrayExpansion } from "./useTrayExpansion";
import type { Collection } from "../types";

function variantLabel(variant: string): string {
  if (variant === "regular") return "Regular";
  if (variant === "italic") return "Italic";
  const m = variant.match(/^(\d+)(italic)?$/);
  if (!m) return variant;
  const weight = parseInt(m[1], 10);
  const italic = !!m[2];
  const weightLabel =
    {
      100: "Thin",
      200: "ExtraLight",
      300: "Light",
      400: "Regular",
      500: "Medium",
      600: "SemiBold",
      700: "Bold",
      800: "ExtraBold",
      900: "Black",
    }[weight] ?? String(weight);
  return italic ? `${weightLabel} Italic` : weightLabel;
}

function parseVariant(variant: string): { weight: number; italic: boolean } {
  if (variant === "regular") return { weight: 400, italic: false };
  if (variant === "italic") return { weight: 400, italic: true };
  const m = variant.match(/^(\d+)(italic)?$/);
  if (!m) return { weight: 400, italic: false };
  return { weight: parseInt(m[1], 10), italic: !!m[2] };
}

export function GoogleFamilyDetail() {
  const selectedGoogleFamily = useStore((s) => s.selectedGoogleFamily);
  const googleFamilies = useStore((s) => s.googleFamilies);
  const close = useStore((s) => s.closeGoogleFamily);
  const previewText = useStore((s) => s.previewText);
  const previewSize = useStore((s) => s.previewSize);
  const previewBgColor = useStore((s) => s.previewBgColor);
  const previewTextColor = useStore((s) => s.previewTextColor);
  const activateGoogleVariant = useStore((s) => s.activateGoogleVariant);
  const deactivateGoogleVariant = useStore((s) => s.deactivateGoogleVariant);
  const googleActiveVariants = useStore((s) => s.googleActiveVariants);
  const loadGoogleActiveVariants = useStore((s) => s.loadGoogleActiveVariants);
  const googleNamedInstances = useStore((s) => s.googleNamedInstances);
  const loadGoogleNamedInstances = useStore((s) => s.loadGoogleNamedInstances);
  const trayExpanded = useStore((s) => s.trayExpanded);
  const toggleTrayExpanded = useStore((s) => s.toggleTrayExpanded);
  const expansion = useTrayExpansion(trayExpanded);
  const starredGoogleVariants = useStore((s) => s.starredGoogleVariants);
  const toggleStarGoogleVariant = useStore((s) => s.toggleStarGoogleVariant);
  const pinnedGoogleVariants = useStore((s) => s.pinnedGoogleVariants);
  const togglePinGoogleVariant = useStore((s) => s.togglePinGoogleVariant);
  const collectionsForGoogleFamily = useStore(
    (s) => s.collectionsForGoogleFamily,
  );
  const removeGoogleFamilyFromCollection = useStore(
    (s) => s.removeGoogleFamilyFromCollection,
  );
  const collections = useStore((s) => s.collections);
  const toggleGoogleVariantInCollection = useStore(
    (s) => s.toggleGoogleVariantInCollection,
  );
  const collectionsForGoogleVariant = useStore(
    (s) => s.collectionsForGoogleVariant,
  );
  const [variantExistingIds, setVariantExistingIds] = useState<Set<number>>(
    new Set(),
  );
  const selectCollection = useStore((s) => s.selectCollection);
  const [familyCollections, setFamilyCollections] = useState<Collection[]>([]);
  const [variantMenu, setVariantMenu] = useState<{
    x: number;
    y: number;
    variant: string;
  } | null>(null);

  useEffect(() => {
    if (!selectedGoogleFamily) {
      setFamilyCollections([]);
      return;
    }
    collectionsForGoogleFamily(selectedGoogleFamily).then(setFamilyCollections);
  }, [selectedGoogleFamily, collectionsForGoogleFamily]);

  // Keep a Google-CSS <link> in <head> so every preview below renders.
  useEffect(() => {
    if (!selectedGoogleFamily) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
      selectedGoogleFamily,
    )}:ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,100;1,200;1,300;1,400;1,500;1,600;1,700;1,800;1,900&display=block`;
    link.setAttribute("data-google-font-detail", selectedGoogleFamily);
    document.head.appendChild(link);
    loadGoogleActiveVariants(selectedGoogleFamily);
    // Also pull named instances from the cached VF file (if any). Empty for
    // non-VF families or families that haven't been downloaded yet; the
    // latter case resolves itself once the user activates the family.
    loadGoogleNamedInstances(selectedGoogleFamily);
    return () => {
      link.remove();
    };
  }, [
    selectedGoogleFamily,
    loadGoogleActiveVariants,
    loadGoogleNamedInstances,
  ]);

  // Re-fetch named instances whenever the active-variant set for this
  // family changes — the first activation is when the VF file lands on
  // disk, so that's when the list becomes readable. Keeps the tray honest
  // without polling.
  useEffect(() => {
    if (!selectedGoogleFamily) return;
    loadGoogleNamedInstances(selectedGoogleFamily);
  }, [
    selectedGoogleFamily,
    loadGoogleNamedInstances,
    googleActiveVariants[selectedGoogleFamily ?? ""]?.size,
  ]);

  if (!selectedGoogleFamily) return null;
  const data = googleFamilies.find(
    (f) => f.familyName === selectedGoogleFamily,
  );

  // No upper clamp — the slider's own 8-200 range governs. The old
  // 64 px cap made the tray's preview stop growing halfway through
  // the slider.
  const displaySize = Math.max(14, previewSize);

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
        style={{ borderBottom: "1px solid rgba(128,128,128,0.15)" }}
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
            {selectedGoogleFamily}
          </div>
          <div className="text-xs mt-0.5" style={{ opacity: 0.45 }}>
            {data
              ? `${data.variants.length} style${data.variants.length === 1 ? "" : "s"} · `
              : "Loading styles… "}
            <span className="uppercase tracking-wider">Google</span>
            {data && (
              <>
                <span> · </span>
                <span className="uppercase tracking-wider">
                  {data.category}
                </span>
              </>
            )}
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
                      await removeGoogleFamilyFromCollection(
                        c.id,
                        selectedGoogleFamily,
                      );
                      setFamilyCollections((prev) =>
                        prev.filter((p) => p.id !== c.id),
                      );
                    }}
                    title={`Remove "${selectedGoogleFamily}" from "${c.name}"`}
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
          onClick={close}
          className="text-lg leading-none px-2 py-1 rounded hover:bg-black/5 dark:hover:bg-white/5 opacity-60 hover:opacity-100"
          title="Close"
          aria-label="Close"
        >
          ×
        </button>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {!data && (
          <div className="p-5 text-xs" style={{ opacity: 0.5 }}>
            Variant info not in cache. Click "↻ Sync" in the Google Fonts
            sidebar to refresh.
          </div>
        )}
        <ul>
          {data?.variants.map((v) => {
            const { weight, italic } = parseVariant(v);
            const activeVariantsForFamily =
              googleActiveVariants[selectedGoogleFamily] ?? new Set<string>();
            const isActive = activeVariantsForFamily.has(v);
            const isVariantStarred =
              starredGoogleVariants[selectedGoogleFamily]?.has(v) ?? false;
            const isVariantPinned = pinnedGoogleVariants.some(
              (p) => p.family === selectedGoogleFamily && p.variant === v,
            );
            return (
              <li
                key={v}
                className="hover-reveal-parent px-5 py-3 hover:bg-black/5 dark:hover:bg-white/5"
                onContextMenu={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (selectedGoogleFamily) {
                    const list = await collectionsForGoogleVariant(
                      selectedGoogleFamily,
                      v,
                    );
                    setVariantExistingIds(
                      new Set(list.map((c) => c.id)),
                    );
                  }
                  setVariantMenu({ x: e.clientX, y: e.clientY, variant: v });
                }}
              >
                <div
                  className="text-xs mb-1 flex items-center gap-1.5"
                  style={{ opacity: 0.6 }}
                >
                  <VariantActivationToggle
                    isActive={isActive}
                    disabled={false}
                    family={selectedGoogleFamily}
                    variant={v}
                    onToggle={(activate) => {
                      if (activate) {
                        activateGoogleVariant(selectedGoogleFamily, v);
                      } else {
                        deactivateGoogleVariant(selectedGoogleFamily, v);
                      }
                    }}
                  />
                  <span className="truncate">{variantLabel(v)}</span>
                  <span>·</span>
                  <span>{weight}</span>
                  {italic && <span className="italic">italic</span>}
                  <div className="flex-1" />
                  <span className={isVariantStarred ? "" : "hover-reveal"}>
                    <StarButton
                      starred={isVariantStarred}
                      onToggle={() =>
                        toggleStarGoogleVariant(selectedGoogleFamily, v)
                      }
                    />
                  </span>
                  <span className={isVariantPinned ? "" : "hover-reveal"}>
                    <PinButton
                      pinned={isVariantPinned}
                      onToggle={() =>
                        togglePinGoogleVariant(selectedGoogleFamily, v)
                      }
                    />
                  </span>
                </div>
                <div
                  style={{
                    fontFamily: `'${selectedGoogleFamily}', sans-serif`,
                    fontWeight: weight,
                    fontStyle: italic ? "italic" : "normal",
                    fontSize: displaySize,
                    lineHeight: 1.4,
                    paddingBottom: "0.12em",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {previewText || "The quick brown fox"}
                </div>
              </li>
            );
          })}
        </ul>
        {selectedGoogleFamily &&
          (googleNamedInstances[selectedGoogleFamily]?.length ?? 0) > 0 && (
            <NamedInstancesSection
              family={selectedGoogleFamily}
              instances={googleNamedInstances[selectedGoogleFamily] ?? []}
              previewText={previewText || "The quick brown fox"}
              displaySize={displaySize}
            />
          )}
      </div>
      {variantMenu && selectedGoogleFamily && (
        <ContextMenu
          x={variantMenu.x}
          y={variantMenu.y}
          items={[
            {
              label: (() => {
                const active =
                  (
                    googleActiveVariants[selectedGoogleFamily] ??
                    new Set<string>()
                  ).has(variantMenu.variant);
                const styleLabel = variantMenu.variant;
                return active
                  ? `Deactivate "${styleLabel}"`
                  : `Activate "${styleLabel}"`;
              })(),
              onSelect: () => {
                const active =
                  (
                    googleActiveVariants[selectedGoogleFamily] ??
                    new Set<string>()
                  ).has(variantMenu.variant);
                if (active) {
                  deactivateGoogleVariant(
                    selectedGoogleFamily,
                    variantMenu.variant,
                  );
                } else {
                  activateGoogleVariant(
                    selectedGoogleFamily,
                    variantMenu.variant,
                  );
                }
              },
            },
            { separator: true, label: "" },
            {
              label: "Copy style name",
              onSelect: () =>
                navigator.clipboard
                  .writeText(`${selectedGoogleFamily} ${variantMenu.variant}`)
                  .catch(() => {}),
            },
            ...buildAddToCollectionItems({
              collections,
              existingCollectionIds: variantExistingIds,
              onToggle: (collectionId, c) =>
                toggleGoogleVariantInCollection(
                  collectionId,
                  selectedGoogleFamily,
                  variantMenu.variant,
                  c.name,
                ),
            }),
          ] as MenuItem[]}
          onClose={() => setVariantMenu(null)}
        />
      )}
    </aside>
  );
}

function VariantActivationToggle({
  isActive,
  disabled,
  family,
  variant,
  onToggle,
}: {
  isActive: boolean;
  disabled: boolean;
  family: string;
  variant: string;
  onToggle: (next: boolean) => void;
}) {
  // Only check the per-variant target. Previously this also fell back to
  // `google:${family}` and `"google-all"`, which meant variants couldn't
  // flip to active individually during a family-level activate — they'd
  // all stay spinning until the parent target cleared. The store's
  // streaming progress listener + pre-added per-variant targets now drive
  // individual variant dots: the target lands when activation starts and
  // clears when that specific variant is registered, so each row lights
  // up the moment its TTF hits Windows.
  const loading = useActivationLoading([
    `google-variant:${family}:${variant}`,
  ]);
  return (
    <ActivationToggle
      state={isActive ? "active" : "inactive"}
      disabled={disabled}
      loading={loading}
      onToggle={onToggle}
    />
  );
}

/** Non-catalog named instances of a variable font. Windows surfaces these
 *  (Inconsolata Condensed, Bold Wide, etc.) once the VF is loaded — they're
 *  not individually toggleable, they ride along with the family. Rendered
 *  via CSS `font-variation-settings` so the preview matches what Word shows. */
function NamedInstancesSection({
  family,
  instances,
  previewText,
  displaySize,
}: {
  family: string;
  instances: import("../types").GoogleNamedInstance[];
  previewText: string;
  displaySize: number;
}) {
  // Axis-coord subtitle, e.g. "wdth 75 · wght 700".
  const coordLabel = (axes: [string, number][]) =>
    axes.map(([tag, v]) => `${tag} ${formatAxisVal(v)}`).join(" · ");
  // font-variation-settings string.
  const variationSettings = (axes: [string, number][]) =>
    axes.map(([tag, v]) => `'${tag}' ${v}`).join(", ");

  return (
    <div>
      <div
        className="px-5 pt-4 pb-2 text-[10px] uppercase tracking-wider"
        style={{ opacity: 0.45 }}
      >
        Variable-font styles
        <span className="ml-2 normal-case tracking-normal" style={{ opacity: 0.7 }}>
          · {instances.length} more exposed to Word/Affinity when this family
          is active
        </span>
      </div>
      <ul>
        {instances.map((inst, i) => (
          <li
            key={`${inst.name}-${i}`}
            className="hover-reveal-parent px-5 py-3 hover:bg-black/5 dark:hover:bg-white/5"
          >
            <div
              className="text-xs mb-1 flex items-center gap-1.5"
              style={{ opacity: 0.6 }}
            >
              <span className="truncate">{inst.name}</span>
              {inst.axes.length > 0 && (
                <>
                  <span>·</span>
                  <span className="truncate text-[10px]">
                    {coordLabel(inst.axes)}
                  </span>
                </>
              )}
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard
                    .writeText(`${family} ${inst.name}`)
                    .catch(() => {});
                }}
                className="hover-reveal btn-pill btn-pill-sm"
                title="Copy style name"
              >
                Copy name
              </button>
            </div>
            <div
              style={{
                fontFamily: `'${family}', sans-serif`,
                fontVariationSettings: variationSettings(inst.axes),
                fontSize: displaySize,
                lineHeight: 1.4,
                paddingBottom: "0.12em",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {previewText}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatAxisVal(v: number): string {
  if (Math.abs(v - Math.round(v)) < 0.01) return String(Math.round(v));
  return v.toFixed(1);
}
