const { listen }  = window.__TAURI__.event;
const { invoke }  = window.__TAURI__.tauri;
const { appWindow, LogicalSize } = window.__TAURI__.window;

// ── defaults (fallback if backend unreachable) ─────────────
const DEFAULTS = {
    theme:              'dark',
    activeOpacity:      85,
    accentColor:        '#1DB954',
    lyricsEnabled:      false,
    lyricsDisplayMode:  'popup',
};

const SYNC_DRIFT_TOLERANCE = 1.5; // seconds — see updateMedia()

let settings   = { ...DEFAULTS };
let mediaState = { status: 'idle', currentTime: 0, totalTime: 0 };
let tickerInterval = null;

// ── lyrics state ─────────────────────────────────────────────────
let lyricsLines   = [];   // [{ time, text }, ...] sorted ascending
let lyricsIndex   = -1;
let lastLyricsKey = '';   // "title|artist" of the track lyrics were fetched for

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds) % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

// This window has its own isolated document, so theme/accent/opacity vars
// set on the bar's document don't apply here — reapply them independently.
function applyTheme(s) {
    const link = document.getElementById('theme-template');
    if (link) link.href = `css/templates/${s.theme === 'light' ? 'light' : 'dark'}.css`;
    const root = document.documentElement;
    root.style.setProperty('--accent-color', s.accentColor || DEFAULTS.accentColor);
    root.style.setProperty('--popup-bg-opacity', String(clamp(s.activeOpacity, 10, 100) / 100));
}

// Resizes this window to fit its own content — replaces the old hardcoded
// POPUP_HEIGHT/LYRICS_PANEL_HEIGHT constants; handles the lyrics-panel
// visible/hidden height difference automatically.
async function resizeToContent() {
    try {
        const box = document.getElementById('popup-box');
        if (!box) return;
        await appWindow.setSize(new LogicalSize(290, box.scrollHeight));
    } catch (err) {
        console.warn('[POPUP] resizeToContent failed:', err);
    }
}

// Falls back to the CSS placeholder icon when no art is available (common —
// many SMTC sources don't expose one).
function setAlbumArt(el, url) {
    if (!el) return;
    if (url) {
        el.style.backgroundImage = `url("${url}")`;
        el.classList.add('has-art');
    } else {
        el.style.backgroundImage = '';
        el.classList.remove('has-art');
    }
}

// ── lyrics ─────────────────────────────────────────────────
// Fixed 5-slot window (2 before, current, 2 after). Only textContent is
// touched, and only when the active line actually changes.
function renderLyricsWindow() {
    const panel = document.getElementById('lyrics-panel');
    if (!panel) return;
    const slots = panel.querySelectorAll('.lyrics-line');
    const mid   = Math.floor(slots.length / 2);
    for (let i = 0; i < slots.length; i++) {
        const line = lyricsLines[lyricsIndex - mid + i];
        slots[i].textContent = line ? line.text : '';
    }
}

function updateLyricsForTime(t) {
    if (lyricsLines.length === 0) return;
    let idx = -1;
    for (let i = 0; i < lyricsLines.length; i++) {
        if (lyricsLines[i].time <= t) idx = i; else break;
    }
    if (idx !== lyricsIndex) {
        lyricsIndex = idx;
        renderLyricsWindow();
    }
}

async function hideLyricsPanel() {
    lyricsLines = [];
    lyricsIndex = -1;
    const panel = document.getElementById('lyrics-panel');
    if (panel) panel.classList.add('hidden');
    renderLyricsWindow();
    await resizeToContent();
}

async function fetchLyricsForCurrentTrack(title, artist, durationSecs) {
    await hideLyricsPanel();
    // Only the "Popup" display mode owns this panel — in "Bar" mode the
    // bar window (js/main.js) fetches and shows the current line instead,
    // so we skip the network call entirely here to avoid double-querying.
    if (settings.lyricsDisplayMode !== 'popup' || !settings.lyricsEnabled) return;

    try {
        const res = await invoke('fetch_lyrics', { title, artist, durationSecs });
        if (res && res.available && res.lines && res.lines.length > 0) {
            lyricsLines = res.lines;
            const panel = document.getElementById('lyrics-panel');
            if (panel) panel.classList.remove('hidden');
            updateLyricsForTime(mediaState.currentTime);
            await resizeToContent();
        }
    } catch (err) {
        console.warn('[POPUP] fetch_lyrics failed:', err);
    }
}

// ── local time ticker ────────────────────────────────────
function stopTicker() {
    if (tickerInterval !== null) { clearInterval(tickerInterval); tickerInterval = null; }
}
function startTicker() {
    stopTicker();
    const progressEl = document.getElementById('progress-bar');
    tickerInterval = setInterval(() => {
        if (mediaState.status !== 'playing') return;
        mediaState.currentTime = Math.min(mediaState.currentTime + 1, mediaState.totalTime);
        if (progressEl) progressEl.style.width = mediaState.totalTime > 0
            ? `${clamp((mediaState.currentTime / mediaState.totalTime) * 100, 0, 100)}%` : '0%';
        updateLyricsForTime(mediaState.currentTime);
    }, 1000);
}

