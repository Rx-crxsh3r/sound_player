// ── .clyr custom lyrics format ──────────────────────────────
// A small hand-authored timed-cue format (spec supplied externally, not
// designed in this codebase): `@key: value` global style directives,
// `//` comments, and `[start] -> [end] { style overrides } text` cue
// lines. Hand-rolled parser, matching the existing LRC parser's style
// (no regex/nom dependency) — see parse_lrc/parse_lrc_timestamp in
// src/main.rs, whose timestamp parser this reuses verbatim.
//
// The cascade (global @ defaults merged with each cue's own overrides) is
// resolved ONCE here, at parse time — every cue's `style` field is already
// fully baked, so the frontend never re-resolves anything per frame.
//
// Unknown @keys, unknown per-cue style keys, and any line that doesn't
// match comment/@directive/[cue] shape are parse errors with a 1-indexed
// line number — this is a hand-authored format, so a user gets told
// exactly what's wrong rather than having a mistake silently swallowed.

use serde::{Deserialize, Serialize};

pub(crate) const MAX_SOURCE_BYTES: usize = 256 * 1024;
pub(crate) const MAX_CUES: usize = 2000;
pub(crate) const MAX_CUE_TEXT_LEN: usize = 500;

#[derive(Debug)]
pub(crate) struct ClyrParseError {
    pub(crate) line: usize,
    pub(crate) message: String,
}

impl std::fmt::Display for ClyrParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.line == 0 {
            write!(f, "{}", self.message)
        } else {
            write!(f, "line {}: {}", self.line, self.message)
        }
    }
}

fn err(line_no: usize, message: impl Into<String>) -> ClyrParseError {
    ClyrParseError { line: line_no, message: message.into() }
}

// Fully-resolved (cascade already applied) per-cue style — every field is
// a plain string/bool/percentage the frontend can apply directly via
// individual CSSOM property assignments (never `style.cssText`, which
// would let an unvalidated value inject unrelated CSS declarations).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CueStyle {
    pub(crate) font:  String,
    pub(crate) size:  String, // raw CSS value w/ unit, e.g. "48px" — validated at parse time
    pub(crate) color: String, // "#RRGGBB"/"#RGB"/"#RRGGBBAA" or a basic named color
    pub(crate) bold:  bool,
    pub(crate) italic: bool,
    pub(crate) align: String, // "left" | "center" | "right"
    pub(crate) pos_x: f32,    // percent of screen width, 0-100
    pub(crate) pos_y: f32,    // percent of screen height, 0-100
    pub(crate) outline: bool,          // opt-in; fixed width, user-chosen color
    pub(crate) outline_color: String,  // "#RRGGBB"/etc — meaningless when outline is false
    pub(crate) shadow: bool,           // on/off only, fixed color — legibility aid, opt-out
}

impl CueStyle {
    // No `@pos` directive exists in the grammar (position isn't a
    // sensible whole-file default), so cues that omit `pos` fall back to
    // this builtin placement rather than an @-configurable one.
    //
    // shadow defaults to true (not false, unlike outline) — this preserves
    // every existing .clyr file's current appearance: the renderer used to
    // draw an unconditional drop-shadow, so a file that never mentions
    // `shadow` should keep looking exactly like it did before this field
    // existed. outline is new with no prior on-screen behavior, so it
    // defaults off (opt-in).
    fn builtin_default() -> Self {
        CueStyle {
            font: "Segoe UI".to_string(),
            size: "32px".to_string(),
            color: "#FFFFFF".to_string(),
            bold: false,
            italic: false,
            align: "center".to_string(),
            pos_x: 50.0,
            pos_y: 85.0,
            outline: false,
            outline_color: "#000000".to_string(),
            shadow: true,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClyrCue {
    pub(crate) start: f32,
    pub(crate) end:   f32,
    pub(crate) text:  String,
    pub(crate) style: CueStyle,
    // Parsed but inert this pass — fading/animation is explicitly
    // deferred. Cue-only (no `@fade` global exists), so it doesn't belong
    // on CueStyle's cascade.
    pub(crate) fade_ms: Option<u32>,
}

pub(crate) fn parse_clyr(source: &str) -> Result<Vec<ClyrCue>, ClyrParseError> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(err(0, format!(".clyr file exceeds the {}KB size limit", MAX_SOURCE_BYTES / 1024)));
    }

    let mut defaults = CueStyle::builtin_default();
    let mut cues = Vec::new();

    for (idx, raw_line) in source.lines().enumerate() {
        let line_no = idx + 1;
        let line = raw_line.trim();

        if line.is_empty() || line.starts_with("//") {
            continue;
        }

        if let Some(rest) = line.strip_prefix('@') {
            apply_directive(rest, &mut defaults, line_no)?;
            continue;
        }

        if line.starts_with('[') {
            if cues.len() >= MAX_CUES {
                return Err(err(line_no, format!("exceeds the {MAX_CUES}-cue limit")));
            }
            cues.push(parse_cue_line(line, &defaults, line_no)?);
            continue;
        }

        return Err(err(line_no, "expected a //comment, @directive, or [start] -> [end] cue line"));
    }

    cues.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));
    Ok(cues)
}

