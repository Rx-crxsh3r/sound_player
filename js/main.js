const { listen, emit }                        = window.__TAURI__.event;
const { invoke }                              = window.__TAURI__.tauri;
const { appWindow, LogicalSize, PhysicalPosition } = window.__TAURI__.window;

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
};

const BAR_HEIGHT     = 54;   // must match tauri.conf window height
const POPUP_HEIGHT   = 208;  // bar + popup together

// ── helpers ────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function setTheme(name) {
    const link = document.getElementById('theme-template');
    if (link) link.href = `css/templates/${name === 'light' ? 'light' : 'dark'}.css`;
}

// ── state ──────────────────────────────────────────────────
let settings       = { ...DEFAULTS };
let popupOpen      = false;
let mediaState     = { status: 'idle', currentTime: 0, totalTime: 0 };
let tickerInterval = null;

// ── local time ticker ────────────────────────────────────
function stopTicker() {
    if (tickerInterval !== null) { clearInterval(tickerInterval); tickerInterval = null; }
}
function startTicker() {
    stopTicker();
    const timeEl     = document.getElementById('track-time');
    const progressEl = document.getElementById('progress-bar');
    tickerInterval = setInterval(() => {
        if (mediaState.status !== 'playing') return;
        mediaState.currentTime = Math.min(mediaState.currentTime + 1, mediaState.totalTime);
        if (timeEl)     timeEl.textContent     = `${formatTime(mediaState.currentTime)} / ${formatTime(mediaState.totalTime)}`;
        if (progressEl) progressEl.style.width = mediaState.totalTime > 0
            ? `${clamp((mediaState.currentTime / mediaState.totalTime) * 100, 0, 100)}%` : '0%';
    }, 1000);
}

// ── click-through sync ────────────────────────────────────
// Bar must be interactive when popup is visible OR edit mode is on.
// Otherwise the window is fully click-through (the overlay state).
async function syncClickThrough() {
    const passThrough = !popupOpen && !settings.editMode;
    try {
        await invoke('set_main_click_through', { passThrough });
    } catch (err) {
        console.warn('[CLICK-THROUGH] invoke failed:', err);
    }
}

// ── window height sync ─────────────────────────────────────
async function syncWindowHeight() {
    try {
        const w       = (await appWindow.innerSize()).width / (await appWindow.scaleFactor());
        const targetH = popupOpen ? POPUP_HEIGHT : BAR_HEIGHT;
        await appWindow.setSize(new LogicalSize(w, targetH));
    } catch (err) {
        console.warn('[WINDOW] syncWindowHeight failed:', err);
    }
}

// ── apply settings from any source ────────────────────────
async function applySettings(s) {
    settings = { ...DEFAULTS, ...s };

    setTheme(settings.theme);

    const root = document.documentElement;
    root.style.setProperty('--bar-active-opacity', String(clamp(settings.activeOpacity, 10, 100) / 100));
    root.style.setProperty('--bar-idle-opacity',   String(clamp(settings.idleOpacity,   10, 100) / 100));
    root.style.setProperty('--popup-bg-opacity',   String(clamp(settings.activeOpacity, 10, 100) / 100));
    root.style.setProperty('--accent-color', settings.accentColor || DEFAULTS.accentColor);

    document.body.classList.toggle('edit-mode', Boolean(settings.editMode));
    await syncClickThrough();

    if (typeof settings.barX === 'number' && typeof settings.barY === 'number') {
        try {
            await appWindow.setPosition(new PhysicalPosition(settings.barX, settings.barY));
        } catch (err) {
            console.warn('[SETTINGS] Failed to set bar position:', err);
        }
    }

    const popup = document.getElementById('popup-box');
    if (popup) {
        popup.style.left = `${14 + clamp(settings.offsetX, 0, 80)}px`;
        popup.style.top  = `${58 + clamp(settings.offsetY, 0, 80)}px`;
    }
}

// ── popup visibility ───────────────────────────────────────
async function setPopup(visible) {
    popupOpen = visible;
    const popup = document.getElementById('popup-box');
    if (popup) popup.classList.toggle('hidden', !popupOpen);
    await syncWindowHeight();
    await syncClickThrough();
    try { await emit('overlay-popup-changed', { open: popupOpen }); } catch (err) {
        console.warn('[POPUP] emit overlay-popup-changed failed:', err);
    }
}

