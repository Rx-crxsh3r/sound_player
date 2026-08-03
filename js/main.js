const { listen }                                    = window.__TAURI__.event;
const { invoke }                                    = window.__TAURI__.core;
const { getCurrentWindow, LogicalSize, PhysicalPosition } = window.__TAURI__.window;
const appWindow = getCurrentWindow();

// ── defaults (fallback if backend unreachable) ─────────────
const DEFAULTS = {
    theme:               'dark',
    activeOpacity:       85,
    idleOpacity:         50,
    accentColor:         '#1DB954',
    editMode:            false,
    offsetX:             0,
    offsetY:             0,
    barX:                0,
    barY:                0,
    visualizerGain:      1.0,
    visualizerSmoothing: 0.20,
    visualizerEnabled:   true,
    visualizerBands:     24,
    lyricsEnabled:       false,
    lyricsDisplayMode:   'popup',
};

const BAR_HEIGHT             = 54;  // must match tauri.conf window height
const BAR_LYRIC_STRIP_HEIGHT = 30;  // extra height when bar-mode lyrics are visible
const SYNC_DRIFT_TOLERANCE   = 1.5; // seconds — see updateMedia()

// ── helpers ────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds) % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function setTheme(name) {
    const link = document.getElementById('theme-template');
    if (link) link.href = `css/templates/${name === 'light' ? 'light' : 'dark'}.css`;
}

// ── state ──────────────────────────────────────────────────
let settings       = { ...DEFAULTS };
let mediaState     = { status: 'idle', currentTime: 0, totalTime: 0 };
let tickerInterval = null;

// ── visualizer state (module scope so applySettings can access) ────
let freqLine          = null;
let freqBars          = [];
let barCurrent        = new Float32Array(0);
let barTarget         = new Float32Array(0);
let rafId             = null;
let freqActive        = false;
let freqFallbackTimer = null;

const RUST_BANDS     = 24;
const MAX_ANIM_DELAY = 0.60;

// ── bar-mode lyrics state ────────────────────────────────────────
// Only active when settings.lyricsDisplayMode === 'bar' — shown alongside
// the visualizer (independent settings, not exclusive). The popup's own
// richer 5-line lyrics panel lives entirely in js/popup.js, which gates its
// fetch on the opposite mode so the two windows never both query
// lrclib.net for the same track.
let barLyricsLines   = [];
let barLyricsIndex   = -1;
let lastBarLyricsKey = '';

function rebuildBars(n) {
    if (!freqLine) return;
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    clearTimeout(freqFallbackTimer);
    freqActive = false;
    freqLine.classList.remove('live');
    freqLine.innerHTML = '';
    for (let i = 0; i < n; i++) {
        const bar = document.createElement('div');
        bar.className = 'bar';
        const pos   = n > 1 ? i / (n - 1) : 0.5;
        const dist  = Math.abs(pos - 0.5) * 2;
        bar.style.animationDelay = `${((1 - dist) * MAX_ANIM_DELAY).toFixed(2)}s`;
        freqLine.appendChild(bar);
    }
    freqBars   = [...freqLine.children];
    barCurrent = new Float32Array(n).fill(0.08);
    barTarget  = new Float32Array(n).fill(0.08);
}

function freqTick() {
    const smooth   = settings.visualizerSmoothing ?? 0.20;
    const gain     = settings.visualizerGain      ?? 1.0;
    const lerpRate = 1 - smooth;
    let   settled  = true;

    for (let i = 0; i < freqBars.length; i++) {
        const t = Math.min(1.0, Math.max(0.08, barTarget[i] * gain));
        barCurrent[i] += (t - barCurrent[i]) * lerpRate;
        if (freqBars[i]) freqBars[i].style.transform = `scaleY(${barCurrent[i].toFixed(3)})`;
        if (Math.abs(t - barCurrent[i]) > 0.004) settled = false;
    }

    if (settled && !freqActive) {
        rafId = null;
        freqLine.classList.remove('live');
        freqBars.forEach(b => { b.style.transform = ''; });
    } else {
        rafId = requestAnimationFrame(freqTick);
    }
}

function startFreqLoop() {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(freqTick);
}

// ── bar-mode lyrics ──────────────────────────────────────────
function updateBarLyricsForTime(t) {
    if (barLyricsLines.length === 0) return;
    let idx = -1;
    for (let i = 0; i < barLyricsLines.length; i++) {
        if (barLyricsLines[i].time <= t) idx = i; else break;
    }
    if (idx !== barLyricsIndex) {
        barLyricsIndex = idx;
        const lineEl = document.getElementById('bar-lyric-line');
        if (lineEl) lineEl.textContent = barLyricsLines[idx] ? barLyricsLines[idx].text : '';
    }
}

