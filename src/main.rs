// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use std::fs;
use tauri_plugin_dialog::DialogExt;

// Project (.clyrproj) save/open, and .clyr export, all go through Rust
// rather than browser-only mechanisms — going through our own
// #[tauri::command] + invoke() is the exact pattern already proven
// throughout the main overlay app on the `main` branch, and per that
// app's own finding, our own commands need no capabilities entry (only
// bare plugin/core commands called directly from JS do).
//
// .clyr EXPORT originally used a Blob + <a download> click (no Rust
// round-trip) — that's a standard browser technique, but WebView2 doesn't
// reliably surface it as an actual save dialog the way a normal browser
// tab does, so the click silently did nothing. Routed through the same
// dialog-plugin + blocking_save_file() path proven by save_project_dialog
// below instead. .clyr IMPORT stays on plain <input type="file"> +
// File.text() in js/main.js — that's a native OS picker either way and
// has none of the download-link's quirks.
#[tauri::command]
fn save_project_dialog(app: tauri::AppHandle, content: String) -> Result<Option<String>, String> {
    let chosen = app
        .dialog()
        .file()
        .add_filter("Clyr Studio Project", &["clyrproj"])
        .set_file_name("untitled.clyrproj")
        .blocking_save_file();

    let Some(path) = chosen else { return Ok(None) };
    let path_str = path.to_string();
    fs::write(&path_str, content).map_err(|e| e.to_string())?;
    Ok(Some(path_str))
}

#[tauri::command]
fn open_project_dialog(app: tauri::AppHandle) -> Result<Option<(String, String)>, String> {
    let chosen = app
        .dialog()
        .file()
        .add_filter("Clyr Studio Project", &["clyrproj"])
        .blocking_pick_file();

    let Some(path) = chosen else { return Ok(None) };
    let path_str = path.to_string();
    let content = fs::read_to_string(&path_str).map_err(|e| e.to_string())?;
    Ok(Some((path_str, content)))
}

#[tauri::command]
fn export_clyr_dialog(app: tauri::AppHandle, content: String) -> Result<Option<String>, String> {
    let chosen = app
        .dialog()
        .file()
        .add_filter("Clyr Lyrics", &["clyr"])
        .set_file_name("export.clyr")
        .blocking_save_file();

    let Some(path) = chosen else { return Ok(None) };
    let path_str = path.to_string();
    fs::write(&path_str, content).map_err(|e| e.to_string())?;
    Ok(Some(path_str))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_project_dialog, open_project_dialog, export_clyr_dialog])
        .run(tauri::generate_context!())
        .expect("error running Clyr Studio");
}
