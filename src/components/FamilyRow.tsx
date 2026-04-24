import { useState } from "react";
import type { FamilySummary } from "../types";
import { FontPreview } from "./FontPreview";
import { useStore } from "../store";
import {
  ActivationToggle,
  familyState,
  useActivationLoading,
} from "./ActivationToggle";
import { StarButton } from "./StarButton";
import { PinButton } from "./PinButton";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { buildAddToCollectionItems } from "./collectionMenuItems";

export function FamilyRow({ family }: { family: FamilySummary }) {
  const previewText = useStore((s) => s.previewText);
  const previewSize = useStore((s) => s.previewSize);
  const openFamily = useStore((s) => s.openFamily);
  const selectedFamily = useStore((s) => s.selectedFamily);
  const activateFamily = useStore((s) => s.activateFamily);
  const deactivateFamily = useStore((s) => s.deactivateFamily);
  const starFamily = useStore((s) => s.starFamily);
  const unstarFamily = useStore((s) => s.unstarFamily);
  const pinnedFamilyNames = useStore((s) => s.pinnedFamilyNames);
  const togglePin = useStore((s) => s.togglePin);
  const collections = useStore((s) => s.collections);
  const toggleFamilyInCollection = useStore(
    (s) => s.toggleFamilyInCollection,
  );
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const isSelected = selectedFamily === family.familyName;
  const state = familyState(family.activeCount, family.styles);
  const loading = useActivationLoading([`family:${family.familyName}`]);
  const isStarred = family.starredCount > 0;
  const isPinned = pinnedFamilyNames.includes(family.familyName);
  const fmt = family.format.toUpperCase();

  const activationItems: MenuItem[] =
    state === "active"
      ? [
          {
            label: `Deactivate "${family.familyName}"`,
            onSelect: () => deactivateFamily(family.familyName),
          },
        ]
      : state === "inactive"
        ? [
            {
              label: `Activate "${family.familyName}"`,
              onSelect: () => activateFamily(family.familyName),
            },
          ]
        : [
            {
              label: "Activate remaining styles",
              onSelect: () => activateFamily(family.familyName),
            },
            {
              label: `Deactivate "${family.familyName}"`,
              onSelect: () => deactivateFamily(family.familyName),
            },
          ];
  const menuItems: MenuItem[] = [
    ...activationItems,
    { separator: true, label: "" },
    {
      label: "Open family info",
      onSelect: () => openFamily(family.familyName),
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
      existingCollectionIds: new Set(
        collections
          .filter((c) => family.collectionNames.includes(c.name))
          .map((c) => c.id),
      ),
      onToggle: (collectionId, c) =>
        toggleFamilyInCollection(collectionId, family.familyName, c.name),
    }),
  ];

  return (
    <div
      className={`hover-reveal-parent relative h-full px-6 py-3 flex flex-col gap-1.5 cursor-pointer ${
        isSelected ? "bg-black/5 dark:bg-white/5" : ""
      }`}
      onClick={() => openFamily(family.familyName)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
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
            if (activate) activateFamily(family.familyName);
            else deactivateFamily(family.familyName);
          }}
        />
        <span className="truncate">{family.familyName}</span>
        <span>·</span>
        <span>
          {family.activeCount > 0
            ? `${family.activeCount}/${family.styles}`
            : family.styles}{" "}
          styles
        </span>
        <span>·</span>
        <span className="uppercase tracking-wider">{fmt}</span>
        {family.collectionNames.length > 0 && (
          <>
            <span>·</span>
            <span className="flex items-center gap-1 flex-wrap">
              {family.collectionNames.map((name) => (
                <span
                  key={name}
                  className="btn-pill btn-pill-sm"
                  style={{ textTransform: "none" }}
                  title={`In collection: ${name}`}
                >
                  {name}
                </span>
              ))}
            </span>
          </>
        )}

        <div className="flex-1" />

        {/* Icons: star/pin stay visible when active, otherwise only on hover.
            Open Info is always hover-revealed. */}
        <div className="flex items-center gap-2 ml-2">
          <div className={isStarred ? "" : "hover-reveal"}>
            <StarButton
              starred={isStarred}
              onToggle={() => {
                if (isStarred) unstarFamily(family.familyName);
                else starFamily(family.familyName);
              }}
            />
          </div>
          <div className={isPinned ? "" : "hover-reveal"}>
            <PinButton
              pinned={isPinned}
              onToggle={() => togglePin(family.familyName)}
            />
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openFamily(family.familyName);
            }}
            className="btn-pill btn-pill-sm hover-reveal"
            title="Open family info"
          >
            Open Info
          </button>
        </div>
      </div>
      <div className="min-w-0">
        <FontPreview
          repId={family.repId}
          filePath={family.filePath}
          ttcIndex={family.ttcIndex}
          text={previewText || "The quick brown fox"}
          size={previewSize}
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
    </div>
  );
}
