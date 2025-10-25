# Soundboard Auto-Detect Feature

## Overview

Added automatic detection and assignment of soundboard audio files to dedicated media slots, making it easy to work with both VMix and Soundboard recordings in the same project.

---

## What Was Added

### 1. **New Audio Source Types**

Added 6 new soundboard-specific audio types:

**Frontend Types** (`types.ts`):
- `mic1Sb` - Mic 1 (Soundboard)
- `mic2Sb` - Mic 2 (Soundboard)
- `screenSb` - Screen Audio (Soundboard)
- `desktopSb` - Desktop Audio (Soundboard)
- `bluetoothSb` - Bluetooth (Soundboard)
- `soundEffectsSb` - Sound Effects (Soundboard)

**Backend Types** (auto-detect):
- `mic-1-sb`
- `mic-2-sb`
- `screen-sb`
- `desktop-sb`
- `bluetooth-sb`
- `sound-effects-sb`

### 2. **Enhanced Auto-Detect Logic**

**Old Behavior**:
- Found mic 1, mic 2, screen, etc. files
- Preferred non-sb files
- Ignored sb files if non-sb existed

**New Behavior**:
- Detects **both** VMix and Soundboard files separately
- Assigns VMix files to regular slots (`mic1`, `mic2`, etc.)
- Assigns Soundboard files to dedicated slots (`mic1Sb`, `mic2Sb`, etc.)
- Detects desktop audio soundboard (Windows desktop audio)

**Example Detection**:
```
Files in directory:
  2025-10-23 mic 1 audio.wav        → mic1 (VMix)
  2025-10-23 mic 1 audio sb.wav     → mic1Sb (Soundboard)
  2025-10-23 mic 2 audio sb.wav     → mic2Sb (Soundboard)
  2025-10-23 screen audio sb.wav    → screenSb (Soundboard)
  2025-10-23 desktop audio sb.wav   → desktopSb (Soundboard)
```

### 3. **Soundboard Detection Pattern**

Files are identified as soundboard if they contain:
- ` sb ` (with spaces)
- `_sb_` (with underscores)
- `-sb-` (with hyphens)
- ` sb.wav` (at end)
- `_sb.wav` (at end)

**Case Insensitive**: Works with `SB`, `Sb`, or `sb`

---

## How It Works

### Auto-Detect Flow:

1. **User clicks "Auto-Detect"** in the UI
2. System scans master video directory for matching files
3. For each audio type (mic 1, mic 2, screen, etc.):
   - Finds all matching files
   - Separates VMix files (no 'sb') from Soundboard files (has 'sb')
   - Assigns VMix file to regular slot
   - Assigns Soundboard file to dedicated SB slot
4. **Frontend displays** both file types as separate sources
5. **User can choose** to use VMix, Soundboard, or both

### Unified Sync Integration:

The soundboard files detected by auto-detect will automatically:
1. Be identified by unified sync system (has 'sb' in filename)
2. Get synced together using single correlation
3. Receive same offset and clock drift correction
4. Be ready for FCPX import

---

## User Workflow

### Step 1: Select Master Video
```
Select: 2025-10-23 master.mp4
```

### Step 2: Click Auto-Detect
```
[Auto-Detect Media Files]
```

### Step 3: Review Detected Files

**VMix Files** (already synced to 29.97fps):
- ✓ Mic Audio 1
- ✓ Mic Audio 2
- ✓ Screen Audio

**Soundboard Files** (will be synced automatically):
- ✓ Mic 1 (Soundboard)
- ✓ Mic 2 (Soundboard)
- ✓ Screen Audio (Soundboard)
- ✓ Desktop Audio (Soundboard)

### Step 4: Process Workflow
```
[Start Workflow]

→ Soundboard files detected
→ Unified sync: Mic 1 + Mic 2
→ Detect offset: 11 frames
→ Detect drift: 1.000110x
→ Apply to all SB files
→ Generate FCPX projects
```

### Step 5: Use in FCPX
```
Import both VMix and Soundboard files
Mix and match as needed:
  - Use VMix mic 1 for convenience
  - Use Soundboard mic 1 for better quality
  - Use Soundboard desktop audio (not in VMix)
```

---

## Benefits

### 1. **Flexibility**
- Have access to both VMix and Soundboard versions
- Choose best quality for each track
- Desktop audio available when needed

### 2. **Automatic Sync**
- No manual configuration
- Single correlation syncs all SB files
- Handles variable drift automatically

### 3. **Better Organization**
- Clear labeling (VMix vs Soundboard)
- Easy to identify file sources
- No confusion about which file to use

### 4. **Quality Options**
- VMix: Pre-synced, convenient
- Soundboard: Higher quality, separate tracks
- Mix both in same project

---

## File Naming Requirements

### For Auto-Detection:

**VMix Files** (from VMix outputs):
```
✓ 2025-10-23 mic 1 audio.wav
✓ 2025-10-23 mic 2 audio.wav
✓ 2025-10-23 screen audio.wav
```

**Soundboard Files**:
```
✓ 2025-10-23 mic 1 audio sb.wav
✓ 2025-10-23 mic 2 audio sb.wav
✓ 2025-10-23 screen audio sb.wav
✓ 2025-10-23 desktop audio sb.wav
✓ 2025-10-23 bluetooth sb.wav
✓ 2025-10-23 sound effects sb.wav
```

