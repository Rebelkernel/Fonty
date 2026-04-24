import { useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import type { FolderNode } from "../types";
import { useStore } from "../store";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import {
  ActivationToggle,
  familyState,
  useActivationLoading,
} from "./ActivationToggle";

export function FolderTreeNode({
  node,
  depth,
  isRoot,
  ancestorLastFlags = [],
  isLastAmongSiblings = true,
}: {
  node: FolderNode;
  depth: number;
  isRoot: boolean;
  /** For each ancestor depth, true if that ancestor was the last child of its parent */
  ancestorLastFlags?: boolean[];
  /** Is *this* node the last among its siblings? */
  isLastAmongSiblings?: boolean;
}) {
  const {
    expandedFolders,
    toggleFolder,
    selectedFolder,
    selectFolder,
    removeRoot,
    activateFolder,
    deactivateFolder,
  } = useStore();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const expanded = expandedFolders.has(node.path);
  const selected = selectedFolder === node.path;
  const hasChildren = node.children.length > 0;
  // Tri-state activation uses font files so partial family activation still
  // shows "mixed"; the counter shown to the user is families (matching the
  // main card's "N families" and the sidebar's "All Fonts").
  const state = familyState(node.activeCount, node.totalCount);
  const totalFamilies = node.familyCount;
  const activeFamilies = node.activeFamilyCount;
  const loading = useActivationLoading([`folder:${node.path}`]);

  const activationItems: MenuItem[] =
    node.totalCount === 0
      ? []
      : state === "active"
        ? [
            {
              label: `Deactivate "${node.name}"`,
              onSelect: () => deactivateFolder(node.path),
            },
          ]
        : state === "inactive"
          ? [
              {
                label: `Activate "${node.name}"`,
                onSelect: () => activateFolder(node.path),
              },
            ]
          : [
              {
                label: `Activate remaining in "${node.name}"`,
                onSelect: () => activateFolder(node.path),
              },
              {
                label: `Deactivate all in "${node.name}"`,
                onSelect: () => deactivateFolder(node.path),
              },
            ];
  const items: MenuItem[] = [
    ...activationItems,
    ...(activationItems.length > 0
      ? [{ separator: true as const, label: "" }]
      : []),
    {
      label: "Show only this folder",
      onSelect: () => selectFolder(node.path),
    },
    {
      label: "Open in Explorer",
      onSelect: () => {
        openPath(node.path).catch((e) => console.error(e));
      },
    },
    {
      label: "Copy path",
      onSelect: () => {
        navigator.clipboard.writeText(node.path).catch((e) => console.error(e));
      },
    },
    ...(isRoot
      ? [
          {
            label: "Remove from FONTY",
            onSelect: () => removeRoot(node.path),
            destructive: true,
          },
        ]
      : []),
  ];

  return (
    <>
      <div
        className="group flex items-stretch cursor-pointer ml-2"
        onClick={() => selectFolder(node.path)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        title={node.path}
      >
        {/* Guides live in their own column OUTSIDE the highlight box so the
            hover/selected pill starts at this level's dot instead of the
            sidebar's left edge. `slice(1)` drops the root (ancestor-0): for
            single-root setups it's always empty anyway, and skipping it makes
            indent steps uniform at 12px per depth *and* keeps the IMMEDIATE
            parent's through-line intact (the depth-1 siblings that continue
            past an expanded grandchild). */}
        <div className="flex items-stretch shrink-0">
          {ancestorLastFlags.slice(1).map((last, i) => (
            <div key={i} className={`tree-guide ${last ? "" : "v"}`} />
          ))}
          {depth > 0 && (
            <div
              className={`tree-guide turn ${
                !isLastAmongSiblings ? "continue" : ""
              }`}
            />
          )}
        </div>

        {/* Highlighted content area — this is what the hover/selected pill
            paints. Symmetric 10px padding on both sides keeps the pill
            breathing room equal on left and right. */}
        <div
          className={`flex-1 min-w-0 flex items-center py-1.5 mr-2 rounded-md text-sm transition-colors ${
            selected
              ? "bg-[var(--color-row-selected)] text-[var(--color-row-selected-text)]"
              : "text-[var(--color-text)] hover:bg-[var(--color-row-hover)]"
          }`}
          style={{ paddingLeft: 10, paddingRight: 10 }}
        >
          <div
            className="shrink-0 mr-1.5 w-3 flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <ActivationToggle
              state={state}
              loading={loading}
              size={12}
              onToggle={(activate) => {
                if (activate) activateFolder(node.path);
                else deactivateFolder(node.path);
              }}
            />
          </div>
          <span className="flex-1 min-w-0 truncate">{node.name}</span>
          <span className="text-xs text-[var(--color-text-faint)] tabular-nums ml-2">
            {activeFamilies > 0
              ? `${activeFamilies}/${totalFamilies}`
              : totalFamilies.toLocaleString()}
          </span>
          <div className="shrink-0 ml-1 w-5 flex items-center justify-center">
            {hasChildren ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFolder(node.path);
                }}
                className="w-5 h-5 flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] cursor-pointer"
                aria-label={expanded ? "Collapse" : "Expand"}
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
                    transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                  }}
                >
                  <path d="M6 4 L10 8 L6 12" />
                </svg>
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {expanded &&
        node.children.map((child, idx) => (
          <FolderTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            isRoot={false}
            ancestorLastFlags={[...ancestorLastFlags, isLastAmongSiblings]}
            isLastAmongSiblings={idx === node.children.length - 1}
          />
        ))}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={items}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
