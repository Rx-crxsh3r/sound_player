# .clyr format

Custom lyrics/captions for the overlay. Upload via Settings > Custom Lyrics.

## Structure

```
// comment
@font: "Segoe UI"
@size: 32px
@color: "#FFFFFF"
@align: center
@shadow: true
@outline: false

[00:12.50] -> [00:15.00] { size: 48px, bold: true, color: "#FF5555", pos: "x:50, y:50" } Some text
[00:15.20] -> [00:18.00] { italic: true, outline: true, outlineColor: "#000000" } More text
```

- `//` starts a comment line.
- `@key: value` sets a global default, used by any cue that doesn't override that property. Valid keys: `font`, `size`, `color`, `align`, `outline`, `outlineColor`, `shadow`.
- A cue line is `[start] -> [end] { optional style } text`. Timestamps are `mm:ss.xx`. Everything after the `}` (or after `[end]` if there's no style block) is the cue's text, to end of line.
- **Multiple cues can be on screen at once** if their `[start,end)` windows overlap — there's no requirement that cues be sequential/non-overlapping. Up to 20 cues can render concurrently; beyond that, extras are silently dropped rather than erroring.
- Cues don't need to be written in time order; they're sorted on load.

## Style keys

| Key | Value | Notes |
|---|---|---|
| `font` | quoted string | any font name. 5 fonts are guaranteed to render correctly since they ship with Windows itself: `"Segoe UI"` (default), `"Impact"`, `"Georgia"`, `"Consolas"`, `"Comic Sans MS"`. Any other name is passed through with a generic fallback, so it may render differently (or fall back) depending on the machine. |
| `size` | number + unit | `px`, `em`, `rem`, `%`, `vw`, or `vh` — e.g. `48px` |
| `color` | quoted hex or name | `#RGB`, `#RRGGBB`, `#RRGGBBAA`, or a basic color name |
| `bold` | `true` / `false` | |
| `italic` | `true` / `false` | |
| `align` | `left` / `center` / `right` | |
| `pos` | quoted `"x:N, y:N"` | **percentage of screen, 0–100.** Not pixels, not `"center"`. Omit it and a cue falls back to `x:50, y:85`. |
| `outline` | `true` / `false` | Text outline/stroke. Fixed width (not adjustable) — only on/off and `outlineColor` are yours to set. **Defaults to `false`.** |
| `outlineColor` | quoted hex or name | Same value format as `color`. Only meaningful when `outline: true`. |
| `shadow` | `true` / `false` | A fixed-color legibility drop-shadow behind the text — no color control, on/off only. **Defaults to `true`** (a file that never mentions `shadow` still gets the shadow, matching this app's original always-on behavior). |

## Not supported (yet)

- **Animation/motion.** There's no `anim` property. A cue is static — same position and style for its whole `[start] -> [end]` window. "Movement" has to be faked with several short, rapidly-sequenced cues at different positions (see `samples/believer.clyr`).
- **`fade`** is parsed (so files that include it don't error) but has no visual effect yet.
- **Off-screen positions.** `x`/`y` are clamped to 0–100, so nothing can start or end past the screen edge.
- **True bundled/embedded fonts.** The 5 guaranteed fonts above are relied on being pre-installed on Windows, not shipped as font files with the app — so they won't look identical on a future Linux build unless equivalent system fonts happen to be installed there too.
- **Adjustable outline width.** Fixed thickness only.

## Errors

Unknown `@key`, unknown per-cue style key, or a malformed line fails to load with a line number and message shown in the Add form — fix that line and re-upload.

## Example

See `samples/believer.clyr` for a full-song example, including the word-by-word cascading style used for its chorus.
