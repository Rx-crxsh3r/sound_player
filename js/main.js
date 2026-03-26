const { listen }                              = window.__TAURI__.event;
const { invoke }                              = window.__TAURI__.tauri;
const { appWindow, LogicalSize, PhysicalPosition } = window.__TAURI__.window;

// ── defaults (fallback if backend unreachable) ─────────────
const DEFAULTS = {
    theme:         'dark',
    activeOpacity: 85,
    idleOpacity:   50,
    accentColor:   '#1DB954',
    editMode:      false,
    offsetX:       0,
    offsetY:       0,    barX:          0,
    barY:          0,};

const BAR_HEIGHT     = 46;   // must match tauri.conf window height
const POPUP_HEIGHT   = 172;  // bar + popup together

// ── helpers ────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function setTheme(name) {
    const link = document.getElementById('theme-template');
    if (link) {
        const file = `css/templates/${name === 'light' ? 'light' : 'dark'}.css`;
        console.log(`[THEME] Applying theme: "${name}" -> ${file}`);
        link.href = file;
    }
}

// ── state ──────────────────────────────────────────────────
let settings   = { ...DEFAULTS };
let popupOpen  = false;

// ── click-through sync ────────────────────────────────────
// Bar must be interactive when popup is visible OR edit mode is on.
// Otherwise the window is fully click-through (the overlay state).
async function syncClickThrough() {
    const passThrough = !popupOpen && !settings.editMode;
    console.log(`[CLICK-THROUGH] popup:${popupOpen} editMode:${settings.editMode} → passThrough:${passThrough}`);
    try {
        await invoke('set_main_click_through', { passThrough });
    } catch (err) {
        console.warn('[CLICK-THROUGH] invoke failed:', err);
    }
}

// ── window height sync ─────────────────────────────────────
async function syncWindowHeight() {
    try {
        const w = (await appWindow.innerSize()).width / (await appWindow.scaleFactor());
        const targetH = popupOpen ? POPUP_HEIGHT : BAR_HEIGHT;
        console.log(`[WINDOW] syncWindowHeight — popup: ${popupOpen}, setting size to ${w}x${targetH}`);
        await appWindow.setSize(new LogicalSize(w, targetH));
        console.log(`[WINDOW] Window resized OK`);
    } catch (err) {
        console.warn('[WINDOW] syncWindowHeight failed:', err);
    }
}

// ── apply settings from any source ────────────────────────
async function applySettings(s) {
    console.log('[SETTINGS] applySettings called:', s);
    settings = { ...DEFAULTS, ...s };

    setTheme(settings.theme);

    const root = document.documentElement;
    root.style.setProperty('--bar-active-opacity', String(clamp(settings.activeOpacity, 10, 100) / 100));
    root.style.setProperty('--bar-idle-opacity',   String(clamp(settings.idleOpacity,   10, 100) / 100));
    root.style.setProperty('--popup-bg-opacity',   String(clamp(settings.activeOpacity, 10, 100) / 100));
    root.style.setProperty('--accent-color', settings.accentColor || DEFAULTS.accentColor);

    document.body.classList.toggle('edit-mode', Boolean(settings.editMode));
    console.log(`[SETTINGS] Applied — theme:${settings.theme} active-opacity:${settings.activeOpacity} accent:${settings.accentColor} editMode:${settings.editMode}`);

    // Sync click-through: interactive when popup open OR edit mode on
    await syncClickThrough();

    // Restore saved bar position
    if (typeof settings.barX === 'number' && typeof settings.barY === 'number') {
        try {
            await appWindow.setPosition(new PhysicalPosition(settings.barX, settings.barY));
            console.log(`[SETTINGS] Bar position applied: (${settings.barX}, ${settings.barY})`);
        } catch (err) {
            console.warn('[SETTINGS] Failed to set bar position:', err);
        }
    }

    const popup = document.getElementById('popup-box');
    if (popup) {
        popup.style.left = `${14 + clamp(settings.offsetX, 0, 80)}px`;
        popup.style.top  = `${50 + clamp(settings.offsetY, 0, 80)}px`;
    }
}

// ── popup visibility ───────────────────────────────────────
async function setPopup(visible) {
    console.log(`[POPUP] setPopup(${visible}) — current state: ${popupOpen}`);
    popupOpen = visible;
    const popup = document.getElementById('popup-box');
    if (popup) {
        popup.classList.toggle('hidden', !popupOpen);
        console.log(`[POPUP] popup-box classList: ${popup.className}`);
    } else {
        console.warn('[POPUP] popup-box element not found in DOM!');
    }
    await syncWindowHeight();
    await syncClickThrough();
    console.log(`[POPUP] setPopup done — popupOpen: ${popupOpen}`);
}

