import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "../store";
import { FontPreview } from "./FontPreview";
import { ActivationToggle, familyState } from "./ActivationToggle";
import { StarButton } from "./StarButton";
import { PinButton } from "./PinButton";
import type { FamilySummary } from "../types";

// Wider target so columns are slightly fewer and cards feel less cramped.
const CELL_TARGET_WIDTH = 340;
const CELL_GAP = 10;
const CONTAINER_PADDING = 16;
// Spacing around the preview inside a card (metadata above + footer below).
const CELL_CHROME = 88;

export function FamilyGrid({ families }: { families: FamilySummary[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const previewSize = useStore((s) => s.previewSize);

  useEffect(() => {
    if (!parentRef.current) return;
    const ro = new ResizeObserver(() => {
      if (parentRef.current) setWidth(parentRef.current.clientWidth);
    });
    ro.observe(parentRef.current);
    setWidth(parentRef.current.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Clamp the preview size so cards stay readable without growing huge.
  const cellPreviewSize = Math.min(previewSize, 96);
  const cellHeight = Math.max(140, Math.round(cellPreviewSize * 1.6 + CELL_CHROME));
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
                <GridCell
                  key={f.repId}
                  family={f}
                  height={cellHeight}
                  previewSize={cellPreviewSize}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GridCell({
  family,
  height,
  previewSize,
}: {
  family: FamilySummary;
  height: number;
  previewSize: number;
}) {
  const previewText = useStore((s) => s.previewText);
  const openFamily = useStore((s) => s.openFamily);
  const activateFamily = useStore((s) => s.activateFamily);
  const deactivateFamily = useStore((s) => s.deactivateFamily);
  const starFamily = useStore((s) => s.starFamily);
  const unstarFamily = useStore((s) => s.unstarFamily);
  const togglePin = useStore((s) => s.togglePin);
  const pinnedFamilyNames = useStore((s) => s.pinnedFamilyNames);

  const state = familyState(family.activeCount, family.styles);
  const isStarred = family.starredCount > 0;
  const isPinned = pinnedFamilyNames.includes(family.familyName);

  return (
    <div
      className="hover-reveal-parent relative border border-black/10 dark:border-white/10 rounded-lg p-3 flex flex-col gap-2 cursor-pointer overflow-hidden min-w-0 hover:border-current"
      style={{ height }}
      onClick={() => openFamily(family.familyName)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(
          "application/fonty-family",
          family.familyName,
        );
        e.dataTransfer.effectAllowed = "copy";
      }}
    >
      <div
        className="flex items-center gap-2 text-xs min-w-0"
        style={{ opacity: 0.6 }}
      >
        <ActivationToggle
          state={state}
          size={12}
          onToggle={(activate) => {
            if (activate) activateFamily(family.familyName);
            else deactivateFamily(family.familyName);
          }}
        />
        <span className="truncate flex-1">{family.familyName}</span>
        <span className="flex items-center gap-1.5 shrink-0">
          <span className={isStarred ? "" : "hover-reveal"}>
            <StarButton
              starred={isStarred}
              onToggle={() => {
                if (isStarred) unstarFamily(family.familyName);
                else starFamily(family.familyName);
              }}
            />
          </span>
          <span className={isPinned ? "" : "hover-reveal"}>
            <PinButton
              pinned={isPinned}
              onToggle={() => togglePin(family.familyName)}
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
          }}
        >
          <FontPreview
            repId={family.repId}
            filePath={family.filePath}
            ttcIndex={family.ttcIndex}
            text={previewText || "Aa Bb Cc"}
            size={previewSize}
          />
        </div>
      </div>
      <div
        className="text-[10px] truncate"
        style={{ opacity: 0.4 }}
        title={family.filePath}
      >
        {family.styles} style{family.styles === 1 ? "" : "s"} ·{" "}
        {family.format.toUpperCase()}
      </div>
    </div>
  );
}
