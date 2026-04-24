import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog, ask } from "@tauri-apps/plugin-dialog";
import type {
  ActivationResult,
  ClassificationCount,
  Collection,
  ExportResult,
  FamilySummary,
  FolderNode,
  FontRow,
  GoogleFamilyRow,
  GoogleLibraryStats,
  GoogleNamedInstance,
  LibraryFilter,
  LibraryStats,
  RootFolder,
  ScanProgressEvent,
  ScanSummary,
  Theme,
  ViewMode,
} from "./types";

const THEME_KEY = "fonty_theme_v1";
const GOOGLE_STAR_FAMILIES_KEY = "fonty_google_starred_families_v1";
const GOOGLE_STAR_VARIANTS_KEY = "fonty_google_starred_variants_v1";
const ERROR_LOG_KEY = "fonty_error_log_v1";
const ERROR_LOG_MAX = 500;

function loadStoredErrorLog(): Array<{
  time: number;
  context: string;
  message: string;
}> {
  try {
    const raw = localStorage.getItem(ERROR_LOG_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (e) =>
        e &&
        typeof e.time === "number" &&
        typeof e.context === "string" &&
        typeof e.message === "string",
    );
  } catch {
    return [];
  }
}

function saveStoredErrorLog(
  log: Array<{ time: number; context: string; message: string }>,
) {
  try {
    localStorage.setItem(ERROR_LOG_KEY, JSON.stringify(log));
  } catch {
    // localStorage is full or unavailable — fine; the in-memory log still
    // works for this session.
  }
}

/** Concurrency-limited map. Processes `items` in parallel with at most
 *  `concurrency` worker promises in flight, preserving order in the output
 *  array. Used to fan out Google family activations during category / all
 *  bulk operations — previously they ran strictly serially so 48 families
 *  queued up end-to-end even though each family's variant downloads are
 *  already parallel. Four workers × ~16 variant threads per family = up to
 *  ~48 concurrent in-flight downloads without exhausting our thread pool. */
async function pMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const GOOGLE_FAMILY_CONCURRENCY = 8;

function loadStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* ignore */
  }
  return "light";
}

function loadStarredGoogleFamilies(): Set<string> {
  try {
    const raw = localStorage.getItem(GOOGLE_STAR_FAMILIES_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr.filter((v) => typeof v === "string"));
    }
  } catch {
    /* ignore */
  }
  return new Set<string>();
}

function saveStarredGoogleFamilies(set: Set<string>) {
  try {
    localStorage.setItem(GOOGLE_STAR_FAMILIES_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

function loadStarredGoogleVariants(): Record<string, Set<string>> {
  try {
    const raw = localStorage.getItem(GOOGLE_STAR_VARIANTS_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object") {
        const out: Record<string, Set<string>> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (Array.isArray(v)) {
            out[k] = new Set(v.filter((x) => typeof x === "string"));
          }
        }
        return out;
      }
    }
  } catch {
    /* ignore */
  }
  return {};
}

function saveStarredGoogleVariants(map: Record<string, Set<string>>) {
  try {
    const plain: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(map)) plain[k] = [...v];
    localStorage.setItem(GOOGLE_STAR_VARIANTS_KEY, JSON.stringify(plain));
  } catch {
    /* ignore */
  }
}

function applyTheme(t: Theme) {
  document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* ignore */
  }
}

const DEFAULT_PREVIEW_TEXT_COLOR = "#e8e9ec";
const DEFAULT_PREVIEW_BG_COLOR = "#0f1012";

const STORAGE_KEY = "fonty_preview_colors_v1";

function loadStoredColors(): {
  textColor: string;
  bgColor: string;
} {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed.textColor === "string" &&
        typeof parsed.bgColor === "string"
      ) {
        return parsed;
      }
    }
  } catch {
    // ignore
  }
  return {
    textColor: DEFAULT_PREVIEW_TEXT_COLOR,
    bgColor: DEFAULT_PREVIEW_BG_COLOR,
  };
}

function saveStoredColors(textColor: string, bgColor: string) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ textColor, bgColor }),
    );
  } catch {
    // ignore
  }
}

