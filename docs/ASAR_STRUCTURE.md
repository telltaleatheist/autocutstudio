# ASAR Archive Structure

## Overview

The application uses Electron's asar archive format for packaging. Understanding what goes inside vs outside the asar is critical for proper functionality.

## ASAR = Read-Only ❌

The asar archive is **read-only** at runtime. Files inside the asar:
- ✅ Can be read
- ❌ Cannot be modified
- ❌ Cannot be executed directly (on some platforms)
- ❌ Cannot have .pyc cache files written

## extraResources = Read-Write ✅

Files in `extraResources` are placed outside the asar in the app's Resources directory and are **read-write** accessible.

## Current Configuration

### Inside ASAR (Read-Only)
```
app.asar/
├── dist-electron/main/          # Electron main process code
├── frontend/dist/               # Angular frontend
└── node_modules/                # npm packages (except unpacked ones)
```

### Outside ASAR (Read-Write) in Resources/
```
Resources/
├── core/                        # Python processing scripts
│   ├── *.py
│   └── __pycache__/            # Python can write .pyc files here ✅
├── cli/                         # Python CLI scripts
│   ├── *.py
│   └── __pycache__/            # Python can write .pyc files here ✅
├── config/                      # YAML configuration files
│   └── *.yaml                  # Can be modified at runtime if needed ✅
├── binaries/                    # Platform-specific binaries
│   ├── ffmpeg                  # Executable outside asar ✅
│   └── ffprobe                 # Executable outside asar ✅
├── python/                      # Bundled Python runtime
│   └── python-runtime/
│       ├── bin/python3         # Executable outside asar ✅
│       └── lib/                # Python packages ✅
└── environment.yml              # Conda environment file
```

## Why This Matters

### Python Files Must Be Outside ASAR

```python
# Python tries to write .pyc files when importing modules
import core.audio_processor  # ❌ FAILS if core/ is in asar (read-only)
                              # ✅ WORKS if core/ is in extraResources
```

### Binaries Must Be Executable

On macOS/Linux, files inside asar may lose execute permissions:
```bash
# ❌ FAILS - can't execute from asar
app.asar/binaries/ffmpeg

# ✅ WORKS - executable outside asar
Resources/binaries/ffmpeg
```

### Config Files May Need Modification

If the app needs to modify config files at runtime:
```yaml
# config/autostudio_config.yaml
# ❌ Can't modify if in asar
# ✅ Can modify if in extraResources
```

## Package.json Configuration

```json
{
  "build": {
    "asar": true,
    "extraResources": [
      "core",        // Python scripts (need __pycache__ write)
      "cli",         // Python CLI (need __pycache__ write)
      "config",      // YAML configs (may need modification)
      "binaries",    // Executables (need execute permission)
      "python"       // Python runtime (needs write access)
    ],
    "files": [
      "dist-electron/main/**/*",     // Electron code (read-only OK)
      "frontend/dist/**/*",          // Angular app (read-only OK)
      "node_modules/**/*",           // npm deps (read-only OK)
      "!core/**",                    // Exclude - already in extraResources
      "!cli/**",                     // Exclude - already in extraResources
      "!config/**",                  // Exclude - already in extraResources
      "!binaries/**",                // Exclude - already in extraResources
      "!python/**"                   // Exclude - already in extraResources
    ]
  }
}
```

## Testing ASAR Configuration

After building, verify the structure:

```bash
# Build the app
npm run package:mac:arm64

# Check asar contents (should NOT contain core/cli/config/binaries/python)
npx asar list dist-electron/mac-arm64/AutoCutStudio.app/Contents/Resources/app.asar

# Check Resources directory (should contain core/cli/config/binaries/python)
ls dist-electron/mac-arm64/AutoCutStudio.app/Contents/Resources/

# Verify structure
tree dist-electron/mac-arm64/AutoCutStudio.app/Contents/Resources/ -L 2
```

Expected output:
```
Resources/
├── app.asar              # Contains Electron + frontend (read-only)
├── core/                 # Outside asar (read-write) ✅
├── cli/                  # Outside asar (read-write) ✅
├── config/               # Outside asar (read-write) ✅
├── binaries/             # Outside asar (executable) ✅
└── python/               # Outside asar (read-write) ✅
```

## Common Issues

### Issue: ModuleNotFoundError or ImportError
**Cause:** Python files are in asar and Python can't write .pyc files
**Solution:** Ensure `core/` and `cli/` are in `extraResources`, not `files`

### Issue: Permission Denied when executing ffmpeg
**Cause:** Binary is in asar and lost execute permission
**Solution:** Ensure `binaries/` is in `extraResources`

### Issue: Python package import fails
**Cause:** Python runtime is in asar
**Solution:** Ensure `python/` is in `extraResources`

### Issue: Config changes don't persist
**Cause:** Config file is in read-only asar
**Solution:** Ensure `config/` is in `extraResources` if runtime modification is needed

## Performance Considerations

### Pros of ASAR
- ✅ Faster file access (single archive vs many small files)
- ✅ Smaller app size (compression)
- ✅ Harder to inspect/modify app code

### Cons of extraResources
- ⚠️ Slower access (individual files)
- ⚠️ No compression
- ⚠️ Easier to inspect/modify

### Our Approach
We use a **hybrid approach**:
- Electron code & frontend → **asar** (many small files, benefit from compression)
- Python code & binaries → **extraResources** (need write/execute access)

This gives us the best of both worlds!

## References

- [Electron ASAR Documentation](https://www.electronjs.org/docs/latest/tutorial/application-packaging)
- [electron-builder extraResources](https://www.electron.build/configuration/contents#extraresources)
- [Python .pyc files](https://docs.python.org/3/tutorial/modules.html#compiled-python-files)
