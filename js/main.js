const { invoke } = window.__TAURI__.core;

// ── state ────────────────────────────────────────────────────
let defaults = defaultProjectDefaults();
let cues = [];
let selectedCueId = null;
let audioObjectUrl = null;
let audioFileName = '';
let currentProjectPath = null;
let seeking = false;
let lastActiveCanvasKey = '';
let dragState = null;

let undoStack = [];
const UNDO_LIMIT = 100;

const AUTOSAVE_KEY = 'clyr_studio_autosave_v1';
let autosaveTimer = null;

const audioEl = document.getElementById('audio-player');

const NAMED_COLOR_HEX = {
    white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000',
    blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff',
    gray: '#808080', grey: '#808080', orange: '#ffa500', purple: '#800080',
    pink: '#ffc0cb', brown: '#a52a2a', transparent: '#000000', gold: '#ffd700',
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// <input type="color"> only ever accepts/shows plain #rrggbb — this is a
// known, accepted narrowing vs. the full format (named colors, #RGB,
// alpha) for THIS editor's UI specifically; the format itself still
// supports all of those for hand-authored or externally-produced files.
function normalizeColorForPicker(c) {
    if (!c) return '#ffffff';
    if (c.startsWith('#')) {
        const hex = c.slice(1);
        if (hex.length === 3) return '#' + [...hex].map((ch) => ch + ch).join('');
        if (hex.length === 8) return '#' + hex.slice(0, 6);
        if (hex.length === 6) return c;
    }
    return NAMED_COLOR_HEX[c.toLowerCase()] || '#ffffff';
}

function formatClock(seconds) {
    const s = Math.max(0, seconds || 0);
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
}

// ── status line ──────────────────────────────────────────────
function setStatus(msg, isError = false) {
    const el = document.getElementById('status-message');
    el.textContent = msg;
    el.style.color = isError ? 'var(--danger)' : '';
}

// ── undo (full-state snapshots, capped) ─────────────────────
function snapshot() {
    undoStack.push(structuredClone({ defaults, cues }));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    document.getElementById('undo-btn').disabled = false;
}
function undo() {
    if (undoStack.length === 0) return;
    const prev = undoStack.pop();
    defaults = prev.defaults;
    cues = prev.cues;
    if (!cues.find((c) => c.id === selectedCueId)) selectedCueId = null;
    document.getElementById('undo-btn').disabled = undoStack.length === 0;
    renderAll();
}

// ── autosave (localStorage safety net — distinct from explicit
// Save Project, which uses a real file dialog via Rust) ─────
function serializeProject() {
    return JSON.stringify({ version: 1, audioFileName, defaults, cues }, null, 2);
}
function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
        try {
            localStorage.setItem(AUTOSAVE_KEY, serializeProject());
        } catch (err) {
            console.warn('[AUTOSAVE] failed:', err);
        }
    }, 2000);
}

// ── audio ────────────────────────────────────────────────────
document.getElementById('open-audio-btn').addEventListener('click', () => {
    document.getElementById('audio-file-input').click();
});
document.getElementById('audio-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
    audioObjectUrl = URL.createObjectURL(file);
    audioFileName = file.name;
    audioEl.src = audioObjectUrl;
    document.getElementById('audio-filename').textContent = file.name;
    document.getElementById('play-pause-btn').disabled = false;
    document.getElementById('seek-bar').disabled = false;
    document.getElementById('add-box-btn').disabled = false;
    setStatus(`Loaded ${file.name}`);
});

audioEl.addEventListener('loadedmetadata', () => {
    document.getElementById('seek-bar').max = String(Math.floor((audioEl.duration || 0) * 1000));
    updateTimeDisplay();
});
audioEl.addEventListener('timeupdate', () => {
    if (!seeking) {
        document.getElementById('seek-bar').value = String(Math.floor(audioEl.currentTime * 1000));
    }
    updateTimeDisplay();
    renderCanvas();
    renderLayerList();
});
audioEl.addEventListener('play', () => { document.getElementById('play-pause-btn').textContent = 'Pause'; });
audioEl.addEventListener('pause', () => { document.getElementById('play-pause-btn').textContent = 'Play'; });

function updateTimeDisplay() {
    const dur = Number.isFinite(audioEl.duration) ? audioEl.duration : 0;
    document.getElementById('time-display').textContent = `${formatClock(audioEl.currentTime)} / ${formatClock(dur)}`;
}

