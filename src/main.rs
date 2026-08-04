// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod audio_analysis;
mod platform;

use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition,
    WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

// ── Media state (emitted to frontend) ───────────────────────
// pub(crate) — constructed from src/platform/{windows,linux}.rs.
#[derive(Clone, serde::Serialize)]
pub(crate) struct MediaState {
    pub(crate) status:        String,
    pub(crate) title:         String,
    pub(crate) artist:        String,
    pub(crate) album_art_url: String,
    pub(crate) current_time:  u32,
    pub(crate) total_time:    u32,
    // False when current_time is extrapolated from a stale timeline
    // checkpoint (common for browser-tab sources, especially once the tab
    // is backgrounded and its own position-reporting timer gets throttled)
    // rather than a genuinely fresh one. The frontend uses this to decide
    // whether current_time is trustworthy enough to hard-correct its own
    // local clock against. Always true-when-playing on Linux/MPRIS, whose
    // Position property is specified to be computed fresh on each query.
    pub(crate) position_live: bool,
}

// Detects JPEG/PNG from magic bytes — shared by both platforms' album-art
// handling (Windows' embedded SMTC thumbnail stream, Linux's MPRIS artUrl
// file/URL).
pub(crate) fn detect_image_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\xFF\xD8\xFF")   { "image/jpeg" }
    else if bytes.starts_with(b"\x89PNG")  { "image/png"  }
    else                                     { "image/jpeg" }
}

// A global keybind. Disabled and unset by default — the user must open
// Settings > Keybinds, record a combo, and enable it explicitly. `combo` is
// stored in the accelerator format the global-shortcut plugin expects
// (e.g. "Ctrl+Alt+P"); "" means "not set yet".
#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ShortcutBinding {
    enabled: bool,
    combo:   String,
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
    bar_x:               i32,
    bar_y:               i32,
    visualizer_gain:      f32,
    visualizer_smoothing:  f32,
    visualizer_enabled:    bool,
    visualizer_bands:      u8,
    lyrics_enabled:        bool,
    // "popup" (default, below the bar) or "bar" (under the visualizer) —
    // independent of visualizer_enabled, not exclusive with it.
    lyrics_display_mode:   String,
    shortcut_play_pause:        ShortcutBinding,
    shortcut_next:              ShortcutBinding,
    shortcut_prev:               ShortcutBinding,
    shortcut_toggle_popup:       ShortcutBinding,
    shortcut_hide_bar:           ShortcutBinding,
    shortcut_toggle_visualizer:  ShortcutBinding,
    shortcut_open_settings:      ShortcutBinding,
    // When true, and bar-mode lyrics are currently showing a line, the
    // hide-bar shortcut shrinks the bar down to just that line instead of
    // hiding the window outright (see frontend "hotkey-hide-bar" handling
    // in js/main.js — Rust doesn't track lyrics-visible state itself).
    hide_bar_keeps_lyrics: bool,
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
            bar_x:               0,
            bar_y:               0,
            visualizer_gain:      1.0,
            visualizer_smoothing:  0.20,
            visualizer_enabled:    true,
            visualizer_bands:      24,
            lyrics_enabled:        false,
            lyrics_display_mode:   "popup".into(),
            shortcut_play_pause:        ShortcutBinding::default(),
            shortcut_next:              ShortcutBinding::default(),
            shortcut_prev:               ShortcutBinding::default(),
            shortcut_toggle_popup:       ShortcutBinding::default(),
            shortcut_hide_bar:           ShortcutBinding::default(),
            shortcut_toggle_visualizer:  ShortcutBinding::default(),
            shortcut_open_settings:      ShortcutBinding::default(),
            hide_bar_keeps_lyrics: false,
        }
    }
}

// ── Settings persistence helpers ──────────────────────────
fn settings_path(handle: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = handle.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn read_settings(handle: &AppHandle) -> OverlaySettings {
    let Ok(path) = settings_path(handle)     else { return OverlaySettings::default(); };
    let Ok(raw)  = fs::read_to_string(&path) else { return OverlaySettings::default(); };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_settings(handle: &AppHandle, s: &OverlaySettings) -> Result<(), String> {
    let path    = settings_path(handle)?;
    let content = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())
}

// ── Lyrics (lrclib.net) ─────────────────────────────────────
// Synced-lyrics lookup, keyed by "title|artist" (lowercased). Misses are
// cached too, so a track confirmed to have no synced lyrics isn't
// re-queried every time it's replayed.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct LyricsLine {
    time: f32,
    text: String,
}

