# 🎬 Clyr Studio

A standalone visual editor for authoring `.clyr` files — timed, styled
lyric/caption overlays for [Audio-Overlay](https://github.com/Rx-crxsh3r/sound_player)'s
Custom Lyrics feature (see the `main` branch of this same repo).

Open a song, drop text boxes wherever you want them on screen while it
plays, style each one, and export a `.clyr` file the overlay app can play
back exactly as designed — instead of hand-timing a text file against a
song by guesswork.

> ⚠️ Same spirit as the overlay app: a work in progress, built as a
> companion tool rather than a general-purpose subtitle editor.

## Features

- Drag-and-drop box placement synced to real audio playback, with
  adjustable playback speed (down to 0.1x) for placing cues precisely
- Multiple boxes on screen at once, each independently timed and styled
- Per-box font (5 curated choices or free text), size, color, bold/
  italic, alignment, outline (color + fixed width), and drop shadow
- Double-click a box to edit its text in place; copy/paste and a
  Duplicate button for quickly reusing a styled box elsewhere in the
  timeline
- A live "Project Defaults" panel — the `.clyr` file's `@`-directive
  fallback style, inherited by any box that doesn't override it
- Full undo history and autosave, so a session survives a crash/restart
- Round-trip: open an existing `.clyr` file back into the visual timeline
  to keep revising it, not just create-and-export
- Native Save/Open dialogs for project files (`.clyrproj`); `.clyr`
  import/export uses plain file pickers

## Building

Standard Tauri v2 workflow:

```
cargo tauri dev       # dev
cargo tauri build     # release build
```

## Verifying a release

Releases include `SHA256SUMS.txt` and a detached signature
(`SHA256SUMS.txt.asc`) so you can confirm a download is exactly what was
built here and hasn't been altered or substituted.

```
gpg --import RELEASE_SIGNING_KEY.asc      # once
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt               # or Get-FileHash on Windows
```

Key: `Rx-crxsh3r <ahmed.ab2824@gmail.com>`
Fingerprint: `CF8F2D55 C53029B6 A629253E 3B550FAE 05AC57C2`
([public key](RELEASE_SIGNING_KEY.asc)) — same release key used for
Audio-Overlay on the `main` branch.

## Contributing / Feedback

Suggestions, criticism, code pointers, or just saying hi — open an issue
or start a discussion.

---

> Made with 🦀 and 🎧