document.getElementById('play-pause-btn').addEventListener('click', () => {
    if (audioEl.paused) audioEl.play(); else audioEl.pause();
});

const seekBar = document.getElementById('seek-bar');
seekBar.addEventListener('pointerdown', () => { seeking = true; });
seekBar.addEventListener('input', () => {
    audioEl.currentTime = Number(seekBar.value) / 1000;
    updateTimeDisplay();
    renderCanvas();
});
seekBar.addEventListener('pointerup', () => { seeking = false; });

// ── add box ──────────────────────────────────────────────────
// Captures the current playhead as the new cue's start and pauses
// playback immediately, so styling/positioning never races the music —
// per the described flow. end defaults to start+2s (there's often no
// "next cue" yet to derive it from when authoring forward); adjustable
// via drag on the timeline, typing a value, or "set to playhead" after
// resuming. Position/bold/italic/outline/shadow are pre-populated from
// the CURRENT effective default (a real explicit copy, not inherited) —
// see clyr_format.js's header comment on why those 7 properties are
// always-explicit-once-created rather than genuinely sparse.
document.getElementById('add-box-btn').addEventListener('click', () => {
    if (!Number.isFinite(audioEl.duration)) return;
    const start = audioEl.currentTime;
    audioEl.pause();
    snapshot();
    const eff = resolveStyle({ style: {} }, defaults);
    const newCue = {
        id: generateCueId(),
        start,
        end: Math.min(start + 2.0, audioEl.duration || start + 2.0),
        text: 'New text',
        fadeMs: undefined,
        style: {
            posX: 50, posY: 85,
            bold: eff.bold, italic: eff.italic,
            outline: eff.outline, outlineColor: eff.outlineColor,
            shadow: eff.shadow,
        },
    };
    cues.push(newCue);
    selectedCueId = newCue.id;
    renderAll();
    setStatus(`Added cue at ${formatClock(start)} — resume playback when ready.`);
});

// ── canvas: renders every cue active at the current playhead ─
// (the multi-box requirement) using the exact same left/top-percent +
// translate(-50%,-50%) positioning math as main branch's actual runtime
// overlay, so this is a genuinely accurate live preview, not an
// approximation.
function findActiveCues(t) {
    return cues.filter((c) => c.start <= t && t < c.end);
}

function renderCanvas() {
    const t = audioEl.currentTime || 0;
    const active = findActiveCues(t);
    const key = active.map((c) => c.id).sort().join(',') + '|' + selectedCueId;
    if (key === lastActiveCanvasKey) return; // change-gated, same spirit as the runtime overlay
    lastActiveCanvasKey = key;

    const canvas = document.getElementById('canvas');
    canvas.innerHTML = '';
    for (const cue of active) {
        const eff = resolveStyle(cue, defaults);
        const el = document.createElement('div');
        el.className = 'box' + (cue.id === selectedCueId ? ' selected' : '') + (eff.shadow ? ' shadow-fx' : '');
        el.textContent = cue.text;
        el.style.left = `${eff.posX}%`;
        el.style.top = `${eff.posY}%`;
        el.style.fontFamily = eff.font;
        el.style.fontSize = eff.size;
        el.style.color = eff.color;
        el.style.fontWeight = eff.bold ? '700' : '400';
        el.style.fontStyle = eff.italic ? 'italic' : 'normal';
        el.style.textAlign = eff.align;
        if (eff.outline) {
            el.style.webkitTextStrokeWidth = '2px';
            el.style.webkitTextStrokeColor = eff.outlineColor;
        }
        el.dataset.cueId = cue.id;
        el.addEventListener('pointerdown', onBoxPointerDown);
        canvas.appendChild(el);
    }
}

