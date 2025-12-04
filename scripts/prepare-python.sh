#!/bin/bash
# Script to prepare Python runtime for packaging
# This script creates a minimal Python environment with required packages

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PYTHON_DIR="$PROJECT_ROOT/python"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🐍 Preparing Python runtime for packaging...${NC}"
echo "Project root: $PROJECT_ROOT"
echo "Python directory: $PYTHON_DIR"

# Parse command line arguments
TARGET_PLATFORM="$1"
FORCE_STANDALONE="$2"  # Pass "standalone" as second arg to force download

# Detect current platform
CURRENT_PLATFORM="$(uname -s)"
CURRENT_ARCH="$(uname -m)"

echo "Current platform: $CURRENT_PLATFORM $CURRENT_ARCH"

# Function to prepare Python from local conda
prepare_from_conda() {
    local platform_dir="$1"
    local conda_path="$2"

    echo -e "${YELLOW}Copying conda environment...${NC}"
    mkdir -p "$platform_dir"
    rsync -av --exclude='__pycache__' --exclude='*.pyc' --exclude='*.pyo' \
        "$conda_path/" "$platform_dir/python-runtime/"

    echo -e "${GREEN}✅ Python runtime prepared from conda!${NC}"
    echo "📊 Size: $(du -sh "$platform_dir" | cut -f1)"
}

# Function to download python-build-standalone
download_standalone_python() {
    local platform_dir="$1"
    local arch="$2"

    # Python version and release
    local PYTHON_VERSION="3.11.9"
    local RELEASE_DATE="20240726"

    local url=""
    local filename=""

    if [ "$arch" = "x64" ]; then
        filename="cpython-${PYTHON_VERSION}+${RELEASE_DATE}-x86_64-apple-darwin-install_only.tar.gz"
        url="https://github.com/indygreg/python-build-standalone/releases/download/${RELEASE_DATE}/${filename}"
    elif [ "$arch" = "arm64" ]; then
        filename="cpython-${PYTHON_VERSION}+${RELEASE_DATE}-aarch64-apple-darwin-install_only.tar.gz"
        url="https://github.com/indygreg/python-build-standalone/releases/download/${RELEASE_DATE}/${filename}"
    else
        echo -e "${RED}❌ Unsupported architecture: $arch${NC}"
        return 1
    fi

    echo -e "${YELLOW}Downloading Python ${PYTHON_VERSION} for $arch...${NC}"
    echo "URL: $url"

    local temp_dir=$(mktemp -d)

    if curl -L -o "$temp_dir/$filename" "$url"; then
        echo -e "${GREEN}✓ Downloaded successfully${NC}"

        mkdir -p "$platform_dir"

        echo -e "${YELLOW}Extracting...${NC}"
        tar -xzf "$temp_dir/$filename" -C "$platform_dir"

        # Rename 'python' to 'python-runtime' for consistency
        if [ -d "$platform_dir/python" ]; then
            mv "$platform_dir/python" "$platform_dir/python-runtime"
        fi

        # Install required packages
        echo -e "${YELLOW}Installing required packages...${NC}"
        "$platform_dir/python-runtime/bin/pip3" install --upgrade pip
        "$platform_dir/python-runtime/bin/pip3" install \
            numpy scipy librosa Pillow auto-editor PyYAML

        rm -rf "$temp_dir"

        echo -e "${GREEN}✅ Standalone Python prepared!${NC}"
        echo "📊 Size: $(du -sh "$platform_dir" | cut -f1)"
        return 0
    else
        echo -e "${RED}❌ Failed to download Python${NC}"
        rm -rf "$temp_dir"
        return 1
    fi
}

# Determine which platform to prepare
if [ -z "$TARGET_PLATFORM" ]; then
    # Auto-detect from current system
    if [ "$CURRENT_PLATFORM" = "Darwin" ] && [ "$CURRENT_ARCH" = "arm64" ]; then
        TARGET_PLATFORM="mac-arm64"
    elif [ "$CURRENT_PLATFORM" = "Darwin" ] && [ "$CURRENT_ARCH" = "x86_64" ]; then
        TARGET_PLATFORM="mac-x64"
    elif [ "$CURRENT_PLATFORM" = "Linux" ]; then
        TARGET_PLATFORM="linux-x64"
    else
        echo -e "${RED}❌ Could not auto-detect platform${NC}"
        echo "Usage: $0 [platform]"
        echo "Platforms: mac-arm64, mac-x64, linux-x64"
        exit 1
    fi
