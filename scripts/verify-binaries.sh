#!/bin/bash
# Verify that all required binaries are present for a given platform

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

echo -e "${BLUE}🔍 Verifying binaries for platform: $PLATFORM${NC}"
echo ""

ERRORS=0
WARNINGS=0

# Check binaries directory
echo -e "${BLUE}Checking binaries directory...${NC}"
PLATFORM_BIN_DIR="$BINARIES_DIR/$PLATFORM"

if [ ! -d "$PLATFORM_BIN_DIR" ]; then
    echo -e "${RED}  ✗ Directory not found: $PLATFORM_BIN_DIR${NC}"
    ERRORS=$((ERRORS + 1))
else
    echo -e "${GREEN}  ✓ Directory exists: $PLATFORM_BIN_DIR${NC}"

    # Check for ffmpeg
    if [[ "$PLATFORM" == win32-* ]]; then
        FFMPEG_NAME="ffmpeg.exe"
        FFPROBE_NAME="ffprobe.exe"
        AUTO_EDITOR_NAME="auto-editor.exe"
    else
        FFMPEG_NAME="ffmpeg"
        FFPROBE_NAME="ffprobe"
        AUTO_EDITOR_NAME="auto-editor"
    fi

    if [ -f "$PLATFORM_BIN_DIR/$FFMPEG_NAME" ]; then
        SIZE=$(du -h "$PLATFORM_BIN_DIR/$FFMPEG_NAME" | cut -f1)
        echo -e "${GREEN}  ✓ ffmpeg found ($SIZE)${NC}"

        # Check if executable (Unix-like platforms)
        if [[ "$PLATFORM" != win32-* ]]; then
            if [ -x "$PLATFORM_BIN_DIR/$FFMPEG_NAME" ]; then
                echo -e "${GREEN}    ✓ Executable permission set${NC}"
            else
                echo -e "${YELLOW}    ⚠ Not executable - will be fixed during packaging${NC}"
                WARNINGS=$((WARNINGS + 1))
            fi
        fi
    else
        echo -e "${RED}  ✗ ffmpeg not found${NC}"
        ERRORS=$((ERRORS + 1))
    fi

    if [ -f "$PLATFORM_BIN_DIR/$FFPROBE_NAME" ]; then
        SIZE=$(du -h "$PLATFORM_BIN_DIR/$FFPROBE_NAME" | cut -f1)
        echo -e "${GREEN}  ✓ ffprobe found ($SIZE)${NC}"

        # Check if executable (Unix-like platforms)
        if [[ "$PLATFORM" != win32-* ]]; then
            if [ -x "$PLATFORM_BIN_DIR/$FFPROBE_NAME" ]; then
                echo -e "${GREEN}    ✓ Executable permission set${NC}"
            else
                echo -e "${YELLOW}    ⚠ Not executable - will be fixed during packaging${NC}"
                WARNINGS=$((WARNINGS + 1))
            fi
        fi
    else
        echo -e "${RED}  ✗ ffprobe not found${NC}"
        ERRORS=$((ERRORS + 1))
    fi

    if [ -f "$PLATFORM_BIN_DIR/$AUTO_EDITOR_NAME" ]; then
        SIZE=$(du -h "$PLATFORM_BIN_DIR/$AUTO_EDITOR_NAME" | cut -f1)
        echo -e "${GREEN}  ✓ auto-editor found ($SIZE)${NC}"

        # Check if executable (Unix-like platforms)
        if [[ "$PLATFORM" != win32-* ]]; then
            if [ -x "$PLATFORM_BIN_DIR/$AUTO_EDITOR_NAME" ]; then
                echo -e "${GREEN}    ✓ Executable permission set${NC}"
            else
                echo -e "${YELLOW}    ⚠ Not executable - will be fixed during packaging${NC}"
                WARNINGS=$((WARNINGS + 1))
            fi
        fi
    else
        echo -e "${RED}  ✗ auto-editor not found${NC}"
        ERRORS=$((ERRORS + 1))
    fi
fi

echo ""

# Check Python directory (optional)
echo -e "${BLUE}Checking Python runtime (optional)...${NC}"
PLATFORM_PYTHON_DIR="$PYTHON_DIR/$PLATFORM"

if [ ! -d "$PLATFORM_PYTHON_DIR" ]; then
    echo -e "${YELLOW}  ⚠ Python runtime not bundled for $PLATFORM${NC}"
    echo -e "${YELLOW}    This is OK if using system Python${NC}"
    WARNINGS=$((WARNINGS + 1))
else
    echo -e "${GREEN}  ✓ Python directory exists: $PLATFORM_PYTHON_DIR${NC}"

    PYTHON_RUNTIME="$PLATFORM_PYTHON_DIR/python-runtime"
    if [ -d "$PYTHON_RUNTIME" ]; then
        echo -e "${GREEN}  ✓ Python runtime found${NC}"

        # Check for python executable
        if [[ "$PLATFORM" == win32-* ]]; then
            PYTHON_BIN="$PYTHON_RUNTIME/python.exe"
        else
            PYTHON_BIN="$PYTHON_RUNTIME/bin/python3"
        fi

        if [ -f "$PYTHON_BIN" ]; then
            SIZE=$(du -sh "$PYTHON_RUNTIME" | cut -f1)
            echo -e "${GREEN}  ✓ Python executable found (total size: $SIZE)${NC}"
        else
            echo -e "${YELLOW}  ⚠ Python executable not found at expected location${NC}"
            WARNINGS=$((WARNINGS + 1))
        fi
    else
        echo -e "${YELLOW}  ⚠ Python runtime directory not found${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi
fi

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "${GREEN}✅ All binaries verified successfully!${NC}"
    echo -e "${GREEN}   Ready to package for $PLATFORM${NC}"
    exit 0
elif [ $ERRORS -eq 0 ]; then
    echo -e "${YELLOW}⚠️  Verification passed with $WARNINGS warning(s)${NC}"
    echo -e "${YELLOW}   Can proceed with packaging, but review warnings above${NC}"
    exit 0
else
    echo -e "${RED}❌ Verification failed with $ERRORS error(s) and $WARNINGS warning(s)${NC}"
    echo -e "${RED}   Cannot package - please run preparation scripts first:${NC}"
    echo ""
    echo -e "${YELLOW}   For current platform:${NC}"
    echo -e "     ./scripts/prepare-binaries.sh"
    echo ""
    echo -e "${YELLOW}   For other platforms:${NC}"
    echo -e "     ./scripts/download-binaries.sh $PLATFORM"
    echo ""
    exit 1
fi