**Key**: Must have session prefix (`YYYY-MM-DD`) and contain 'sb' for soundboard files

---

## Technical Details

### Files Modified:

#### 1. `frontend/src/app/models/types.ts`
- Added 6 new soundboard audio types
- Added labels for UI display
- Updated type unions

#### 2. `frontend/src/app/components/workflow/workflow.component.ts`
- Added soundboard types to audio types array
- Updated auto-detect type mapping
- Maps backend types to frontend types

#### 3. `electron/ipc/ipc-handlers.ts`
- Enhanced auto-detect logic
- Separates VMix from Soundboard files
- Detects desktop audio soundboard
- Returns both types in separate slots

### Type Mapping:

**Backend → Frontend**:
```typescript
{
  'mic-1': 'mic1',           // VMix
  'mic-1-sb': 'mic1Sb',      // Soundboard
  'mic-2': 'mic2',           // VMix
  'mic-2-sb': 'mic2Sb',      // Soundboard
  'screen': 'screen',        // VMix
  'screen-sb': 'screenSb',   // Soundboard
  'desktop-sb': 'desktopSb', // Soundboard only
  // ... etc
}
```

---

## Example Scenarios

### Scenario 1: Full Recording Session

**Files**:
- VMix Output 2: mic 1 audio.wav (Mic 1 + Mic 2 combined)
- VMix Output 3: screen audio.wav (Screen + Desktop + Bluetooth combined)
- Soundboard: mic 1 audio sb.wav (Mic 1 separate)
- Soundboard: mic 2 audio sb.wav (Mic 2 separate)
- Soundboard: screen audio sb.wav (Screen audio separate)
- Soundboard: desktop audio sb.wav (Desktop audio separate)
- Soundboard: bluetooth sb.wav (Bluetooth separate)

**Auto-Detect Result**:
- ✓ 8 files detected and assigned
- ✓ All soundboard files synced together
- ✓ Ready for flexible editing in FCPX

### Scenario 2: Minimal Setup

**Files**:
- VMix Output 4: master.mp4 (everything mixed)
- Soundboard: mic 1 audio sb.wav
- Soundboard: screen audio sb.wav

**Auto-Detect Result**:
- ✓ 2 soundboard files detected
- ✓ Synced via unified system
- ✓ Use for separate track control

### Scenario 3: Desktop Audio Only

**Files**:
- VMix Output 4: master.mp4
- Soundboard: desktop audio sb.wav (Windows desktop, not in VMix)

**Auto-Detect Result**:
- ✓ Desktop audio detected
- ✓ Synced to master timeline
- ✓ Available for editing (not in any VMix output)

---

## UI Display

### Media Source List:

```
Audio Sources:
  [✓] Mic Audio 1 (VMix)              [2025-10-23 mic 1 audio.wav]
  [✓] Mic 1 (Soundboard)              [2025-10-23 mic 1 audio sb.wav]
  [✓] Mic 2 (Soundboard)              [2025-10-23 mic 2 audio sb.wav]
  [✓] Screen Audio (VMix)             [2025-10-23 screen audio.wav]
  [✓] Screen Audio (Soundboard)       [2025-10-23 screen audio sb.wav]
  [✓] Desktop Audio (Soundboard)      [2025-10-23 desktop audio sb.wav]
```

Clear labeling makes it easy to identify source.

---

## Console Output Example

### During Auto-Detect:
```
Detected mic-1 (VMix): mic 1 audio.wav
Detected mic-1-sb (Soundboard): mic 1 audio sb.wav
Detected mic-2-sb (Soundboard): mic 2 audio sb.wav
Detected screen (VMix): screen audio.wav
Detected screen-sb (Soundboard): screen audio sb.wav
Detected desktop-sb (Soundboard): desktop audio sb.wav
```

### During Workflow Processing:
```
======================================================================
SOUNDBOARD FILES DETECTED - Using Unified Sync
======================================================================
Found 4 soundboard files:
  - mic1Sb: mic 1 audio sb.wav
  - mic2Sb: mic 2 audio sb.wav
  - screenSb: screen audio sb.wav
  - desktopSb: desktop audio sb.wav

[Correlation and sync...]

======================================================================
Soundboard unified sync complete!
  Offset: 0.367s
  Speed: 1.000110
  Drift: 60.7 frames
======================================================================
```

---

## Future Enhancements

### Potential Additions:
1. **Visual indicators**: Show VMix vs Soundboard with icons
2. **Quality comparison**: Show file size/bitrate differences
3. **Preference setting**: Default to VMix or Soundboard
4. **Batch operations**: Apply sync/settings to all SB files
5. **Auto-selection**: Smart selection based on quality

---

## Summary

✅ **Added**: 6 new soundboard audio types
✅ **Enhanced**: Auto-detect separates VMix and Soundboard files
✅ **Integrated**: Works seamlessly with unified soundboard sync
✅ **Flexible**: Use VMix, Soundboard, or both in same project

The system now automatically detects and properly assigns both VMix and Soundboard recordings, making it easy to work with your complete multi-device recording setup!
