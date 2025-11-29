# Packaging Guide

Complete guide for packaging AutoCutStudio with bundled binaries for distribution.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Available Scripts](#available-scripts)
3. [Packaging Workflow](#packaging-workflow)
4. [Platform-Specific Instructions](#platform-specific-instructions)
5. [Troubleshooting](#troubleshooting)

## Quick Start

### For Your Current Platform (macOS ARM64)

```bash
# Option 1: Download binaries and package in one command
npm run clean:package:mac-arm64

# Option 2: Prepare binaries once, then package multiple times
npm run prepare:binaries    # Copy from system
npm run package:mac-arm64   # Package with verification
```

### For Other Platforms

```bash
# Windows (from any platform)
npm run clean:package:win-x64

# Linux (from any platform)
npm run clean:package:linux-x64

# macOS Intel (from any platform)
npm run clean:package:mac-intel
```

### For All Platforms

```bash
# Download binaries for all platforms and package everything
npm run clean:package:all
```

## Available Scripts

### Preparation Scripts

| Script | Description |
|--------|-------------|
| `npm run prepare:binaries` | Copy binaries from current system (macOS only) |
| `npm run prepare:python` | Bundle Python environment (current platform) |
| `npm run download:binaries:mac-arm64` | Download macOS ARM64 binaries |
| `npm run download:binaries:mac-intel` | Download macOS Intel binaries |
| `npm run download:binaries:win-x64` | Download Windows x64 binaries |
| `npm run download:binaries:linux-x64` | Download Linux x64 binaries |
| `npm run download:binaries:all` | Download binaries for all platforms |

### Verification Scripts

| Script | Description |
|--------|-------------|
| `npm run verify:mac-arm64` | Verify macOS ARM64 binaries are ready |
| `npm run verify:mac-intel` | Verify macOS Intel binaries are ready |
| `npm run verify:win-x64` | Verify Windows x64 binaries are ready |
| `npm run verify:linux-x64` | Verify Linux x64 binaries are ready |

### Packaging Scripts (with verification)

| Script | Description |
|--------|-------------|
| `npm run package:mac-arm64` | Package for macOS Apple Silicon |
| `npm run package:mac-intel` | Package for macOS Intel |
| `npm run package:mac` | Package for both macOS architectures |
| `npm run package:win-x64` | Package for Windows 64-bit |
| `npm run package:linux-x64` | Package for Linux 64-bit |
| `npm run package:all` | Package for all platforms |

### Clean Package Scripts (download + package)

| Script | Description |
|--------|-------------|
| `npm run clean:package:mac-arm64` | Download + package macOS ARM64 |
| `npm run clean:package:mac-intel` | Download + package macOS Intel |
| `npm run clean:package:mac` | Download + package both macOS |
| `npm run clean:package:win-x64` | Download + package Windows |
| `npm run clean:package:linux-x64` | Download + package Linux |
| `npm run clean:package:all` | Download + package all platforms |

## Packaging Workflow

### Workflow 1: One-Shot Packaging (Recommended for CI/CD)

Use `clean:package:*` scripts that handle everything:

```bash
# For macOS ARM64
npm run clean:package:mac-arm64

# This does:
# 1. Downloads FFmpeg/FFprobe binaries
# 2. Verifies binaries are present
# 3. Cleans previous builds
# 4. Builds TypeScript and frontend
# 5. Packages the application
```

**Best for:**
- First-time packaging
- CI/CD pipelines
- Packaging for platforms you don't have binaries for yet

### Workflow 2: Incremental Packaging (Recommended for development)

Prepare binaries once, then package multiple times:

```bash
# Step 1: Prepare binaries (once)
npm run prepare:binaries     # For current platform
# or
npm run download:binaries:win-x64  # For other platforms

# Step 2: Optional - Bundle Python (increases size but self-contained)
npm run prepare:python

# Step 3: Package (can repeat this step)
npm run package:mac-arm64

# Make changes to code...

# Package again without re-downloading binaries
npm run package:mac-arm64
```

**Best for:**
- Iterative development
- Testing packaging locally
- When binaries are already downloaded

### Workflow 3: Multi-Platform Release

Package for all platforms at once:

```bash
# Option 1: Download and package everything
npm run clean:package:all

# Option 2: Download all binaries first, then package
npm run download:binaries:all
npm run package:all
```

**Note:** Cross-platform packaging has limitations:
- ✅ Can package macOS on macOS (any arch)
- ✅ Can package Windows from macOS/Linux
- ✅ Can package Linux from macOS/Linux
- ⚠️ Code signing requires the target platform

## Platform-Specific Instructions

### macOS ARM64 (Apple Silicon)

**On Apple Silicon Mac:**
```bash
# Easiest: Use local Homebrew installation
brew install ffmpeg
npm run prepare:binaries
npm run package:mac-arm64
```

**On any platform:**
```bash
# Download is not available (no official static builds)
# Need to copy from Apple Silicon Mac manually
```

**Manual copy:**
```bash
# On Apple Silicon Mac:
cp /opt/homebrew/bin/ffmpeg binaries/darwin-arm64/
cp /opt/homebrew/bin/ffprobe binaries/darwin-arm64/
chmod +x binaries/darwin-arm64/*
```

### macOS Intel

**On Intel Mac:**
```bash
brew install ffmpeg
npm run prepare:binaries
npm run package:mac-intel
```

**On Apple Silicon Mac (using Rosetta):**
```bash
# Install Homebrew for x86_64
arch -x86_64 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install ffmpeg for x86_64
arch -x86_64 /usr/local/bin/brew install ffmpeg

# Prepare and package
npm run prepare:binaries
npm run package:mac-intel
```

**On any platform:**
```bash
# Download is not available (no official static builds)
# Need to copy from Intel Mac manually
```

### Windows x64

**On any platform:**
```bash
# Automatic download available!
npm run clean:package:win-x64
```

This downloads from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (official FFmpeg builds for Windows).

**Manual download:**
1. Download: https://github.com/BtbN/FFmpeg-Builds/releases/latest
2. Extract `ffmpeg.exe` and `ffprobe.exe`
3. Copy to `binaries/win32-x64/`

### Linux x64

**On any platform:**
```bash
# Automatic download available!
npm run clean:package:linux-x64
```

This downloads from [John Van Sickle's static builds](https://johnvansickle.com/ffmpeg/) (popular Linux FFmpeg builds).

**Manual download:**
1. Download: https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
2. Extract `ffmpeg` and `ffprobe`
3. Copy to `binaries/linux-x64/`
4. Make executable: `chmod +x binaries/linux-x64/*`

## Bundling Python (Optional)

By default, the packaged app will use the system's Python installation. To bundle Python for a fully self-contained app:

```bash
# Bundle current platform's Python environment
npm run prepare:python
```

**Pros:**
- ✅ Self-contained app (no dependencies)
- ✅ Guaranteed Python version
- ✅ All packages included

**Cons:**
- ❌ Very large file size (~500MB+ for conda env)
- ❌ Platform-specific (can't cross-compile)
- ❌ Longer build times

**Recommended:** Use system Python for development, bundle Python for distribution.

## Verification

Before packaging, you can verify binaries are ready:

```bash
# Verify specific platform
npm run verify:mac-arm64

# Output:
# ✅ All binaries verified successfully!
#    Ready to package for darwin-arm64
```

Verification checks:
- ✅ Binaries directory exists
- ✅ ffmpeg and ffprobe are present
- ✅ Binaries are executable (Unix-like)
- ⚠️ Python runtime (optional)

## Output Locations

After packaging, find your distributable files in:

```bash
dist-electron/
├── mac-arm64/
│   └── AutoCutStudio.app       # macOS ARM64 app
├── mac-x64/
│   └── AutoCutStudio.app       # macOS Intel app
├── win-unpacked/
│   └── AutoCutStudio.exe       # Windows unpacked
├── linux-unpacked/
│   └── autocutstudio           # Linux unpacked
├── AutoCutStudio-1.0.0-arm64.dmg    # macOS ARM64 installer
├── AutoCutStudio-1.0.0-x64.dmg      # macOS Intel installer
├── AutoCutStudio Setup 1.0.0.exe    # Windows installer
└── AutoCutStudio-1.0.0.AppImage     # Linux AppImage
```

## Testing Packaged Apps

### macOS

```bash
# Open the app
open dist-electron/mac-arm64/AutoCutStudio.app

# Check logs
tail -f ~/Library/Logs/AutoCutStudio/main.log

# Verify bundled binaries are being used
cat ~/Library/Logs/AutoCutStudio/main.log | grep "Found bundled"
```

### Windows

```powershell
# Run the app
dist-electron\win-unpacked\AutoCutStudio.exe

# Check logs
type %APPDATA%\AutoCutStudio\logs\main.log
```

### Linux

```bash
# Run the AppImage
./dist-electron/AutoCutStudio-1.0.0.AppImage

# Check logs
tail -f ~/.config/AutoCutStudio/logs/main.log
```

## Troubleshooting

### Verification Fails

```bash
❌ Verification failed with 1 error(s)
   ffmpeg not found
```

**Solution:**
```bash
# Download binaries for the platform
npm run download:binaries:mac-arm64

# Or copy from system (macOS only)
npm run prepare:binaries
```

### "local: can only be used in a function"

This error appears if scripts were not made executable.

**Solution:**
```bash
chmod +x scripts/*.sh
```

### Binaries Not Found in Packaged App

Check the app logs to see if binaries are being resolved:

```bash
# macOS
cat ~/Library/Logs/AutoCutStudio/main.log | grep -i binary

# Should see:
# Found bundled binary: /path/to/binaries/ffmpeg
```

**Solution:**
1. Verify binaries exist: `npm run verify:mac-arm64`
2. Check `binaries/` is in `extraResources` (package.json)
3. Ensure binaries are executable: `chmod +x binaries/darwin-arm64/*`

### Package Size Too Large

Bundled Python adds ~500MB+ to package size.

**Solutions:**
1. Don't bundle Python (use system Python)
2. Use python-build-standalone instead of conda
3. Use PyInstaller to create single Python executable

### Cross-Platform Signing

Code signing requires the target platform:
- macOS signing requires macOS + Developer ID
- Windows signing requires Windows + certificate
- Linux doesn't require signing

**For CI/CD:**
Use platform-specific runners (e.g., macOS runner for macOS builds)

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Build and Release

on:
  push:
    tags:
      - 'v*'

jobs:
  build-mac-arm64:
    runs-on: macos-latest-xlarge  # Apple Silicon runner
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm install
      - run: npm run clean:package:mac-arm64
      - uses: actions/upload-artifact@v3
        with:
          name: mac-arm64
          path: dist-electron/*.dmg

  build-mac-intel:
    runs-on: macos-latest  # Intel runner
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm install
      - run: npm run clean:package:mac-intel
      - uses: actions/upload-artifact@v3
        with:
          name: mac-intel
          path: dist-electron/*.dmg

  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm install
      - run: npm run clean:package:win-x64
      - uses: actions/upload-artifact@v3
        with:
          name: windows
          path: dist-electron/*.exe

  build-linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm install
      - run: npm run clean:package:linux-x64
      - uses: actions/upload-artifact@v3
        with:
          name: linux
          path: dist-electron/*.AppImage
```

## Summary

**For quick packaging:**
```bash
npm run clean:package:mac-arm64  # Downloads + packages
```

**For iterative development:**
```bash
npm run prepare:binaries          # Once
npm run package:mac-arm64         # Many times
```

**For multi-platform release:**
```bash
npm run clean:package:all         # All platforms
```

**For verification:**
```bash
npm run verify:mac-arm64          # Check before packaging
```

See [BINARY_BUNDLING.md](../BINARY_BUNDLING.md) for more details on the bundling architecture.
