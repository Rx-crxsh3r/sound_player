const { invoke } = window.__TAURI__.tauri;
const { listen }  = window.__TAURI__.event;

async function applyTheme() {
    try {
        const s    = await invoke('load_overlay_settings');
        const link = document.getElementById('theme-template');
        if (link) link.href = `css/templates/${s.theme === 'light' ? 'light' : 'dark'}.css`;
    } catch (err) {
        console.warn('[THEME] bar_button: applyTheme failed:', err);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await applyTheme();

    document.getElementById('toggle-btn').addEventListener('click', async () => {
        await invoke('toggle_overlay_popup');
    });

    listen('overlay-settings-updated', (e) => {
        const link = document.getElementById('theme-template');
        if (link && e.payload?.theme) {
            link.href = `css/templates/${e.payload.theme === 'light' ? 'light' : 'dark'}.css`;
        }
    });

    listen('overlay-popup-changed', (e) => {
        const btn = document.getElementById('toggle-btn');
        if (btn) btn.classList.toggle('is-open', Boolean(e.payload?.open));
    });
});