// SVG markup for transport play/pause icon
const SVG_PAUSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="5" width="3" height="14" rx="1"/><rect x="15" y="5" width="3" height="14" rx="1"/></svg>';
const SVG_PLAY  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6,4 20,12 6,20"/></svg>';

// ── media UI update ────────────────────────────────────────
function updateMedia(state) {
    const bar          = document.getElementById('main-bar');
    const timeEl       = document.getElementById('track-time');
    const artEl        = document.getElementById('album-art');
    const titleEl      = document.getElementById('track-title');
    const artistEl     = document.getElementById('track-artist');
    const progressEl   = document.getElementById('progress-bar');
    const ppBtn        = document.getElementById('play-pause-btn');

    if (state.status === 'playing' || state.status === 'paused') {
        // Sync authoritative time from SMTC (corrects ticker drift)
        mediaState.status      = state.status;
        mediaState.currentTime = state.current_time;
        mediaState.totalTime   = state.total_time;

        bar.classList.toggle('playing', state.status === 'playing');
        bar.classList.toggle('idle',    state.status === 'paused');

        timeEl.textContent    = `${formatTime(state.current_time)} / ${formatTime(state.total_time)}`;
        titleEl.textContent   = state.title;
        artistEl.textContent  = state.artist;
        artEl.src             = state.album_art_url || '';

        const pct = state.total_time > 0
            ? clamp((state.current_time / state.total_time) * 100, 0, 100)
            : 0;
        progressEl.style.width = `${pct}%`;

        if (ppBtn) ppBtn.innerHTML = state.status === 'playing' ? SVG_PAUSE : SVG_PLAY;

        if (state.status === 'playing') startTicker(); else stopTicker();
    } else {
        mediaState = { status: 'idle', currentTime: 0, totalTime: 0 };
        stopTicker();

        bar.classList.remove('playing');
        bar.classList.add('idle');
        timeEl.textContent     = '--:-- / --:--';
        titleEl.textContent    = 'Track Title';
        artistEl.textContent   = 'Artist Name';
        artEl.src              = '';
        progressEl.style.width = '0%';
        if (ppBtn) ppBtn.innerHTML = SVG_PLAY;
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
    await setPopup(false);

    // ── event listeners ──────────────────────────────────
    // Settings updated from settings window
    listen('overlay-settings-updated', async (e) => {
        await applySettings(e.payload);
    });

    // Toggle popup from bar_button window via Rust broadcast
    listen('overlay-toggle-popup', async () => {
        await setPopup(!popupOpen);
    });

    // Close popup button
    document.getElementById('close-popup-btn').addEventListener('click', async () => {
        await setPopup(false);
    });

    // Transport controls
    document.getElementById('prev-btn').addEventListener('click', async () => {
        try { await invoke('media_prev'); } catch (err) { console.warn('[TRANSPORT] media_prev failed:', err); }
    });
    document.getElementById('play-pause-btn').addEventListener('click', async () => {
        try { await invoke('media_play_pause'); } catch (err) { console.warn('[TRANSPORT] media_play_pause failed:', err); }
    });
    document.getElementById('next-btn').addEventListener('click', async () => {
        try { await invoke('media_next'); } catch (err) { console.warn('[TRANSPORT] media_next failed:', err); }
    });

    // Edit-mode dragging
    document.getElementById('main-bar').addEventListener('mousedown', (e) => {
        if (!settings.editMode || e.button !== 0) return;
        if (e.target.closest('button')) return;
        appWindow.startDragging();
    });

    listen('media-update', (e) => { updateMedia(e.payload); });

    // ── Audio frequency visualizer ──────────────────────────
    // Bar elements cached once. barTarget receives raw FFT data; barCurrent
    // lerps toward it every rAF tick for smooth animation.
    const freqLine   = document.getElementById('animated-line');
    const freqBars   = freqLine ? [...freqLine.querySelectorAll('.bar')] : [];
    const barCurrent = new Float32Array(24).fill(0.08);
    const barTarget  = new Float32Array(24).fill(0.08);
    let   rafId             = null;
    let   freqActive        = false;
    let   freqFallbackTimer = null;

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
            // All bars settled at idle floor — hand control back to CSS animation.
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

    listen('audio-freq', (e) => {
        if (!freqLine || freqBars.length === 0) return;
        const bands = e.payload; // [f32; 24]
        bands.forEach((v, i) => { if (i < barTarget.length) barTarget[i] = v; });

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
