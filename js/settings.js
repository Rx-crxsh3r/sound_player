const { invoke } = window.__TAURI__.core;

// ── Defaults (must match Rust OverlaySettings default) ────
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

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ── Theme link helper ──────────────────────────────────────
function applyThemeLink(name) {
    const link = document.getElementById('theme-template');
    if (link) link.href = `css/templates/${name === 'light' ? 'light' : 'dark'}.css`;
}

// ── Custom select (native <select> popups render via OS/WebView chrome
// and ignore our theme CSS entirely — this replaces the open-list part
// with a fully CSS-themed one while keeping the real <select> as the data
// store, so readUI/populateUI/liveUpdate all keep working unchanged) ────
function initFakeSelects() {
    document.querySelectorAll('select.control-select').forEach(selectEl => {
        const wrapper = document.createElement('div');
        wrapper.className = 'fake-select';
        wrapper.innerHTML = `
            <div class="fake-select-box" tabindex="0">
                <span class="fake-select-label"></span>
                <svg class="fake-select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6,9 12,15 18,9"/></svg>
            </div>
            <ul class="fake-select-list" hidden></ul>`;

        const box   = wrapper.querySelector('.fake-select-box');
        const label = wrapper.querySelector('.fake-select-label');
        const list  = wrapper.querySelector('.fake-select-list');

        const close = () => { list.hidden = true;  wrapper.classList.remove('open'); };
        const open  = () => { list.hidden = false; wrapper.classList.add('open'); };
        const refresh = () => {
            const selected = selectEl.options[selectEl.selectedIndex];
            label.textContent = selected ? selected.textContent : '';
            list.querySelectorAll('li').forEach(li => {
                li.classList.toggle('selected', li.dataset.value === selectEl.value);
            });
        };

        Array.from(selectEl.options).forEach(opt => {
            const li = document.createElement('li');
            li.textContent = opt.textContent;
            li.dataset.value = opt.value;
            li.addEventListener('click', () => {
                selectEl.value = opt.value;
                selectEl.dispatchEvent(new Event('input', { bubbles: true }));
                refresh();
                close();
            });
            list.appendChild(li);
        });

        box.addEventListener('click', () => (list.hidden ? open() : close()));
        box.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); list.hidden ? open() : close(); }
            else if (e.key === 'Escape') close();
        });
        document.addEventListener('click', (e) => {
            if (!wrapper.contains(e.target)) close();
        });

        // Preserve the existing label-click-focuses-control behavior now
        // that the real <select> is hidden and can't receive it directly.
        const assocLabel = document.querySelector(`label[for="${selectEl.id}"]`);
        if (assocLabel) assocLabel.addEventListener('click', () => box.focus());

        selectEl.insertAdjacentElement('afterend', wrapper);
        selectEl.classList.add('visually-hidden-select');
        selectEl.tabIndex = -1;

        refresh();
        selectEl.__refreshFakeSelect = refresh;
    });
}

function refreshFakeSelects() {
    document.querySelectorAll('select.control-select').forEach(el => {
        if (typeof el.__refreshFakeSelect === 'function') el.__refreshFakeSelect();
    });
}

// ── Tab navigation ─────────────────────────────────────────
function initTabs() {
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            if (tab.classList.contains('placeholder')) return;
            document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.settings-tab-view').forEach(v => v.classList.remove('active'));
            tab.classList.add('active');
            const view = document.getElementById(`view-${tab.dataset.tab}`);
            if (view) view.classList.add('active');
        });
    });
}

// ── Populate UI from a settings object ────────────────────
function populateUI(s) {
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

    document.getElementById('visualizer-enabled').checked          = s.visualizerEnabled !== false;
    document.getElementById('visualizer-bands').value              = String(s.visualizerBands || 24);
    document.getElementById('visualizer-gain').value              = String(s.visualizerGain);
    document.getElementById('visualizer-smoothing').value         = String(s.visualizerSmoothing);
    document.getElementById('visualizer-gain-value').textContent      = `${Number(s.visualizerGain).toFixed(1)}×`;
    document.getElementById('visualizer-smoothing-value').textContent = `${Math.round(s.visualizerSmoothing * 100)}%`;

    document.getElementById('lyrics-enabled-toggle').checked = Boolean(s.lyricsEnabled);
    document.getElementById('lyrics-display-mode').value     = s.lyricsDisplayMode === 'bar' ? 'bar' : 'popup';

    applyThemeLink(s.theme);
    document.documentElement.style.setProperty('--accent-color', s.accentColor);
    document.documentElement.style.setProperty('--ui-accent-surface', hexToRgba(s.accentColor, 0.10));

    refreshFakeSelects();
}

