// Linux implementation: media info via MPRIS (a D-Bus interface media
// players implement — org.mpris.MediaPlayer2.*), audio capture via
// PulseAudio's monitor-source recording (also covers PipeWire desktops via
// its pulse-compatibility layer, which is what makes one implementation
// cover Arch/Fedora/Ubuntu/Mint in their common desktop configurations).
//
// Written without a Linux environment to compile or test against. The
// overall approach — list MPRIS names, pick the active player, read its
// Metadata/Position/PlaybackStatus; PulseAudio's Simple API reading
// "@DEFAULT_MONITOR@" — is solid, but exact zbus / libpulse-binding method
// names may need a small fixup against whatever crate version actually
// resolves when this is built for real. Send the first compiler error and
// it should be a quick fix, not a design change.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tauri::{AppHandle, Emitter};
use zbus::blocking::{Connection, Proxy};

use crate::audio_analysis::compute_bands;
use crate::{detect_image_mime, MediaState};

const MPRIS_PATH:          &str = "/org/mpris/MediaPlayer2";
const MPRIS_PLAYER_IFACE:  &str = "org.mpris.MediaPlayer2.Player";

// Picks "the" active player when several might be running: prefers one
// that's actually Playing, falls back to a Paused one, else None. Re-run
// fresh on every poll/command rather than cached — an extra ListNames call
// once a second (or on an occasional transport click) is cheap enough not
// to matter, and it means we always react correctly to a player closing.
fn find_active_player(conn: &Connection) -> Option<String> {
    let dbus = Proxy::new(conn, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus").ok()?;
    let names: Vec<String> = dbus.call("ListNames", &()).ok()?;

    let mut fallback = None;
    for name in names.into_iter().filter(|n| n.starts_with("org.mpris.MediaPlayer2.")) {
        let Ok(player) = Proxy::new(conn, name.clone(), MPRIS_PATH, MPRIS_PLAYER_IFACE) else { continue };
        let Ok(status) = player.get_property::<String>("PlaybackStatus") else { continue };
        if status == "Playing" { return Some(name); }
        if status == "Paused" && fallback.is_none() { fallback = Some(name); }
    }
    fallback
}

fn get_player(conn: &Connection) -> Result<Proxy<'static>, String> {
    let name = find_active_player(conn).ok_or_else(|| "no active MPRIS player".to_string())?;
    Proxy::new(conn, name, MPRIS_PATH, MPRIS_PLAYER_IFACE).map_err(|e| e.to_string())
}

