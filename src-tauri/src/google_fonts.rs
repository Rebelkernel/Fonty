use crate::error::{FontyError, Result};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use rayon::prelude::*;
use regex::Regex;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const LEGACY_UA: &str =
    "Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/27.0.1453.93 Safari/537.36";

const CHROME_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// Google Fonts CSS API gates file formats on the User-Agent: modern
/// browsers get WOFF2, Chrome 27 gets WOFF, and `Java/1.6.0` (along with a
/// handful of other legacy Java/server UAs) gets static TTF URLs on
/// `fonts.gstatic.com`. The TTFs Google serves for this UA are STATIC per
/// weight + style — even for families that ship as variable fonts in the
/// `google/fonts` GitHub repo. This is the same mechanism FontBase and
/// most other desktop font managers use.
const JAVA_UA: &str = "Java/1.6.0";

static FONT_FACE_BLOCK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?s)@font-face\s*\{([^}]+)\}").unwrap());
static FONT_URL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"src:\s*url\((https?://[^)]+)\)").unwrap());
static FONT_WEIGHT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"font-weight:\s*(\d+)").unwrap());
static FONT_STYLE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"font-style:\s*(\w+)").unwrap());

/// Shared ureq Agent so every Google HTTP call reuses TLS + TCP connections.
/// 128 idle / 64 per host — sized for the 32-thread download pool plus the
/// occasional CSS / catalog fetch. fonts.gstatic.com + raw.githubusercontent.com
/// are CDN-backed, keepalive-friendly, and happily serve dozens of concurrent
/// requests per client.
static HTTP_AGENT: Lazy<ureq::Agent> = Lazy::new(|| {
    ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(120))
        .max_idle_connections(128)
        .max_idle_connections_per_host(64)
        .build()
});

/// Dedicated thread pool for parallel Google Fonts variant downloads.
/// 32 threads: fonts.gstatic.com is a global CDN that eats that for
/// breakfast, and the frontend now runs up to 8 families in parallel — we
/// want headroom for ~32 concurrent in-flight variant downloads. Isolated
/// from the global rayon pool so a download storm can't stall the scanner.
static DOWNLOAD_POOL: Lazy<rayon::ThreadPool> = Lazy::new(|| {
    rayon::ThreadPoolBuilder::new()
        .num_threads(32)
        .thread_name(|i| format!("fonty-dl-{i}"))
        .build()
        .expect("failed to build google download thread pool")
});

/// CSS-URL cache: maps a family → (parsed @font-face blocks, fetched_at).
/// Populated either by [`try_google_css_java_streaming`] on the first
/// per-family fetch, or by [`prefetch_css_for_families`] in a single
/// multi-family request at the start of a bulk batch. The streaming
/// downloader consults the cache first, so prefetched families skip the
/// 300 ms-per-family CSS round trip entirely.
///
/// TTL is 1 hour — Google's CDN URLs don't rotate that often, and a stale
/// URL just means one variant 404s and fallback strategies kick in.
static CSS_URL_CACHE: Lazy<Mutex<std::collections::HashMap<String, CachedCssEntry>>> =
    Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

const CSS_CACHE_TTL_SECS: u64 = 3600;

#[derive(Clone)]
struct CachedCssEntry {
    /// Parsed (weight, italic, ttf_url) triples for this family.
    urls: Vec<(i32, bool, String)>,
    fetched_at_epoch: u64,
}

fn now_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn fetch_catalog_raw() -> Result<String> {
    let body = HTTP_AGENT
        .get("https://fonts.google.com/metadata/fonts")
        .set("User-Agent", LEGACY_UA)
        .timeout(std::time::Duration::from_secs(30))
        .call()
        .map_err(|e| FontyError::Msg(format!("google catalog fetch: {e}")))?
        .into_string()
        .map_err(|e| FontyError::Msg(format!("google catalog read: {e}")))?;
    Ok(body.trim_start_matches(")]}'").trim().to_string())
}

#[derive(Debug, Clone)]
pub struct FontVariant {
    pub variant: String,
    pub weight: i32,
    pub italic: bool,
}

fn download_bytes(url: &str, ua: &str) -> Result<Vec<u8>> {
    let resp = HTTP_AGENT
        .get(url)
        .set("User-Agent", ua)
        .set("Accept", "*/*")
        .set("Referer", "https://fonts.google.com/")
        .call()
        .map_err(|e| FontyError::Msg(format!("download {url}: {e}")))?;
    let mut buf = Vec::with_capacity(1 << 17);
    resp.into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| FontyError::Msg(format!("read {url}: {e}")))?;
    Ok(buf)
}

/// Strategy A: ZIP from fonts.google.com/download?family=X.
/// Google serves a zip of TTFs here. Validated via PK magic-bytes.
fn try_zip(family: &str, dest_dir: &Path) -> Result<Vec<(PathBuf, FontVariant)>> {
    let url = format!(
        "https://fonts.google.com/download?family={}",
        family.replace(' ', "+")
    );
    let bytes = download_bytes(&url, CHROME_UA)?;
    if bytes.len() < 4 || &bytes[0..2] != b"PK" {
        return Err(FontyError::Msg(format!(
            "google zip: expected ZIP, got {} bytes",
            bytes.len()
        )));
    }
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| FontyError::Msg(format!("zip open: {e}")))?;
    let mut out = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| FontyError::Msg(format!("zip entry: {e}")))?;
        let name = entry.name().to_string();
        let lower = name.to_ascii_lowercase();
        if !(lower.ends_with(".ttf") || lower.ends_with(".otf")) {
            continue;
        }
        let filename = Path::new(&name)
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("font_{i}.ttf"));
        // Cap per-entry decompressed size at 64 MB to defuse zip-bombs.
        // Real font files max out around 30 MB (Noto CJK) — 64 MB is a
        // generous ceiling that still catches pathological payloads.
        const MAX_FONT_BYTES: u64 = 64 * 1024 * 1024;
        let dest_path = dest_dir.join(&filename);
        // Skip if already cached — avoids os error 32 on locked files.
        if !dest_path.exists() {
            let out_file = fs::File::create(&dest_path)
                .map_err(|e| FontyError::Msg(format!("zip create {dest_path:?}: {e}")))?;
            let mut capped = (&mut entry).take(MAX_FONT_BYTES + 1);
            let mut writer = std::io::BufWriter::new(out_file);
            let written = std::io::copy(&mut capped, &mut writer)
                .map_err(|e| FontyError::Msg(format!("zip extract: {e}")))?;
            drop(writer);
            if written > MAX_FONT_BYTES {
                let _ = fs::remove_file(&dest_path);
                return Err(FontyError::Msg(format!(
                    "zip entry '{name}' exceeded {MAX_FONT_BYTES} bytes — refusing"
                )));
            }
        }

        let stem = dest_path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let (variant, weight, italic) = parse_variant_from_filename(&stem, family);
        out.push((
            dest_path,
            FontVariant {
                variant,
                weight,
                italic,
            },
        ));
    }
    if out.is_empty() {
        return Err(FontyError::Msg(format!(
            "google zip for {family} contained no TTF/OTF"
        )));
    }
    Ok(out)
}