// ── drag-to-position (the primary way to set pos) ────────────
function onBoxPointerDown(e) {
    e.preventDefault();
    const cueId = e.currentTarget.dataset.cueId;
    selectCue(cueId);
    const canvas = document.getElementById('canvas');
    const rect = canvas.getBoundingClientRect();
    snapshot(); // one snapshot per drag gesture, not per pointermove tick
    dragState = { cueId, rect, el: e.currentTarget };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.addEventListener('pointermove', onBoxPointerMove);
    e.currentTarget.addEventListener('pointerup', onBoxPointerUp);
}
function onBoxPointerMove(e) {
    if (!dragState) return;
    const { rect, cueId, el } = dragState;
    const xPct = clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100);
    const yPct = clamp(((e.clientY - rect.top) / rect.height) * 100, 0, 100);
    const cue = cues.find((c) => c.id === cueId);
    if (!cue) return;
    cue.style.posX = Math.round(xPct * 10) / 10;
    cue.style.posY = Math.round(yPct * 10) / 10;
    // Direct imperative update on the dragged element only — not a full
    // renderCanvas() pass — so dragging stays smooth and doesn't fight
    // the change-gate above.
    el.style.left = `${cue.style.posX}%`;
    el.style.top = `${cue.style.posY}%`;
    if (cueId === selectedCueId) {
        document.getElementById('insp-pos-x').value = cue.style.posX;
        document.getElementById('insp-pos-y').value = cue.style.posY;
    }
}
function onBoxPointerUp(e) {
    if (!dragState) return;
    const { el } = dragState;
    el.removeEventListener('pointermove', onBoxPointerMove);
    el.removeEventListener('pointerup', onBoxPointerUp);
    dragState = null;
    scheduleAutosave();
}

// ── layer list ───────────────────────────────────────────────
function renderLayerList() {
    const container = document.getElementById('layer-list');
    container.innerHTML = '';
    const t = audioEl.currentTime || 0;
    const sorted = [...cues].sort((a, b) => a.start - b.start);
    for (const cue of sorted) {
        const row = document.createElement('div');
        const isActive = cue.start <= t && t < cue.end;
        row.className = 'layer-row' + (cue.id === selectedCueId ? ' selected' : '') + (isActive ? ' active-now' : '');
        const timeSpan = document.createElement('span');
        timeSpan.className = 'layer-time';
        timeSpan.textContent = formatClock(cue.start);
        const textSpan = document.createElement('span');
        textSpan.textContent = cue.text.length > 28 ? cue.text.slice(0, 28) + '…' : cue.text;
        row.append(timeSpan, textSpan);
        row.addEventListener('click', () => {
            audioEl.currentTime = cue.start;
            updateTimeDisplay();
            selectCue(cue.id);
        });
        container.appendChild(row);
    }
}

function selectCue(cueId) {
    selectedCueId = cueId;
    lastActiveCanvasKey = ''; // force a rebuild so the .selected outline updates
    renderCanvas();
    renderLayerList();
    renderInspector();
}

// ── inspector: Project Defaults form (shown when nothing selected) ──
function populateFontSelect(selectEl, includeInherit) {
    selectEl.innerHTML = '';
    if (includeInherit) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(inherit)';
        selectEl.appendChild(opt);
    }
    for (const font of CURATED_FONTS) {
        const opt = document.createElement('option');
        opt.value = font;
        opt.textContent = font;
        selectEl.appendChild(opt);
    }
}

function populateDefaultsForm() {
    document.getElementById('def-font').value = defaults.font;
    document.getElementById('def-size').value = defaults.size;
    document.getElementById('def-color').value = normalizeColorForPicker(defaults.color);
    document.getElementById('def-align').value = defaults.align;
    document.getElementById('def-outline').checked = defaults.outline;
    document.getElementById('def-outline-color').value = normalizeColorForPicker(defaults.outlineColor);
    document.getElementById('def-shadow').checked = defaults.shadow;
}

function readDefaultsForm() {
    defaults.font = document.getElementById('def-font').value;
    const sizeInput = document.getElementById('def-size');
    const sizeVal = sizeInput.value.trim();
    if (validateSize(sizeVal)) defaults.size = sizeVal;
    else sizeInput.value = defaults.size;
    defaults.color = document.getElementById('def-color').value;
    defaults.align = document.getElementById('def-align').value;
    defaults.outline = document.getElementById('def-outline').checked;
    defaults.outlineColor = document.getElementById('def-outline-color').value;
    defaults.shadow = document.getElementById('def-shadow').checked;
}

function bindDefaultsForm() {
    const ids = ['def-font', 'def-size', 'def-color', 'def-align', 'def-outline', 'def-outline-color', 'def-shadow'];
    for (const id of ids) {
        document.getElementById(id).addEventListener('change', () => {
            snapshot();
            readDefaultsForm();
            renderAll();
        });
    }
}

