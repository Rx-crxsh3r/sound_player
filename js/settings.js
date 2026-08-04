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
    shortcutPlayPause:        { enabled: false, combo: '' },
    shortcutNext:              { enabled: false, combo: '' },
    shortcutPrev:               { enabled: false, combo: '' },
    shortcutTogglePopup:        { enabled: false, combo: '' },
    shortcutHideBar:             { enabled: false, combo: '' },
    shortcutToggleVisualizer:    { enabled: false, combo: '' },
    shortcutOpenSettings:        { enabled: false, combo: '' },
    hideBarKeepsLyrics: false,
};

// Matches the camelCase action IDs used in settings.html's
// data-action/element-id attributes and the action names src/main.rs
// returns in the failed-shortcuts list — kept in one place so the two
// stay in sync.
const SHORTCUT_ACTIONS = [
    'playPause', 'next', 'prev', 'togglePopup',
    'hideBar', 'toggleVisualizer', 'openSettings',
];

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

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

// ── Keybind recorder ────────────────────────────────────────
// Click a shortcut's button, press the combo you want, it's captured and
// displayed immediately — nothing is registered with the OS until Save &
// Apply (see the save-btn handler, which is also where a "this combo is
// already in use" conflict can first be discovered — see the Keybinds
// tab's own helper text for why that can only be known at save time).
function formatAccelerator(e) {
    const modifierKeys = ['Control', 'Alt', 'Shift', 'Meta'];
    if (modifierKeys.includes(e.key)) return null; // still just a modifier — keep listening

    const parts = [];
    if (e.ctrlKey)  parts.push('Ctrl');
    if (e.altKey)   parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey)  parts.push('Super');

    let key = e.key;
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    parts.push(key);

    return parts.join('+');
}

function initShortcutRecorders() {
    document.querySelectorAll('.shortcut-row').forEach(row => {
        const action = row.dataset.action;
        const btn = document.getElementById(`shortcut-${action}-combo`);
        if (!btn) return;

        let recording = false;

        function onKeyDown(e) {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') { stopRecording(); return; }
            const combo = formatAccelerator(e);
            if (!combo) return;
            btn.textContent = combo;
            btn.dataset.combo = combo;
            btn.classList.add('set');
            btn.classList.remove('conflict');
            stopRecording();
        }

        function stopRecording() {
            recording = false;
            btn.classList.remove('recording');
            document.removeEventListener('keydown', onKeyDown, true);
        }

        btn.addEventListener('click', () => {
            if (recording) { stopRecording(); return; }
            recording = true;
            btn.textContent = 'Press a key combo… (Esc to cancel)';
            btn.classList.add('recording');
            document.addEventListener('keydown', onKeyDown, true);
        });
    });
}

function populateShortcuts(s) {
    SHORTCUT_ACTIONS.forEach(action => {
        const binding = s[`shortcut${capitalize(action)}`] || { enabled: false, combo: '' };
        const btn      = document.getElementById(`shortcut-${action}-combo`);
        const checkbox = document.getElementById(`shortcut-${action}-enabled`);
        if (btn) {
            btn.textContent = binding.combo || 'Click to record';
            btn.dataset.combo = binding.combo || '';
            btn.classList.toggle('set', Boolean(binding.combo));
            btn.classList.remove('conflict');
        }
        if (checkbox) checkbox.checked = Boolean(binding.enabled);
    });
    const keepLyrics = document.getElementById('hide-bar-keeps-lyrics');
    if (keepLyrics) keepLyrics.checked = Boolean(s.hideBarKeepsLyrics);
}

function readShortcuts() {
    const result = {};
    SHORTCUT_ACTIONS.forEach(action => {
        const btn      = document.getElementById(`shortcut-${action}-combo`);
        const checkbox = document.getElementById(`shortcut-${action}-enabled`);
        result[`shortcut${capitalize(action)}`] = {
            combo:   (btn && btn.dataset.combo) || '',
            enabled: Boolean(checkbox && checkbox.checked),
        };
    });
    const keepLyrics = document.getElementById('hide-bar-keeps-lyrics');
    result.hideBarKeepsLyrics = Boolean(keepLyrics && keepLyrics.checked);
    return result;
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

    populateShortcuts(s);

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
        ...readShortcuts(),
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
    initShortcutRecorders();

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

        document.querySelectorAll('.shortcut-recorder').forEach(b => b.classList.remove('conflict'));

        let failedShortcuts = [];
        try {
            failedShortcuts = (await invoke('save_overlay_settings', { settings: newSettings })) || [];
        } catch (err) {
            setStatus(`Save failed: ${String(err)}`, 'error');
            return;
        }

        if (failedShortcuts.length > 0) {
            failedShortcuts.forEach(action => {
                const btn = document.getElementById(`shortcut-${action}-combo`);
                if (btn) btn.classList.add('conflict');
            });
            setStatus(`Saved, but ${failedShortcuts.length} shortcut${failedShortcuts.length > 1 ? 's' : ''} couldn't be registered (already in use) — see highlighted row${failedShortcuts.length > 1 ? 's' : ''} in Keybinds.`, 'error');
        } else {
            setStatus('Saved and applied.', 'success');
        }

        const btn  = document.getElementById('save-btn');
        const orig = btn.textContent;
        btn.textContent = 'Saved ✓';
        btn.disabled = true;
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1200);
    });
});