/// **Primary download strategy**: Google Fonts CSS API with the Java UA that
/// makes Google serve static TTFs per weight/style. This is the FontBase
/// approach — every variant lands as its own file with a normalised name
/// (`{Camel}-{Style}.ttf`), every file is an independent HKCU activation
/// unit, and there's no variable-font bookkeeping to reconcile.
///
/// Handles families the google/fonts raw path fails on:
///  - Bare-name statics (Nova Mono, Candal, Carter One, …)
///  - Designer-code filenames (PT Mono `PTM55FT.ttf`, IM Fell `IMFePIrm28P.ttf`)
///  - Exotic VF axes (Tilt Neon XROT/YROT, Honk MORF/SHLN, Nabla EDPT/EHLT,
///    Jaro `opsz`) — Google serves static slices via the CSS API even when
///    the family ships as VF in the repo.
fn try_google_css_java(
    family: &str,
    variants: &[String],
    dest_dir: &Path,
) -> Result<Vec<(PathBuf, FontVariant)>> {
    let resolved: Vec<String> = if variants.is_empty() {
        vec!["regular".to_string()]
    } else {
        variants.to_vec()
    };
    // Cache-first: bulk prefetch may have already populated URLs for this
    // family. If not, fetch now and cache.
    let blocks = fetch_css_urls_cached(family, &resolved)?;
    // Normalised filename stem — matches the FontBase convention.
    let camel = github_camel(family);

    // Parallel download every variant. Cache-hit short-circuits on disk.
    let results: Vec<Option<(PathBuf, FontVariant)>> = DOWNLOAD_POOL.install(|| {
        blocks
            .par_iter()
            .map(|(weight, italic, src_url)| {
                let style_name = weight_italic_to_style_name(*weight, *italic);
                let filename = format!("{camel}-{style_name}.ttf");
                let dest = dest_dir.join(&filename);
                let variant = weight_italic_to_variant(*weight, *italic);
                if dest.exists() {
                    return Some((
                        dest,
                        FontVariant {
                            variant,
                            weight: *weight,
                            italic: *italic,
                        },
                    ));
                }
                let bytes = match download_bytes(src_url, CHROME_UA) {
                    Ok(b) => b,
                    Err(_) => return None,
                };
                if bytes.len() < 200 {
                    return None;
                }
                // Magic byte sanity check — TTF/TTC/OTF.
                let m = &bytes[0..4];
                let is_font = matches!(
                    m,
                    [0x00, 0x01, 0x00, 0x00]
                        | [0x4F, 0x54, 0x54, 0x4F]
                        | [0x74, 0x72, 0x75, 0x65]
                        | [0x74, 0x74, 0x63, 0x66]
                );
                if !is_font {
                    return None;
                }
                if write_font_file(&dest, &bytes).is_err() {
                    return None;
                }
                Some((
                    dest,
                    FontVariant {
                        variant,
                        weight: *weight,
                        italic: *italic,
                    },
                ))
            })
            .collect()
    });

    let out: Vec<(PathBuf, FontVariant)> = results.into_iter().flatten().collect();
    if out.is_empty() {
        return Err(FontyError::Msg(format!(
            "google css gave URLs for '{family}' but every download failed"
        )));
    }
    Ok(out)
}

/// Fetch + cache Google CSS URL blocks for a single family. Consulted by
/// the streaming downloader first — if a bulk batch already prefetched
/// this family via [`prefetch_css_for_families`], we skip the network
/// entirely.
fn fetch_css_urls_cached(
    family: &str,
    variants: &[String],
) -> Result<Vec<(i32, bool, String)>> {
    {
        let cache = CSS_URL_CACHE.lock();
        if let Some(entry) = cache.get(family) {
            if now_epoch_secs().saturating_sub(entry.fetched_at_epoch)
                < CSS_CACHE_TTL_SECS
            {
                // Cached entry always holds every variant Google would
                // have returned for "fetch every weight/italic we care
                // about" — not just the caller's subset. Let the caller
                // pick what it needs.
                return Ok(entry.urls.clone());
            }
        }
    }
    let variants_spec = if variants.is_empty() {
        "regular".to_string()
    } else {
        variants.join(",")
    };
    let family_param = urlencoding::encode(family).replace("%20", "+");
    let url = format!(
        "https://fonts.googleapis.com/css?family={family_param}:{variants_spec}&display=swap"
    );
    let body = HTTP_AGENT
        .get(&url)
        .set("User-Agent", JAVA_UA)
        .timeout(std::time::Duration::from_secs(20))
        .call()
        .map_err(|e| FontyError::Msg(format!("google css fetch: {e}")))?
        .into_string()
        .map_err(|e| FontyError::Msg(format!("google css read: {e}")))?;
    let blocks = parse_css_blocks_for_family(&body, family);
    if blocks.is_empty() {
        return Err(FontyError::Msg(format!(
            "google css for '{family}' returned no TTF @font-face blocks"
        )));
    }
    CSS_URL_CACHE.lock().insert(
        family.to_string(),
        CachedCssEntry {
            urls: blocks.clone(),
            fetched_at_epoch: now_epoch_secs(),
        },
    );
    Ok(blocks)
}

/// Parse every `@font-face` block in a CSS body that matches
/// `font-family: 'family'`. Accepts both single-family and multi-family
/// responses (Google CSS returns them as one flat stream of @font-face
/// rules with a `font-family` attribute inside each).
fn parse_css_blocks_for_family(body: &str, family: &str) -> Vec<(i32, bool, String)> {
    static FAMILY_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r#"font-family:\s*'([^']+)'"#).unwrap());
    let mut out = Vec::new();
    for cap in FONT_FACE_BLOCK_RE.captures_iter(body) {
        let block = &cap[1];
        let fam = match FAMILY_RE.captures(block) {
            Some(c) => c[1].to_string(),
            None => continue,
        };
        if fam != family {
            continue;
        }
        let weight = FONT_WEIGHT_RE
            .captures(block)
            .and_then(|c| c[1].parse::<i32>().ok())
            .unwrap_or(400);
        let italic = FONT_STYLE_RE
            .captures(block)
            .map(|c| c[1].eq_ignore_ascii_case("italic"))
            .unwrap_or(false);
        let url_match = match FONT_URL_RE.captures(block) {
            Some(c) => c[1].to_string(),
            None => continue,
        };
        if !url_match.to_ascii_lowercase().contains(".ttf") {
            continue;
        }
        out.push((weight, italic, url_match));
    }
    out
}

/// Batch-prefetch CSS URLs for many families in a single HTTP request.
/// Google's CSS endpoint accepts pipe-delimited family specs:
///   `?family=Roboto:400,700|Inconsolata:400,700|NovaMono:400`
/// We chunk at 20 families per URL to stay comfortably under every
/// server's URL-length limit (typical ~8 KB; our chunks are ~1-2 KB).
/// Every family returned is stashed in [`CSS_URL_CACHE`], so subsequent
/// per-family downloader calls bypass the network for metadata.
///
/// This is the single biggest speed win for bulk category / all-Google
/// activations: 48 CSS fetches collapse to 3 (≥ 16× fewer round trips).
pub fn prefetch_css_for_families(
    families: &[(String, Vec<String>)],
) -> Result<()> {
    const CHUNK_SIZE: usize = 20;
    for chunk in families.chunks(CHUNK_SIZE) {
        let family_specs: Vec<String> = chunk
            .iter()
            .map(|(family, variants)| {
                let encoded = urlencoding::encode(family).replace("%20", "+");
                let spec = if variants.is_empty() {
                    "regular".to_string()
                } else {
                    variants.join(",")
                };
                format!("{encoded}:{spec}")
            })
            .collect();
        let url = format!(
            "https://fonts.googleapis.com/css?family={}&display=swap",
            family_specs.join("|")
        );
        let body = match HTTP_AGENT
            .get(&url)
            .set("User-Agent", JAVA_UA)
            .timeout(std::time::Duration::from_secs(30))
            .call()
            .and_then(|resp| resp.into_string().map_err(Into::into))
        {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("css batch prefetch ({} families) failed: {e}", chunk.len());
                continue; // fall through — per-family fetches will retry
            }
        };
        let now = now_epoch_secs();
        let mut cache = CSS_URL_CACHE.lock();
        for (family, _variants) in chunk {
            let blocks = parse_css_blocks_for_family(&body, family);
            if blocks.is_empty() {
                continue;
            }
            cache.insert(
                family.clone(),
                CachedCssEntry {
                    urls: blocks,
                    fetched_at_epoch: now,
                },
            );
        }
    }
    Ok(())
}

