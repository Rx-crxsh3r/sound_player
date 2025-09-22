#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|_app| {
            // Nothing fancy yet
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
