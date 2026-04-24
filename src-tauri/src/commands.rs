use crate::activator;
use crate::db::{
    Collection, Db, FamilySummary, FolderNode, FontRow, GoogleFamilyRow, RootFolder,
};
use crate::error::{FontyError, Result};
use crate::google_fonts;
use crate::scanner::{self, ScanSummary};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct AppState {
    pub db: Arc<Db>,
}

impl AppState {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgressEvent {
    pub total: usize,
    pub processed: usize,
    pub added: usize,
    pub errors: usize,
    pub phase: &'static str,
    pub current: Option<String>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub fonts: i64,
    pub families: i64,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClassificationCount {
    pub classification: String,
    pub families: i64,
}

/// Per-variant progress event emitted during Google Fonts activation.
/// `status` values:
///   - `"activated"` — variant's TTF is on disk and loaded via AddFontResourceW.
///     Frontend can flip the variant's activation dot from loading to active.
///   - `"error"` — variant failed to activate. Frontend clears the loading
///     state without flipping the dot.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GoogleDownloadProgress {
    pub family: String,
    pub variant: String,
    pub status: &'static str,
}

fn emit_google_progress(
    app: &AppHandle,
    family: &str,
    variant: &str,
    status: &'static str,
) {
    let _ = app.emit(
        "google-download-progress",
        GoogleDownloadProgress {
            family: family.to_string(),
            variant: variant.to_string(),
            status,
        },
    );
}

/// Result payload for `remove_google_family` and the Settings inactive-sweep.
/// Bytes are surfaced to the user so the toast can say "Freed 3.4 MB".
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoveGoogleResult {
    pub deactivated: usize,
    pub files_removed: usize,
    pub bytes_removed: u64,
}

#[tauri::command]
pub async fn scan_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<ScanSummary> {
    let path = PathBuf::from(&path);
    if !path.is_dir() {
        return Err(FontyError::Msg(format!(
            "not a directory: {}",
            path.display()
        )));
    }

    state.db.add_root(&path.to_string_lossy())?;

    let db = state.db.clone();
    let app_for_thread = app.clone();

    let summary = tauri::async_runtime::spawn_blocking(move || {
        let last_emit = AtomicU64::new(0);
        let start = Instant::now();
        scanner::scan(&path, &db, |p| {
            let now_ms = start.elapsed().as_millis() as u64;
            let last = last_emit.load(Ordering::Relaxed);
            let is_final = matches!(p.phase, "saving" | "done" | "walking");
            if is_final || now_ms.saturating_sub(last) >= 120 {
                last_emit.store(now_ms, Ordering::Relaxed);
                let _ = app_for_thread.emit(
                    "scan-progress",
                    ScanProgressEvent {
                        total: p.total,
                        processed: p.processed,
                        added: p.added,
                        errors: p.errors,
                        phase: p.phase,
                        current: p.current.map(|p| p.display().to_string()),
                    },
                );
            }
        })
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))??;

    Ok(summary)
}

#[tauri::command]
pub fn library_stats(state: State<'_, AppState>) -> Result<LibraryStats> {
    Ok(LibraryStats {
        fonts: state.db.font_count()?,
        families: state.db.family_count()?,
    })
}

#[tauri::command]
pub fn list_families(
    state: State<'_, AppState>,
    folder_filter: Option<String>,
    collection_id: Option<i64>,
) -> Result<Vec<FamilySummary>> {
    state
        .db
        .list_families(folder_filter.as_deref(), collection_id)
}

#[tauri::command]
pub fn folder_trees(state: State<'_, AppState>) -> Result<Vec<FolderNode>> {
    state.db.folder_trees()
}

// ----- Collections -----

#[tauri::command]
pub fn list_collections(state: State<'_, AppState>) -> Result<Vec<Collection>> {
    state.db.list_collections()
}

#[tauri::command]
pub fn create_collection(
    state: State<'_, AppState>,
    name: String,
) -> Result<i64> {
    let name = name.trim();
    if name.is_empty() {
        return Err(FontyError::Msg("collection name cannot be empty".into()));
    }
    state.db.create_collection(name)
}

#[tauri::command]
pub fn rename_collection(
    state: State<'_, AppState>,
    id: i64,
    name: String,
) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(FontyError::Msg("collection name cannot be empty".into()));
    }
    state.db.rename_collection(id, name)
}

#[tauri::command]
pub fn delete_collection(state: State<'_, AppState>, id: i64) -> Result<()> {
    state.db.delete_collection(id)
}

#[tauri::command]
pub fn add_family_to_collection(
    state: State<'_, AppState>,
    collection_id: i64,
    family_name: String,
) -> Result<()> {
    let ids = state.db.ids_in_family(&family_name)?;
    state.db.add_fonts_to_collection(collection_id, &ids)
}

#[tauri::command]
pub fn remove_family_from_collection(
    state: State<'_, AppState>,
    collection_id: i64,
    family_name: String,
) -> Result<()> {
    let ids = state.db.ids_in_family(&family_name)?;
    state.db.remove_fonts_from_collection(collection_id, &ids)
}

#[tauri::command]
pub fn collections_for_family(
    state: State<'_, AppState>,
    family_name: String,
) -> Result<Vec<Collection>> {
    state.db.collections_for_family(&family_name)
}

