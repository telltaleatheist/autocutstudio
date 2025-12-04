#!/bin/bash
# Download binaries for packaging across all platforms
# This script downloads FFmpeg/FFprobe binaries for platforms where they're not natively available

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/binaries"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🌐 Downloading binaries for all platforms...${NC}"
echo "Project root: $PROJECT_ROOT"
echo "Binaries directory: $BINARIES_DIR"
echo ""

# Function to download and extract file
download_and_extract() {
    local url="$1"
    local output_file="$2"
    local extract_dir="$3"

    echo -e "${YELLOW}  Downloading: $url${NC}"

    # Create temp directory
    local temp_dir=$(mktemp -d)

    # Download
    if curl -L -o "$temp_dir/$output_file" "$url"; then
        echo -e "${GREEN}  ✓ Downloaded successfully${NC}"

        # Extract based on file type
        if [[ "$output_file" == *.zip ]]; then
            echo -e "${YELLOW}  Extracting zip...${NC}"
            unzip -q "$temp_dir/$output_file" -d "$temp_dir/extracted"
        elif [[ "$output_file" == *.tar.xz ]]; then
            echo -e "${YELLOW}  Extracting tar.xz...${NC}"
            mkdir -p "$temp_dir/extracted"
            tar -xJf "$temp_dir/$output_file" -C "$temp_dir/extracted"
        elif [[ "$output_file" == *.tar.gz ]]; then
            echo -e "${YELLOW}  Extracting tar.gz...${NC}"
            mkdir -p "$temp_dir/extracted"
            tar -xzf "$temp_dir/$output_file" -C "$temp_dir/extracted"
        fi

        # Find and copy binaries
        local ffmpeg_bin=$(find "$temp_dir/extracted" -name "ffmpeg" -o -name "ffmpeg.exe" | head -n 1)
        local ffprobe_bin=$(find "$temp_dir/extracted" -name "ffprobe" -o -name "ffprobe.exe" | head -n 1)

        if [ -n "$ffmpeg_bin" ]; then
            mkdir -p "$extract_dir"
            cp "$ffmpeg_bin" "$extract_dir/"
            chmod +x "$extract_dir/$(basename "$ffmpeg_bin")" 2>/dev/null || true
            echo -e "${GREEN}  ✓ Copied ffmpeg${NC}"
        fi

        if [ -n "$ffprobe_bin" ]; then
            mkdir -p "$extract_dir"
            cp "$ffprobe_bin" "$extract_dir/"
            chmod +x "$extract_dir/$(basename "$ffprobe_bin")" 2>/dev/null || true
            echo -e "${GREEN}  ✓ Copied ffprobe${NC}"
        fi

        # Cleanup
        rm -rf "$temp_dir"
        return 0
    else
        echo -e "${RED}  ✗ Download failed${NC}"
        rm -rf "$temp_dir"
        return 1
    fi
}

# Parse command line arguments
PLATFORM="$1"

if [ -z "$PLATFORM" ]; then
    echo -e "${RED}Error: Platform not specified${NC}"
    echo "Usage: $0 [platform]"
    echo "Platforms: darwin-arm64, darwin-x64, win32-x64, linux-x64, all"
    exit 1
fi

