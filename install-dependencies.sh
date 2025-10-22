#!/bin/bash

# AutoCutStudio Dependency Installer
# This script installs all required dependencies for AutoCutStudio
# Works on both Apple Silicon and Intel Macs

set -e  # Exit on error

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print functions
print_header() {
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo -e "${BLUE}$1${NC}"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

# Check if running as root (we don't want that)
if [ "$EUID" -eq 0 ]; then
    print_error "Please DO NOT run this script as root (with sudo)"
    print_info "The script will ask for your password when needed"
    exit 1
fi

print_header "AutoCutStudio Dependency Installer"
print_info "This script will check and install all required dependencies"
print_info "You may be prompted for your password during installation"
echo ""

# Detect architecture
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    print_info "Detected: Apple Silicon (ARM64) Mac"
    BREW_PREFIX="/opt/homebrew"
else
    print_info "Detected: Intel (x86_64) Mac"
    BREW_PREFIX="/usr/local"
fi

# Check macOS version
OS_VERSION=$(sw_vers -productVersion)
print_info "macOS Version: $OS_VERSION"
echo ""

# Track what needs to be installed
NEEDS_XCODE=false
NEEDS_HOMEBREW=false
NEEDS_PYTHON=false
NEEDS_FFMPEG=false
NEEDS_FFPROBE=false
NEEDS_AUTO_EDITOR=false
MISSING_PIP_PACKAGES=()

# ============================================
# 1. Check Xcode Command Line Tools
# ============================================
print_header "Checking Xcode Command Line Tools"

if xcode-select -p &> /dev/null; then
    print_success "Xcode Command Line Tools are installed"
else
    print_warning "Xcode Command Line Tools not found"
    NEEDS_XCODE=true
fi

# ============================================
# 2. Check Homebrew
# ============================================
print_header "Checking Homebrew"

if command -v brew &> /dev/null; then
    BREW_VERSION=$(brew --version | head -1)
    print_success "Homebrew is installed: $BREW_VERSION"

    # Check if it's in the right location for the architecture
    BREW_PATH=$(which brew)
    if [[ "$ARCH" = "arm64" && "$BREW_PATH" != "/opt/homebrew/bin/brew" ]]; then
        print_warning "Homebrew found at $BREW_PATH but should be at /opt/homebrew/bin/brew for Apple Silicon"
        print_info "This is usually fine, but if you have issues, consider reinstalling Homebrew"
    elif [[ "$ARCH" = "x86_64" && "$BREW_PATH" != "/usr/local/bin/brew" ]]; then
        print_warning "Homebrew found at $BREW_PATH but should be at /usr/local/bin/brew for Intel Macs"
        print_info "This is usually fine, but if you have issues, consider reinstalling Homebrew"
    fi
else
    print_warning "Homebrew not found"
    NEEDS_HOMEBREW=true
fi

# ============================================
# 3. Check Python 3
# ============================================
print_header "Checking Python 3"

if command -v python3 &> /dev/null; then
    PYTHON_VERSION=$(python3 --version 2>&1)
    PYTHON_PATH=$(which python3)
    print_success "Python 3 is installed: $PYTHON_VERSION at $PYTHON_PATH"

    # Check if it's a recent enough version (3.9+)
    PYTHON_MAJOR=$(python3 -c 'import sys; print(sys.version_info[0])')
    PYTHON_MINOR=$(python3 -c 'import sys; print(sys.version_info[1])')

    if [ "$PYTHON_MAJOR" -eq 3 ] && [ "$PYTHON_MINOR" -ge 9 ]; then
        print_success "Python version is compatible (3.9+)"
    else
        print_warning "Python version is older than 3.9, some features may not work"
        print_info "Current: Python $PYTHON_MAJOR.$PYTHON_MINOR, Recommended: Python 3.9+"
    fi
else
    print_warning "Python 3 not found"
    NEEDS_PYTHON=true
fi

# ============================================
# 4. Check pip
# ============================================
print_header "Checking pip (Python package manager)"

if command -v pip3 &> /dev/null; then
    PIP_VERSION=$(pip3 --version 2>&1)
    print_success "pip3 is installed: $PIP_VERSION"
else
    print_warning "pip3 not found"
    print_info "pip3 should be installed with Python, will attempt to fix"
fi

# ============================================
# 5. Check FFmpeg
# ============================================
print_header "Checking FFmpeg"

if command -v ffmpeg &> /dev/null; then
    FFMPEG_VERSION=$(ffmpeg -version 2>&1 | head -1)
    print_success "FFmpeg is installed: $FFMPEG_VERSION"
else
    print_warning "FFmpeg not found"
    NEEDS_FFMPEG=true
fi

# ============================================
# 6. Check FFprobe
# ============================================
print_header "Checking FFprobe"

if command -v ffprobe &> /dev/null; then
    FFPROBE_VERSION=$(ffprobe -version 2>&1 | head -1)
    print_success "FFprobe is installed: $FFPROBE_VERSION"
else
    print_warning "FFprobe not found"
    NEEDS_FFPROBE=true
fi

# ============================================
# 7. Check Python packages
# ============================================
print_header "Checking Python packages"

# Check PyYAML
if python3 -c "import yaml" &> /dev/null; then
    VERSION=$(pip3 show pyyaml 2>/dev/null | grep Version | cut -d' ' -f2)
    if [ -n "$VERSION" ]; then
        print_success "pyyaml installed: v$VERSION"
    else
        print_success "pyyaml installed"
    fi
else
    print_warning "pyyaml not found"
    MISSING_PIP_PACKAGES+=("pyyaml")
fi

# Check auto-editor
if python3 -c "import auto_editor" &> /dev/null; then
    VERSION=$(pip3 show auto-editor 2>/dev/null | grep Version | cut -d' ' -f2)
    if [ -n "$VERSION" ]; then
        print_success "auto-editor installed: v$VERSION"
    else
        print_success "auto-editor installed"
    fi
else
    print_warning "auto-editor not found"
    MISSING_PIP_PACKAGES+=("auto-editor")
fi

# Check auto-editor separately as command
if command -v auto-editor &> /dev/null; then
    AUTO_EDITOR_VERSION=$(auto-editor --version 2>&1 || echo "installed")
    print_success "auto-editor command available: $AUTO_EDITOR_VERSION"
else
    if [[ ! " ${MISSING_PIP_PACKAGES[@]} " =~ " auto-editor " ]]; then
        print_warning "auto-editor command not found in PATH"
        NEEDS_AUTO_EDITOR=true
    fi
fi

# ============================================
# Summary
# ============================================
print_header "Installation Summary"

NEEDS_INSTALL=false

if [ "$NEEDS_XCODE" = true ]; then
    print_error "Xcode Command Line Tools need to be installed"
    NEEDS_INSTALL=true
fi

if [ "$NEEDS_HOMEBREW" = true ]; then
    print_error "Homebrew needs to be installed"
    NEEDS_INSTALL=true
fi

if [ "$NEEDS_PYTHON" = true ]; then
    print_error "Python 3 needs to be installed"
    NEEDS_INSTALL=true
fi

if [ "$NEEDS_FFMPEG" = true ] || [ "$NEEDS_FFPROBE" = true ]; then
    print_error "FFmpeg/FFprobe need to be installed"
    NEEDS_INSTALL=true
fi

if [ ${#MISSING_PIP_PACKAGES[@]} -gt 0 ]; then
    print_error "Missing Python packages: ${MISSING_PIP_PACKAGES[*]}"
    NEEDS_INSTALL=true
fi

if [ "$NEEDS_AUTO_EDITOR" = true ]; then
    print_error "auto-editor command not in PATH"
    NEEDS_INSTALL=true
fi

if [ "$NEEDS_INSTALL" = false ]; then
    echo ""
    print_success "All dependencies are already installed!"
    print_success "AutoCutStudio is ready to use"
    echo ""
    exit 0
fi

echo ""
print_warning "Some dependencies are missing and need to be installed"
echo ""
read -p "Would you like to install missing dependencies now? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print_info "Installation cancelled"
    print_info "Run this script again when you're ready to install"
    exit 0
fi

# ============================================
# Begin Installation
# ============================================
print_header "Installing Missing Dependencies"

# Install Xcode Command Line Tools
if [ "$NEEDS_XCODE" = true ]; then
    print_info "Installing Xcode Command Line Tools..."
    print_warning "This may take several minutes"
    print_info "A dialog box will appear - click 'Install' to continue"

    xcode-select --install

    print_info "Waiting for Xcode Command Line Tools installation..."
    print_info "Please complete the installation in the dialog box"

    # Wait for installation to complete
    until xcode-select -p &> /dev/null; do
        sleep 5
    done

    print_success "Xcode Command Line Tools installed successfully"

    # Accept license
    sudo xcodebuild -license accept 2>/dev/null || true
fi

# Install Homebrew
if [ "$NEEDS_HOMEBREW" = true ]; then
    print_info "Installing Homebrew..."
    print_warning "You will be prompted for your password"

    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

    # Add Homebrew to PATH for this session
    if [ "$ARCH" = "arm64" ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    else
        eval "$(/usr/local/bin/brew shellenv)"
    fi

    print_success "Homebrew installed successfully"
    print_info "Adding Homebrew to your shell profile..."

    # Detect shell and add to profile
    if [ -n "$ZSH_VERSION" ]; then
        SHELL_PROFILE="$HOME/.zshrc"
    elif [ -n "$BASH_VERSION" ]; then
        SHELL_PROFILE="$HOME/.bash_profile"
    else
        SHELL_PROFILE="$HOME/.profile"
    fi

    if [ "$ARCH" = "arm64" ]; then
        echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$SHELL_PROFILE"
    else
        echo 'eval "$(/usr/local/bin/brew shellenv)"' >> "$SHELL_PROFILE"
    fi

    print_success "Homebrew added to $SHELL_PROFILE"
fi

# Install Python 3
if [ "$NEEDS_PYTHON" = true ]; then
    print_info "Installing Python 3..."
    brew install python3
    print_success "Python 3 installed successfully"
fi

# Install FFmpeg (includes FFprobe)
if [ "$NEEDS_FFMPEG" = true ] || [ "$NEEDS_FFPROBE" = true ]; then
    print_info "Installing FFmpeg (includes FFprobe)..."
    brew install ffmpeg
    print_success "FFmpeg and FFprobe installed successfully"
fi

# Install Python packages
if [ ${#MISSING_PIP_PACKAGES[@]} -gt 0 ]; then
    print_info "Installing Python packages..."

    for PACKAGE in "${MISSING_PIP_PACKAGES[@]}"; do
        print_info "Installing $PACKAGE..."
        pip3 install --user "$PACKAGE"
        print_success "$PACKAGE installed"
    done

    print_success "All Python packages installed successfully"

    # Check if Python user bin is in PATH
    PYTHON_USER_BIN=$(python3 -m site --user-base)/bin
    if [[ ":$PATH:" != *":$PYTHON_USER_BIN:"* ]]; then
        print_warning "Python user bin directory not in PATH"
        print_info "Adding $PYTHON_USER_BIN to your shell profile..."

        # Detect shell and add to profile
        if [ -n "$ZSH_VERSION" ]; then
            SHELL_PROFILE="$HOME/.zshrc"
        elif [ -n "$BASH_VERSION" ]; then
            SHELL_PROFILE="$HOME/.bash_profile"
        else
            SHELL_PROFILE="$HOME/.profile"
        fi

        echo "export PATH=\"\$PATH:$PYTHON_USER_BIN\"" >> "$SHELL_PROFILE"
        export PATH="$PATH:$PYTHON_USER_BIN"

        print_success "Added to $SHELL_PROFILE"
    fi
fi

# ============================================
# Final Verification
# ============================================
print_header "Verifying Installation"

ALL_GOOD=true

# Re-check everything
if ! command -v python3 &> /dev/null; then
    print_error "Python 3 still not found"
    ALL_GOOD=false
else
    print_success "Python 3: $(python3 --version)"
fi

if ! command -v pip3 &> /dev/null; then
    print_error "pip3 still not found"
    ALL_GOOD=false
else
    print_success "pip3: $(pip3 --version | cut -d' ' -f1-2)"
fi

if ! command -v ffmpeg &> /dev/null; then
    print_error "FFmpeg still not found"
    ALL_GOOD=false
else
    print_success "FFmpeg: installed"
fi

if ! command -v ffprobe &> /dev/null; then
    print_error "FFprobe still not found"
    ALL_GOOD=false
else
    print_success "FFprobe: installed"
fi

# Check Python packages
if python3 -c "import yaml" &> /dev/null; then
    print_success "pyyaml: installed"
else
    print_error "pyyaml: still not found"
    ALL_GOOD=false
fi

if python3 -c "import auto_editor" &> /dev/null; then
    print_success "auto-editor: installed"
else
    print_error "auto-editor: still not found"
    ALL_GOOD=false
fi

# Check auto-editor command
if command -v auto-editor &> /dev/null; then
    print_success "auto-editor: available in PATH"
else
    print_warning "auto-editor: command not immediately available"
    print_info "You may need to restart your terminal or run:"
    print_info "  export PATH=\"\$PATH:$(python3 -m site --user-base)/bin\""
fi

echo ""

if [ "$ALL_GOOD" = true ]; then
    print_header "Installation Complete!"
    print_success "All dependencies are now installed"
    print_success "AutoCutStudio is ready to use"
    echo ""
    print_info "If you installed auto-editor for the first time, you may need to:"
    print_info "  1. Close and reopen your terminal, OR"
    print_info "  2. Run: source $SHELL_PROFILE"
    echo ""
else
    print_header "Installation Issues Detected"
    print_warning "Some dependencies could not be verified"
    print_info "Please try the following:"
    print_info "  1. Close and reopen your terminal"
    print_info "  2. Run this script again"
    print_info "  3. If problems persist, try installing manually:"
    echo ""
    print_info "     brew install python3 ffmpeg"
    print_info "     pip3 install --user pyyaml auto-editor"
    echo ""
fi
