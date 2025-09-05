# AutoCutStudio Development Documentation

## Project Overview

AutoCutStudio is a Python-based automation tool for YouTube content creators that streamlines the multi-camera video editing workflow in Final Cut Pro X (FCPX). The tool automates the creation of templated compound clips with precise audio/video synchronization and multi-cam layouts.

## Current Project Status (WORKING v1.2)

### Completed Core Functionality
AutoCutStudio now has a **fully functional end-to-end workflow** with a modern web interface that processes video files from raw master recordings to Final Cut Pro ready compound clips.

**Working Features:**
- ✅ **Modern web interface**: Flask-based UI with project audio management system
- ✅ **Project audio source management**: Add/remove audio sources with individual sync controls
- ✅ **Session-based auto-detection**: Automatically matches audio files by session (e.g., "2025-09-03 1")
- ✅ **Video-to-audio extraction**: Supports video files as audio sources with automatic extraction
- ✅ **Individual audio sync controls**: Per-source 29.97fps sync correction checkboxes
- ✅ **Complete workflow automation**: Single command processes master video through all stages
- ✅ **Auto-editor integration**: Automatically identifies and cuts silence/pauses
- ✅ **6 compound clip generation**: Solo and dual camera modes for CAM, GS, and SSB layouts
- ✅ **8 audio source support**: mic1-4, screen, game, sound effects, bluetooth
- ✅ **Audio processing pipeline**: Extraction, format conversion, and selective sync correction
- ✅ **Configuration-driven**: All positioning, scaling, and paths stored in YAML
- ✅ **Modular architecture**: Future-proofed with abstraction layers

**Current Web Workflow:**
1. Select master video file using browser
2. Auto-detect or manually add audio sources to project
3. Configure individual sync settings per audio source
4. Process to generate 6 compound clip variations
5. Download Final Cut Pro XML files

**Generated Compound Clips:**
- `CAM Solo/Dual`: Camera-focused with mic audio + sound effects
- `GS Solo/Dual`: Multi-view game share with full audio mix (including bluetooth)
- `SSB Solo/Dual`: Large screen with camera overlay, screen audio only (including bluetooth)

### Web Interface Architecture

**Project Audio Management System:**
- **Left Panel**: Project audio sources with individual sync checkboxes and remove buttons
- **Right Panel**: File browser for adding audio/video files to project
- **Auto-Detection**: Session-based matching using naming convention (YYYY-MM-DD N pattern)
- **Manual Addition**: Browse and select audio/video files with type detection

**User Experience Flow:**
1. Select master video file
2. Use auto-detect to find matching audio files in same session
3. Manually add additional sources if needed
4. Configure sync settings per audio source
5. Process to generate all compound variations

### Session-Based File Matching

The system uses your naming convention to match files within sessions:
```
2025-09-03 1 master.mov
2025-09-03 1 mic 1 audio.wav
2025-09-03 1 screen audio.wav

2025-09-03 2 master.mov  
2025-09-03 2 mic 1 audio.wav
// Files from session "2025-09-03 1" won't match with "2025-09-03 2"
```

### Audio Source Distribution

**CAM Compounds**: `mic1`, `mic2`, `mic3`, `mic4`, `sound_effects`
**GS Compounds**: `mic1`, `mic2`, `mic3`, `mic4`, `screen`, `game`, `sound_effects`, `bluetooth`  
**SSB Compounds**: `screen`, `game`, `bluetooth`

### Individual Audio Sync Correction

Each audio source can have 29.97fps sync correction applied independently:
- Checkboxes next to each project audio source
- Applies `atempo=1.001` filter only to selected sources
- Prevents double-correction when using previously processed files
- Handles video-to-audio extraction with optional sync

## Ultimate Project Goals

### Complete Multi-Compound System ✅ ACHIEVED
Single FCPX project containing **six compound clips** for different presentation modes:

1. **CAM Solo/Dual**: Camera-focused layouts with mic audio only
2. **GS Solo/Dual**: Multi-view with game, screen, cameras, and full audio mix  
3. **SSB Solo/Dual**: Large screen view with small camera overlay, screen audio only

## Project Architecture

### Directory Structure (Current)
```
autostudio/
├── autostudio.py
├── cli/
├── config/
│   └── autostudio_config.yaml
├── core/
│   ├── audio_processor.py
│   ├── compound_generators/
│   │   ├── cam_generator.py
│   │   ├── dc_cam_generator.py
│   │   ├── gs_generator.py
│   │   ├── dc_gs_generator.py
│   │   ├── ssb_generator.py
│   │   └── dc_ssb_generator.py
│   ├── config.py
│   ├── editors/
│   └── xml_utils.py
├── docs/
├── webui/
│   ├── app.py
│   ├── static/
│   │   ├── css/style.css
│   │   └── js/app.js
│   └── templates/
│       └── index.html
└── templates/
```

### Key Abstraction Layers

1. **Web Interface**: Flask-based UI with project audio management
2. **Editor Abstraction**: Pluggable cutting tools (auto-editor implemented)
3. **Source Processing**: Handle different input layouts and session-based matching
4. **Compound Generation**: Template-driven compound clip creation with gap structure
5. **Audio Processing**: Individual sync correction and video-to-audio extraction

## Configuration System