#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
struct LyricsResponse {
    available: bool,
    lines: Vec<LyricsLine>,
}

struct LyricsCache(Mutex<HashMap<String, LyricsResponse>>);

fn lyrics_cache_path(handle: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = handle.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("lyrics_cache.json"))
}

fn load_lyrics_cache(handle: &AppHandle) -> HashMap<String, LyricsResponse> {
    let Ok(path) = lyrics_cache_path(handle)    else { return HashMap::new(); };
    let Ok(raw)  = fs::read_to_string(&path)    else { return HashMap::new(); };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_lyrics_cache(handle: &AppHandle, cache: &HashMap<String, LyricsResponse>) {
    if let Ok(path) = lyrics_cache_path(handle) {
        if let Ok(content) = serde_json::to_string(cache) {
            let _ = fs::write(&path, content);
        }
    }
}

fn lyrics_cache_key(title: &str, artist: &str) -> String {
    format!("{}|{}", title.trim().to_lowercase(), artist.trim().to_lowercase())
}

// Percent-encodes a query parameter (byte-oriented, so multi-byte UTF-8
// characters in track/artist names come through correctly).
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// Parses LRC-format synced lyrics into (time, text) lines. Skips metadata
// tags ([ar:...], [ti:...], etc.) — anything whose bracket content isn't a
// numeric mm:ss.xx timestamp. A line can carry multiple stacked timestamps
// (e.g. a repeated chorus); each becomes its own entry.
fn parse_lrc(text: &str) -> Vec<LyricsLine> {
    let mut lines = Vec::new();

    for raw_line in text.lines() {
        let mut rest  = raw_line.trim();
        let mut times = Vec::new();

        while rest.starts_with('[') {
            let Some(close) = rest.find(']') else { break; };
            match parse_lrc_timestamp(&rest[1..close]) {
                Some(t) => {
                    times.push(t);
                    rest = &rest[close + 1..];
                }
                None => break, // non-timestamp tag — not a lyric line
            }
        }

        if times.is_empty() { continue; }
        let text = rest.trim().to_string();
        for t in times {
            lines.push(LyricsLine { time: t, text: text.clone() });
        }
    }

    lines.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    lines
}

fn parse_lrc_timestamp(tag: &str) -> Option<f32> {
    // "mm:ss.xx" -> ["mm", "ss", "xx"]
    let normalized = tag.replacen(':', ".", 1);
    let parts: Vec<&str> = normalized.splitn(3, '.').collect();
    if parts.len() < 2 { return None; }

    let minutes: f32 = parts[0].parse().ok()?;
    let seconds: f32 = parts[1].parse().ok()?;
    let fraction: f32 = match parts.get(2) {
        Some(frac) => format!("0.{frac}").parse().ok()?,
        None => 0.0,
    };
    Some(minutes * 60.0 + seconds + fraction)
}

fn fetch_lyrics_remote(title: &str, artist: &str, duration_secs: u32) -> Result<LyricsResponse, String> {
    let url = format!(
        "https://lrclib.net/api/get?track_name={}&artist_name={}&duration={}",
        url_encode(title), url_encode(artist), duration_secs
    );

    let response = ureq::get(&url)
        .timeout(Duration::from_secs(5))
        .call()
        .map_err(|e| e.to_string())?;

    let body: serde_json::Value = response.into_json().map_err(|e| e.to_string())?;

    match body.get("syncedLyrics").and_then(|v| v.as_str()) {
        Some(lrc) if !lrc.trim().is_empty() => Ok(LyricsResponse { available: true, lines: parse_lrc(lrc) }),
        _ => Ok(LyricsResponse { available: false, lines: Vec::new() }),
    }
}

#[tauri::command]
fn fetch_lyrics(handle: AppHandle, title: String, artist: String, duration_secs: u32) -> Result<LyricsResponse, String> {
    let key = lyrics_cache_key(&title, &artist);

    if let Some(state) = handle.try_state::<LyricsCache>() {
        if let Some(cached) = state.0.lock().unwrap().get(&key) {
            return Ok(cached.clone());
        }
    }

    // A failed lookup (network error, no match) is treated the same as
    // "no synced lyrics" from the frontend's point of view.
    let result = fetch_lyrics_remote(&title, &artist, duration_secs).unwrap_or_default();

    if let Some(state) = handle.try_state::<LyricsCache>() {
        let mut map = state.0.lock().unwrap();
        map.insert(key, result.clone());
        save_lyrics_cache(&handle, &map);
    }

    Ok(result)
}

#[tauri::command]
fn clear_lyrics_cache(handle: AppHandle) -> Result<(), String> {
    if let Some(state) = handle.try_state::<LyricsCache>() {
        state.0.lock().unwrap().clear();
    }
    if let Ok(path) = lyrics_cache_path(&handle) {
        let _ = fs::remove_file(&path);
    }
    Ok(())
}

// ── Tauri commands ─────────────────────────────────────────
#[tauri::command]
fn load_overlay_settings(handle: AppHandle) -> OverlaySettings {
    read_settings(&handle)
}

// Returns the action names of any enabled shortcuts that failed to
// register (e.g. already claimed by another application) — this is the
// live "is this combo taken" check; there's no way to know in advance.
#[tauri::command]
fn save_overlay_settings(handle: AppHandle, settings: OverlaySettings) -> Result<Vec<String>, String> {
    write_settings(&handle, &settings)?;
    let failed_shortcuts = sync_shortcuts(&handle, &settings);
    let _ = handle.emit("overlay-settings-updated", &settings);
    Ok(failed_shortcuts)
}

// The popup window's own visibility is the source of truth for "is it
// open" — no separate state to keep in sync. Shared by the IPC command
// below and the "toggle popup" global shortcut handler.
fn toggle_popup_internal(handle: &AppHandle) {
    let Some(win) = handle.get_webview_window("popup") else { return; };
    let now_open = !win.is_visible().unwrap_or(false);
    if now_open {
        sync_popup_position(handle);
        let _ = win.show();
    } else {
        let _ = win.hide();
    }
    let _ = handle.emit("overlay-popup-changed", serde_json::json!({ "open": now_open }));
}

#[tauri::command]
fn toggle_overlay_popup(handle: AppHandle) {
    toggle_popup_internal(&handle);
}

// Hides/shows the main bar + its toggle button together — used by the
// "hide bar" shortcut's full-hide path (see js/main.js's "hotkey-hide-bar"
// handling for the other path, which shrinks the bar in place instead of
// hiding the window). A dedicated command because main.js can't reach
// across to bar_button itself — same reason WindowEvent::CloseRequested
// already does this cross-window hide in Rust.
#[tauri::command]
fn set_main_visible(handle: AppHandle, visible: bool) {
    if let Some(win) = handle.get_webview_window("main") {
        if visible { let _ = win.show(); } else { let _ = win.hide(); }
    }
    if let Some(btn) = handle.get_webview_window("bar_button") {
        if visible { let _ = btn.show(); } else { let _ = btn.hide(); }
    }
}

// ── Global keybinds ─────────────────────────────────────────
// Windows (and every OS) has no "is this combo free?" query — the only way
// to know is to attempt registration and see whether it fails. This is
// that attempt: unregisters everything, then re-registers whatever's
// enabled with a non-empty combo, returning the action names that failed
// (surfaced by the frontend as "already in use"). Full re-sync rather than
// diffing — simpler, and this only runs at startup and on user-initiated
// saves, not a hot path.
fn sync_shortcuts(handle: &AppHandle, settings: &OverlaySettings) -> Vec<String> {
    let gs = handle.global_shortcut();
    let _ = gs.unregister_all();

    // Action names are camelCase to match the frontend's element IDs
    // directly (shortcut-<action>-combo etc. in settings.html) — these
    // strings cross the Rust/JS boundary as-is via the failed-shortcuts
    // list, so there's no snake_case/camelCase conversion needed on either
    // side.
    let bindings: [(&str, &ShortcutBinding); 7] = [
        ("playPause",        &settings.shortcut_play_pause),
        ("next",             &settings.shortcut_next),
        ("prev",             &settings.shortcut_prev),
        ("togglePopup",      &settings.shortcut_toggle_popup),
        ("hideBar",          &settings.shortcut_hide_bar),
        ("toggleVisualizer", &settings.shortcut_toggle_visualizer),
        ("openSettings",     &settings.shortcut_open_settings),
    ];

    let mut failed = Vec::new();
    for (action, binding) in bindings {
        if !binding.enabled || binding.combo.is_empty() { continue; }

        let Ok(shortcut) = binding.combo.parse::<Shortcut>() else {
            failed.push(action.to_string());
            continue;
        };

        let action_owned = action.to_string();
        let registered = gs.on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                run_shortcut_action(app, &action_owned);
            }
        });
        if registered.is_err() {
            failed.push(action.to_string());
        }
    }

    failed
}

