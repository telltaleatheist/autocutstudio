#!/bin/bash
# Script to prepare binaries for packaging
# This script copies or downloads required binaries for each platform

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/binaries"

echo "🔧 Preparing binaries for packaging..."
echo "Project root: $PROJECT_ROOT"
echo "Binaries directory: $BINARIES_DIR"

# Detect current platform
PLATFORM="$(uname -s)"
ARCH="$(uname -m)"

echo "Current platform: $PLATFORM $ARCH"

# Function to copy binary if it exists
copy_if_exists() {
    local src="$1"
    local dest="$2"

    if [ -f "$src" ]; then
        echo "  ✓ Copying $(basename "$src") from $src"
        cp "$src" "$dest"
        chmod +x "$dest"
        return 0
    else
        echo "  ✗ Not found: $src"
        return 1
    fi
}

# macOS ARM64 (Apple Silicon)
echo ""
echo "📦 Preparing macOS ARM64 binaries..."
DARWIN_ARM64_DIR="$BINARIES_DIR/darwin-arm64"
mkdir -p "$DARWIN_ARM64_DIR"

if [ "$PLATFORM" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
    # Copy from current system (Homebrew on Apple Silicon)
    copy_if_exists "/opt/homebrew/bin/ffmpeg" "$DARWIN_ARM64_DIR/ffmpeg" || \
        echo "  ⚠️  ffmpeg not found - please install: brew install ffmpeg"

    copy_if_exists "/opt/homebrew/bin/ffprobe" "$DARWIN_ARM64_DIR/ffprobe" || \
        copy_if_exists "/usr/local/bin/ffprobe" "$DARWIN_ARM64_DIR/ffprobe" || \
        echo "  ⚠️  ffprobe not found - please install: brew install ffmpeg"
else
    echo "  ℹ️  Not on macOS ARM64 - skipping native binaries"
    echo "  💡 To build for macOS ARM64, run this script on an Apple Silicon Mac"
fi

# macOS x64 (Intel)
echo ""
echo "📦 Preparing macOS x64 binaries..."
DARWIN_X64_DIR="$BINARIES_DIR/darwin-x64"
mkdir -p "$DARWIN_X64_DIR"

if [ "$PLATFORM" = "Darwin" ]; then
    # Try to find Intel binaries (Homebrew x86_64)
    copy_if_exists "/usr/local/bin/ffmpeg" "$DARWIN_X64_DIR/ffmpeg" || \
        echo "  ⚠️  Intel ffmpeg not found"

    copy_if_exists "/usr/local/bin/ffprobe" "$DARWIN_X64_DIR/ffprobe" || \
        echo "  ⚠️  Intel ffprobe not found"
else
    echo "  ℹ️  Not on macOS - skipping Intel binaries"
fi

# Windows x64
echo ""
echo "📦 Preparing Windows x64 binaries..."
WINDOWS_X64_DIR="$BINARIES_DIR/win32-x64"
mkdir -p "$WINDOWS_X64_DIR"
echo "  ℹ️  Windows binaries must be downloaded separately"
echo "  💡 Download from: https://github.com/BtbN/FFmpeg-Builds/releases"
echo "  💡 Extract ffmpeg.exe and ffprobe.exe to: $WINDOWS_X64_DIR"

# Linux x64
echo ""
echo "📦 Preparing Linux x64 binaries..."
LINUX_X64_DIR="$BINARIES_DIR/linux-x64"
mkdir -p "$LINUX_X64_DIR"
echo "  ℹ️  Linux binaries must be downloaded separately"
echo "  💡 Use static builds from: https://johnvansickle.com/ffmpeg/"
echo "  💡 Extract ffmpeg and ffprobe to: $LINUX_X64_DIR"

# Python bundling info
echo ""
echo "🐍 Python bundling notes:"
echo "  The app will need a bundled Python environment with required packages."
echo "  Options:"
echo "    1. Use PyInstaller/Nuitka to create standalone Python executable"
echo "    2. Bundle conda environment (current approach in environment.yml)"
echo "    3. Use python-build-standalone for minimal Python runtime"
echo ""
echo "  Current conda env location: /opt/homebrew/Caskroom/miniconda/base/envs/autocutstudio"
echo "  Required packages: numpy, scipy, librosa, Pillow, auto-editor, PyYAML"

echo ""
echo "✅ Binary preparation complete!"
echo ""
echo "📋 Summary:"
echo "  darwin-arm64: $(ls -1 "$DARWIN_ARM64_DIR" 2>/dev/null | wc -l | tr -d ' ') files"
echo "  darwin-x64:   $(ls -1 "$DARWIN_X64_DIR" 2>/dev/null | wc -l | tr -d ' ') files"
echo "  win32-x64:    $(ls -1 "$WINDOWS_X64_DIR" 2>/dev/null | wc -l | tr -d ' ') files"
echo "  linux-x64:    $(ls -1 "$LINUX_X64_DIR" 2>/dev/null | wc -l | tr -d ' ') files"
echo ""
echo "Next steps:"
echo "  1. Run this script to copy current platform binaries"
echo "  2. Download binaries for other platforms (see links above)"
echo "  3. Update electron-builder config to include binaries"
echo "  4. Update services to use bundled binaries"
