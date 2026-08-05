// ── .clyr format: parser + serializer (JS port) ─────────────
// This is a *different implementation* of the same grammar as `main`
// branch's src/clyr.rs, not a line-for-line port of its behavior:
// main's Rust parser deliberately CASCADE-RESOLVES every cue into one
// fully-baked style at parse time (correct for a runtime that only ever
// reads the effective style, fast). This editor needs the opposite — it
// must PRESERVE the distinction between "this cue explicitly set X" and
// "X was inherited from the file's @ defaults," or every re-exported file
// would balloon into repeating a full style block on every single cue.
// So parsing here produces SPARSE per-cue styles (only explicitly-set
// keys present); resolveStyle() computes the effective style on demand,
// only for rendering.
//
// Grammar-critical: every validation rule here (size units, color
// formats, quote-aware splitting, MAX_* caps, line-numbered errors) must
// stay in lockstep with main's src/clyr.rs by hand, since this branch has
// no shared git history with main to enforce it structurally. If you
// change one, change the other. Verified in sync as of the branch's
// "believer.clyr" round-trip test (see js/main.js's dev-console self-test).

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_CUES = 2000;
const MAX_CUE_TEXT_LEN = 500;

// Matches main's CueStyle::builtin_default() exactly — the base layer
// every cue resolves against before @ defaults and cue overrides apply.
const BUILTIN_STYLE = {
    font: 'Segoe UI',
    size: '32px',
    color: '#FFFFFF',
    bold: false,
    italic: false,
    align: 'center',
    posX: 50,
    posY: 85,
    outline: false,
    outlineColor: '#000000',
    shadow: true,
};

// Only these 7 are valid @directives / project-wide defaults in the
// grammar — bold/italic/pos have no @ form, they're builtin-only.
const DEFAULT_KEYS = ['font', 'size', 'color', 'align', 'outline', 'outlineColor', 'shadow'];

// The 5 fonts main's overlay renderer guarantees (ship with Windows
// itself) — kept identical here so the editor's live preview and the
// runtime's actual output never drift apart.
const CURATED_FONTS = ['Segoe UI', 'Impact', 'Georgia', 'Consolas', 'Comic Sans MS'];

function defaultProjectDefaults() {
    const d = {};
    for (const key of DEFAULT_KEYS) d[key] = BUILTIN_STYLE[key];
    return d;
}

// Sparse-over-defaults-over-builtin — the only place these three layers
// get merged; never mutates the stored sparse style. Rendering-only.
function resolveStyle(cue, defaults) {
    return { ...BUILTIN_STYLE, ...defaults, ...cue.style };
}

let idCounter = 0;
function generateCueId() {
    idCounter += 1;
    return `cue-${Date.now().toString(36)}-${idCounter}`;
}

class ClyrParseError extends Error {
    constructor(line, message) {
        super(line > 0 ? `line ${line}: ${message}` : message);
        this.line = line;
        this.rawMessage = message;
    }
}
function fail(lineNo, message) {
    throw new ClyrParseError(lineNo, message);
}

// ── validators (ported from src/clyr.rs's validate_*/parse_bool) ────
const SIZE_UNITS = ['px', 'em', 'rem', '%', 'vw', 'vh'];
function validateSize(s) {
    for (const unit of SIZE_UNITS) {
        if (s.endsWith(unit)) {
            const num = s.slice(0, s.length - unit.length);
            if (num.trim() !== '' && !Number.isNaN(Number(num))) return true;
        }
    }
    return false;
}

function isHexColor(s) {
    if (!s.startsWith('#')) return false;
    const hex = s.slice(1);
    return (hex.length === 3 || hex.length === 6 || hex.length === 8) && /^[0-9a-fA-F]+$/.test(hex);
}
const NAMED_COLORS = [
    'white', 'black', 'red', 'green', 'blue', 'yellow', 'cyan', 'magenta',
    'gray', 'grey', 'orange', 'purple', 'pink', 'brown', 'transparent', 'gold',
];
function validateColor(s) {
    if (isHexColor(s)) return true;
    return NAMED_COLORS.includes(s.toLowerCase());
}

function validateAlign(s) {
    return s === 'left' || s === 'center' || s === 'right';
}

function parseBoolValue(s) {
    const t = s.trim();
    if (t === 'true') return true;
    if (t === 'false') return false;
    return undefined;
}

function stripQuotes(s) {
    return s.trim().replace(/^"+|"+$/g, '');
}