fn run_shortcut_action(app: &AppHandle, action: &str) {
    match action {
        "playPause" => { let _ = platform::media_play_pause(); }
        "next"      => { let _ = platform::media_next(); }
        "prev"      => { let _ = platform::media_prev(); }
        "togglePopup" => toggle_popup_internal(app),
        // Rust doesn't know whether bar-mode lyrics are currently showing
        // (only js/main.js does) — it just notifies the bar window and
        // lets the frontend decide between shrinking-to-lyrics-line and a
        // full hide (which then calls set_main_visible back on this side).
        "hideBar" => {
            let _ = app.emit("hotkey-hide-bar", ());
        }
        "toggleVisualizer" => {
            let mut settings = read_settings(app);
            settings.visualizer_enabled = !settings.visualizer_enabled;
            if let Some(state) = app.try_state::<VisualizerEnabled>() {
                state.0.store(settings.visualizer_enabled, Ordering::Relaxed);
            }
            let _ = write_settings(app, &settings);
            let _ = app.emit("overlay-settings-updated", &settings);
        }
        "openSettings" => open_settings_window(app),
        _ => {}
    }
}

#[tauri::command]
fn close_popup_window(handle: AppHandle) {
    if let Some(win) = handle.get_webview_window("popup") {
        let _ = win.hide();
    }
    let _ = handle.emit("overlay-popup-changed", serde_json::json!({ "open": false }));
}

