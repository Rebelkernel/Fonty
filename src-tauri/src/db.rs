use crate::error::Result;
use crate::parser::{now_secs, ParsedFont};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::path::Path;

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "temp_store", "MEMORY")?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        db.seed_roots_from_legacy()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS fonts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL,
                ttc_index INTEGER NOT NULL DEFAULT 0,
                file_hash TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                file_mtime INTEGER NOT NULL,
                family_name TEXT NOT NULL,
                subfamily TEXT,
                typographic_family TEXT,
                typographic_subfamily TEXT,
                postscript_name TEXT,
                designer TEXT,
                weight INTEGER NOT NULL DEFAULT 400,
                italic INTEGER NOT NULL DEFAULT 0,
                width INTEGER NOT NULL DEFAULT 5,
                classification TEXT NOT NULL,
                format TEXT NOT NULL,
                added_at INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL,
                UNIQUE(file_path, ttc_index)
            );
            CREATE INDEX IF NOT EXISTS idx_fonts_family ON fonts(family_name COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_fonts_classification ON fonts(classification);
            CREATE INDEX IF NOT EXISTS idx_fonts_hash ON fonts(file_hash);

            CREATE TABLE IF NOT EXISTS favorites (
                font_id INTEGER PRIMARY KEY REFERENCES fonts(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS activations (
                font_id INTEGER PRIMARY KEY REFERENCES fonts(id) ON DELETE CASCADE,
                registry_key TEXT NOT NULL,
                activated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            CREATE TABLE IF NOT EXISTS roots (
                path TEXT PRIMARY KEY,
                added_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS collections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS collection_fonts (
                collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
                font_id INTEGER NOT NULL REFERENCES fonts(id) ON DELETE CASCADE,
                added_at INTEGER NOT NULL,
                PRIMARY KEY (collection_id, font_id)
            );
            CREATE INDEX IF NOT EXISTS idx_cf_collection ON collection_fonts(collection_id);
            CREATE INDEX IF NOT EXISTS idx_cf_font ON collection_fonts(font_id);

            CREATE TABLE IF NOT EXISTS google_families (
                family_name TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                variants TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS google_activations (
                family_name TEXT NOT NULL,
                variant TEXT NOT NULL,
                cached_path TEXT NOT NULL,
                weight INTEGER NOT NULL DEFAULT 400,
                italic INTEGER NOT NULL DEFAULT 0,
                activated_at INTEGER NOT NULL,
                PRIMARY KEY (family_name, variant)
            );

            -- Google families added to a user collection. Separate from
            -- collection_fonts because Google families don't have a local
            -- font_id until they're activated; we want collection membership
            -- to work before any download happens.
            CREATE TABLE IF NOT EXISTS collection_google_families (
                collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
                family_name TEXT NOT NULL,
                added_at INTEGER NOT NULL,
                PRIMARY KEY (collection_id, family_name)
            );
            CREATE INDEX IF NOT EXISTS idx_cgf_collection
                ON collection_google_families(collection_id);
            CREATE INDEX IF NOT EXISTS idx_cgf_family
                ON collection_google_families(family_name);

            -- Individual Google variants in a collection (e.g. "Roboto" + "700italic").
            -- Parallel to how local fonts can be added as individual styles
            -- via collection_fonts.font_id.
            CREATE TABLE IF NOT EXISTS collection_google_variants (
                collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
                family_name TEXT NOT NULL,
                variant TEXT NOT NULL,
                added_at INTEGER NOT NULL,
                PRIMARY KEY (collection_id, family_name, variant)
            );
            CREATE INDEX IF NOT EXISTS idx_cgv_collection
                ON collection_google_variants(collection_id);
            CREATE INDEX IF NOT EXISTS idx_cgv_family
                ON collection_google_variants(family_name);

            -- Pending Google-cache wipes. Every full-family deactivate inserts
            -- a row here with the current timestamp; a janitor task clears
            -- the family's cache dir 5 minutes later if the family is still
            -- fully inactive. Reactivate clears the row. Survives restarts
            -- so the 5-min timer is wall-clock, not session-local.
            CREATE TABLE IF NOT EXISTS google_cache_pending_wipe (
                family_name TEXT PRIMARY KEY,
                marked_at INTEGER NOT NULL
            );
            "#,
        )?;
        // Additive migration for designer column (existing DBs won't have it)
        let _ = conn.execute("ALTER TABLE fonts ADD COLUMN designer TEXT", []);
        // Additive migration: registry_key on google_activations so we can
        // unregister the HKCU entry on deactivation.
        let _ = conn.execute(
            "ALTER TABLE google_activations ADD COLUMN registry_key TEXT NOT NULL DEFAULT ''",
            [],
        );

        // One-time data migration: Google activations stored with the long
        // variant format ("regular", "italic", "700italic") get normalised
        // to the catalog's short format ("400", "400i", "700i"). Gated by
        // a settings-table marker so subsequent launches skip the 22 SQL
        // passes — this was adding a visible chunk of startup latency on
        // large DBs.
        const MIGRATION_KEY: &str = "migration_google_variants_short_v1";
        let already_done: bool = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [MIGRATION_KEY],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
            .map(|v| v == "1")
            .unwrap_or(false);
        if !already_done {
            for (from, to) in [
            ("regular", "400"),
            ("italic", "400i"),
            ("100italic", "100i"),
            ("200italic", "200i"),
            ("300italic", "300i"),
            ("400italic", "400i"),
            ("500italic", "500i"),
            ("600italic", "600i"),
            ("700italic", "700i"),
            ("800italic", "800i"),
            ("900italic", "900i"),
        ] {
            let _ = conn.execute(
                "UPDATE OR IGNORE google_activations SET variant = ?1 WHERE variant = ?2",
                params![to, from],
            );
            // Whatever couldn't be normalised because the target already
            // exists is redundant; drop it.
            let _ = conn.execute(
                "DELETE FROM google_activations WHERE variant = ?1",
                params![from],
            );
        }
            let _ = conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, '1')",
                [MIGRATION_KEY],
            );
        }
        Ok(())
    }

    pub fn seed_roots_from_legacy(&self) -> Result<()> {
        let conn = self.conn.lock();
        let existing: i64 =
            conn.query_row("SELECT COUNT(*) FROM roots", [], |r| r.get(0))?;
        if existing > 0 {
            return Ok(());
        }
        let has_fonts: i64 =
            conn.query_row("SELECT COUNT(*) FROM fonts", [], |r| r.get(0))?;
        if has_fonts == 0 {
            return Ok(());
        }

        let legacy: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'root_folder'",
                [],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();

        let path = if let Some(p) = legacy {
            Some(p)
        } else {
            let mut paths = Vec::new();
            {
                let mut stmt = conn.prepare("SELECT file_path FROM fonts LIMIT 500")?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                for row in rows {
                    if let Ok(p) = row {
                        paths.push(p);
                    }
                }
            }
            common_ancestor(&paths)
        };

        if let Some(p) = path {
            conn.execute(
                "INSERT OR IGNORE INTO roots (path, added_at) VALUES (?1, ?2)",
                params![p, now_secs()],
            )?;
        }
        Ok(())
    }

    pub fn list_roots(&self) -> Result<Vec<RootFolder>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT path, added_at FROM roots ORDER BY added_at")?;
        let rows = stmt.query_map([], |r| {
            Ok(RootFolder {
                path: r.get(0)?,
                added_at: r.get(1)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn add_root(&self, path: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR IGNORE INTO roots (path, added_at) VALUES (?1, ?2)",
            params![path, now_secs()],
        )?;
        Ok(())
    }

    pub fn remove_root(&self, root_path: &str) -> Result<usize> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;

        let other_roots: Vec<String> = {
            let mut stmt = tx.prepare("SELECT path FROM roots WHERE path != ?1")?;
            let rows = stmt.query_map([root_path], |r| r.get::<_, String>(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let sep = if root_path.contains('\\') { "\\" } else { "/" };
        let this_prefix = ensure_trailing_sep(root_path, sep);
        let other_prefixes: Vec<String> = other_roots
            .iter()
            .map(|r| ensure_trailing_sep(r, if r.contains('\\') { "\\" } else { "/" }))
            .collect();

        let mut ids_to_delete: Vec<i64> = Vec::new();
        {
            let mut stmt = tx.prepare("SELECT id, file_path FROM fonts")?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (id, path) = row?;
                if !path.starts_with(&this_prefix) {
                    continue;
                }
                let covered_by_other = other_prefixes.iter().any(|p| path.starts_with(p));
                if !covered_by_other {
                    ids_to_delete.push(id);
                }
            }
        }

        let deleted = ids_to_delete.len();
        for chunk in ids_to_delete.chunks(500) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!("DELETE FROM fonts WHERE id IN ({})", placeholders);
            tx.execute(
                &sql,
                rusqlite::params_from_iter(chunk.iter().map(|n| *n)),
            )?;
        }
        tx.execute("DELETE FROM roots WHERE path = ?1", [root_path])?;
        tx.commit()?;
        Ok(deleted)
    }

    pub fn upsert_batch(&self, fonts: &[ParsedFont]) -> Result<usize> {
        if fonts.is_empty() {
            return Ok(0);
        }
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let now = now_secs();
        let mut inserted = 0usize;
        {
            let mut stmt = tx.prepare(
                r#"INSERT INTO fonts (file_path, ttc_index, file_hash, file_size, file_mtime,
                    family_name, subfamily, typographic_family, typographic_subfamily,
                    postscript_name, designer, weight, italic, width, classification, format,
                    added_at, last_seen_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
                   ON CONFLICT(file_path, ttc_index) DO UPDATE SET
                     file_hash=excluded.file_hash,
                     file_size=excluded.file_size,
                     file_mtime=excluded.file_mtime,
                     family_name=excluded.family_name,
                     subfamily=excluded.subfamily,
                     typographic_family=excluded.typographic_family,
                     typographic_subfamily=excluded.typographic_subfamily,
                     postscript_name=excluded.postscript_name,
                     designer=excluded.designer,
                     weight=excluded.weight,
                     italic=excluded.italic,
                     width=excluded.width,
                     classification=excluded.classification,
                     format=excluded.format,
                     last_seen_at=excluded.last_seen_at"#,
            )?;
            for f in fonts {
                stmt.execute(params![
                    f.file_path.to_string_lossy(),
                    f.ttc_index,
                    f.file_hash,
                    f.file_size,
                    f.file_mtime,
                    f.family_name,
                    f.subfamily,
                    f.typographic_family,
                    f.typographic_subfamily,
                    f.postscript_name,
                    f.designer,
                    f.weight,
                    f.italic as i32,
                    f.width,
                    f.classification,
                    f.format,
                    now,
                    now,
                ])?;
                inserted += 1;
            }
        }
        tx.commit()?;
        Ok(inserted)
    }

    pub fn font_count(&self) -> Result<i64> {
        let conn = self.conn.lock();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM fonts", [], |r| r.get(0))?;
        Ok(n)
    }

    pub fn family_count(&self) -> Result<i64> {
        // Must match how list_families() and folder_trees() dedupe — otherwise
        // the "All Fonts" counter in the sidebar disagrees with the folder
        // row ("2008") and the main card header ("N families"). Use the same
        // COALESCE(typographic_family, family_name) so all three speak the
        // same language.
        let conn = self.conn.lock();
        let n: i64 = conn.query_row(
            "SELECT COUNT(DISTINCT COALESCE(NULLIF(typographic_family, ''), family_name)) FROM fonts",
            [],
            |r| r.get(0),
        )?;
        Ok(n)
    }

    pub fn list_families(
        &self,
        folder_filter: Option<&str>,
        collection_id: Option<i64>,
    ) -> Result<Vec<FamilySummary>> {
        let conn = self.conn.lock();
        let prefix = folder_filter.map(|f| {
            let sep = if f.contains('\\') { '\\' } else { '/' };
            if f.ends_with(sep) {
                f.to_string()
            } else {
                format!("{}{}", f, sep)
            }
        });
        let mut stmt = conn.prepare(
            r#"
            WITH base AS (
              -- When a collection is set, scope every count (styles, active,
              -- starred, representative, collection pills) to fonts that are
              -- actually in the collection. That's what makes individual
              -- styles appear as their own "family" in the collection view.
              -- Folder filter is the same as before — we don't shrink counts
              -- to the folder, we still want the full family.
              SELECT id, file_path, ttc_index, classification, weight, italic,
                format, designer, typographic_family,
                COALESCE(NULLIF(typographic_family, ''), family_name) AS eff_family
              FROM fonts
              WHERE (?2 IS NULL OR id IN (
                SELECT font_id FROM collection_fonts WHERE collection_id = ?2
              ))
            ),
            visible AS (
              SELECT DISTINCT eff_family FROM base
              WHERE (?1 IS NULL OR substr(file_path, 1, length(?1)) = ?1)
            ),
            ranked AS (
              SELECT id, file_path, ttc_index, classification, format, designer, eff_family,
                ROW_NUMBER() OVER (PARTITION BY eff_family
                  ORDER BY ABS(weight - 400), italic, id) AS rn
              FROM base
            ),
            counts AS (
              SELECT b.eff_family,
                COUNT(*) AS styles,
                COUNT(a.font_id) AS active_count,
                COUNT(fv.font_id) AS starred_count
              FROM base b
              LEFT JOIN activations a ON a.font_id = b.id
              LEFT JOIN favorites fv ON fv.font_id = b.id
              GROUP BY b.eff_family
            ),
            fam_colls_dedup AS (
              SELECT DISTINCT b.eff_family, c.name
              FROM base b
              JOIN collection_fonts cf ON cf.font_id = b.id
              JOIN collections c ON c.id = cf.collection_id
            ),
            fam_colls AS (
              SELECT eff_family, GROUP_CONCAT(name, CHAR(31)) AS names
              FROM fam_colls_dedup
              GROUP BY eff_family
            )
            SELECT r.eff_family, c.styles, c.active_count, c.starred_count,
                   r.classification, r.id, r.file_path, r.ttc_index,
                   r.format, r.designer, fc.names
            FROM ranked r
            JOIN counts c USING (eff_family)
            LEFT JOIN fam_colls fc USING (eff_family)
            WHERE r.rn = 1
              AND r.eff_family IN (SELECT eff_family FROM visible)
            ORDER BY r.eff_family COLLATE NOCASE
            "#,
        )?;
        let rows = stmt.query_map(params![prefix, collection_id], |r| {
            let collection_names: Vec<String> = r
                .get::<_, Option<String>>(10)?
                .map(|s| {
                    s.split('\u{001F}')
                        .filter(|x| !x.is_empty())
                        .map(|x| x.to_string())
                        .collect()
                })
                .unwrap_or_default();
            Ok(FamilySummary {
                family_name: r.get(0)?,
                styles: r.get(1)?,
                active_count: r.get(2)?,
                starred_count: r.get(3)?,
                classification: r.get(4)?,
                rep_id: r.get(5)?,
                file_path: r.get(6)?,
                ttc_index: r.get(7)?,
                format: r.get(8)?,
                designer: r.get(9)?,
                collection_names,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn folder_trees(&self) -> Result<Vec<FolderNode>> {
        let roots = self.list_roots()?;
        // Also pull each font's effective family so we can compute per-folder
        // family counts in a second pass. Using typographic_family when set
        // keeps us consistent with list_families() — otherwise the folder
        // number would count "Bodoni Bold" and "Bodoni" as separate families.
        let fonts: Vec<(String, String, bool)> = {
            let conn = self.conn.lock();
            let mut stmt = conn.prepare(
                r#"SELECT f.file_path,
                          COALESCE(NULLIF(f.typographic_family, ''), f.family_name) AS fam,
                          (a.font_id IS NOT NULL) AS is_active
                   FROM fonts f
                   LEFT JOIN activations a ON a.font_id = f.id"#,
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)? != 0,
                ))
            })?;
            let mut out = Vec::new();
            for row in rows {
                if let Ok(p) = row {
                    out.push(p);
                }
            }
            out
        };

        // For every ancestor directory of each font, remember which families
        // live underneath. After the tree is built we hand these sets to
        // assign_family_counts so each folder node reports distinct families
        // (not font files).
        let mut folder_families: HashMap<String, HashSet<String>> = HashMap::new();
        let mut folder_active_families: HashMap<String, HashSet<String>> = HashMap::new();
        for (path, fam, active) in &fonts {
            let sep = if path.contains('\\') { '\\' } else { '/' };
            let mut cur: &str = path.as_str();
            while let Some(idx) = cur.rfind(sep) {
                cur = &cur[..idx];
                folder_families
                    .entry(cur.to_string())
                    .or_default()
                    .insert(fam.clone());
                if *active {
                    folder_active_families
                        .entry(cur.to_string())
                        .or_default()
                        .insert(fam.clone());
                }
            }
        }

        let mut trees = Vec::with_capacity(roots.len());
        for root in roots {
            let sep_char = if root.path.contains('\\') { '\\' } else { '/' };
            let root_clean = root.path.trim_end_matches(sep_char).to_string();
            let prefix = format!("{}{}", root_clean, sep_char);
            let under_root: Vec<&(String, String, bool)> = fonts
                .iter()
                .filter(|(p, _, _)| p.starts_with(&prefix))
                .collect();
            let mut tree = build_folder_tree(&root_clean, sep_char, &under_root);
            assign_family_counts(&mut tree, &folder_families, &folder_active_families);
            trees.push(tree);
        }
        Ok(trees)
    }

    pub fn active_font_ids(&self) -> Result<Vec<i64>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT font_id FROM activations")?;
        let rows = stmt.query_map([], |r| r.get::<_, i64>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn starred_font_ids(&self) -> Result<Vec<i64>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT font_id FROM favorites")?;
        let rows = stmt.query_map([], |r| r.get::<_, i64>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn star_fonts(&self, ids: &[i64]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        {
            let mut stmt =
                tx.prepare("INSERT OR IGNORE INTO favorites (font_id) VALUES (?1)")?;
            for id in ids {
                stmt.execute([id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn unstar_fonts(&self, ids: &[i64]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for chunk in ids.chunks(500) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "DELETE FROM favorites WHERE font_id IN ({})",
                placeholders
            );
            tx.execute(&sql, rusqlite::params_from_iter(chunk.iter().copied()))?;
        }
        tx.commit()?;
        Ok(())
    }

    // ----- Collections -----

    pub fn list_collections(&self) -> Result<Vec<Collection>> {
        let conn = self.conn.lock();
        // family_count = distinct local families + distinct Google families
        // in this collection, because users add both kinds. font_count and
        // active_font_count stay file-level (Google entries don't have local
        // font ids until activation, so they only contribute to family_count).
        let mut stmt = conn.prepare(
            r#"SELECT c.id, c.name, c.created_at,
                (
                  (SELECT COUNT(DISTINCT COALESCE(NULLIF(f.typographic_family, ''), f.family_name))
                   FROM collection_fonts cf
                   JOIN fonts f ON f.id = cf.font_id
                   WHERE cf.collection_id = c.id)
                  +
                  (SELECT COUNT(*) FROM collection_google_families cgf
                   WHERE cgf.collection_id = c.id)
                  +
                  -- Google variants whose parent family isn't already in the
                  -- collection (avoid double-counting when both family and
                  -- variant are added).
                  (SELECT COUNT(DISTINCT cgv.family_name)
                   FROM collection_google_variants cgv
                   WHERE cgv.collection_id = c.id
                     AND NOT EXISTS (
                       SELECT 1 FROM collection_google_families cgf2
                       WHERE cgf2.collection_id = c.id
                         AND cgf2.family_name = cgv.family_name
                     ))
                ) AS family_count,
                (SELECT COUNT(*) FROM collection_fonts cf WHERE cf.collection_id = c.id)
                  AS font_count,
                (SELECT COUNT(*) FROM collection_fonts cf
                 JOIN activations a ON a.font_id = cf.font_id
                 WHERE cf.collection_id = c.id) AS active_font_count
               FROM collections c
               ORDER BY c.created_at ASC"#,
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Collection {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                family_count: r.get(3)?,
                font_count: r.get(4)?,
                active_font_count: r.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn create_collection(&self, name: &str) -> Result<i64> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO collections (name, created_at) VALUES (?1, ?2)",
            params![name, now_secs()],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn rename_collection(&self, id: i64, name: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE collections SET name = ?1 WHERE id = ?2",
            params![name, id],
        )?;
        Ok(())
    }

    pub fn delete_collection(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM collections WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn add_fonts_to_collection(&self, collection_id: i64, ids: &[i64]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                r#"INSERT OR IGNORE INTO collection_fonts (collection_id, font_id, added_at)
                   VALUES (?1, ?2, ?3)"#,
            )?;
            let now = now_secs();
            for id in ids {
                stmt.execute(params![collection_id, id, now])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn collection_font_ids(&self, collection_id: i64) -> Result<Vec<i64>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT font_id FROM collection_fonts WHERE collection_id = ?1",
        )?;
        let rows = stmt.query_map([collection_id], |r| r.get::<_, i64>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn collections_for_family(
        &self,
        family_name: &str,
    ) -> Result<Vec<Collection>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"SELECT DISTINCT c.id, c.name, c.created_at,
                 0 AS family_count, 0 AS font_count, 0 AS active_font_count
               FROM collections c
               JOIN collection_fonts cf ON cf.collection_id = c.id
               JOIN fonts f ON f.id = cf.font_id
               WHERE COALESCE(NULLIF(f.typographic_family, ''), f.family_name) = ?1
               ORDER BY c.name COLLATE NOCASE"#,
        )?;
        let rows = stmt.query_map([family_name], |r| {
            Ok(Collection {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                family_count: r.get(3)?,
                font_count: r.get(4)?,
                active_font_count: r.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn add_google_family_to_collection(
        &self,
        collection_id: i64,
        family_name: &str,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"INSERT OR IGNORE INTO collection_google_families
                 (collection_id, family_name, added_at)
               VALUES (?1, ?2, ?3)"#,
            params![collection_id, family_name, now_secs()],
        )?;
        Ok(())
    }

    pub fn remove_google_family_from_collection(
        &self,
        collection_id: i64,
        family_name: &str,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"DELETE FROM collection_google_families
                 WHERE collection_id = ?1 AND family_name = ?2"#,
            params![collection_id, family_name],
        )?;
        Ok(())
    }

    pub fn collection_google_family_names(
        &self,
        collection_id: i64,
    ) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"SELECT family_name FROM collection_google_families
                 WHERE collection_id = ?1
                 ORDER BY added_at DESC"#,
        )?;
        let rows = stmt.query_map([collection_id], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn collections_for_google_family(
        &self,
        family_name: &str,
    ) -> Result<Vec<Collection>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"SELECT c.id, c.name, c.created_at,
                 0 AS family_count, 0 AS font_count, 0 AS active_font_count
               FROM collections c
               JOIN collection_google_families cgf ON cgf.collection_id = c.id
               WHERE cgf.family_name = ?1
               ORDER BY c.name COLLATE NOCASE"#,
        )?;
        let rows = stmt.query_map([family_name], |r| {
            Ok(Collection {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                family_count: r.get(3)?,
                font_count: r.get(4)?,
                active_font_count: r.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn add_google_variant_to_collection(
        &self,
        collection_id: i64,
        family_name: &str,
        variant: &str,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"INSERT OR IGNORE INTO collection_google_variants
                 (collection_id, family_name, variant, added_at)
               VALUES (?1, ?2, ?3, ?4)"#,
            params![collection_id, family_name, variant, now_secs()],
        )?;
        Ok(())
    }

    pub fn remove_google_variant_from_collection(
        &self,
        collection_id: i64,
        family_name: &str,
        variant: &str,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"DELETE FROM collection_google_variants
                 WHERE collection_id = ?1
                   AND family_name = ?2
                   AND variant = ?3"#,
            params![collection_id, family_name, variant],
        )?;
        Ok(())
    }

    pub fn collection_google_variants(
        &self,
        collection_id: i64,
    ) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"SELECT family_name, variant FROM collection_google_variants
                 WHERE collection_id = ?1
                 ORDER BY added_at DESC"#,
        )?;
        let rows = stmt.query_map([collection_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn toggle_font_in_collection(
        &self,
        collection_id: i64,
        font_id: i64,
    ) -> Result<bool> {
        // Returns true if the font was added, false if it was removed.
        let conn = self.conn.lock();
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM collection_fonts WHERE collection_id = ?1 AND font_id = ?2",
            params![collection_id, font_id],
            |r| r.get(0),
        )?;
        if exists > 0 {
            conn.execute(
                "DELETE FROM collection_fonts WHERE collection_id = ?1 AND font_id = ?2",
                params![collection_id, font_id],
            )?;
            Ok(false)
        } else {
            conn.execute(
                "INSERT INTO collection_fonts (collection_id, font_id, added_at) VALUES (?1, ?2, ?3)",
                params![collection_id, font_id, now_secs()],
            )?;
            Ok(true)
        }
    }

    pub fn toggle_family_in_collection(
        &self,
        collection_id: i64,
        family_name: &str,
    ) -> Result<bool> {
        let mut conn = self.conn.lock();
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM collection_fonts cf JOIN fonts f ON f.id = cf.font_id
             WHERE cf.collection_id = ?1
               AND COALESCE(NULLIF(f.typographic_family, ''), f.family_name) = ?2",
            params![collection_id, family_name],
            |r| r.get(0),
        )?;
        if exists > 0 {
            conn.execute(
                "DELETE FROM collection_fonts WHERE collection_id = ?1
                   AND font_id IN (
                     SELECT id FROM fonts
                     WHERE COALESCE(NULLIF(typographic_family, ''), family_name) = ?2
                   )",
                params![collection_id, family_name],
            )?;
            Ok(false)
        } else {
            let ids: Vec<i64> = {
                let mut stmt = conn.prepare(
                    "SELECT id FROM fonts
                     WHERE COALESCE(NULLIF(typographic_family, ''), family_name) = ?1",
                )?;
                let rows = stmt.query_map([family_name], |r| r.get::<_, i64>(0))?;
                rows.filter_map(|r| r.ok()).collect()
            };
            let tx = conn.transaction()?;
            {
                let mut insert = tx.prepare(
                    "INSERT OR IGNORE INTO collection_fonts (collection_id, font_id, added_at)
                     VALUES (?1, ?2, ?3)",
                )?;
                let now = now_secs();
                for id in &ids {
                    insert.execute(params![collection_id, id, now])?;
                }
            }
            tx.commit()?;
            Ok(true)
        }
    }

    pub fn toggle_google_family_in_collection(
        &self,
        collection_id: i64,
        family: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock();
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM collection_google_families
             WHERE collection_id = ?1 AND family_name = ?2",
            params![collection_id, family],
            |r| r.get(0),
        )?;
        if exists > 0 {
            conn.execute(
                "DELETE FROM collection_google_families
                 WHERE collection_id = ?1 AND family_name = ?2",
                params![collection_id, family],
            )?;
            Ok(false)
        } else {
            conn.execute(
                "INSERT INTO collection_google_families
                   (collection_id, family_name, added_at)
                 VALUES (?1, ?2, ?3)",
                params![collection_id, family, now_secs()],
            )?;
            Ok(true)
        }
    }

    pub fn toggle_google_variant_in_collection(
        &self,
        collection_id: i64,
        family: &str,
        variant: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock();
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM collection_google_variants
             WHERE collection_id = ?1 AND family_name = ?2 AND variant = ?3",
            params![collection_id, family, variant],
            |r| r.get(0),
        )?;
        if exists > 0 {
            conn.execute(
                "DELETE FROM collection_google_variants
                 WHERE collection_id = ?1 AND family_name = ?2 AND variant = ?3",
                params![collection_id, family, variant],
            )?;
            Ok(false)
        } else {
            conn.execute(
                "INSERT INTO collection_google_variants
                   (collection_id, family_name, variant, added_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![collection_id, family, variant, now_secs()],
            )?;
            Ok(true)
        }
    }

    pub fn collections_for_font(&self, font_id: i64) -> Result<Vec<Collection>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"SELECT c.id, c.name, c.created_at,
                 0 AS family_count, 0 AS font_count, 0 AS active_font_count
               FROM collections c
               JOIN collection_fonts cf ON cf.collection_id = c.id
               WHERE cf.font_id = ?1
               ORDER BY c.name COLLATE NOCASE"#,
        )?;
        let rows = stmt.query_map([font_id], |r| {
            Ok(Collection {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                family_count: r.get(3)?,
                font_count: r.get(4)?,
                active_font_count: r.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn collections_for_google_variant(
        &self,
        family_name: &str,
        variant: &str,
    ) -> Result<Vec<Collection>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"SELECT c.id, c.name, c.created_at,
                 0 AS family_count, 0 AS font_count, 0 AS active_font_count
               FROM collections c
               JOIN collection_google_variants cgv ON cgv.collection_id = c.id
               WHERE cgv.family_name = ?1 AND cgv.variant = ?2
               ORDER BY c.name COLLATE NOCASE"#,
        )?;
        let rows = stmt.query_map([family_name, variant], |r| {
            Ok(Collection {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                family_count: r.get(3)?,
                font_count: r.get(4)?,
                active_font_count: r.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn collection_export_rows(
        &self,
        collection_id: i64,
    ) -> Result<Vec<(String, String)>> {
        // Returns (effective_family, file_path) for every font in the collection
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"SELECT COALESCE(NULLIF(f.typographic_family, ''), f.family_name) AS fam,
                       f.file_path
               FROM collection_fonts cf
               JOIN fonts f ON f.id = cf.font_id
               WHERE cf.collection_id = ?1"#,
        )?;
        let rows = stmt.query_map([collection_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn sibling_font_files(&self, file_path: &str) -> Result<Vec<String>> {
        // Returns all font files that share the same filename stem (minus extension)
        // as the given path — used during collection export to include .otf/.ttf/etc.
        // siblings when copying a representative file.
        use std::path::Path;
        let p = Path::new(file_path);
        let parent = p.parent().map(|x| x.to_string_lossy().into_owned());
        let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned());
        let (parent, stem) = match (parent, stem) {
            (Some(a), Some(b)) => (a, b),
            _ => return Ok(vec![file_path.to_string()]),
        };
        let sep = if parent.contains('\\') { '\\' } else { '/' };
        let prefix = format!("{}{}{}.", parent, sep, stem);
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT DISTINCT file_path FROM fonts \
             WHERE substr(file_path, 1, length(?1)) = ?1",
        )?;
        let rows = stmt.query_map([&prefix], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        if out.is_empty() {
            out.push(file_path.to_string());
        }
        Ok(out)
    }

    pub fn remove_fonts_from_collection(
        &self,
        collection_id: i64,
        ids: &[i64],
    ) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for chunk in ids.chunks(500) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "DELETE FROM collection_fonts WHERE collection_id = ? AND font_id IN ({})",
                placeholders
            );
            let mut params_vec: Vec<i64> = Vec::with_capacity(chunk.len() + 1);
            params_vec.push(collection_id);
            params_vec.extend_from_slice(chunk);
            tx.execute(&sql, rusqlite::params_from_iter(params_vec.iter().copied()))?;
        }
        tx.commit()?;
        Ok(())
    }

    // ----- Google Fonts -----

    pub fn upsert_google_families(
        &self,
        families: &[(String, String, Vec<String>)],
    ) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let now = now_secs();
        {
            let mut stmt = tx.prepare(
                r#"INSERT INTO google_families (family_name, category, variants, updated_at)
                   VALUES (?1, ?2, ?3, ?4)
                   ON CONFLICT(family_name) DO UPDATE SET
                     category=excluded.category,
                     variants=excluded.variants,
                     updated_at=excluded.updated_at"#,
            )?;
            for (fam, cat, vars) in families {
                let vars_json = serde_json::to_string(vars).unwrap_or_else(|_| "[]".into());
                stmt.execute(params![fam, cat, vars_json, now])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_google_families(&self) -> Result<Vec<GoogleFamilyRow>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"SELECT gf.family_name, gf.category, gf.variants,
                 (SELECT COUNT(*) FROM google_activations ga
                  WHERE ga.family_name = gf.family_name) AS active_count
               FROM google_families gf
               ORDER BY gf.family_name COLLATE NOCASE"#,
        )?;
        let rows = stmt.query_map([], |r| {
            let variants_json: String = r.get(2)?;
            let variants: Vec<String> =
                serde_json::from_str(&variants_json).unwrap_or_default();
            let count = variants.len() as i64;
            Ok(GoogleFamilyRow {
                family_name: r.get(0)?,
                category: r.get(1)?,
                variant_count: count,
                variants,
                active_count: r.get(3)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn google_family_count(&self) -> Result<i64> {
        let conn = self.conn.lock();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM google_families",
            [],
            |r| r.get(0),
        )?;
        Ok(n)
    }

    pub fn google_variants_for(&self, family: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let variants: Option<String> = conn
            .query_row(
                "SELECT variants FROM google_families WHERE family_name = ?1",
                [family],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(v) = variants {
            Ok(serde_json::from_str::<Vec<String>>(&v).unwrap_or_default())
        } else {
            Ok(Vec::new())
        }
    }

    pub fn record_google_activation(
        &self,
        family: &str,
        variant: &str,
        cached_path: &str,
        weight: i32,
        italic: bool,
        registry_key: &str,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"INSERT INTO google_activations
                 (family_name, variant, cached_path, weight, italic, registry_key, activated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
               ON CONFLICT(family_name, variant) DO UPDATE SET
                 cached_path=excluded.cached_path,
                 weight=excluded.weight,
                 italic=excluded.italic,
                 registry_key=excluded.registry_key,
                 activated_at=excluded.activated_at"#,
            params![family, variant, cached_path, weight, italic as i32, registry_key, now_secs()],
        )?;
        Ok(())
    }

    pub fn list_google_activations(&self) -> Result<Vec<GoogleActivationRow>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT family_name, variant, cached_path, registry_key FROM google_activations",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(GoogleActivationRow {
                family_name: r.get(0)?,
                variant: r.get(1)?,
                cached_path: r.get(2)?,
                registry_key: r.get(3)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn list_google_activations_for_family(
        &self,
        family: &str,
    ) -> Result<Vec<GoogleActivationRow>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT family_name, variant, cached_path, registry_key \
             FROM google_activations WHERE family_name = ?1",
        )?;
        let rows = stmt.query_map([family], |r| {
            Ok(GoogleActivationRow {
                family_name: r.get(0)?,
                variant: r.get(1)?,
                cached_path: r.get(2)?,
                registry_key: r.get(3)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn delete_google_activation(&self, family: &str, variant: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM google_activations WHERE family_name = ?1 AND variant = ?2",
            params![family, variant],
        )?;
        Ok(())
    }

    pub fn total_google_active(&self) -> Result<i64> {
        let conn = self.conn.lock();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM google_activations",
            [],
            |r| r.get(0),
        )?;
        Ok(n)
    }

    /// Mark a Google family as pending a 5-minute cache wipe. Idempotent —
    /// re-marking resets the timer. Called by the deactivate path.
    pub fn mark_google_pending_wipe(&self, family: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO google_cache_pending_wipe (family_name, marked_at)
             VALUES (?1, ?2)
             ON CONFLICT(family_name) DO UPDATE SET marked_at = excluded.marked_at",
            params![family, now_secs()],
        )?;
        Ok(())
    }

    /// Cancel a pending wipe. Called whenever the family (or one of its
    /// variants) is activated within the grace window.
    pub fn unmark_google_pending_wipe(&self, family: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM google_cache_pending_wipe WHERE family_name = ?1",
            params![family],
        )?;
        Ok(())
    }

    /// Return every pending-wipe row older than `grace_secs` seconds. The
    /// janitor uses this to find families whose grace period has elapsed.
    pub fn list_overdue_google_wipes(
        &self,
        grace_secs: i64,
    ) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let cutoff = now_secs() - grace_secs;
        let mut stmt = conn.prepare(
            "SELECT family_name FROM google_cache_pending_wipe WHERE marked_at <= ?1",
        )?;
        let rows = stmt.query_map([cutoff], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Distinct family names with at least one active variant. Used by the
    /// Settings "clear inactive Google Fonts cache" sweep to know which cache
    /// dirs to keep. Cheaper than `list_google_activations` when we just need
    /// the set of active families.
    pub fn active_google_family_names(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT DISTINCT family_name FROM google_activations")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn get_activation_info(&self, ids: &[i64]) -> Result<Vec<FontActivationInfo>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut out = Vec::with_capacity(ids.len());
        let conn = self.conn.lock();
        for chunk in ids.chunks(500) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                r#"SELECT id, file_path, family_name, subfamily, postscript_name, format
                   FROM fonts WHERE id IN ({})"#,
                placeholders
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params_from_iter(chunk.iter().copied()), |r| {
                Ok(FontActivationInfo {
                    id: r.get(0)?,
                    file_path: r.get(1)?,
                    family_name: r.get(2)?,
                    subfamily: r.get(3)?,
                    postscript_name: r.get(4)?,
                    format: r.get(5)?,
                })
            })?;
            for row in rows {
                out.push(row?);
            }
        }
        Ok(out)
    }

    /// Every currently-active record in the activations table. Used at
    /// startup to reapply fonts when `restore_active_on_launch` is on, and
    /// on tray Quit to release session handles without clearing the table.
    pub fn get_all_active_records(&self) -> Result<Vec<ActiveRec>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"SELECT a.font_id, a.registry_key, f.file_path
               FROM activations a
               JOIN fonts f ON f.id = a.font_id"#,
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(ActiveRec {
                font_id: r.get(0)?,
                registry_key: r.get(1)?,
                file_path: r.get(2)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn get_active_records(&self, ids: &[i64]) -> Result<Vec<ActiveRec>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut out = Vec::with_capacity(ids.len());
        let conn = self.conn.lock();
        for chunk in ids.chunks(500) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                r#"SELECT a.font_id, a.registry_key, f.file_path
                   FROM activations a
                   JOIN fonts f ON f.id = a.font_id
                   WHERE a.font_id IN ({})"#,
                placeholders
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params_from_iter(chunk.iter().copied()), |r| {
                Ok(ActiveRec {
                    font_id: r.get(0)?,
                    registry_key: r.get(1)?,
                    file_path: r.get(2)?,
                })
            })?;
            for row in rows {
                out.push(row?);
            }
        }
        Ok(out)
    }

    pub fn record_activations(&self, recs: &[(i64, String)]) -> Result<()> {
        if recs.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let now = now_secs();
        {
            let mut stmt = tx.prepare(
                r#"INSERT INTO activations (font_id, registry_key, activated_at)
                   VALUES (?1, ?2, ?3)
                   ON CONFLICT(font_id) DO UPDATE SET
                     registry_key=excluded.registry_key,
                     activated_at=excluded.activated_at"#,
            )?;
            for (id, key) in recs {
                stmt.execute(params![id, key, now])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn record_deactivations(&self, ids: &[i64]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for chunk in ids.chunks(500) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!("DELETE FROM activations WHERE font_id IN ({})", placeholders);
            tx.execute(&sql, rusqlite::params_from_iter(chunk.iter().copied()))?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn ids_in_family(&self, family_name: &str) -> Result<Vec<i64>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"SELECT id FROM fonts
               WHERE COALESCE(NULLIF(typographic_family, ''), family_name) = ?1"#,
        )?;
        let rows = stmt.query_map([family_name], |r| r.get::<_, i64>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn ids_in_folder(&self, folder: &str) -> Result<Vec<i64>> {
        let sep = if folder.contains('\\') { '\\' } else { '/' };
        let prefix = if folder.ends_with(sep) {
            folder.to_string()
        } else {
            format!("{}{}", folder, sep)
        };
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id FROM fonts WHERE substr(file_path, 1, length(?1)) = ?1",
        )?;
        let rows = stmt.query_map([&prefix], |r| r.get::<_, i64>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock();
        let value = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [key],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        Ok(value)
    }

    pub fn set_setting(&self, key: &str, value: Option<&str>) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"INSERT INTO settings (key, value) VALUES (?1, ?2)
               ON CONFLICT(key) DO UPDATE SET value=excluded.value"#,
            params![key, value],
        )?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn get_font(&self, id: i64) -> Result<Option<FontRow>> {
        let conn = self.conn.lock();
        let row = conn
            .query_row(
                r#"SELECT id, file_path, ttc_index, family_name, subfamily,
                   weight, italic, classification, format
                   FROM fonts WHERE id = ?1"#,
                [id],
                |r| {
                    Ok(FontRow {
                        id: r.get(0)?,
                        file_path: r.get(1)?,
                        ttc_index: r.get(2)?,
                        family_name: r.get(3)?,
                        subfamily: r.get(4)?,
                        weight: r.get(5)?,
                        italic: r.get::<_, i32>(6)? != 0,
                        classification: r.get(7)?,
                        format: r.get(8)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    pub fn list_family_styles(
        &self,
        family_name: &str,
        collection_id: Option<i64>,
    ) -> Result<Vec<FontRow>> {
        // When a collection is selected, only return styles actually in that
        // collection — that's what drives the "individual style as its own
        // family" behavior in the collection view.
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"SELECT id, file_path, ttc_index, family_name, subfamily,
                weight, italic, classification, format
               FROM fonts
               WHERE COALESCE(NULLIF(typographic_family, ''), family_name) = ?1
                 AND (?2 IS NULL OR id IN (
                   SELECT font_id FROM collection_fonts WHERE collection_id = ?2
                 ))
               ORDER BY ABS(weight - 400), italic, id"#,
        )?;
        let rows = stmt.query_map(params![family_name, collection_id], |r| {
            Ok(FontRow {
                id: r.get(0)?,
                file_path: r.get(1)?,
                ttc_index: r.get(2)?,
                family_name: r.get(3)?,
                subfamily: r.get(4)?,
                weight: r.get(5)?,
                italic: r.get::<_, i32>(6)? != 0,
                classification: r.get(7)?,
                format: r.get(8)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn infer_common_root(&self) -> Result<Option<String>> {
        let mut paths: Vec<String> = Vec::new();
        {
            let conn = self.conn.lock();
            let mut stmt = conn.prepare("SELECT file_path FROM fonts LIMIT 500")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            for row in rows {
                if let Ok(p) = row {
                    paths.push(p);
                }
            }
        }
        Ok(common_ancestor(&paths))
    }

    pub fn classification_counts(&self) -> Result<Vec<(String, i64)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT classification, COUNT(DISTINCT family_name) FROM fonts GROUP BY classification",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }
}

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RootFolder {
    pub path: String,
    pub added_at: i64,
}

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    pub family_count: i64,
    pub font_count: i64,
    pub active_font_count: i64,
}

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GoogleFamilyRow {
    pub family_name: String,
    pub category: String,
    pub variants: Vec<String>,
    pub variant_count: i64,
    pub active_count: i64,
}

#[derive(Debug, Clone)]
pub struct GoogleActivationRow {
    pub family_name: String,
    pub variant: String,
    pub cached_path: String,
    pub registry_key: String,
}

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FolderNode {
    pub name: String,
    pub path: String,
    pub font_count: i64,
    pub total_count: i64,
    pub active_count: i64,
    /// Distinct families touching this folder or any of its descendants.
    /// This is what the UI shows in the counter so folder rows agree with
    /// the "N families" counter on the main card when you click the folder.
    pub family_count: i64,
    /// Subset of family_count that currently has at least one activated font.
    pub active_family_count: i64,
    pub children: Vec<FolderNode>,
}

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FamilySummary {
    pub family_name: String,
    pub styles: i64,
    pub active_count: i64,
    pub starred_count: i64,
    pub classification: String,
    pub rep_id: i64,
    pub file_path: String,
    pub ttc_index: i32,
    pub format: String,
    pub designer: Option<String>,
    pub collection_names: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct FontActivationInfo {
    pub id: i64,
    pub file_path: String,
    pub family_name: String,
    pub subfamily: Option<String>,
    pub postscript_name: Option<String>,
    pub format: String,
}

#[derive(Debug, Clone)]
pub struct ActiveRec {
    pub font_id: i64,
    pub registry_key: String,
    pub file_path: String,
}

fn build_folder_tree(
    root_clean: &str,
    sep: char,
    fonts: &[&(String, String, bool)],
) -> FolderNode {
    let name = root_clean
        .rsplit(sep)
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(root_clean)
        .to_string();
    let mut root = FolderNode {
        name,
        path: root_clean.to_string(),
        font_count: 0,
        total_count: 0,
        active_count: 0,
        family_count: 0,
        active_family_count: 0,
        children: Vec::new(),
    };
    for (path, _family, active) in fonts {
        let rel = &path[root_clean.len()..];
        let rel = rel.trim_start_matches(sep);
        let parts: Vec<&str> = rel.split(sep).collect();
        if parts.is_empty() {
            continue;
        }
        let dir_parts = &parts[..parts.len().saturating_sub(1)];
        insert_font_path(&mut root, dir_parts, root_clean, sep, *active);
    }
    compute_totals(&mut root);
    sort_tree(&mut root);
    root
}

fn insert_font_path(
    node: &mut FolderNode,
    dir_parts: &[&str],
    parent_path: &str,
    sep: char,
    is_active: bool,
) {
    if dir_parts.is_empty() {
        node.font_count += 1;
        if is_active {
            node.active_count += 1;
        }
        return;
    }
    let first = dir_parts[0];
    let rest = &dir_parts[1..];
    let child_path = format!("{}{}{}", parent_path, sep, first);
    let idx = match node.children.iter().position(|c| c.name == first) {
        Some(i) => i,
        None => {
            node.children.push(FolderNode {
                name: first.to_string(),
                path: child_path.clone(),
                font_count: 0,
                total_count: 0,
                active_count: 0,
                family_count: 0,
                active_family_count: 0,
                children: Vec::new(),
            });
            node.children.len() - 1
        }
    };
    insert_font_path(&mut node.children[idx], rest, &child_path, sep, is_active);
}

fn assign_family_counts(
    node: &mut FolderNode,
    families: &HashMap<String, HashSet<String>>,
    active_families: &HashMap<String, HashSet<String>>,
) {
    node.family_count = families.get(&node.path).map(|s| s.len() as i64).unwrap_or(0);
    node.active_family_count = active_families
        .get(&node.path)
        .map(|s| s.len() as i64)
        .unwrap_or(0);
    for child in &mut node.children {
        assign_family_counts(child, families, active_families);
    }
}

fn compute_totals(node: &mut FolderNode) -> (i64, i64) {
    let mut total = node.font_count;
    let mut active = node.active_count;
    for child in &mut node.children {
        let (t, a) = compute_totals(child);
        total += t;
        active += a;
    }
    node.total_count = total;
    node.active_count = active;
    (total, active)
}

fn sort_tree(node: &mut FolderNode) {
    node.children
        .sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    for child in &mut node.children {
        sort_tree(child);
    }
}

fn ensure_trailing_sep(path: &str, sep: &str) -> String {
    if path.ends_with(sep) {
        path.to_string()
    } else {
        format!("{}{}", path, sep)
    }
}

fn common_ancestor(paths: &[String]) -> Option<String> {
    if paths.is_empty() {
        return None;
    }
    let sep = if paths[0].contains('\\') { '\\' } else { '/' };
    let first_parts: Vec<&str> = paths[0].split(sep).collect();
    if first_parts.len() < 2 {
        return None;
    }
    let mut prefix: Vec<&str> = first_parts[..first_parts.len() - 1].to_vec();
    for p in paths.iter().skip(1) {
        let parts: Vec<&str> = p.split(sep).collect();
        if parts.len() < 2 {
            continue;
        }
        let parts_parent = &parts[..parts.len() - 1];
        let mut i = 0;
        while i < prefix.len() && i < parts_parent.len() && prefix[i] == parts_parent[i] {
            i += 1;
        }
        prefix.truncate(i);
        if prefix.is_empty() {
            return None;
        }
    }
    let joined = prefix.join(&sep.to_string());
    if joined.is_empty() {
        None
    } else {
        Some(joined)
    }
}

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FontRow {
    pub id: i64,
    pub file_path: String,
    pub ttc_index: i32,
    pub family_name: String,
    pub subfamily: Option<String>,
    pub weight: i32,
    pub italic: bool,
    pub classification: String,
    pub format: String,
}
