#!/usr/bin/env python3
"""
Apply audio drift correction using ffmpeg.
"""

import argparse
import subprocess
import sys
from pathlib import Path


def apply_drift_correction(input_path: str, drift_frames: float, duration: float, fps: float, output_path: str):
    """Apply drift correction to audio file."""

    input_file = Path(input_path)

    if not input_file.exists():
        print(f"Error: Input file does not exist: {input_path}", file=sys.stderr)
        return False

    # Calculate correction factor
    # Positive drift = expand audio (slower/longer), Negative drift = shrink audio (faster/shorter)
    total_frames = duration * fps
    correction_factor = 1 + (drift_frames / total_frames)

    print(f"Applying drift correction to {input_file.name}")
    print(f"  Drift: {drift_frames} frames over {duration:.1f} seconds")
    print(f"  Correction factor: {correction_factor:.6f}")
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
    parser.add_argument('--duration', type=float, required=True, help='Video duration in seconds')
    parser.add_argument('--fps', type=float, required=True, help='Video frame rate')
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