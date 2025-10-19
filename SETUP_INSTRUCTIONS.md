# AutoCutStudio Electron App - Setup Instructions

## Current Status

I've created the core Electron infrastructure for your AutoCutStudio app. However, there's an npm cache permission issue preventing automatic installation of Angular dependencies.

## What's Been Created

### ✅ Electron Backend (Complete)
- [x] Project structure and package.json
- [x] Electron main process ([electron/main.ts](electron/main.ts))
- [x] Preload script with IPC API ([electron/preload.ts](electron/preload.ts))
- [x] TypeScript configurations
- [x] Dependency checking service (Python, ffmpeg, auto-editor)
- [x] Python CLI execution service
- [x] Window management service
- [x] IPC handlers for:
  - File/directory selection dialogs
  - File browsing
  - Python workflow execution
  - Real-time output streaming
  - Job cancellation

### 🚧 Angular Frontend (Structure Created, Needs npm install)
- [x] Basic Angular project structure
- [ ] npm dependencies (blocked by cache permissions)
- [ ] Components (ready to create after npm install)
- [ ] Services (ready to create after npm install)

## Fix npm Cache Issue

Run this command to fix the npm cache permissions:

\`\`\`bash
sudo chown -R $(whoami) ~/.npm
\`\`\`

Then install dependencies:

\`\`\`bash
# Install root dependencies
cd /Volumes/Callisto/Projects/AutoCutStudioApp
npm install

# Install Angular frontend dependencies
cd frontend
npm install
\`\`\`

## Next Steps After npm Install

Once npm dependencies are installed, I need to create:

### Angular Components
1. **File Browser Component** - Browse and select video/audio files
2. **Audio Sources Component** - Manage multiple audio sources (mic1-4, screen, game, etc.)
3. **Video Sources Component** - Optional high-res video sources
4. **XML Options Component** - Select which compound clips to generate
5. **Console Output Modal** - Real-time Python output display
6. **Results Component** - Display generated files with "Show in Finder" buttons
7. **Dependency Check Component** - Show missing dependencies on startup

### Angular Services
1. **ElectronService** - IPC communication wrapper
2. **ProcessingService** - Workflow execution and job management
3. **FileService** - File operations

### Styling
- Migrate the beautiful CSS from your Flask webui
- Orange theme colors (`--primary-orange: #ff6b35`)
- Dark/light theme support

## Architecture Overview

\`\`\`
User clicks "Process" in Angular UI
    ↓
Angular calls electron.executeWorkflow() via IPC
    ↓
Electron main process receives IPC call
    ↓
PythonService spawns: python3 cli/main.py workflow --master ... --mic-audio ...
    ↓
Real-time stdout/stderr streamed back to Angular via IPC events
    ↓
Angular displays output in console modal
    ↓
Python process completes, returns generated XML file paths
    ↓
Angular shows results with "Show in Finder" buttons
\`\`\`

## Key Features Implemented

### Dependency Checking
On startup, the app checks for:
- Python 3
- ffmpeg
- ffprobe
- auto-editor

If any are missing, shows a helpful error window with installation instructions.

### Python CLI Execution
- Spawns Python processes via child_process
- Captures stdout/stderr in real-time
- Streams output to frontend
- Supports job cancellation
- Cleans up processes on app quit

### File Operations
- Native file/directory picker dialogs
- File browsing (no upload, just path selection)
- "Show in Finder" functionality
- "Open with default app" functionality

## Development Commands

\`\`\`bash
# Build and run in development mode
npm run dev

# Build everything
npm run build:all

# Build for production (macOS)
npm run package:mac
\`\`\`

## Flask WebUI Features to Migrate

From your existing Flask app, we need to recreate in Angular:

1. ✅ File browser with path display
2. ✅ Auto-detect audio files by naming pattern
3. ✅ Multiple audio source management (mic1-4, screen, game, soundEffects, bluetooth)
4. ✅ Optional video sources (cam1, cam2, screen, game)
5. ✅ Audio corrections (29.97fps sync + drift)
6. ✅ XML generation options checkboxes
7. ✅ Background processing with progress
8. ✅ Console-style output display
9. ✅ Results with download/show in finder
10. ✅ Dark/light theme toggle

## Questions?

Once you've fixed the npm cache and installed dependencies, let me know and I'll create all the Angular components, services, and styling!
