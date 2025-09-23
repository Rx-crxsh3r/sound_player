// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{AppHandle, Manager};
use std::time::Duration;

// This struct holds th e media state.
#[derive(Clone, serde::Serialize)]
struct MediaState {
    status: String, // "playing" or "idle"
    title: String,
    artist: String,
    album_art_url: String,
    current_time: u32,
    total_time: u32,
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // This setup closure runs once when the app starts.
            // We'll start our mock data loop here.
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                mock_media_loop(app_handle).await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// This function simulates a media player.
// It will cycle through a few states and emit events to the frontend.
async fn mock_media_loop(app_handle: AppHandle) {
    let mut cycle = 0;
    loop {
        let state = match cycle {
            0 => MediaState { // Idle state
                status: "idle".to_string(),
                title: "".to_string(),
                artist: "".to_string(),
                album_art_url: "".to_string(),
                current_time: 0,
                total_time: 0,
            },
            1 => MediaState { // First song
                status: "playing".to_string(),
                title: "Starlight".to_string(),
                artist: "Muse".to_string(),
                album_art_url: "https://placehold.co/100x100/1DB954/FFFFFF?text=Muse".to_string(),
                current_time: 83, // 1:23
                total_time: 240, // 4:00
            },
            _ => MediaState { // Second song
                status: "playing".to_string(),
                title: "Bohemian Rhapsody".to_string(),
                artist: "Queen".to_string(),
                album_art_url: "https://placehold.co/100x100/F44336/FFFFFF?text=Queen".to_string(),
                current_time: 150, // 2:30
                total_time: 355, // 5:55
            },
        };

        // Emit the 'media-update' event to the frontend with the current state.
        app_handle.emit_all("media-update", state).unwrap();
        
        // Wait for 5 seconds before sending the next update.
        tokio::time::sleep(Duration::from_secs(5)).await;

        cycle = (cycle + 1) % 3;
    }
}