type State = {
  roots: RootFolder[];
  folderTrees: FolderNode[];
  expandedFolders: Set<string>;
  selectedFolder: string | null;
  activeIds: Set<number>;
  starredIds: Set<number>;
  pinnedFamilyNames: string[];
  pinnedStyles: FontRow[];
  libraryFilter: LibraryFilter;
  activationBusy: boolean;
  previewTextColor: string;
  previewBgColor: string;
  theme: Theme;
  viewMode: ViewMode;
  dragActive: boolean;
  collections: Collection[];
  selectedCollection: number | null;
  selectedCollectionName: string | null;
  googleFamilies: GoogleFamilyRow[];
  googleLibraryStats: GoogleLibraryStats;
  googleFontsLoading: boolean;
  showGoogleFonts: boolean;
  scanning: boolean;
  progress: ScanProgressEvent | null;
  lastSummary: ScanSummary | null;
  stats: LibraryStats;
  classifications: ClassificationCount[];
  families: FamilySummary[];
  previewText: string;
  previewSize: number;
  searchQuery: string;

  selectedFamily: string | null;
  familyStyles: FontRow[];
  loadingFamilyStyles: boolean;
  selectedGoogleFamily: string | null;

  setPreviewText: (t: string) => void;
  setPreviewSize: (n: number) => void;
  setSearchQuery: (q: string) => void;

  setPreviewTextColor: (c: string) => void;
  setPreviewBgColor: (c: string) => void;
  resetPreviewColors: () => void;

  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  setDragActive: (v: boolean) => void;
  setViewMode: (v: ViewMode) => void;
  toggleViewMode: () => void;

  setLibraryFilter: (f: LibraryFilter) => void;

  loadCollections: () => Promise<void>;
  createCollection: (name: string) => Promise<number | null>;
  renameCollection: (id: number, name: string) => Promise<void>;
  deleteCollection: (id: number) => Promise<void>;
  addFamilyToCollection: (id: number, familyName: string) => Promise<void>;
  addFontsToCollection: (id: number, fontIds: number[]) => Promise<void>;
  removeFamilyFromCollection: (id: number, familyName: string) => Promise<void>;
  selectCollection: (id: number | null) => Promise<void>;
  activateCollection: (id: number) => Promise<void>;
  deactivateCollection: (id: number) => Promise<void>;
  exportCollection: (id: number, name: string) => Promise<ExportResult | null>;

  addGoogleFamilyToCollection: (id: number, family: string) => Promise<void>;
  removeGoogleFamilyFromCollection: (
    id: number,
    family: string,
  ) => Promise<void>;
  collectionsForGoogleFamily: (family: string) => Promise<Collection[]>;
  collectionGoogleFamilyNames: (id: number) => Promise<string[]>;
  collectionGoogleFamilies: string[];
  loadCollectionGoogleFamilies: (id: number | null) => Promise<void>;

  addGoogleVariantToCollection: (
    id: number,
    family: string,
    variant: string,
  ) => Promise<void>;
  removeGoogleVariantFromCollection: (
    id: number,
    family: string,
    variant: string,
  ) => Promise<void>;
  collectionsForGoogleVariant: (
    family: string,
    variant: string,
  ) => Promise<Collection[]>;

  setShowGoogleFonts: (v: boolean) => void;
  selectedGoogleCategory: string | null;
  setSelectedGoogleCategory: (cat: string | null) => void;
  expandedGoogleFonts: boolean;
  setExpandedGoogleFonts: (v: boolean) => void;
  loadGoogleLibrary: () => Promise<void>;
  refreshGoogleCatalog: () => Promise<number>;
  activateGoogleFamily: (family: string) => Promise<void>;
  deactivateGoogleFamily: (family: string) => Promise<void>;
  deactivateAllGoogle: () => Promise<void>;
  activateAllGoogle: () => Promise<void>;
  activateGoogleCategory: (category: string) => Promise<void>;
  collectionsForFamily: (familyName: string) => Promise<Collection[]>;

  toggleFolder: (path: string) => void;
  selectFolder: (path: string | null) => Promise<void>;

  openFamily: (familyName: string) => Promise<void>;
  closeFamily: () => void;
  openGoogleFamily: (familyName: string) => void;
  closeGoogleFamily: () => void;

  loadStats: () => Promise<void>;
  loadFamilies: () => Promise<void>;
  loadClassifications: () => Promise<void>;
  loadRoots: () => Promise<void>;
  loadFolderTrees: () => Promise<void>;
  loadActiveIds: () => Promise<void>;
  pickAndScan: () => Promise<void>;
  removeRoot: (path: string) => Promise<void>;
  refresh: () => Promise<void>;

  activateFonts: (ids: number[]) => Promise<void>;
  deactivateFonts: (ids: number[]) => Promise<void>;
  activateFamily: (familyName: string) => Promise<void>;
  deactivateFamily: (familyName: string) => Promise<void>;
  activateFolder: (path: string) => Promise<void>;
  deactivateFolder: (path: string) => Promise<void>;

  loadStarredIds: () => Promise<void>;
  starFonts: (ids: number[]) => Promise<void>;
  unstarFonts: (ids: number[]) => Promise<void>;
  starFamily: (familyName: string) => Promise<void>;
  unstarFamily: (familyName: string) => Promise<void>;

  togglePin: (familyName: string) => void;
  togglePinStyle: (style: FontRow) => void;
  togglePinGoogleFamily: (family: string) => void;
  clearPins: () => void;

  pinnedGoogleFamilies: string[];
  pinnedGoogleVariants: Array<{ family: string; variant: string }>;
  togglePinGoogleVariant: (family: string, variant: string) => void;
  googleActiveVariants: Record<string, Set<string>>;
  loadGoogleActiveVariants: (family: string) => Promise<void>;
  activateGoogleVariant: (family: string, variant: string) => Promise<void>;
  deactivateGoogleVariant: (family: string, variant: string) => Promise<void>;
  /** Per-family cache of variable-font named instances, parsed from the
   *  downloaded VF file. Empty array for non-VF families or families
   *  whose TTF isn't cached yet. Refreshed each time the styles tray opens. */
  googleNamedInstances: Record<string, GoogleNamedInstance[]>;
  loadGoogleNamedInstances: (family: string) => Promise<void>;

  starredGoogleFamilies: Set<string>;
  starredGoogleVariants: Record<string, Set<string>>;
  toggleStarGoogleFamily: (family: string) => void;
  toggleStarGoogleVariant: (family: string, variant: string) => void;

  showSettings: boolean;
  setShowSettings: (v: boolean) => void;
  toggleSettings: () => void;

  /** When true, the open styles tray (local or Google) takes over the main
   *  area's horizontal space and the main-card list hides. Pinned dock stays
   *  put because it sits below the flex row that contains the tray. */
  trayExpanded: boolean;
  toggleTrayExpanded: () => void;
  setTrayExpanded: (v: boolean) => void;

  restoreOnLaunch: boolean;
  loadRestoreOnLaunch: () => Promise<void>;
  setRestoreOnLaunch: (enabled: boolean) => Promise<void>;

  toast: { id: number; message: string } | null;
  showToast: (message: string) => void;
  dismissToast: () => void;

  /** Rolling in-app error log for user-visible failures — currently
   *  Google Fonts download/activate errors + any future action that asks
   *  `logError(...)`. Oldest entries drop off after 500 to keep memory
   *  bounded. Persisted to localStorage so it survives an app restart.
   *  Surfaced in the Settings card with Copy + Clear buttons. */
  errorLog: Array<{ time: number; context: string; message: string }>;
  logError: (context: string, message: string) => void;
  clearErrorLog: () => void;

  /** Identifiers currently mid-activation. "target" keys are namespaced
   *  strings: "font:123", "family:Roboto", "folder:C:\\…", "collection:5",
   *  "google:Roboto", "google-variant:Roboto:700italic", "google-all",
   *  "google-cat:serif", "local-all". Row components consult these sets
   *  to decide whether to render a loading arc. */
  activatingTargets: Set<string>;
  deactivatingTargets: Set<string>;

  toggleFontInCollection: (
    collectionId: number,
    fontId: number,
    collectionName: string,
  ) => Promise<void>;
  toggleFamilyInCollection: (
    collectionId: number,
    familyName: string,
    collectionName: string,
  ) => Promise<void>;
  toggleGoogleFamilyInCollection: (
    collectionId: number,
    family: string,
    collectionName: string,
  ) => Promise<void>;
  toggleGoogleVariantInCollection: (
    collectionId: number,
    family: string,
    variant: string,
    collectionName: string,
  ) => Promise<void>;
  collectionsForFont: (fontId: number) => Promise<Collection[]>;

  deactivateAllFonts: () => Promise<void>;
  clearUserFontsRegistry: () => Promise<number>;
  uninstallUserInstalledFonts: () => Promise<number>;
  clearGoogleCache: () => Promise<number>;
  clearInactiveGoogleCache: () => Promise<number>;
  removeGoogleFamily: (family: string) => Promise<void>;
  loadGoogleCacheSize: () => Promise<void>;
  /** Total bytes of the Google Fonts cache on disk. Updated via
   *  loadGoogleCacheSize(); surfaced in Settings next to the clear actions. */
  googleCacheBytes: number;
};

/** Payload for the `google-download-progress` Tauri event. One is emitted
 *  per variant after the backend finishes (or fails) its AddFontResourceW
 *  call. Frontend mutates googleActiveVariants + googleFamilies live so the
 *  UI reflects per-variant progress during a batch. */
export type GoogleDownloadProgressPayload = {
  family: string;
  variant: string;
  status: "activated" | "error";
};

export type RemoveGoogleResult = {
  deactivated: number;
  filesRemoved: number;
  bytesRemoved: number;
};

const initialColors = loadStoredColors();

