use crate::error::{FontyError, Result};
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::Graphics::Gdi::{AddFontResourceW, RemoveFontResourceW};
use windows::Win32::UI::WindowsAndMessaging::{
    SendMessageTimeoutW, SMTO_ABORTIFHUNG, SMTO_NOTIMEOUTIFNOTHUNG, WM_FONTCHANGE,
};
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::{RegKey, RegValue};

const FONTS_REG_PATH: &str = r"Software\Microsoft\Windows NT\CurrentVersion\Fonts";

pub fn registry_value_name(
    id: i64,
    family_name: &str,
    subfamily: Option<&str>,
    postscript_name: Option<&str>,
    format: &str,
) -> String {
    let suffix = if format == "otf" {
        "(OpenType)"
    } else {
        "(TrueType)"
    };
    let base = if let Some(ps) = postscript_name.filter(|s| !s.is_empty()) {
        ps.to_string()
    } else if let Some(sub) = subfamily
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("regular"))
    {
        format!("{} {}", family_name, sub)
    } else {
        family_name.to_string()
    };
    format!("FONTY[{}] {} {}", id, base, suffix)
}

pub fn register_font(value_name: &str, file_path: &Path) -> Result<()> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let fonts_key = hkcu
        .open_subkey_with_flags(FONTS_REG_PATH, KEY_WRITE)
        .map_err(|e| FontyError::Msg(format!("open HKCU Fonts: {e}")))?;
    let path_str = file_path.to_string_lossy().into_owned();
    fonts_key
        .set_value(value_name, &path_str)
        .map_err(|e| FontyError::Msg(format!("write registry value: {e}")))?;
    Ok(())
}

pub fn unregister_font(value_name: &str) -> Result<()> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let fonts_key = hkcu
        .open_subkey_with_flags(FONTS_REG_PATH, KEY_WRITE)
        .map_err(|e| FontyError::Msg(format!("open HKCU Fonts: {e}")))?;
    match fonts_key.delete_value(value_name) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(FontyError::Msg(format!("delete registry value: {e}"))),
    }
}

/// Batch unregister — opens HKCU\...\Fonts once and deletes every name in
/// `value_names`. ~2–5x faster than calling `unregister_font` in a loop
/// when deactivating many Google variants at once. Missing entries are
/// silently skipped. Errors from individual deletes are swallowed so one
/// stale row can't block the rest.
pub fn unregister_fonts_batch(value_names: &[&str]) -> Result<()> {
    if value_names.is_empty() {
        return Ok(());
    }
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let fonts_key = hkcu
        .open_subkey_with_flags(FONTS_REG_PATH, KEY_WRITE)
        .map_err(|e| FontyError::Msg(format!("open HKCU Fonts: {e}")))?;
    for name in value_names {
        let _ = fonts_key.delete_value(name);
    }
    Ok(())
}

/// Batch register — opens HKCU once, writes every (name, path) pair.
pub fn register_fonts_batch(entries: &[(&str, &Path)]) -> Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let fonts_key = hkcu
        .open_subkey_with_flags(FONTS_REG_PATH, KEY_WRITE)
        .map_err(|e| FontyError::Msg(format!("open HKCU Fonts: {e}")))?;
    for (name, path) in entries {
        let path_str = path.to_string_lossy().into_owned();
        let _ = fonts_key.set_value(name, &path_str);
    }
    Ok(())
}

pub fn add_font_resource(file_path: &Path) -> Result<u32> {
    let wide: Vec<u16> = file_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let n = unsafe { AddFontResourceW(PCWSTR(wide.as_ptr())) };
    if n == 0 {
        tracing::warn!("AddFontResourceW returned 0 for {:?}", file_path);
    }
    Ok(n as u32)
}

pub fn remove_font_resource(file_path: &Path) -> Result<()> {
    // RemoveFontResourceW is ref-counted. A font can be loaded into the
    // session multiple times (AddFontResourceW manually + Windows auto-
    // loading from HKCU at login, or another app also loaded it). A single
    // Remove call just decrements by 1, which is why Word/Affinity still
    // see a just-"deactivated" font. Drain the ref count by calling until
    // Windows returns FALSE (= nothing left to remove). Cap at 16 so a
    // buggy return value can't turn this into an infinite loop.
    let wide: Vec<u16> = file_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        for _ in 0..16 {
            let ok = RemoveFontResourceW(PCWSTR(wide.as_ptr()));
            if !ok.as_bool() {
                break;
            }
        }
    }
    Ok(())
}