// Quote-aware top-level comma split — a comma inside "..." (e.g. the
// nested pos: "x:50, y:50" string) is not a field separator. Reused for
// both the outer { } style block and the inner pos string, same as
// main's split_top_level.
function splitTopLevel(s) {
    const out = [];
    let start = 0;
    let inQuotes = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '"') {
            inQuotes = !inQuotes;
        } else if (c === ',' && !inQuotes) {
            const piece = s.slice(start, i).trim();
            if (piece) out.push(piece);
            start = i + 1;
        }
    }
    const tail = s.slice(start).trim();
    if (tail) out.push(tail);
    return out;
}

function findCloseBrace(s) {
    let inQuotes = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '"') inQuotes = !inQuotes;
        else if (c === '}' && !inQuotes) return i;
    }
    return -1;
}

// ── timestamps: mm:ss.xxx <-> seconds ───────────────────────
// Ported from parse_lrc_timestamp: replace the FIRST ':' with '.', then
// split into at most 3 pieces (extra dots stay glued to the 3rd piece).
function parseTimestamp(tag) {
    const colonIdx = tag.indexOf(':');
    const normalized = colonIdx === -1 ? tag : tag.slice(0, colonIdx) + '.' + tag.slice(colonIdx + 1);
    const firstDot = normalized.indexOf('.');
    if (firstDot === -1) return null; // need at least "mm.ss"
    const mm = normalized.slice(0, firstDot);
    const rest = normalized.slice(firstDot + 1);
    const secondDot = rest.indexOf('.');
    const ss = secondDot === -1 ? rest : rest.slice(0, secondDot);
    const frac = secondDot === -1 ? undefined : rest.slice(secondDot + 1);

    if (mm.trim() === '' || Number.isNaN(Number(mm))) return null;
    if (ss.trim() === '' || Number.isNaN(Number(ss))) return null;
    let fraction = 0;
    if (frac !== undefined) {
        const f = Number('0.' + frac);
        if (Number.isNaN(f)) return null;
        fraction = f;
    }
    return Number(mm) * 60 + Number(ss) + fraction;
}

// Integer-millisecond arithmetic throughout (not floating seconds) so
// minute/second rollover can't produce a "60.000 seconds" artifact from
// floating-point rounding.
function formatTimestamp(totalSeconds) {
    const totalMs = Math.max(0, Math.round(totalSeconds * 1000));
    const minutes = Math.floor(totalMs / 60000);
    const remMs = totalMs - minutes * 60000;
    const wholeSeconds = Math.floor(remMs / 1000);
    const fracMs = remMs - wholeSeconds * 1000;
    return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(fracMs).padStart(3, '0')}`;
}

// ── pos: "x:N, y:N" ──────────────────────────────────────────
function parsePosValue(raw, lineNo) {
    const inner = stripQuotes(raw);
    let x, y;
    for (const part of splitTopLevel(inner)) {
        const colonIdx = part.indexOf(':');
        if (colonIdx === -1) fail(lineNo, `malformed pos component '${part}'`);
        const k = part.slice(0, colonIdx).trim();
        const vStr = part.slice(colonIdx + 1).trim();
        const v = Number(vStr);
        if (vStr === '' || Number.isNaN(v)) fail(lineNo, `pos.${k} is not numeric`);
        const clamped = Math.min(100, Math.max(0, v));
        if (k === 'x') x = clamped;
        else if (k === 'y') y = clamped;
        else fail(lineNo, `unknown pos key '${k}'`);
    }
    if (x === undefined || y === undefined) fail(lineNo, 'pos requires both x and y');
    return { x, y };
}

// ── @directive -> ProjectDefaults ───────────────────────────
function applyDirective(rest, defaults, lineNo) {
    const colonIdx = rest.indexOf(':');
    if (colonIdx === -1) fail(lineNo, "malformed @directive, expected '@key: value'");
    const key = rest.slice(0, colonIdx).trim();
    const value = stripQuotes(rest.slice(colonIdx + 1));

    switch (key) {
        case 'font':
            defaults.font = value;
            break;
        case 'size':
            if (!validateSize(value)) fail(lineNo, `invalid size '${value}' (expected a number followed by px/em/rem/%/vw/vh)`);
            defaults.size = value;
            break;
        case 'color':
            if (!validateColor(value)) fail(lineNo, `invalid color '${value}' (expected #RGB, #RRGGBB, #RRGGBBAA, or a basic color name)`);
            defaults.color = value;
            break;
        case 'align': {
            const v = value.toLowerCase();
            if (!validateAlign(v)) fail(lineNo, `invalid align '${v}' (expected left/center/right)`);
            defaults.align = v;
            break;
        }
        case 'outline': {
            const b = parseBoolValue(value);
            if (b === undefined) fail(lineNo, `expected true/false, got '${value.trim()}'`);
            defaults.outline = b;
            break;
        }
        case 'outlineColor':
            if (!validateColor(value)) fail(lineNo, `invalid color '${value}' (expected #RGB, #RRGGBB, #RRGGBBAA, or a basic color name)`);
            defaults.outlineColor = value;
            break;
        case 'shadow': {
            const b = parseBoolValue(value);
            if (b === undefined) fail(lineNo, `expected true/false, got '${value.trim()}'`);
            defaults.shadow = b;
            break;
        }
        default:
            fail(lineNo, `unknown @directive '@${key}' (expected font/size/color/align/outline/outlineColor/shadow)`);
    }
}

