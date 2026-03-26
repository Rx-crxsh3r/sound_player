const { invoke } = window.__TAURI__.tauri;
const { listen }  = window.__TAURI__.event;

// Apply the correct theme template so the button color variables resolve.
async function applyTheme() {
    console.log('[THEME] bar_button: applyTheme called');
    try {
        const s = await invoke('load_overlay_settings');
        const link = document.getElementById('theme-template');
        const file = `css/templates/${s.theme === 'light' ? 'light' : 'dark'}.css`;
        if (link) link.href = file;
        console.log(`[THEME] bar_button: theme applied -> ${file}`);
    } catch (err) {
        console.warn('[THEME] bar_button: applyTheme failed, keeping default dark:', err);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    console.log('[BOOT] bar_button.js DOMContentLoaded');
    await applyTheme();

    document.getElementById('toggle-btn').addEventListener('click', async () => {
        console.log('[BTN] Toggle button clicked — invoking toggle_overlay_popup');
        await invoke('toggle_overlay_popup');
        console.log('[BTN] toggle_overlay_popup invoke sent');
    });

    // If the theme changes via settings, update our template link too.
    listen('overlay-settings-updated', (e) => {
        console.log('[EVENT] bar_button: overlay-settings-updated received, theme:', e.payload?.theme);
        const link = document.getElementById('theme-template');
        if (link && e.payload?.theme) {
            link.href = `css/templates/${e.payload.theme === 'light' ? 'light' : 'dark'}.css`;
        }
    });

    // Mirror popup open/closed state as V / ∧ button rotation.
    listen('overlay-popup-changed', (e) => {
        const btn = document.getElementById('toggle-btn');
        if (btn) btn.classList.toggle('is-open', Boolean(e.payload?.open));
    });

    console.log('[BOOT] bar_button init complete');
});