pub fn broadcast_font_change() {
    // SendMessageTimeoutW with SMTO_ABORTIFHUNG is safer than
    // SendNotifyMessageW when one of the top-level target windows has a
    // stuck message pump — we won't hang FONTY waiting on a misbehaving app.
    // The SMTO_NOTIMEOUTIFNOTHUNG bit tells Windows the 1 s deadline only
    // applies to hung windows, so healthy apps (Word, Affinity, Figma) get
    // all the time they need to refresh their font lists.
    //
    // Word and Affinity pick up activations & deactivations off the back of
    // this broadcast. Some apps still cache their font picker until restart
    // — that's a limitation of those apps, not something FONTY can force.
    unsafe {
        let hwnd = HWND(0xFFFF_usize as *mut c_void);
        let mut result: usize = 0;
        let _ = SendMessageTimeoutW(
            hwnd,
            WM_FONTCHANGE,
            WPARAM(0),
            LPARAM(0),
            SMTO_ABORTIFHUNG | SMTO_NOTIMEOUTIFNOTHUNG,
            1000,
            Some(&mut result as *mut usize),
        );
    }
}

fn reg_value_to_string(v: &RegValue) -> Option<String> {
    use winreg::enums::RegType;
    if !matches!(v.vtype, RegType::REG_SZ | RegType::REG_EXPAND_SZ) {
        return None;
    }
    if v.bytes.len() < 2 || v.bytes.len() % 2 != 0 {
        return None;
    }
    let wide: Vec<u16> = v
        .bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|&w| w != 0)
        .collect();
    Some(String::from_utf16_lossy(&wide))
}

pub fn count_hkcu_fonts() -> Result<usize> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let fonts_key = hkcu
        .open_subkey_with_flags(FONTS_REG_PATH, KEY_READ)
        .map_err(|e| FontyError::Msg(format!("open HKCU Fonts: {e}")))?;
    let mut count = 0usize;
    for entry in fonts_key.enum_values() {
        if entry.is_ok() {
            count += 1;
        }
    }
    Ok(count)
}

/// Wipe every entry under HKCU\...\Fonts (unload from session + delete the
/// registry value). Files on disk are NOT touched — this is the "registry
/// only" cleanup used by the Maintenance action.
pub fn clear_all_hkcu_fonts() -> Result<usize> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let fonts_key = hkcu
        .open_subkey_with_flags(FONTS_REG_PATH, KEY_READ | KEY_WRITE)
        .map_err(|e| FontyError::Msg(format!("open HKCU Fonts: {e}")))?;

    let mut entries: Vec<(String, Option<String>)> = Vec::new();
    for entry in fonts_key.enum_values() {
        match entry {
            Ok((name, value)) => {
                let path = reg_value_to_string(&value);
                entries.push((name, path));
            }
            Err(_) => continue,
        }
    }

    let total = entries.len();
    for (name, path) in &entries {
        if let Some(p) = path {
            let _ = remove_font_resource(Path::new(p));
        }
        let _ = fonts_key.delete_value(name);
    }

    broadcast_font_change();
    Ok(total)
}

/// Full per-user font uninstall: wipe HKCU entries AND delete the backing
/// font files in `%LOCALAPPDATA%\Microsoft\Windows\Fonts` (the folder
/// Windows uses when you right-click → Install for current user). Files
/// referenced by HKCU but living outside that directory are left alone —
/// those are the user's own library. System fonts in `C:\Windows\Fonts`
/// are never touched (they come from HKLM, and we never open HKLM).
pub fn uninstall_user_installed_fonts() -> Result<usize> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let fonts_key = hkcu
        .open_subkey_with_flags(FONTS_REG_PATH, KEY_READ | KEY_WRITE)
        .map_err(|e| FontyError::Msg(format!("open HKCU Fonts: {e}")))?;

    let mut entries: Vec<(String, Option<String>)> = Vec::new();
    for entry in fonts_key.enum_values() {
        if let Ok((name, value)) = entry {
            entries.push((name, reg_value_to_string(&value)));
        }
    }

    let user_fonts_dir = std::env::var("LOCALAPPDATA").ok().map(|b| {
        std::path::PathBuf::from(b)
            .join("Microsoft")
            .join("Windows")
            .join("Fonts")
    });

    let total = entries.len();
    for (name, path) in &entries {
        if let Some(p) = path {
            let p_path = Path::new(p);
            let _ = remove_font_resource(p_path);
            if let Some(dir) = user_fonts_dir.as_ref() {
                if p_path.starts_with(dir) {
                    let _ = std::fs::remove_file(p_path);
                }
            }
        }
        let _ = fonts_key.delete_value(name);
    }

    // Belt-and-suspenders: walk the fonts folder and remove any leftover
    // files that have no HKCU record (e.g. from apps that installed files
    // without registering them). System fonts aren't in this directory.
    if let Some(dir) = user_fonts_dir.as_ref() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
    }

    broadcast_font_change();
    Ok(total)
}
