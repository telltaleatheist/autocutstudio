#!/usr/bin/env python3
"""
Apply audio drift correction using ffmpeg.
"""

import argparse
import subprocess
import sys
import json
from pathlib import Path


def get_audio_duration(input_path: str) -> float:
    """Get audio file duration in seconds using ffprobe."""
    cmd = [
        'ffprobe', '-v', 'quiet', '-print_format', 'json',
        '-show_format', str(input_path)
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        data = json.loads(result.stdout)
        duration = float(data['format']['duration'])
        return duration
    except Exception as e:
        print(f"Error getting audio duration: {e}", file=sys.stderr)
        return 0.0


def apply_drift_correction(input_path: str, drift_frames: float, duration: float, fps: float, output_path: str):
    """Apply drift correction to audio file.

    User workflow:
    1. Drop audio in editor, align at start
    2. Go to end of video and count time/frame offset
    3. Positive drift = audio is TOO SHORT, needs to be STRETCHED (slowed down)
       Negative drift = audio is TOO LONG, needs to be COMPRESSED (sped up)

    Args:
        drift_frames: If < 100, treated as seconds (e.g., 5.5 = 5s 15f at 30fps)
                     If >= 100, treated as frame count for backward compatibility
    """

    input_file = Path(input_path)

    if not input_file.exists():
        print(f"Error: Input file does not exist: {input_path}", file=sys.stderr)
        return False

    # Auto-detect audio duration
    if duration is None or duration <= 0:
        audio_duration = get_audio_duration(input_path)
        if audio_duration <= 0:
            print(f"Error: Could not determine audio duration", file=sys.stderr)
            return False
    else:
        audio_duration = duration

    # Interpret drift_frames parameter
    # New format: decimal seconds (e.g., 5.5 = 5 seconds + 15 frames at 30fps)
    # Legacy format: frame count (>= 100 is assumed to be frames)
    if abs(drift_frames) < 100:
        # Treat as seconds with fractional frame component
        drift_seconds = drift_frames
        # For display, convert to seconds + frames
        seconds_part = int(drift_seconds)
        frames_part = int(round((abs(drift_seconds) - abs(seconds_part)) * 30))
        drift_display = f"{seconds_part}s {frames_part}f"
    else:
        # Legacy: treat as frame count
        drift_seconds = drift_frames / fps
        drift_display = f"{drift_frames} frames"

    # Calculate target duration
    # Positive drift = need to add time (stretch/slow down)
    # Negative drift = need to remove time (compress/speed up)
    target_duration = audio_duration + drift_seconds

    if target_duration <= 0:
        print(f"Error: Target duration would be <= 0", file=sys.stderr)
        return False

    # Speed factor: original/target
    # To make audio longer (target > original), we slow down (factor < 1)
    # To make audio shorter (target < original), we speed up (factor > 1)
    correction_factor = audio_duration / target_duration

    print(f"Applying drift correction to {input_file.name}")
    print(f"  Original duration: {audio_duration:.2f} seconds")
    print(f"  Drift: {drift_display} ({drift_seconds:.3f} seconds)")
    print(f"  Target duration: {target_duration:.2f} seconds")
    print(f"  Speed factor: {correction_factor:.6f}")
    if drift_seconds > 0:
        print(f"  Action: Stretching audio by {abs(drift_seconds):.2f}s (slowing down)")
    elif drift_seconds < 0:
        print(f"  Action: Compressing audio by {abs(drift_seconds):.2f}s (speeding up)")
    else:
        print(f"  Action: No change")
    print(f"  Output: {output_path}")

    # Apply drift correction using ffmpeg atempo filter
    cmd = [
        'ffmpeg', '-i', str(input_path),
        '-filter:a', f'atempo={correction_factor}',
        '-c:a', 'pcm_s24le',  # 24-bit PCM for high quality
        '-y',  # Overwrite output
        str(output_path)
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        print(f"✓ Drift correction applied successfully")
        print(f"  Output saved to: {output_path}")
        return True
    except subprocess.CalledProcessError as e:
        print(f"Error applying drift correction:", file=sys.stderr)
        print(f"  Command: {' '.join(cmd)}", file=sys.stderr)
        print(f"  stderr: {e.stderr}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(description='Apply audio drift correction')
    parser.add_argument('--input', required=True, help='Input audio file path')
    parser.add_argument('--drift-frames', type=float, required=True, help='Drift in frames (negative = shrink, positive = expand)')
    parser.add_argument('--duration', type=float, default=0, help='Audio duration in seconds (auto-detected if not provided)')
    parser.add_argument('--fps', type=float, default=29.97, help='Video frame rate (default: 29.97)')
    parser.add_argument('--output', required=True, help='Output audio file path')

    args = parser.parse_args()

    success = apply_drift_correction(
        args.input,
        args.drift_frames,
        args.duration,
        args.fps,
        args.output
    )

    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()