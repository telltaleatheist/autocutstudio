# Binary Bundling Guide

This guide explains how AutoCutStudio bundles required binaries (Python, FFmpeg, FFprobe, and auto-editor) into the distributed application.

## Overview

AutoCutStudio requires several external binaries to function:

1. **Python 3** - Runs the core processing scripts
2. **FFmpeg** - Video/audio encoding and processing
3. **FFprobe** - Media file information extraction
4. **auto-editor** - Silence detection and cutting (Python package)

The application now supports bundling these binaries in the packaged app, eliminating the need for users to install them separately.

## Directory Structure

```
AutoCutStudioApp/
├── binaries/               # Platform-specific binaries
│   ├── darwin-arm64/      # macOS Apple Silicon
│   │   ├── ffmpeg
│   │   └── ffprobe
│   ├── darwin-x64/        # macOS Intel
│   │   ├── ffmpeg
│   │   └── ffprobe
│   ├── win32-x64/         # Windows 64-bit
│   │   ├── ffmpeg.exe
│   │   └── ffprobe.exe
│   └── linux-x64/         # Linux 64-bit
│       ├── ffmpeg
│       └── ffprobe
├── python/                # Platform-specific Python runtimes
│   ├── darwin-arm64/
│   │   └── python-runtime/
│   ├── darwin-x64/
│   │   └── python-runtime/
│   ├── win32-x64/
│   │   └── python-runtime/
│   └── linux-x64/
│       └── python-runtime/
└── scripts/
    ├── prepare-binaries.sh   # Copies/downloads binaries
    └── prepare-python.sh     # Bundles Python environment
```

## Preparing Binaries for Packaging

### Step 1: Prepare Platform Binaries

Run the binary preparation script to copy binaries for your current platform:

```bash
./scripts/prepare-binaries.sh
```

This script will:
- Copy FFmpeg and FFprobe from your system (Homebrew, etc.)
- Create the appropriate directory structure
- Show instructions for downloading binaries for other platforms

#### Downloading Binaries for Other Platforms

**Windows (win32-x64):**
```bash
# Download from FFmpeg-Builds
# https://github.com/BtbN/FFmpeg-Builds/releases
# Get: ffmpeg-master-latest-win64-gpl.zip
# Extract ffmpeg.exe and ffprobe.exe to binaries/win32-x64/
```

**Linux (linux-x64):**
```bash
# Download static builds from John Van Sickle
# https://johnvansickle.com/ffmpeg/
# Get: ffmpeg-release-amd64-static.tar.xz
# Extract ffmpeg and ffprobe to binaries/linux-x64/
```

**macOS Intel (darwin-x64):**
```bash
# If on an Intel Mac, binaries will be copied automatically
# If on Apple Silicon Mac, you'll need to build or download separately
# Or use Homebrew in Rosetta mode:
arch -x86_64 /usr/local/bin/brew install ffmpeg
# Then run prepare-binaries.sh
```

### Step 2: Prepare Python Runtime

**Option 1: Bundle Conda Environment (Recommended for development)**

```bash
chmod +x scripts/prepare-python.sh
./scripts/prepare-python.sh
```

This will copy your existing conda environment to the `python/` directory.

**Option 2: Use Python Build Standalone (Recommended for production)**

For a smaller, more portable Python runtime:

```bash
# Download python-build-standalone
# https://github.com/indygreg/python-build-standalone/releases

# For macOS ARM64:
wget https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.11.7+20240107-aarch64-apple-darwin-install_only.tar.gz

# Extract to python/darwin-arm64/python-runtime/
tar -xzf cpython-*.tar.gz -C python/darwin-arm64/
mv python/darwin-arm64/python python/darwin-arm64/python-runtime

# Install required packages
python/darwin-arm64/python-runtime/bin/pip3 install numpy scipy librosa Pillow auto-editor PyYAML
```

**Option 3: Use PyInstaller/Nuitka**

For a single executable approach, you can use PyInstaller to bundle the Python scripts and dependencies:

```bash
pip install pyinstaller
pyinstaller --onefile cli/electron_workflow.py
# Copy the built executable to binaries/
```

## How Binary Resolution Works

The application uses a `BinaryResolver` service (`electron/services/binary-resolver.ts`) that:

1. **First** looks for bundled binaries in `extraResources/binaries/`
2. **Then** falls back to system binaries (Homebrew, system PATH, etc.)
3. **Finally** returns the binary name and hopes it's in PATH

### Resolution Priority

```typescript
// Example for FFmpeg:
1. extraResources/binaries/ffmpeg (bundled)
2. /opt/homebrew/bin/ffmpeg (Homebrew Apple Silicon)
3. /usr/local/bin/ffmpeg (Homebrew Intel)
4. 'ffmpeg' (hope it's in PATH)
```

