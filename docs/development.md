# AutoCutStudio Development Documentation

## Project Overview

AutoCutStudio is a Python-based automation tool for YouTube content creators that streamlines the multi-camera video editing workflow in Final Cut Pro X (FCPX). The tool automates the creation of templated compound clips with precise audio/video synchronization and multi-cam layouts.

## Current Project Status (WORKING v1.5)

### Completed Core Functionality
AutoCutStudio has a **fully functional end-to-end workflow** with a modern web interface that processes video files from raw master recordings to Final Cut Pro ready compound clips, packaged in organized zip archives.

**Working Features:**
- ✅ **Modern web interface**: Flask-based UI with comprehensive project management
- ✅ **Flexible audio management**: Add files to project, then assign audio types via dropdown
- ✅ **Audio corrections system**: Independent pre-processing for sync and drift corrections
- ✅ **Clock drift correction**: Fix audio/video drift with frame-level precision
- ✅ **29.97fps sync correction**: Handle framerate mismatches between sources
- ✅ **Session-based auto-detection**: Automatically matches audio files by session (e.g., "2025-09-03 1")
- ✅ **Video-to-audio extraction**: Supports video files as audio sources with automatic extraction
- ✅ **Selective XML generation**: Choose which compound clips to generate (base files always included)
- ✅ **Complete workflow automation**: Single command processes master video through all stages
- ✅ **Auto-editor integration**: Automatically identifies and cuts silence/pauses
- ✅ **6 compound clip generation**: Solo and dual camera modes for CAM, GS, and SSB layouts
- ✅ **Master project generation (v1.5)**: Rebuilt from scratch to properly combine all compounds with multi-lane timeline structure
- ✅ **8 audio source support**: mic1-4, screen, game, sound effects, bluetooth
- ✅ **Audio processing pipeline**: Extraction, format conversion, and selective corrections
- ✅ **Automatic file cleanup**: XMLs packaged in zip then deleted to maintain clean workspace
- ✅ **Job re-execution**: Process button re-enables after completion for immediate new jobs
- ✅ **Configuration-driven**: All positioning, scaling, and paths stored in YAML
- ✅ **Modular architecture**: Future-proofed with abstraction layers

**Current Web Workflow:**
1. Select master video file using modal file browser
2. Auto-detect or manually add audio sources to project
3. Assign audio types using dropdown selectors for each file
4. **Apply audio corrections independently (optional)**:
   - Check "Apply" for files needing correction
   - Select "29.97" for framerate sync and/or "Drift" for clock drift
   - Enter drift frames (positive to shorten, negative to extend)
   - Click "Apply Audio Corrections Now" to pre-process files
5. Select which compound clips to generate (optional - defaults to all)
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
  - `SOLO Master`: Combined timeline with all solo compounds on separate lanes
  - `DC Master`: Combined timeline with all dual camera compounds on separate lanes

### Master Project Generation (v1.5)

**Complete Timeline Structure Rebuild:**
The master project generator has been completely rewritten to build timelines from scratch rather than copying and modifying existing structures. This ensures proper multi-lane organization and compound referencing.

**Master Project Timeline Structure:**
- **Main spine**: CAM video (srcEnable="video")
- **Lane -2**: SSB audio (srcEnable="audio")
- **Lane -1**: CAM audio (srcEnable="audio")  
- **Lane 1**: GS compound (muted with -96dB)
- **Lane 2**: SSB video (srcEnable="video")

**Key Improvements:**
- Extracts compound media definitions directly from generated CAM, GS, SSB XMLs
- Builds proper resource sections with consistent IDs (r2=CAM, r6=SSB, r12=GS)
- Creates timeline cuts matching the auto-editor's edit decisions
- Properly sets conform-rate to 29.97fps for all nested clips
- Generates both SOLO and DC versions with appropriate naming
- Maintains correct timing relationships across all lanes

### Audio Corrections System (v1.4)

**Independent Audio Pre-Processing:**
The system now includes a dedicated audio corrections panel that operates independently of XML generation, allowing users to fix sync issues before or after generating compound clips.

**Clock Drift Correction:**
- **Problem**: Independent recording devices (VMix vs soundboard) have slight clock differences
- **Symptom**: Audio drifts 13 frames over 3 hours (0.0042% drift = 42 PPM)
- **Solution**: Enter drift frames to calculate and apply precise speed correction
- **Input**:
  - Negative values (-13): Shortens audio by 13 frames (shrinks/speeds up audio)
  - Positive values (+13): Extends audio by 13 frames (expands/slows down audio)
- **Calculation**: `correction_factor = 1 - (drift_frames / (video_duration * fps))`
- **Implementation**: Uses FFmpeg's `atempo` filter for high-quality time stretching

**29.97fps Sync Correction:**
- **Problem**: Camera records at 29.97fps while audio interface records at 30fps
- **Solution**: Apply 1.001x speed correction to audio files
- **Use case**: Frame rate mismatches between recording devices

**File Naming Convention:**
- Original: `2025-09-14 mic 1 audio.wav`
- 29.97 sync only: `2025-09-14 mic 1 audio_synced.wav`
- Drift only (shrink): `2025-09-14 mic 1 audio_drift_minus13f.wav`
- Drift only (expand): `2025-09-14 mic 1 audio_drift_plus13f.wav`
- Both corrections: `2025-09-14 mic 1 audio_synced_drift_minus13f.wav`