#[tauri::command]
fn set_main_click_through(handle: AppHandle, pass_through: bool) {
    if let Some(win) = handle.get_webview_window("main") {
        let _ = win.set_ignore_cursor_events(pass_through);
    }
}

// Position of the main bar window (physical pixels)
#[derive(serde::Serialize)]
struct BarPosition { x: i32, y: i32 }

// Shared flag — each platform's audio capture loop (src/platform/*) reads
// this every tick to decide whether to run the FFT and emit.
struct VisualizerEnabled(Arc<AtomicBool>);

#[tauri::command]
fn set_visualizer_enabled(handle: AppHandle, enabled: bool) {
    if let Some(state) = handle.try_state::<VisualizerEnabled>() {
        state.0.store(enabled, Ordering::Relaxed);
    }
}

#[tauri::command]
fn get_main_position(handle: AppHandle) -> Result<BarPosition, String> {
    let win = handle.get_webview_window("main").ok_or_else(|| "main window not found".to_string())?;
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    Ok(BarPosition { x: pos.x, y: pos.y })
}

// ── Transport commands ─────────────────────────────────────
// Thin wrappers — the real implementation is per-platform (SMTC on
// Windows, MPRIS on Linux); see src/platform/*.
#[tauri::command]
fn media_play_pause() -> Result<(), String> {
    platform::media_play_pause()
}

#[tauri::command]
fn media_next() -> Result<(), String> {
    platform::media_next()
}

#[tauri::command]
fn media_prev() -> Result<(), String> {
    platform::media_prev()
}

// ── bar_button window helpers ──────────────────────────────
// The bar_button window is a tiny always-on-top interactive window
// positioned at the left edge of the main overlay bar.
// It stays click-through on the OS level is NOT needed here because
// the window itself is just 30×30 px — only the button is in it.
fn open_bar_button_window(handle: &AppHandle) {
    if handle.get_webview_window("bar_button").is_some() { return; }
    let Ok(win) = WebviewWindowBuilder::new(handle, "bar_button", WebviewUrl::App("bar_button.html".into()))
        .title("Overlay Toggle")
        .inner_size(30.0, 22.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false) // otherwise DWM draws its default drop-shadow/border
                        // around this tiny borderless window on Windows
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
    else { return };
    platform::float_window(&win);
    let _ = win.show();
    platform::pin_window_size(&win, 30, 22);
}