// ── inspector: per-cue form (shown when a cue is selected) ──
// font/size/align/color are genuinely sparse (blank/unchecked = inherit
// from Project Defaults); pos/bold/italic/outline/outlineColor/shadow
// are always-explicit once a cue exists — see clyr_format.js's header
// comment for why that split was made.
function populateCueForm(cue) {
    document.getElementById('insp-text').value = cue.text;
    document.getElementById('insp-start').value = cue.start.toFixed(2);
    document.getElementById('insp-end').value = cue.end.toFixed(2);

    document.getElementById('insp-font').value = cue.style.font ?? '';
    document.getElementById('insp-size').value = cue.style.size ?? '';

    const hasColor = cue.style.color !== undefined;
    document.getElementById('insp-color-override').checked = hasColor;
    document.getElementById('insp-color').value = normalizeColorForPicker(
        hasColor ? cue.style.color : resolveStyle(cue, defaults).color
    );

    document.getElementById('insp-bold').checked = Boolean(cue.style.bold);
    document.getElementById('insp-italic').checked = Boolean(cue.style.italic);
    document.getElementById('insp-align').value = cue.style.align ?? '';

    document.getElementById('insp-pos-x').value = cue.style.posX ?? 50;
    document.getElementById('insp-pos-y').value = cue.style.posY ?? 85;

    document.getElementById('insp-outline').checked = Boolean(cue.style.outline);
    document.getElementById('insp-outline-color').value = normalizeColorForPicker(cue.style.outlineColor ?? defaults.outlineColor);

    document.getElementById('insp-shadow').checked = Boolean(cue.style.shadow);
}

function readCueForm(cue) {
    cue.text = document.getElementById('insp-text').value || ' ';

    const start = Number(document.getElementById('insp-start').value);
    const end = Number(document.getElementById('insp-end').value);
    if (Number.isFinite(start)) cue.start = Math.max(0, start);
    if (Number.isFinite(end) && end > cue.start) cue.end = end;
    else document.getElementById('insp-end').value = cue.end.toFixed(2);

    const fontVal = document.getElementById('insp-font').value;
    if (fontVal === '') delete cue.style.font; else cue.style.font = fontVal;

    const sizeVal = document.getElementById('insp-size').value.trim();
    if (sizeVal === '') delete cue.style.size;
    else if (validateSize(sizeVal)) cue.style.size = sizeVal;
    else document.getElementById('insp-size').value = cue.style.size ?? '';

    const colorOverride = document.getElementById('insp-color-override').checked;
    if (!colorOverride) delete cue.style.color;
    else cue.style.color = document.getElementById('insp-color').value;

    cue.style.bold = document.getElementById('insp-bold').checked;
    cue.style.italic = document.getElementById('insp-italic').checked;

    const alignVal = document.getElementById('insp-align').value;
    if (alignVal === '') delete cue.style.align; else cue.style.align = alignVal;

    const x = Number(document.getElementById('insp-pos-x').value);
    const y = Number(document.getElementById('insp-pos-y').value);
    if (Number.isFinite(x)) cue.style.posX = clamp(x, 0, 100);
    if (Number.isFinite(y)) cue.style.posY = clamp(y, 0, 100);

    cue.style.outline = document.getElementById('insp-outline').checked;
    cue.style.outlineColor = document.getElementById('insp-outline-color').value;
    cue.style.shadow = document.getElementById('insp-shadow').checked;
}

function bindInspectorForm() {
    const ids = [
        'insp-text', 'insp-start', 'insp-end', 'insp-font', 'insp-size',
        'insp-color-override', 'insp-color', 'insp-bold', 'insp-italic', 'insp-align',
        'insp-pos-x', 'insp-pos-y', 'insp-outline', 'insp-outline-color', 'insp-shadow',
    ];
    for (const id of ids) {
        document.getElementById(id).addEventListener('change', () => {
            const cue = cues.find((c) => c.id === selectedCueId);
            if (!cue) return;
            snapshot();
            readCueForm(cue);
            renderAll();
        });
    }
    document.getElementById('insp-capture-start').addEventListener('click', () => {
        const cue = cues.find((c) => c.id === selectedCueId);
        if (!cue || !Number.isFinite(audioEl.currentTime)) return;
        snapshot();
        cue.start = audioEl.currentTime;
        renderAll();
    });
    document.getElementById('insp-capture-end').addEventListener('click', () => {
        const cue = cues.find((c) => c.id === selectedCueId);
        if (!cue || !Number.isFinite(audioEl.currentTime)) return;
        snapshot();
        cue.end = audioEl.currentTime;
        renderAll();
    });
    document.getElementById('insp-delete-btn').addEventListener('click', () => {
        const cue = cues.find((c) => c.id === selectedCueId);
        if (!cue) return;
        snapshot();
        cues = cues.filter((c) => c.id !== selectedCueId);
        selectedCueId = null;
        renderAll();
    });
}

