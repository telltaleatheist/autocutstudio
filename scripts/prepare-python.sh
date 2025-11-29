#!/bin/bash
# Script to prepare Python runtime for packaging
# This script creates a minimal Python environment with required packages

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PYTHON_DIR="$PROJECT_ROOT/python"

echo "🐍 Preparing Python runtime for packaging..."
echo "Project root: $PROJECT_ROOT"
echo "Python directory: $PYTHON_DIR"

# Detect current platform
PLATFORM="$(uname -s)"
ARCH="$(uname -m)"

echo "Current platform: $PLATFORM $ARCH"

# Set platform-specific directory
if [ "$PLATFORM" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
    PLATFORM_DIR="$PYTHON_DIR/darwin-arm64"
elif [ "$PLATFORM" = "Darwin" ] && [ "$ARCH" = "x86_64" ]; then
    PLATFORM_DIR="$PYTHON_DIR/darwin-x64"
elif [ "$PLATFORM" = "Linux" ]; then
    PLATFORM_DIR="$PYTHON_DIR/linux-x64"
else
    echo "❌ Unsupported platform: $PLATFORM $ARCH"
    exit 1
fi

echo "Platform directory: $PLATFORM_DIR"

# Check if conda environment exists
CONDA_ENV="/opt/homebrew/Caskroom/miniconda/base/envs/autocutstudio"
ALT_CONDA_ENV="/usr/local/Caskroom/miniconda/base/envs/autocutstudio"

if [ -d "$CONDA_ENV" ]; then
    CONDA_PATH="$CONDA_ENV"
elif [ -d "$ALT_CONDA_ENV" ]; then
    CONDA_PATH="$ALT_CONDA_ENV"
else
    echo "❌ Conda environment 'autocutstudio' not found"
    echo "Please create it using: conda env create -f environment.yml"
    exit 1
fi

echo "Found conda environment: $CONDA_PATH"

# Create platform directory
mkdir -p "$PLATFORM_DIR"

echo ""
echo "📦 Bundling Python environment..."
echo "This will copy the conda environment to the python directory."
echo "Warning: This may take several minutes and use significant disk space."
echo ""

# Option 1: Copy entire conda environment (simple but large)
echo "Copying conda environment..."
rsync -av --exclude='__pycache__' --exclude='*.pyc' --exclude='*.pyo' \
    "$CONDA_PATH/" "$PLATFORM_DIR/python-runtime/"

echo ""
echo "✅ Python runtime prepared!"
echo ""
echo "📊 Size: $(du -sh "$PLATFORM_DIR" | cut -f1)"
echo ""
echo "🔍 Verifying Python installation..."
"$PLATFORM_DIR/python-runtime/bin/python3" --version

echo ""
echo "📦 Installed packages:"
"$PLATFORM_DIR/python-runtime/bin/python3" -m pip list | grep -E "(numpy|scipy|librosa|Pillow|auto-editor|PyYAML)"

echo ""
echo "💡 Next steps:"
echo "  1. Update electron-builder config to include python directory"
echo "  2. Update PythonService to use bundled Python"
echo "  3. Test the bundled Python environment"
echo ""
echo "⚠️  Note: For production, consider using python-build-standalone for smaller size"
echo "   See: https://github.com/indygreg/python-build-standalone"
