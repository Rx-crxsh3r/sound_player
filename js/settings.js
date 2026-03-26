const { invoke } = window.__TAURI__.tauri;

// ── Defaults (must match Rust OverlaySettings default) ────
const DEFAULTS = {
    theme:         'dark',
    activeOpacity: 85,
    idleOpacity:   50,
    accentColor:   '#1DB954',
    editMode:      false,
    offsetX:       0,
    offsetY:       0,
    barX:          0,
    barY:          0,
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Theme link helper ──────────────────────────────────────
function applyThemeLink(name) {
    const link = document.getElementById('theme-template');
    if (link) link.href = `css/templates/${name === 'light' ? 'light' : 'dark'}.css`;
}

// ── Tab navigation ─────────────────────────────────────────
function initTabs() {
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            if (tab.classList.contains('placeholder')) {
                console.log(`[TABS] Tab '${tab.dataset.tab}' is a placeholder — ignoring click`);
                return;
            }
            console.log(`[TABS] Switching to tab: ${tab.dataset.tab}`);
            document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.settings-tab-view').forEach(v => v.classList.remove('active'));

            tab.classList.add('active');
            const view = document.getElementById(`view-${tab.dataset.tab}`);
            if (view) {
                view.classList.add('active');
                console.log(`[TABS] View #view-${tab.dataset.tab} activated`);
            } else {
                console.warn(`[TABS] No view found for tab '${tab.dataset.tab}'`);
            }
        });
    });
}

// ── Populate UI from a settings object ────────────────────
function populateUI(s) {
    console.log('[UI] populateUI called:', s);
    document.getElementById('theme-select').value          = s.theme;
    document.getElementById('active-opacity').value        = String(s.activeOpacity);
    document.getElementById('idle-opacity').value          = String(s.idleOpacity);
    document.getElementById('accent-color-picker').value   = s.accentColor;
    document.getElementById('edit-mode-toggle').checked    = s.editMode;
    document.getElementById('offset-x').value              = String(s.offsetX);
    document.getElementById('offset-y').value              = String(s.offsetY);

    document.getElementById('active-opacity-value').textContent = `${s.activeOpacity}%`;
    document.getElementById('idle-opacity-value').textContent   = `${s.idleOpacity}%`;
    document.getElementById('accent-hex-label').textContent     = `${s.accentColor}`;

    applyThemeLink(s.theme);
    console.log('[UI] populateUI done');
}

// ── Read current UI values into an object ─────────────────
function readUI() {
    const result = {
        theme:         document.getElementById('theme-select').value,
        activeOpacity: clamp(Number(document.getElementById('active-opacity').value), 10, 100),
        idleOpacity:   clamp(Number(document.getElementById('idle-opacity').value),   10, 100),
        accentColor:   document.getElementById('accent-color-picker').value,
        editMode:      document.getElementById('edit-mode-toggle').checked,
        offsetX:       clamp(Number(document.getElementById('offset-x').value), 0, 80),
        offsetY:       clamp(Number(document.getElementById('offset-y').value), 0, 80),
    };
    console.log('[UI] readUI result:', result);
    return result;
}

// ── Live readout update while sliders move ─────────────────
function liveUpdate() {
    const activeVal = document.getElementById('active-opacity').value;
    const idleVal   = document.getElementById('idle-opacity').value;
    const hexVal    = document.getElementById('accent-color-picker').value;
    console.log(`[UI] liveUpdate — active:${activeVal}% idle:${idleVal}% accent:${hexVal}`);
    document.getElementById('active-opacity-value').textContent = `${activeVal}%`;
    document.getElementById('idle-opacity-value').textContent   = `${idleVal}%`;
    document.getElementById('accent-hex-label').textContent     = hexVal;

    applyThemeLink(document.getElementById('theme-select').value);
}

// ── Status helper ──────────────────────────────────────────
function setStatus(msg, type = '') {
    const el = document.getElementById('save-status');
    el.textContent = msg;
    el.className   = type;   // '' | 'success' | 'error'
}

// ── Main ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    console.log('[BOOT] settings.js DOMContentLoaded — starting settings init');
    initTabs();
    console.log('[BOOT] Tabs initialized');

    // Load saved settings from Rust / AppData
    console.log('[BOOT] Invoking load_overlay_settings...');
    let current = { ...DEFAULTS };
    try {
        const loaded = await invoke('load_overlay_settings');
        current = { ...DEFAULTS, ...loaded };
        console.log('[BOOT] Settings loaded from backend:', current);
    } catch (err) {
        console.warn('[BOOT] load_overlay_settings failed:', err);
        setStatus('Could not load settings — using defaults.', 'error');
    }

    populateUI(current);

    // Live readouts
    ['theme-select', 'active-opacity', 'idle-opacity',
     'accent-color-picker', 'edit-mode-toggle', 'offset-x', 'offset-y']
        .forEach(id => document.getElementById(id).addEventListener('input', liveUpdate));
    console.log('[BOOT] Live input listeners registered');

    // Reset button
    document.getElementById('reset-btn').addEventListener('click', () => {
        console.log('[BTN] Reset Defaults clicked');
        populateUI({ ...DEFAULTS });
        setStatus('Defaults loaded — click Save & Apply to commit.');
    });

    // Save & Apply button
    document.getElementById('save-btn').addEventListener('click', async () => {
        console.log('[BTN] Save & Apply clicked');
        const newSettings = readUI();
        setStatus('Saving…');

        // Capture current bar position so it persists across restarts
        try {
            const pos = await invoke('get_main_position');
            newSettings.barX = pos.x;
            newSettings.barY = pos.y;
            console.log(`[BTN] Bar position captured: (${pos.x}, ${pos.y})`);
        } catch (err) {
            console.warn('[BTN] get_main_position failed, keeping existing barX/barY:', err);
        }

        try {
            console.log('[BTN] Invoking save_overlay_settings...');
            await invoke('save_overlay_settings', { settings: newSettings });
            console.log('[BTN] save_overlay_settings OK');
            setStatus('Saved and applied.', 'success');
        } catch (err) {
            console.error('[BTN] save_overlay_settings FAILED:', err);
            setStatus(`Save failed: ${String(err)}`, 'error');
            return;
        }

        // Brief button feedback
        const btn = document.getElementById('save-btn');
        const orig = btn.textContent;
        btn.textContent = 'Saved ✓';
        btn.disabled = true;
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1200);
    });

    console.log('[BOOT] Settings init complete');
});