function renderInspector() {
    const defaultsForm = document.getElementById('defaults-form');
    const cueForm = document.getElementById('inspector-form');
    const cue = selectedCueId === null ? null : cues.find((c) => c.id === selectedCueId);
    if (!cue) {
        if (selectedCueId !== null) selectedCueId = null;
        defaultsForm.hidden = false;
        cueForm.hidden = true;
        populateDefaultsForm();
        return;
    }
    defaultsForm.hidden = true;
    cueForm.hidden = false;
    populateCueForm(cue);
}

function renderAll() {
    lastActiveCanvasKey = '';
    renderCanvas();
    renderLayerList();
    renderInspector();
    scheduleAutosave();
}

// ── .clyr import/export (plain browser mechanisms, no plugin) ──
document.getElementById('import-clyr-btn').addEventListener('click', () => {
    document.getElementById('clyr-file-input').click();
});
document.getElementById('clyr-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const result = parseClyr(text);
    if (!result.ok) {
        const loc = result.error.line > 0 ? `line ${result.error.line}: ` : '';
        setStatus(`Import failed — ${loc}${result.error.message}`, true);
        e.target.value = '';
        return;
    }
    snapshot();
    defaults = result.defaults;
    cues = result.cues;
    selectedCueId = null;
    renderAll();
    setStatus(`Imported ${cues.length} cue${cues.length === 1 ? '' : 's'} from ${file.name}.`);
    e.target.value = '';
});

document.getElementById('export-clyr-btn').addEventListener('click', () => {
    if (cues.length === 0) {
        setStatus('Nothing to export — add at least one cue first.', true);
        return;
    }
    const text = serializeClyr(defaults, cues);
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'export.clyr';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus(`Exported ${cues.length} cue${cues.length === 1 ? '' : 's'}.`);
});

// ── project (.clyrproj) save/open — native dialogs via Rust ──
document.getElementById('save-project-btn').addEventListener('click', async () => {
    try {
        const path = await invoke('save_project_dialog', { content: serializeProject() });
        if (path) {
            currentProjectPath = path;
            setStatus(`Saved to ${path}`);
        }
    } catch (err) {
        setStatus(`Save failed: ${String(err)}`, true);
    }
});

document.getElementById('open-project-btn').addEventListener('click', async () => {
    try {
        const result = await invoke('open_project_dialog');
        if (!result) return;
        const [path, content] = result;
        const data = JSON.parse(content);
        snapshot();
        defaults = data.defaults;
        cues = data.cues;
        audioFileName = data.audioFileName || '';
        document.getElementById('audio-filename').textContent = audioFileName ? `${audioFileName} (re-open audio file to resume playback)` : '';
        selectedCueId = null;
        currentProjectPath = path;
        renderAll();
        setStatus(`Opened ${path}`);
    } catch (err) {
        setStatus(`Open failed: ${String(err)}`, true);
    }
});

document.getElementById('undo-btn').addEventListener('click', undo);
document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
    }
});

// ── init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    populateFontSelect(document.getElementById('def-font'), false);
    populateFontSelect(document.getElementById('insp-font'), true);
    bindDefaultsForm();
    bindInspectorForm();

    try {
        const saved = localStorage.getItem(AUTOSAVE_KEY);
        if (saved) {
            const data = JSON.parse(saved);
            if (data.cues && data.cues.length > 0 && confirm(`Restore autosaved session with ${data.cues.length} cue(s)?`)) {
                defaults = data.defaults;
                cues = data.cues;
                audioFileName = data.audioFileName || '';
                if (audioFileName) {
                    document.getElementById('audio-filename').textContent = `${audioFileName} (re-open audio file to resume playback)`;
                }
            }
        }
    } catch (err) {
        console.warn('[AUTOSAVE] restore failed:', err);
    }

    renderAll();
    setStatus('Open an audio file to begin.');
});