### Enhanced Config Structure (autostudio_config.yaml)
```yaml
# 8 audio source support
audio:
  sources:
    mic1: null
    mic2: null  
    mic3: null
    mic4: null
    screen: null
    game: null
    sound_effects: null
    bluetooth: null

# Audio source distribution per compound type
layouts:
  cam:
    solo:
      audio_sources: ["mic1", "mic2", "mic3", "mic4", "sound_effects"]
  gs:
    solo:
      audio_sources: ["mic1", "mic2", "mic3", "mic4", "screen", "game", "sound_effects", "bluetooth"]
  ssb:
    solo:
      audio_sources: ["screen", "game", "bluetooth"]

# Border asset management - individual borders per visual element
paths:
  assets:
    borders:
      cam_dc:
        top_left: "/path/to/cam_dc_top_left.png"
        bottom_right: "/path/to/cam_dc_bottom_right.png"
      gs:
        bottom_left: "/path/to/gs_bottom_left.png"
        bottom_right: "/path/to/gs_bottom_right.png"
        top_left: "/path/to/gs_top_left.png"
```

## Technical Implementation Details

### Project Audio Management (Web Interface)

**Frontend State Management:**
```javascript
let projectAudioSources = {
  mic1: { path: '/path/to/file.wav', syncFix: false },
  screen: { path: '/path/to/screen.mov', syncFix: true }
};
```

**Backend Processing:**
```python
# Individual sync correction per audio source
for audio_type, audio_path in audio_sources.items():
    apply_sync = audio_sync_settings.get(audio_type, False)
    processed_path = audio_processor.process_audio_source(audio_path, apply_sync)
```

### Session-Based Auto-Detection

**Pattern Matching:**
```python
def extract_session_from_filename(filename):
    match = re.match(r'^(\d{4}-\d{2}-\d{2}\s+\d+)', filename)
    return match.group(1) if match else None
```

Only files with matching session identifiers are auto-detected together.

### Video-to-Audio Extraction Pipeline

**Automatic Detection:**
```python
video_extensions = ['.mp4', '.mov', '.avi', '.mkv', ...]
if source_path.suffix.lower() in video_extensions:
    processed_audio_path = self.extract_audio_from_video(source_path)
```

**FFmpeg Extraction:**
- Extracts to PCM 16-bit WAV at 48kHz stereo
- Optional 29.97fps sync correction with `atempo=1.001`
- Saves as `{filename}_extracted.wav`

### Compound Clip Structure (Gap-Based)

Each compound uses a gap element spanning full duration:
```xml
<gap name="Gap" offset="0s" duration="[full_master_duration]">
  <asset-clip lane="-2" ref="mic1_audio"/>
  <asset-clip lane="-3" ref="mic2_audio"/>
  <clip lane="1"><video ref="master_video"/></clip>
  <!-- Border assets on higher lanes -->
</gap>
```

## Web Interface Features

### Project Audio Management
- **Add Sources**: Auto-detect or manual browse for audio/video files
- **Individual Controls**: Sync checkbox and remove button per source
- **Type Detection**: Automatic audio type detection from filenames
- **Session Filtering**: Only shows files from same recording session

### File Browser System
- **Master Video Browser**: Modal for selecting main video file
- **Audio File Browser**: Dedicated panel for adding audio sources
- **Video Support**: Can select video files for audio extraction
- **Type Prompting**: Manual type selection when auto-detection fails

### Processing Workflow
- **Real-time Progress**: WebSocket-style progress updates
- **Individual Sync**: Per-source 29.97fps correction
- **Multiple Outputs**: Generates all 6 compound variations simultaneously
- **Download Management**: Direct XML file downloads

## Current Development Status

### Completed (v1.2)
- ✅ **Web interface with project audio management**
- ✅ **Session-based auto-detection system**
- ✅ **Individual audio sync controls**
- ✅ **Video-to-audio extraction support**
- ✅ **8 audio source types (mic1-4, screen, game, sfx, bluetooth)**
- ✅ **6 compound clip generators (solo/dual for CAM/GS/SSB)**
- ✅ **Audio source distribution per compound type**
- ✅ **Individual border asset management**
- ✅ **Gap-based compound structure**
- ✅ **End-to-end testing with production files**

### Known Issues & Solutions
- **Double sync correction**: System warns when processing `_synced` files
- **Clock drift**: 16-frame drift over 3+ hours requires manual correction in FCPX
- **Copy/paste timing**: Use export/import method for moving cut sections between projects

## Testing and Usage

### Web Interface Usage
1. Start server: `python webui/app.py`
2. Navigate to `http://localhost:5555`
3. Select master video file
4. Auto-detect or manually add audio sources
5. Configure individual sync settings
6. Process to generate all compound variations

### File Organization Best Practices
- Use session-based naming: `YYYY-MM-DD N filename`
- Keep original audio files separate from processed `_synced` files
- Organize by date in subdirectories
- Use consistent naming patterns for reliable auto-detection

### Sync Correction Guidelines
- **Use sync correction for**: Frame rate mismatches (29.97fps/30fps)
- **Don't use sync correction for**: Clock drift (use manual FCPX correction)
- **Double correction warning**: Avoid processing `_synced` files with sync enabled
- **Custom corrections**: For clock drift, use tiny percentages (0.0045%) in FCPX

## Design Principles

- **Project-based audio management**: Clear separation between file browsing and project sources
- **Individual control**: Per-source sync correction prevents over-correction
- **Session isolation**: Automatic file matching within recording sessions
- **Video source support**: Extract audio from any video file format
- **No hardcoded values**: Everything configurable via YAML and web interface
- **Modular architecture**: Easy to extend with new compound types or audio sources
- **Gap-based structure**: Timeline elements move together as units
- **Clean separation**: Input processing separate from output generation

The system successfully delivers a working v1.2 with a modern web interface that automates the entire YouTube editing workflow while providing granular control over audio processing and sync correction.