export const useStore = create<State>((set, get) => ({
  roots: [],
  folderTrees: [],
  expandedFolders: new Set<string>(),
  selectedFolder: null,
  activeIds: new Set<number>(),
  starredIds: new Set<number>(),
  pinnedFamilyNames: [],
  pinnedStyles: [],
  pinnedGoogleFamilies: [],
  pinnedGoogleVariants: [],
  googleActiveVariants: {},
  googleNamedInstances: {},
  starredGoogleFamilies: loadStarredGoogleFamilies(),
  starredGoogleVariants: loadStarredGoogleVariants(),
  showSettings: false,
  trayExpanded: false,
  restoreOnLaunch: true,
  toast: null,
  errorLog: loadStoredErrorLog(),
  activatingTargets: new Set<string>(),
  deactivatingTargets: new Set<string>(),
  libraryFilter: "all",
  activationBusy: false,
  viewMode: (localStorage.getItem("fonty_view_mode_v1") === "grid"
    ? "grid"
    : "list") as ViewMode,
  collections: [],
  selectedCollection: null,
  selectedCollectionName: null,
  collectionGoogleFamilies: [],
  googleFamilies: [],
  googleLibraryStats: { families: 0, active: 0 },
  googleCacheBytes: 0,
  googleFontsLoading: false,
  showGoogleFonts: false,
  selectedGoogleCategory: null,
  expandedGoogleFonts: false,
  previewTextColor: initialColors.textColor,
  previewBgColor: initialColors.bgColor,
  scanning: false,
  progress: null,
  lastSummary: null,
  stats: { fonts: 0, families: 0 },
  classifications: [],
  families: [],
  previewText: "The quick brown fox jumps over the lazy dog",
  previewSize: 48,
  searchQuery: "",
  theme: loadStoredTheme(),
  dragActive: false,

  selectedFamily: null,
  familyStyles: [],
  loadingFamilyStyles: false,
  selectedGoogleFamily: null,

  setPreviewText: (t) => set({ previewText: t }),
  setPreviewSize: (n) => set({ previewSize: n }),
  setSearchQuery: (q) => set({ searchQuery: q }),

  setPreviewTextColor(c: string) {
    set({ previewTextColor: c });
    saveStoredColors(c, get().previewBgColor);
  },
  setPreviewBgColor(c: string) {
    set({ previewBgColor: c });
    saveStoredColors(get().previewTextColor, c);
  },
  resetPreviewColors() {
    set({
      previewTextColor: DEFAULT_PREVIEW_TEXT_COLOR,
      previewBgColor: DEFAULT_PREVIEW_BG_COLOR,
    });
    saveStoredColors(DEFAULT_PREVIEW_TEXT_COLOR, DEFAULT_PREVIEW_BG_COLOR);
  },

  setTheme(t: Theme) {
    applyTheme(t);
    set({ theme: t });
  },
  toggleTheme() {
    const next: Theme = get().theme === "dark" ? "light" : "dark";
    applyTheme(next);
    set({ theme: next });
  },
  setDragActive(v: boolean) {
    set({ dragActive: v });
  },
  setViewMode(v: ViewMode) {
    try {
      localStorage.setItem("fonty_view_mode_v1", v);
    } catch {
      /* ignore */
    }
    set({ viewMode: v });
  },
  toggleViewMode() {
    const next: ViewMode = get().viewMode === "list" ? "grid" : "list";
    try {
      localStorage.setItem("fonty_view_mode_v1", next);
    } catch {
      /* ignore */
    }
    set({ viewMode: next });
  },

  setLibraryFilter(f: LibraryFilter) {
    // Library filter is independent of other selections — reset them so
    // "Starred" / "Active" / "All Fonts" always show a global, folder-
    // agnostic view and close any open detail drawers.
    set({
      libraryFilter: f,
      selectedFolder: null,
      selectedCollection: null,
      selectedCollectionName: null,
      showGoogleFonts: false,
      selectedFamily: null,
      selectedGoogleFamily: null,
      familyStyles: [],
      showSettings: false,
    });
    get().loadFamilies();
  },

  toggleFolder(path: string) {
    const next = new Set(get().expandedFolders);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    set({ expandedFolders: next });
  },

  async selectFolder(path: string | null) {
    set({
      selectedFolder: path,
      selectedCollection: null,
      selectedCollectionName: null,
      showGoogleFonts: false,
      libraryFilter: "all",
      selectedFamily: null,
      selectedGoogleFamily: null,
      familyStyles: [],
      showSettings: false,
    });
    await get().loadFamilies();
  },

  async openFamily(familyName: string) {
    // Only one styles tray may be open at a time — close any Google tray
    // that was showing before we load this local family's styles. When
    // viewing a collection, scope the styles to that collection so the
    // tray reflects what the user actually added.
    const collectionId = get().selectedCollection;
    set({
      selectedFamily: familyName,
      selectedGoogleFamily: null,
      familyStyles: [],
      loadingFamilyStyles: true,
    });
    try {
      const styles = await invoke<FontRow[]>("list_family_styles", {
        familyName,
        collectionId,
      });
      if (get().selectedFamily === familyName) {
        set({ familyStyles: styles, loadingFamilyStyles: false });
      }
    } catch (e) {
      console.error("list_family_styles failed", e);
      set({ loadingFamilyStyles: false });
    }
  },

  closeFamily() {
    set({ selectedFamily: null, familyStyles: [] });
  },

  openGoogleFamily(familyName: string) {
    set({
      selectedGoogleFamily: familyName,
      selectedFamily: null,
      familyStyles: [],
    });
  },
  closeGoogleFamily() {
    set({ selectedGoogleFamily: null });
  },

  async loadStats() {
    const stats = await invoke<LibraryStats>("library_stats");
    set({ stats });
  },

  async loadFamilies() {
    const folderFilter = get().selectedFolder;
    const collectionId = get().selectedCollection;
    const families = await invoke<FamilySummary[]>("list_families", {
      folderFilter,
      collectionId,
    });
    set({ families });
  },

  async loadCollections() {
    const collections = await invoke<Collection[]>("list_collections");
    set({ collections });
  },

  async createCollection(name: string) {
    try {
      const id = await invoke<number>("create_collection", { name });
      await get().loadCollections();
      return id;
    } catch (e) {
      console.error("create_collection failed", e);
      return null;
    }
  },

  async renameCollection(id: number, name: string) {
    await invoke("rename_collection", { id, name });
    await get().loadCollections();
  },

  async deleteCollection(id: number) {
    const confirmed = await ask(
      "Delete this collection? Fonts inside the collection stay in your library — only the grouping is removed.",
      { title: "Delete collection", kind: "warning" },
    );
    if (!confirmed) return;
    await invoke("delete_collection", { id });
    if (get().selectedCollection === id) {
      set({ selectedCollection: null });
    }
    await Promise.all([get().loadCollections(), get().loadFamilies()]);
  },

  async addFamilyToCollection(id: number, familyName: string) {
    await invoke("add_family_to_collection", {
      collectionId: id,
      familyName,
    });
    await Promise.all([get().loadCollections(), get().loadFamilies()]);
  },

  async removeFamilyFromCollection(id: number, familyName: string) {
    await invoke("remove_family_from_collection", {
      collectionId: id,
      familyName,
    });
    await Promise.all([get().loadCollections(), get().loadFamilies()]);
  },

  async addFontsToCollection(id: number, fontIds: number[]) {
    if (fontIds.length === 0) return;
    await invoke("add_fonts_to_collection", {
      collectionId: id,
      fontIds,
    });
    await Promise.all([get().loadCollections(), get().loadFamilies()]);
  },

  async selectCollection(id: number | null) {
    let name: string | null = null;
    if (id !== null) {
      const found = get().collections.find((c) => c.id === id);
      name = found?.name ?? null;
    }
    set({
      selectedCollection: id,
      selectedCollectionName: name,
      selectedFolder: null,
      showGoogleFonts: false,
      libraryFilter: "all",
      selectedFamily: null,
      selectedGoogleFamily: null,
      familyStyles: [],
      showSettings: false,
    });
    await Promise.all([
      get().loadFamilies(),
      get().loadCollectionGoogleFamilies(id),
    ]);
  },

  async activateCollection(id: number) {
    const target = `collection:${id}`;
    addTarget(get, set, target, "activating");
    set({ activationBusy: true });
    try {
      await invoke<ActivationResult>("activate_collection", {
        collectionId: id,
      });
      await refreshAfterActivation(get, set);
    } finally {
      removeTarget(get, set, target, "activating");
      set({ activationBusy: false });
    }
  },

  async deactivateCollection(id: number) {
    const target = `collection:${id}`;
    addTarget(get, set, target, "deactivating");
    set({ activationBusy: true });
    try {
      await invoke<ActivationResult>("deactivate_collection", {
        collectionId: id,
      });
      await refreshAfterActivation(get, set);
    } finally {
      removeTarget(get, set, target, "deactivating");
      set({ activationBusy: false });
    }
  },

  async exportCollection(id: number, name: string) {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: `Pick a destination folder for "${name}"`,
    });
    if (!picked || typeof picked !== "string") return null;
    try {
      const result = await invoke<ExportResult>("export_collection", {
        collectionId: id,
        destDir: picked,
        collectionName: name,
      });
      return result;
    } catch (e) {
      console.error("export_collection failed", e);
      return null;
    }
  },

  async collectionsForFamily(familyName: string) {
    try {
      return await invoke<Collection[]>("collections_for_family", {
        familyName,
      });
    } catch (e) {
      console.error("collections_for_family failed", e);
      return [];
    }
  },

  async addGoogleFamilyToCollection(id: number, family: string) {
    try {
      await invoke("add_google_family_to_collection", {
        collectionId: id,
        family,
      });
      await Promise.all([
        get().loadCollections(),
        get().loadCollectionGoogleFamilies(get().selectedCollection),
      ]);
    } catch (e) {
      console.error("add_google_family_to_collection failed", e);
    }
  },

  async removeGoogleFamilyFromCollection(id: number, family: string) {
    try {
      await invoke("remove_google_family_from_collection", {
        collectionId: id,
        family,
      });
      await Promise.all([
        get().loadCollections(),
        get().loadCollectionGoogleFamilies(get().selectedCollection),
      ]);
    } catch (e) {
      console.error("remove_google_family_from_collection failed", e);
    }
  },

  async collectionsForGoogleFamily(family: string) {
    try {
      return await invoke<Collection[]>("collections_for_google_family", {
        family,
      });
    } catch (e) {
      console.error("collections_for_google_family failed", e);
      return [];
    }
  },

  async collectionGoogleFamilyNames(id: number) {
    try {
      return await invoke<string[]>("collection_google_family_names", {
        collectionId: id,
      });
    } catch (e) {
      console.error("collection_google_family_names failed", e);
      return [];
    }
  },

  async loadCollectionGoogleFamilies(id: number | null) {
    if (id === null) {
      set({ collectionGoogleFamilies: [] });
      return;
    }
    try {
      const names = await invoke<string[]>(
        "collection_google_family_names",
        { collectionId: id },
      );
      set({ collectionGoogleFamilies: names });
    } catch (e) {
      console.error("loadCollectionGoogleFamilies failed", e);
      set({ collectionGoogleFamilies: [] });
    }
  },

  async addGoogleVariantToCollection(id, family, variant) {
    try {
      await invoke("add_google_variant_to_collection", {
        collectionId: id,
        family,
        variant,
      });
      await get().loadCollections();
    } catch (e) {
      console.error("add_google_variant_to_collection failed", e);
    }
  },

  async removeGoogleVariantFromCollection(id, family, variant) {
    try {
      await invoke("remove_google_variant_from_collection", {
        collectionId: id,
        family,
        variant,
      });
      await get().loadCollections();
    } catch (e) {
      console.error("remove_google_variant_from_collection failed", e);
    }
  },

  async collectionsForGoogleVariant(family, variant) {
    try {
      return await invoke<Collection[]>("collections_for_google_variant", {
        family,
        variant,
      });
    } catch (e) {
      console.error("collections_for_google_variant failed", e);
      return [];
    }
  },

  setShowGoogleFonts(v: boolean) {
    set({
      showGoogleFonts: v,
      // Any main-view switch closes open drawers.
      selectedFamily: null,
      selectedGoogleFamily: null,
      familyStyles: [],
      showSettings: false,
    });
    if (v) {
      set({
        selectedFolder: null,
        selectedCollection: null,
        selectedCollectionName: null,
        libraryFilter: "all",
      });
      get().loadGoogleLibrary();
    } else {
      set({ selectedGoogleCategory: null });
    }
  },

  setSelectedGoogleCategory(cat: string | null) {
    // Selecting a category implies we're in the Google Fonts view — flip it
    // on and clear other selections so the main card reflects the filter.
    set({
      selectedGoogleCategory: cat,
      showGoogleFonts: true,
      selectedFolder: null,
      selectedCollection: null,
      selectedCollectionName: null,
      libraryFilter: "all",
      selectedFamily: null,
      selectedGoogleFamily: null,
      familyStyles: [],
      showSettings: false,
    });
    get().loadGoogleLibrary();
  },

  setExpandedGoogleFonts(v: boolean) {
    set({ expandedGoogleFonts: v });
  },

  async loadGoogleLibrary() {
    try {
      const [stats, families] = await Promise.all([
        invoke<GoogleLibraryStats>("google_library_stats"),
        invoke<GoogleFamilyRow[]>("list_google_families"),
      ]);
      set({ googleLibraryStats: stats, googleFamilies: families });
    } catch (e) {
      console.error("loadGoogleLibrary failed", e);
    }
  },

  async refreshGoogleCatalog() {
    set({ googleFontsLoading: true });
    try {
      const n = await invoke<number>("refresh_google_catalog");
      await get().loadGoogleLibrary();
      return n;
    } catch (e) {
      console.error("refresh_google_catalog failed", e);
      return 0;
    } finally {
      set({ googleFontsLoading: false });
    }
  },

  async activateGoogleFamily(family: string) {
    // Pre-add per-variant loading targets so each variant row's dot spins
    // individually until the backend's streaming progress listener removes
    // its target — produces the "variants light up as they land" UX.
    const meta = get().googleFamilies.find((f) => f.familyName === family);
    const allVariants = meta?.variants ?? [];
    const currentlyActive =
      get().googleActiveVariants[family] ?? new Set<string>();
    const missing = allVariants.filter((v) => !currentlyActive.has(v));
    const familyTarget = `google:${family}`;
    const variantTargets = missing.map((v) => `google-variant:${family}:${v}`);
    // Single setState so we don't re-render per target.
    set((s) => {
      const next = new Set(s.activatingTargets);
      next.add(familyTarget);
      for (const t of variantTargets) next.add(t);
      return { activatingTargets: next };
    });
    try {
      await invoke<number>("activate_google_family", { family });
      await get().loadGoogleLibrary();
    } catch (e) {
      const msg = typeof e === "string" ? e : JSON.stringify(e);
      get().logError(`activate_google_family "${family}"`, msg);
      alert(
        `Couldn't activate Google font "${family}":\n\n${msg}\n\nCheck your internet connection, then try again.`,
      );
    } finally {
      // Clean up both the family target and any variant targets the
      // streaming listener didn't remove (errors / already-active / etc.).
      set((s) => {
        const next = new Set(s.activatingTargets);
        next.delete(familyTarget);
        for (const t of variantTargets) next.delete(t);
        return { activatingTargets: next };
      });
    }
  },

  async deactivateGoogleFamily(family: string) {
    const target = `google:${family}`;
    addTarget(get, set, target, "deactivating");
    set({ activationBusy: true });
    try {
      await invoke<number>("deactivate_google_family", { family });
      await get().loadGoogleLibrary();
    } catch (e) {
      console.error("deactivate_google_family failed", e);
    } finally {
      removeTarget(get, set, target, "deactivating");
      set({ activationBusy: false });
    }
  },

  async deactivateAllGoogle() {
    addTarget(get, set, "google-all", "deactivating");
    set({ activationBusy: true });
    try {
      await invoke<number>("deactivate_all_google");
      await get().loadGoogleLibrary();
    } finally {
      removeTarget(get, set, "google-all", "deactivating");
      set({ activationBusy: false });
    }
  },

  async activateAllGoogle() {
    const targets = get().googleFamilies.filter((f) => f.activeCount === 0);
    if (targets.length === 0) return;
    const confirmed = await ask(
      `Activate all ${targets.length.toLocaleString()} Google fonts?\n\nEach family's files will be downloaded and loaded into Windows. This can take several minutes and use significant bandwidth.`,
      { title: "Activate all Google fonts", kind: "warning" },
    );
    if (!confirmed) return;
    // Count how many families are pending per category, so each category's
    // target can clear the moment its last family finishes — independent
    // of sibling categories. This is what lets Sans Serif flip to active
    // while Monospace is still in progress, instead of all categories
    // holding loading until the entire activate-all ends.
    const remainingByCategory = new Map<string, number>();
    for (const f of targets) {
      remainingByCategory.set(
        f.category,
        (remainingByCategory.get(f.category) ?? 0) + 1,
      );
    }
    const categoryKeys = Array.from(remainingByCategory.keys());

    // Pre-add every tier's target: google-all + each category + each family
    // + each pending variant. One setState so we don't re-render per target.
    set((s) => {
      const next = new Set(s.activatingTargets);
      next.add("google-all");
      for (const cat of categoryKeys) next.add(`google-cat:${cat}`);
      for (const f of targets) {
        next.add(`google:${f.familyName}`);
        const currentlyActive =
          s.googleActiveVariants[f.familyName] ?? new Set<string>();
        for (const v of f.variants) {
          if (!currentlyActive.has(v)) {
            next.add(`google-variant:${f.familyName}:${v}`);
          }
        }
      }
      return { activatingTargets: next };
    });

    const failures: Array<{ family: string; error: string }> = [];
    try {
      // Batch CSS prefetch for every family — 1600 families collapse from
      // 1600 CSS fetches to ~80 (20 families per request). On a typical
      // connection this saves several minutes on activate-all.
      try {
        await invoke<number>("prefetch_google_css", {
          families: targets.map((f) => f.familyName),
        });
      } catch (e) {
        console.warn("prefetch_google_css failed", e);
      }
      await pMap(targets, GOOGLE_FAMILY_CONCURRENCY, async (f) => {
        try {
          await invoke<number>("activate_google_family_no_broadcast", {
            family: f.familyName,
          });
        } catch (e) {
          const msg = typeof e === "string" ? e : JSON.stringify(e);
          get().logError(`activate-all · "${f.familyName}"`, msg);
          failures.push({ family: f.familyName, error: msg });
        }
        // Family done — flip its dot regardless of how siblings are doing.
        // Also check if this was the last family of its category; if so,
        // drop that category's target so the category row flips too.
        const left = (remainingByCategory.get(f.category) ?? 1) - 1;
        remainingByCategory.set(f.category, left);
        const categoryFinished = left <= 0;
        set((s) => {
          const next = new Set(s.activatingTargets);
          next.delete(`google:${f.familyName}`);
          for (const v of f.variants) {
            next.delete(`google-variant:${f.familyName}:${v}`);
          }
          if (categoryFinished) {
            next.delete(`google-cat:${f.category}`);
          }
          return { activatingTargets: next };
        });
      });
      // Single final broadcast so every newly-loaded variant in every
      // family refreshes Windows font consumers at once.
      try {
        await invoke("google_broadcast_font_change");
      } catch (e) {
        console.warn("google_broadcast_font_change failed", e);
      }
      await get().loadGoogleLibrary();
      const succeeded = targets.length - failures.length;
      if (failures.length === 0) {
        get().showToast(`Activated ${succeeded.toLocaleString()} families`);
      } else {
        get().showToast(
          `Activated ${succeeded.toLocaleString()} · ${failures.length} failed (see Settings → Error log)`,
        );
      }
    } finally {
      // google-all clears last. Any category targets still lingering (from
      // errored families that skewed the counter) clean up here too.
      set((s) => {
        const next = new Set(s.activatingTargets);
        next.delete("google-all");
        for (const cat of categoryKeys) next.delete(`google-cat:${cat}`);
        return { activatingTargets: next };
      });
    }
  },

  async activateGoogleCategory(category: string) {
    const targets = get().googleFamilies.filter(
      (f) => f.category === category && f.activeCount === 0,
    );
    if (targets.length === 0) return;
    const confirmed = await ask(
      `Activate all ${targets.length.toLocaleString()} "${category}" Google fonts?\n\nFiles will be downloaded and loaded into Windows.`,
      { title: "Activate category", kind: "warning" },
    );
    if (!confirmed) return;
    const categoryTarget = `google-cat:${category}`;

    // Hierarchical pre-add: every descendant target goes into activatingTargets
    // BEFORE the batch starts, so every row below the category (families,
    // variants) shows its loading dot from the click instant. As individual
    // work completes, each level's own target clears independently:
    //   - variant target  ← removed by the streaming progress listener
    //   - family target   ← removed by the pMap worker's finally block
    //   - category target ← removed at the end of the whole batch
    // Each level's dot flips when ITS target clears — families flip as
    // soon as their own variants are all done, even if siblings are still
    // being processed. Matches Adria's "hierarchy" model.
    set((s) => {
      const next = new Set(s.activatingTargets);
      next.add(categoryTarget);
      for (const f of targets) {
        next.add(`google:${f.familyName}`);
        const currentlyActive =
          s.googleActiveVariants[f.familyName] ?? new Set<string>();
        for (const v of f.variants) {
          if (!currentlyActive.has(v)) {
            next.add(`google-variant:${f.familyName}:${v}`);
          }
        }
      }
      return { activatingTargets: next };
    });

    const failures: Array<{ family: string; error: string }> = [];
    try {
      // Batch-prefetch every family's CSS URLs in one or two HTTP calls
      // (20 families per request) BEFORE the pMap workers start. Each
      // family's subsequent activate finds its URLs in the cache and
      // skips the per-family metadata round-trip — a 48-family category
      // collapses from 48 CSS fetches to 3.
      try {
        await invoke<number>("prefetch_google_css", {
          families: targets.map((f) => f.familyName),
        });
      } catch (e) {
        // Not fatal — per-family fetch will handle it.
        console.warn("prefetch_google_css failed", e);
      }
      await pMap(targets, GOOGLE_FAMILY_CONCURRENCY, async (f) => {
        try {
          await invoke<number>("activate_google_family_no_broadcast", {
            family: f.familyName,
          });
        } catch (e) {
          const msg = typeof e === "string" ? e : JSON.stringify(e);
          get().logError(
            `activate category "${category}" · "${f.familyName}"`,
            msg,
          );
          failures.push({ family: f.familyName, error: msg });
        }
        // Clear this family's target + any stray variant targets the
        // streaming progress listener didn't remove.
        set((s) => {
          const next = new Set(s.activatingTargets);
          next.delete(`google:${f.familyName}`);
          for (const v of f.variants) {
            next.delete(`google-variant:${f.familyName}:${v}`);
          }
          return { activatingTargets: next };
        });
      });
      // Single WM_FONTCHANGE broadcast for the whole batch instead of
      // one per family. Word/Affinity refresh their font pickers once.
      try {
        await invoke("google_broadcast_font_change");
      } catch (e) {
        console.warn("google_broadcast_font_change failed", e);
      }
      await get().loadGoogleLibrary();
      const succeeded = targets.length - failures.length;
      if (failures.length === 0) {
        get().showToast(
          `Activated ${succeeded.toLocaleString()} ${category} families`,
        );
      } else {
        get().showToast(
          `Activated ${succeeded.toLocaleString()} · ${failures.length} failed (see Settings → Error log)`,
        );
      }
    } finally {
      // Category target clears last — only after every family in it has
      // finalised. This is the "parent state isn't stated until all files
      // in it are stated" rule.
      removeTarget(get, set, categoryTarget, "activating");
    }
  },

  async loadFolderTrees() {
    const folderTrees = await invoke<FolderNode[]>("folder_trees");
    set({ folderTrees });
  },

  async loadActiveIds() {
    const ids = await invoke<number[]>("active_font_ids");
    set({ activeIds: new Set(ids) });
  },

  async loadStarredIds() {
    const ids = await invoke<number[]>("starred_font_ids");
    set({ starredIds: new Set(ids) });
  },

  async loadClassifications() {
    const classifications = await invoke<ClassificationCount[]>(
      "classification_counts",
    );
    set({ classifications });
  },

  async loadRoots() {
    const roots = await invoke<RootFolder[]>("list_roots");
    set({ roots });
  },

  async refresh() {
    await Promise.all([
      get().loadStats(),
      get().loadFamilies(),
      get().loadClassifications(),
      get().loadRoots(),
      get().loadFolderTrees(),
      get().loadActiveIds(),
      get().loadStarredIds(),
      get().loadCollections(),
      get().loadRestoreOnLaunch(),
    ]);
  },

  async loadRestoreOnLaunch() {
    try {
      const v = await invoke<boolean>("get_restore_on_launch");
      set({ restoreOnLaunch: v });
    } catch (e) {
      console.error("get_restore_on_launch failed", e);
    }
  },

  async setRestoreOnLaunch(enabled: boolean) {
    try {
      await invoke("set_restore_on_launch", { enabled });
      set({ restoreOnLaunch: enabled });
      get().showToast(
        enabled
          ? "Active fonts will be restored on launch"
          : "Active fonts will not be restored on launch",
      );
    } catch (e) {
      console.error("set_restore_on_launch failed", e);
    }
  },

  async activateFonts(ids: number[]) {
    if (ids.length === 0) return;
    const targets = ids.map((id) => `font:${id}`);
    targets.forEach((t) => addTarget(get, set, t, "activating"));
    set({ activationBusy: true });
    try {
      await invoke<ActivationResult>("activate_fonts", { ids });
      await refreshAfterActivation(get, set);
    } finally {
      targets.forEach((t) => removeTarget(get, set, t, "activating"));
      set({ activationBusy: false });
    }
  },

  async deactivateFonts(ids: number[]) {
    if (ids.length === 0) return;
    const targets = ids.map((id) => `font:${id}`);
    targets.forEach((t) => addTarget(get, set, t, "deactivating"));
    set({ activationBusy: true });
    try {
      await invoke<ActivationResult>("deactivate_fonts", { ids });
      await refreshAfterActivation(get, set);
    } finally {
      targets.forEach((t) => removeTarget(get, set, t, "deactivating"));
      set({ activationBusy: false });
    }
  },

  async activateFamily(familyName: string) {
    const target = `family:${familyName}`;
    addTarget(get, set, target, "activating");
    set({ activationBusy: true });
    try {
      await invoke<ActivationResult>("activate_family", { familyName });
      await refreshAfterActivation(get, set);
    } finally {
      removeTarget(get, set, target, "activating");
      set({ activationBusy: false });
    }
  },

  async deactivateFamily(familyName: string) {
    const target = `family:${familyName}`;
    addTarget(get, set, target, "deactivating");
    set({ activationBusy: true });
    try {
      await invoke<ActivationResult>("deactivate_family", { familyName });
      await refreshAfterActivation(get, set);
    } finally {
      removeTarget(get, set, target, "deactivating");
      set({ activationBusy: false });
    }
  },

  async activateFolder(path: string) {
    const target = `folder:${path}`;
    addTarget(get, set, target, "activating");
    set({ activationBusy: true });
    try {
      await invoke<ActivationResult>("activate_folder", { path });
      await refreshAfterActivation(get, set);
    } finally {
      removeTarget(get, set, target, "activating");
      set({ activationBusy: false });
    }
  },

  async deactivateFolder(path: string) {
    const target = `folder:${path}`;
    addTarget(get, set, target, "deactivating");
    set({ activationBusy: true });
    try {
      await invoke<ActivationResult>("deactivate_folder", { path });
      await refreshAfterActivation(get, set);
    } finally {
      removeTarget(get, set, target, "deactivating");
      set({ activationBusy: false });
    }
  },

  async pickAndScan() {
    if (get().scanning) return;
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Pick a folder containing fonts",
    });
    if (!picked || typeof picked !== "string") return;
    set({
      scanning: true,
      progress: null,
      lastSummary: null,
    });
    try {
      const summary = await invoke<ScanSummary>("scan_folder", {
        path: picked,
      });
      set({ lastSummary: summary });
      await get().refresh();
    } finally {
      set({ scanning: false });
    }
  },

  async removeRoot(path: string) {
    const confirmed = await ask(
      `Remove "${path}" from FONTY?\n\nFonts under this folder will be deleted from your library (the files on disk are untouched).`,
      { title: "Remove folder", kind: "warning" },
    );
    if (!confirmed) return;
    await invoke("remove_root", { path });
    if (get().selectedFamily) {
      set({ selectedFamily: null, familyStyles: [] });
    }
    if (
      get().selectedFolder &&
      (get().selectedFolder === path ||
        get().selectedFolder!.startsWith(path))
    ) {
      set({ selectedFolder: null });
    }
    await get().refresh();
  },

  async starFonts(ids: number[]) {
    if (ids.length === 0) return;
    await invoke("star_fonts", { ids });
    await refreshAfterStar(get);
  },
  async unstarFonts(ids: number[]) {
    if (ids.length === 0) return;
    await invoke("unstar_fonts", { ids });
    await refreshAfterStar(get);
  },
  async starFamily(familyName: string) {
    await invoke("star_family", { familyName });
    await refreshAfterStar(get);
  },
  async unstarFamily(familyName: string) {
    await invoke("unstar_family", { familyName });
    await refreshAfterStar(get);
  },

  togglePin(familyName: string) {
    const cur = get().pinnedFamilyNames;
    if (cur.includes(familyName)) {
      set({ pinnedFamilyNames: cur.filter((n) => n !== familyName) });
    } else {
      set({ pinnedFamilyNames: [familyName, ...cur] });
    }
  },

  togglePinStyle(style: FontRow) {
    const cur = get().pinnedStyles;
    if (cur.some((s) => s.id === style.id)) {
      set({ pinnedStyles: cur.filter((s) => s.id !== style.id) });
    } else {
      set({ pinnedStyles: [style, ...cur] });
    }
  },

  togglePinGoogleFamily(family: string) {
    const cur = get().pinnedGoogleFamilies;
    if (cur.includes(family)) {
      set({ pinnedGoogleFamilies: cur.filter((f) => f !== family) });
    } else {
      set({ pinnedGoogleFamilies: [family, ...cur] });
    }
  },

  togglePinGoogleVariant(family: string, variant: string) {
    const cur = get().pinnedGoogleVariants;
    const idx = cur.findIndex(
      (v) => v.family === family && v.variant === variant,
    );
    if (idx >= 0) {
      set({
        pinnedGoogleVariants: cur.filter((_, i) => i !== idx),
      });
    } else {
      set({
        pinnedGoogleVariants: [{ family, variant }, ...cur],
      });
    }
  },

  clearPins() {
    set({
      pinnedFamilyNames: [],
      pinnedStyles: [],
      pinnedGoogleFamilies: [],
      pinnedGoogleVariants: [],
    });
  },

  async loadGoogleActiveVariants(family: string) {
    try {
      const list = await invoke<string[]>("google_active_variants_for", {
        family,
      });
      set({
        googleActiveVariants: {
          ...get().googleActiveVariants,
          [family]: new Set(list),
        },
      });
    } catch (e) {
      console.error("google_active_variants_for failed", e);
    }
  },

  async loadGoogleNamedInstances(family: string) {
    try {
      const list = await invoke<GoogleNamedInstance[]>(
        "google_named_instances",
        { family },
      );
      set({
        googleNamedInstances: {
          ...get().googleNamedInstances,
          [family]: list,
        },
      });
    } catch (e) {
      console.error("google_named_instances failed", e);
    }
  },

  async activateGoogleVariant(family: string, variant: string) {
    const target = `google-variant:${family}:${variant}`;
    addTarget(get, set, target, "activating");
    set({ activationBusy: true });
    try {
      await invoke("activate_google_variant", { family, variant });
      await Promise.all([
        get().loadGoogleLibrary(),
        get().loadGoogleActiveVariants(family),
      ]);
    } catch (e) {
      const msg = typeof e === "string" ? e : JSON.stringify(e);
      get().logError(
        `activate_google_variant "${family}" / ${variant}`,
        msg,
      );
      alert(
        `Couldn't activate "${family} ${variant}":\n\n${msg}\n\nTry ↻ Sync in the sidebar and retry.`,
      );
    } finally {
      removeTarget(get, set, target, "activating");
      set({ activationBusy: false });
    }
  },

  async deactivateGoogleVariant(family: string, variant: string) {
    const target = `google-variant:${family}:${variant}`;
    addTarget(get, set, target, "deactivating");
    set({ activationBusy: true });
    try {
      await invoke("deactivate_google_variant", { family, variant });
      await Promise.all([
        get().loadGoogleLibrary(),
        get().loadGoogleActiveVariants(family),
      ]);
    } catch (e) {
      console.error("deactivate_google_variant failed", e);
    } finally {
      removeTarget(get, set, target, "deactivating");
      set({ activationBusy: false });
    }
  },

  toggleStarGoogleFamily(family: string) {
    const cur = new Set(get().starredGoogleFamilies);
    if (cur.has(family)) cur.delete(family);
    else cur.add(family);
    saveStarredGoogleFamilies(cur);
    set({ starredGoogleFamilies: cur });
  },

  toggleStarGoogleVariant(family: string, variant: string) {
    const cur = { ...get().starredGoogleVariants };
    const forFam = new Set(cur[family] ?? []);
    if (forFam.has(variant)) forFam.delete(variant);
    else forFam.add(variant);
    if (forFam.size === 0) delete cur[family];
    else cur[family] = forFam;
    saveStarredGoogleVariants(cur);
    set({ starredGoogleVariants: cur });
  },

  setShowSettings(v: boolean) {
    set({
      showSettings: v,
      ...(v
        ? {
            selectedFamily: null,
            selectedGoogleFamily: null,
            familyStyles: [],
          }
        : {}),
    });
  },

  toggleSettings() {
    const next = !get().showSettings;
    set({
      showSettings: next,
      ...(next
        ? {
            selectedFamily: null,
            selectedGoogleFamily: null,
            familyStyles: [],
          }
        : {}),
    });
  },

  toggleTrayExpanded() {
    set({ trayExpanded: !get().trayExpanded });
  },
  setTrayExpanded(v: boolean) {
    set({ trayExpanded: v });
  },

  showToast(message: string) {
    const id = Date.now() + Math.random();
    set({ toast: { id, message } });
    setTimeout(() => {
      const cur = get().toast;
      if (cur && cur.id === id) set({ toast: null });
    }, 2200);
  },

  dismissToast() {
    set({ toast: null });
  },

  logError(context: string, message: string) {
    const entry = { time: Date.now(), context, message };
    const next = [...get().errorLog, entry].slice(-ERROR_LOG_MAX);
    set({ errorLog: next });
    saveStoredErrorLog(next);
    // Still emit to console so live debugging via DevTools works too.
    console.warn(`[${context}] ${message}`);
  },

  clearErrorLog() {
    set({ errorLog: [] });
    saveStoredErrorLog([]);
  },

  async toggleFontInCollection(collectionId, fontId, collectionName) {
    try {
      const added = await invoke<boolean>("toggle_font_in_collection", {
        collectionId,
        fontId,
      });
      await Promise.all([
        get().loadCollections(),
        get().loadFamilies(),
      ]);
      get().showToast(
        added
          ? `Added to "${collectionName}"`
          : `Removed from "${collectionName}"`,
      );
    } catch (e) {
      console.error("toggle_font_in_collection failed", e);
    }
  },

  async toggleFamilyInCollection(collectionId, familyName, collectionName) {
    try {
      const added = await invoke<boolean>("toggle_family_in_collection", {
        collectionId,
        familyName,
      });
      await Promise.all([
        get().loadCollections(),
        get().loadFamilies(),
      ]);
      get().showToast(
        added
          ? `Added to "${collectionName}"`
          : `Removed from "${collectionName}"`,
      );
    } catch (e) {
      console.error("toggle_family_in_collection failed", e);
    }
  },

  async toggleGoogleFamilyInCollection(
    collectionId,
    family,
    collectionName,
  ) {
    try {
      const added = await invoke<boolean>(
        "toggle_google_family_in_collection",
        { collectionId, family },
      );
      await Promise.all([
        get().loadCollections(),
        get().loadCollectionGoogleFamilies(get().selectedCollection),
      ]);
      get().showToast(
        added
          ? `Added to "${collectionName}"`
          : `Removed from "${collectionName}"`,
      );
    } catch (e) {
      console.error("toggle_google_family_in_collection failed", e);
    }
  },

  async toggleGoogleVariantInCollection(
    collectionId,
    family,
    variant,
    collectionName,
  ) {
    try {
      const added = await invoke<boolean>(
        "toggle_google_variant_in_collection",
        { collectionId, family, variant },
      );
      await get().loadCollections();
      get().showToast(
        added
          ? `Added to "${collectionName}"`
          : `Removed from "${collectionName}"`,
      );
    } catch (e) {
      console.error("toggle_google_variant_in_collection failed", e);
    }
  },

  async collectionsForFont(fontId: number) {
    try {
      return await invoke<Collection[]>("collections_for_font", { fontId });
    } catch (e) {
      console.error("collections_for_font failed", e);
      return [];
    }
  },

  async deactivateAllFonts() {
    const confirmed = await ask(
      "Deactivate every font FONTY has activated on your system?\n\nThis removes FONTY's per-user font registrations. Files on disk are untouched.",
      { title: "Deactivate all", kind: "warning" },
    );
    if (!confirmed) return;
    set({ activationBusy: true });
    try {
      await invoke("deactivate_all_fonts");
      await refreshAfterActivation(get, set);
    } finally {
      set({ activationBusy: false });
    }
  },

  async uninstallUserInstalledFonts() {
    const confirmed = await ask(
      "Uninstall every per-user font from your system?\n\nRemoves the HKCU registry entries AND deletes every file in %LOCALAPPDATA%\\Microsoft\\Windows\\Fonts (the per-user fonts directory Windows uses when you right-click → Install for current user). System fonts in C:\\Windows\\Fonts are NOT touched. Files in your own font folders stay put.\n\nThis will deactivate every FONTY font currently loaded. Continue?",
      { title: "Uninstall all user fonts from system", kind: "warning" },
    );
    if (!confirmed) return 0;
    try {
      const result = await invoke<{ cleared: number }>(
        "uninstall_user_installed_fonts",
      );
      await refreshAfterActivation(get, set);
      get().showToast(`Uninstalled ${result.cleared.toLocaleString()} fonts`);
      return result.cleared;
    } catch (e) {
      console.error("uninstall_user_installed_fonts failed", e);
      return 0;
    }
  },

  async clearGoogleCache() {
    const confirmed = await ask(
      "Delete every cached Google Fonts TTF from disk?\n\nActive Google fonts will lose their files — you should deactivate them first. Next activation will re-download.",
      { title: "Clear Google Fonts cache", kind: "warning" },
    );
    if (!confirmed) return 0;
    try {
      const removed = await invoke<number>("clear_google_cache");
      get().showToast(`Cleared ${removed.toLocaleString()} cached files`);
      await get().loadGoogleCacheSize();
      return removed;
    } catch (e) {
      console.error("clear_google_cache failed", e);
      return 0;
    }
  },

  async clearInactiveGoogleCache() {
    const confirmed = await ask(
      "Delete cached files for every Google family that isn't currently active?\n\nActive families stay untouched. Reactivating a deleted family will re-download its files.",
      { title: "Clear cache for inactive Google families", kind: "warning" },
    );
    if (!confirmed) return 0;
    try {
      const res = await invoke<RemoveGoogleResult>(
        "clear_inactive_google_cache",
      );
      const mb = (res.bytesRemoved / (1024 * 1024)).toFixed(1);
      get().showToast(
        res.filesRemoved > 0
          ? `Cleared ${res.filesRemoved.toLocaleString()} files · ${mb} MB`
          : "Nothing to clear",
      );
      await get().loadGoogleCacheSize();
      return res.filesRemoved;
    } catch (e) {
      console.error("clear_inactive_google_cache failed", e);
      return 0;
    }
  },

  async removeGoogleFamily(family: string) {
    const target = `google:${family}`;
    addTarget(get, set, target, "deactivating");
    set({ activationBusy: true });
    try {
      const res = await invoke<RemoveGoogleResult>("remove_google_family", {
        family,
      });
      const mb = (res.bytesRemoved / (1024 * 1024)).toFixed(1);
      get().showToast(
        res.filesRemoved > 0
          ? `Removed "${family}" · ${mb} MB freed`
          : `"${family}" isn't cached`,
      );
      await Promise.all([
        get().loadGoogleLibrary(),
        get().loadGoogleCacheSize(),
      ]);
    } catch (e) {
      console.error("remove_google_family failed", e);
    } finally {
      removeTarget(get, set, target, "deactivating");
      set({ activationBusy: false });
    }
  },

  async loadGoogleCacheSize() {
    try {
      const bytes = await invoke<number>("google_cache_size");
      set({ googleCacheBytes: bytes });
    } catch (e) {
      console.error("google_cache_size failed", e);
    }
  },

  async clearUserFontsRegistry() {
    const confirmed = await ask(
      "Remove ALL per-user font installations from Windows?\n\nThis wipes every entry under HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts — including FONTY's, FontBase leftovers, and any other app's per-user registrations. Windows system fonts are NOT touched. Files on disk are untouched.\n\nActivations can be re-applied from FONTY. Continue?",
      { title: "Clean up all user-installed fonts", kind: "warning" },
    );
    if (!confirmed) return 0;
    set({ activationBusy: true });
    try {
      const result = await invoke<{ cleared: number }>(
        "clear_user_fonts_registry",
      );
      await refreshAfterActivation(get, set);
      return result.cleared;
    } finally {
      set({ activationBusy: false });
    }
  },
}));

