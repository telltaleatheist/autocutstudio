# AutoCutStudio Development Documentation

## Project Overview

AutoCutStudio is a Python-based automation tool for YouTube content creators that streamlines the multi-camera video editing workflow in Final Cut Pro X (FCPX). The tool automates the creation of templated compound clips with precise audio/video synchronization and multi-cam layouts.

## Current Project Status (WORKING v1.3)

### Completed Core Functionality
AutoCutStudio has a **fully functional end-to-end workflow** with a modern web interface that processes video files from raw master recordings to Final Cut Pro ready compound clips, packaged in organized zip archives.

**Working Features:**
- ✅ **Modern web interface**: Flask-based UI with comprehensive project management
- ✅ **Flexible audio management**: Add files to project, then assign audio types via dropdown
- ✅ **Session-based auto-detection**: Automatically matches audio files by session (e.g., "2025-09-03 1")
- ✅ **Video-to-audio extraction**: Supports video files as audio sources with automatic extraction
- ✅ **Individual audio sync controls**: Per-source 29.97fps sync correction checkboxes
- ✅ **Selective XML generation**: Choose which compound clips to generate (base files always included)
- ✅ **Complete workflow automation**: Single command processes master video through all stages
- ✅ **Auto-editor integration**: Automatically identifies and cuts silence/pauses
- ✅ **6 compound clip generation**: Solo and dual camera modes for CAM, GS, and SSB layouts
- ✅ **2 master project generation**: SOLO and DC master projects with all compounds on lanes
- ✅ **8 audio source support**: mic1-4, screen, game, sound effects, bluetooth
- ✅ **Audio processing pipeline**: Extraction, format conversion, and selective sync correction
- ✅ **Automatic file cleanup**: XMLs packaged in zip then deleted to maintain clean workspace
- ✅ **Job re-execution**: Process button re-enables after completion for immediate new jobs
- ✅ **Configuration-driven**: All positioning, scaling, and paths stored in YAML
- ✅ **Modular architecture**: Future-proofed with abstraction layers

**Current Web Workflow:**
1. Select master video file using modal file browser
2. Auto-detect or manually add audio sources to project
3. Assign audio types using dropdown selectors for each file
4. Select which compound clips to generate (optional - defaults to all)
5. Configure individual sync settings per audio source
6. Process to generate selected compound clip variations
7. Download zip file containing all XML files organized by session

**Generated Files (in zip archive):**
- Auto-editor export (always included)
- Base compound clip (always included)
- Selected compound clips:
  - `CAM Solo/Dual`: Camera-focused with mic audio + sound effects
  - `GS Solo/Dual`: Multi-view game share with full audio mix (including bluetooth)
  - `SSB Solo/Dual`: Large screen with camera overlay, screen audio only (including bluetooth)
- Master projects (if selected):
  - `SOLO Master`: All solo compounds on separate lanes
  - `DC Master`: All dual camera compounds on separate lanes

### Web Interface Architecture

**Audio Management System:**
- **File List**: Shows all added audio/video files with status
- **Type Assignment**: Dropdown selector for each file to assign audio type
- **Duplicate Prevention**: Shows "(in use)" for already assigned types
- **Visual Feedback**: Unassigned files highlighted differently
- **Sync Controls**: Individual 29.97fps correction per file (enabled after type assignment)

**XML Generation Options:**
- **Organized Layout**: Compounds grouped by camera type (Solo/Dual)
- **Select All/None**: Quick selection controls
- **Default Behavior**: All compounds selected by default
- **Base Files**: Auto-editor and compound base always generated

**User Experience Flow:**
1. Select master video file
2. Use auto-detect to find matching audio files in same session
3. Or manually add files and assign types via dropdowns
4. Review and adjust sync settings if needed
5. Choose which compounds to generate (optional)
6. Process to generate all selected variations
7. Download zip archive containing organized XML files

### Session-Based File Organization

The system uses your naming convention for organization:
```
2025-09-03 1 master.mov
2025-09-03 1 mic 1 audio.wav
2025-09-03 1 screen audio.wav

2025-09-03 2 master.mov  
2025-09-03 2 mic 1 audio.wav
```

Zip archives are named by session:
- `2025-09-03_1_compounds.zip` containing folder `2025-09-03_1/` with all XMLs
- `2025-09-03_2_compounds.zip` containing folder `2025-09-03_2/` with all XMLs

### Audio Source Distribution

