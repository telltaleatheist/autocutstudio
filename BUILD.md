# Build & Package Instructions - Apple Silicon Mac

This document explains how to build and package AutoCutStudio for Apple Silicon Mac computers (M1/M2/M3/M4).

## Prerequisites

### System Requirements
- **macOS**: 11.0 (Big Sur) or later
- **Apple Silicon**: M1, M2, M3, M4, or M1/M2 Ultra/Max (arm64 architecture)

### Build Requirements (Developer Machine)
- **Xcode Command Line Tools**: `xcode-select --install`
- **Node.js**: 18+ (LTS recommended, avoid odd-numbered versions for production)
- **npm**: 10+

### Runtime Requirements (End User Machine)
The packaged application requires these tools to be pre-installed:
- **Python 3.9+**: `brew install python3`
- **ffmpeg & ffprobe**: `brew install ffmpeg`
- **auto-editor**: `pip3 install auto-editor`

**Important:** All tools must be in the system PATH for the application to work properly.

## Installation (Developer Setup)

1. Clone the repository
2. Install all dependencies:
```bash
npm run install:all
```

## Building the Application

### Build Everything
```bash
npm run build:all
```

This command builds:
- Frontend (Angular app)
- Electron main process
- Electron preload script

### Build Individual Components
```bash
npm run build:frontend  # Build Angular frontend only
npm run build:electron  # Build Electron main process only
npm run build:preload   # Build Electron preload script only
```

## Packaging for Apple Silicon Mac

### Quick Package (Recommended)
```bash
npm run package:mac
```

This creates: `dist-electron/AutoCutStudio-1.0.0-arm64.dmg`

### Alternative: Explicitly Specify arm64
```bash
npm run package:mac:arm64
```

Both commands create a native Apple Silicon DMG optimized for M1/M2/M3/M4 chips.

### Build for Intel Mac (if needed)
```bash
npm run package:mac:x64
```

Creates: `dist-electron/AutoCutStudio-1.0.0-x64.dmg` (runs via Rosetta 2 on Apple Silicon)

## Development

### Run in Development Mode
```bash
npm run dev
```

This builds everything and launches the app with developer tools enabled.

### Run Built Application
```bash
npm start
```

This builds and runs the production version locally (without packaging).

## Clean Build Artifacts

```bash
npm run clean      # Remove build artifacts
npm run clean:all  # Remove all build artifacts including frontend dist
```

## Distribution

### What You Get
After running `npm run package:mac`, you'll find:
- **DMG File**: `dist-electron/AutoCutStudio-1.0.0-arm64.dmg`
  - Drag-and-drop installer
  - Native performance on Apple Silicon Macs
  - Works on M1/M2/M3/M4, including Ultra and Max variants
  - Requires macOS 11.0 (Big Sur) or later

### Installing on User Machine
1. Double-click the DMG file
2. Drag AutoCutStudio to the Applications folder
3. Eject the DMG
4. Launch AutoCutStudio from Applications

**First Launch:** macOS may show a security warning. Users should:
1. Right-click the app and select "Open"
2. Click "Open" in the security dialog
3. Or go to System Settings > Privacy & Security > Allow

## User Requirements

Before distributing, make sure end users have installed:

```bash
# Install Homebrew (if not already installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Python 3
brew install python3

# Install ffmpeg (includes ffprobe)
brew install ffmpeg

# Install auto-editor
pip3 install auto-editor

# Verify installations
python3 --version
ffmpeg -version
ffprobe -version
auto-editor --version
```

## Troubleshooting

### Build Fails
1. **Install Xcode Command Line Tools:**
   ```bash
   xcode-select --install
   ```

2. **Clear npm cache and rebuild:**
   ```bash
   npm run clean:all
   rm -rf node_modules package-lock.json
   npm cache clean --force
   npm run install:all
   npm run build:all
   ```

3. **Check Node version:**
   ```bash
   node --version  # Should be 18.x or higher
   ```

### Python Not Found (Runtime Error)
Make sure Python 3 is installed and in PATH:
```bash
which python3
python3 --version
```

### ffmpeg/ffprobe Not Found (Runtime Error)
Make sure ffmpeg is installed:
```bash
which ffmpeg
which ffprobe
ffmpeg -version
```

### auto-editor Not Found (Runtime Error)
Install or reinstall auto-editor:
```bash
pip3 install --upgrade auto-editor
auto-editor --version
```

### App Runs Slowly on Apple Silicon
If the app runs slowly, you may have built an Intel (x64) version by mistake:
1. Check which DMG you're using - should be `arm64.dmg` not `x64.dmg`
2. Rebuild with: `npm run package:mac` (defaults to arm64)
3. Make sure `package.json` has `"arch": ["arm64"]` in the mac target config

### DMG Won't Open on User Machine
- Ensure the Mac is running macOS 11.0 (Big Sur) or later
- Try right-clicking and selecting "Open" instead of double-clicking
- Check System Settings > Privacy & Security for blocked apps

## File Structure

After building, your project structure:
```
AutoCutStudioApp/
├── dist-electron/
│   ├── AutoCutStudio-1.0.0-arm64.dmg  # Distributable DMG (Apple Silicon)
│   ├── mac/                            # Unpacked app
│   └── mac-arm64/                      # Build artifacts
├── frontend/dist/                      # Built Angular app
├── dist-electron/main/                 # Built Electron code
└── ...
```

## Code Signing (Optional)

For distribution outside of personal use, you may want to sign the app with an Apple Developer certificate:

1. Get an Apple Developer account ($99/year)
2. Create a Developer ID Application certificate
3. Export certificate as .p12 file
4. Set environment variables:
```bash
export CSC_LINK=/path/to/certificate.p12
export CSC_KEY_PASSWORD=your_password
npm run package:mac
```

Signed apps won't show security warnings on first launch.

## Support

For issues or questions, please open an issue on GitHub.

---

**Note:** This build configuration is optimized for Apple Silicon (M1/M2/M3/M4) Macs. For Intel Mac builds, use `npm run package:mac:x64` instead.