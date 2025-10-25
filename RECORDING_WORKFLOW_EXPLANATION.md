# Recording Workflow Explanation

## Overview

This document explains the multi-device recording setup used for content creation, including the sync challenges that arise from using multiple independent recording systems.

---

## Recording Devices & Systems

### Device 1: VMix (Windows Computer)

**Recording Mode**: Outputs record at **29.97fps** (synced to timeline)

**Outputs Recorded**:

- **Output 2**: Cam Capture + Mic 1 Audio (combined)
  - Produces: `mic 1 audio.wav` (29.97fps, synced)
  - Audio and video recorded together and separately

- **Output 3**: [Variable content] + Screen Audio
  - Produces: `screen audio.wav` (29.97fps, synced)
  - Audio always synced because it's recording at 29.97fps

- **Output 4**: Master Video + Master Audio
  - Produces: `master.mp4` (29.97fps, synced)
  - Contains ALL sources mixed together
  - This is the timeline reference

**Independent Sources Recorded** (recorded at original framerate):

- **Screen Capture**:
  - Produces: `screen capture.mp4` (60fps, NOT synced)
  - Video only (no audio track)
  - Started by VMix at same time as outputs, but may be a few frames or ~1 second apart

- **Game Capture** (when used):
  - Produces: `game capture.mp4` (60fps if captured, NOT synced)
  - Video only or with game audio
  - Game audio is NOT included in master audio
  - Rarely used

### Device 2: Soundboard (Separate Computer/Device)

**Recording Mode**: Independent device with its own clock speed

**What It Captures**:
- ALL audio passing through the soundboard before it goes to VMix
- Sources: Mic 1, Mic 2, Mic 3, Mic 4, Bluetooth, Screen Audio, Sound Effects

**Files Produced**:
- `mic 1 audio sb.wav` - Just Mic 1
- `mic 2 audio sb.wav` - Just Mic 2
- `screen audio sb.wav` - Just Screen Audio
- `bluetooth audio sb.wav` - Just Bluetooth
- `sound effects sb.wav` - Just Sound Effects
- Possibly a master combo file (all sources mixed)

**Current Usage**:
- Mic 3 and Mic 4 are not connected (files will be empty/unused)
- Active soundboard files: Mic 1, Mic 2, Bluetooth, Screen Audio, Sound Effects

**Key Characteristics**:
- **Different clock speed** than VMix computer
- **Started manually** - hit record button separately from VMix
- Usually started at the same time, but can be **seconds apart**
- **Clock drift varies** by recording session:
  - Sometimes 12 frames over 5 hours
  - Sometimes 19 frames over 5 hours
  - Sometimes 23 frames over 3 hours
  - This variation is WHY manual sync doesn't work

---

## Audio Signal Flow

```
Physical Sources (Mics, Screen, etc.)
    ↓
Soundboard (records individual tracks)
    ↓
VMix (receives mixed audio, records outputs)
    ↓
Master Video (all audio mixed together)
```

**Important**: The soundboard sits BEFORE VMix in the signal chain, so:
- Soundboard files capture the raw, individual sources
- VMix files capture the audio after it passes through the soundboard
- Both are recording THE SAME audio, just at different points in the chain

---

## Sync Challenges

### Challenge 1: Independent Start Times

**Problem**: VMix and Soundboard are started manually
- Both hit "record" at approximately the same time
- Can be **seconds apart** due to manual button pressing
- Exact offset varies per recording session

**Solution Needed**: Auto-detect time offset using cross-correlation

### Challenge 2: Different Clock Speeds

**Problem**: Soundboard has different clock speed than VMix
- Causes audio drift over long recordings
- Drift amount **varies per session** (12-23 frames over 3-5 hours)
- Cannot use fixed manual correction

**Solution Needed**: Auto-detect clock drift and apply speed correction

### Challenge 3: Variable Frame Rates

**Problem**: Independent video sources record at native framerate
- Screen Capture: 60fps (needs conversion to 29.97fps)
- Game Capture: 60fps (needs conversion to 29.97fps)
- VMix Outputs: Already 29.97fps (no conversion needed)

**Solution Needed**: Auto-detect source framerate and convert to 29.97fps