# macOS ARM64 (Apple Silicon)
download_mac_arm64() {
    echo -e "\n${BLUE}📦 Downloading macOS ARM64 binaries...${NC}"
    local target_dir="$BINARIES_DIR/mac-arm64"
    mkdir -p "$target_dir"

    # Check if already present on local system
    if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
        if [ -f "/opt/homebrew/bin/ffmpeg" ]; then
            echo -e "${GREEN}  ✓ Using local Homebrew FFmpeg/FFprobe${NC}"
            cp /opt/homebrew/bin/ffmpeg "$target_dir/"
            cp /opt/homebrew/bin/ffprobe "$target_dir/" 2>/dev/null || cp /usr/local/bin/ffprobe "$target_dir/" 2>/dev/null || true
            chmod +x "$target_dir"/*
        else
            echo -e "${YELLOW}  Note: FFmpeg doesn't provide official ARM64 macOS static builds${NC}"
            echo -e "${YELLOW}  Please install via Homebrew on an Apple Silicon Mac:${NC}"
            echo -e "${YELLOW}    brew install ffmpeg${NC}"
            echo -e "${YELLOW}  Then run: ./scripts/prepare-binaries.sh${NC}"
        fi
    fi

    # Download auto-editor binary
    echo -e "${YELLOW}  Downloading auto-editor...${NC}"
    local ae_url="https://github.com/WyattBlue/auto-editor/releases/latest/download/auto-editor-macos-arm64"
    if curl -L -o "$target_dir/auto-editor" "$ae_url"; then
        chmod +x "$target_dir/auto-editor"
        echo -e "${GREEN}  ✓ Downloaded auto-editor${NC}"
    else
        echo -e "${RED}  ✗ Failed to download auto-editor${NC}"
    fi
}

# macOS x64 (Intel)
download_mac_x64() {
    echo -e "\n${BLUE}📦 Downloading macOS x64 binaries...${NC}"
    local target_dir="$BINARIES_DIR/mac-x64"
    mkdir -p "$target_dir"

    # Download static FFmpeg builds from evermeet.cx (most reliable source for macOS static builds)
    echo -e "${YELLOW}  Downloading FFmpeg for Intel Mac from evermeet.cx...${NC}"

    # Download ffmpeg
    local ffmpeg_url="https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip"
    local temp_dir=$(mktemp -d)

    if curl -L -o "$temp_dir/ffmpeg.zip" "$ffmpeg_url" 2>/dev/null; then
        unzip -q "$temp_dir/ffmpeg.zip" -d "$temp_dir"
        if [ -f "$temp_dir/ffmpeg" ]; then
            cp "$temp_dir/ffmpeg" "$target_dir/"
            chmod +x "$target_dir/ffmpeg"
            echo -e "${GREEN}  ✓ Downloaded ffmpeg${NC}"
        else
            echo -e "${RED}  ✗ ffmpeg not found in archive${NC}"
        fi
    else
        echo -e "${RED}  ✗ Failed to download ffmpeg${NC}"
    fi

    # Download ffprobe
    local ffprobe_url="https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip"

    if curl -L -o "$temp_dir/ffprobe.zip" "$ffprobe_url" 2>/dev/null; then
        unzip -q "$temp_dir/ffprobe.zip" -d "$temp_dir"
        if [ -f "$temp_dir/ffprobe" ]; then
            cp "$temp_dir/ffprobe" "$target_dir/"
            chmod +x "$target_dir/ffprobe"
            echo -e "${GREEN}  ✓ Downloaded ffprobe${NC}"
        else
            echo -e "${RED}  ✗ ffprobe not found in archive${NC}"
        fi
    else
        echo -e "${RED}  ✗ Failed to download ffprobe${NC}"
    fi

    rm -rf "$temp_dir"

    # Download auto-editor binary
    echo -e "${YELLOW}  Downloading auto-editor...${NC}"
    local ae_url="https://github.com/WyattBlue/auto-editor/releases/latest/download/auto-editor-macos-x86_64"
    if curl -L -o "$target_dir/auto-editor" "$ae_url"; then
        chmod +x "$target_dir/auto-editor"
        echo -e "${GREEN}  ✓ Downloaded auto-editor${NC}"
    else
        echo -e "${RED}  ✗ Failed to download auto-editor${NC}"
    fi
}

# Windows x64
download_win_x64() {
    echo -e "\n${BLUE}📦 Downloading Windows x64 binaries...${NC}"
    local target_dir="$BINARIES_DIR/win-x64"
    mkdir -p "$target_dir"

    # Download FFmpeg
    local url="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
    download_and_extract "$url" "ffmpeg-win64.zip" "$target_dir"

    # Download auto-editor
    echo -e "${YELLOW}  Downloading auto-editor...${NC}"
    local ae_url="https://github.com/WyattBlue/auto-editor/releases/latest/download/auto-editor-windows-amd64.exe"
    if curl -L -o "$target_dir/auto-editor.exe" "$ae_url"; then
        echo -e "${GREEN}  ✓ Downloaded auto-editor${NC}"
    else
        echo -e "${RED}  ✗ Failed to download auto-editor${NC}"
    fi
}

# Linux x64
download_linux_x64() {
    echo -e "\n${BLUE}📦 Downloading Linux x64 binaries...${NC}"
    local target_dir="$BINARIES_DIR/linux-x64"
    mkdir -p "$target_dir"

    # Download FFmpeg
    local url="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
    download_and_extract "$url" "ffmpeg-linux64.tar.xz" "$target_dir"

    # Download auto-editor
    echo -e "${YELLOW}  Downloading auto-editor...${NC}"
    local ae_url="https://github.com/WyattBlue/auto-editor/releases/latest/download/auto-editor-linux-x86_64"
    if curl -L -o "$target_dir/auto-editor" "$ae_url"; then
        chmod +x "$target_dir/auto-editor"
        echo -e "${GREEN}  ✓ Downloaded auto-editor${NC}"
    else
        echo -e "${RED}  ✗ Failed to download auto-editor${NC}"
    fi
}

# Download based on platform argument
case "$PLATFORM" in
    darwin-arm64|mac-arm64)
        download_mac_arm64
        ;;
    darwin-x64|mac-x64|mac-intel)
        download_mac_x64
        ;;
    win32-x64|win-x64|windows)
        download_win_x64
        ;;
    linux-x64|linux)
        download_linux_x64
        ;;
    all)
        download_mac_arm64 || true
        download_mac_x64 || true
        download_win_x64 || true
        download_linux_x64 || true
        ;;
    *)
        echo -e "${RED}Error: Unknown platform: $PLATFORM${NC}"
        echo "Valid platforms: mac-arm64, mac-x64, win-x64, linux-x64, all"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}✅ Download complete!${NC}"
echo ""
echo -e "${BLUE}📋 Summary:${NC}"
for platform_dir in mac-arm64 mac-x64 win-x64 linux-x64; do
    if [ -d "$BINARIES_DIR/$platform_dir" ]; then
        COUNT=$(ls -1 "$BINARIES_DIR/$platform_dir" 2>/dev/null | wc -l | tr -d ' ')
        echo -e "  $platform_dir: ${GREEN}$COUNT files${NC}"
        ls -lh "$BINARIES_DIR/$platform_dir" 2>/dev/null | tail -n +2 | awk '{print "    " $9 " (" $5 ")"}'
    else
        echo -e "  $platform_dir: ${YELLOW}not present${NC}"
    fi
done
echo ""