function addTarget(
  get: () => State,
  set: (s: Partial<State>) => void,
  target: string,
  direction: "activating" | "deactivating",
) {
  const key =
    direction === "activating" ? "activatingTargets" : "deactivatingTargets";
  const next = new Set(get()[key] as Set<string>);
  next.add(target);
  set({ [key]: next } as unknown as Partial<State>);
}

function removeTarget(
  get: () => State,
  set: (s: Partial<State>) => void,
  target: string,
  direction: "activating" | "deactivating",
) {
  const key =
    direction === "activating" ? "activatingTargets" : "deactivatingTargets";
  const next = new Set(get()[key] as Set<string>);
  next.delete(target);
  set({ [key]: next } as unknown as Partial<State>);
}

async function refreshAfterStar(get: () => State) {
  await Promise.all([get().loadFamilies(), get().loadStarredIds()]);
  const selectedFamily = get().selectedFamily;
  if (selectedFamily) {
    await get().openFamily(selectedFamily);
  }
}

async function refreshAfterActivation(
  get: () => State,
  _set: (s: Partial<State>) => void,
) {
  // Reload every piece of sidebar state that depends on activation so dots
  // and counters update in real time. Includes Google stats + families
  // because deactivate_all_fonts (and future paths) now touch Google too.
  await Promise.all([
    get().loadFamilies(),
    get().loadFolderTrees(),
    get().loadActiveIds(),
    get().loadCollections(),
    get().loadStats(),
    get().loadGoogleLibrary(),
  ]);
  // If the detail drawer is open, refresh its styles too.
  const selectedFamily = get().selectedFamily;
  if (selectedFamily) {
    await get().openFamily(selectedFamily);
  }
}

