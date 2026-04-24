import { useState } from "react";
import { useStore } from "../store";
import type { Collection } from "../types";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import {
  ActivationToggle,
  familyState,
  useActivationLoading,
} from "./ActivationToggle";

export function CollectionsSection() {
  const collections = useStore((s) => s.collections);
  const createCollection = useStore((s) => s.createCollection);
  const selectedCollection = useStore((s) => s.selectedCollection);
  const selectCollection = useStore((s) => s.selectCollection);
  const deleteCollection = useStore((s) => s.deleteCollection);
  const renameCollection = useStore((s) => s.renameCollection);
  const addFamilyToCollection = useStore((s) => s.addFamilyToCollection);
  const activateCollection = useStore((s) => s.activateCollection);
  const deactivateCollection = useStore((s) => s.deactivateCollection);
  const exportCollection = useStore((s) => s.exportCollection);
  const activationBusy = useStore((s) => s.activationBusy);
  // Tri-state ratio now comes straight from the backend — `activeFontCount`
  // is the number of fonts inside the collection that are currently loaded
  // into the session, `fontCount` is the total in the collection.

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameName, setRenameName] = useState("");
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    collection: Collection;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);

  const submitCreate = async () => {
    const name = newName.trim();
    if (!name) {
      setCreating(false);
      setNewName("");
      return;
    }
    await createCollection(name);
    setCreating(false);
    setNewName("");
  };

  const submitRename = async () => {
    if (renamingId === null) return;
    const name = renameName.trim();
    if (name) {
      await renameCollection(renamingId, name);
    }
    setRenamingId(null);
    setRenameName("");
  };

  return (
    <div className="py-2">
      <div
        className="pr-2 py-1 flex items-center justify-between"
        style={{ paddingLeft: 18 }}
      >
        <span
          className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-faint)] font-medium cursor-help"
          title="Tag-like groups that can hold the same font in several places. Right-click a font in the list to add it to a collection. Click a collection to filter the list. Right-click a collection to rename, export as a folder, or delete it."
        >
          Collections
        </span>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="btn-pill"
          title="Create a new collection"
        >
          + Add
        </button>
      </div>

      {creating && (
        <div className="px-5 py-1.5">
          <input
            autoFocus
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCreate();
              else if (e.key === "Escape") {
                setCreating(false);
                setNewName("");
              }
            }}
            onBlur={submitCreate}
            placeholder="Name…"
            className="w-full bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
          />
        </div>
      )}

      {collections.length === 0 && !creating && (
        <div className="italic text-xs text-[var(--color-text-faint)] px-5 py-1.5">
          No collections yet
        </div>
      )}

      {collections.map((c) => {
        const isSelected = selectedCollection === c.id;
        const isRenaming = renamingId === c.id;
        const isDropTarget = dropTarget === c.id;
        const state = familyState(
          c.activeFontCount,
          Math.max(1, c.fontCount),
        );
        return (
          <div
            key={c.id}
            onClick={() => {
              if (!isRenaming) selectCollection(isSelected ? null : c.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ x: e.clientX, y: e.clientY, collection: c });
            }}
            onDragOver={(e) => {
              if (
                e.dataTransfer.types.includes("application/fonty-family")
              ) {
                e.preventDefault();
                setDropTarget(c.id);
              }
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={async (e) => {
              e.preventDefault();
              setDropTarget(null);
              const familyName = e.dataTransfer.getData(
                "application/fonty-family",
              );
              if (familyName) {
                await addFamilyToCollection(c.id, familyName);
              }
            }}
            className={`flex items-center py-1.5 ml-2 mr-2 rounded-md text-sm cursor-pointer transition-colors ${
              isSelected
                ? "bg-[var(--color-row-selected)] text-[var(--color-row-selected-text)]"
                : "text-[var(--color-text)] hover:bg-[var(--color-row-hover)]"
            } ${
              isDropTarget
                ? "ring-1 ring-inset ring-[var(--color-accent)]"
                : ""
            }`}
            style={{ paddingLeft: 10, paddingRight: 10 }}
            title={c.name}
          >
            <div
              className="shrink-0 mr-1.5 w-3 flex items-center justify-center"
              onClick={(e) => e.stopPropagation()}
            >
              <CollectionActivationToggle
                state={state}
                disabled={activationBusy || c.familyCount === 0}
                collectionId={c.id}
                onToggle={(activate) => {
                  if (activate) activateCollection(c.id);
                  else deactivateCollection(c.id);
                }}
              />
            </div>
            {isRenaming ? (
              <input
                autoFocus
                type="text"
                value={renameName}
                onChange={(e) => setRenameName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitRename();
                  else if (e.key === "Escape") {
                    setRenamingId(null);
                    setRenameName("");
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                onBlur={submitRename}
                className="flex-1 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded px-2 py-0.5 text-xs outline-none focus:border-[var(--color-accent)]"
              />
            ) : (
              <span className="truncate flex-1">{c.name}</span>
            )}
            <span className="text-xs text-[var(--color-text-faint)] tabular-nums ml-2">
              {c.familyCount.toLocaleString()}
            </span>
          </div>
        );
      })}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={contextItems(menu.collection, {
            activate: () => activateCollection(menu.collection.id),
            deactivate: () => deactivateCollection(menu.collection.id),
            rename: () => {
              setRenamingId(menu.collection.id);
              setRenameName(menu.collection.name);
            },
            del: () => deleteCollection(menu.collection.id),
            export_: async () => {
              const result = await exportCollection(
                menu.collection.id,
                menu.collection.name,
              );
              if (result) {
                console.info(
                  `Exported "${menu.collection.name}": ${result.copied} files across ${result.families} families → ${result.dest}`,
                );
              }
            },
          })}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/** Thin wrapper so we can call the `useActivationLoading` hook per row
 *  (hooks can't live inside the parent's `.map` without a component). */
function CollectionActivationToggle({
  state,
  disabled,
  collectionId,
  onToggle,
}: {
  state: import("../types").ActivationState;
  disabled: boolean;
  collectionId: number;
  onToggle: (next: boolean) => void;
}) {
  const loading = useActivationLoading([`collection:${collectionId}`]);
  return (
    <ActivationToggle
      state={state}
      disabled={disabled}
      loading={loading}
      size={12}
      onToggle={onToggle}
    />
  );
}

function contextItems(
  c: Collection,
  actions: {
    activate: () => void;
    deactivate: () => void;
    rename: () => void;
    del: () => void;
    export_: () => void;
  },
): MenuItem[] {
  const active = c.activeFontCount;
  const total = c.fontCount;
  let activation: MenuItem[];
  if (total === 0) {
    activation = [
      {
        label: "Activate collection (empty)",
        onSelect: actions.activate,
        disabled: true,
      },
    ];
  } else if (active === 0) {
    activation = [{ label: `Activate "${c.name}"`, onSelect: actions.activate }];
  } else if (active >= total) {
    activation = [
      { label: `Deactivate "${c.name}"`, onSelect: actions.deactivate },
    ];
  } else {
    // Mixed — offer both so the user can flip in either direction.
    activation = [
      {
        label: `Activate remaining in "${c.name}"`,
        onSelect: actions.activate,
      },
      {
        label: `Deactivate all in "${c.name}"`,
        onSelect: actions.deactivate,
      },
    ];
  }
  return [
    ...activation,
    { separator: true, label: "" },
    { label: "Rename", onSelect: actions.rename },
    {
      label: "Export as folder…",
      onSelect: actions.export_,
    },
    { label: `Delete "${c.name}"`, onSelect: actions.del, destructive: true },
  ];
}