/// Streaming variant of [`try_google_css_java`]: after each variant's TTF
/// lands on disk inside a rayon worker, the `on_ready` callback fires
/// immediately — allowing the caller (commands::activate_google_family) to
/// run the GDI + HKCU + DB + progress-event pipeline per variant as soon
/// as it's available, instead of waiting for every download to finish.
///
/// This is the mechanism that makes Adria's "variants light up individually
/// while others still load" UX real — the user sees variants flip to active
/// in the styles tray in natural download order, not as one batch at end.
///
/// `on_ready` runs in whichever rayon worker thread finished the download.
/// The closure must be `Send + Sync` and any captured state that it writes
/// must be thread-safe (DB + Tauri AppHandle + winreg are all OK here).
pub fn try_google_css_java_streaming<F>(
    family: &str,
    variants: &[String],
    dest_dir: &Path,
    on_ready: F,
) -> Result<Vec<(PathBuf, FontVariant)>>
where
    F: Fn(&Path, &FontVariant) + Send + Sync,
{
    let resolved: Vec<String> = if variants.is_empty() {
        vec!["regular".to_string()]
    } else {
        variants.to_vec()
    };
    // Cache-first: bulk prefetch may have already populated URLs for this
    // family. If not, fetch now and cache.
    let blocks = fetch_css_urls_cached(family, &resolved)?;
    let camel = github_camel(family);

    // Build (weight, italic) → original catalog-variant map so the DB
    // row's variant string matches what the styles tray iterates.
    let variant_map: std::collections::HashMap<(i32, bool), String> = resolved
        .iter()
        .map(|v| {
            let (w, i) = variant_weight_italic(v);
            ((w, i), v.clone())
        })
        .collect();

    let results: Vec<Option<(PathBuf, FontVariant)>> = DOWNLOAD_POOL.install(|| {
        blocks
            .par_iter()
            .map(|(weight, italic, src_url)| {
                let style_name = weight_italic_to_style_name(*weight, *italic);
                let filename = format!("{camel}-{style_name}.ttf");
                let dest = dest_dir.join(&filename);
                // Preserve the exact catalog variant string for this
                // (weight, italic) key when possible — falls back to the
                // canonical short form if the CSS block doesn't map to
                // anything we asked for (shouldn't happen in practice).
                let variant = variant_map
                    .get(&(*weight, *italic))
                    .cloned()
                    .unwrap_or_else(|| weight_italic_to_variant(*weight, *italic));
                let fv = FontVariant {
                    variant: variant.clone(),
                    weight: *weight,
                    italic: *italic,
                };

                if dest.exists() {
                    on_ready(&dest, &fv);
                    return Some((dest, fv));
                }

                let bytes = match download_bytes(src_url, CHROME_UA) {
                    Ok(b) => b,
                    Err(_) => return None,
                };
                if bytes.len() < 200 {
                    return None;
                }
                let m = &bytes[0..4];
                let is_font = matches!(
                    m,
                    [0x00, 0x01, 0x00, 0x00]
                        | [0x4F, 0x54, 0x54, 0x4F]
                        | [0x74, 0x72, 0x75, 0x65]
                        | [0x74, 0x74, 0x63, 0x66]
                );
                if !is_font {
                    return None;
                }
                if write_font_file(&dest, &bytes).is_err() {
                    return None;
                }
                on_ready(&dest, &fv);
                Some((dest, fv))
            })
            .collect()
    });

    let out: Vec<(PathBuf, FontVariant)> = results.into_iter().flatten().collect();
    if out.is_empty() {
        return Err(FontyError::Msg(format!(
            "google css gave URLs for '{family}' but every download failed"
        )));
    }
    Ok(out)
}

/// "Bold", "BoldItalic", "Thin", "Italic", etc. — FontBase-style style name
/// used in cache filenames.
fn weight_italic_to_style_name(weight: i32, italic: bool) -> String {
    let name = match weight {
        100 => "Thin",
        200 => "ExtraLight",
        300 => "Light",
        400 => "Regular",
        500 => "Medium",
        600 => "SemiBold",
        700 => "Bold",
        800 => "ExtraBold",
        900 => "Black",
        _ => "Regular",
    };
    match (name, italic) {
        ("Regular", true) => "Italic".to_string(),
        (w, true) => format!("{w}Italic"),
        (w, false) => w.to_string(),
    }
}

/// Inverse of `variant_weight_italic` — rebuild Google's catalog-format
/// variant string (short form: `"400"`, `"400i"`, `"700i"`). This is the
/// format the catalog parser stores into `google_families.variants`, so
/// using it here means DB rows from `record_google_activation` line up 1:1
/// with the strings the frontend styles-tray iterates — no more "family
/// dot says active but every style dot says inactive" mismatch.
fn weight_italic_to_variant(weight: i32, italic: bool) -> String {
    if italic {
        format!("{weight}i")
    } else {
        weight.to_string()
    }
}

/// Legacy CSS1 endpoint with Chrome-27 UA — retained as a fallback for the
/// rare case Google's CSS API starts failing or the user is offline.
/// Historically returned WOFF (which Windows 10+ can load via
/// `AddFontResourceW`). Stored verbatim on disk with the url's extension.
#[allow(dead_code)]
fn try_css(
    family: &str,
    variants: &[String],
    dest_dir: &Path,
) -> Result<Vec<(PathBuf, FontVariant)>> {
    let variants_spec = if variants.is_empty() {
        "regular,italic,700,700italic".to_string()
    } else {
        variants.join(",")
    };
    let url = format!(
        "https://fonts.googleapis.com/css?family={}:{}&subset=latin,latin-ext",
        urlencoding::encode(family),
        variants_spec
    );
    let body = HTTP_AGENT
        .get(&url)
        .set("User-Agent", LEGACY_UA)
        .timeout(std::time::Duration::from_secs(20))
        .call()
        .map_err(|e| FontyError::Msg(format!("google css fetch: {e}")))?
        .into_string()
        .map_err(|e| FontyError::Msg(format!("google css read: {e}")))?;

    let mut out = Vec::new();
    for cap in FONT_FACE_BLOCK_RE.captures_iter(&body) {
        let block = &cap[1];
        let weight = FONT_WEIGHT_RE
            .captures(block)
            .and_then(|c| c[1].parse::<i32>().ok())
            .unwrap_or(400);
        let italic = FONT_STYLE_RE
            .captures(block)
            .map(|c| c[1].eq_ignore_ascii_case("italic"))
            .unwrap_or(false);
        let url_match = match FONT_URL_RE.captures(block) {
            Some(c) => c[1].to_string(),
            None => continue,
        };

        let ext = if url_match.to_ascii_lowercase().ends_with(".ttf") {
            "ttf"
        } else if url_match.to_ascii_lowercase().ends_with(".otf") {
            "otf"
        } else if url_match.to_ascii_lowercase().ends_with(".woff2") {
            "woff2"
        } else {
            "woff"
        };

        let variant = if italic && weight == 400 {
            "italic".to_string()
        } else if italic {
            format!("{}italic", weight)
        } else if weight == 400 {
            "regular".to_string()
        } else {
            weight.to_string()
        };
        let safe: String = variant
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();
        let dest = dest_dir.join(format!("{}.{}", safe, ext));
        let bytes = download_bytes(&url_match, LEGACY_UA)?;
        fs::write(&dest, &bytes)?;
        out.push((
            dest,
            FontVariant {
                variant,
                weight,
                italic,
            },
        ));
    }
    if out.is_empty() {
        return Err(FontyError::Msg(format!(
            "google css for {family} yielded no parseable @font-face blocks"
        )));
    }
    Ok(out)
}

