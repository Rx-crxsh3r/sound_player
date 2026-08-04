const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

const SYNC_DRIFT_TOLERANCE = 1.5; // seconds — see updateMedia(), same tolerance as main.js/popup.js

let mediaState = { status: 'idle', currentTime: 0, totalTime: 0 };
let tickerInterval = null;

let cues             = [];   // [{ start, end, text, style, fadeMs }, ...] sorted ascending by start
let currentCueIndex  = -1;
let lastCueKey       = '';   // "title|artist" of the track cues were fetched for
let customLyricsEnabled = false;

// ── local time ticker (mirrors main.js/popup.js) ────────────
function stopTicker() {
    if (tickerInterval !== null) { clearInterval(tickerInterval); tickerInterval = null; }
}
function startTicker() {
    stopTicker();
    tickerInterval = setInterval(() => {
        if (mediaState.status !== 'playing') return;
        mediaState.currentTime = Math.min(mediaState.currentTime + 1, mediaState.totalTime);
        updateCueForTime(mediaState.currentTime);
    }, 1000);
}

// ── cue lookup + render ──────────────────────────────────────
// Unlike the LRC-based bar/popup lyrics (which always show the last line
// until the next one starts), .clyr cues have explicit start/end times —
// gaps between cues are valid and nothing should render during them.
function findActiveCueIndex(t) {
    for (let i = 0; i < cues.length; i++) {
        if (cues[i].start <= t && t < cues[i].end) return i;
        if (cues[i].start > t) break; // sorted ascending — no match beyond this point
    }
    return -1;
}

function updateCueForTime(t) {
    const idx = findActiveCueIndex(t);
    if (idx === currentCueIndex) return; // change-gated, same pattern as updateBarLyricsForTime
    currentCueIndex = idx;
    renderCue(idx);
}

function renderCue(idx) {
    const el = document.getElementById('cue');
    if (!el) return;

    if (idx === -1 || !cues[idx]) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }

    const cue   = cues[idx];
    const style = cue.style;

    // textContent only — never innerHTML — categorically prevents
    // HTML/script injection from an uploaded .clyr file regardless of its
    // contents. Style fields are individual CSSOM property assignments,
    // never style.cssText: cssText parses as a semicolon-delimited
    // declaration LIST, so an unvalidated value containing ';' could
    // inject unrelated declarations that way, whereas a per-property
    // setter only ever accepts a value for that one property.
    el.textContent       = cue.text;
    el.style.left         = `${style.posX}%`;
    el.style.top          = `${style.posY}%`;
    el.style.fontFamily   = style.font;
    el.style.fontSize     = style.size;
    el.style.color        = style.color;
    el.style.fontWeight   = style.bold ? '700' : '400';
    el.style.fontStyle    = style.italic ? 'italic' : 'normal';
    el.style.textAlign    = style.align;
    el.classList.remove('hidden');
}

function clearCues() {
    cues = [];
    currentCueIndex = -1;
    renderCue(-1);
}

async function fetchCuesForCurrentTrack(title, artist) {
    clearCues();
    if (!customLyricsEnabled) return;

    try {
        const entry = await invoke('find_custom_lyrics_for_track', { title, artist });
        if (entry && entry.cues && entry.cues.length > 0) {
            cues = entry.cues;
            updateCueForTime(mediaState.currentTime);
        }
    } catch (err) {
        console.warn('[CUSTOM-LYRICS] find_custom_lyrics_for_track failed:', err);
    }
}

// ── media-update handling (mirrors main.js/popup.js updateMedia) ────
function updateMedia(state) {
    if (state.status === 'playing' || state.status === 'paused') {
        mediaState.status    = state.status;
        mediaState.totalTime = state.total_time;

        const key        = `${state.title}|${state.artist}`;
        const isNewTrack  = key !== lastCueKey;

        const drift = Math.abs(mediaState.currentTime - state.current_time);
        if (isNewTrack || (state.position_live && drift > SYNC_DRIFT_TOLERANCE)) {
            mediaState.currentTime = state.current_time;
        }

        if (state.status === 'playing') { if (tickerInterval === null) startTicker(); }
        else { stopTicker(); }

        if (isNewTrack) {
            lastCueKey = key;
            // has_custom_lyrics is computed once in Rust's media_loop
            // (single source of truth, shared with main.js/popup.js's
            // gating of their own lrclib fetch) — this window only needs
            // to fetch the actual cues when it's true.
            if (state.has_custom_lyrics) {
                fetchCuesForCurrentTrack(state.title, state.artist);
            } else {
                clearCues();
            }
        } else {
            updateCueForTime(mediaState.currentTime);
        }
    } else {
        mediaState = { status: 'idle', currentTime: 0, totalTime: 0 };
        stopTicker();
        lastCueKey = '';
        clearCues();
    }
}

// ── init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    try {
        const loaded = await invoke('load_overlay_settings');
        customLyricsEnabled = Boolean(loaded && loaded.customLyricsEnabled);
    } catch (err) {
        console.warn('[CUSTOM-LYRICS] load_overlay_settings failed:', err);
    }

    listen('overlay-settings-updated', (e) => {
        customLyricsEnabled = Boolean(e.payload && e.payload.customLyricsEnabled);
        if (!customLyricsEnabled) clearCues();
    });

    listen('media-update', (e) => { updateMedia(e.payload); });
});
