mod activator;
mod commands;
mod db;
mod error;
mod google_fonts;
mod parser;
mod scanner;

use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,fonty=debug")),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("fonty.db");
            tracing::info!("db path: {:?}", db_path);
            let db = Arc::new(db::Db::open(&db_path)?);
            // Restore-on-launch: if the user has it enabled (default), re-call
            // AddFontResourceW for every row still in the activations table so
            // Word/Affinity pick them up again. When off, start clean — wipe
            // both the session and the DB table like earlier builds.
            //
            // CRITICAL: this used to run synchronously inside setup(). For a
            // user with thousands of active Google variants that meant 10+
            // seconds of GDI calls before the window appeared — the app
            // looked like it froze on launch. Now it runs on a background
            // thread so setup() returns immediately and the UI draws right
            // away. Google fonts are already loaded by Windows via their
            // HKCU entries at user login, so the brief window between
            // launch and restore completion has no visible effect in Word/
            // Affinity — AddFontResourceW here just bumps FONTY's own ref
            // count so deactivate later works cleanly.
            if commands::read_restore_on_launch(&db) {
                let restore_db = db.clone();
                std::thread::Builder::new()
                    .name("fonty-restore".into())
                    .spawn(move || {
                        if let Err(e) = commands::reapply_active_session(&restore_db) {
                            tracing::warn!("restore-on-launch failed: {}", e);
                        }
                    })
                    .expect("spawn restore thread");
            } else if let Err(e) = commands::deactivate_all_session(&db) {
                tracing::warn!("startup cleanup failed: {}", e);
            }
            app.manage(commands::AppState::new(db.clone()));

            // Background janitor: every 60s, wipe the cache dir of any
            // Google family whose 5-minute grace period has expired since
            // deactivation. See commands::run_google_cache_janitor_once.
            // First tick runs on startup so a family whose 5-min window
            // elapsed while the app was closed gets cleaned right away.
            let janitor_app = app.handle().clone();
            let janitor_db = db.clone();
            std::thread::Builder::new()
                .name("fonty-google-janitor".into())
                .spawn(move || {
                    let cache_root = match janitor_app.path().app_cache_dir() {
                        Ok(p) => p,
                        Err(e) => {
                            tracing::warn!("janitor cache_dir resolve failed: {e}");
                            return;
                        }
                    };
                    loop {
                        if let Err(e) = commands::run_google_cache_janitor_once(
                            &janitor_db,
                            &cache_root,
                        ) {
                            tracing::warn!("google cache janitor tick failed: {e}");
                        }
                        std::thread::sleep(std::time::Duration::from_secs(60));
                    }
                })
                .expect("spawn google cache janitor thread");

            // System tray: X on the window hides it; app keeps running in the
            // tray with fonts still active. Left-click toggles the window.
            // Right-click → menu with Show/Hide and Quit (Quit runs cleanup).
            let show_item =
                MenuItem::with_id(app, "show", "Show FONTY", true, None::<&str>)?;
            let hide_item =
                MenuItem::with_id(app, "hide", "Hide FONTY", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(
                app,
                "quit",
                "Quit FONTY",
                true,
                None::<&str>,
            )?;
            let menu =
                Menu::with_items(app, &[&show_item, &hide_item, &separator, &quit_item])?;

            let _tray = TrayIconBuilder::with_id("fonty-tray")
                .tooltip("FONTY — font manager")
                .icon(
                    app.default_window_icon()
                        .expect("default window icon")
                        .clone(),
                )
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    "quit" => {
                        if let Some(state) = app.try_state::<commands::AppState>() {
                            // When restore-on-launch is on (default), just
                            // release the session handles — keep the
                            // activations table so the next launch can
                            // re-apply them. When it's off, wipe the DB too.
                            let restore =
                                commands::read_restore_on_launch(&state.db);
                            let res = if restore {
                                commands::release_session_fonts(&state.db)
                            } else {
                                commands::deactivate_all_session(&state.db)
                            };
                            if let Err(e) = res {
                                tracing::warn!("quit cleanup failed: {}", e);
                            }
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let visible = w.is_visible().unwrap_or(false);
                            if visible {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Don't actually close: hide to tray. Fonts stay loaded so
                // you can keep working in Word/Affinity while FONTY is tucked
                // away. Use the tray menu's "Quit" to actually exit + clean up.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::scan_folder,
            commands::library_stats,
            commands::list_families,
            commands::list_family_styles,
            commands::classification_counts,
            commands::list_roots,
            commands::remove_root,
            commands::folder_trees,
            commands::active_font_ids,
            commands::activate_fonts,
            commands::deactivate_fonts,
            commands::activate_family,
            commands::deactivate_family,
            commands::activate_folder,
            commands::deactivate_folder,
            commands::starred_font_ids,
            commands::star_fonts,
            commands::unstar_fonts,
            commands::star_family,
            commands::unstar_family,
            commands::count_user_fonts,
            commands::deactivate_all_fonts,
            commands::clear_user_fonts_registry,
            commands::uninstall_user_installed_fonts,
            commands::list_collections,
            commands::create_collection,
            commands::rename_collection,
            commands::delete_collection,
            commands::add_family_to_collection,
            commands::remove_family_from_collection,
            commands::collections_for_family,
            commands::add_fonts_to_collection,
            commands::remove_fonts_from_collection,
            commands::add_google_family_to_collection,
            commands::remove_google_family_from_collection,
            commands::collection_google_family_names,
            commands::collections_for_google_family,
            commands::add_google_variant_to_collection,
            commands::remove_google_variant_from_collection,
            commands::collection_google_variants,
            commands::collections_for_google_variant,
            commands::toggle_font_in_collection,
            commands::toggle_family_in_collection,
            commands::toggle_google_family_in_collection,
            commands::toggle_google_variant_in_collection,
            commands::collections_for_font,
            commands::get_restore_on_launch,
            commands::set_restore_on_launch,
            commands::clear_google_cache,
            commands::activate_collection,
            commands::deactivate_collection,
            commands::export_collection,
            commands::refresh_google_catalog,
            commands::list_google_families,
            commands::google_library_stats,
            commands::activate_google_family,
            commands::activate_google_variant,
            commands::deactivate_google_variant,
            commands::google_active_variants_for,
            commands::deactivate_google_family,
            commands::deactivate_all_google,
            commands::remove_google_family,
            commands::google_cache_size,
            commands::clear_inactive_google_cache,
            commands::google_named_instances,
            commands::activate_google_family_no_broadcast,
            commands::google_broadcast_font_change,
            commands::prefetch_google_css,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FONTY");
}