async function hideBarLyrics() {
    barLyricsLines = [];
    barLyricsIndex = -1;
    const bar    = document.getElementById('main-bar');
    const lineEl = document.getElementById('bar-lyric-line');
    if (bar)    bar.classList.remove('showing-bar-lyric');
    if (lineEl) lineEl.textContent = '';
    await syncBarHeight();
}

async function fetchBarLyrics(title, artist, durationSecs) {
    await hideBarLyrics();
    if (settings.lyricsDisplayMode !== 'bar' || !settings.lyricsEnabled) return;

    try {
        const res = await invoke('fetch_lyrics', { title, artist, durationSecs });
        if (res && res.available && res.lines && res.lines.length > 0) {
            barLyricsLines = res.lines;
            const bar = document.getElementById('main-bar');
            if (bar) bar.classList.add('showing-bar-lyric');
            updateBarLyricsForTime(mediaState.currentTime);
            await syncBarHeight();
        }
    } catch (err) {
        console.warn('[BAR-LYRICS] fetch_lyrics failed:', err);
    }
}

// ── local time ticker (drives #track-time in the bar) ───────
function stopTicker() {
    if (tickerInterval !== null) { clearInterval(tickerInterval); tickerInterval = null; }
}
function startTicker() {
    stopTicker();
    const timeEl = document.getElementById('track-time');
    tickerInterval = setInterval(() => {
        if (mediaState.status !== 'playing') return;
        mediaState.currentTime = Math.min(mediaState.currentTime + 1, mediaState.totalTime);
        if (timeEl) timeEl.textContent = `${formatTime(mediaState.currentTime)} / ${formatTime(mediaState.totalTime)}`;
        updateBarLyricsForTime(mediaState.currentTime);
    }, 1000);
}

// ── click-through sync ────────────────────────────────────
// The popup lives in its own separate window now (js/popup.js) and never
// affects this window's click-through state — only edit-mode dragging does.
async function syncClickThrough() {
    const passThrough = !settings.editMode;
    try {
        await invoke('set_main_click_through', { passThrough });
    } catch (err) {
        console.warn('[CLICK-THROUGH] invoke failed:', err);
    }
}

// ── bar window height sync ──────────────────────────────────
// Only grows for the bar-mode lyrics strip now — the popup resizes itself
// independently in js/popup.js.
async function syncBarHeight() {
    try {
        const w = (await appWindow.innerSize()).width / (await appWindow.scaleFactor());
        const barLyricsVisible = settings.lyricsDisplayMode === 'bar' && barLyricsLines.length > 0;
        const targetH = BAR_HEIGHT + (barLyricsVisible ? BAR_LYRIC_STRIP_HEIGHT : 0);
        await appWindow.setSize(new LogicalSize(w, targetH));
    } catch (err) {
        console.warn('[WINDOW] syncBarHeight failed:', err);
    }
}

// ── apply settings from any source ────────────────────────
async function applySettings(s) {
    settings = { ...DEFAULTS, ...s };

    setTheme(settings.theme);

    const root = document.documentElement;
    root.style.setProperty('--bar-active-opacity', String(clamp(settings.activeOpacity, 10, 100) / 100));
    root.style.setProperty('--bar-idle-opacity',   String(clamp(settings.idleOpacity,   10, 100) / 100));
    root.style.setProperty('--accent-color', settings.accentColor || DEFAULTS.accentColor);

    document.body.classList.toggle('edit-mode', Boolean(settings.editMode));

    // Rebuild bars if band count changed
    const newBandCount = Math.max(1, settings.visualizerBands || 24);
    if (freqLine && newBandCount !== freqBars.length) rebuildBars(newBandCount);

    // Visualizer enable/disable — .viz-off actually hides the EQ bars.
    // Previously disabling only stopped feeding them real audio data, so
    // they kept looping the default (non-reactive) idle bounce animation
    // forever instead of disappearing, which read as a broken/changed
    // visualizer pattern rather than an off one.
    const vizEnabled = settings.visualizerEnabled !== false;
    document.getElementById('main-bar').classList.toggle('viz-off', !vizEnabled);
    try { await invoke('set_visualizer_enabled', { enabled: vizEnabled }); } catch (_) {}
    if (!vizEnabled && rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
        if (freqLine) {
            freqLine.classList.remove('live');
            freqBars.forEach(b => { b.style.transform = ''; });
        }
    }

    // Bar-mode lyrics disabled (or switched to popup mode) — drop them
    // immediately rather than waiting for the next track change.
    if ((settings.lyricsDisplayMode !== 'bar' || !settings.lyricsEnabled) && barLyricsLines.length > 0) {
        await hideBarLyrics();
    }

    await syncClickThrough();

    if (typeof settings.barX === 'number' && typeof settings.barY === 'number') {
        try {
            await appWindow.setPosition(new PhysicalPosition(settings.barX, settings.barY));
        } catch (err) {
            console.warn('[SETTINGS] Failed to set bar position:', err);
        }
    }
}