This approach ensures:
- ✅ Packaged apps work out-of-the-box (bundled binaries)
- ✅ Development mode works (uses system binaries)
- ✅ Graceful fallback if bundled binaries are missing

## Building the Application with Bundled Binaries

### For Current Platform

```bash
# 1. Prepare binaries
./scripts/prepare-binaries.sh

# 2. Prepare Python (if using bundled Python)
./scripts/prepare-python.sh

# 3. Build the application
npm run package:mac        # or package:win, package:linux
```

### For Multiple Platforms

```bash
# 1. Prepare all platform binaries (download from links above)
# 2. Prepare Python for each platform
# 3. Build for all platforms
npm run package:all
```

## Configuration

The binary bundling is configured in `package.json`:

```json
{
  "build": {
    "extraResources": [
      {
        "from": "binaries/${os}-${arch}",
        "to": "binaries"
      },
      {
        "from": "python/${os}-${arch}",
        "to": "python"
      }
    ]
  }
}
```

The `${os}-${arch}` variables are automatically replaced by electron-builder:
- macOS ARM64: `darwin-arm64`
- macOS Intel: `darwin-x64`
- Windows: `win32-x64`
- Linux: `linux-x64`

## Development vs Production

### Development Mode
- Uses system-installed binaries (Homebrew, conda, etc.)
- No need to prepare bundled binaries for development
- Faster iteration (no binary copying)

### Production Mode
- Uses bundled binaries from `extraResources/`
- Falls back to system binaries if bundled ones are missing
- Self-contained application

## Testing Bundled Binaries

To test if bundled binaries are working:

```bash
# 1. Build the app
npm run package:mac:arm64

# 2. Open the app
open dist-electron/mac-arm64/AutoCutStudio.app

# 3. Check logs for binary resolution
tail -f ~/Library/Logs/AutoCutStudio/main.log | grep -i "binary\|python\|ffmpeg"
```

You should see log entries like:
```
[info] BinaryResolver initialized
[info] Found bundled binary: /Applications/AutoCutStudio.app/Contents/Resources/binaries/ffmpeg
[info] Found bundled Python: /Applications/AutoCutStudio.app/Contents/Resources/python/python-runtime/bin/python3
```

## Size Considerations

Bundling binaries increases the application size:

| Component | Approximate Size |
|-----------|-----------------|
| FFmpeg | ~100-150 MB |
| FFprobe | ~100-150 MB |
| Python Runtime (minimal) | ~50-100 MB |
| Python Runtime (conda) | ~500+ MB |
| Python packages | ~200-500 MB |

**Total estimated size:** 450 MB - 1.3 GB depending on Python bundling method

### Optimization Tips

1. **Use python-build-standalone** instead of conda (~400 MB savings)
2. **Strip debug symbols** from FFmpeg binaries
3. **Use PyInstaller** to create a single Python executable
4. **Compress with LZMA** (electron-builder does this automatically)

## Troubleshooting

### Binaries Not Found

If the app can't find bundled binaries:

1. Check `~/Library/Logs/AutoCutStudio/main.log`
2. Verify binaries exist in `extraResources/`
3. Ensure binaries are executable: `chmod +x binaries/darwin-arm64/*`

### Python Import Errors

If Python can't import packages:

1. Verify packages are installed in bundled Python
2. Check `PYTHONPATH` in logs
3. Ensure bundled Python matches the platform

### Version Mismatch Errors

If you get ABI or version mismatch errors:

1. Rebuild Python packages for the target platform
2. Use platform-specific wheels
3. Ensure Python version matches between build and runtime

## CI/CD Integration

For automated builds with bundled binaries:

```yaml
# Example GitHub Actions workflow
- name: Prepare Binaries
  run: |
    ./scripts/prepare-binaries.sh
    ./scripts/prepare-python.sh

- name: Build Application
  run: npm run package:mac:arm64

- name: Upload Artifact
  uses: actions/upload-artifact@v2
  with:
    name: AutoCutStudio-macOS
    path: dist-electron/*.dmg
```

## Future Improvements

- [ ] Automate binary downloads in prepare scripts
- [ ] Add binary signature verification
- [ ] Support for auto-updates of bundled binaries
- [ ] Platform-specific optimization
- [ ] Lazy loading of Python runtime (download on first use)

## Resources

- [electron-builder extraResources](https://www.electron.build/configuration/contents#extraresources)
- [FFmpeg Static Builds](https://ffmpeg.org/download.html)
- [Python Build Standalone](https://github.com/indygreg/python-build-standalone)
- [PyInstaller Documentation](https://pyinstaller.org/)