/// Strategy C: Google Webfonts Helper public mirror. Always returns a zip
/// of TTF files, regardless of UA. Used as fallback when Google's own
/// download endpoint misbehaves.
fn try_gwfh(
    family: &str,
    variants: &[String],
    dest_dir: &Path,
) -> Result<Vec<(PathBuf, FontVariant)>> {
    let slug = family.to_ascii_lowercase().replace(' ', "-");
    let variants_spec = if variants.is_empty() {
        "regular,italic,700,700italic".to_string()
    } else {
        variants.join(",")
    };
    let url = format!(
        "https://gwfh.mranftl.com/api/fonts/{}?download=zip&subsets=latin&formats=ttf&variants={}",
        slug, variants_spec
    );
    let bytes = download_bytes(&url, CHROME_UA)?;
    if bytes.len() < 4 || &bytes[0..2] != b"PK" {
        return Err(FontyError::Msg(format!(
            "gwfh for {}: not a ZIP response ({} bytes)",
            family,
            bytes.len()
        )));
    }
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| FontyError::Msg(format!("gwfh zip open: {e}")))?;
    let mut out = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| FontyError::Msg(format!("gwfh zip entry: {e}")))?;
        let name = entry.name().to_string();
        let lower = name.to_ascii_lowercase();
        if !(lower.ends_with(".ttf") || lower.ends_with(".otf")) {
            continue;
        }
        let filename = Path::new(&name)
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("font_{i}.ttf"));
        let dest_path = dest_dir.join(&filename);
        // Skip if the file is already on disk — avoids the "os error 32:
        // used by another process" that fires when Windows still holds a
        // handle on a just-deactivated font. Cached file is authoritative.
        if !dest_path.exists() {
            let mut out_file = fs::File::create(&dest_path)
                .map_err(|e| FontyError::Msg(format!("gwfh create {dest_path:?}: {e}")))?;
            std::io::copy(&mut entry, &mut out_file)
                .map_err(|e| FontyError::Msg(format!("gwfh zip extract: {e}")))?;
        }

        let stem = dest_path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let (variant, weight, italic) = parse_variant_from_filename(&stem, family);
        out.push((
            dest_path,
            FontVariant {
                variant,
                weight,
                italic,
            },
        ));
    }
    if out.is_empty() {
        return Err(FontyError::Msg(format!(
            "gwfh zip for {family} contained no TTF/OTF"
        )));
    }
    Ok(out)
}

/// Returns `true` if the given file on disk starts with a valid TTF/OTF/TTC
/// magic signature — i.e. something `AddFontResourceW` actually knows how
/// to load. Anything else (e.g. WOFF/WOFF2 mis-labelled as .ttf) is rejected.
pub fn is_valid_font_file(path: &Path) -> bool {
    use std::io::Read;
    let mut f = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut magic = [0u8; 4];
    if f.read_exact(&mut magic).is_err() {
        return false;
    }
    matches!(
        &magic,
        [0x00, 0x01, 0x00, 0x00]
            | [0x4F, 0x54, 0x54, 0x4F]
            | [0x74, 0x72, 0x75, 0x65]
            | [0x74, 0x79, 0x70, 0x31]
            | [0x74, 0x74, 0x63, 0x66]
    )
}

/// Scan the family's cache directory for TTF/OTF files already downloaded
/// in a previous session. Keyed by variant string ("regular", "700italic"
/// etc.) so `resolve_variants` can skip the network for anything present.
pub fn list_cached_variants(
    family: &str,
    dest_dir: &Path,
) -> Vec<(PathBuf, FontVariant)> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(dest_dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if ext != "ttf" && ext != "otf" {
            continue;
        }
        // Don't try to open the file to validate magic bytes — a fresh
        // deactivate may still have a Windows handle on it (ref count
        // hasn't dropped to zero yet because Word/Affinity hasn't refreshed
        // its cache). Failing the open here would trigger a re-download,
        // which then fails to write over the still-locked file. Trust the
        // extension instead.
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        let (variant, weight, italic) = parse_variant_from_filename(stem, family);
        out.push((
            path,
            FontVariant {
                variant,
                weight,
                italic,
            },
        ));
    }
    out
}

