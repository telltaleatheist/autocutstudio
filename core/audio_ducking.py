#!/usr/bin/env python3
"""
Audio Ducking Module
Uses ffmpeg sidechaingate to duck one audio when another is loud.
"""

import subprocess
from pathlib import Path
from typing import List, Tuple


class AudioDucker:
    """Handle audio ducking operations using ffmpeg."""

    def __init__(self):
        pass

    def duck_audio(
        self,
        audio_to_duck: str,
        trigger_audio: str,
        output_path: str,
        threshold: int = -40,
        ratio: int = 20,
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

        # Build ffmpeg command with sidechaingate filter
        cmd = [
            'ffmpeg',
            '-i', str(audio_to_duck),    # Input audio to be ducked
            '-i', str(trigger_audio),     # Trigger audio
            '-filter_complex',
            f'[0:a][1:a]sidechaingate='
            f'threshold={threshold}dB:'
            f'ratio={ratio}:'
            f'attack={attack}:'
            f'release={release}:'
            f'makeup=0:'
            f'knee=2.828:'
            f'detection=rms:'
            f'link=average[out]',
            '-map', '[out]',
            '-c:a', 'pcm_s16le',  # 16-bit PCM WAV
            '-y',  # Overwrite output
            str(output_path)
        ]

        try:
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
            output1 = audio1.parent / f"{audio1.stem}_ducked{audio1.suffix}"
            ducked1 = self.duck_audio(
                audio_to_duck=str(audio1),
                trigger_audio=str(audio2),
                output_path=str(output1),
                threshold=threshold
            )
            output_files.append(ducked1)

        if mode == 'duck2' or mode == 'mutual':
            # Duck audio2 when audio1 is loud
            output2 = audio2.parent / f"{audio2.stem}_ducked{audio2.suffix}"
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
    import sys

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
