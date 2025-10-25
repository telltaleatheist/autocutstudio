# Skip Button Feature - Complete Summary

## What Problem Does This Solve?

When processing videos, the workflow needs to **re-render** (re-encode) certain video and audio files to sync them with your master video. This re-rendering can take **30-120 seconds per file**, which adds up quickly when you have multiple sources.

**The skip button lets you skip these time-consuming re-renders when you don't need them.**

---

## What Is "Re-Rendering" and Why Does It Happen?

### The Problem: Mismatched Timing

Your recordings have timing issues:

1. **Different start times** - Camera starts 5 seconds before master
2. **Different frame rates** - Capture card records at 30fps, master is 29.97fps
3. **Clock drift** - Soundboard files drift by 13 frames over 4 hours

### The Solution: Re-Rendering

To fix these issues, the workflow:

1. **Analyzes audio** using cross-correlation to find exact time offset
2. **Speeds up/slows down** the video to match frame rates (30fps → 29.97fps)
3. **Re-encodes** the file with FFmpeg to apply these corrections

**This creates a NEW synced file** (e.g., `screen_capture_synced_2997.mov`)

### The Tradeoff

- ✅ **Perfect sync** - Everything lines up perfectly
- ❌ **Slow** - Re-encoding video takes 1-2 minutes per file
- ❌ **Quality loss** - Re-encoding degrades quality slightly

---

## When Can You Skip Re-Rendering?

The skip button appears for operations where you have an **alternative source** that's "good enough."

### ALWAYS SKIPPABLE - Video Sources

These videos are already in your master video, so you can use the master quadrants instead of re-rendering:

| Video Type | Master Quadrant | Why Skippable |
|------------|----------------|---------------|
| **Screen capture** | Top-left quadrant | Already recorded in master |
| **Game capture** | Bottom-right quadrant | Already recorded in master |
| **Cam 1** | Bottom-left quadrant | Already recorded in master |
| **Cam 2** | Top-right quadrant | Already recorded in master |

**Skip result:** Uses the quadrant from master video instead of re-rendering the separate capture.

### ALWAYS SKIPPABLE - Optional Audio

These audio tracks are nice-to-have but not required:

| Audio Type | Why Skippable |
|------------|---------------|
| **mic2, mic3, mic4** | Secondary microphones (optional) |
| **bluetooth** | Bluetooth audio (optional) |

**Skip result:** Completely omits this audio from the output (as if you never added it).

### CONDITIONALLY SKIPPABLE - Soundboard Files

Soundboard files (with "sb" in filename) can be skipped IF you have a non-SB alternative:

| File | Alternative | Skippable? |
|------|-------------|------------|
| `mic1 audio sb.wav` | `mic1 audio.wav` exists | ✅ YES - use non-SB version |
| `screen audio sb.wav` | `screen audio.wav` exists | ✅ YES - use non-SB version |
| `mic1 audio sb.wav` | NO alternative | ❌ NO - required for output |

**Skip result:** Uses the non-SB version instead of re-rendering the SB version.

### NEVER SKIPPABLE - Essential Audio

These are required and have no alternative:

| Audio Type | Why Can't Skip |
|------------|----------------|
| **mic1 audio.wav** | Primary microphone - essential for output |
| **screen audio.wav** | Screen/game audio - essential for output |

**Skip result:** Button is grayed out (disabled).

---

## How the Skip Button Works

### Visual Appearance

When processing a skippable operation, you'll see:

```
┌─────────────────────────────────────────────────┐
│ Overall Progress: 35% complete                  │
│ ████████████░░░░░░░░░░░░░░░░░░░                 │
│                                                  │
│ ┌──────────────────────────────────────────────┐│
│ │ Syncing screen video      45.2%   [⏩ Skip] ││
│ │ ██████████████░░░░░░░░░░░░                  ││
│ └──────────────────────────────────────────────┘│
│                                                  │
│ [Process Workflow]  [⏹ Cancel]                  │
└─────────────────────────────────────────────────┘
```

**Blue button** = Can skip (optional operation)
**Gray button** = Cannot skip (required operation)

### What Happens When You Click Skip

1. **Frontend** sends skip signal via IPC
2. **Electron** writes JSON to Python stdin: `{"type": "skip"}`
3. **Python** detects skip signal with non-blocking check
4. **Python** uses fallback instead of re-rendering:
   - Video: Use master quadrant
   - Optional audio: Omit entirely
   - SB audio: Use non-SB alternative
5. **Workflow** continues to next operation immediately

**Time saved:** 30-120 seconds per skipped operation!

---

## Technical Flow

### Complete Signal Chain