// ── Transport commands ─────────────────────────────────────
pub fn media_play_pause() -> Result<(), String> {
    let conn = Connection::session().map_err(|e| e.to_string())?;
    get_player(&conn)?.call_method("PlayPause", &()).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn media_next() -> Result<(), String> {
    let conn = Connection::session().map_err(|e| e.to_string())?;
    get_player(&conn)?.call_method("Next", &()).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn media_prev() -> Result<(), String> {
    let conn = Connection::session().map_err(|e| e.to_string())?;
    get_player(&conn)?.call_method("Previous", &()).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn poll_media(_last_title: &str) -> Result<MediaState, String> {
    let conn = Connection::session().map_err(|e| e.to_string())?;
    let player = get_player(&conn)?;

    let raw_status: String = player.get_property("PlaybackStatus").unwrap_or_else(|_| "Stopped".into());
    let status = match raw_status.as_str() {
        "Playing" => "playing",
        "Paused"  => "paused",
        _         => "idle",
    }.to_string();

    let metadata: std::collections::HashMap<String, zbus::zvariant::OwnedValue> =
        player.get_property("Metadata").unwrap_or_default();

    let title = metadata.get("xesam:title")
        .and_then(|v| <&str>::try_from(v).ok())
        .unwrap_or("").to_string();

    // xesam:artist is an array of strings — take the first.
    let artist = metadata.get("xesam:artist")
        .and_then(|v| <&zbus::zvariant::Array>::try_from(v).ok())
        .and_then(|arr| arr.get(0))
        .and_then(|v| <&str>::try_from(v).ok())
        .unwrap_or("").to_string();

    let art_url = metadata.get("mpris:artUrl")
        .and_then(|v| <&str>::try_from(v).ok())
        .unwrap_or("").to_string();

    let length_us: i64 = metadata.get("mpris:length")
        .and_then(|v| <i64>::try_from(v).ok())
        .unwrap_or(0);

    let position_us: i64 = player.get_property("Position").unwrap_or(0);

    let current_time = (position_us / 1_000_000).max(0) as u32;
    let total_time   = (length_us   / 1_000_000).max(0) as u32;

    // Unlike Windows SMTC, MPRIS's Position is specified to be computed
    // fresh by the player on each query rather than a cached checkpoint —
    // no interpolation/staleness tracking needed here (see the Windows
    // implementation's position_live handling for why that's not true
    // there).
    let position_live = status == "playing";

    let album_art_url = resolve_art_url(&art_url).unwrap_or_default();

    Ok(MediaState { status, title, artist, album_art_url, current_time, total_time, position_live })
}

// mpris:artUrl is usually a local "file://" path to a cached thumbnail,
// occasionally an http(s) URL. Either way, re-encode to the same
// data:<mime>;base64,... shape the Windows path produces, so the frontend
// (js/main.js / js/popup.js's setAlbumArt) never needs to know which
// platform it's running on.
fn resolve_art_url(url: &str) -> Option<String> {
    if url.is_empty() { return None; }

    let bytes = if let Some(path) = url.strip_prefix("file://") {
        std::fs::read(path).ok()?
    } else if url.starts_with("http://") || url.starts_with("https://") {
        let mut buf = Vec::new();
        ureq::get(url).call().ok()?.into_reader().read_to_end(&mut buf).ok()?;
        buf
    } else {
        return None;
    };

    let mime = detect_image_mime(&bytes);
    Some(format!("data:{};base64,{}", mime, B64.encode(&bytes)))
}

// ── Audio frequency capture ───────────────────────────────
// Records from PulseAudio's "@DEFAULT_MONITOR@" — its own alias for "the
// monitor of whatever sink is currently default" — so there's no need to
// enumerate sound cards or hardcode a device name that would vary by
// machine. Works whether the system runs PulseAudio proper or PipeWire
// with its pulse-compatible layer.
pub fn spawn_audio_capture(handle: AppHandle, enabled: Arc<AtomicBool>) {
    std::thread::spawn(move || audio_loop(handle, enabled));
}

fn audio_loop(handle: AppHandle, enabled: Arc<AtomicBool>) {
    use libpulse_binding as pulse;
    use libpulse_simple_binding::Simple;

    const SAMPLE_RATE: u32 = 44_100;
    const CHANNELS: u8 = 2;
    const FFT_SIZE: usize = 1024;
    // Tuning constant — raise if bars are too dim, lower if they clip.
    const GAIN: f32 = 300.0;

    let spec = pulse::sample::Spec {
        format:   pulse::sample::Format::FLOAT32NE,
        channels: CHANNELS,
        rate:     SAMPLE_RATE,
    };
    if !spec.is_valid() { return; }

    let stream = Simple::new(
        None,                       // default server
        "Sound Overlay",            // app name shown to the audio system
        pulse::stream::Direction::Record,
        Some("@DEFAULT_MONITOR@"),  // default output's monitor source
        "visualizer capture",
        &spec,
        None,
        None,
    );
    let stream = match stream { Ok(s) => s, Err(_) => return };

    let mut ring: Vec<f32> = Vec::with_capacity(FFT_SIZE * 4);
    let mut planner = rustfft::FftPlanner::<f32>::new();
    let mut raw = [0u8; 4096];
    let bytes_per_frame = 4 * CHANNELS as usize; // 4 bytes per f32 sample

    loop {
        // Always read, even when disabled — skipping it lets PulseAudio's
        // server-side buffer overrun, causing latency/glitches once
        // re-enabled. Only the FFT below is skipped when off, matching the
        // same "skip the expensive part, not the mandatory part" shape as
        // the Windows capture thread.
        if stream.read(&mut raw).is_err() { return; }

        let frames = raw.len() / bytes_per_frame;
        for i in 0..frames {
            let mut frame_sum = 0.0f32;
            for c in 0..CHANNELS as usize {
                let offset = (i * CHANNELS as usize + c) * 4;
                let sample = f32::from_le_bytes([raw[offset], raw[offset + 1], raw[offset + 2], raw[offset + 3]]);
                frame_sum += sample;
            }
            ring.push(frame_sum / CHANNELS as f32);
        }
        if ring.len() > FFT_SIZE * 4 {
            let drop = ring.len() - FFT_SIZE * 2;
            ring.drain(..drop);
        }

        if !enabled.load(Ordering::Relaxed) { continue; }
        if ring.len() < FFT_SIZE { continue; }

        let window = &ring[ring.len() - FFT_SIZE..];
        let bands = compute_bands(window, SAMPLE_RATE as f32, &mut planner, GAIN);
        let _ = handle.emit("audio-freq", &bands);
    }
}
