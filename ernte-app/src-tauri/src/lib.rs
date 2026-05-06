use std::fs;
use std::path::{Path, PathBuf};

#[allow(unused_imports)]
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

// Pull in the auto-generated function `embedded_data_files()` that
// returns Vec<(&str, &str)> with (filename, json_content) pairs.
include!(concat!(env!("OUT_DIR"), "/embedded_historie.rs"));

/// Checks whether a directory contains any history or master-data files.
#[allow(dead_code)]
fn contains_data_files(dir: &Path) -> bool {
    fs::read_dir(dir)
        .map(|entries| {
            entries.filter_map(|e| e.ok()).any(|e| {
                let name = e.file_name().into_string().unwrap_or_default();
                (name.starts_with("historie-") && name.ends_with(".json"))
                    || name == "stammdaten.json"
            })
        })
        .unwrap_or(false)
}

/// Copy historie-*.json and stammdaten.json from src to dst.
/// Only copies files that do NOT already exist in dst (no overwrite).
#[allow(dead_code)]
fn copy_data_files(src: &Path, dst: &Path) {
    if let Ok(entries) = fs::read_dir(src) {
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().into_string().unwrap_or_default();
            let is_data_file = (name.starts_with("historie-") && name.ends_with(".json"))
                || name == "stammdaten.json";
            if is_data_file {
                let dst_file = dst.join(&name);
                if !dst_file.exists() {
                    let _ = fs::copy(entry.path(), &dst_file);
                    eprintln!("[data-init] Copied {} → {}", entry.path().display(), dst_file.display());
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Dev-mode helper: walk upward from exe to find the workspace root that
// contains the data files (existing behaviour for `cargo tauri dev`).
// ---------------------------------------------------------------------------
#[cfg(debug_assertions)]
fn get_dev_base_path() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));

    let mut best_match: Option<PathBuf> = None;
    let mut candidate = exe_dir.clone();
    for _ in 0..6 {
        if contains_data_files(&candidate) {
            best_match = Some(candidate.clone());
        }
        match candidate.parent() {
            Some(parent) => candidate = parent.to_path_buf(),
            None => break,
        }
    }

    if let Some(path) = best_match {
        return path;
    }

    if let Ok(cwd) = std::env::current_dir() {
        if contains_data_files(&cwd) {
            return cwd;
        }
        if let Some(parent) = cwd.parent() {
            if contains_data_files(&parent.to_path_buf()) {
                return parent.to_path_buf();
            }
        }
    }

    exe_dir
}

// ---------------------------------------------------------------------------
// Data-directory resolution
// ---------------------------------------------------------------------------

/// Returns the **writable** directory used for all data files.
///
/// * **Debug / dev builds** – walks upward from the executable to find the
///   workspace root (so `cargo tauri dev` keeps working as before).
/// * **Release builds** – returns the OS-specific app-data directory
///   (`~/.local/share/com.solawi.ernte` on Linux,
///    `%APPDATA%\com.solawi.ernte` on Windows).
fn get_data_dir(app: &tauri::AppHandle) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        get_dev_base_path()
    }

    #[cfg(not(debug_assertions))]
    {
        app.path()
            .app_data_dir()
            .unwrap_or_else(|_| {
                std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                    .unwrap_or_else(|| PathBuf::from("."))
            })
    }
}