// ── { style block } -> sparse per-cue style ─────────────────
function parseStyleBlock(block, lineNo) {
    const style = {};
    let fadeMs;
    for (const part of splitTopLevel(block)) {
        const colonIdx = part.indexOf(':');
        if (colonIdx === -1) fail(lineNo, `malformed style entry '${part}'`);
        const key = part.slice(0, colonIdx).trim();
        const value = part.slice(colonIdx + 1).trim();

        switch (key) {
            case 'font':
                style.font = stripQuotes(value);
                break;
            case 'size': {
                const v = stripQuotes(value);
                if (!validateSize(v)) fail(lineNo, `invalid size '${v}' (expected a number followed by px/em/rem/%/vw/vh)`);
                style.size = v;
                break;
            }
            case 'color': {
                const v = stripQuotes(value);
                if (!validateColor(v)) fail(lineNo, `invalid color '${v}' (expected #RGB, #RRGGBB, #RRGGBBAA, or a basic color name)`);
                style.color = v;
                break;
            }
            case 'bold': {
                const b = parseBoolValue(value);
                if (b === undefined) fail(lineNo, `expected true/false, got '${value}'`);
                style.bold = b;
                break;
            }
            case 'italic': {
                const b = parseBoolValue(value);
                if (b === undefined) fail(lineNo, `expected true/false, got '${value}'`);
                style.italic = b;
                break;
            }
            case 'align': {
                const v = stripQuotes(value).toLowerCase();
                if (!validateAlign(v)) fail(lineNo, `invalid align '${v}' (expected left/center/right)`);
                style.align = v;
                break;
            }
            case 'pos': {
                const { x, y } = parsePosValue(value, lineNo);
                style.posX = x;
                style.posY = y;
                break;
            }
            case 'outline': {
                const b = parseBoolValue(value);
                if (b === undefined) fail(lineNo, `expected true/false, got '${value}'`);
                style.outline = b;
                break;
            }
            case 'outlineColor': {
                const v = stripQuotes(value);
                if (!validateColor(v)) fail(lineNo, `invalid color '${v}' (expected #RGB, #RRGGBB, #RRGGBBAA, or a basic color name)`);
                style.outlineColor = v;
                break;
            }
            case 'shadow': {
                const b = parseBoolValue(value);
                if (b === undefined) fail(lineNo, `expected true/false, got '${value}'`);
                style.shadow = b;
                break;
            }
            case 'fade': {
                const n = Number(value);
                if (value.trim() === '' || Number.isNaN(n) || n < 0 || !Number.isInteger(n)) {
                    fail(lineNo, `fade value '${value}' is not a non-negative integer`);
                }
                fadeMs = n;
                break;
            }
            default:
                fail(lineNo, `unknown style key '${key}'`);
        }
    }
    return { style, fadeMs };
}

// ── [start] -> [end] { style } text ─────────────────────────
function parseCueLine(line, lineNo) {
    const rest0 = line.slice(1); // skip leading '[' (caller already confirmed it's there)
    const close1 = rest0.indexOf(']');
    if (close1 === -1) fail(lineNo, "missing closing ']' for start timestamp");
    const startTag = rest0.slice(0, close1);
    const start = parseTimestamp(startTag);
    if (start === null) fail(lineNo, `invalid start timestamp '${startTag}'`);
    let rest = rest0.slice(close1 + 1).replace(/^\s+/, '');

    if (!rest.startsWith('->')) fail(lineNo, "expected '->' between start and end timestamps");
    rest = rest.slice(2).replace(/^\s+/, '');

    if (!rest.startsWith('[')) fail(lineNo, "expected '[' before end timestamp");
    rest = rest.slice(1);
    const close2 = rest.indexOf(']');
    if (close2 === -1) fail(lineNo, "missing closing ']' for end timestamp");
    const endTag = rest.slice(0, close2);
    const end = parseTimestamp(endTag);
    if (end === null) fail(lineNo, `invalid end timestamp '${endTag}'`);
    rest = rest.slice(close2 + 1).replace(/^\s+/, '');

    if (end <= start) {
        fail(lineNo, `end timestamp (${end.toFixed(2)}s) must be after start (${start.toFixed(2)}s)`);
    }

    let style = {};
    let fadeMs;
    let textPart = rest;
    if (rest.startsWith('{')) {
        const blockRest = rest.slice(1);
        const closeIdx = findCloseBrace(blockRest);
        if (closeIdx === -1) fail(lineNo, "missing closing '}' for style block");
        const blockStr = blockRest.slice(0, closeIdx);
        const parsed = parseStyleBlock(blockStr, lineNo);
        style = parsed.style;
        fadeMs = parsed.fadeMs;
        textPart = blockRest.slice(closeIdx + 1).replace(/^\s+/, '');
    }

    const text = textPart.trim();
    if (text === '') fail(lineNo, 'cue has no text');
    if ([...text].length > MAX_CUE_TEXT_LEN) fail(lineNo, `cue text exceeds ${MAX_CUE_TEXT_LEN} characters`);

    return { id: generateCueId(), start, end, text, style, fadeMs };
}

