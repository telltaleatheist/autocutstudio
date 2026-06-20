#!/bin/bash
# Packaging preflight.
#
# ffmpeg/ffprobe and the Python runtime are NO LONGER bundled in the app — they
# are downloaded at runtime from GitHub releases into the shared OwenMorgan
# location (see electron/services/asset-catalog.ts). This script therefore only
# *reports* whether local copies exist under binaries/ and python/ (handy dev
# fallbacks); their absence is fine and never blocks packaging.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/binaries"
PYTHON_DIR="$PROJECT_ROOT/python"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PLATFORM="$1"

if [ -z "$PLATFORM" ]; then
    echo -e "${RED}Error: Platform not specified${NC}"
    echo "Usage: $0 [platform]"
    echo "Platforms: mac-arm64, mac-x64, win-x64, linux-x64"
    exit 1
fi

# Normalize platform name (map from Node.js names to our directory names)
case "$PLATFORM" in
    darwin-arm64|mac-arm64) PLATFORM="mac-arm64" ;;
    darwin-x64|mac-intel|mac-x64) PLATFORM="mac-x64" ;;
    win32-x64|win-x64|windows) PLATFORM="win-x64" ;;
    linux|linux-x64) PLATFORM="linux-x64" ;;
esac

echo -e "${BLUE}🔍 Packaging preflight for platform: $PLATFORM${NC}"
echo ""
echo -e "${BLUE}ℹ ffmpeg/ffprobe and the Python runtime are downloaded at runtime${NC}"
echo -e "${BLUE}  from GitHub releases — they are not bundled in the app.${NC}"
echo ""

# Optional local copies (dev fallback only — not bundled).
PLATFORM_BIN_DIR="$BINARIES_DIR/$PLATFORM"
if [ -d "$PLATFORM_BIN_DIR" ]; then
    echo -e "${GREEN}  ✓ local binaries present (dev fallback, not bundled): $PLATFORM_BIN_DIR${NC}"
else
    echo -e "${YELLOW}  • no local binaries/$PLATFORM — fine, fetched at runtime${NC}"
fi

PLATFORM_PYTHON_DIR="$PYTHON_DIR/$PLATFORM"
if [ -d "$PLATFORM_PYTHON_DIR" ]; then
    echo -e "${GREEN}  ✓ local Python runtime present (dev fallback, not bundled): $PLATFORM_PYTHON_DIR${NC}"
else
    echo -e "${YELLOW}  • no local python/$PLATFORM — fine, fetched at runtime${NC}"
fi

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✅ Preflight OK — ready to package for $PLATFORM${NC}"
echo -e "${GREEN}   (runtime assets resolved from GitHub releases)${NC}"
exit 0
