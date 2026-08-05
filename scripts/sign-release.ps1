<#
.SYNOPSIS
  Computes SHA256 checksums for every file in a release directory and
  GPG-signs the checksum file with the project's release key.

.DESCRIPTION
  Run this after `cargo tauri build` against the directory containing the
  built installer(s)/binary. It does NOT build anything itself and does
  NOT touch which branch you're on — point it at whichever app's release
  output you just built (Audio-Overlay on `main`, Clyr Studio on
  `subtitle_creator`).

  Produces:
    SHA256SUMS.txt       one line per file: "<hash>  <filename>"
    SHA256SUMS.txt.asc   detached ASCII-armored GPG signature over that file

  The private key has no passphrase (a deliberate choice for a
  release-checksum-signing key that only ever runs locally, not something
  protecting funds/personal data) and never leaves this machine — signing
  is local-only, not wired into any CI.

.PARAMETER ReleaseDir
  Folder containing the built release artifacts to checksum and sign.

.EXAMPLE
  .\scripts\sign-release.ps1 -ReleaseDir "target\release\bundle\nsis"
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseDir
)

$ErrorActionPreference = "Stop"

# Fingerprint of the "Rx-crxsh3r <ahmed.ab2824@gmail.com>" release key —
# public half is committed at RELEASE_SIGNING_KEY.asc for anyone
# verifying a release to import.
$KeyFingerprint = "CF8F2D55C53029B6A629253E3B550FAE05AC57C2"

# gpg is commonly only on Git Bash's PATH (bundled with Git for Windows),
# not PowerShell's — rather than requiring a permanent PATH edit just to
# run this script, look in the usual install locations too.
function Resolve-GpgPath {
    $cmd = Get-Command gpg -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        "$env:ProgramFiles\Git\usr\bin\gpg.exe",
        "${env:ProgramFiles(x86)}\Git\usr\bin\gpg.exe",
        "$env:ProgramFiles\GnuPG\bin\gpg.exe",
        "${env:ProgramFiles(x86)}\GnuPG\bin\gpg.exe"
    )
    foreach ($path in $candidates) {
        if (Test-Path $path) { return $path }
    }
    return $null
}

$gpgPath = Resolve-GpgPath
if (-not $gpgPath) {
    Write-Error "gpg.exe not found on PATH or in common install locations (Git for Windows, GnuPG4Win). Install one of those, or add gpg to PATH, then retry."
    exit 1
}

# Resolve to an absolute path up front and use that everywhere below —
# Test-Path/Get-ChildItem resolve a relative path via PowerShell's own
# $PWD, but the raw [System.IO.File] call further down resolves relative
# paths via .NET's Environment.CurrentDirectory instead, which can drift
# out of sync with $PWD (a known PowerShell quirk, e.g. after `cd ..`) —
# that split caused SHA256SUMS.txt to be written under the wrong
# directory entirely. Resolving once here avoids relying on either.
try {
    $ReleaseDir = (Resolve-Path -Path $ReleaseDir -ErrorAction Stop).Path
} catch {
    Write-Error "Release directory not found: $ReleaseDir"
    exit 1
}

$files = Get-ChildItem -Path $ReleaseDir -File | Where-Object { $_.Name -notin @("SHA256SUMS.txt", "SHA256SUMS.txt.asc") }
if ($files.Count -eq 0) {
    Write-Error "No files found in '$ReleaseDir' to checksum."
    exit 1
}

$lines = foreach ($f in $files) {
    $hash = (Get-FileHash -Path $f.FullName -Algorithm SHA256).Hash.ToLower()
    "$hash  $($f.Name)"
}

$sumsPath = Join-Path $ReleaseDir "SHA256SUMS.txt"
# Explicit UTF-8 without BOM — a leading BOM can trip up strict
# `sha256sum -c` parsing on Linux when someone verifies the release there.
[System.IO.File]::WriteAllLines($sumsPath, $lines, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Wrote checksums for $($files.Count) file(s) -> $sumsPath"

& $gpgPath --local-user $KeyFingerprint --armor --detach-sign --yes $sumsPath
if ($LASTEXITCODE -ne 0) {
    Write-Error "gpg signing failed (exit $LASTEXITCODE)."
    exit 1
}

Write-Host "Signed -> $sumsPath.asc"
