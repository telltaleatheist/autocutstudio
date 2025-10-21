# Building AutoCutStudio

This guide explains how to build self-contained distributable versions of AutoCutStudio for macOS.

## Overview

AutoCutStudio can be built as a **completely self-contained application** that includes:
- ✅ Electron app with Angular frontend
- ✅ Python 3.9 runtime
- ✅ All Python dependencies (auto-editor, ffmpeg, etc.)
- ✅ Complete conda environment

The packaged app **does not require** users to install:
- Python
- Conda
- ffmpeg
- auto-editor
- Any other dependencies

## Prerequisites

### For Building on Apple Silicon (M1/M2/M3)

1. **macOS** (Apple Silicon)
2. **Node.js** 18+ ([Download](https://nodejs.org/))
3. **Miniconda** (arm64 version)
   \`\`\`bash
   # Install Miniconda for Apple Silicon
   brew install --cask miniconda
   \`\`\`
4. **conda-pack** will be installed automatically by the build script

### For Building for Intel Mac (x64)

If you're on an **Apple Silicon Mac** but want to build for Intel Macs:

1. Install **x64 version of Miniconda** using Rosetta:
   \`\`\`bash
   # Download and install x64 Miniconda
   arch -x86_64 /bin/bash -c "\$(curl -fsSL https://repo.anaconda.com/miniconda/Miniconda3-latest-MacOSX-x86_64.sh)" -b -p /usr/local/Caskroom/miniconda/base
   \`\`\`

2. Create the environment using x64 conda:
   \`\`\`bash
   arch -x86_64 /usr/local/Caskroom/miniconda/base/bin/conda env create -f environment.yml
   \`\`\`

## Quick Start

### Build for Apple Silicon

\`\`\`bash
chmod +x build-apple-silicon.sh
./build-apple-silicon.sh
\`\`\`

This will:
1. Check all prerequisites
2. Install npm dependencies
3. Build the Electron app
4. Bundle the Python environment
5. Create a DMG installer in \`dist-electron/\`

### Build for Intel Mac

\`\`\`bash
chmod +x build-intel-mac.sh
./build-intel-mac.sh
\`\`\`

## Manual Build Process

If you prefer to build manually:

### 1. Install Dependencies

\`\`\`bash
# Install npm dependencies
npm install

# Create conda environment (if not already created)
conda env create -f environment.yml
\`\`\`

### 2. Build for Apple Silicon (arm64)

\`\`\`bash
# Clean previous builds
npm run clean

# Build frontend and electron code
npm run build:all

# Bundle Python environment for arm64
npm run bundle:python:arm64

# Package the app
npm run package:mac:arm64
\`\`\`

### 3. Build for Intel Mac (x64)

\`\`\`bash
# Clean previous builds
npm run clean

# Build frontend and electron code
npm run build:all

# Bundle Python environment for x64
npm run bundle:python:x64

# Package the app
npm run package:mac:x64
\`\`\`

### 4. Build for Both Architectures

\`\`\`bash
npm run package:mac:both
\`\`\`

This creates separate DMG files for each architecture.

## Available Scripts

### Build Scripts
- \`npm run build:all\` - Build frontend and Electron code
- \`npm run build:frontend\` - Build Angular frontend only
- \`npm run build:electron\` - Build Electron main process only

### Python Bundling
- \`npm run bundle:python\` - Bundle Python for current arch (arm64 default)
- \`npm run bundle:python:arm64\` - Bundle Python for Apple Silicon
- \`npm run bundle:python:x64\` - Bundle Python for Intel Mac

### Packaging
- \`npm run package:mac:arm64\` - Package for Apple Silicon
- \`npm run package:mac:x64\` - Package for Intel Mac
- \`npm run package:mac:both\` - Package for both architectures

### Development
- \`npm start\` - Run in development mode
- \`npm run dev\` - Same as npm start
- \`npm run clean\` - Clean build artifacts

## Output

After building, you'll find the DMG installer in:
\`\`\`
dist-electron/AutoCutStudio-{version}-{arch}.dmg
\`\`\`

Where:
- \`{version}\` is the version from package.json (e.g., \`1.0.0\`)
- \`{arch}\` is either \`arm64\` or \`x64\`

## Distribution

The generated DMG file is completely self-contained and can be distributed to users who:
- Have macOS 10.15 (Catalina) or later
- Don't have Python, conda, or any dependencies installed
- Just want to drag-and-drop to install

### File Sizes

Approximate sizes:
- **arm64 DMG**: ~500-700 MB (includes Python + all dependencies)
- **x64 DMG**: ~500-700 MB (includes Python + all dependencies)

## Troubleshooting

### "conda: command not found"

Make sure conda is in your PATH:
\`\`\`bash
# For Apple Silicon
export PATH="/opt/homebrew/Caskroom/miniconda/base/bin:\$PATH"

# For Intel Mac
export PATH="/usr/local/Caskroom/miniconda/base/bin:\$PATH"
\`\`\`

### "Environment 'autocutstudio' not found"

Create the conda environment:
\`\`\`bash
# For Apple Silicon
conda env create -f environment.yml

# For Intel Mac (from Apple Silicon)
arch -x86_64 /usr/local/Caskroom/miniconda/base/bin/conda env create -f environment.yml
\`\`\`

### "Python bundling failed"

1. Make sure conda-pack is installed:
   \`\`\`bash
   conda install -c conda-forge conda-pack
   \`\`\`

2. Check that the autocutstudio environment exists:
   \`\`\`bash
   conda list -n autocutstudio
   \`\`\`

## How It Works

### Python Bundling

1. **conda-pack** creates a portable tarball of the conda environment
2. The environment is extracted to \`python-dist/darwin-{arch}/env/\`
3. During app packaging, the **afterPack hook** copies this into the app
4. At runtime, **PythonService** detects and uses the bundled Python
5. If bundled Python is missing, it falls back to system Python

