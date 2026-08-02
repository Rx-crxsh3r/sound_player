use std::fs;
use std::path::{Path, PathBuf};

fn copy_dir_contents(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !src.exists() {
        return Ok(());
    }

    fs::create_dir_all(dst)?;

    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let target = dst.join(entry.file_name());

        if path.is_dir() {
            copy_dir_contents(&path, &target)?;
        } else {
            fs::copy(&path, &target)?;
        }
    }

    Ok(())
}

fn copy_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(src, dst)?;
    Ok(())
}

fn sync_frontend_assets() -> std::io::Result<()> {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let dist_dir = manifest_dir.join("dist");

    fs::create_dir_all(&dist_dir)?;

    for file in ["index.html", "settings.html", "bar_button.html", "popup.html"] {
        let src = manifest_dir.join(file);
        let dst = dist_dir.join(file);
        copy_file(&src, &dst)?;
    }

    for dir in ["css", "js", "icons"] {
        copy_dir_contents(&manifest_dir.join(dir), &dist_dir.join(dir))?;
    }

    Ok(())
}

fn main() {
    for path in [
        "index.html",
        "settings.html",
        "bar_button.html",
        "popup.html",
        "css",
        "js",
        "icons",
        "tauri.conf.json",
        "build.rs",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }

    let _ = sync_frontend_assets();
    tauri_build::build()
}