#[tauri::command]
pub fn add_fonts_to_collection(
    state: State<'_, AppState>,
    collection_id: i64,
    font_ids: Vec<i64>,
) -> Result<()> {
    state.db.add_fonts_to_collection(collection_id, &font_ids)
}

#[tauri::command]
pub fn remove_fonts_from_collection(
    state: State<'_, AppState>,
    collection_id: i64,
    font_ids: Vec<i64>,
) -> Result<()> {
    state.db.remove_fonts_from_collection(collection_id, &font_ids)
}

#[tauri::command]
pub fn add_google_family_to_collection(
    state: State<'_, AppState>,
    collection_id: i64,
    family: String,
) -> Result<()> {
    state.db.add_google_family_to_collection(collection_id, &family)
}

#[tauri::command]
pub fn remove_google_family_from_collection(
    state: State<'_, AppState>,
    collection_id: i64,
    family: String,
) -> Result<()> {
    state
        .db
        .remove_google_family_from_collection(collection_id, &family)
}

#[tauri::command]
pub fn collection_google_family_names(
    state: State<'_, AppState>,
    collection_id: i64,
) -> Result<Vec<String>> {
    state.db.collection_google_family_names(collection_id)
}

#[tauri::command]
pub fn collections_for_google_family(
    state: State<'_, AppState>,
    family: String,
) -> Result<Vec<Collection>> {
    state.db.collections_for_google_family(&family)
}

#[tauri::command]
pub fn add_google_variant_to_collection(
    state: State<'_, AppState>,
    collection_id: i64,
    family: String,
    variant: String,
) -> Result<()> {
    state
        .db
        .add_google_variant_to_collection(collection_id, &family, &variant)
}

#[tauri::command]
pub fn remove_google_variant_from_collection(
    state: State<'_, AppState>,
    collection_id: i64,
    family: String,
    variant: String,
) -> Result<()> {
    state
        .db
        .remove_google_variant_from_collection(collection_id, &family, &variant)
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GoogleVariantRow {
    pub family: String,
    pub variant: String,
}

#[tauri::command]
pub fn collection_google_variants(
    state: State<'_, AppState>,
    collection_id: i64,
) -> Result<Vec<GoogleVariantRow>> {
    let rows = state.db.collection_google_variants(collection_id)?;
    Ok(rows
        .into_iter()
        .map(|(family, variant)| GoogleVariantRow { family, variant })
        .collect())
}

#[tauri::command]
pub fn collections_for_google_variant(
    state: State<'_, AppState>,
    family: String,
    variant: String,
) -> Result<Vec<Collection>> {
    state.db.collections_for_google_variant(&family, &variant)
}

#[tauri::command]
pub fn toggle_font_in_collection(
    state: State<'_, AppState>,
    collection_id: i64,
    font_id: i64,
) -> Result<bool> {
    state.db.toggle_font_in_collection(collection_id, font_id)
}

#[tauri::command]
pub fn toggle_family_in_collection(
    state: State<'_, AppState>,
    collection_id: i64,
    family_name: String,
) -> Result<bool> {
    state.db.toggle_family_in_collection(collection_id, &family_name)
}

#[tauri::command]
pub fn toggle_google_family_in_collection(
    state: State<'_, AppState>,
    collection_id: i64,
    family: String,
) -> Result<bool> {
    state.db.toggle_google_family_in_collection(collection_id, &family)
}

#[tauri::command]
pub fn toggle_google_variant_in_collection(
    state: State<'_, AppState>,
    collection_id: i64,
    family: String,
    variant: String,
) -> Result<bool> {
    state
        .db
        .toggle_google_variant_in_collection(collection_id, &family, &variant)
}

#[tauri::command]
pub fn collections_for_font(
    state: State<'_, AppState>,
    font_id: i64,
) -> Result<Vec<Collection>> {
    state.db.collections_for_font(font_id)
}

#[tauri::command]
pub async fn activate_collection(
    state: State<'_, AppState>,
    collection_id: i64,
) -> Result<ActivationResult> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ids = db.collection_font_ids(collection_id)?;
        activate_ids(&db, &ids)
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn deactivate_collection(
    state: State<'_, AppState>,
    collection_id: i64,
) -> Result<ActivationResult> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ids = db.collection_font_ids(collection_id)?;
        deactivate_ids(&db, &ids)
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub copied: usize,
    pub families: usize,
    pub dest: String,
}

