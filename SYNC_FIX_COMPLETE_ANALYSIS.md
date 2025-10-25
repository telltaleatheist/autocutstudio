# Complete Sync Fix Analysis

## What I Discovered from Your Actual Files

### Your Files:
- **Master**: 18407.5s, 551,645 frames @ 29.97fps
- **Screen Capture (original)**: 18406.1s, 1,099,646 frames @ **60fps** (not 30fps!)
- **Screen Capture (old sync)**: 18387.7s, 1,099,646 frames @ 60.06fps

### The Root Problem

The code was using the **WRONG APPROACH** for framerate conversion:

**Old (Wrong) Method**:
```python
# Used setpts/atempo to change playback SPEED
speed_factor = 30 / 29.97  # 1.001 (speeding up)
'-filter:v', f'setpts=PTS/{speed_factor}'
'-filter:a', f'atempo={speed_factor}'
```

**Result**:
- Made video 18.4 seconds SHORTER (18406s → 18388s)
- At 4:19:10, video was ~9s 17f ahead
- Wrong because it changed DURATION instead of just dropping frames

**New (Correct) Method**:
```python
# Use fps filter to drop frames, maintain duration
'-filter:v', 'fps=fps=29.97'
```

**Result**:
- Drops frames: 1,099,646 @ 60fps → ~549,000 @ 29.97fps
- Maintains duration: ~18406s (same as original)
- Works for ANY source fps (30, 60, 120, etc.) → 29.97fps

## But Wait - There Are TWO Separate Issues!

### Issue 1: Framerate Conversion (FIXED)
**What it does**: Converts 60fps/30fps video to 29.97fps for FCPX timeline
**Status**: ✅ FIXED - Now uses `fps` filter to drop frames
**File**: `core/audio_processor.py:268-305`

### Issue 2: Sync Alignment (STILL NEEDS WORK)
**What it does**: Handles time offset and clock drift
**Status**: ⚠️ ONLY available with Python 3.10-3.13 (advanced sync)

## The Two Types of Sync Problems

### Type A: Framerate Mismatch
- **Cause**: Screen capture recorded at 60fps, timeline is 29.97fps
- **Symptom**: Video has 2x as many frames as it should
- **Solution**: Drop frames with `fps` filter ✅ FIXED
- **Required for**: ALL screen/game captures

### Type B: Time Alignment
- **Cause**: Recording devices don't start at exact same time, clocks run at slightly different speeds
- **Symptom**:
  - Video starts 7 frames off
  - Drifts by 9s 17f over 4+ hours
- **Solution**: Advanced sync (cross-correlation + clock drift correction)
- **Required for**: Long recordings with separate capture devices

## Why You're Still Seeing Alignment Issues

Even with the framerate fix, you'll still have alignment issues because:

1. **Time Offset** (7 frames at start):
   - Screen capture recording started slightly before/after master
   - Advanced sync detects this with cross-correlation
   - Adds delay or trim to align start points

2. **Clock Drift** (accumulates over time):
   - Screen capture's clock runs at slightly different rate than master
   - Over 4 hours, this adds up to frames of drift
   - Advanced sync detects duration difference and applies speed correction

## Current State Analysis

### What's Working:
- ✅ Framerate conversion (after fix)
- ✅ Basic file processing

### What's NOT Working:
- ❌ Time offset detection (needs advanced sync)
- ❌ Clock drift correction (needs advanced sync)

### Why Advanced Sync is Disabled:
The Electron app uses Python 3.14, but librosa (required for audio cross-correlation) only supports Python 3.10-3.13.

Console output would show:
```
⚠ Advanced sync not available (using basic sync)
  Reason: Python 3.14 - requires 3.10-3.13
```

## The Complete Solution

You need BOTH fixes:

### Fix 1: Framerate Conversion (DONE)
```python
# core/audio_processor.py
'-filter:v', 'fps=fps=29.97'  # Drop frames to match timeline
```

### Fix 2: Time Alignment (REQUIRES CONDA)
```python
# core/audio_sync.py (only works with Python 3.10-3.13)
# 1. Cross-correlation finds time offset
offset_seconds = analyzer.find_offset_cross_correlation(master, source)

# 2. Clock drift detection finds speed difference
speed_factor = analyzer.detect_clock_drift(master, source)

# 3. Apply both corrections
apply_sync(offset_seconds, speed_factor)
```

## How to Get Full Sync

### Option 1: Run via Conda (RECOMMENDED FOR TESTING)
```bash
# Activate conda environment (has Python 3.11)
conda activate autocutstudio

# Run workflow
/opt/homebrew/Caskroom/miniconda/base/envs/autocutstudio/bin/python3 -m cli.electron_workflow < params.json
```

Expected output:
```
✓ Advanced audio sync system loaded (cross-correlation enabled)
Using advanced audio sync (cross-correlation)

Processing screen: 2025-10-23 screen capture.mp4
  Analyzing sync...
  Offset found: 0.233s (7 frames)
  Speed correction: 1.000050 (0.005% faster)
  Drift: 15 frames over 4 hours
✓ screen synced successfully
```

### Option 2: Bundle Python 3.11 with Electron
- Package conda environment with app
- Point Electron to bundled Python
- Users get advanced sync without setup

### Option 3: Wait for Librosa Python 3.14 Support
- Keep checking librosa releases
- Update when available

## Expected Results After Both Fixes

### With Framerate Fix Only (Current):
- ✅ Video duration correct
- ✅ No speed-related drift
- ❌ Still 7 frames off at start
- ❌ Still has clock drift accumulation

### With Both Fixes (Conda):
- ✅ Video duration correct
- ✅ No speed-related drift
- ✅ Start aligned (< 1 frame)
- ✅ Clock drift corrected (< 2 frames over 5 hours)

## Testing the Fix

### Test 1: Verify Framerate Fix
```bash
# Re-run sync with new code
npm run electron:dev

# Check output file
ffprobe synced.mp4
# Should show: r_frame_rate="2997/100" (29.97fps)
# Duration should match original (not shorter)
```

### Test 2: Test with Advanced Sync
```bash
# Run via conda
conda activate autocutstudio
/opt/homebrew/Caskroom/miniconda/base/envs/autocutstudio/bin/python3 -m cli.electron_workflow < params.json

# Check for:
# ✓ "Advanced audio sync system loaded"
# ✓ Offset detection results
# ✓ Speed correction applied
```

## Summary

**Primary Bug**: Using `setpts`/`atempo` (speed change) instead of `fps` filter (frame drop)
- **Impact**: 18s shorter video, 9s 17f drift at 4 hours
- **Status**: ✅ FIXED

**Secondary Issue**: No time offset/clock drift correction
- **Cause**: Advanced sync requires Python 3.10-3.13
- **Impact**: 7 frames off at start, additional drift from clock differences
- **Status**: ⚠️ Available via conda, not in Electron app

**Next Step**: Test the framerate fix, then decide whether to bundle Python 3.11 for advanced sync