fn sync_button_position(handle: &AppHandle) {
    let (Some(main), Some(btn)) = (handle.get_webview_window("main"), handle.get_webview_window("bar_button")) else {
        return;
    };
    if let Ok(pos) = main.outer_position() {
        let _ = btn.set_position(PhysicalPosition::new(pos.x + 10, pos.y - 8));
    }
}

// ── popup window helpers ────────────────────────────────────
// The popup (art/title/progress/transport) is its own small always-on-top
// window, exactly like bar_button above — this is what makes it possible
// for it to be genuinely click-through everywhere except its own tiny
// rectangle. Before this, the popup lived inside the full-width "main"
// window, so opening it made set_ignore_cursor_events(false) apply to that
// entire window — swallowing clicks across the whole bar's width, not just
// the popup box (a serious problem when this overlay sits on top of a game).
fn open_popup_window(handle: &AppHandle) {
    if handle.get_webview_window("popup").is_some() { return; }
    let Ok(win) = WebviewWindowBuilder::new(handle, "popup", WebviewUrl::App("popup.html".into()))
        .title("Overlay Popup")
        .inner_size(290.0, 190.0) // popup.js self-resizes to fit its actual content
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false) // same DWM border issue as bar_button — see there
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
    else { return };
    platform::float_window(&win);
}

fn sync_popup_position(handle: &AppHandle) {
    let (Some(main), Some(popup)) = (handle.get_webview_window("main"), handle.get_webview_window("popup")) else {
        return;
    };
    let settings = read_settings(handle);
    if let Ok(pos) = main.outer_position() {
        let x = pos.x + 14 + settings.offset_x as i32;
        let y = pos.y + 58 + settings.offset_y as i32;
        let _ = popup.set_position(PhysicalPosition::new(x, y));
    }
}

// ── Settings window ────────────────────────────────────────
fn open_settings_window(handle: &AppHandle) {
    if let Some(win) = handle.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    if let Ok(win) = WebviewWindowBuilder::new(handle, "settings", WebviewUrl::App("settings.html".into()))
        .title("Sound Overlay Settings")
        .inner_size(860.0, 580.0)
        .min_inner_size(720.0, 480.0)
        .resizable(true)
        .decorations(true)
        .visible(true)
        .build()
    {
        let _ = win.set_focus();
    }
}

// ── System tray ────────────────────────────────────────────
// Menu/tray-icon building moved to v2's tauri::menu / tauri::tray modules —
// built inside .setup() below since TrayIconBuilder needs an app handle,
// unlike v1's SystemTray which was attached directly on the Builder.
fn build_tray_menu(handle: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let settings     = MenuItem::with_id(handle, "settings",     "Settings",     true, None::<&str>)?;
    let show_overlay = MenuItem::with_id(handle, "show_overlay", "Show Overlay", true, None::<&str>)?;
    let separator    = PredefinedMenuItem::separator(handle)?;
    let quit         = MenuItem::with_id(handle, "quit",         "Quit",         true, None::<&str>)?;
    Menu::with_items(handle, &[&settings, &show_overlay, &separator, &quit])
}

fn handle_tray_menu_event(app: &AppHandle, id: &str) {
    match id {
        "settings" => {
            open_settings_window(app);
        }
        "show_overlay" => {
            if let Some(w) = app.get_webview_window("main")       { let _ = w.show(); }
            if let Some(w) = app.get_webview_window("bar_button") { let _ = w.show(); }
            sync_button_position(app);
            sync_popup_position(app);
        }
        "quit" => {
            std::process::exit(0);
        }
        _ => {}
    }
}

