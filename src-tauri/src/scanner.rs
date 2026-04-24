use crate::db::Db;
use crate::error::Result;
use crate::parser::{self, ParsedFont};
use rayon::prelude::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;
use walkdir::WalkDir;

#[derive(Debug, Clone)]
pub struct ScanProgress {
    pub total: usize,
    pub processed: usize,
    pub added: usize,
    pub errors: usize,
    pub current: Option<PathBuf>,
    pub phase: &'static str,
}

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub total_files: usize,
    pub faces_added: usize,
    pub errors: usize,
    pub elapsed_ms: u128,
}

pub fn scan<F>(root: &Path, db: &Db, progress: F) -> Result<ScanSummary>
where
    F: Fn(ScanProgress) + Send + Sync,
{
    let start = Instant::now();
    tracing::info!("scanning {:?}", root);

    progress(ScanProgress {
        total: 0,
        processed: 0,
        added: 0,
        errors: 0,
        current: None,
        phase: "walking",
    });

    let files: Vec<PathBuf> = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| is_font_file(e.path()))
        .map(|e| e.into_path())
        .collect();

    let total = files.len();
    tracing::info!("found {} font files", total);

    progress(ScanProgress {
        total,
        processed: 0,
        added: 0,
        errors: 0,
        current: None,
        phase: "parsing",
    });

    let processed = Arc::new(AtomicUsize::new(0));
    let errors = Arc::new(AtomicUsize::new(0));

    let parsed: Vec<ParsedFont> = files
        .par_iter()
        .flat_map_iter(|path| {
            let n = processed.fetch_add(1, Ordering::Relaxed);
            let result = parser::parse_file(path);
            let out: Vec<ParsedFont> = match result {
                Ok(v) => v,
                Err(e) => {
                    tracing::debug!("parse fail {:?}: {}", path, e);
                    errors.fetch_add(1, Ordering::Relaxed);
                    Vec::new()
                }
            };
            progress(ScanProgress {
                total,
                processed: n + 1,
                added: 0,
                errors: errors.load(Ordering::Relaxed),
                current: Some(path.clone()),
                phase: "parsing",
            });
            out
        })
        .collect();

    let parse_done = start.elapsed();
    tracing::info!(
        "parsed {} faces from {} files in {:?}",
        parsed.len(),
        total,
        parse_done
    );

    progress(ScanProgress {
        total,
        processed: total,
        added: 0,
        errors: errors.load(Ordering::Relaxed),
        current: None,
        phase: "saving",
    });

    let added = db.upsert_batch(&parsed)?;
    tracing::info!("upserted {} rows", added);

    let summary = ScanSummary {
        total_files: total,
        faces_added: added,
        errors: errors.load(Ordering::Relaxed),
        elapsed_ms: start.elapsed().as_millis(),
    };

    progress(ScanProgress {
        total,
        processed: total,
        added,
        errors: summary.errors,
        current: None,
        phase: "done",
    });

    Ok(summary)
}

fn is_font_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(), "ttf" | "otf" | "ttc" | "otc"))
        .unwrap_or(false)
}