**Correction Controls Per File:**
- **Apply**: Master checkbox to enable corrections for this file
- **29.97**: Apply framerate sync correction
- **Drift**: Apply global drift correction value
- Visual "Corrected" badge shows on processed files

### Web Interface Architecture

**Audio Management System:**
- **File List**: Shows all added audio/video files with status
- **Type Assignment**: Dropdown selector for each file to assign audio type
- **Duplicate Prevention**: Shows "(in use)" for already assigned types
- **Visual Feedback**: Unassigned files highlighted differently
- **Correction Controls**: Individual checkboxes for each type of correction

**Audio Corrections Panel:**
- **Global Drift Setting**: Single input for all files marked with "Drift"
- **Real-time Calculation**: Shows correction factor as you type
- **Batch Processing**: Apply corrections to multiple files at once
- **Independent Operation**: Works separately from XML generation

**XML Generation Options:**
- **Organized Layout**: Compounds grouped by camera type (Solo/Dual)
- **Select All/None**: Quick selection controls
- **Default Behavior**: All compounds selected by default
- **Base Files**: Auto-editor and compound base always generated

**User Experience Flow:**
1. Select master video file
2. Use auto-detect to find matching audio files in same session
3. Or manually add files and assign types via dropdowns
4. Optionally apply audio corrections for sync issues
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
2. **Independent Audio Corrections**: Pre-process audio for sync issues before XML generation
3. **Smart File Management**: Automatic cleanup after zip creation keeps workspace organized
4. **Selective Generation**: Choose exactly which compounds you need
5. **Session Organization**: Zip archives contain session-named folders for multi-session workflows
6. **Job Continuity**: No page refresh needed between processing jobs
7. **Visual Feedback**: Clear indication of file status, type assignments, and corrections applied

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
    syncFix: false,  // 29.97fps correction
    applyCorrections: false,  // Master toggle
    applyDrift: false  // Clock drift correction
  }
};
```

**Type Assignment Validation:**
- Prevents duplicate type assignments
- Shows availability status in dropdown
- Visual indication for unassigned files
- Correction controls only enabled after type assignment

### Audio Corrections Processing

**Drift Correction Calculation:**
```python
# For 13 frames drift over 2:51:38 (171.63 minutes)
total_frames = 171.63 * 60 * 29.97  # Total frames in video
correction_factor = 1 + (13 / total_frames)  # = 1.000042
# Apply using FFmpeg: atempo=1.000042
```

**Processing Pipeline:**
1. Check which files have "Apply" checked
2. For each file:
   - Apply 29.97 sync if checked (1.001x speed)
   - Apply drift correction if checked (calculated factor)
3. Generate new filenames with clear suffixes
4. Update project to use corrected files
5. Show "Corrected" badge on processed files

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
6. **Apply corrections if needed:**
   - Check "Apply" on files needing correction
   - Select "29.97" and/or "Drift" per file
   - Enter drift frames (+ to shorten, - to extend)
   - Click "Apply Audio Corrections Now"
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
- **29.97 sync**: For frame rate mismatches (29.97fps vs 30fps)
- **Clock drift**: For independent device timing differences
- **Negative drift**: Audio needs to be shortened (shrink/speed up audio)
- **Positive drift**: Audio needs to be extended (expand/slow down audio)
- **Warning system**: Visual indicators for already corrected files
- **Per-file control**: Individual correction settings prevent over-correction

## Current Development Status

### Completed (v1.5)
- ✅ **Master project generator rebuilt from scratch**
- ✅ **Proper multi-lane timeline structure**
- ✅ **Direct compound extraction from source XMLs**
- ✅ **Consistent resource ID management**
- ✅ **Automatic timeline duration calculation**
- ✅ **Smart collections for library organization**

### Completed (v1.4)
- ✅ **Independent audio corrections panel**
- ✅ **Clock drift correction with frame-level precision**
- ✅ **Bidirectional drift support (positive/negative)**
- ✅ **Real-time correction factor calculation**
- ✅ **Batch audio processing before XML generation**
- ✅ **Clear file naming for corrected files**
- ✅ **Visual feedback for corrected files**
- ✅ **Per-file correction selection**

### Known Issues & Solutions
- **Clock drift vs frame rate issues**: System differentiates between the two types of sync problems
- **Double correction prevention**: Visual badges and naming conventions prevent reprocessing
- **Drift calculation**: Requires master video selection for accurate frame count

## Design Principles

- **User control**: Explicit type assignment and correction selection
- **Independent processing**: Audio corrections separate from XML generation
- **Clean workspace**: Automatic cleanup maintains organization
- **Session isolation**: Each recording session managed independently
- **Visual feedback**: Clear status indication throughout workflow
- **No hardcoded values**: Everything configurable via YAML and interface
- **Modular architecture**: Easy to extend with new compound types or corrections
- **Gap-based structure**: Timeline elements move together as units
- **Relative paths**: XML files maintain correct media references regardless of location

The system successfully delivers a working v1.5 with comprehensive file management, independent audio corrections for both framerate and clock drift issues, selective generation, rebuilt master project generation with proper multi-lane timeline structure, and automatic cleanup that maintains an organized workspace while providing full control over the editing workflow.