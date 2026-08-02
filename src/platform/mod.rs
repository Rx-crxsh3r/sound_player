// Each platform module exposes the same surface:
//   fn poll_media(last_title: &str) -> Result<MediaState, String>
//   fn media_play_pause() -> Result<(), String>
//   fn media_next() -> Result<(), String>
//   fn media_prev() -> Result<(), String>
//   fn spawn_audio_capture(handle: AppHandle, enabled: Arc<AtomicBool>)
// so src/main.rs never branches on OS itself — it just calls `platform::*`.

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;
