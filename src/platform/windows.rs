// Windows implementation: media info via SMTC (System Media Transport
// Controls), audio capture via WASAPI loopback.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tauri::{AppHandle, Manager};
use windows::{
    Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as SmtcManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
    },
    Storage::Streams::DataReader,
};

use crate::audio_analysis::compute_bands;
use crate::{detect_image_mime, MediaState};

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

// ── Transport commands ─────────────────────────────────────
pub fn media_play_pause() -> Result<(), String> {
    get_smtc_session()?.TryTogglePlayPauseAsync().map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn media_next() -> Result<(), String> {
    get_smtc_session()?.TrySkipNextAsync().map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn media_prev() -> Result<(), String> {
    get_smtc_session()?.TrySkipPreviousAsync().map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    Ok(())
}

// Windows FILETIME / WinRT DateTime epoch is 1601-01-01, in 100ns ticks.
// Unix epoch (1970-01-01) is this many seconds after that.
const WINDOWS_EPOCH_OFFSET_100NS: i64 = 11_644_473_600 * 10_000_000;

fn windows_now_ticks() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    (dur.as_nanos() / 100) as i64 + WINDOWS_EPOCH_OFFSET_100NS
}

pub fn poll_media(last_title: &str) -> Result<MediaState, String> {
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

    let mime = detect_image_mime(&buf);
    Ok(format!("data:{};base64,{}", mime, B64.encode(&buf)))
}

// ── Audio frequency capture ───────────────────────────────
// Captures WASAPI loopback (system audio output), runs an FFT every ~33 ms,
// and emits an `audio-freq` event with 24 normalised band values (0.0–1.0).
// The frontend uses these to drive the EQ bar animation.
pub fn spawn_audio_capture(handle: AppHandle, enabled: Arc<AtomicBool>) {
    std::thread::spawn(move || audio_loop(handle, enabled));
}

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
