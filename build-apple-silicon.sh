#!/bin/bash

###############################################################################
# Build AutoCutStudio for Apple Silicon (M1/M2/M3)
###############################################################################

set -e  # Exit on error

echo "🍎 Building AutoCutStudio for Apple Silicon (arm64)..."
echo ""

# Check if we're on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "❌ This script must be run on macOS"
    exit 1
fi

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed"
    echo "   Please install Node.js from https://nodejs.org/"
    exit 1
fi

# Check conda
if ! command -v conda &> /dev/null; then
    echo "❌ Conda is not installed"
    echo "   Please install Miniconda from https://docs.conda.io/en/latest/miniconda.html"
    exit 1
fi

# Check if autocutstudio environment exists
if ! conda env list | grep -q "autocutstudio"; then
    echo "❌ Conda environment 'autocutstudio' not found"
    echo "   Please create it first with:"
    echo "   conda env create -f environment.yml"
    exit 1
fi

echo "✅ Prerequisites check passed"
echo ""

# Install npm dependencies
echo "📦 Installing npm dependencies..."
npm install
echo ""

# Build the application
echo "🔨 Building application..."
npm run build:all
echo ""

# Note: Python files are bundled by electron-builder via extraResources
# No separate Python bundling step needed

# Package the app
echo "📦 Creating DMG installer..."
npm run package:mac:arm64
echo ""

echo "✅ Build complete!"
echo ""
echo "📍 Output location:"
ls -lh dist-electron/*.dmg 2>/dev/null || echo "   No DMG found - check for errors above"
echo ""
echo "🚀 You can now distribute the DMG file to other Apple Silicon Macs!"
