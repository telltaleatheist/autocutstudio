# AutoCutStudio Performance Investigation

## Date: 2026-01-01

## Problem - RESOLVED
FCPX was experiencing 9-11 second delays on every action. Initially suspected to be XML complexity from AutoCutStudio-generated files, but investigation revealed it was corrupted FCPX preferences/containers.

### Resolution
Clearing FCPX preferences and sandboxed containers fixed the issue:
```bash
# Delete preferences
defaults delete com.apple.FinalCut

# Delete sandboxed containers
rm -rf "$HOME/Library/Containers/com.apple.FinalCut"
rm -rf "$HOME/Library/Containers/com.apple.FinalCut.FxAnalyzer"
rm -rf "$HOME/Library/Group Containers/PTN9T2S29T.com.apple.videoProApps/com.apple.FinalCut"
rm -rf "$HOME/Library/Application Support/Final Cut Pro"
rm -rf "$HOME/Library/Application Scripts/com.apple.FinalCut"
rm -rf "$HOME/Library/Application Scripts/com.apple.FinalCut.FxAnalyzer"
```

**Likely cause:** Corrupted cache/state data in the sandboxed containers from a crash, interrupted operation, or OS/FCPX update that left stale data.

---

## XML Optimizations Made (kept)

### 1. Removed `conform-rate` elements from master project generator
**File:** `core/compound_generators/master_project_generator.py`

**Issue:** Every ref-clip in the master project had a `<conform-rate srcFrameRate="29.97" />` element, even though the compound clips are already at 29.97fps. This caused FCPX to perform unnecessary framerate conforming calculations on ~17,775 elements.

**Fix:** Removed all conform-rate elements from the master project generator. The compound clips already handle framerate conversion internally (e.g., 60fps screen capture is retimed via timeMap inside SSB/GS compounds).

### 2. Skip audio effects on disabled clips
**File:** `core/xml_utils.py`

**Issue:** Audio effects (Voice Isolation, Compressor, Noise Gate) were being added to all audio clips, including disabled ones. This caused FCPX to process effects on muted audio tracks.

**Fix:** Added early return in `create_clip_with_audio_effects()` when `enabled=False`:
```python
# Skip adding audio effects for disabled clips (no point processing effects on muted audio)
if not enabled:
    return clip
```

**Result:**
- **GS compound:** All audio is disabled -> no effects added (was adding effects to 5+ disabled tracks)
- **CAM compound:** Master audio (disabled) has no effects; mic audio (enabled) keeps effects
- **SSB compound:** Master audio (disabled) has no effects; screen audio (enabled) keeps effects

---

## Segment Split (reverted to 1 hour)
**File:** `core/compound_generators/master_project_generator.py`

Projects are split into ~1 hour segments. This was temporarily changed to 30 minutes during investigation but reverted since XML complexity wasn't the root cause.

- A 4-hour video creates 4 parts (~1 hour each)
- A 2.5-hour video creates 3 parts (~50 min each)

---

## Files Modified

1. `core/compound_generators/master_project_generator.py`
   - Removed conform-rate elements
   - Segment split at 1 hour (reverted from 30 min)

2. `core/xml_utils.py`
   - Skip audio effects for disabled clips

---

## Verification Commands

```bash
# Should be 0 for master project (no conform-rate elements)
grep -c "conform-rate" your_file_SOLO.fcpxml

# Should be 0 for GS compound (all audio disabled, no effects)
grep -c "Compressor\|Noise Gate\|voiceIsolation" your_file_GS.fcpxml
```