// ── media UI update ────────────────────────────────────────
function updateMedia(state) {
    console.log(`[MEDIA] updateMedia — status:'${state.status}' title:'${state.title}' artist:'${state.artist}'`);
    const bar          = document.getElementById('main-bar');
    const timeEl       = document.getElementById('track-time');
    const artEl        = document.getElementById('album-art');
    const titleEl      = document.getElementById('track-title');
    const artistEl     = document.getElementById('track-artist');
    const progressEl   = document.getElementById('progress-bar');

    if (state.status === 'playing') {
        bar.classList.replace('idle', 'playing') || bar.classList.add('playing');
        bar.classList.remove('idle');

        timeEl.textContent    = `${formatTime(state.current_time)} / ${formatTime(state.total_time)}`;
        titleEl.textContent   = state.title;
        artistEl.textContent  = state.artist;
        artEl.src             = state.album_art_url || '';

        const pct = state.total_time > 0
            ? clamp((state.current_time / state.total_time) * 100, 0, 100)
            : 0;
        progressEl.style.width = `${pct}%`;
    } else {
        bar.classList.remove('playing');
        bar.classList.add('idle');
        timeEl.textContent     = '--:-- / --:--';
        progressEl.style.width = '0%';
    }
}

// ── init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    console.log('[BOOT] main.js DOMContentLoaded — starting overlay init');

    // Load persisted settings from Rust/AppData
    console.log('[BOOT] Invoking load_overlay_settings...');
    try {
        const loaded = await invoke('load_overlay_settings');
        console.log('[BOOT] Settings loaded from backend:', loaded);
        await applySettings(loaded);
    } catch (err) {
        console.warn('[BOOT] load_overlay_settings failed, using defaults:', err);
        await applySettings(DEFAULTS);
    }

    // Start in bar-only height, idle state
    const bar = document.getElementById('main-bar');
    bar.classList.add('idle');
    console.log('[BOOT] Bar set to idle state');
    await setPopup(false);
    console.log('[BOOT] Popup initialized (hidden)');

    // ── event listeners ──────────────────────────────────
    // Settings updated from settings window
    listen('overlay-settings-updated', async (e) => {
        console.log('[EVENT] overlay-settings-updated received:', e.payload);
        await applySettings(e.payload);
    });
    console.log('[BOOT] Listening for overlay-settings-updated');

    // Toggle popup from bar_button window via Rust broadcast
    listen('overlay-toggle-popup', async () => {
        console.log(`[EVENT] overlay-toggle-popup received — toggling from ${popupOpen} to ${!popupOpen}`);
        await setPopup(!popupOpen);
    });
    console.log('[BOOT] Listening for overlay-toggle-popup');

    // Close popup button
    document.getElementById('close-popup-btn').addEventListener('click', async () => {
        console.log('[BTN] Close popup button clicked');
        await setPopup(false);
    });

    // Transport placeholders — brief feedback in artist text
    const artistEl = document.getElementById('track-artist');
    function transportFeedback(label) {
        const prev = artistEl.textContent;
        artistEl.textContent = label;
        setTimeout(() => { if (artistEl.textContent === label) artistEl.textContent = prev; }, 700);
    }
    document.getElementById('prev-btn').addEventListener('click',       () => { console.log('[BTN] Prev clicked'); transportFeedback('Previous…'); });
    document.getElementById('play-pause-btn').addEventListener('click', () => { console.log('[BTN] Play/Pause clicked'); transportFeedback('Play/Pause…'); });
    document.getElementById('next-btn').addEventListener('click',       () => { console.log('[BTN] Next clicked'); transportFeedback('Next…'); });

    // Edit-mode dragging — only the bar, only when edit mode is on
    document.getElementById('main-bar').addEventListener('mousedown', (e) => {
        if (!settings.editMode || e.button !== 0) return;
        if (e.target.closest('button')) return;
        console.log('[DRAG] Edit-mode drag started');
        appWindow.startDragging();
    });

    // Media updates from Rust mock loop
    listen('media-update', (e) => {
        console.log('[EVENT] media-update received:', e.payload);
        updateMedia(e.payload);
    });
    console.log('[BOOT] Listening for media-update');

    console.log('[BOOT] Overlay init complete');
});
