# Sync Bug Fix Summary

## Critical Bug Found and Fixed

### Issue 1: Screen Capture Sync (30fps → 29.97fps) - WRONG DIRECTION

**Problem**: The code was speeding up 30fps video instead of slowing it down.

**Location**: `core/audio_processor.py:268-333` (`sync_video_for_2997fps`)

**Old (Wrong) Behavior**:
```python
speed_factor = 1.001001  # 30/29.97 = speeding up
# Result: Video gets SHORTER (finishes ~550 frames early over 5 hours)
```

**New (Correct) Behavior**:
```python
speed_factor = 29.97 / 30.0  # 0.999 = slowing down
# Result: Video gets LONGER (same frames play at 29.97fps instead of 30fps)
```

**Why This Matters**:
- **30fps screen capture** has MORE frames per second than **29.97fps timeline**
- To keep same number of frames in sync, you need to SLOW DOWN the playback
- Think: same frames, longer duration = slower playback = lower fps

**Math Verification**:
```
5h 6min video (18360s):
- Old method: 18360s becomes 18341s (-18.36s = -550 frames) - TOO SHORT
- New method: 18360s becomes 18378s (+18.38s = +551 frames) - CORRECT

At 4:19:10:
- Old method: Video 466-557 frames AHEAD (depending on other factors)
- New method: Video stays IN SYNC
```

### Issue 2: Soundboard Audio Sync - Not Being Applied

**Problem**: Advanced sync (cross-correlation + clock drift correction) requires Python 3.10-3.13.

**Current Status**: The Electron app likely uses system Python 3.14, so advanced sync is DISABLED.

**Result**:
- Soundboard files get NO clock drift correction
- Only basic framerate sync is applied (if enabled)
- Clock differences between recording devices accumulate over hours

**Evidence from Your Test**:
- 6 frames early at start (offset not detected)
- 6 frames late at 4 hours (12 frame total drift not corrected)
- This is ~0.4s drift over 4 hours = 0.0028% clock difference

**Solution Options**:

1. **Run via conda environment** (has Python 3.11):
   ```bash
   conda activate autocutstudio
   /opt/homebrew/Caskroom/miniconda/base/envs/autocutstudio/bin/python3 -m cli.electron_workflow
   ```

2. **Install librosa for Python 3.14** (when it becomes available)

3. **Accept basic sync only** (no cross-correlation, no clock drift correction)

## Files Changed

### `core/audio_processor.py`
**Line 268-333**: Fixed `sync_video_for_2997fps()` to slow down instead of speed up

**Changes**:
- Speed factor: `1.001001` → `0.999` (inverted)
- Comments updated to explain correct behavior
- Filter application remains the same (setpts/atempo)

## Testing Recommendations

### Test 1: Screen Capture Sync
1. Record a 30fps screen capture for 5+ minutes
2. Run workflow with the fixed code
3. Import synced file into FCPX on 29.97fps timeline
4. Check alignment at start, middle, and end
5. **Expected**: Should stay in sync throughout

### Test 2: Soundboard Audio Sync (with conda)
1. Use conda environment: `conda activate autocutstudio`
2. Run workflow via conda Python
3. Check console for "Advanced audio sync" message
4. Verify synced audio has both offset and speed corrections applied
5. **Expected**: Sub-frame accuracy throughout recording

### Test 3: Verify Python Version
```bash
# Check which Python Electron is using
which python3
python3 --version

# Should be 3.14 (no advanced sync)
# For advanced sync, use conda:
/opt/homebrew/Caskroom/miniconda/base/envs/autocutstudio/bin/python3 --version
# Should be 3.10-3.13
```

## Root Cause Analysis

### Why Was The Direction Wrong?

The confusion comes from two different sync scenarios:

**Scenario A: Matching wall-clock time** (WRONG for FCPX)
- "Speed up 30fps to finish at same time as 29.97fps"
- Use factor = 30/29.97 = 1.001
- Makes video SHORTER

**Scenario B: Matching frame count** (CORRECT for FCPX)
- "Play 30fps frames at 29.97fps rate"
- Use factor = 29.97/30 = 0.999
- Makes video LONGER

FCPX needs Scenario B because it's timeline-based, not wall-clock based.

## Impact

### Before Fix:
- Screen captures drifted ~550 frames over 5 hours
- Had to manually adjust by 9 seconds and 17 frames
- Unusable for long recordings

### After Fix:
- Screen captures should stay in sync
- May need minor adjustment (< 10 frames over 5 hours)
- Soundboard audio still needs conda environment for full sync

## Next Steps

1. Test the screen capture fix with a long recording
2. Decide on Python version strategy:
   - Keep system Python 3.14 (no advanced sync) OR
   - Bundle conda Python 3.11 with Electron app OR
   - Wait for librosa to support Python 3.14
3. Consider hardware encoding for faster re-rendering (separate issue)
