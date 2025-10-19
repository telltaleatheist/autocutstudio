# AutoCutStudio - Electron Desktop App

**Automated multi-camera video editing workflow for YouTube content creators**

An Electron + Angular desktop application that wraps your Python CLI video processing tools with a beautiful, user-friendly interface.

## ✨ Features

- 🎬 Process master video files with multiple audio sources
- 🎤 Support for multiple audio types (mic1-4, screen, game, sound effects, bluetooth)
- 📹 Optional individual video sources (cam1, cam2, screen, game)
- 🎯 Configurable XML generation options for FCPX
- 📟 Real-time console output from Python processing
- 🌓 Light/Dark theme support
- ✅ Automatic dependency checking (Python, ffmpeg, auto-editor)
- 💾 No file uploads - works directly with file paths

## 🚀 Quick Start

### Prerequisites

The app will check for these on startup:
- Python 3
- ffmpeg
- ffprobe
- auto-editor

If missing, the app will show installation instructions.

### Installation

1. **Install dependencies:**
   ```bash
   npm install
   cd frontend && npm install && cd ..
   ```

2. **Build the app:**
   ```bash
   npm run build:all
   ```

3. **Run in development mode:**
   ```bash
   npm run dev
   ```

4. **Package for distribution:**
   ```bash
   npm run package:mac
   ```

## 📖 Usage

1. **Launch the app** - Double-click the app or run `npm run dev`

2. **Select Master Video** - Click "Browse" to select your main video file

3. **Add Audio Sources** - Click "Add Audio" and select audio files
   - Assign each audio source a type (Mic 1-4, Screen, Game, etc.)
   - Enable 29.97fps sync correction if needed
   - Enable drift correction if needed

4. **Optional: Add Video Sources** - Add individual high-resolution camera feeds

5. **Select XML Options** - Choose which compound clips to generate
   - CAM Solo/Dual
   - GS (Game Share) Solo/Dual
   - SSB (Screen Share Big) Solo/Dual
   - Master SOLO/DC

6. **Click "Process Workflow"** - Processing begins
   - Console output modal shows real-time progress
   - Python CLI runs in background
   - Results appear when complete

## 🏗️ Architecture

\`\`\`
┌─────────────────────────────────────┐
│   Angular Frontend (Renderer)       │
│   - File selection UI               │
│   - Audio/video source management   │
│   - Real-time console output        │
│   - Theme toggle                    │
└─────────────────────────────────────┘
              ↓ IPC
┌─────────────────────────────────────┐
│   Electron Main Process             │
│   - Dependency checking              │
│   - File dialog handlers             │
│   - Python CLI execution             │
│   - Real-time output streaming       │
└─────────────────────────────────────┘
              ↓ spawn
┌─────────────────────────────────────┐
│   Python CLI (Your existing code)   │
│   - auto-editor integration          │
│   - FCPX XML generation              │
│   - Audio/video processing           │
└─────────────────────────────────────┘
\`\`\`

## 📂 Project Structure

\`\`\`
AutoCutStudioApp/
├── electron/                 # Electron backend (TypeScript)
│   ├── main.ts              # Main process entry point
│   ├── preload.ts           # IPC bridge (secure)
│   ├── config/              # App configuration
│   ├── services/            # Services (Python, Dependency, Window)
│   └── ipc/                 # IPC handlers
├── frontend/                # Angular frontend
│   └── src/app/
│       ├── components/      # UI components
│       │   ├── workflow/    # Main workflow form
│       │   ├── file-browser/
│       │   ├── audio-sources/
│       │   ├── console-output/
│       │   └── results/
│       ├── services/        # Angular services
│       │   ├── electron.service.ts    # IPC wrapper
│       │   └── processing.service.ts  # Workflow management
│       └── models/          # TypeScript types
├── core/                    # Python core (your existing code)
├── cli/                     # Python CLI (your existing code)
├── config/                  # YAML config (your existing code)
└── package.json             # Root package file
\`\`\`

## 🛠️ Development

### Available Scripts

\`\`\`bash
npm run build:all           # Build everything
npm run build:frontend      # Build Angular only
npm run build:electron      # Build Electron main only
npm run build:preload       # Build preload script only

npm run dev                 # Run in development mode
npm start                   # Run in production mode

npm run package             # Package for all platforms
npm run package:mac         # Package for macOS only

npm run clean               # Clean build artifacts
npm run clean:all           # Clean everything including frontend
\`\`\`

### Tech Stack

- **Electron** - Desktop app framework
- **Angular 19** - Frontend framework
- **TypeScript** - Type-safe JavaScript
- **Python 3** - Backend processing
- **auto-editor** - Video editing engine
- **ffmpeg** - Video/audio processing

## 🎨 UI Features

- **Orange Theme** - Based on your Flask webui design (#ff6b35)
- **Dark/Light Mode** - Toggle between themes
- **Real-time Console** - See Python output as it happens
- **Native File Dialogs** - macOS-native file pickers
- **No File Uploads** - Works directly with file paths
- **Responsive Design** - Adapts to window size

## 🔧 Configuration

The app uses your existing `config/autostudio_config.yaml` for Python CLI settings.

Electron-specific settings are in:
- `electron/config/app-config.ts` - App paths and environment
- `package.json` - Build configuration

## 🐛 Troubleshooting

### App won't start
- Check that Python 3, ffmpeg, and auto-editor are installed
- Run `npm run dev` to see console logs

### Build errors
- Delete `node_modules` and `dist*` folders
- Run `npm install` again
- Make sure TypeScript is installed globally

### Python errors
- Check that your Python CLI works: `python3 cli/main.py workflow --help`
- Verify paths in `config/autostudio_config.yaml`

## 📝 License

MIT

## 🙏 Credits

Built with:
- Electron
- Angular
- auto-editor
- Your awesome Python video processing pipeline!

---

**Built by Claude Code** 🤖
