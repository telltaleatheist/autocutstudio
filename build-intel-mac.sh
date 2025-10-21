#!/bin/bash

###############################################################################
# Build AutoCutStudio for Intel Mac (x64)
###############################################################################

set -e  # Exit on error

echo "💻 Building AutoCutStudio for Intel Mac (x64)..."
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

# Check if conda is available at x64 location (try multiple possible locations)
X64_CONDA_LOCATIONS=(
    "/usr/local/Caskroom/miniconda/base/bin/conda"
    "$HOME/miniconda3-x64/bin/conda"
    "$HOME/.miniconda3-x64/bin/conda"
)

X64_CONDA=""
for conda_path in "${X64_CONDA_LOCATIONS[@]}"; do
    if [[ -f "$conda_path" ]]; then
        X64_CONDA="$conda_path"
        echo "✅ Found Intel conda at: $X64_CONDA"
        break
    fi
done

if [[ -z "$X64_CONDA" ]]; then
    echo "❌ Intel (x64) conda installation not found"
    echo ""
    echo "To build for Intel Mac, you need to install x64 conda:"
    echo ""
    echo "Run these commands to install Intel Miniconda:"
    echo ""
    echo "  curl -fsSL https://repo.anaconda.com/miniconda/Miniconda3-latest-MacOSX-x86_64.sh -o /tmp/miniconda-x64.sh"
    echo "  arch -x86_64 bash /tmp/miniconda-x64.sh -b -p \$HOME/miniconda3-x64"
    echo ""
    echo "Then create the environment:"
    echo "  \$HOME/miniconda3-x64/bin/conda env create -f environment.yml"
    echo ""
    exit 1
fi

# Check if autocutstudio environment exists in x64 conda
if ! $X64_CONDA env list | grep -q "autocutstudio"; then
    echo "❌ Conda environment 'autocutstudio' not found in x64 installation"
    echo "   Please create it first with:"
    echo "   arch -x86_64 $X64_CONDA env create -f environment.yml"
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

# Bundle Python environment for x64
echo "🐍 Bundling Python environment for Intel Mac..."
# Temporarily override BUILD_ARCH for the bundling script
export BUILD_ARCH=x64
npm run bundle:python:x64
echo ""

# Package the app
echo "📦 Creating DMG installer..."
npm run package:mac:x64
echo ""

echo "✅ Build complete!"
echo ""
echo "📍 Output location:"
ls -lh dist-electron/*.dmg 2>/dev/null || echo "   No DMG found - check for errors above"
echo ""
echo "🚀 You can now distribute the DMG file to Intel Macs!"
