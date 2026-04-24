export type ScanPhase = "walking" | "parsing" | "saving" | "done";

export type ScanProgressEvent = {
  total: number;
  processed: number;
  added: number;
  errors: number;
  phase: ScanPhase;
  current: string | null;
};

export type ScanSummary = {
  totalFiles: number;
  facesAdded: number;
  errors: number;
  elapsedMs: number;
};

export type FamilySummary = {
  familyName: string;
  styles: number;
  activeCount: number;
  starredCount: number;
  classification: string;
  repId: number;
  filePath: string;
  ttcIndex: number;
  format: string;
  designer: string | null;
  collectionNames: string[];
};

export type Theme = "dark" | "light";

export type LibraryFilter = "all" | "starred" | "active";

export type ActivationState = "active" | "inactive" | "mixed";

export type ActivationResult = {
  activated: number;
  deactivated: number;
};

export type LibraryStats = {
  fonts: number;
  families: number;
};

export type ClassificationCount = {
  classification: string;
  families: number;
};

export type RootFolder = {
  path: string;
  addedAt: number;
};

export type Collection = {
  id: number;
  name: string;
  createdAt: number;
  familyCount: number;
  fontCount: number;
  activeFontCount: number;
};

export type ViewMode = "list" | "grid";

export type GoogleFontFamily = {
  family: string;
  category: string;
  variants: string[];
  subsets: string[];
};

export type GoogleFamilyRow = {
  familyName: string;
  category: string;
  variants: string[];
  variantCount: number;
  activeCount: number;
};

export type GoogleLibraryStats = {
  families: number;
  active: number;
};

/** Named instance of a variable font (e.g. Inconsolata → "Condensed Bold").
 *  Emitted by the Rust backend after parsing the cached TTF's fvar + name
 *  tables. Empty for non-VF families. */
export type GoogleNamedInstance = {
  name: string;
  /** Axis tag → coordinate. `[["wdth", 75], ["wght", 700]]` → CSS
   *  `font-variation-settings: 'wdth' 75, 'wght' 700`. */
  axes: Array<[string, number]>;
  /** Convenience: wght coord if present, else 400. */
  weight: number;
  /** Convenience: ital > 0.5 OR |slnt| > 1. */
  italic: boolean;
};

export type ExportResult = {
  copied: number;
  families: number;
  dest: string;
};

export type FolderNode = {
  name: string;
  path: string;
  fontCount: number;
  totalCount: number;
  activeCount: number;
  familyCount: number;
  activeFamilyCount: number;
  children: FolderNode[];
};

export type FontRow = {
  id: number;
  filePath: string;
  ttcIndex: number;
  familyName: string;
  subfamily: string | null;
  weight: number;
  italic: boolean;
  classification: string;
  format: string;
};

export type Classification =
  | "serif"
  | "sans"
  | "slab"
  | "monospace"
  | "script"
  | "display"
  | "unknown";