/// Wipe every cached TTF/OTF in the Google Fonts cache root. Called from
/// Settings → "Clear Google Fonts cache". Returns the count of files
/// removed. Does NOT touch the activations table — caller is expected to
/// deactivate first or accept that active variants will be missing on disk.
pub fn clear_cache_root(cache_root: &Path) -> Result<usize> {
    let mut removed = 0usize;
    let entries = match fs::read_dir(cache_root) {
        Ok(e) => e,
        Err(_) => return Ok(0),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Ok(inner) = fs::read_dir(&path) {
                for f in inner.flatten() {
                    if fs::remove_file(f.path()).is_ok() {
                        removed += 1;
                    }
                }
                let _ = fs::remove_dir(&path);
            }
        } else if fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// High-level: return TTF paths for every requested variant. Uses the cache
/// first, falls back to `download_variants_as_ttf` only for the ones that
/// aren't already on disk. Massive speed win on re-activation.
pub fn resolve_variants(
    family: &str,
    variants: &[String],
    dest_dir: &Path,
) -> Result<Vec<(PathBuf, FontVariant)>> {
    fs::create_dir_all(dest_dir)?;
    let cached = list_cached_variants(family, dest_dir);
    let wanted: Vec<String> = if variants.is_empty() {
        vec!["regular".to_string()]
    } else {
        variants.to_vec()
    };
    let mut out: Vec<(PathBuf, FontVariant)> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    for w in &wanted {
        if let Some(hit) = cached.iter().find(|(_, v)| &v.variant == w) {
            out.push(hit.clone());
        } else {
            missing.push(w.clone());
        }
    }
    if missing.is_empty() {
        return Ok(out);
    }
    // Only download what we're actually missing.
    let downloaded = download_variants_as_ttf(family, &missing, dest_dir)?;
    for item in downloaded {
        if !out.iter().any(|(_, v)| v.variant == item.1.variant) {
            out.push(item);
        }
    }
    Ok(out)
}

/// Download + cache every TTF for a family. Strategy order:
///  1. **Google CSS API (Java UA)** — primary. One request gives us per-style
///     static TTF URLs on fonts.gstatic.com. Works for every family Google
///     publishes, normalises to clean `{Camel}-{Style}.ttf` filenames, and
///     makes each variant an independent activation unit. This is the
///     FontBase approach.
///  2. **github.com/google/fonts** — fallback. METADATA.pb-driven then
///     legacy guess-based. Used if the CSS API is unreachable or rejects
///     the family (extremely rare).
///  3. **gwfh + google-zip** — final fallbacks for the edge case where both
///     CSS and github fail. Kept for completeness; modern usage rarely hits
///     them.
pub fn download_variants_as_ttf(
    family: &str,
    variants: &[String],
    dest_dir: &Path,
) -> Result<Vec<(PathBuf, FontVariant)>> {
    fs::create_dir_all(dest_dir)?;
    let mut errors: Vec<String> = Vec::new();

    type DlFn = fn(&str, &[String], &Path) -> Result<Vec<(PathBuf, FontVariant)>>;
    let strategies: &[(&str, DlFn)] = &[
        ("google-css", try_google_css_java_adapter),
        ("github", try_github_adapter),
        ("gwfh", try_gwfh_adapter),
        ("google-zip", try_google_zip_adapter),
    ];

    for (name, strategy) in strategies.iter() {
        match strategy(family, variants, dest_dir) {
            Ok(v) if !v.is_empty() => return Ok(v),
            Ok(_) => errors.push(format!("{name}: no variants resolved")),
            Err(e) => {
                tracing::warn!("{} failed for {}: {}", name, family, e);
                errors.push(format!("{name}: {e}"));
            }
        }
    }

    Err(FontyError::Msg(format!(
        "All download strategies failed for '{family}': {}",
        errors.join(" | ")
    )))
}

// Adapters so we can hold strategies in a single slice. `try_zip` ignores
// the variants list (Google's zip endpoint always delivers the whole family)
// but the signature has to match the others.
fn try_google_css_java_adapter(
    family: &str,
    variants: &[String],
    dest_dir: &Path,
) -> Result<Vec<(PathBuf, FontVariant)>> {
    try_google_css_java(family, variants, dest_dir)
}
fn try_gwfh_adapter(
    family: &str,
    variants: &[String],
    dest_dir: &Path,
) -> Result<Vec<(PathBuf, FontVariant)>> {
    try_gwfh(family, variants, dest_dir)
}
fn try_github_adapter(
    family: &str,
    variants: &[String],
    dest_dir: &Path,
) -> Result<Vec<(PathBuf, FontVariant)>> {
    try_github(family, variants, dest_dir)
}
fn try_google_zip_adapter(
    family: &str,
    _variants: &[String],
    dest_dir: &Path,
) -> Result<Vec<(PathBuf, FontVariant)>> {
    try_zip(family, dest_dir)
}

fn github_slug(family: &str) -> String {
    family
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

fn github_camel(family: &str) -> String {
    family.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Parse any Google variant string into (weight, italic). Accepts every
/// format the project has touched:
///   - Catalog short form: `"400"`, `"400i"`, `"100i"` (what
///     fonts.google.com/metadata/fonts serves and what FONTY's DB stores)
///   - Long form: `"regular"`, `"italic"`, `"400italic"`, `"700italic"`
///     (historical internal strings and legacy downloader output)
fn variant_weight_italic(v: &str) -> (i32, bool) {
    let lower = v.trim().to_ascii_lowercase();
    if lower == "regular" {
        return (400, false);
    }
    if lower == "italic" {
        return (400, true);
    }
    if let Some(rest) = lower.strip_suffix("italic") {
        let w = rest.parse().unwrap_or(400);
        return (w, true);
    }
    if let Some(rest) = lower.strip_suffix('i') {
        if let Ok(w) = rest.parse::<i32>() {
            return (w, true);
        }
    }
    let weight: i32 = lower.parse().unwrap_or(400);
    (weight, false)
}

fn variant_to_github_style(v: &str) -> String {
    let (weight, italic) = variant_weight_italic(v);
    let weight_name = match weight {
        100 => "Thin",
        200 => "ExtraLight",
        300 => "Light",
        400 => "Regular",
        500 => "Medium",
        600 => "SemiBold",
        700 => "Bold",
        800 => "ExtraBold",
        900 => "Black",
        _ => "Regular",
    };
    match (weight_name, italic) {
        ("Regular", true) => "Italic".to_string(),
        (w, true) => format!("{}Italic", w),
        (w, false) => w.to_string(),
    }
}

/// Direct TTF fetch from github.com/google/fonts raw files.
///
/// **Authoritative path — METADATA.pb lookup.** Every family directory in
/// google/fonts contains a `METADATA.pb` file (protobuf text) listing the
/// exact TTF filename for each weight+style, plus any variable-font axis
/// tags. Reading it once and using the listed filenames beats guessing
/// `{Camel}-{Style}.ttf`, which fails on:
///   - Bare-name static families (`NovaMono.ttf`, `CarterOne.ttf`, etc.)
///   - Quirky designer-internal names (`PTM55FT.ttf` for PT Mono,
///     `IMFePIrm28P.ttf` for IM Fell DW Pica)
///   - Exotic VF axis combos (`TiltNeon[XROT,YROT].ttf`,
///     `Honk[MORF,SHLN].ttf`, `Nabla[EDPT,EHLT].ttf`, `Jaro[opsz].ttf`)
///
/// **Fallback — guess + VF probe.** If METADATA.pb is unreachable (404,
/// rate-limit, network hiccup), drop to the legacy guess-based path which
/// handles the common "Camel-Regular.ttf" cases.
fn try_github(
    family: &str,
    variants: &[String],
    dest_dir: &Path,
) -> Result<Vec<(PathBuf, FontVariant)>> {
    let slug = github_slug(family);
    let camel = github_camel(family);

    let resolved: Vec<String> = if variants.is_empty() {
        vec!["regular".to_string()]
    } else {
        variants.to_vec()
    };

    // Primary path: METADATA.pb-driven resolution.
    if let Some(meta) = fetch_family_metadata(&slug) {
        if let Ok(out) = try_github_via_metadata(&meta, &slug, &resolved, dest_dir) {
            if !out.is_empty() {
                return Ok(out);
            }
        }
    }

    // Legacy fallback: VF probe + per-variant static guess. Kept for families
    // whose METADATA.pb temporarily 404s or for future families we haven't
    // mapped yet.
    if let Some(vf_path) = probe_variable_font(&slug, &camel, dest_dir) {
        return Ok(resolved
            .iter()
            .map(|v| {
                let (weight, italic) = variant_weight_italic(v);
                (
                    vf_path.clone(),
                    FontVariant {
                        variant: v.clone(),
                        weight,
                        italic,
                    },
                )
            })
            .collect());
    }

    let license_hint: Mutex<Option<&'static str>> = Mutex::new(None);
    let results: Vec<Option<(PathBuf, FontVariant)>> = DOWNLOAD_POOL.install(|| {
        resolved
            .par_iter()
            .map(|variant| {
                try_github_one_variant(variant, &slug, &camel, dest_dir, &license_hint)
            })
            .collect()
    });
    let out: Vec<(PathBuf, FontVariant)> = results.into_iter().flatten().collect();
    if out.is_empty() {
        return Err(FontyError::Msg(format!(
            "no variants for '{family}' in google/fonts repo"
        )));
    }
    Ok(out)
}

const GITHUB_LICENSES: [&str; 3] = ["ofl", "apache", "ufl"];

#[derive(Debug, Clone)]
struct MetadataFont {
    /// `"normal"` or `"italic"`.
    style: String,
    weight: i32,
    filename: String,
}

#[derive(Debug, Clone)]
struct FamilyMetadata {
    license: &'static str,
    fonts: Vec<MetadataFont>,
}

/// Fetch `METADATA.pb` for a family, trying all three license subdirs in
/// parallel. Returns as soon as any license has a parseable file. ~300-500 ms
/// cold, near-instant when hits the shared HTTP keepalive pool.
fn fetch_family_metadata(slug: &str) -> Option<FamilyMetadata> {
    let winner: Mutex<Option<FamilyMetadata>> = Mutex::new(None);
    DOWNLOAD_POOL.install(|| {
        GITHUB_LICENSES.par_iter().for_each(|lic| {
            if winner.lock().is_some() {
                return;
            }
            let url = format!(
                "https://raw.githubusercontent.com/google/fonts/main/{lic}/{slug}/METADATA.pb"
            );
            let bytes = match download_bytes(&url, CHROME_UA) {
                Ok(b) => b,
                Err(_) => return,
            };
            let text = match std::str::from_utf8(&bytes) {
                Ok(t) => t,
                Err(_) => return,
            };
            if let Some(meta) = parse_metadata_pb(text, lic) {
                let mut slot = winner.lock();
                if slot.is_none() {
                    *slot = Some(meta);
                }
            }
        });
    });
    winner.into_inner()
}

/// Minimal protobuf-text parser for the `fonts { ... }` blocks in
/// METADATA.pb. Only extracts `style`, `weight`, `filename` — that's all we
/// need to map requested variants to on-disk filenames. Ignores nested
/// blocks (axes, source, etc.) by tracking brace depth.
fn parse_metadata_pb(text: &str, license: &'static str) -> Option<FamilyMetadata> {
    let mut fonts = Vec::new();
    let mut in_fonts = false;
    let mut depth = 0i32;
    let mut cur_style = String::from("normal");
    let mut cur_weight = 400i32;
    let mut cur_filename = String::new();

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if !in_fonts {
            if line.starts_with("fonts") && line.ends_with('{') {
                in_fonts = true;
                depth = 1;
                cur_style = "normal".into();
                cur_weight = 400;
                cur_filename.clear();
            }
            continue;
        }
        if line.ends_with('{') && !line.starts_with("fonts") {
            depth += 1;
            continue;
        }
        if line == "}" {
            depth -= 1;
            if depth == 0 {
                in_fonts = false;
                if !cur_filename.is_empty() {
                    fonts.push(MetadataFont {
                        style: cur_style.clone(),
                        weight: cur_weight,
                        filename: cur_filename.clone(),
                    });
                }
            }
            continue;
        }
        // Only capture the shallow fields; nested-block fields (axes.tag,
        // source.commit, …) are filtered out by depth > 1.
        if depth != 1 {
            continue;
        }
        if let Some(rest) = line.strip_prefix("style:") {
            cur_style = rest.trim().trim_matches('"').to_string();
        } else if let Some(rest) = line.strip_prefix("weight:") {
            if let Ok(v) = rest.trim().parse::<i32>() {
                cur_weight = v;
            }
        } else if let Some(rest) = line.strip_prefix("filename:") {
            cur_filename = rest.trim().trim_matches('"').to_string();
        }
    }

    if fonts.is_empty() {
        return None;
    }
    Some(FamilyMetadata { license, fonts })
}

/// Use the parsed METADATA to resolve requested variants to on-disk paths.
/// Handles three shapes in one pass:
///  - **Static family**: per-variant filenames (one file per weight/style).
///  - **VF family, single axis group**: one filename covers every variant
///    (e.g. Inconsolata `[wdth,wght]`).
///  - **VF family, italic-split**: separate VFs for upright and italic
///    (e.g. Roboto `Roboto[wdth,wght]` + `Roboto-Italic[wdth,wght]`).
///
/// Downloads each unique filename once, in parallel.
fn try_github_via_metadata(
    meta: &FamilyMetadata,
    slug: &str,
    variants: &[String],
    dest_dir: &Path,
) -> Result<Vec<(PathBuf, FontVariant)>> {
    // Pick the upright-VF and italic-VF files out of METADATA (if any).
    // Bracketed filename is the universal VF marker.
    let upright_vf = meta
        .fonts
        .iter()
        .find(|f| f.filename.contains('[') && f.style == "normal")
        .map(|f| f.filename.clone());
    let italic_vf = meta
        .fonts
        .iter()
        .find(|f| f.filename.contains('[') && f.style == "italic")
        .map(|f| f.filename.clone());

    // Map each requested variant to the filename that should cover it.
    let mut per_variant: Vec<(String, String, i32, bool)> = Vec::new();
    for v in variants {
        let (weight, italic) = variant_weight_italic(v);
        // 1. Prefer an exact (weight, style) match.
        let want_style = if italic { "italic" } else { "normal" };
        let exact = meta
            .fonts
            .iter()
            .find(|f| f.weight == weight && f.style == want_style)
            .map(|f| f.filename.clone());
        // 2. Fall back to a VF file (italic-specific if available).
        let filename = exact
            .or_else(|| if italic { italic_vf.clone().or_else(|| upright_vf.clone()) } else { upright_vf.clone() });
        let Some(filename) = filename else {
            continue;
        };
        per_variant.push((v.clone(), filename, weight, italic));
    }

    if per_variant.is_empty() {
        return Err(FontyError::Msg("metadata had no resolvable variants".into()));
    }

    // Deduplicate filenames (common for VFs where one file serves many variants).
    let unique_files: Vec<String> = {
        let mut set = std::collections::BTreeSet::new();
        for (_, fname, _, _) in &per_variant {
            set.insert(fname.clone());
        }
        set.into_iter().collect()
    };

    // Download each unique filename in parallel. Short-circuits on cached
    // copies. `downloaded` maps filename → PathBuf on success.
    let downloaded: Mutex<std::collections::HashMap<String, PathBuf>> =
        Mutex::new(std::collections::HashMap::new());
    DOWNLOAD_POOL.install(|| {
        unique_files.par_iter().for_each(|fname| {
            let dest = dest_dir.join(fname);
            if dest.exists() {
                downloaded.lock().insert(fname.clone(), dest);
                return;
            }
            let url = format!(
                "https://raw.githubusercontent.com/google/fonts/main/{lic}/{slug}/{file}",
                lic = meta.license,
                slug = slug,
                file = fname,
            );
            if let Ok(bytes) = download_bytes(&url, CHROME_UA) {
                if bytes.len() > 200 && bytes[0] == 0x00 {
                    if write_font_file(&dest, &bytes).is_ok() {
                        downloaded.lock().insert(fname.clone(), dest);
                    }
                }
            }
        });
    });
    let paths = downloaded.into_inner();

    let mut out = Vec::new();
    for (variant, filename, weight, italic) in per_variant {
        if let Some(p) = paths.get(&filename) {
            out.push((
                p.clone(),
                FontVariant {
                    variant,
                    weight,
                    italic,
                },
            ));
        }
    }
    Ok(out)
}

/// Most common VF axis-combo suffixes seen in google/fonts, ordered by
/// rough frequency. Covers ~95% of VF families including Inconsolata
/// (`[wdth,wght]`), Roboto Flex (`[opsz,wght]`), Raleway, Oswald, Bitter,
/// Recursive, etc. Less common axis combos fall through to the GitHub
/// contents-API last-resort path.
const VF_AXIS_SUFFIXES: &[&str] = &[
    "[wght]",
    "[ital,wght]",
    "[wdth,wght]",
    "[opsz,wght]",
    "[slnt,wght]",
    "[opsz,wdth,wght]",
    "[ital,opsz,wght]",
];

/// Legacy "-VariableFont_..." naming used before bracketed axes were the
/// standard. A handful of older families still use it.
const VF_LEGACY_SUFFIXES: &[&str] = &[
    "-VariableFont_wght",
    "-VariableFont_ital,wght",
    "-VariableFont_wdth,wght",
];

/// One-shot VF probe for a family. Strategy:
///  - **Cache check (free)**: if any of the ~10 candidate filenames is
///    already on disk, use it immediately.
///  - **Network probe (OFL license, parallel)**: fire all candidates at
///    once through the download pool; first hit wins. OFL covers ~98% of
///    VF-shipped Google fonts. If nothing matches, caller falls through to
///    per-variant static TTF fetching (which handles apache/ufl + exotic
///    cases via the contents API).
fn probe_variable_font(
    slug: &str,
    camel: &str,
    dest_dir: &Path,
) -> Option<PathBuf> {
    let candidates: Vec<String> = VF_AXIS_SUFFIXES
        .iter()
        .map(|s| format!("{camel}{s}.ttf"))
        .chain(VF_LEGACY_SUFFIXES.iter().map(|s| format!("{camel}{s}.ttf")))
        .collect();

    // Cache short-circuit: any existing file wins.
    for cand in &candidates {
        let p = dest_dir.join(cand);
        if p.exists() {
            return Some(p);
        }
    }

    // Network probe across all three license subdirs in parallel. Uses a
    // shared Mutex slot so the first success short-circuits siblings'
    // writes. Keeps the total cost for a static-only family (Roboto et al.)
    // to a few parallel HEAD-like GETs — 1-2 round-trip waves, ~300-500 ms.
    // Apache/UFL VF families (uncommon but real, e.g. some older Roboto
    // forks) used to fall through to the GitHub contents API per-variant,
    // which rate-limits. Probing all licenses here dodges that.
    let probes: Vec<(String, &str)> = candidates
        .iter()
        .flat_map(|cand| {
            GITHUB_LICENSES
                .iter()
                .map(move |lic| (cand.clone(), *lic))
        })
        .collect();
    let winner: Mutex<Option<PathBuf>> = Mutex::new(None);
    DOWNLOAD_POOL.install(|| {
        probes.par_iter().for_each(|(cand, license)| {
            if winner.lock().is_some() {
                return;
            }
            let url = format!(
                "https://raw.githubusercontent.com/google/fonts/main/{license}/{slug}/{cand}"
            );
            if let Ok(bytes) = download_bytes(&url, CHROME_UA) {
                if bytes.len() > 200 && bytes[0] == 0x00 {
                    let mut slot = winner.lock();
                    if slot.is_some() {
                        return; // another thread beat us
                    }
                    let dest_path = dest_dir.join(cand);
                    if write_font_file(&dest_path, &bytes).is_ok() {
                        *slot = Some(dest_path);
                    }
                }
            }
        });
    });
    winner.into_inner()
}

/// Write a font file to disk with a fallback for the "used by another
/// process" (os error 32) case. If the file exists and is locked by Windows
/// GDI (typical right after a deactivate), assume the cached copy is good
/// and keep using it — the new bytes are almost certainly the same content.
fn write_font_file(dest: &Path, bytes: &[u8]) -> std::io::Result<()> {
    // Already exists? Trust the cached copy rather than risking a truncate
    // on a still-locked file.
    if dest.exists() {
        return Ok(());
    }
    fs::write(dest, bytes)
}

fn try_github_one_variant(
    variant: &str,
    slug: &str,
    camel: &str,
    dest_dir: &Path,
    license_hint: &Mutex<Option<&'static str>>,
) -> Option<(PathBuf, FontVariant)> {
    let (weight, italic) = variant_weight_italic(variant);
    let style_name = variant_to_github_style(variant);
    let filename = format!("{camel}-{style_name}.ttf");

    // Defensive cache short-circuit: if the exact file already exists on
    // disk we use it without touching the network. Guards against the
    // "os error 32 — in use by another process" failure when Windows still
    // holds a handle on a just-deactivated font and fs::write tries to
    // truncate it.
    let dest_path = dest_dir.join(&filename);
    if dest_path.exists() {
        return Some((
            dest_path,
            FontVariant {
                variant: variant.to_string(),
                weight,
                italic,
            },
        ));
    }

    // Build the license probe order: memoised-hit first (if known), then
    // the rest. Keeps the deterministic ofl→apache→ufl order when nothing
    // has succeeded yet.
    let licenses_order: Vec<&'static str> = {
        let hint = *license_hint.lock();
        match hint {
            Some(hit) => std::iter::once(hit)
                .chain(GITHUB_LICENSES.iter().copied().filter(|l| *l != hit))
                .collect(),
            None => GITHUB_LICENSES.to_vec(),
        }
    };

    let mut got_path: Option<PathBuf> = None;
    let mut winning_license: Option<&'static str> = None;
    for license in &licenses_order {
        let url = format!(
            "https://raw.githubusercontent.com/google/fonts/main/{license}/{slug}/{filename}"
        );
        if let Ok(bytes) = download_bytes(&url, CHROME_UA) {
            if bytes.len() > 200 && bytes[0] == 0x00 {
                if let Err(e) = write_font_file(&dest_path, &bytes) {
                    tracing::warn!("write {:?}: {}", dest_path, e);
                    return None;
                }
                got_path = Some(dest_path.clone());
                winning_license = Some(*license);
                break;
            }
        }
    }

    // VF fallback here is now redundant — `probe_variable_font` runs once
    // per family in the parent `try_github` and short-circuits every variant
    // to the shared file. Keep only the GitHub contents-API last resort for
    // exotic custom-axis families that aren't in our `VF_AXIS_SUFFIXES` list.
    if got_path.is_none() {
        'api: for license in &licenses_order {
            let api_url = format!(
                "https://api.github.com/repos/google/fonts/contents/{license}/{slug}"
            );
            let bytes = match download_bytes(&api_url, "FONTY/1.0") {
                Ok(b) => b,
                Err(_) => continue,
            };
            let text = match std::str::from_utf8(&bytes) {
                Ok(t) => t,
                Err(_) => continue,
            };
            let mut picked: Option<String> = None;
            for chunk in text.split("\"name\":\"").skip(1) {
                if let Some(end) = chunk.find('"') {
                    let name = &chunk[..end];
                    let lower = name.to_ascii_lowercase();
                    if lower.ends_with(".ttf")
                        && (name.contains('[') || lower.contains("variablefont"))
                    {
                        picked = Some(name.to_string());
                        break;
                    }
                }
            }
            if let Some(name) = picked {
                let raw = format!(
                    "https://raw.githubusercontent.com/google/fonts/main/{license}/{slug}/{name}"
                );
                if let Ok(b) = download_bytes(&raw, CHROME_UA) {
                    if b.len() > 200 && b[0] == 0x00 {
                        let vf_path = dest_dir.join(&name);
                        if write_font_file(&vf_path, &b).is_ok() {
                            got_path = Some(vf_path);
                            winning_license = Some(*license);
                            break 'api;
                        }
                    }
                }
            }
        }
    }

    // Share the winning license with sibling threads so the rest of the
    // batch skips the other two.
    if let Some(lic) = winning_license {
        let mut hint = license_hint.lock();
        if hint.is_none() {
            *hint = Some(lic);
        }
    }

    got_path.map(|path| {
        (
            path,
            FontVariant {
                variant: variant.to_string(),
                weight,
                italic,
            },
        )
    })
}