```
User clicks [⏩ Skip] button
    ↓
workflow.component.ts: skipCurrentOperation()
    ↓
electron.service.ts: sendSkipSignal()
    ↓
IPC: 'send-skip-signal'
    ↓
ipc-handlers.ts: pythonService.sendSkipSignal()
    ↓
python-service.ts: Write to stdin → {"type": "skip"}
    ↓
Python workflow: check_for_skip_signal()
    ↓
Detects skip = true
    ↓
Uses fallback, continues to next operation
```

### Event Flow (What Makes Button Appear)

```
Python emits: emit_operation_start("Syncing screen video", can_skip=True)
    ↓
JSON to stdout: {"type": "operation_start", "operation": "...", "can_skip": true}
    ↓
python-service.ts forwards to processing.service.ts
    ↓
processing.service.ts updates job: currentOperation, canSkipCurrent
    ↓
workflow.component.ts subscribes to job updates
    ↓
HTML template: *ngIf="isProcessing && currentOperation"
    ↓
Skip button appears!
```

---

## Real-World Example

### Scenario: Processing a gaming session

**Your files:**
- Master video (has all 4 quadrants: cam1, cam2, screen, game)
- Separate screen capture (30fps, better quality)
- Separate game capture (30fps, better quality)
- mic1 audio.wav (main mic)
- mic2 audio.wav (co-host mic)

### Without Skip Button (Old Behavior)

```
1. Syncing screen video...  [████████████] 100% (90 seconds)
2. Syncing game video...    [████████████] 100% (120 seconds)
3. Processing mic1 audio...  [████████████] 100% (5 seconds)
4. Processing mic2 audio...  [████████████] 100% (5 seconds)
5. Generating compounds...   [████████████] 100% (30 seconds)

Total time: 250 seconds (4 minutes 10 seconds)
```

### With Skip Button (New Behavior)

```
1. Syncing screen video...  [⏩ Skip] ← You click skip
   → Uses master top-left quadrant instead (instant!)

2. Syncing game video...    [⏩ Skip] ← You click skip
   → Uses master bottom-right quadrant instead (instant!)

3. Processing mic1 audio...  [████████████] 100% (5 seconds)
   → Cannot skip (required)

4. Processing mic2 audio...  [⏩ Skip] ← You click skip
   → Omits mic2 from output (instant!)

5. Generating compounds...   [████████████] 100% (30 seconds)

Total time: 35 seconds (saved 215 seconds = 3.5 minutes!)
```

---

## When Should You Skip?

### Skip When:

✅ **Master video quality is good enough** - Don't need the separate high-quality captures
✅ **You don't need the audio track** - mic2/3/4/bluetooth are optional
✅ **You're testing/iterating quickly** - Want faster preview, will do final render later
✅ **Time is more important than quality** - Need output quickly

### Don't Skip When:

❌ **You need highest quality** - Separate captures are higher quality than master quadrants
❌ **Audio sync is critical** - Need perfectly synced audio (re-rendering fixes drift)
✅ **This is the final export** - You want best possible quality
❌ **Master quadrant has issues** - Corruption, dropped frames, etc.

---

## Quality Comparison

### Using Separate Screen Capture (Re-rendered)
- **Pros:** Higher bitrate, better quality, perfectly synced
- **Cons:** Takes 90 seconds to re-encode, slight quality loss from re-encoding

### Using Master Quadrant (Skipped)
- **Pros:** Instant (no re-encoding), no quality loss from re-encoding
- **Cons:** Lower bitrate (1/4 of master), already compressed once

**Recommendation:** Skip for previews/drafts, don't skip for final exports.

---

## File Management

### When You Skip

When you skip an operation, **only the skipped file is deleted** (if it was created):

**Example:** You skip screen capture processing
- ❌ Deletes: `screen_capture_synced.mp4` (the re-encoded file that was being created)
- ✅ Keeps: Original `screen capture.mp4` (your source file)
- ✅ Keeps: All other synced files from previous operations

### When Workflow Completes

All generated files persist after workflow completion:
- ✅ Synced audio files (`*_synced.wav`)
- ✅ Synced video files (`*_synced.mp4`)
- ✅ Compound XML files (in ZIP)
- ✅ All original source files

**You manage cleanup yourself** - delete what you don't need when you're done.

---

## Summary

The skip button is a **time-saving feature** that lets you choose between:

1. **Perfect quality + slow** (re-render everything)
2. **Good enough + fast** (use master quadrants/skip optional files)

It's intelligent - only shows for operations where you have a safe alternative, and never lets you skip essential files.

**Typical time savings:** 2-5 minutes per workflow when skipping 3-4 operations.