// ── Entry point ────────────────────────────────────────────
fn main() {
    eprintln!("[BOOT] ====== Sound Overlay starting ======");
    eprintln!("[BOOT] Registering commands and building app...");
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            load_overlay_settings,
            save_overlay_settings,
            toggle_overlay_popup,
            set_main_click_through,
            set_visualizer_enabled,
            get_main_position,
            media_play_pause,
            media_next,
            media_prev,
            fetch_lyrics,
            clear_lyrics_cache,
            close_popup_window,
            set_main_visible,
        ])
        .on_window_event(|window, event| {
            let label = window.label();
            match event {
                WindowEvent::Moved(_) if label == "main" => {
                    sync_button_position(window.app_handle());
                    sync_popup_position(window.app_handle());
                }
                WindowEvent::Resized(_) if label == "main" => {
                    if let Some(btn) = window.app_handle().get_webview_window("bar_button") {
                        let _ = btn.set_always_on_top(true);
                    }
                }
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                    if label == "main" {
                        let app = window.app_handle();
                        if let Some(btn) = app.get_webview_window("bar_button") { let _ = btn.hide(); }
                        if let Some(popup) = app.get_webview_window("popup")   { let _ = popup.hide(); }
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            let handle = app.handle();
            let saved  = read_settings(&handle);

            let viz_flag = Arc::new(AtomicBool::new(saved.visualizer_enabled));
            app.manage(VisualizerEnabled(viz_flag.clone()));

            let lyrics_cache = load_lyrics_cache(&handle);
            app.manage(LyricsCache(Mutex::new(lyrics_cache)));

            sync_shortcuts(&handle, &saved);

            if let Some(main) = app.get_webview_window("main") {
                // Tiling WMs (i3 etc.) decide float-vs-tile at map time, so the
                // type hint has to land before the window is ever shown —
                // hence "visible": false in tauri.conf.json and an explicit
                // show() here, after the hint, instead of relying on the
                // config's own initial show.
                platform::float_window(&main);
                let _ = main.show(); // realizes the GDK window — set_ignore_cursor_events below needs it to exist
                if let Ok(Some(monitor)) = main.current_monitor() {
                    let screen_w = monitor.size().width as f64 / monitor.scale_factor();
                    let _ = main.set_size(tauri::LogicalSize::new(screen_w, 54.0));
                }
                let _ = main.set_position(PhysicalPosition::new(saved.bar_x, saved.bar_y));
                let _ = main.set_ignore_cursor_events(true);
            }

            open_bar_button_window(&handle);
            sync_button_position(&handle);

            open_popup_window(&handle);
            sync_popup_position(&handle);

            let tray_menu = build_tray_menu(&handle)?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| handle_tray_menu_event(app, event.id().as_ref()))
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        open_settings_window(tray.app_handle());
                    }
                })
                .build(app)?;

            let h = handle.clone();
            tauri::async_runtime::spawn(async move { media_loop(h).await; });

            platform::spawn_audio_capture(handle.clone(), viz_flag);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}

// ── Media watcher ──────────────────────────────────────────
// Platform-agnostic — poll_media() is SMTC on Windows, MPRIS on Linux
// (src/platform/*), but the polling/emit shape is identical either way.
async fn media_loop(handle: AppHandle) {
    tokio::time::sleep(Duration::from_millis(500)).await;

    let mut last_title  = String::new();
    let mut last_status = String::new();
    let mut cached_art  = String::new();

    loop {
        match platform::poll_media(&last_title) {
            Ok(mut state) => {
                if state.title == last_title {
                    // Same track — reuse cached art (avoids re-reading the thumbnail stream).
                    state.album_art_url = cached_art.clone();
                } else {
                    cached_art = state.album_art_url.clone();
                }
                let changed = state.title != last_title || state.status != last_status;
                if changed {
                    last_title  = state.title.clone();
                    last_status = state.status.clone();
                }
                // Re-emit every tick while playing too, not just on change —
                // otherwise current_time is only ever corrected once (at
                // track/status change) and the frontend's local 1s ticker
                // drifts against real playback over the length of a song
                // (this is what caused lyrics to fall out of sync).
                if changed || state.status == "playing" {
                    let _ = handle.emit("media-update", &state);
                }
            }
            Err(_) => {
                if last_status != "idle" {
                    last_status = "idle".into();
                    last_title  = String::new();
                    cached_art  = String::new();
                    let _ = handle.emit("media-update", &MediaState {
                        status:        "idle".into(),
                        title:         String::new(),
                        artist:        String::new(),
                        album_art_url: String::new(),
                        current_time:  0,
                        total_time:    0,
                        position_live: false,
                    });
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}