// ── top-level parse ──────────────────────────────────────────
// Returns { ok: true, defaults, cues } or { ok: false, error: { line, message } }
// — fails at the FIRST bad line, same as main's Rust parser, so "valid up
// to line X" here means the same thing it would in the main app's own
// Add-entry form.
function parseClyr(source) {
    try {
        const byteLen = new TextEncoder().encode(source).length;
        if (byteLen > MAX_SOURCE_BYTES) {
            fail(0, `.clyr file exceeds the ${Math.floor(MAX_SOURCE_BYTES / 1024)}KB size limit`);
        }

        const defaults = defaultProjectDefaults();
        const cues = [];
        const lines = source.split('\n');

        for (let idx = 0; idx < lines.length; idx++) {
            const lineNo = idx + 1;
            const line = lines[idx].trim();

            if (line === '' || line.startsWith('//')) continue;

            if (line.startsWith('@')) {
                applyDirective(line.slice(1), defaults, lineNo);
                continue;
            }

            if (line.startsWith('[')) {
                if (cues.length >= MAX_CUES) fail(lineNo, `exceeds the ${MAX_CUES}-cue limit`);
                cues.push(parseCueLine(line, lineNo));
                continue;
            }

            fail(lineNo, 'expected a //comment, @directive, or [start] -> [end] cue line');
        }

        cues.sort((a, b) => a.start - b.start);
        return { ok: true, defaults, cues };
    } catch (e) {
        if (e instanceof ClyrParseError) {
            return { ok: false, error: { line: e.line, message: e.rawMessage } };
        }
        throw e;
    }
}

// ── serialize: ProjectDefaults + sparse cues -> .clyr text ──
function serializeStyleBlock(style) {
    const parts = [];
    if (style.font !== undefined) parts.push(`font: "${style.font}"`);
    if (style.size !== undefined) parts.push(`size: ${style.size}`);
    if (style.color !== undefined) parts.push(`color: "${style.color}"`);
    if (style.bold !== undefined) parts.push(`bold: ${style.bold}`);
    if (style.italic !== undefined) parts.push(`italic: ${style.italic}`);
    if (style.align !== undefined) parts.push(`align: ${style.align}`);
    if (style.posX !== undefined && style.posY !== undefined) {
        parts.push(`pos: "x:${style.posX}, y:${style.posY}"`);
    }
    if (style.outline !== undefined) parts.push(`outline: ${style.outline}`);
    if (style.outlineColor !== undefined) parts.push(`outlineColor: "${style.outlineColor}"`);
    if (style.shadow !== undefined) parts.push(`shadow: ${style.shadow}`);
    return parts.join(', ');
}

function serializeClyr(defaults, cues) {
    const lines = [
        `@font: "${defaults.font}"`,
        `@size: ${defaults.size}`,
        `@color: "${defaults.color}"`,
        `@align: ${defaults.align}`,
        `@outline: ${defaults.outline}`,
        `@outlineColor: "${defaults.outlineColor}"`,
        `@shadow: ${defaults.shadow}`,
        '',
    ];

    const sorted = [...cues].sort((a, b) => a.start - b.start);
    for (const cue of sorted) {
        const startTag = formatTimestamp(cue.start);
        const endTag = formatTimestamp(cue.end);
        const styleStr = serializeStyleBlock(cue.style);
        const stylePart = styleStr ? ` { ${styleStr} }` : '';
        lines.push(`[${startTag}] -> [${endTag}]${stylePart} ${cue.text}`);
    }

    return lines.join('\n') + '\n';
}