// SVG markup for transport play/pause icon
const SVG_PAUSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="5" width="3" height="14" rx="1"/><rect x="15" y="5" width="3" height="14" rx="1"/></svg>';
const SVG_PLAY  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6,4 20,12 6,20"/></svg>';

async function updateMedia(state) {
    const artEl      = document.getElementById('album-art');
    const titleEl    = document.getElementById('track-title');
    const artistEl   = document.getElementById('track-artist');
    const progressEl = document.getElementById('progress-bar');
    const ppBtn      = document.getElementById('play-pause-btn');

    if (state.status === 'playing' || state.status === 'paused') {
        mediaState.status    = state.status;
        mediaState.totalTime = state.total_time;

        const lyricsKey  = `${state.title}|${state.artist}`;
        const isNewTrack = lyricsKey !== lastLyricsKey;

        // Lyrics timing uses mediaState.currentTime, hard-corrected against
        // the backend's reported position only when the backend says that
        // position is freshly-anchored (position_live) AND it disagrees by
        // more than a beat — or this is a new track. Browser-tab sources in
        // particular only push real position updates occasionally (worse
        // once backgrounded, e.g. tabbing away to a game throttles the
        // site's own reporting timer), so the backend is often
        // extrapolating from an old checkpoint; trusting that more than our
        // own steadily-ticking local clock is what caused lyrics to drift
        // back out of sync after a while. The progress bar below always
        // uses the backend's raw value regardless, so it's never wrong for
        // long either way.
        const drift = Math.abs(mediaState.currentTime - state.current_time);
        if (isNewTrack || (state.position_live && drift > SYNC_DRIFT_TOLERANCE)) {
            mediaState.currentTime = state.current_time;
        }

        titleEl.textContent  = state.title;
        artistEl.textContent = state.artist;
        setAlbumArt(artEl, state.album_art_url);

        const pct = state.total_time > 0
            ? clamp((state.current_time / state.total_time) * 100, 0, 100)
            : 0;
        progressEl.style.width = `${pct}%`;

        if (ppBtn) ppBtn.innerHTML = state.status === 'playing' ? SVG_PAUSE : SVG_PLAY;

        // media-update now arrives every second while playing (needed to
        // keep current_time fresh) — only (re)start the ticker on an actual
        // playing transition. Restarting it every call would tear down and
        // rebuild the interval before it ever fires, freezing local time.
        if (state.status === 'playing') { if (tickerInterval === null) startTicker(); }
        else { stopTicker(); }

        // New track — (re)fetch lyrics. Status-only changes (play/pause on
        // the same track) don't trigger a refetch.
        if (isNewTrack) {
            lastLyricsKey = lyricsKey;
            await fetchLyricsForCurrentTrack(state.title, state.artist, state.total_time);
        } else {
            updateLyricsForTime(mediaState.currentTime);
        }
    } else {
        mediaState = { status: 'idle', currentTime: 0, totalTime: 0 };
        stopTicker();
        lastLyricsKey = '';
        await hideLyricsPanel();

        titleEl.textContent    = 'Track Title';
        artistEl.textContent   = 'Artist Name';
        setAlbumArt(artEl, '');
        progressEl.style.width = '0%';
        if (ppBtn) ppBtn.innerHTML = SVG_PLAY;
    }

    await resizeToContent();
}

// ── init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    try {
        const loaded = await invoke('load_overlay_settings');
        settings = { ...DEFAULTS, ...loaded };
    } catch (err) {
        console.warn('[POPUP] load_overlay_settings failed, using defaults:', err);
    }
    applyTheme(settings);
    await resizeToContent();

    listen('overlay-settings-updated', async (e) => {
        settings = { ...DEFAULTS, ...e.payload };
        applyTheme(settings);
        if (settings.lyricsDisplayMode !== 'popup' || !settings.lyricsEnabled) {
            await hideLyricsPanel();
        }
    });

    listen('media-update', (e) => { updateMedia(e.payload); });

    document.getElementById('close-popup-btn').addEventListener('click', async () => {
        try { await invoke('close_popup_window'); } catch (err) { console.warn('[POPUP] close_popup_window failed:', err); }
    });

    document.getElementById('prev-btn').addEventListener('click', async () => {
        try { await invoke('media_prev'); } catch (err) { console.warn('[TRANSPORT] media_prev failed:', err); }
    });
    document.getElementById('play-pause-btn').addEventListener('click', async () => {
        try { await invoke('media_play_pause'); } catch (err) { console.warn('[TRANSPORT] media_play_pause failed:', err); }
    });
    document.getElementById('next-btn').addEventListener('click', async () => {
        try { await invoke('media_next'); } catch (err) { console.warn('[TRANSPORT] media_next failed:', err); }
    });
});