**CAM Compounds**: `mic1`, `mic2`, `mic3`, `mic4`, `sound_effects`
**GS Compounds**: `mic1`, `mic2`, `mic3`, `mic4`, `screen`, `game`, `sound_effects`, `bluetooth`  
**SSB Compounds**: `screen`, `game`, `bluetooth`

### Individual Audio Sync Correction

Each audio source can have 29.97fps sync correction applied independently:
- Checkboxes enabled after audio type assignment
- Applies `atempo=1.001` filter only to selected sources
- Prevents double-correction when using previously processed files
- Handles video-to-audio extraction with optional sync

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
│   │   ├── dc_ssb_generator.py
│   │   └── master_project_generator.py
│   ├── config.py
│   ├── editors/
│   │   └── auto_editor.py
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

### Key Features

1. **Flexible Audio Assignment**: Files added to project list with dropdown type selection
2. **Smart File Management**: Automatic cleanup after zip creation keeps workspace organized
3. **Selective Generation**: Choose exactly which compounds you need
4. **Session Organization**: Zip archives contain session-named folders for multi-session workflows
5. **Job Continuity**: No page refresh needed between processing jobs
6. **Visual Feedback**: Clear indication of file status and type assignments

## Configuration System

### Config Structure (autostudio_config.yaml)
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

# Border asset management
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

### Audio File Management

**File List Structure:**
```javascript
projectAudioSources = {
  'file_1234567890': { 
    path: '/path/to/file.wav', 
    type: 'mic1',  // or null if unassigned
    syncFix: false 
  },
  'file_1234567891': { 
    path: '/path/to/screen.mov', 
    type: 'screen',
    syncFix: true 
  }
};
```

**Type Assignment Validation:**
- Prevents duplicate type assignments
- Shows availability status in dropdown
- Visual indication for unassigned files
- Sync controls only enabled after type assignment

### XML Generation Control

**Selective Generation:**
```python
def should_generate(xml_type):
    if not xml_options:  # None or empty generates everything
        return True
    return xml_type in xml_options
```

- Base files (auto-editor, compound) always generated
- Compounds generated only if selected
- Dependencies generated for master projects even if not selected

### File Cleanup Process

**Zip and Clean:**
```python
def create_xml_zip(xml_files, output_dir, session_name, cleanup=True):
    # Create zip with session-named internal folder
    # Delete original XML files after zipping
```

- All XMLs packaged in session-named folder within zip
- Original XML files deleted after successful zip creation
- Maintains clean workspace for multiple sessions

## Testing and Usage

### Web Interface Usage
1. Start server: `python webui/app.py`
2. Navigate to `http://localhost:5555`
3. Select master video file
4. Add audio sources (auto-detect or manual)
5. Assign audio types via dropdowns
6. Configure sync settings if needed
7. Select desired compound clips
8. Process to generate
9. Download zip archive
10. Start new job without refreshing

### File Organization Best Practices
- Use session-based naming: `YYYY-MM-DD N filename`
- Keep original audio files separate from processed files
- Multiple sessions can coexist in same directory
- Each session gets its own zip archive

### Sync Correction Guidelines
- **Use sync for**: Frame rate mismatches (29.97fps/30fps)
- **Don't use for**: Clock drift (use manual FCPX correction)
- **Warning system**: Alerts when processing already synced files
- **Per-file control**: Individual sync settings prevent over-correction

## Current Development Status

### Completed (v1.3)
- ✅ **Dropdown-based audio type assignment**
- ✅ **Selective XML generation with checkboxes**
- ✅ **Automatic file cleanup after zip creation**
- ✅ **Session-named folders inside zip archives**
- ✅ **Job re-execution without page refresh**
- ✅ **Improved visual design for audio file list**
- ✅ **Base files always included in generation**
- ✅ **Validation to prevent duplicate type assignments**

### Known Issues & Solutions
- **Double sync correction**: System prevents processing `_synced` files with sync enabled
- **Clock drift**: 16-frame drift over 3+ hours requires manual correction in FCPX
- **Unassigned files**: Visual indication and validation before processing

## Design Principles

- **User control**: Explicit type assignment and generation selection
- **Clean workspace**: Automatic cleanup maintains organization
- **Session isolation**: Each recording session managed independently
- **Visual feedback**: Clear status indication throughout workflow
- **No hardcoded values**: Everything configurable via YAML and interface
- **Modular architecture**: Easy to extend with new compound types
- **Gap-based structure**: Timeline elements move together as units
- **Relative paths**: XML files maintain correct media references regardless of location

The system successfully delivers a working v1.3 with comprehensive file management, selective generation, and automatic cleanup that maintains an organized workspace while providing full control over the editing workflow.