let unlistenProgress: UnlistenFn | null = null;

export async function initScanProgressListener() {
  if (unlistenProgress) return;
  unlistenProgress = await listen<ScanProgressEvent>("scan-progress", (e) => {
    useStore.setState({ progress: e.payload });
  });
}

let unlistenGoogleProgress: UnlistenFn | null = null;

/**
 * Subscribe to per-variant Google activation progress. Events are
 * *batched* into ~120 ms windows before mutating the store — during a
 * bulk activate we can receive 60+ events per second, each of which
 * previously triggered an O(googleFamilies) map + multiple React
 * re-renders. Collecting them and applying once per frame-ish cuts the
 * work by an order of magnitude while still feeling live.
 *
 * Safe to call multiple times; the listener only registers once.
 */
export async function initGoogleDownloadProgressListener() {
  if (unlistenGoogleProgress) return;

  let pending: Array<{
    family: string;
    variant: string;
    status: "activated" | "error";
  }> = [];
  let flushScheduled = false;
  const FLUSH_MS = 120;

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    setTimeout(() => {
      const events = pending;
      pending = [];
      flushScheduled = false;
      if (events.length === 0) return;
      applyProgressBatch(events);
    }, FLUSH_MS);
  }

  unlistenGoogleProgress = await listen<GoogleDownloadProgressPayload>(
    "google-download-progress",
    (e) => {
      const { family, variant, status } = e.payload;
      // Both "activated" and "error" release the per-variant loading
      // target — the difference is whether we bump the optimistic active
      // count. Error events still need to stop the variant's spinning
      // arc; otherwise it would spin forever on a failed activation.
      if (status !== "activated" && status !== "error") return;
      pending.push({ family, variant, status });
      scheduleFlush();
    },
  );
}