fi

# Normalize platform name
case "$TARGET_PLATFORM" in
    darwin-arm64|mac-arm64) TARGET_PLATFORM="mac-arm64" ;;
    darwin-x64|mac-x64|mac-intel) TARGET_PLATFORM="mac-x64" ;;
    linux|linux-x64) TARGET_PLATFORM="linux-x64" ;;
esac

echo -e "${BLUE}Target platform: $TARGET_PLATFORM${NC}"

PLATFORM_DIR="$PYTHON_DIR/$TARGET_PLATFORM"

# Check if we can use local conda or need to download
USE_STANDALONE=false

if [ "$FORCE_STANDALONE" = "standalone" ]; then
    echo -e "${YELLOW}Forcing standalone Python download...${NC}"
    USE_STANDALONE=true
elif [ "$TARGET_PLATFORM" = "mac-arm64" ] && [ "$CURRENT_ARCH" = "arm64" ]; then
    # We're on ARM64, can use local conda
    CONDA_ENV="/opt/homebrew/Caskroom/miniconda/base/envs/autocutstudio"
    if [ -d "$CONDA_ENV" ]; then
        echo -e "${GREEN}Found local conda environment: $CONDA_ENV${NC}"
        prepare_from_conda "$PLATFORM_DIR" "$CONDA_ENV"
    else
        echo -e "${YELLOW}Local conda not found, downloading standalone...${NC}"
        USE_STANDALONE=true
    fi
elif [ "$TARGET_PLATFORM" = "mac-x64" ] && [ "$CURRENT_ARCH" = "x86_64" ]; then
    # We're on x64, can use local conda
    CONDA_ENV="/usr/local/Caskroom/miniconda/base/envs/autocutstudio"
    if [ -d "$CONDA_ENV" ]; then
        echo -e "${GREEN}Found local conda environment: $CONDA_ENV${NC}"
        prepare_from_conda "$PLATFORM_DIR" "$CONDA_ENV"
    else
        echo -e "${YELLOW}Local conda not found, downloading standalone...${NC}"
        USE_STANDALONE=true
    fi
elif [ "$TARGET_PLATFORM" = "mac-x64" ] && [ "$CURRENT_ARCH" = "arm64" ]; then
    # Cross-compiling: on ARM64 but need x64 Python
    echo -e "${YELLOW}Cross-platform build: downloading x64 Python for Intel Mac...${NC}"
    USE_STANDALONE=true
elif [ "$TARGET_PLATFORM" = "mac-arm64" ] && [ "$CURRENT_ARCH" = "x86_64" ]; then
    # Cross-compiling: on x64 but need ARM64 Python
    echo -e "${YELLOW}Cross-platform build: downloading ARM64 Python for Apple Silicon...${NC}"
    USE_STANDALONE=true
else
    echo -e "${YELLOW}Non-matching platform, downloading standalone...${NC}"
    USE_STANDALONE=true
fi

if [ "$USE_STANDALONE" = true ]; then
    case "$TARGET_PLATFORM" in
        mac-arm64) download_standalone_python "$PLATFORM_DIR" "arm64" ;;
        mac-x64) download_standalone_python "$PLATFORM_DIR" "x64" ;;
        *)
            echo -e "${RED}❌ Standalone downloads not yet supported for $TARGET_PLATFORM${NC}"
            exit 1
            ;;
    esac
fi

# Verify the installation
echo ""
echo -e "${BLUE}🔍 Verifying Python installation...${NC}"
if [ -f "$PLATFORM_DIR/python-runtime/bin/python3" ]; then
    "$PLATFORM_DIR/python-runtime/bin/python3" --version

    echo ""
    echo -e "${BLUE}📦 Installed packages:${NC}"
    "$PLATFORM_DIR/python-runtime/bin/python3" -m pip list 2>/dev/null | grep -E "(numpy|scipy|librosa|Pillow|auto-editor|PyYAML)" || echo "  (checking packages...)"
else
    echo -e "${RED}❌ Python executable not found!${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}✅ Python runtime ready for $TARGET_PLATFORM${NC}"
echo ""
