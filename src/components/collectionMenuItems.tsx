import type { Collection } from "../types";
import type { MenuItem } from "./ContextMenu";

/**
 * Build the "Add to collection" menu section. Clicking a collection
 * toggles membership — adds if not in, removes if already in. Callers
 * provide an optional `existingCollectionIds` set so the UI shows a
 * check mark next to collections the font is already a member of, but
 * clicking either state still invokes `onToggle` with the collection id.
 */
export function buildAddToCollectionItems(params: {
  collections: Collection[];
  existingCollectionIds?: Set<number>;
  onToggle: (collectionId: number, collection: Collection) => void;
}): MenuItem[] {
  const { collections, existingCollectionIds, onToggle } = params;
  const items: MenuItem[] = [{ separator: true, label: "Add to collection" }];
  if (collections.length === 0) {
    items.push({
      label: "No collections yet — create one in the sidebar",
      onSelect: () => {},
      disabled: true,
    });
    return items;
  }
  for (const c of collections) {
    const already = existingCollectionIds?.has(c.id) ?? false;
    items.push({
      label: already ? `✓ ${c.name}` : c.name,
      onSelect: () => onToggle(c.id, c),
    });
  }
  return items;
}