// ── Read current UI values into an object ─────────────────
function readUI() {
    const result = {
        theme:         document.getElementById('theme-select').value,
        activeOpacity: clamp(Number(document.getElementById('active-opacity').value), 10, 100),
        idleOpacity:   clamp(Number(document.getElementById('idle-opacity').value),   10, 100),
        accentColor:   document.getElementById('accent-color-picker').value,
        editMode:      document.getElementById('edit-mode-toggle').checked,
        offsetX:             clamp(Number(document.getElementById('offset-x').value), 0, 80),
        offsetY:             clamp(Number(document.getElementById('offset-y').value), 0, 80),
        visualizerEnabled:   document.getElementById('visualizer-enabled').checked,
        visualizerBands:     Number(document.getElementById('visualizer-bands').value),
        visualizerGain:      parseFloat(document.getElementById('visualizer-gain').value),
        visualizerSmoothing: parseFloat(document.getElementById('visualizer-smoothing').value),
        lyricsEnabled:       document.getElementById('lyrics-enabled-toggle').checked,
        lyricsDisplayMode:   document.getElementById('lyrics-display-mode').value,
    };
    return result;
}

// ── Live readout update while sliders move ─────────────────
function liveUpdate() {
    const activeVal = document.getElementById('active-opacity').value;
    const idleVal   = document.getElementById('idle-opacity').value;
    const hexVal    = document.getElementById('accent-color-picker').value;
    document.getElementById('active-opacity-value').textContent = `${activeVal}%`;
    document.getElementById('idle-opacity-value').textContent   = `${idleVal}%`;
    document.getElementById('accent-hex-label').textContent     = hexVal;

    const gainVal      = document.getElementById('visualizer-gain').value;
    const smoothingVal = document.getElementById('visualizer-smoothing').value;
    document.getElementById('visualizer-gain-value').textContent      = `${parseFloat(gainVal).toFixed(1)}×`;
    document.getElementById('visualizer-smoothing-value').textContent = `${Math.round(parseFloat(smoothingVal) * 100)}%`;

    applyThemeLink(document.getElementById('theme-select').value);
    document.documentElement.style.setProperty('--accent-color', hexVal);
    document.documentElement.style.setProperty('--ui-accent-surface', hexToRgba(hexVal, 0.10));
}

// ── Status helper ──────────────────────────────────────────
function setStatus(msg, type = '') {
    const el = document.getElementById('save-status');
    el.textContent = msg;
    el.className   = type;   // '' | 'success' | 'error'
}

// ── Main ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    initTabs();
    initFakeSelects();

    let current = { ...DEFAULTS };
    try {
        const loaded = await invoke('load_overlay_settings');
        current = { ...DEFAULTS, ...loaded };
    } catch (err) {
        console.warn('[BOOT] load_overlay_settings failed:', err);
        setStatus('Could not load settings — using defaults.', 'error');
    }

    populateUI(current);

    ['theme-select', 'active-opacity', 'idle-opacity',
     'accent-color-picker', 'edit-mode-toggle', 'offset-x', 'offset-y',
     'visualizer-enabled', 'visualizer-bands', 'visualizer-gain', 'visualizer-smoothing',
     'lyrics-enabled-toggle', 'lyrics-display-mode']
        .forEach(id => document.getElementById(id).addEventListener('input', liveUpdate));

    document.getElementById('clear-lyrics-cache-btn').addEventListener('click', async () => {
        const status = document.getElementById('lyrics-cache-status');
        try {
            await invoke('clear_lyrics_cache');
            if (status) status.textContent = 'Cache cleared.';
        } catch (err) {
            if (status) status.textContent = `Failed: ${String(err)}`;
        }
        setTimeout(() => { if (status) status.textContent = ''; }, 2000);
    });

    document.getElementById('reset-btn').addEventListener('click', () => {
        populateUI({ ...DEFAULTS });
        setStatus('Defaults loaded — click Save & Apply to commit.');
    });

    document.getElementById('save-btn').addEventListener('click', async () => {
        const newSettings = readUI();
        setStatus('Saving…');

        try {
            const pos = await invoke('get_main_position');
            newSettings.barX = pos.x;
            newSettings.barY = pos.y;
        } catch (err) {
            console.warn('[BTN] get_main_position failed, keeping existing barX/barY:', err);
        }

        try {
            await invoke('save_overlay_settings', { settings: newSettings });
            setStatus('Saved and applied.', 'success');
        } catch (err) {
            setStatus(`Save failed: ${String(err)}`, 'error');
            return;
        }

        const btn  = document.getElementById('save-btn');
        const orig = btn.textContent;
        btn.textContent = 'Saved ✓';
        btn.disabled = true;
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1200);
    });
});
