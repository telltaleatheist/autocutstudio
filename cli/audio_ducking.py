#!/usr/bin/env python3
"""
Audio Ducking Module
Uses ffmpeg sidechaingate to duck one audio when another is loud.
"""

import sys
import subprocess
import shutil
from pathlib import Path
from typing import List, Tuple, Optional, Callable


def get_processed_path(input_path: str, extension: str = None) -> Path:
    """Get the _processed output path for a file, avoiding _processed_processed."""
    input_path = Path(input_path)
    stem = input_path.stem
    if stem.endswith('_processed'):
        stem = stem[:-10]
    ext = extension if extension else input_path.suffix
    return input_path.parent / f"{stem}_processed{ext}"


class AudioDucker:
    """Handle audio ducking operations using ffmpeg."""

    def __init__(self, progress_callback: Optional[Callable] = None):
        # Find ffmpeg executable in PATH
        self.ffmpeg_path = self._find_ffmpeg()
        if not self.ffmpeg_path:
            raise RuntimeError("ffmpeg not found in PATH. Please install ffmpeg.")
        self.progress_callback = progress_callback
        self.skip_check_callback = None  # Can be set by caller

    def _find_ffmpeg(self) -> Optional[str]:
        """Find ffmpeg executable in system PATH."""
        # Try common locations
        ffmpeg = shutil.which('ffmpeg')
        if ffmpeg:
            return ffmpeg

        # Try homebrew locations on macOS
        homebrew_paths = [
            '/opt/homebrew/bin/ffmpeg',
            '/usr/local/bin/ffmpeg'
        ]
        for path in homebrew_paths:
            if Path(path).exists():
                return path

        return None

    def duck_audio(
        self,
        audio_to_duck: str,
        trigger_audio: str,
        output_path: str,
        threshold: int = -40,
        ratio: int = 20,  # Maximum allowed ratio (20:1)
        attack: int = 10,
        release: int = 100
    ) -> str:
        """Duck one audio file when another is loud.

        Args:
            audio_to_duck: Path to audio file that will be lowered
            trigger_audio: Path to audio file that triggers the ducking
            output_path: Where to save the ducked audio
            threshold: How loud trigger needs to be (in dB, e.g., -40)
            ratio: How much to reduce audio when ducking (e.g., 20:1)
            attack: How fast to duck (in ms, e.g., 10)
            release: How fast to un-duck (in ms, e.g., 100)

        Returns:
            Path to the ducked audio file
        """
        print(f"Ducking '{Path(audio_to_duck).name}' when '{Path(trigger_audio).name}' is loud...")
        print(f"  Threshold: {threshold}dB, Ratio: {ratio}:1, Attack: {attack}ms, Release: {release}ms")

        # Build ffmpeg command with sidechaincompress filter
        # For dramatic/complete muting, we use max ratio (20) with a hard knee (1)
        # Hard knee = more aggressive compression = more dramatic effect
        cmd = [
            self.ffmpeg_path,  # Use the found ffmpeg path
            '-progress', 'pipe:2',  # Enable progress output
            '-i', str(audio_to_duck),    # Input audio to be ducked (lowered)
            '-i', str(trigger_audio),     # Trigger audio (when this is loud, duck the other)
            '-filter_complex',
            f'[0:a][1:a]sidechaincompress='
            f'threshold={threshold}dB:'   # When trigger exceeds this, start ducking
            f'ratio={ratio}:'             # Max ratio (20:1) for heavy reduction
            f'attack={attack}:'           # How fast to duck (10ms = quick)
            f'release={release}:'         # How fast to return (100ms = smooth)
            f'knee=1[out]',               # Hard knee (1) = very aggressive/dramatic
            '-map', '[out]',
            '-c:a', 'pcm_s16le',  # 16-bit PCM WAV
            '-y',  # Overwrite output
            str(output_path)
        ]

        try:
            # Use progress tracking if available
            if self.progress_callback:
                from core.ffmpeg_progress import FFmpegProgressTracker
                tracker = FFmpegProgressTracker(self.progress_callback)
                tracker.run_ffmpeg_with_progress(
                    cmd,
                    str(audio_to_duck),
                    f"Ducking {Path(audio_to_duck).name}",
                    skip_check_callback=self.skip_check_callback
                )
            else:
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    check=True
                )

            print(f"✓ Ducked audio saved to: {output_path}")
            return str(output_path)

        except subprocess.CalledProcessError as e:
            print(f"✗ Error ducking audio: {e}")
            print(f"  stderr: {e.stderr}")
            raise

    def process_ducking(
        self,
        audio1_path: str,
        audio2_path: str,
        mode: str = 'mutual',
        threshold: int = -40
    ) -> List[str]:
        """Process audio ducking based on mode.

        Args:
            audio1_path: Path to first audio file
            audio2_path: Path to second audio file
            mode: 'duck1' (duck audio1), 'duck2' (duck audio2), or 'mutual' (both)
            threshold: Threshold in dB for ducking trigger

        Returns:
            List of output file paths
        """
        audio1 = Path(audio1_path)
        audio2 = Path(audio2_path)
        output_files = []

        print(f"\n=== Audio Ducking ===")
        print(f"Mode: {mode}")
        print(f"Audio 1: {audio1.name}")
        print(f"Audio 2: {audio2.name}")
        print(f"Threshold: {threshold}dB\n")

        if mode == 'duck1' or mode == 'mutual':
            # Duck audio1 when audio2 is loud
            output1 = get_processed_path(audio1, '.wav')
            ducked1 = self.duck_audio(
                audio_to_duck=str(audio1),
                trigger_audio=str(audio2),
                output_path=str(output1),
                threshold=threshold
            )
            output_files.append(ducked1)

        if mode == 'duck2' or mode == 'mutual':
            # Duck audio2 when audio1 is loud
            output2 = get_processed_path(audio2, '.wav')
            ducked2 = self.duck_audio(
                audio_to_duck=str(audio2),
                trigger_audio=str(audio1),
                output_path=str(output2),
                threshold=threshold
            )
            output_files.append(ducked2)

        print(f"\n=== Ducking Complete ===")
        print(f"Created {len(output_files)} ducked file(s):")
        for f in output_files:
            print(f"  • {f}")

        return output_files


if __name__ == '__main__':
    # Test the audio ducker
    if len(sys.argv) < 3:
        print("Usage: python audio_ducking.py <audio1> <audio2> [mode] [threshold]")
        print("  mode: duck1, duck2, or mutual (default: mutual)")
        print("  threshold: dB threshold (default: -40)")
        sys.exit(1)

    audio1 = sys.argv[1]
    audio2 = sys.argv[2]
    mode = sys.argv[3] if len(sys.argv) > 3 else 'mutual'
    threshold = int(sys.argv[4]) if len(sys.argv) > 4 else -40

    ducker = AudioDucker()
    output_files = ducker.process_ducking(audio1, audio2, mode, threshold)

    print("\nDone!")
