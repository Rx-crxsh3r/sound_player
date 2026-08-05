# 🎵 SoundwaveOverlay

![Rust](https://img.shields.io/badge/rust-1.70+-orange.svg)
![Tauri](https://img.shields.io/badge/tauri-v2-blue.svg)
![Tokio](https://img.shields.io/badge/tokio-1.x-purple.svg)
    <!-- very cute badges. this message is hidden pls go away -->


*A minimalist media overlay app built with Rust; customizable, snappy, and entirely yours ;)*  
_(slogan still being worked on)_


## Overview

**SoundwaveOverlay** (~ working title ~) is a lightweight desktop overlay that displays media information (like the current song, artist, and album art) using system-level integrations -- no logins, no trackers, no nonsense. 

It's being built in **Rust** with a frontend powered by **Tauri**, making it ultra-performant and cross-platform.

> ⚠️ This project is a **WIP** and serves as a learning playground for me to deepen my understanding of Rust and system-level programming. Working on it in my free time, progress might be slow.

## Why I'm Building This

- To explore **Rust**: its ownership model, performance, safety, and tooling.
- To build a real-world project with clean architecture and customizable UI.
- To learn how to interact with OS-level media APIs (SMTC, MPRIS, etc.).

## Features (Planned)

- 🖥️ Transparent, click-through UI overlay
- ⚙️ Fully customizable settings with live previews
- 🎨 Template-based theming (dark/light/custom CSS)
- 🔄 Real-time system media info (Spotify, VLC, browsers, etc.)
- 🌍 Cross-platform support (Windows, macOS, Linux)

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
([public key](RELEASE_SIGNING_KEY.asc))

## Contributing / Feedback

I’d love to hear your thoughts!

- Suggestions?
- Criticism?
- Code pointers?
- Just wanna say hi?

Open an issue or start a discussion! This is a *passion project* , and all input is welcome as I learn and grow with Rust.

---

> Made with 🦀 and 🎧