fn apply_directive(rest: &str, defaults: &mut CueStyle, line_no: usize) -> Result<(), ClyrParseError> {
    let Some((key, value)) = rest.split_once(':') else {
        return Err(err(line_no, "malformed @directive, expected '@key: value'"));
    };
    let key = key.trim();
    let value = strip_quotes(value);

    match key {
        "font" => defaults.font = value.to_string(),
        "size" => {
            validate_size(value).map_err(|m| err(line_no, m))?;
            defaults.size = value.to_string();
        }
        "color" => {
            validate_color(value).map_err(|m| err(line_no, m))?;
            defaults.color = value.to_string();
        }
        "align" => {
            let v = value.to_lowercase();
            validate_align(&v).map_err(|m| err(line_no, m))?;
            defaults.align = v;
        }
        "outline" => defaults.outline = parse_bool(value, line_no)?,
        "outlineColor" => {
            validate_color(value).map_err(|m| err(line_no, m))?;
            defaults.outline_color = value.to_string();
        }
        "shadow" => defaults.shadow = parse_bool(value, line_no)?,
        other => {
            return Err(err(line_no, format!("unknown @directive '@{other}' (expected font/size/color/align/outline/outlineColor/shadow)")));
        }
    }
    Ok(())
}

fn parse_cue_line(line: &str, defaults: &CueStyle, line_no: usize) -> Result<ClyrCue, ClyrParseError> {
    // [start]
    let rest = &line[1..]; // skip the leading '[' (caller already confirmed it's there)
    let Some(close1) = rest.find(']') else {
        return Err(err(line_no, "missing closing ']' for start timestamp"));
    };
    let start_tag = &rest[..close1];
    let start = crate::parse_lrc_timestamp(start_tag)
        .ok_or_else(|| err(line_no, format!("invalid start timestamp '{start_tag}'")))?;
    let rest = rest[close1 + 1..].trim_start();

    // ->
    let Some(rest) = rest.strip_prefix("->") else {
        return Err(err(line_no, "expected '->' between start and end timestamps"));
    };
    let rest = rest.trim_start();

    // [end]
    let Some(rest) = rest.strip_prefix('[') else {
        return Err(err(line_no, "expected '[' before end timestamp"));
    };
    let Some(close2) = rest.find(']') else {
        return Err(err(line_no, "missing closing ']' for end timestamp"));
    };
    let end_tag = &rest[..close2];
    let end = crate::parse_lrc_timestamp(end_tag)
        .ok_or_else(|| err(line_no, format!("invalid end timestamp '{end_tag}'")))?;
    let rest = rest[close2 + 1..].trim_start();

    if end <= start {
        return Err(err(line_no, format!("end timestamp ({end:.2}s) must be after start ({start:.2}s)")));
    }

    // optional { style block }
    let (style, fade_ms, text_part) = if let Some(block_rest) = rest.strip_prefix('{') {
        let Some(close_idx) = find_close_brace(block_rest) else {
            return Err(err(line_no, "missing closing '}' for style block"));
        };
        let block_str = &block_rest[..close_idx];
        let (style, fade_ms) = parse_style_block(block_str, defaults, line_no)?;
        (style, fade_ms, block_rest[close_idx + 1..].trim_start())
    } else {
        (defaults.clone(), None, rest)
    };

    let text = text_part.trim();
    if text.is_empty() {
        return Err(err(line_no, "cue has no text"));
    }
    if text.chars().count() > MAX_CUE_TEXT_LEN {
        return Err(err(line_no, format!("cue text exceeds {MAX_CUE_TEXT_LEN} characters")));
    }

    Ok(ClyrCue { start, end, text: text.to_string(), style, fade_ms })
}