#[tauri::command]
pub async fn export_collection(
    state: State<'_, AppState>,
    collection_id: i64,
    dest_dir: String,
    collection_name: String,
) -> Result<ExportResult> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<ExportResult> {
        let rows = db.collection_export_rows(collection_id)?;
        if rows.is_empty() {
            return Err(FontyError::Msg("collection is empty".into()));
        }
        let safe_name = sanitize_file_name(&collection_name);
        let root = Path::new(&dest_dir).join(&safe_name);
        fs::create_dir_all(&root)?;
        let mut copied = 0usize;
        let mut families_seen: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        let mut files_seen: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        for (family, file_path) in &rows {
            families_seen.insert(family.clone());
            let family_dir = root.join(sanitize_file_name(family));
            fs::create_dir_all(&family_dir)?;
            // copy every sibling file (same stem, different extension) for this font
            let siblings = db.sibling_font_files(file_path)?;
            for src in siblings {
                if !files_seen.insert(src.clone()) {
                    continue;
                }
                let src_path = Path::new(&src);
                if let Some(file_name) = src_path.file_name() {
                    let dest = family_dir.join(file_name);
                    if dest.exists() {
                        continue;
                    }
                    if let Err(e) = fs::copy(src_path, &dest) {
                        tracing::warn!("copy {:?} -> {:?} failed: {}", src_path, dest, e);
                    } else {
                        copied += 1;
                    }
                }
            }
        }
        Ok(ExportResult {
            copied,
            families: families_seen.len(),
            dest: root.to_string_lossy().into_owned(),
        })
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

fn sanitize_file_name(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string()
}

// ----- Google Fonts -----

#[tauri::command]
pub async fn refresh_google_catalog(
    state: State<'_, AppState>,
) -> Result<usize> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<usize> {
        let raw = google_fonts::fetch_catalog_raw()?;
        let v: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| FontyError::Msg(format!("google catalog json: {e}")))?;
        let list = v
            .get("familyMetadataList")
            .and_then(|x| x.as_array())
            .ok_or_else(|| FontyError::Msg("missing familyMetadataList".into()))?;

        let mut out = Vec::with_capacity(list.len());
        for f in list {
            let family = match f.get("family").and_then(|x| x.as_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let category = f
                .get("category")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let variants: Vec<String> = f
                .get("fonts")
                .and_then(|x| x.as_object())
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            out.push((family, category, variants));
        }
        let n = out.len();
        db.upsert_google_families(&out)?;
        Ok(n)
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

#[tauri::command]
pub fn list_google_families(
    state: State<'_, AppState>,
) -> Result<Vec<GoogleFamilyRow>> {
    state.db.list_google_families()
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GoogleLibraryStats {
    pub families: i64,
    pub active: i64,
}

#[tauri::command]
pub fn google_library_stats(
    state: State<'_, AppState>,
) -> Result<GoogleLibraryStats> {
    Ok(GoogleLibraryStats {
        families: state.db.google_family_count()?,
        active: state.db.total_google_active()?,
    })
}

/// Shared activation body used by both the broadcasting wrapper and the
/// bulk `_no_broadcast` variant. Does everything EXCEPT the
/// `WM_FONTCHANGE` broadcast, so bulk callers can batch that into a single
/// message at the end of the whole operation.
fn activate_google_family_core(
    db: &Db,
    app_emit: &AppHandle,
    cache_root: &Path,
    family: &str,
) -> Result<usize> {
    let family_cache = google_fonts::cache_dir_for_family(cache_root, family);
    let variants = db.google_variants_for(family)?;

    // The user just asked to activate — cancel any pending 5-minute
    // cache wipe so the files stay on disk regardless of outcome.
    let _ = db.unmark_google_pending_wipe(family);

    let already_active: std::collections::HashSet<String> = db
        .list_google_activations_for_family(family)?
        .into_iter()
        .map(|r| r.variant)
        .collect();

    use std::sync::atomic::{AtomicUsize, Ordering};
    let activated_count = AtomicUsize::new(0);
    let error_count = AtomicUsize::new(0);
    let activate_one = |path: &std::path::Path, v: &google_fonts::FontVariant| {
        if already_active.contains(&v.variant) {
            emit_google_progress(app_emit, family, &v.variant, "activated");
            return;
        }
        let n = match activator::add_font_resource(path) {
            Ok(n) => n,
            Err(e) => {
                tracing::warn!("add_font_resource failed for {:?}: {}", path, e);
                emit_google_progress(app_emit, family, &v.variant, "error");
                error_count.fetch_add(1, Ordering::Relaxed);
                return;
            }
        };
        if n == 0 {
            tracing::warn!(
                "AddFontResourceW returned 0 for Google font {:?} — skipping",
                path
            );
            emit_google_progress(app_emit, family, &v.variant, "error");
            error_count.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let reg_name = google_fonts::registry_display_name(family, &v.variant);
        if let Err(e) = activator::register_font(&reg_name, path) {
            tracing::warn!(
                "register_font failed for Google {family}/{}: {e}",
                v.variant
            );
            let _ = activator::remove_font_resource(path);
            emit_google_progress(app_emit, family, &v.variant, "error");
            error_count.fetch_add(1, Ordering::Relaxed);
            return;
        }
        if let Err(e) = db.record_google_activation(
            family,
            &v.variant,
            &path.to_string_lossy(),
            v.weight,
            v.italic,
            &reg_name,
        ) {
            tracing::warn!("record_google_activation {family}/{}: {e}", v.variant);
            emit_google_progress(app_emit, family, &v.variant, "error");
            error_count.fetch_add(1, Ordering::Relaxed);
            return;
        }
        activated_count.fetch_add(1, Ordering::Relaxed);
        emit_google_progress(app_emit, family, &v.variant, "activated");
    };

    let stream_result = google_fonts::try_google_css_java_streaming(
        family,
        &variants,
        &family_cache,
        activate_one,
    );
    if let Err(e) = stream_result {
        tracing::warn!(
            "google-css streaming failed for {}: {} — falling back",
            family,
            e
        );
        let fallback = google_fonts::resolve_variants(family, &variants, &family_cache)?;
        for (path, v) in &fallback {
            activate_one(path, v);
        }
    }

    let activated = activated_count.load(Ordering::Relaxed);
    let errored = error_count.load(Ordering::Relaxed);

    if activated == 0 && already_active.is_empty() && errored > 0 {
        return Err(FontyError::Msg(format!(
            "Windows won't load '{family}' — every downloaded variant \
             was rejected by the system font loader. This usually \
             happens with complex-script fonts (Telugu, some Khmer) \
             that Windows' GDI can't handle. The files are cached; \
             nothing FONTY can do to force load them."
        )));
    }
    Ok(activated + already_active.len())
}

/// Default Tauri command — single-family activate, broadcasts
/// `WM_FONTCHANGE` once at the end so Word/Affinity refresh their pickers.
#[tauri::command]
pub async fn activate_google_family(
    app: AppHandle,
    state: State<'_, AppState>,
    family: String,
) -> Result<usize> {
    let db = state.db.clone();
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| FontyError::Msg(format!("cache dir: {e}")))?;
    let app_emit = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<usize> {
        let n = activate_google_family_core(&db, &app_emit, &cache_root, &family)?;
        if n > 0 {
            activator::broadcast_font_change();
        }
        Ok(n)
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

/// Bulk-mode activate: same logic as `activate_google_family` but SKIPS
/// the `WM_FONTCHANGE` broadcast. Meant to be called in a loop by the
/// frontend's pMap worker during category / activate-all batches; the
/// caller invokes `google_broadcast_font_change` once after the whole
/// batch finishes. Saves the 10 ms–1 s broadcast cost per family — often
/// the dominant wall-clock expense in a 48-family category on slow apps.
#[tauri::command]
pub async fn activate_google_family_no_broadcast(
    app: AppHandle,
    state: State<'_, AppState>,
    family: String,
) -> Result<usize> {
    let db = state.db.clone();
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| FontyError::Msg(format!("cache dir: {e}")))?;
    let app_emit = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<usize> {
        activate_google_family_core(&db, &app_emit, &cache_root, &family)
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

/// Fire a single `WM_FONTCHANGE` broadcast — used by the frontend after a
/// bulk activate batch built with `activate_google_family_no_broadcast`
/// so one message covers every new variant Windows just saw.
#[tauri::command]
pub async fn google_broadcast_font_change() -> Result<()> {
    tauri::async_runtime::spawn_blocking(|| {
        activator::broadcast_font_change();
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?;
    Ok(())
}

/// Batch CSS prefetch — one HTTP request per 20 families populates the
/// shared URL cache so each family's subsequent activate skips its own
/// metadata round-trip. Frontend calls this at the top of category /
/// activate-all flows; the returned count is for diagnostics only.
#[tauri::command]
pub async fn prefetch_google_css(
    state: State<'_, AppState>,
    families: Vec<String>,
) -> Result<usize> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<usize> {
        let mut pairs: Vec<(String, Vec<String>)> = Vec::with_capacity(families.len());
        for f in &families {
            let vs = db.google_variants_for(f).unwrap_or_default();
            pairs.push((f.clone(), vs));
        }
        let n = pairs.len();
        google_fonts::prefetch_css_for_families(&pairs)?;
        Ok(n)
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

/// Activate a single Google Fonts variant (e.g. "Roboto"/"700italic").
/// Downloads the whole family's TTF zip if it isn't cached yet, then
/// registers only the requested variant.
#[tauri::command]
pub async fn activate_google_variant(
    app: AppHandle,
    state: State<'_, AppState>,
    family: String,
    variant: String,
) -> Result<()> {
    let db = state.db.clone();
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| FontyError::Msg(format!("cache dir: {e}")))?;
    let app_emit = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        let already = db
            .list_google_activations_for_family(&family)?
            .into_iter()
            .any(|r| r.variant == variant);
        if already {
            return Ok(());
        }

        // User is reactivating — cancel any pending 5-minute cache wipe.
        let _ = db.unmark_google_pending_wipe(&family);

        let family_cache = google_fonts::cache_dir_for_family(&cache_root, &family);
        // Only resolve THIS one variant. Saves massive bandwidth when the
        // user clicks a single style on an 18-variant family — we used to
        // pull every variant just to activate one.
        let requested = vec![variant.clone()];
        let files =
            google_fonts::resolve_variants(&family, &requested, &family_cache)?;
        let matched = files.iter().find(|(_, v)| v.variant == variant);
        let (path, v) = match matched {
            Some(m) => m,
            None => {
                emit_google_progress(&app_emit, &family, &variant, "error");
                return Err(FontyError::Msg(format!(
                    "Variant '{variant}' of '{family}' wasn't in the download"
                )));
            }
        };
        let reg_name = google_fonts::registry_display_name(&family, &v.variant);
        activator::register_font(&reg_name, path)?;
        let n = activator::add_font_resource(path)?;
        if n == 0 {
            let _ = activator::unregister_font(&reg_name);
            emit_google_progress(&app_emit, &family, &variant, "error");
            return Err(FontyError::Msg(format!(
                "Windows rejected '{variant}' of '{family}'"
            )));
        }
        db.record_google_activation(
            &family,
            &v.variant,
            &path.to_string_lossy(),
            v.weight,
            v.italic,
            &reg_name,
        )?;
        activator::broadcast_font_change();
        emit_google_progress(&app_emit, &family, &variant, "activated");
        Ok(())
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

/// Deactivate just one Google variant. Family-level rows remain active.
#[tauri::command]
pub async fn deactivate_google_variant(
    state: State<'_, AppState>,
    family: String,
    variant: String,
) -> Result<()> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        let rows = db.list_google_activations_for_family(&family)?;
        for row in &rows {
            if row.variant != variant {
                continue;
            }
            // Reconstruct legacy names missing from the DB so the HKCU
            // entry is actually removed — critical for Word/Affinity to
            // drop the font from their picker.
            let reg_name = if row.registry_key.is_empty() {
                google_fonts::registry_display_name(&row.family_name, &row.variant)
            } else {
                row.registry_key.clone()
            };
            let _ = activator::unregister_font(&reg_name);
            let _ = activator::remove_font_resource(Path::new(&row.cached_path));
            // Cache file kept for fast re-activation.
            db.delete_google_activation(&row.family_name, &row.variant)?;
        }
        // If this was the last active variant in the family, start the
        // 5-minute wipe timer. If other variants are still active, leave
        // the family alone — the cache stays until the whole family is dark.
        if db.list_google_activations_for_family(&family)?.is_empty() {
            let _ = db.mark_google_pending_wipe(&family);
        }
        activator::broadcast_font_change();
        Ok(())
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

#[tauri::command]
pub fn google_active_variants_for(
    state: State<'_, AppState>,
    family: String,
) -> Result<Vec<String>> {
    Ok(state
        .db
        .list_google_activations_for_family(&family)?
        .into_iter()
        .map(|r| r.variant)
        .collect())
}

/// Named instances exposed by a Google family's cached variable-font file
/// (e.g. Inconsolata → Thin Condensed, Bold Condensed, Bold Wide, …).
/// Returns an empty list for non-VF families, or when the family hasn't been
/// downloaded yet. Frontend calls this when the styles tray opens; if the
/// list is non-empty, the tray shows these alongside the catalog variants.
#[tauri::command]
pub async fn google_named_instances(
    app: AppHandle,
    family: String,
) -> Result<Vec<google_fonts::NamedInstance>> {
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| FontyError::Msg(format!("cache dir: {e}")))?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<google_fonts::NamedInstance>> {
        Ok(google_fonts::read_named_instances_for_family(&cache_root, &family))
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn deactivate_google_family(
    state: State<'_, AppState>,
    family: String,
) -> Result<usize> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<usize> {
        let rows = db.list_google_activations_for_family(&family)?;
        // Open HKCU once for the whole batch. For legacy rows that predate
        // the registry_key column, reconstruct the HKCU entry name the same
        // way activation did — otherwise the font lingers in Word/Affinity
        // because Windows still has the HKCU entry pointing at the file.
        let reconstructed: Vec<String> = rows
            .iter()
            .map(|r| {
                if r.registry_key.is_empty() {
                    google_fonts::registry_display_name(&r.family_name, &r.variant)
                } else {
                    r.registry_key.clone()
                }
            })
            .collect();
        let reg_keys: Vec<&str> = reconstructed.iter().map(|s| s.as_str()).collect();
        let _ = activator::unregister_fonts_batch(&reg_keys);
        // Files stay on disk for the 5-minute grace window — the janitor
        // will wipe them if the family is still inactive at that point. If
        // the user reactivates inside the window the pending-wipe row is
        // cleared and the cache survives.
        for row in &rows {
            let _ = activator::remove_font_resource(Path::new(&row.cached_path));
            db.delete_google_activation(&row.family_name, &row.variant)?;
        }
        let count = rows.len();
        if count > 0 {
            activator::broadcast_font_change();
            let _ = db.mark_google_pending_wipe(&family);
        }
        Ok(count)
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn deactivate_all_google(
    state: State<'_, AppState>,
) -> Result<usize> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<usize> {
        deactivate_all_google_inner(&db)
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

pub fn deactivate_all_google_inner(db: &Db) -> Result<usize> {
    let rows = db.list_google_activations()?;
    if rows.is_empty() {
        return Ok(0);
    }
    let reg_keys: Vec<&str> = rows
        .iter()
        .filter_map(|r| {
            if r.registry_key.is_empty() {
                None
            } else {
                Some(r.registry_key.as_str())
            }
        })
        .collect();
    let _ = activator::unregister_fonts_batch(&reg_keys);
    for row in &rows {
        let _ = activator::remove_font_resource(Path::new(&row.cached_path));
        // Cache files are kept for fast re-activation; Clear Cache action
        // in Settings is the intentional way to free disk space.
        db.delete_google_activation(&row.family_name, &row.variant)?;
    }
    activator::broadcast_font_change();
    Ok(rows.len())
}

#[tauri::command]
pub fn active_font_ids(state: State<'_, AppState>) -> Result<Vec<i64>> {
    state.db.active_font_ids()
}

#[tauri::command]
pub fn starred_font_ids(state: State<'_, AppState>) -> Result<Vec<i64>> {
    state.db.starred_font_ids()
}

#[tauri::command]
pub fn count_user_fonts() -> Result<usize> {
    activator::count_hkcu_fonts()
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClearResult {
    pub cleared: usize,
}

#[tauri::command]
pub async fn deactivate_all_fonts(state: State<'_, AppState>) -> Result<ActivationResult> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Covers BOTH local activations and any Google Fonts that were
        // loaded this session — users expect "Deactivate all Fonty fonts"
        // to mean everything FONTY ever touched, not just the local half.
        let ids = db.active_font_ids()?;
        let local = deactivate_ids(&db, &ids)?;
        let google = deactivate_all_google_inner(&db).unwrap_or(0);
        Ok(ActivationResult {
            activated: local.activated,
            deactivated: local.deactivated + google,
        })
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn uninstall_user_installed_fonts(
    state: State<'_, AppState>,
) -> Result<ClearResult> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<ClearResult> {
        let cleared = activator::uninstall_user_installed_fonts()?;
        // Our activations table points at files that may no longer exist
        // — sync it so the UI doesn't think fonts are still active.
        let active = db.active_font_ids()?;
        db.record_deactivations(&active)?;
        let _ = deactivate_all_google_inner(&db);
        Ok(ClearResult { cleared })
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn clear_user_fonts_registry(state: State<'_, AppState>) -> Result<ClearResult> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<ClearResult> {
        let cleared = activator::clear_all_hkcu_fonts()?;
        // Also clear our own activations table (otherwise state is out of sync)
        let active = db.active_font_ids()?;
        db.record_deactivations(&active)?;
        Ok(ClearResult { cleared })
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

#[tauri::command]
pub fn star_fonts(state: State<'_, AppState>, ids: Vec<i64>) -> Result<()> {
    state.db.star_fonts(&ids)
}

#[tauri::command]
pub fn unstar_fonts(state: State<'_, AppState>, ids: Vec<i64>) -> Result<()> {
    state.db.unstar_fonts(&ids)
}

#[tauri::command]
pub fn star_family(state: State<'_, AppState>, family_name: String) -> Result<()> {
    let ids = state.db.ids_in_family(&family_name)?;
    state.db.star_fonts(&ids)
}

#[tauri::command]
pub fn unstar_family(state: State<'_, AppState>, family_name: String) -> Result<()> {
    let ids = state.db.ids_in_family(&family_name)?;
    state.db.unstar_fonts(&ids)
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActivationResult {
    pub activated: usize,
    pub deactivated: usize,
}

#[tauri::command]
pub async fn activate_fonts(
    state: State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<ActivationResult> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || activate_ids(&db, &ids))
        .await
        .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn deactivate_fonts(
    state: State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<ActivationResult> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || deactivate_ids(&db, &ids))
        .await
        .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn activate_family(
    state: State<'_, AppState>,
    family_name: String,
) -> Result<ActivationResult> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ids = db.ids_in_family(&family_name)?;
        activate_ids(&db, &ids)
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn deactivate_family(
    state: State<'_, AppState>,
    family_name: String,
) -> Result<ActivationResult> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ids = db.ids_in_family(&family_name)?;
        deactivate_ids(&db, &ids)
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn activate_folder(
    state: State<'_, AppState>,
    path: String,
) -> Result<ActivationResult> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ids = db.ids_in_folder(&path)?;
        activate_ids(&db, &ids)
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn deactivate_folder(
    state: State<'_, AppState>,
    path: String,
) -> Result<ActivationResult> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ids = db.ids_in_folder(&path)?;
        deactivate_ids(&db, &ids)
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

fn activate_ids(db: &Db, ids: &[i64]) -> Result<ActivationResult> {
    let already_active: std::collections::HashSet<i64> =
        db.active_font_ids()?.into_iter().collect();
    let to_activate: Vec<i64> = ids
        .iter()
        .copied()
        .filter(|id| !already_active.contains(id))
        .collect();
    if to_activate.is_empty() {
        return Ok(ActivationResult {
            activated: 0,
            deactivated: 0,
        });
    }
    let infos = db.get_activation_info(&to_activate)?;
    let mut records: Vec<(i64, String)> = Vec::with_capacity(infos.len());
    for info in &infos {
        // Session-only activation: AddFontResourceW loads the font into the
        // current user session (visible to Word/Affinity/etc via WM_FONTCHANGE).
        // We deliberately do NOT write to HKCU so the OS doesn't treat it as
        // a persistent per-user install — it evaporates on FONTY close or logoff.
        let path = Path::new(&info.file_path);
        let _ = activator::add_font_resource(path);
        records.push((info.id, String::new()));
    }
    let activated = records.len();
    db.record_activations(&records)?;
    activator::broadcast_font_change();
    Ok(ActivationResult {
        activated,
        deactivated: 0,
    })
}

fn deactivate_ids(db: &Db, ids: &[i64]) -> Result<ActivationResult> {
    let records = db.get_active_records(ids)?;
    if records.is_empty() {
        return Ok(ActivationResult {
            activated: 0,
            deactivated: 0,
        });
    }
    for rec in &records {
        // Legacy: earlier FONTY versions wrote HKCU entries. Clean those
        // up if the record still carries a registry key so existing users
        // don't have stale persistent entries.
        if !rec.registry_key.is_empty() {
            let _ = activator::unregister_font(&rec.registry_key);
        }
        let _ = activator::remove_font_resource(Path::new(&rec.file_path));
    }
    let ids_to_remove: Vec<i64> = records.iter().map(|r| r.font_id).collect();
    let deactivated = ids_to_remove.len();
    db.record_deactivations(&ids_to_remove)?;
    activator::broadcast_font_change();
    Ok(ActivationResult {
        activated: 0,
        deactivated,
    })
}

/// Fully unload every currently-active font AND clear the activations
/// table. Used for the "Deactivate all Fonty fonts" maintenance action
/// and whenever `restore_active_on_launch` is off so launches start clean.
pub fn deactivate_all_session(db: &Db) -> Result<()> {
    let ids = db.active_font_ids()?;
    if !ids.is_empty() {
        let _ = deactivate_ids(db, &ids)?;
    }
    // Also nuke any Google Fonts that got activated during the session.
    let _ = deactivate_all_google_inner(db);
    Ok(())
}

/// Release session fonts (RemoveFontResourceW) WITHOUT touching the
/// activations / google_activations tables. Called on tray Quit when
/// the user wants their active set remembered for the next launch.
pub fn release_session_fonts(db: &Db) -> Result<()> {
    let records = db.get_all_active_records()?;
    for rec in &records {
        let _ = activator::remove_font_resource(Path::new(&rec.file_path));
    }
    // Google activations: unload but keep the rows so reapply can find them.
    let google = db.list_google_activations()?;
    for rec in &google {
        let _ = activator::remove_font_resource(Path::new(&rec.cached_path));
    }
    if !records.is_empty() || !google.is_empty() {
        activator::broadcast_font_change();
    }
    Ok(())
}

/// Reapply every activation row to the running Windows session. Called on
/// startup when `restore_active_on_launch` is on. Missing font files (user
/// moved them) are skipped silently — we don't prune the DB because the
/// file might come back.
pub fn reapply_active_session(db: &Db) -> Result<()> {
    // Skip the explicit `p.exists()` stat per row — on large sets (e.g. a
    // user who activated thousands of Google variants) each NTFS stat is
    // 1–5 ms, which adds up to many seconds of pure blocking time. Trust
    // AddFontResourceW's return value instead: 0 means Windows couldn't
    // load the file (missing or rejected), and the GDI call itself is
    // cheaper than the stat.
    let start = std::time::Instant::now();
    let records = db.get_all_active_records()?;
    let google = db.list_google_activations()?;
    let total = records.len() + google.len();
    let mut loaded = 0usize;
    for rec in &records {
        let n = activator::add_font_resource(Path::new(&rec.file_path))
            .unwrap_or(0);
        if n > 0 {
            loaded += 1;
        }
    }
    for rec in &google {
        let n = activator::add_font_resource(Path::new(&rec.cached_path))
            .unwrap_or(0);
        if n > 0 {
            loaded += 1;
        }
    }
    if loaded > 0 {
        activator::broadcast_font_change();
    }
    tracing::info!(
        "restore-on-launch: {}/{} fonts reapplied in {} ms",
        loaded,
        total,
        start.elapsed().as_millis()
    );
    Ok(())
}

const RESTORE_SETTING_KEY: &str = "restore_active_on_launch";

pub fn read_restore_on_launch(db: &Db) -> bool {
    // Default on — users expect their active set to survive restarts.
    match db.get_setting(RESTORE_SETTING_KEY) {
        Ok(Some(v)) => v != "false",
        _ => true,
    }
}

#[tauri::command]
pub fn get_restore_on_launch(state: State<'_, AppState>) -> Result<bool> {
    Ok(read_restore_on_launch(&state.db))
}

#[tauri::command]
pub async fn clear_google_cache(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize> {
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| FontyError::Msg(format!("cache dir: {e}")))?;
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<usize> {
        // cache_root typically points at FONTY's app_cache_dir root; Google
        // families are stored as subfolders of it. clear_cache_root walks
        // direct children + one level of subfolders.
        let n = google_fonts::clear_cache_root(&cache_root)?;
        // Wiping every cache file implicitly resolves any pending wipes too.
        let pending = db.list_overdue_google_wipes(0)?;
        for f in &pending {
            let _ = db.unmark_google_pending_wipe(f);
        }
        Ok(n)
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

/// Full-on deactivate + wipe cache for a single family. Bypasses the 5-min
/// grace period. Surfaced in the Google family context menu as
/// "Remove from PC".
#[tauri::command]
pub async fn remove_google_family(
    app: AppHandle,
    state: State<'_, AppState>,
    family: String,
) -> Result<RemoveGoogleResult> {
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| FontyError::Msg(format!("cache dir: {e}")))?;
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<RemoveGoogleResult> {
        // 1. Deactivate (reuses the existing batched path). Reconstruct
        //    legacy reg names so fonts from pre-registry_key rows also get
        //    unregistered from HKCU — otherwise Word keeps them in its list.
        let rows = db.list_google_activations_for_family(&family)?;
        let reconstructed: Vec<String> = rows
            .iter()
            .map(|r| {
                if r.registry_key.is_empty() {
                    google_fonts::registry_display_name(&r.family_name, &r.variant)
                } else {
                    r.registry_key.clone()
                }
            })
            .collect();
        let reg_keys: Vec<&str> = reconstructed.iter().map(|s| s.as_str()).collect();
        let _ = activator::unregister_fonts_batch(&reg_keys);
        for row in &rows {
            let _ = activator::remove_font_resource(Path::new(&row.cached_path));
            db.delete_google_activation(&row.family_name, &row.variant)?;
        }
        let deactivated = rows.len();
        if deactivated > 0 {
            activator::broadcast_font_change();
        }
        // 2. Cancel any pending janitor wipe — we're doing it now.
        let _ = db.unmark_google_pending_wipe(&family);
        // 3. Wipe the family's cache directory immediately.
        let (files, bytes) = google_fonts::remove_family_cache(&cache_root, &family);
        Ok(RemoveGoogleResult {
            deactivated,
            files_removed: files,
            bytes_removed: bytes,
        })
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

/// Total bytes of the Google Fonts cache. Surfaced in the Settings card
/// next to the cache-clearing buttons so the user can see how much disk
/// each action will reclaim.
#[tauri::command]
pub async fn google_cache_size(app: AppHandle) -> Result<u64> {
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| FontyError::Msg(format!("cache dir: {e}")))?;
    tauri::async_runtime::spawn_blocking(move || -> Result<u64> {
        Ok(google_fonts::cache_size_total(&cache_root))
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

/// Grace period in seconds between a full-family deactivate and the janitor
/// wiping its cache files. 5 minutes matches Adria's design note — fast
/// re-activation for "oops, put that back", auto-reclaim for "I meant it".
pub const GOOGLE_CACHE_WIPE_GRACE_SECS: i64 = 300;

/// One tick of the janitor loop — finds families whose grace period has
/// elapsed, verifies they still have zero active variants (defensive against
/// races where someone reactivated between list and delete), wipes their
/// cache directory, and clears the pending-wipe row. Safe to call on any
/// thread. Called every 60s from the background task spawned in lib.rs.
pub fn run_google_cache_janitor_once(db: &Db, cache_root: &Path) -> Result<usize> {
    let overdue = db.list_overdue_google_wipes(GOOGLE_CACHE_WIPE_GRACE_SECS)?;
    let mut wiped = 0usize;
    for family in &overdue {
        // Defensive: if the user reactivated after the SELECT, skip the
        // wipe and drop the pending row.
        let still_inactive = db
            .list_google_activations_for_family(family)?
            .is_empty();
        if !still_inactive {
            let _ = db.unmark_google_pending_wipe(family);
            continue;
        }
        let (files, bytes) = google_fonts::remove_family_cache(cache_root, family);
        // Only clear the pending-wipe row if the wipe actually finished. If
        // the directory still exists (Windows is holding a handle on a TTF
        // from another process), leave the row so the next 60-second tick
        // retries. Prevents the "locked once, leaked forever" leak of the
        // first cut.
        let dir = google_fonts::cache_dir_for_family(cache_root, family);
        if !dir.exists() {
            let _ = db.unmark_google_pending_wipe(family);
        } else {
            tracing::info!(
                "google cache janitor: {family} still locked — will retry next tick"
            );
        }
        if files > 0 || bytes > 0 {
            tracing::info!(
                "google cache janitor: wiped {family} — {files} files, {bytes} bytes"
            );
            wiped += 1;
        }
    }
    Ok(wiped)
}

/// Settings sweep: delete every cached family directory that doesn't have
/// an active variant in `google_activations`. Keeps the user's actively-
/// used cache intact. Also clears pending-wipe rows for the swept families.
#[tauri::command]
pub async fn clear_inactive_google_cache(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RemoveGoogleResult> {
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| FontyError::Msg(format!("cache dir: {e}")))?;
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<RemoveGoogleResult> {
        let active = db.active_google_family_names()?;
        let active_dirs: std::collections::HashSet<String> =
            active.iter().map(|f| google_fonts::family_dir_name(f)).collect();
        let (files, bytes) =
            google_fonts::clear_inactive_cache(&cache_root, &active_dirs);
        // Any pending wipe for a now-gone family is a no-op; clear the rows.
        let pending = db.list_overdue_google_wipes(0)?;
        for f in &pending {
            if !active.contains(f) {
                let _ = db.unmark_google_pending_wipe(f);
            }
        }
        Ok(RemoveGoogleResult {
            deactivated: 0,
            files_removed: files,
            bytes_removed: bytes,
        })
    })
    .await
    .map_err(|e| FontyError::Msg(format!("join error: {e}")))?
}

#[tauri::command]
pub fn set_restore_on_launch(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<()> {
    state.db.set_setting(
        RESTORE_SETTING_KEY,
        Some(if enabled { "true" } else { "false" }),
    )
}

#[tauri::command]
pub fn classification_counts(state: State<'_, AppState>) -> Result<Vec<ClassificationCount>> {
    let rows = state.db.classification_counts()?;
    Ok(rows
        .into_iter()
        .map(|(classification, families)| ClassificationCount {
            classification,
            families,
        })
        .collect())
}

#[tauri::command]
pub fn list_roots(state: State<'_, AppState>) -> Result<Vec<RootFolder>> {
    state.db.list_roots()
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoveRootResult {
    pub removed_fonts: usize,
}

#[tauri::command]
pub fn remove_root(
    state: State<'_, AppState>,
    path: String,
) -> Result<RemoveRootResult> {
    let removed = state.db.remove_root(&path)?;
    Ok(RemoveRootResult {
        removed_fonts: removed,
    })
}

#[tauri::command]
pub fn list_family_styles(
    state: State<'_, AppState>,
    family_name: String,
    collection_id: Option<i64>,
) -> Result<Vec<FontRow>> {
    state.db.list_family_styles(&family_name, collection_id)
}
