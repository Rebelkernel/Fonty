use crate::error::{FontyError, Result};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct ParsedFont {
    pub file_path: PathBuf,
    pub ttc_index: i32,
    pub file_hash: String,
    pub file_size: i64,
    pub file_mtime: i64,
    pub family_name: String,
    pub subfamily: Option<String>,
    pub typographic_family: Option<String>,
    pub typographic_subfamily: Option<String>,
    pub postscript_name: Option<String>,
    pub designer: Option<String>,
    pub weight: i32,
    pub italic: bool,
    pub width: i32,
    pub classification: String,
    pub format: String,
}

pub fn parse_file(path: &Path) -> Result<Vec<ParsedFont>> {
    let data = std::fs::read(path)?;
    let meta = std::fs::metadata(path)?;
    let file_size = meta.len() as i64;
    let file_mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let hash = format!("{:016x}", xxhash_rust::xxh64::xxh64(&data, 0));

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let format = match ext.as_str() {
        "otf" | "otc" => "otf",
        _ => "ttf",
    };
    let is_collection = matches!(ext.as_str(), "ttc" | "otc");

    let mut results = Vec::new();

    if is_collection {
        let n = ttf_parser::fonts_in_collection(&data).unwrap_or(1);
        for i in 0..n {
            if let Ok(face) = ttf_parser::Face::parse(&data, i) {
                if let Some(p) =
                    extract(&face, path, i as i32, &hash, file_size, file_mtime, format)
                {
                    results.push(p);
                }
            }
        }
    } else {
        let face = ttf_parser::Face::parse(&data, 0)?;
        if let Some(p) = extract(&face, path, 0, &hash, file_size, file_mtime, format) {
            results.push(p);
        }
    }

    if results.is_empty() {
        return Err(FontyError::NoFamilyName);
    }
    Ok(results)
}

fn extract(
    face: &ttf_parser::Face,
    path: &Path,
    ttc_index: i32,
    hash: &str,
    file_size: i64,
    file_mtime: i64,
    format: &'static str,
) -> Option<ParsedFont> {
    let family_name = read_name(face, ttf_parser::name_id::FAMILY)?;
    let subfamily = read_name(face, ttf_parser::name_id::SUBFAMILY);
    let typographic_family = read_name(face, ttf_parser::name_id::TYPOGRAPHIC_FAMILY);
    let typographic_subfamily = read_name(face, ttf_parser::name_id::TYPOGRAPHIC_SUBFAMILY);
    let postscript_name = read_name(face, ttf_parser::name_id::POST_SCRIPT_NAME);
    let designer = read_name(face, 9);

    let weight = face.weight().to_number() as i32;
    let italic = face.is_italic();
    let width = face.width().to_number() as i32;
    let classification = classify(face, &family_name, subfamily.as_deref());

    Some(ParsedFont {
        file_path: path.to_path_buf(),
        ttc_index,
        file_hash: hash.to_string(),
        file_size,
        file_mtime,
        family_name,
        subfamily,
        typographic_family,
        typographic_subfamily,
        postscript_name,
        designer,
        weight,
        italic,
        width,
        classification,
        format: format.to_string(),
    })
}

fn read_name(face: &ttf_parser::Face, id: u16) -> Option<String> {
    let names = face.names();
    let len = names.len();
    let mut best: Option<String> = None;
    for i in 0..len {
        let n = match names.get(i) {
            Some(n) => n,
            None => continue,
        };
        if n.name_id != id {
            continue;
        }
        if let Some(s) = n.to_string() {
            if n.is_unicode() {
                return Some(s);
            }
            if best.is_none() {
                best = Some(s);
            }
        }
    }
    best
}

fn classify(face: &ttf_parser::Face, family: &str, subfamily: Option<&str>) -> String {
    if face.is_monospaced() {
        return "monospace".into();
    }
    let hay = format!(
        "{} {}",
        family.to_ascii_lowercase(),
        subfamily.unwrap_or("").to_ascii_lowercase()
    );
    if hay.contains("script")
        || hay.contains(" hand")
        || hay.ends_with("hand")
        || hay.contains("brush")
        || hay.contains("cursive")
    {
        return "script".into();
    }
    if hay.contains("slab") {
        return "slab".into();
    }
    if hay.contains("display") || hay.contains("decorative") || hay.contains("deco") {
        return "display".into();
    }
    if hay.contains("sans") || hay.contains("grotesk") || hay.contains("grotesque") {
        return "sans".into();
    }
    if hay.contains("serif") {
        return "serif".into();
    }
    "unknown".into()
}

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