fn parse_variant_from_filename(stem: &str, family: &str) -> (String, i32, bool) {
    let slug = family.replace(' ', "");
    let after = stem
        .strip_prefix(&slug)
        .or_else(|| stem.strip_prefix(&slug.to_ascii_lowercase()))
        .unwrap_or(stem);
    let tail = after
        .rsplit(|c| c == '-' || c == '_')
        .next()
        .unwrap_or(after);
    let italic = tail.to_ascii_lowercase().contains("italic");
    let weight_label = tail
        .replace("Italic", "")
        .replace("italic", "")
        .trim_start_matches(&['-', '_'][..])
        .trim_end_matches(&['-', '_'][..])
        .to_string();
    let weight_label = if weight_label.is_empty() {
        "Regular".to_string()
    } else {
        weight_label
    };
    let weight = match weight_label.as_str() {
        "Regular" | "Book" => 400,
        "Thin" | "Hairline" => 100,
        "ExtraLight" | "UltraLight" => 200,
        "Light" => 300,
        "Medium" => 500,
        "SemiBold" | "DemiBold" => 600,
        "Bold" => 700,
        "ExtraBold" | "UltraBold" => 800,
        "Black" | "Heavy" => 900,
        _ => 400,
    };
    let variant = if italic && weight == 400 {
        "italic".to_string()
    } else if italic {
        format!("{}italic", weight)
    } else if weight == 400 {
        "regular".to_string()
    } else {
        weight.to_string()
    };
    (variant, weight, italic)
}

