#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{AppHandle, Manager};
use std::time::Duration;

#[derive(Clone, serde::Serialize)]
struct MediaState {
    status: String,
    title: String,
    artist: String,
    album_art_url: String,
    current_time: u32,
    total_time: u32,
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                mock_media_loop(app_handle).await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn mock_media_loop(app_handle: AppHandle) {
    let mut cycle = 0;
    loop {
        let state = match cycle {
            0 => MediaState {
                status: "idle".into(),
                title: "".into(),
                artist: "".into(),
                album_art_url: "".into(),
                current_time: 0,
                total_time: 0,
            },
            1 => MediaState {
                status: "playing".into(),
                title: "Starlight".into(),
                artist: "Muse".into(),
                album_art_url: "https://placehold.co/100x100/1DB954/FFFFFF?text=Muse".into(),
                current_time: 83,
                total_time: 240,
            },
            _ => MediaState {
                status: "playing".into(),
                title: "Bohemian Rhapsody".into(),
                artist: "Queen".into(),
                album_art_url: "https://placehold.co/100x100/F44336/FFFFFF?text=Queen".into(),
                current_time: 150,
                total_time: 355,
            },
        };

        app_handle.emit_all("media-update", state).unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
        cycle = (cycle + 1) % 3;
    }
}
