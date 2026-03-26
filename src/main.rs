// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::time::Duration;
use tauri::{
    AppHandle, CustomMenuItem, Manager, PhysicalPosition,
    SystemTray, SystemTrayEvent, SystemTrayMenu,
    WindowBuilder, WindowEvent, WindowUrl,
};

// ── Media state (mock, emitted to frontend) ────────────────
#[derive(Clone, serde::Serialize)]
struct MediaState {
    status:        String,
    title:         String,
    artist:        String,
    album_art_url: String,
    current_time:  u32,
    total_time:    u32,
}

// ── Settings schema ────────────────────────────────────────
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct OverlaySettings {
    theme:          String,
    active_opacity: u8,
    idle_opacity:   u8,
    accent_color:   String,
    edit_mode:      bool,
    offset_x:       u8,
    offset_y:       u8,
    // Saved bar window position (physical pixels). 0,0 = top-left (default).
    bar_x:          i32,
    bar_y:          i32,
}

impl Default for OverlaySettings {
    fn default() -> Self {
        Self {
            theme:          "dark".into(),
            active_opacity: 85,
            idle_opacity:   50,
            accent_color:   "#1DB954".into(),
            edit_mode:      false,
            offset_x:       0,
            offset_y:       0,
            bar_x:          0,
            bar_y:          0,
        }
    }
}