/// Translate a Google variant string like "700italic" into a Windows-style
/// style name (e.g. "Bold Italic"). Empty for "regular".
fn variant_to_style_name(v: &str) -> String {
    let italic = v.contains("italic");
    let weight_str = v.replace("italic", "").replace("regular", "");
    let weight: i32 = if weight_str.is_empty() {
        400
    } else {
        weight_str.parse().unwrap_or(400)
    };
    let weight_name = match weight {
        100 => "Thin",
        200 => "ExtraLight",
        300 => "Light",
        400 => "",
        500 => "Medium",
        600 => "SemiBold",
        700 => "Bold",
        800 => "ExtraBold",
        900 => "Black",
        _ => "",
    };
    match (weight_name.is_empty(), italic) {
        (true, true) => "Italic".to_string(),
        (true, false) => String::new(),
        (false, true) => format!("{} Italic", weight_name),
        (false, false) => weight_name.to_string(),
    }
}

/// Name used for the HKCU\...\Fonts registry value for a Google font variant.
/// Format matches what Windows Fonts list expects, e.g. `Roboto Bold (TrueType)`.
pub fn registry_display_name(family: &str, variant: &str) -> String {
    let style = variant_to_style_name(variant);
    let full = if style.is_empty() {
        format!("FONTY Google {family}")
    } else {
        format!("FONTY Google {family} {style}")
    };
    format!("{} (TrueType)", full)
}

pub fn cache_dir_for_family(cache_root: &Path, family: &str) -> PathBuf {
    let safe: String = family
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    cache_root.join("google").join(safe)
}

/// Total bytes of every cached TTF/OTF under `<cache_root>/google/*`.
/// Returns 0 if the directory doesn't exist yet. Used by Settings to show the
/// current Google Fonts cache footprint next to the clear-cache buttons.
pub fn cache_size_total(cache_root: &Path) -> u64 {
    let google_root = cache_root.join("google");
    sum_dir_file_sizes(&google_root)
}

fn sum_dir_file_sizes(dir: &Path) -> u64 {
    let mut total = 0u64;
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            total += sum_dir_file_sizes(&path);
        } else if let Ok(meta) = entry.metadata() {
            total += meta.len();
        }
    }
    total
}