function applyProgressBatch(
  events: Array<{
    family: string;
    variant: string;
    status: "activated" | "error";
  }>,
) {
  useStore.setState((s) => {
    // Every event clears its per-variant loading target — regardless of
    // whether the activation succeeded or failed.
    const nextActivating = new Set(s.activatingTargets);
    for (const { family, variant } of events) {
      nextActivating.delete(`google-variant:${family}:${variant}`);
    }

    // Only "activated" events drive the optimistic count bump; "error"
    // events just clear the spinner.
    const addedByFamily = new Map<string, Set<string>>();
    for (const { family, variant, status } of events) {
      if (status !== "activated") continue;
      const alreadyActive = s.googleActiveVariants[family]?.has(variant);
      if (alreadyActive) continue;
      let bucket = addedByFamily.get(family);
      if (!bucket) {
        bucket = new Set();
        addedByFamily.set(family, bucket);
      }
      bucket.add(variant);
    }

    if (addedByFamily.size === 0) {
      return { activatingTargets: nextActivating };
    }

    // Merge into googleActiveVariants — one new object per family touched.
    const nextVariantsByFamily: Record<string, Set<string>> = {
      ...s.googleActiveVariants,
    };
    for (const [family, adds] of addedByFamily) {
      const next = new Set(nextVariantsByFamily[family] ?? []);
      for (const v of adds) next.add(v);
      nextVariantsByFamily[family] = next;
    }

    // Single map pass over googleFamilies bumps every touched family at
    // once — previously each event did its own full map.
    let totalAdded = 0;
    const nextFamilies = s.googleFamilies.map((f) => {
      const adds = addedByFamily.get(f.familyName);
      if (!adds) return f;
      const delta = adds.size;
      totalAdded += delta;
      return {
        ...f,
        activeCount: Math.min(f.activeCount + delta, f.variantCount),
      };
    });

    const nextStats =
      totalAdded > 0
        ? {
            ...s.googleLibraryStats,
            active: s.googleLibraryStats.active + totalAdded,
          }
        : s.googleLibraryStats;

    return {
      activatingTargets: nextActivating,
      googleActiveVariants: nextVariantsByFamily,
      googleFamilies: nextFamilies,
      googleLibraryStats: nextStats,
    };
  });
}
