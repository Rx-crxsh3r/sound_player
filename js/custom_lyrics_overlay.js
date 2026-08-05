const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

const SYNC_DRIFT_TOLERANCE = 1.5; // seconds — see updateMedia(), same tolerance as main.js/popup.js

// Fixed pool of reusable nodes so several cues with overlapping
// [start,end) windows can render concurrently. 20 covers the worst case
// seen so far (believer.clyr's 8-word stair cascade) with real headroom;
// if a file somehow has more than 20 simultaneously-active cues, the
// extras are silently dropped — a rendering-capacity limit, not a
// data-validity error, so this is not something the parser enforces.
const CUE_POOL_SIZE = 20;
const OUTLINE_WIDTH = '2px'; // fixed, not user-adjustable — confirmed

// Five Windows-default fonts (chosen so no font-file bundling is needed —
// each ships with Windows itself) with real fallback stacks. Any other
// font name a hand-authored file specifies still works via the generic
// fallback below; this map just gives the 5 curated choices a proper
// stack instead of passing a single bare name through unmodified.
const FONT_STACKS = {
    'Segoe UI':     '"Segoe UI", system-ui, sans-serif',
    'Impact':       'Impact, "Arial Narrow", sans-serif',
    'Georgia':      'Georgia, "Times New Roman", serif',
    'Consolas':     'Consolas, "Courier New", monospace',
    'Comic Sans MS': '"Comic Sans MS", "Comic Sans", cursive',
};
function resolveFontFamily(name) {
    return FONT_STACKS[name] || `"${name}", "Segoe UI", sans-serif`;
}

let mediaState = { status: 'idle', currentTime: 0, totalTime: 0 };
let tickerInterval = null;

let cues          = [];   // [{ start, end, text, style, fadeMs }, ...] sorted ascending by start
let lastCueKey    = '';   // "title|artist" of the track cues were fetched for
let lastActiveKey = '';   // comma-joined active cue indices from the last render — change-gate
let cuePool       = [];   // DOM nodes, created once at boot, never destroyed
let customLyricsEnabled = false;

// ── pool setup (once, at boot) ──────────────────────────────
function buildCuePool() {
    const container = document.getElementById('cue-pool');
    if (!container) return;
    for (let i = 0; i < CUE_POOL_SIZE; i++) {
        const el = document.createElement('div');
        el.className = 'cue hidden';
        container.appendChild(el);
        cuePool.push(el);
    }
}

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
// Returns ALL indices whose window contains t, not just one, since
// multiple cues can be concurrently active (e.g. a stair-stacked group).
function findActiveCueIndices(t) {
    const out = [];
    for (let i = 0; i < cues.length; i++) {
        if (cues[i].start <= t && t < cues[i].end) out.push(i);
        if (cues[i].start > t) break; // sorted ascending — no match beyond this point
    }
    return out;
}

function updateCueForTime(t) {
    const activeIndices = findActiveCueIndices(t);
    const key = activeIndices.join(',');
    if (key === lastActiveKey) return; // change-gated, same spirit as the old single-index check
    lastActiveKey = key;
    renderActiveCues(activeIndices);
}

function renderActiveCues(activeIndices) {
    const count = Math.min(activeIndices.length, CUE_POOL_SIZE);
    for (let slot = 0; slot < CUE_POOL_SIZE; slot++) {
        const el = cuePool[slot];
        if (!el) continue;
        if (slot < count) {
            renderCueIntoSlot(el, cues[activeIndices[slot]]);
        } else {
            el.classList.add('hidden');
            el.textContent = '';
        }
    }
}

function renderCueIntoSlot(el, cue) {
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
    el.style.fontFamily   = resolveFontFamily(style.font);
    el.style.fontSize     = style.size;
    el.style.color        = style.color;
    el.style.fontWeight   = style.bold ? '700' : '400';
    el.style.fontStyle    = style.italic ? 'italic' : 'normal';
    el.style.textAlign    = style.align;

    // -webkit-text-stroke is supported natively by both webviews this app
    // targets (WebView2/Chromium on Windows, WebKitGTK on Linux) — no
    // fallback needed for either real target.
    if (style.outline) {
        el.style.webkitTextStrokeWidth = OUTLINE_WIDTH;
        el.style.webkitTextStrokeColor = style.outlineColor;
    } else {
        el.style.webkitTextStrokeWidth = '';
        el.style.webkitTextStrokeColor = '';
    }
    el.classList.toggle('shadow', Boolean(style.shadow));

    el.classList.remove('hidden');
}

function clearCues() {
    cues = [];
    lastActiveKey = '';
    for (const el of cuePool) {
        el.classList.add('hidden');
        el.textContent = '';
    }
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
    buildCuePool();

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