/// Wipe a single family's cache directory. Returns `(files_removed, bytes_freed)`.
/// No-op if the directory doesn't exist. Called by the per-family "Remove
/// from PC" action and by the 5-minute janitor.
pub fn remove_family_cache(cache_root: &Path, family: &str) -> (usize, u64) {
    let dir = cache_dir_for_family(cache_root, family);
    let mut files = 0usize;
    let mut bytes = 0u64;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                if fs::remove_file(&path).is_ok() {
                    files += 1;
                    bytes += size;
                }
            }
        }
    }
    let _ = fs::remove_dir(&dir);
    (files, bytes)
}

/// Wipe every cache dir under `<cache_root>/google/` whose family name is NOT
/// in `active_families`. Returns `(files_removed, bytes_freed)`. Used by the
/// Settings "Clear cache for inactive Google families" sweep and also called
/// with a single-family set by the janitor in degenerate cases.
pub fn clear_inactive_cache(
    cache_root: &Path,
    active_family_dirnames: &std::collections::HashSet<String>,
) -> (usize, u64) {
    let google_root = cache_root.join("google");
    let mut files = 0usize;
    let mut bytes = 0u64;
    let entries = match fs::read_dir(&google_root) {
        Ok(e) => e,
        Err(_) => return (0, 0),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = match path.file_name().and_then(|f| f.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if active_family_dirnames.contains(&dir_name) {
            continue;
        }
        if let Ok(inner) = fs::read_dir(&path) {
            for f in inner.flatten() {
                let fp = f.path();
                if fp.is_file() {
                    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
                    if fs::remove_file(&fp).is_ok() {
                        files += 1;
                        bytes += size;
                    }
                }
            }
        }
        let _ = fs::remove_dir(&path);
    }
    (files, bytes)
}

/// Sanitise a family name into the directory-name shape used by
/// [`cache_dir_for_family`]. Useful for the janitor/sweep which compare against
/// on-disk directory names.
pub fn family_dir_name(family: &str) -> String {
    family
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// A named instance of a variable font — e.g. "Condensed Bold Italic" for a
/// family with wdth + wght + ital axes. Windows exposes these to Word/
/// Affinity as individual picker entries, but Google's catalog API only
/// exposes weight + italic variants. We parse them out of the cached TTF
/// so the styles tray can show everything the user will see in their apps.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedInstance {
    pub name: String,
    /// Axis tag → coordinate value (e.g. `"wdth" → 75.0`, `"wght" → 700.0`).
    /// Frontend applies these via `font-variation-settings`.
    pub axes: Vec<(String, f32)>,
    /// Convenience: weight derived from `wght` axis if present, else 400.
    pub weight: f32,
    /// Convenience: italic derived from `ital`/`slnt` axes if present.
    pub italic: bool,
}

/// Read named instances from the cached VF file for a family. Returns an
/// empty list for non-VF families or when no cached TTF exists yet. Walks
/// the cache dir looking for `.ttf`/`.otf` files with a square-bracket axis
/// tag in the filename (e.g. `Inconsolata[wdth,wght].ttf`) or the legacy
/// `-VariableFont_...` naming. Parses fvar + name tables via ttf-parser.
pub fn read_named_instances_for_family(
    cache_root: &Path,
    family: &str,
) -> Vec<NamedInstance> {
    let dir = cache_dir_for_family(cache_root, family);
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        let lower = name.to_ascii_lowercase();
        if !(lower.ends_with(".ttf") || lower.ends_with(".otf")) {
            continue;
        }
        // Heuristic: VFs have `[` or `VariableFont` in the filename. Static
        // TTFs never do, so we can skip them fast without opening the file.
        if !(name.contains('[') || lower.contains("variablefont")) {
            continue;
        }
        if let Ok(list) = parse_named_instances(&path) {
            if !list.is_empty() {
                return list;
            }
        }
    }
    Vec::new()
}

fn parse_named_instances(path: &Path) -> Result<Vec<NamedInstance>> {
    let data = fs::read(path)?;
    let face = ttf_parser::Face::parse(&data, 0)?;
    let axis_tags: Vec<String> = face
        .variation_axes()
        .into_iter()
        .map(|a| tag_to_string(a.tag))
        .collect();
    if axis_tags.is_empty() {
        return Ok(Vec::new());
    }
    // ttf-parser 0.25 exposes the axes from fvar but not the named instances.
    // Parse them manually from the raw table bytes — the spec is at
    // https://learn.microsoft.com/en-us/typography/opentype/spec/fvar#instancerecord
    let fvar_tag = ttf_parser::Tag::from_bytes(b"fvar");
    let raw = face.raw_face().table(fvar_tag).ok_or_else(|| {
        FontyError::Msg("fvar table missing despite variation axes".into())
    })?;
    let instances = parse_fvar_instance_records(raw, axis_tags.len())?;

    let mut out = Vec::new();
    for inst in &instances {
        let raw_name = read_name_id(&face, inst.subfamily_name_id)
            .unwrap_or_else(|| "Instance".to_string());
        let mut axis_values: Vec<(String, f32)> = Vec::new();
        let mut weight = 400.0f32;
        let mut italic = false;
        for (tag, coord) in axis_tags.iter().zip(inst.coordinates.iter()) {
            if tag == "wght" {
                weight = *coord;
            } else if tag == "ital" {
                italic = *coord > 0.5;
            } else if tag == "slnt" && coord.abs() > 1.0 {
                italic = true;
            }
            axis_values.push((tag.clone(), *coord));
        }
        out.push(NamedInstance {
            name: raw_name,
            axes: axis_values,
            weight,
            italic,
        });
    }
    Ok(out)
}

struct InstanceRecord {
    subfamily_name_id: u16,
    coordinates: Vec<f32>,
}

/// Manual fvar instance parser. fvar header is:
///   majorVersion u16, minorVersion u16, axesArrayOffset u16, reserved u16,
///   axisCount u16, axisSize u16, instanceCount u16, instanceSize u16
/// Then axes array (axisSize bytes each), then instance array (instanceSize
/// bytes each). Each instance:
///   subfamilyNameID u16, flags u16, coordinates[axisCount] (Fixed 16.16),
///   postScriptNameID u16 (optional; present if instanceSize > axisCount*4+4)
fn parse_fvar_instance_records(
    raw: &[u8],
    axis_count: usize,
) -> Result<Vec<InstanceRecord>> {
    if raw.len() < 16 {
        return Ok(Vec::new());
    }
    let read_u16 = |off: usize| -> u16 {
        u16::from_be_bytes([raw[off], raw[off + 1]])
    };
    let read_i32 = |off: usize| -> i32 {
        i32::from_be_bytes([raw[off], raw[off + 1], raw[off + 2], raw[off + 3]])
    };

    let axes_array_offset = read_u16(4) as usize;
    // bytes 6..8 reserved, 8..10 axisCount, 10..12 axisSize,
    // 12..14 instanceCount, 14..16 instanceSize
    let axis_size = read_u16(10) as usize;
    let instance_count = read_u16(12) as usize;
    let instance_size = read_u16(14) as usize;

    let min_instance_size = 4 + axis_count * 4;
    if instance_size < min_instance_size {
        return Ok(Vec::new());
    }

    let instances_start = axes_array_offset + axis_size * axis_count;
    let mut out = Vec::with_capacity(instance_count);
    for i in 0..instance_count {
        let base = instances_start + i * instance_size;
        if base + min_instance_size > raw.len() {
            break;
        }
        let subfamily_name_id = read_u16(base);
        // base+2 flags (skip)
        let mut coords = Vec::with_capacity(axis_count);
        for j in 0..axis_count {
            let coord_off = base + 4 + j * 4;
            // Fixed 16.16 → f32
            let fixed = read_i32(coord_off);
            coords.push(fixed as f32 / 65536.0);
        }
        out.push(InstanceRecord {
            subfamily_name_id,
            coordinates: coords,
        });
    }
    Ok(out)
}

fn tag_to_string(tag: ttf_parser::Tag) -> String {
    let bytes = tag.to_bytes();
    String::from_utf8_lossy(&bytes).trim().to_string()
}

fn read_name_id(face: &ttf_parser::Face, id: u16) -> Option<String> {
    let names = face.names();
    let len = names.len();
    let mut best: Option<String> = None;
    for i in 0..len {
        let n = names.get(i)?;
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
