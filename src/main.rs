// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tauri::{
    AppHandle, CustomMenuItem, Manager, PhysicalPosition,
    SystemTray, SystemTrayEvent, SystemTrayMenu,
    WindowBuilder, WindowEvent, WindowUrl,
};
use windows::{
    Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as SmtcManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
    },
    Storage::Streams::DataReader,
};

// ── SMTC transport helper ──────────────────────────────────
// Returns the current active SMTC session, or an error string.
fn get_smtc_session(
) -> Result<windows::Media::Control::GlobalSystemMediaTransportControlsSession, String> {
    let manager = SmtcManager::RequestAsync()
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;
    manager.GetCurrentSession().map_err(|_| "no active SMTC session".to_string())
}

// ── Media state (mock, emitted to frontend) ────────────────
#[derive(Clone, serde::Serialize)]
struct MediaState {
    status:        String,
    title:         String,
    artist:        String,
    album_art_url: String,
    current_time:  u32,
    total_time:    u32,
    // False when current_time is extrapolated from a stale timeline
    // checkpoint (common for browser-tab sources, especially once the tab
    // is backgrounded and its own position-reporting timer gets throttled)
    // rather than a genuinely fresh one. The frontend uses this to decide
    // whether current_time is trustworthy enough to hard-correct its own
    // local clock against.
    position_live: bool,
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
    // "popup" (default) or "bar" — mutually exclusive with the visualizer,
    // enforced on the settings UI side.
    lyrics_display_mode:   String,
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
    let dir = tauri::api::path::app_config_dir(&handle.config())
        .ok_or_else(|| "cannot resolve app config dir".to_string())?;
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

#[tauri::command]
fn save_overlay_settings(handle: AppHandle, settings: OverlaySettings) -> Result<(), String> {
    write_settings(&handle, &settings)?;
    let _ = handle.emit_all("overlay-settings-updated", &settings);
    Ok(())
}

// The popup window's own visibility is the source of truth for "is it
// open" — no separate state to keep in sync.
#[tauri::command]
fn toggle_overlay_popup(handle: AppHandle) {
    let Some(win) = handle.get_window("popup") else { return; };
    let now_open = !win.is_visible().unwrap_or(false);
    if now_open {
        sync_popup_position(&handle);
        let _ = win.show();
    } else {
        let _ = win.hide();
    }
    let _ = handle.emit_all("overlay-popup-changed", serde_json::json!({ "open": now_open }));
}

#[tauri::command]
fn close_popup_window(handle: AppHandle) {
    if let Some(win) = handle.get_window("popup") {
        let _ = win.hide();
    }
    let _ = handle.emit_all("overlay-popup-changed", serde_json::json!({ "open": false }));
}

#[tauri::command]
fn set_main_click_through(handle: AppHandle, pass_through: bool) {
    if let Some(win) = handle.get_window("main") {
        let _ = win.set_ignore_cursor_events(pass_through);
    }
}

// Position of the main bar window (physical pixels)
#[derive(serde::Serialize)]
struct BarPosition { x: i32, y: i32 }

// Shared flag — audio_loop reads this every tick to decide whether to emit.
struct VisualizerEnabled(Arc<AtomicBool>);

#[tauri::command]
fn set_visualizer_enabled(handle: AppHandle, enabled: bool) {
    if let Some(state) = handle.try_state::<VisualizerEnabled>() {
        state.0.store(enabled, Ordering::Relaxed);
    }
}

#[tauri::command]
fn get_main_position(handle: AppHandle) -> Result<BarPosition, String> {
    let win = handle.get_window("main").ok_or_else(|| "main window not found".to_string())?;
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    Ok(BarPosition { x: pos.x, y: pos.y })
}

// ── Transport commands ─────────────────────────────────────
#[tauri::command]
fn media_play_pause() -> Result<(), String> {
    get_smtc_session()?.TryTogglePlayPauseAsync().map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn media_next() -> Result<(), String> {
    get_smtc_session()?.TrySkipNextAsync().map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn media_prev() -> Result<(), String> {
    get_smtc_session()?.TrySkipPreviousAsync().map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    Ok(())
}

// ── bar_button window helpers ──────────────────────────────
// The bar_button window is a tiny always-on-top interactive window
// positioned at the left edge of the main overlay bar.
// It stays click-through on the OS level is NOT needed here because
// the window itself is just 30×30 px — only the button is in it.
fn open_bar_button_window(handle: &AppHandle) {
    if handle.get_window("bar_button").is_some() { return; }
    let _ = WindowBuilder::new(handle, "bar_button", WindowUrl::App("bar_button.html".into()))
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
}

fn sync_button_position(handle: &AppHandle) {
    let (Some(main), Some(btn)) = (handle.get_window("main"), handle.get_window("bar_button")) else {
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
    if handle.get_window("popup").is_some() { return; }
    let _ = WindowBuilder::new(handle, "popup", WindowUrl::App("popup.html".into()))
        .title("Overlay Popup")
        .inner_size(290.0, 190.0) // popup.js self-resizes to fit its actual content
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build();
}

fn sync_popup_position(handle: &AppHandle) {
    let (Some(main), Some(popup)) = (handle.get_window("main"), handle.get_window("popup")) else {
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
    if let Some(win) = handle.get_window("settings") {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    if let Ok(win) = WindowBuilder::new(handle, "settings", WindowUrl::App("settings.html".into()))
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
            set_visualizer_enabled,
            get_main_position,
            media_play_pause,
            media_next,
            media_prev,
            fetch_lyrics,
            clear_lyrics_cache,
            close_popup_window,
        ])
        .system_tray(build_tray())
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::LeftClick { .. } => {
                open_settings_window(app);
            }
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "settings" => {
                    open_settings_window(app);
                }
                "show_overlay" => {
                    if let Some(w) = app.get_window("main")       { let _ = w.show(); }
                    if let Some(w) = app.get_window("bar_button") { let _ = w.show(); }
                    sync_button_position(app);
                    sync_popup_position(app);
                }
                "quit" => {
                    std::process::exit(0);
                }
                _ => {}
            },
            _ => {}
        })
        .on_window_event(|event| {
            let label = event.window().label();
            match event.event() {
                WindowEvent::Moved(_) if label == "main" => {
                    sync_button_position(&event.window().app_handle());
                    sync_popup_position(&event.window().app_handle());
                }
                WindowEvent::Resized(_) if label == "main" => {
                    if let Some(btn) = event.window().app_handle().get_window("bar_button") {
                        let _ = btn.set_always_on_top(true);
                    }
                }
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = event.window().hide();
                    if label == "main" {
                        let app = event.window().app_handle();
                        if let Some(btn) = app.get_window("bar_button") { let _ = btn.hide(); }
                        if let Some(popup) = app.get_window("popup")   { let _ = popup.hide(); }
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

            if let Some(main) = app.get_window("main") {
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

            let h = handle.clone();
            tauri::async_runtime::spawn(async move { smtc_loop(h).await; });

            let h2 = handle.clone();
            std::thread::spawn(move || audio_loop(h2, viz_flag));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}

// ── SMTC media watcher ────────────────────────────────────
async fn smtc_loop(handle: AppHandle) {
    tokio::time::sleep(Duration::from_millis(500)).await;

    let mut last_title  = String::new();
    let mut last_status = String::new();
    let mut cached_art  = String::new();

    loop {
        match poll_smtc(&last_title) {
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
                    let _ = handle.emit_all("media-update", &state);
                }
            }
            Err(_) => {
                if last_status != "idle" {
                    last_status = "idle".into();
                    last_title  = String::new();
                    cached_art  = String::new();
                    let _ = handle.emit_all("media-update", &MediaState {
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

// Windows FILETIME / WinRT DateTime epoch is 1601-01-01, in 100ns ticks.
// Unix epoch (1970-01-01) is this many seconds after that.
const WINDOWS_EPOCH_OFFSET_100NS: i64 = 11_644_473_600 * 10_000_000;

fn windows_now_ticks() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    (dur.as_nanos() / 100) as i64 + WINDOWS_EPOCH_OFFSET_100NS
}

fn poll_smtc(last_title: &str) -> Result<MediaState, String> {
    let session = get_smtc_session()?;

    let playback    = session.GetPlaybackInfo().map_err(|e| e.to_string())?;
    let status_enum = playback.PlaybackStatus().map_err(|e| e.to_string())?;
    let status = match status_enum {
        PlaybackStatus::Playing => "playing",
        PlaybackStatus::Paused  => "paused",
        _                        => "idle",
    }.to_string();

    let props  = session.TryGetMediaPropertiesAsync()
        .map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    let title  = props.Title() .unwrap_or_default().to_string();
    let artist = props.Artist().unwrap_or_default().to_string();

    // A checkpoint older than this isn't trusted enough to hard-correct the
    // frontend's own clock against — see position_live below.
    const STALE_THRESHOLD_TICKS: i64 = 5 * 10_000_000; // 5 seconds

    let (current_time, total_time, position_live) = session
        .GetTimelineProperties()
        .map(|tl| {
            let pos_ticks = tl.Position().unwrap_or_default().Duration;
            let end_ticks = tl.EndTime().unwrap_or_default().Duration;
            let last_updated = tl.LastUpdatedTime().map(|d| d.UniversalTime).unwrap_or(0);
            let age_ticks = if last_updated > 0 { (windows_now_ticks() - last_updated).max(0) } else { i64::MAX };

            // Position is a checkpoint, not a live clock — most sources only
            // push timeline updates occasionally, not every second (browser
            // tabs are the worst offenders: they only report a position
            // when the site's own JS calls it, and that reporting itself
            // gets throttled once the tab is backgrounded — e.g. because
            // the user tabbed away to a game). While playing, interpolate
            // forward from the last checkpoint so the value we report
            // actually advances every poll instead of sitting frozen.
            let live_ticks = if status == "playing" && last_updated > 0 {
                pos_ticks + age_ticks
            } else {
                pos_ticks
            };
            let live_ticks = live_ticks.clamp(0, end_ticks.max(0));

            // Only "live" when the checkpoint we extrapolated from is
            // recent — the longer we extrapolate from a stale one, the
            // more room there is for real playback (buffering hiccups,
            // throttled background-tab timing, etc.) to diverge from our
            // straight-line guess.
            let position_live = status == "playing" && age_ticks < STALE_THRESHOLD_TICKS;

            (
                (live_ticks / 10_000_000) as u32,
                (end_ticks / 10_000_000) as u32,
                position_live,
            )
        })
        .unwrap_or((0, 0, false));

    // Only decode the thumbnail stream when the track changes (avoids ~100-300 KB/s of allocations).
    let album_art_url = if title != last_title {
        read_album_art(&props).unwrap_or_default()
    } else {
        String::new() // caller restores the cached value
    };

    Ok(MediaState { status, title, artist, album_art_url, current_time, total_time, position_live })
}

// ── Audio frequency capture ───────────────────────────────
// Captures WASAPI loopback (system audio output), runs an FFT every ~33 ms,
// and emits an `audio-freq` event with 8 normalised band values (0.0–1.0).
// The frontend uses these to drive the EQ bar animation.
fn audio_loop(handle: AppHandle, enabled: Arc<AtomicBool>) {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    // Prefer the WASAPI host so we can open the output device as a loopback input.
    let host = match cpal::host_from_id(cpal::HostId::Wasapi) {
        Ok(h)  => h,
        Err(_) => return,
    };
    let device = match host.default_output_device() {
        Some(d) => d,
        None    => return,
    };
    let supported = match device.default_output_config() {
        Ok(c)  => c,
        Err(_) => return,
    };

    let sample_rate = supported.sample_rate().0 as f32;
    let channels    = supported.channels() as usize;
    let config      = supported.config();

    const FFT_SIZE: usize = 1024;
    // Tuning constant — raise if bars are too dim, lower if they clip.
    const GAIN: f32 = 300.0;

    let ring = Arc::new(Mutex::new(Vec::<f32>::with_capacity(FFT_SIZE * 4)));
    let ring_w = ring.clone();

    // Build a loopback input stream from the output device.
    // WASAPI shared mode transparently converts the native format to f32.
    let stream = device.build_input_stream(
        &config,
        move |data: &[f32], _: &cpal::InputCallbackInfo| {
            let mut buf = ring_w.lock().unwrap();
            // Mix multi-channel to mono and append.
            for chunk in data.chunks(channels.max(1)) {
                let mono = chunk.iter().copied().sum::<f32>() / chunk.len() as f32;
                buf.push(mono);
            }
            // Keep only the most recent samples to bound memory use.
            if buf.len() > FFT_SIZE * 4 {
                let drop = buf.len() - FFT_SIZE * 2;
                buf.drain(..drop);
            }
        },
        |_| {},
        None,
    );
    let stream = match stream { Ok(s) => s, Err(_) => return };
    if stream.play().is_err() { return; }

    // FftPlanner caches plans — creating it once per thread is fine.
    let mut planner = rustfft::FftPlanner::<f32>::new();

    loop {
        std::thread::sleep(Duration::from_millis(33));

        if !enabled.load(Ordering::Relaxed) { continue; }

        let window: Vec<f32> = {
            let buf = ring.lock().unwrap();
            if buf.len() < FFT_SIZE { continue; }
            buf[buf.len() - FFT_SIZE..].to_vec()
        };

        let bands = compute_bands(&window, sample_rate, &mut planner, GAIN);
        let _ = handle.emit_all("audio-freq", &bands);
    }
}

// Applies a Hann window, runs an FFT of length `samples.len()`, then
// returns 8 RMS band energies scaled to 0.0–1.0 using `gain`.
fn compute_bands(
    samples:  &[f32],
    sample_rate: f32,
    planner:  &mut rustfft::FftPlanner<f32>,
    gain:     f32,
) -> [f32; 24] {
    use rustfft::num_complex::Complex;

    let n = samples.len();
    let pi = std::f32::consts::PI;

    // Hann window → reduces spectral leakage.
    let mut buf: Vec<Complex<f32>> = samples.iter().enumerate().map(|(i, &s)| {
        let w = 0.5 * (1.0 - (2.0 * pi * i as f32 / (n - 1) as f32).cos());
        Complex { re: s * w, im: 0.0 }
    }).collect();

    planner.plan_fft_forward(n).process(&mut buf);

    let bin_hz  = sample_rate / n as f32;
    let nyquist = n / 2;

    // 24 logarithmically-spaced bands — one per EQ bar.
    const EDGES: [f32; 25] = [
         25.0,  40.0,  60.0,  80.0, 100.0, 125.0, 160.0, 200.0,
        250.0, 315.0, 400.0, 500.0, 630.0, 800.0, 1_000.0, 1_250.0,
        1_600.0, 2_000.0, 2_500.0, 3_150.0, 4_000.0, 6_300.0, 10_000.0, 16_000.0, 20_000.0,
    ];

    let mut out = [0.0f32; 24];
    for i in 0..24 {
        let lo = ((EDGES[i]     / bin_hz).round() as usize).clamp(1, nyquist);
        let hi = ((EDGES[i + 1] / bin_hz).round() as usize).clamp(lo + 1, nyquist + 1);
        let count = (hi - lo) as f32;
        // RMS of magnitudes in band
        let energy = buf[lo..hi].iter().map(|c| c.norm_sqr()).sum::<f32>() / count;
        out[i] = (energy.sqrt() / n as f32 * gain).clamp(0.0, 1.0);
    }
    out
}

fn read_album_art(
    props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties,
) -> Result<String, String> {
    let thumb_ref = props.Thumbnail().map_err(|e| e.to_string())?;

    let stream = thumb_ref
        .OpenReadAsync()
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;

    let size = stream.Size().map_err(|e| e.to_string())? as u32;
    if size == 0 { return Err("empty art stream".into()); }

    let reader = DataReader::CreateDataReader(&stream).map_err(|e| e.to_string())?;
    reader.LoadAsync(size).map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;

    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf).map_err(|e| e.to_string())?;

    // Detect MIME type from magic bytes.
    let mime = if buf.starts_with(b"\xFF\xD8\xFF") { "image/jpeg" }
               else if buf.starts_with(b"\x89PNG")  { "image/png"  }
               else                                   { "image/jpeg" };

    Ok(format!("data:{};base64,{}", mime, B64.encode(&buf)))
}

