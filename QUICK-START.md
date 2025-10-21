# AutoCutStudio - Quick Start Guide

## Build Self-Contained Apps for macOS

AutoCutStudio packages everything you need into a single DMG file - no dependencies required!

---

## 🍎 For Your Apple Silicon Mac (Current Machine)

### One Command Build:

```bash
./build-apple-silicon.sh
```

**Output:** `dist-electron/AutoCutStudio-1.0.0-arm64.dmg` (~500-700 MB)

This DMG works on **any Apple Silicon Mac** (M1/M2/M3/M4) without requiring Python, conda, or any other dependencies.

---

## 💻 For Intel Macs

### First Time Setup (one-time):

```bash
./setup-intel-conda.sh
```

This installs an Intel version of conda in your home directory (`~/miniconda3-x64`) to enable cross-compilation.

### Build for Intel:

```bash
./build-intel-mac.sh
```

**Output:** `dist-electron/AutoCutStudio-1.0.0-x64.dmg` (~500-700 MB)

This DMG works on **any Intel Mac** without requiring Python, conda, or any other dependencies.

---

## 📦 What's Included in the DMG?

Each DMG is completely self-contained with:
- ✅ Electron app with Angular frontend
- ✅ Python 3.9 runtime
- ✅ ffmpeg + auto-editor
- ✅ All Python dependencies
- ✅ Complete conda environment

**Users just drag-and-drop to install!**

---

## 🚀 Quick Reference

### Build Commands

| Command | Purpose |
|---------|---------|
| `./build-apple-silicon.sh` | Build for Apple Silicon (M1/M2/M3/M4) |
| `./build-intel-mac.sh` | Build for Intel Mac (x64) |
| `./setup-intel-conda.sh` | One-time setup for Intel builds |

### NPM Scripts

| Command | Purpose |
|---------|---------|
| `npm start` | Run in development mode |
| `npm run clean` | Clean build artifacts |
| `npm run package:mac:arm64` | Package for Apple Silicon |
| `npm run package:mac:x64` | Package for Intel |
| `npm run package:mac:both` | Build both architectures |

---

## 📍 Output Location

After building, find your DMG files in:
```
dist-electron/
├── AutoCutStudio-1.0.0-arm64.dmg    (for Apple Silicon)
└── AutoCutStudio-1.0.0-x64.dmg      (for Intel)
```

---

## 🔧 Troubleshooting

### Build fails with "conda not found"
- **Apple Silicon:** Install with `brew install --cask miniconda`
- **Intel:** Run `./setup-intel-conda.sh`

### "Environment 'autocutstudio' not found"
```bash
# For Apple Silicon
conda env create -f environment.yml

# For Intel (after setup-intel-conda.sh)
~/miniconda3-x64/bin/conda env create -f environment.yml
```

### Need more help?
See **[BUILD.md](BUILD.md)** for detailed instructions and troubleshooting.

---

## 💡 Pro Tips

1. **First build will take longer** (~15-20 min) as it bundles Python
2. **Subsequent builds are faster** (~5-10 min)
3. **DMG files are large** (~500-700 MB each) because they're self-contained
4. **Both architectures can be built on Apple Silicon** using Rosetta

---

## 🎉 That's It!

Build once, distribute everywhere - no dependencies required!

For advanced usage and detailed documentation, see **[BUILD.md](BUILD.md)**.