// ── media UI update (bar-only: idle/playing state, #track-time) ────
// Album art, title/artist, progress, transport, and the popup's own
// lyrics panel are handled independently by js/popup.js now.
function updateMedia(state) {
    const bar    = document.getElementById('main-bar');
    const timeEl = document.getElementById('track-time');

    if (state.status === 'playing' || state.status === 'paused') {
        mediaState.status    = state.status;
        mediaState.totalTime = state.total_time;

        const lyricsKey  = `${state.title}|${state.artist}`;
        const isNewTrack = lyricsKey !== lastBarLyricsKey;

        // Lyrics timing uses mediaState.currentTime, hard-corrected against
        // the backend's reported position only when the backend says that
        // position is freshly-anchored (position_live) AND it disagrees by
        // more than a beat — or this is a new track. Browser-tab sources in
        // particular only push real position updates occasionally (worse
        // once the tab is backgrounded, e.g. because the user tabbed away
        // to a game — its own reporting timer gets throttled), so the
        // backend is often extrapolating from an old checkpoint; trusting
        // that extrapolation more than our own steadily-ticking local clock
        // is what caused lyrics to drift back out of sync after a while.
        // The displayed clock below always shows the backend's raw value
        // regardless, so it's never wrong for long either way.
        const drift = Math.abs(mediaState.currentTime - state.current_time);
        if (isNewTrack || (state.position_live && drift > SYNC_DRIFT_TOLERANCE)) {
            mediaState.currentTime = state.current_time;
        }

        bar.classList.toggle('playing', state.status === 'playing');
        bar.classList.toggle('idle',    state.status === 'paused');
        timeEl.textContent = `${formatTime(state.current_time)} / ${formatTime(state.total_time)}`;

        // media-update now arrives every second while playing (needed to
        // keep current_time fresh) — only (re)start the ticker on an actual
        // playing transition. Restarting it every call would tear down and
        // rebuild the interval before it ever fires, freezing local time.
        if (state.status === 'playing') { if (tickerInterval === null) startTicker(); }
        else { stopTicker(); }

        // New track — (re)fetch bar-mode lyrics. Status-only changes
        // (play/pause on the same track) don't trigger a refetch.
        if (isNewTrack) {
            lastBarLyricsKey = lyricsKey;
            fetchBarLyrics(state.title, state.artist, state.total_time);
        } else {
            updateBarLyricsForTime(mediaState.currentTime);
        }
    } else {
        mediaState = { status: 'idle', currentTime: 0, totalTime: 0 };
        stopTicker();
        lastBarLyricsKey = '';
        hideBarLyrics();

        bar.classList.remove('playing');
        bar.classList.add('idle');
        timeEl.textContent = '--:-- / --:--';
    }
}

// ── init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    try {
        const loaded = await invoke('load_overlay_settings');
        await applySettings(loaded);
    } catch (err) {
        console.warn('[BOOT] load_overlay_settings failed, using defaults:', err);
        await applySettings(DEFAULTS);
    }

    // Start in bar-only height, idle state
    const bar = document.getElementById('main-bar');
    bar.classList.add('idle');
    await syncBarHeight();

    // ── event listeners ──────────────────────────────────
    // Settings updated from settings window
    listen('overlay-settings-updated', async (e) => {
        await applySettings(e.payload);
    });

    // Edit-mode dragging
    document.getElementById('main-bar').addEventListener('mousedown', (e) => {
        if (!settings.editMode || e.button !== 0) return;
        appWindow.startDragging();
    });

    listen('media-update', (e) => { updateMedia(e.payload); });

    // ── Audio frequency visualizer ──────────────────────────
    freqLine = document.getElementById('animated-line');
    rebuildBars(settings.visualizerBands || 24);

    listen('audio-freq', (e) => {
        if (!freqLine || freqBars.length === 0) return;
        const n   = freqBars.length;
        const raw = e.payload; // always RUST_BANDS values from Rust

        // Map RUST_BANDS Rust bands → n display bars by averaging.
        for (let i = 0; i < n; i++) {
            const lo = Math.floor(i * RUST_BANDS / n);
            const hi = Math.min(RUST_BANDS, Math.max(lo + 1, Math.floor((i + 1) * RUST_BANDS / n)));
            let sum = 0;
            for (let j = lo; j < hi; j++) sum += raw[j] || 0;
            barTarget[i] = sum / (hi - lo);
        }

        freqActive = true;
        if (!freqLine.classList.contains('live')) freqLine.classList.add('live');
        startFreqLoop();

        // No new data for 1.5 s — push targets to idle floor and let loop settle.
        clearTimeout(freqFallbackTimer);
        freqFallbackTimer = setTimeout(() => {
            freqActive = false;
            for (let i = 0; i < barTarget.length; i++) barTarget[i] = 0.08;
            startFreqLoop();
        }, 1500);
    });
});
