#!/bin/bash

###############################################################################
# Setup Intel (x64) Conda for Cross-Compilation on Apple Silicon Mac
###############################################################################

set -e  # Exit on error

echo "🔧 Setting up Intel (x64) Conda environment..."
echo ""

# Check if we're on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "❌ This script must be run on macOS"
    exit 1
fi

# Check if we're on Apple Silicon
if [[ "$(uname -m)" != "arm64" ]]; then
    echo "⚠️  This script is designed for Apple Silicon Macs"
    echo "   You appear to be on an Intel Mac already"
    read -p "Do you want to continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Set installation path
INSTALL_PATH="$HOME/miniconda3-x64"

# Check if already installed
if [[ -d "$INSTALL_PATH" ]]; then
    echo "⚠️  Intel conda already installed at: $INSTALL_PATH"
    read -p "Do you want to reinstall? This will remove the existing installation. (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "🗑️  Removing existing installation..."
        rm -rf "$INSTALL_PATH"
    else
        echo "✅ Using existing installation"
        echo ""
        echo "Creating autocutstudio environment..."
        if "$INSTALL_PATH/bin/conda" env list | grep -q "autocutstudio"; then
            echo "✅ Environment 'autocutstudio' already exists"
        else
            arch -x86_64 "$INSTALL_PATH/bin/conda" env create -f environment.yml
            echo "✅ Environment created successfully!"
        fi
        echo ""
        echo "🎉 Setup complete! You can now run:"
        echo "   ./build-intel-mac.sh"
        exit 0
    fi
fi

# Download Miniconda installer
echo "📥 Downloading Intel version of Miniconda..."
curl -fsSL https://repo.anaconda.com/miniconda/Miniconda3-latest-MacOSX-x86_64.sh -o /tmp/miniconda-x64.sh

# Install Miniconda
echo ""
echo "📦 Installing Intel Miniconda to: $INSTALL_PATH"
echo "   This may take a few minutes..."
arch -x86_64 bash /tmp/miniconda-x64.sh -b -p "$INSTALL_PATH"

# Clean up installer
rm /tmp/miniconda-x64.sh

echo ""
echo "✅ Intel Miniconda installed successfully!"

# Create the autocutstudio environment
echo ""
echo "🐍 Creating autocutstudio environment for Intel Mac..."
echo "   This will install Python 3.9, ffmpeg, auto-editor, and all dependencies..."
echo ""

arch -x86_64 "$INSTALL_PATH/bin/conda" env create -f environment.yml

echo ""
echo "✅ Environment created successfully!"

# Verify installation
echo ""
echo "🔍 Verifying installation..."
if "$INSTALL_PATH/bin/conda" env list | grep -q "autocutstudio"; then
    echo "✅ autocutstudio environment found"

    # Get Python version
    PYTHON_VERSION=$(arch -x86_64 "$INSTALL_PATH/envs/autocutstudio/bin/python" --version 2>&1)
    echo "✅ Python: $PYTHON_VERSION"

    # Check architecture
    ARCH=$(arch -x86_64 "$INSTALL_PATH/envs/autocutstudio/bin/python" -c "import platform; print(platform.machine())" 2>&1)
    echo "✅ Architecture: $ARCH"

    if [[ "$ARCH" == "x86_64" ]]; then
        echo "✅ Correct architecture confirmed!"
    else
        echo "⚠️  Warning: Architecture is $ARCH, expected x86_64"
    fi
else
    echo "❌ Environment verification failed"
    exit 1
fi

echo ""
echo "🎉 Setup complete!"
echo ""
echo "You can now build for Intel Mac with:"
echo "   ./build-intel-mac.sh"
echo ""
echo "Installation location:"
echo "   Conda: $INSTALL_PATH"
echo "   Environment: $INSTALL_PATH/envs/autocutstudio"