// ── Settings persistence helpers ──────────────────────────
fn settings_path(handle: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = tauri::api::path::app_config_dir(&handle.config())
        .ok_or_else(|| "cannot resolve app config dir".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn read_settings(handle: &AppHandle) -> OverlaySettings {
    eprintln!("[SETTINGS] Reading settings from disk...");
    let Ok(path) = settings_path(handle) else {
        eprintln!("[SETTINGS] Could not resolve settings path — returning defaults");
        return OverlaySettings::default();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        eprintln!("[SETTINGS] No settings file found at {:?} — returning defaults", path);
        return OverlaySettings::default();
    };
    let result = serde_json::from_str(&raw).unwrap_or_default();
    eprintln!("[SETTINGS] Loaded settings OK");
    result
}

fn write_settings(handle: &AppHandle, s: &OverlaySettings) -> Result<(), String> {
    eprintln!("[SETTINGS] Writing settings to disk...");
    let path    = settings_path(handle)?;
    let content = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())?;
    eprintln!("[SETTINGS] Settings written OK to {:?}", path);
    Ok(())
}

// ── Tauri commands ─────────────────────────────────────────
#[tauri::command]
fn load_overlay_settings(handle: AppHandle) -> OverlaySettings {
    eprintln!("[CMD] load_overlay_settings called");
    let s = read_settings(&handle);
    eprintln!("[CMD] load_overlay_settings done — theme: {}, accent: {}", s.theme, s.accent_color);
    s
}

#[tauri::command]
fn save_overlay_settings(handle: AppHandle, settings: OverlaySettings) -> Result<(), String> {
    eprintln!("[CMD] save_overlay_settings called — theme: {}, accent: {}", settings.theme, settings.accent_color);
    write_settings(&handle, &settings)?;
    eprintln!("[CMD] save_overlay_settings — broadcasting overlay-settings-updated to all windows");
    let _ = handle.emit_all("overlay-settings-updated", &settings);
    eprintln!("[CMD] save_overlay_settings done");
    Ok(())
}

#[tauri::command]
fn toggle_overlay_popup(handle: AppHandle) {
    eprintln!("[CMD] toggle_overlay_popup called — broadcasting overlay-toggle-popup");
    let _ = handle.emit_all("overlay-toggle-popup", ());
    eprintln!("[CMD] toggle_overlay_popup broadcast sent");
}

#[tauri::command]
fn set_main_click_through(handle: AppHandle, pass_through: bool) {
    eprintln!("[CMD] set_main_click_through called — pass_through: {}", pass_through);
    if let Some(win) = handle.get_window("main") {
        let result = win.set_ignore_cursor_events(pass_through);
        eprintln!("[CMD] set_ignore_cursor_events({}) => {:?}", pass_through, result);
    } else {
        eprintln!("[CMD] set_main_click_through — WARNING: main window not found");
    }
}

// Position of the main bar window (physical pixels)
#[derive(serde::Serialize)]
struct BarPosition { x: i32, y: i32 }

#[tauri::command]
fn get_main_position(handle: AppHandle) -> Result<BarPosition, String> {
    eprintln!("[CMD] get_main_position called");
    let win = handle.get_window("main").ok_or_else(|| "main window not found".to_string())?;
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    eprintln!("[CMD] get_main_position — x:{} y:{}", pos.x, pos.y);
    Ok(BarPosition { x: pos.x, y: pos.y })
}

// ── bar_button window helpers ──────────────────────────────
// The bar_button window is a tiny always-on-top interactive window
// positioned at the left edge of the main overlay bar.
// It stays click-through on the OS level is NOT needed here because
// the window itself is just 30×30 px — only the button is in it.
fn open_bar_button_window(handle: &AppHandle) {
    if handle.get_window("bar_button").is_some() {
        eprintln!("[WINDOW] bar_button already exists — skipping open");
        return;
    }
    eprintln!("[WINDOW] Opening bar_button window (30x22 transparent, always-on-top)...");
    let result = WindowBuilder::new(handle, "bar_button", WindowUrl::App("bar_button.html".into()))
        .title("Overlay Toggle")
        .inner_size(30.0, 22.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(true)
        .build();
    eprintln!("[WINDOW] bar_button build result: {}", if result.is_ok() { "OK" } else { "FAILED" });
}

fn sync_button_position(handle: &AppHandle) {
    let (Some(main), Some(btn)) = (handle.get_window("main"), handle.get_window("bar_button")) else {
        eprintln!("[WINDOW] sync_button_position — could not get main or bar_button window");
        return;
    };
    if let Ok(pos) = main.outer_position() {
        let target_x = pos.x + 10;
        let target_y = pos.y - 8; //the button 
        eprintln!("[WINDOW] sync_button_position — main outer pos: ({}, {}), placing bar_button at ({}, {})", pos.x, pos.y, target_x, target_y);
        let _ = btn.set_position(PhysicalPosition::new(target_x, target_y));
    } else {
        eprintln!("[WINDOW] sync_button_position — failed to read main outer_position");
    }
}

// ── Settings window ────────────────────────────────────────
fn open_settings_window(handle: &AppHandle) {
    eprintln!("[WINDOW] open_settings_window called");
    if let Some(win) = handle.get_window("settings") {
        eprintln!("[WINDOW] Settings window already exists — showing and focusing");
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    eprintln!("[WINDOW] Creating new settings window (860x580)...");
    if let Ok(win) = WindowBuilder::new(handle, "settings", WindowUrl::App("settings.html".into()))
        .title("Sound Overlay Settings")
        .inner_size(860.0, 580.0)
        .min_inner_size(720.0, 480.0)
        .resizable(true)
        .decorations(true)
        .visible(true)
        .build()
    {
        eprintln!("[WINDOW] Settings window created OK");
        let _ = win.set_focus();
    } else {
        eprintln!("[WINDOW] Settings window creation FAILED");
    }
}

// ── System tray ────────────────────────────────────────────
fn build_tray() -> SystemTray {
    let menu = SystemTrayMenu::new()
        .add_item(CustomMenuItem::new("settings",     "Settings"))
        .add_item(CustomMenuItem::new("show_overlay", "Show Overlay"))
        .add_native_item(tauri::SystemTrayMenuItem::Separator)
        .add_item(CustomMenuItem::new("quit",         "Quit"));
    SystemTray::new().with_menu(menu)
}

// ── Entry point ────────────────────────────────────────────
fn main() {
    eprintln!("[BOOT] ====== Sound Overlay starting ======");
    eprintln!("[BOOT] Registering commands and building app...");
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_overlay_settings,
            save_overlay_settings,
            toggle_overlay_popup,
            set_main_click_through,
            get_main_position,
        ])
        .system_tray(build_tray())
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::LeftClick { .. } => {
                eprintln!("[TRAY] Left-click on tray icon — opening settings");
                open_settings_window(app);
            }
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "settings" => {
                    eprintln!("[TRAY] Menu: Settings clicked");
                    open_settings_window(app);
                }
                "show_overlay" => {
                    eprintln!("[TRAY] Menu: Show Overlay clicked");
                    if let Some(w) = app.get_window("main") { let _ = w.show(); }
                    if let Some(w) = app.get_window("bar_button") { let _ = w.show(); }
                    sync_button_position(app);
                }
                "quit" => {
                    eprintln!("[TRAY] Menu: Quit clicked — exiting");
                    std::process::exit(0);
                }
                other => eprintln!("[TRAY] Unknown menu item: {}", other),
            },
            _ => {}
        })
        .on_window_event(|event| {
            let label = event.window().label();
            match event.event() {
                // Keep bar_button in sync when main bar moves.
                WindowEvent::Moved(pos) if label == "main" => {
                    eprintln!("[WINDOW] main moved to ({}, {}) — syncing bar_button position", pos.x, pos.y);
                    sync_button_position(&event.window().app_handle());
                }
                // Re-assert bar_button z-order above the main bar after every resize
                // (popup open/close resizes main, which can push bar_button behind it).
                WindowEvent::Resized(_) if label == "main" => {
                    if let Some(btn) = event.window().app_handle().get_window("bar_button") {
                        let _ = btn.set_always_on_top(true);
                    }
                }
                // Closing any window hides it rather than quitting (tray app).
                WindowEvent::CloseRequested { api, .. } => {
                    eprintln!("[WINDOW] Close requested for '{}' — hiding instead of closing", label);
                    api.prevent_close();
                    let _ = event.window().hide();
                    if label == "main" {
                        eprintln!("[WINDOW] main hidden — hiding bar_button too");
                        if let Some(btn) = event.window().app_handle().get_window("bar_button") {
                            let _ = btn.hide();
                        }
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            eprintln!("[BOOT] Setup starting...");
            let handle = app.handle();

            // Read saved settings so we can restore bar position
            let saved = read_settings(&handle);

            // Main overlay: resize to full monitor width, restore saved Y position, then make click-through.
            eprintln!("[BOOT] Configuring main overlay window...");
            if let Some(main) = app.get_window("main") {
                if let Ok(Some(monitor)) = main.current_monitor() {
                    let scale = monitor.scale_factor();
                    let screen_w = monitor.size().width as f64 / scale;
                    eprintln!("[BOOT] Monitor detected — scale: {}, logical width: {}px", scale, screen_w);
                    let _ = main.set_size(tauri::LogicalSize::new(screen_w, 46.0));
                    eprintln!("[BOOT] Main window resized to {}x46", screen_w);
                } else {
                    eprintln!("[BOOT] WARNING: Could not read current monitor — bar may not be full width");
                }
                // Restore saved position (bar_x is normally 0 for full-width; bar_y allows vertical repositioning)
                eprintln!("[BOOT] Restoring bar position to ({}, {})", saved.bar_x, saved.bar_y);
                let _ = main.set_position(PhysicalPosition::new(saved.bar_x, saved.bar_y));
                let _ = main.set_ignore_cursor_events(true);
                eprintln!("[BOOT] Main window click-through enabled");
            } else {
                eprintln!("[BOOT] WARNING: main window not found in setup");
            }

            // Spawn the button sibling window.
            eprintln!("[BOOT] Opening bar_button window...");
            open_bar_button_window(&handle);
            sync_button_position(&handle);
            eprintln!("[BOOT] bar_button opened and positioned");

            // Start mock media loop (dev/placeholder only).
            eprintln!("[BOOT] Starting mock media loop...");
            let h = handle.clone();
            tauri::async_runtime::spawn(async move { mock_media_loop(h).await; });
            eprintln!("[BOOT] Setup complete — app is running");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}

// ── Mock media loop (dev placeholder) ─────────────────────
async fn mock_media_loop(handle: AppHandle) {
    eprintln!("[MEDIA] Mock media loop started");
    let states: &[MediaState] = &[
        MediaState { status: "idle".into(),    title: "".into(), artist: "".into(), album_art_url: "".into(), current_time: 0,   total_time: 0   },
        MediaState { status: "playing".into(), title: "Starlight".into(), artist: "Muse".into(),            album_art_url: "".into(), current_time: 83,  total_time: 240 },
        MediaState { status: "playing".into(), title: "Bohemian Rhapsody".into(), artist: "Queen".into(),   album_art_url: "".into(), current_time: 150, total_time: 355 },
    ];
    let mut i = 0usize;
    loop {
        let s = &states[i];
        eprintln!("[MEDIA] Emitting media-update [{}] status='{}' title='{}'", i, s.status, s.title);
        let _ = handle.emit_all("media-update", s);
        tokio::time::sleep(Duration::from_secs(5)).await;
        i = (i + 1) % states.len();
    }
}