### Challenge 4: Video Start Time Variance

**Problem**: Screen/Game captures started by VMix at same time as outputs
- Can start a **few frames or ~1 second apart**
- Exact offset varies per recording

**Solution Needed**: Detect and correct video offset

---

## Why Cross-Correlation is Failing

### Current Approach (Wrong):
```
Compare: Soundboard Mic 1 → Master Video
Problem: Master has Mic 1 + Mic 2 + Screen + Everything mixed together
Result: Poor correlation (0.456) or NaN
```

The soundboard mic file contains ONLY Mic 1 audio, but the master contains Mic 1 PLUS all other sources mixed together. The cross-correlation algorithm can't find a clear match because:
1. Mic 1 is buried in the mix
2. Other sounds are overlapping/competing
3. Signal-to-noise ratio is poor for correlation

### Correct Approach:
```
Compare: Soundboard Mic 1 → VMix Mic 1 Output
Result: Both contain the SAME audio source
Expected: High correlation (>0.7)
```

Both files contain the same Mic 1 audio:
- One from soundboard (needs sync)
- One from VMix output (already synced to 29.97fps)
- Cross-correlation should work much better

---

## Proposed Sync Strategy

### For Soundboard Audio Files:

**Sync each soundboard file to its corresponding VMix output**:

1. `mic 1 audio sb.wav` → sync to → `mic 1 audio.wav`
2. `mic 2 audio sb.wav` → sync to → `mic 2 audio.wav` (if available)
3. `screen audio sb.wav` → sync to → `screen audio.wav`

**Process**:
1. Cross-correlation detects time offset (seconds apart at start)
2. Duration comparison detects clock drift (varies per session)
3. Apply both corrections:
   - Offset: Trim/delay audio to align start
   - Speed: Adjust playback speed to match clock (atempo filter)

### For Video Files:

**Screen/Game Capture**:
1. Detect source framerate (60fps, 30fps, etc.)
2. Convert to 29.97fps using fps filter (drops frames, maintains duration)
3. Optionally: Detect time offset vs master if needed

---

## File Usage in FCPX

**Question to Answer**: Which files are actually used in the final edit?

**Option A**: Use VMix files (already synced)
- Pros: Already synced to 29.97fps, no processing needed
- Cons: Quality may be lower than soundboard files?

**Option B**: Use synced soundboard files
- Pros: Better audio quality from soundboard?
- Cons: Requires sync processing

**Option C**: Mix and match
- Use soundboard files where quality matters
- Use VMix files where convenience matters

---

## Technical Specifications

### VMix Recordings:
- **Framerate**: 29.97fps (constant)
- **Audio Sync**: Locked to video timeline
- **Start Time**: Synchronized across all outputs

### Soundboard Recordings:
- **Sample Rate**: [To be determined]
- **Clock Speed**: Independent, varies per session
- **Start Time**: Manual, seconds offset from VMix
- **Drift Rate**: 0.002-0.005% faster/slower (varies)

### Independent Video Sources:
- **Screen Capture**: 60fps, no audio
- **Game Capture**: 60fps, may have game audio
- **Start Time**: VMix-controlled, but may lag by frames/seconds

---

## Why Manual Sync Doesn't Work

**The Problem**: Clock drift varies by recording session

**Examples**:
- Session 1: 12 frames drift over 5 hours (speed = 1.000020x)
- Session 2: 19 frames drift over 5 hours (speed = 1.000032x)
- Session 3: 23 frames drift over 3 hours (speed = 1.000064x)

**Why it varies**:
- Soundboard clock speed isn't perfectly stable
- Temperature, power supply, other factors affect clock
- Each recording session has slightly different drift

**Solution Required**: Auto-detect drift per session and apply appropriate speed correction

---

## Summary for AI Assistants

When helping with this workflow, remember:

1. **Soundboard files need sync** (different clock + manual start)
2. **Compare soundboard to VMix outputs** (not to master)
3. **Drift varies per session** (no fixed correction value)
4. **60fps videos need framerate conversion** (not speed adjustment)
5. **Master contains everything mixed** (poor correlation reference)

The key insight: Sync soundboard files to their corresponding clean VMix output files, NOT to the mixed master.
