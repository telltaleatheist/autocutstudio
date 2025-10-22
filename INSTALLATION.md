# AutoCutStudio Installation Guide

## Quick Start

### Step 1: Install Dependencies

Open Terminal and run:

```bash
cd /path/to/AutoCutStudioApp
./install-dependencies.sh
```

Or download and run directly:

```bash
curl -O https://raw.githubusercontent.com/your-repo/AutoCutStudioApp/main/install-dependencies.sh
chmod +x install-dependencies.sh
./install-dependencies.sh
```

The installer will:
- ✓ Check all required dependencies
- ✓ Install anything that's missing
- ✓ Verify the installation
- ✓ Guide you through each step

### Step 2: Install AutoCutStudio

After dependencies are installed:

1. Download the latest `AutoCutStudio-[version].dmg`
2. Open the DMG file
3. Drag AutoCutStudio to your Applications folder
4. Launch AutoCutStudio from Applications

## What Gets Installed

The installer checks and installs these dependencies:

### Required Tools
- **Homebrew** - macOS package manager
- **Python 3.9+** - Programming language runtime
- **FFmpeg** - Video/audio processing tool
- **FFprobe** - Media file analyzer (included with FFmpeg)

### Python Packages
- **PyYAML** - Configuration file parsing
- **auto-editor** - Automatic video editing

## Manual Installation

If you prefer to install manually:

### 1. Install Homebrew
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 2. Install System Tools
```bash
brew install python3 ffmpeg
```

### 3. Install Python Packages
```bash
pip3 install --user pyyaml auto-editor
```

### 4. Verify Installation
```bash
python3 --version   # Should be 3.9 or higher
ffmpeg -version     # Should show FFmpeg version
auto-editor --version   # Should show auto-editor version
```

## Troubleshooting

### "auto-editor: command not found"

After installing auto-editor, you may need to add Python's user bin directory to your PATH:

```bash
# For zsh (default on macOS Catalina+)
echo 'export PATH="$PATH:$(python3 -m site --user-base)/bin"' >> ~/.zshrc
source ~/.zshrc

# For bash
echo 'export PATH="$PATH:$(python3 -m site --user-base)/bin"' >> ~/.bash_profile
source ~/.bash_profile
```

### "ModuleNotFoundError: No module named 'yaml'"

This means PyYAML isn't installed or isn't accessible to the Python being used:

```bash
# Install PyYAML
pip3 install --user pyyaml

# Verify it's installed
python3 -c "import yaml; print('PyYAML is installed')"
```

### "Python version too old"

AutoCutStudio requires Python 3.9 or newer:

```bash
# Check your version
python3 --version

# If too old, update via Homebrew
brew upgrade python3
```

### "Permission denied" when running installer

Make sure the script is executable:

```bash
chmod +x install-dependencies.sh
./install-dependencies.sh
```

### Intel Mac vs Apple Silicon

The installer automatically detects your Mac type:
- **Apple Silicon (M1/M2/M3)**: Installs to `/opt/homebrew`
- **Intel**: Installs to `/usr/local`

Both are fully supported.

## System Requirements

- macOS 10.15 (Catalina) or later
- 4GB RAM minimum (8GB recommended)
- 2GB free disk space
- Internet connection (for downloading dependencies)

## Support

If you encounter issues:

1. Run the installer again - it will check what's missing
2. Check the Terminal output for specific error messages
3. Try the manual installation steps above
4. Restart your terminal/computer after installation

## Uninstalling Dependencies

If you need to remove the dependencies:

```bash
# Remove Python packages
pip3 uninstall pyyaml auto-editor

# Remove system tools (optional, may be used by other apps)
brew uninstall ffmpeg python3

# Remove Homebrew (optional, may be used by other apps)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/uninstall.sh)"
```

**Note:** Only uninstall Homebrew, Python, and FFmpeg if you're sure no other applications need them.