/// Called once during app setup. Ensures the writable data directory exists
/// and seeds missing JSON files from data compiled into the binary.
fn init_data_dir(app: &tauri::AppHandle) {
    let data_dir = get_data_dir(app);
    eprintln!("[data-init] data_dir = {}", data_dir.display());

    // Create directory if necessary.
    if !data_dir.exists() {
        let _ = fs::create_dir_all(&data_dir);
    }

    // Seed missing JSON files (historie-*.json + stammdaten.json).
    for (filename, content) in embedded_data_files() {
        let dst = data_dir.join(filename);
        if !dst.exists() {
            let _ = fs::write(&dst, content);
            eprintln!("[data-init] Seeded {}", dst.display());
        }
    }

    #[cfg(not(debug_assertions))]
    {
        // 2. Legacy migration: users upgrading from v1.0.0 may still
        //    have data files next to the executable.  Copy any that are
        //    missing in app_data_dir (won't overwrite newer files).
        if let Some(exe_dir) = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        {
            if exe_dir != data_dir {
                copy_data_files(&exe_dir, &data_dir);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn save_csv_file(handle: tauri::AppHandle, content: String, default_name: String) -> Result<(), String> {
    let path = handle.dialog()
        .file()
        .set_file_name(default_name)
        .add_filter("CSV", &["csv"])
        .set_title("CSV Export Speichern")
        .blocking_save_file();

    if let Some(p) = path {
        let p_buf: std::path::PathBuf = p.into_path().map_err(|e| e.to_string())?;
        fs::write(p_buf, content).map_err(|e: std::io::Error| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn save_backup_file(handle: tauri::AppHandle, content: String, file_name: String) -> Result<(), String> {
    let path = handle.dialog()
        .file()
        .set_file_name(file_name)
        .add_filter("JSON", &["json"])
        .set_title("Backup speichern")
        .blocking_save_file();

    if let Some(p) = path {
        let p_buf: std::path::PathBuf = p.into_path().map_err(|e| e.to_string())?;
        fs::write(p_buf, content).map_err(|e: std::io::Error| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn sync_history(app: tauri::AppHandle, year: &str, json_content: &str) -> Result<(), String> {
    let base = get_data_dir(&app);
    let json_path = base.join(format!("historie-{}.json", year));
    fs::write(&json_path, json_content).map_err(|e| e.to_string())?;
    eprintln!("[sync_history] wrote {}", json_path.display());
    Ok(())
}

#[tauri::command]
fn load_history(app: tauri::AppHandle, year: &str) -> Result<String, String> {
    let json_path = get_data_dir(&app).join(format!("historie-{}.json", year));
    if !json_path.exists() {
        return Ok("[]".to_string());
    }
    fs::read_to_string(&json_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_history_years(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let mut years = Vec::new();
    let root = get_data_dir(&app);
    let paths = fs::read_dir(&root).map_err(|e| e.to_string())?;

    for path in paths {
        if let Ok(entry) = path {
            let filename = entry.file_name().into_string().unwrap_or_default();
            if filename.starts_with("historie-") && filename.ends_with(".json") {
                let year = filename
                    .replace("historie-", "")
                    .replace(".json", "");
                years.push(year);
            }
        }
    }
    years.sort();
    years.reverse(); // Newest first
    Ok(years)
}

#[tauri::command]
fn load_all_history(app: tauri::AppHandle) -> Result<String, String> {
    let years = list_history_years(app.clone())?;
    let mut all_data = Vec::new();
    let base = get_data_dir(&app);

    for year in years {
        let json_path = base.join(format!("historie-{}.json", year));
        if let Ok(content) = fs::read_to_string(json_path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(arr) = parsed.as_array() {
                    all_data.extend(arr.clone());
                }
            }
        }
    }

    serde_json::to_string(&all_data).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_master_data(app: tauri::AppHandle, articles_json: &str, depots_json: &str) -> Result<(), String> {
    let base = get_data_dir(&app);
    let json_path = base.join("stammdaten.json");

    let combined = serde_json::json!({
        "articles": serde_json::from_str::<serde_json::Value>(articles_json).unwrap_or_default(),
        "depots": serde_json::from_str::<serde_json::Value>(depots_json).unwrap_or_default()
    });

    fs::write(&json_path, combined.to_string()).map_err(|e| e.to_string())?;
    eprintln!("[save_master_data] wrote {}", json_path.display());
    Ok(())
}

#[tauri::command]
fn load_master_data(app: tauri::AppHandle) -> Result<String, String> {
    let json_path = get_data_dir(&app).join("stammdaten.json");
    if !json_path.exists() {
        return Ok("{}".to_string());
    }
    fs::read_to_string(&json_path).map_err(|e| e.to_string())
}

/// Diagnostic command – returns the resolved data directory path.
#[tauri::command]
fn get_data_path(app: tauri::AppHandle) -> String {
    get_data_dir(&app).to_string_lossy().to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            init_data_dir(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            sync_history,
            load_history,
            list_history_years,
            save_csv_file,
            save_backup_file,
            load_all_history,
            save_master_data,
            load_master_data,
            get_data_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