fn parse_style_block(block: &str, base: &CueStyle, line_no: usize) -> Result<(CueStyle, Option<u32>), ClyrParseError> {
    let mut style = base.clone();
    let mut fade_ms = None;

    for part in split_top_level(block) {
        let Some((key, value)) = part.split_once(':') else {
            return Err(err(line_no, format!("malformed style entry '{part}'")));
        };
        let key = key.trim();
        let value = value.trim();

        match key {
            "font" => style.font = strip_quotes(value).to_string(),
            "size" => {
                let v = strip_quotes(value);
                validate_size(v).map_err(|m| err(line_no, m))?;
                style.size = v.to_string();
            }
            "color" => {
                let v = strip_quotes(value);
                validate_color(v).map_err(|m| err(line_no, m))?;
                style.color = v.to_string();
            }
            "bold" => style.bold = parse_bool(value, line_no)?,
            "italic" => style.italic = parse_bool(value, line_no)?,
            "align" => {
                let v = strip_quotes(value).to_lowercase();
                validate_align(&v).map_err(|m| err(line_no, m))?;
                style.align = v;
            }
            "pos" => {
                let (x, y) = parse_pos_value(value, line_no)?;
                style.pos_x = x;
                style.pos_y = y;
            }
            "outline" => style.outline = parse_bool(value, line_no)?,
            "outlineColor" => {
                let v = strip_quotes(value);
                validate_color(v).map_err(|m| err(line_no, m))?;
                style.outline_color = v.to_string();
            }
            "shadow" => style.shadow = parse_bool(value, line_no)?,
            "fade" => {
                let v: u32 = value
                    .parse()
                    .map_err(|_| err(line_no, format!("fade value '{value}' is not a non-negative integer")))?;
                fade_ms = Some(v);
            }
            other => return Err(err(line_no, format!("unknown style key '{other}'"))),
        }
    }

    Ok((style, fade_ms))
}

fn parse_pos_value(raw: &str, line_no: usize) -> Result<(f32, f32), ClyrParseError> {
    let inner = strip_quotes(raw);
    let (mut x, mut y) = (None, None);

    for part in split_top_level(inner) {
        let Some((k, v)) = part.split_once(':') else {
            return Err(err(line_no, format!("malformed pos component '{part}'")));
        };
        let k = k.trim();
        let v: f32 = v
            .trim()
            .parse()
            .map_err(|_| err(line_no, format!("pos.{k} is not numeric")))?;
        let v = v.clamp(0.0, 100.0);
        match k {
            "x" => x = Some(v),
            "y" => y = Some(v),
            other => return Err(err(line_no, format!("unknown pos key '{other}'"))),
        }
    }

    match (x, y) {
        (Some(x), Some(y)) => Ok((x, y)),
        _ => Err(err(line_no, "pos requires both x and y")),
    }
}

// Splits on top-level commas only — a comma inside a "..." quoted value
// (e.g. the nested pos: "x:50, y:50" string) is not a field separator.
// Reused for both the outer `{ }` style block and the inner `pos` string.
fn split_top_level(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut in_quotes = false;

    for (i, c) in s.char_indices() {
        match c {
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => {
                let piece = s[start..i].trim();
                if !piece.is_empty() { out.push(piece); }
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    let tail = s[start..].trim();
    if !tail.is_empty() { out.push(tail); }
    out
}

// Quote-aware scan for the '}' closing a style block that's already had
// its leading '{' stripped — defensive against a stray '}' ever appearing
// inside a future quoted value.
fn find_close_brace(s: &str) -> Option<usize> {
    let mut in_quotes = false;
    for (i, c) in s.char_indices() {
        match c {
            '"' => in_quotes = !in_quotes,
            '}' if !in_quotes => return Some(i),
            _ => {}
        }
    }
    None
}

fn strip_quotes(s: &str) -> &str {
    s.trim().trim_matches('"')
}

fn parse_bool(s: &str, line_no: usize) -> Result<bool, ClyrParseError> {
    match s.trim() {
        "true" => Ok(true),
        "false" => Ok(false),
        other => Err(err(line_no, format!("expected true/false, got '{other}'"))),
    }
}

fn validate_size(s: &str) -> Result<(), String> {
    const UNITS: [&str; 6] = ["px", "em", "rem", "%", "vw", "vh"];
    for unit in UNITS {
        if let Some(num) = s.strip_suffix(unit) {
            if num.parse::<f32>().is_ok() {
                return Ok(());
            }
        }
    }
    Err(format!("invalid size '{s}' (expected a number followed by px/em/rem/%/vw/vh)"))
}

fn is_hex_color(s: &str) -> bool {
    let Some(hex) = s.strip_prefix('#') else { return false; };
    matches!(hex.len(), 3 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit())
}

fn validate_color(s: &str) -> Result<(), String> {
    if is_hex_color(s) {
        return Ok(());
    }
    const NAMED: [&str; 16] = [
        "white", "black", "red", "green", "blue", "yellow", "cyan", "magenta",
        "gray", "grey", "orange", "purple", "pink", "brown", "transparent", "gold",
    ];
    if NAMED.contains(&s.to_lowercase().as_str()) {
        return Ok(());
    }
    Err(format!("invalid color '{s}' (expected #RGB, #RRGGBB, #RRGGBBAA, or a basic color name)"))
}

fn validate_align(s: &str) -> Result<(), String> {
    if matches!(s, "left" | "center" | "right") {
        Ok(())
    } else {
        Err(format!("invalid align '{s}' (expected left/center/right)"))
    }
}
