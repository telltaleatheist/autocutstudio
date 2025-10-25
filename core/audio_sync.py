"""
Audio/Video Synchronization System using Cross-Correlation

This module provides universal sync capabilities for any audio/video file against a master source.
It detects time offsets, clock drift, and applies corrections automatically.

Key Features:
- Audio cross-correlation for precise offset detection
- Clock drift detection and correction (e.g., soundboard clock vs computer clock)
- Automatic framerate sync (30fps vs 29.97fps)
- Soundboard audio detection (files with 'sb' suffix)
- Universal interface for any audio/video source
"""

import subprocess
import json
from pathlib import Path
from typing import Optional, Tuple, Dict
import tempfile
import sys

# Auto-install dependencies if missing
_DEPENDENCIES_AVAILABLE = False
_DEPENDENCY_ERROR = None

# CRITICAL: Python 3.14 with scipy causes segfault - check version BEFORE attempting import
if sys.version_info >= (3, 14):
    _DEPENDENCY_ERROR = f"Python {sys.version_info.major}.{sys.version_info.minor} not supported (requires 3.10-3.13)"
else:
    try:
        import numpy as np
        from scipy import signal
        from scipy.io import wavfile
        import librosa
        _DEPENDENCIES_AVAILABLE = True
    except ImportError as ie:
        _DEPENDENCY_ERROR = str(ie)
    except Exception as e:
        _DEPENDENCY_ERROR = f"Import error: {e}"


def _check_dependencies():
    """Raise helpful error if dependencies are not available."""
    if not _DEPENDENCIES_AVAILABLE:
        error_msg = (
            "Audio sync dependencies (numpy, scipy, librosa) are not available.\n"
            "Python version: {}.{}\n"
        ).format(sys.version_info.major, sys.version_info.minor)

        if _DEPENDENCY_ERROR:
            error_msg += f"Import error: {_DEPENDENCY_ERROR}\n"

        if sys.version_info.major == 3 and sys.version_info.minor >= 14:
            error_msg += (
                "\nPython 3.14+ is not yet supported by librosa.\n"
                "Please use the conda environment with Python 3.10-3.13:\n"
                "  conda activate autocutstudio\n"
            )
        else:
            error_msg += (
                "\nTo install dependencies:\n"
                "  conda activate autocutstudio\n"
                "  conda install numpy scipy\n"
                "  pip install librosa\n"
            )

        raise RuntimeError(error_msg)


class AudioSyncAnalyzer:
    """Analyzes audio files to find time offset and clock drift using cross-correlation."""

    def __init__(self, config=None):
        _check_dependencies()  # Raise error if dependencies not available
        self.config = config or {}
        self.sample_rate = self.config.get('audio.sample_rate', 48000)
        # Downsample to this rate for faster correlation (still accurate to ~20ms)
        self.analysis_sample_rate = 8000

    def extract_audio_segment(self, file_path: str, start_seconds: float = 0,
                             duration_seconds: float = 60) -> Tuple[np.ndarray, int]:
        """Extract audio segment from video or audio file.

        Args:
            file_path: Path to audio or video file
            start_seconds: Start time in seconds
            duration_seconds: Duration to extract in seconds

        Returns:
            Tuple of (audio_data, sample_rate)
        """
        file_path = Path(file_path)

        # Use ffmpeg to extract audio segment
        temp_wav = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
        temp_wav.close()

        cmd = [
            'ffmpeg', '-i', str(file_path),
            '-ss', str(start_seconds),
            '-t', str(duration_seconds),
            '-vn',  # No video
            '-acodec', 'pcm_s16le',
            '-ar', str(self.analysis_sample_rate),
            '-ac', '1',  # Mono for simplicity
            '-y',
            temp_wav.name
        ]

        try:
            subprocess.run(cmd, capture_output=True, text=True, check=True)

            # Load audio using scipy
            sample_rate, audio_data = wavfile.read(temp_wav.name)

            # Clean up temp file
            Path(temp_wav.name).unlink()

            # Normalize to [-1, 1]
            if audio_data.dtype == np.int16:
                audio_data = audio_data.astype(np.float32) / 32768.0
            elif audio_data.dtype == np.int32:
                audio_data = audio_data.astype(np.float32) / 2147483648.0

            return audio_data, sample_rate

        except subprocess.CalledProcessError as e:
            print(f"Error extracting audio from {file_path}: {e}")
            print(f"stderr: {e.stderr}")
            raise

    def find_offset_cross_correlation(self, master_path: str, source_path: str,
                                     search_window_seconds: float = 30,
                                     analysis_duration: float = 60) -> Tuple[float, float]:
        """Find time offset between source and master using cross-correlation.

        Args:
            master_path: Path to master audio/video file
            source_path: Path to source audio/video file to sync
            search_window_seconds: How many seconds before/after to search for alignment
            analysis_duration: Duration of audio to analyze (longer = more accurate but slower)

        Returns:
            Tuple of (offset_seconds, correlation_score)
            - offset_seconds: How many seconds to shift source to align with master (positive = delay source)
            - correlation_score: Quality of match (0-1, higher is better)
        """
        print(f"\nAnalyzing audio sync between:")
        print(f"  Master: {Path(master_path).name}")
        print(f"  Source: {Path(source_path).name}")

        # Extract audio from both files
        # Start at search_window to allow for negative offsets
        master_audio, master_sr = self.extract_audio_segment(
            master_path,
            start_seconds=0,
            duration_seconds=search_window_seconds + analysis_duration
        )

        source_audio, source_sr = self.extract_audio_segment(
            source_path,
            start_seconds=0,
            duration_seconds=analysis_duration
        )

        print(f"  Master audio: {len(master_audio)} samples @ {master_sr}Hz")
        print(f"  Source audio: {len(source_audio)} samples @ {source_sr}Hz")

        # Perform cross-correlation
        correlation = signal.correlate(master_audio, source_audio, mode='valid')

        # Find peak correlation
        peak_index = np.argmax(correlation)
        peak_value = correlation[peak_index]

        # Normalize correlation score
        correlation_score = peak_value / (np.sqrt(np.sum(master_audio**2)) * np.sqrt(np.sum(source_audio**2)))

        # Convert peak index to time offset
        offset_samples = peak_index
        offset_seconds = offset_samples / master_sr

        print(f"  Offset found: {offset_seconds:.3f} seconds")
        print(f"  Correlation score: {correlation_score:.3f}")

        return offset_seconds, correlation_score

    def get_duration(self, file_path: str) -> float:
        """Get duration of audio/video file in seconds."""
        try:
            result = subprocess.run([
                'ffprobe', '-v', 'quiet', '-print_format', 'json',
                '-show_format', str(file_path)
            ], capture_output=True, text=True, check=True)

            data = json.loads(result.stdout)
            duration = float(data['format']['duration'])
            return duration

        except (subprocess.CalledProcessError, json.JSONDecodeError, KeyError) as e:
            print(f"Error getting duration from {file_path}: {e}")
            raise

    def detect_clock_drift(self, master_path: str, source_path: str,
                          offset_seconds: float) -> Tuple[float, float]:
        """Detect clock drift between source and master.

        Args:
            master_path: Path to master file
            source_path: Path to source file
            offset_seconds: Known offset at the start

        Returns:
            Tuple of (speed_factor, drift_frames_at_2997)
            - speed_factor: Multiply source speed by this to match master (e.g., 1.001 = 0.1% faster)
            - drift_frames_at_2997: Drift in frames at 29.97fps (for reference)
        """
        master_duration = self.get_duration(master_path)
        source_duration = self.get_duration(source_path)

        print(f"\nDetecting clock drift:")
        print(f"  Master duration: {master_duration:.3f}s")
        print(f"  Source duration: {source_duration:.3f}s")

        # Account for offset - source should be measured from where it aligns with master
        effective_source_duration = source_duration
        effective_master_duration = master_duration - offset_seconds

        # Calculate speed factor needed
        # If source is longer, we need to speed it up (factor > 1)
        # If source is shorter, we need to slow it down (factor < 1)
        speed_factor = effective_source_duration / effective_master_duration

        # Calculate drift in frames at 29.97fps for reference
        duration_diff = effective_source_duration - effective_master_duration
        drift_frames = duration_diff * 29.97

        print(f"  Duration difference: {duration_diff:.3f}s ({drift_frames:.1f} frames @ 29.97fps)")
        print(f"  Speed correction factor: {speed_factor:.6f}")

        return speed_factor, drift_frames

    def analyze_sync(self, master_path: str, source_path: str,
                    search_window: float = 30) -> Dict:
        """Complete sync analysis for a source file against master.

        Args:
            master_path: Path to master audio/video file
            source_path: Path to source file to sync
            search_window: Seconds to search for alignment

        Returns:
            Dict with keys:
                - offset_seconds: Time offset to apply to source
                - speed_factor: Speed adjustment factor
                - correlation_score: Quality of sync detection
                - drift_frames: Drift in frames at 29.97fps
                - is_soundboard: Whether this is a soundboard file
        """
        source_name = Path(source_path).name
        is_soundboard = 'sb.' in source_name.lower() or source_name.lower().endswith('sb.wav')

        # Find offset using cross-correlation
        offset_seconds, correlation_score = self.find_offset_cross_correlation(
            master_path, source_path,
            search_window_seconds=search_window
        )

        # Detect clock drift
        speed_factor, drift_frames = self.detect_clock_drift(
            master_path, source_path, offset_seconds
        )

        result = {
            'offset_seconds': offset_seconds,
            'speed_factor': speed_factor,
            'correlation_score': correlation_score,
            'drift_frames': drift_frames,
            'is_soundboard': is_soundboard,
            'source_file': str(source_path),
            'master_file': str(master_path)
        }

        if is_soundboard:
            print(f"  ⚠️  Soundboard file detected - will apply clock drift correction")

        return result


class MediaSyncProcessor:
    """Applies sync corrections to audio and video files."""

    def __init__(self, config=None):
        # MediaSyncProcessor doesn't need numpy/scipy for applying sync (uses ffmpeg)
        # But it needs AudioSyncAnalyzer for the sync_file method
        self.config = config or {}

    def apply_sync_to_audio(self, input_path: str, offset_seconds: float,
                           speed_factor: float, output_path: Optional[str] = None) -> str:
        """Apply offset and speed correction to audio file.

        Args:
            input_path: Path to input audio file
            offset_seconds: Time offset in seconds (will pad with silence if positive)
            speed_factor: Speed adjustment factor
            output_path: Optional output path

        Returns:
            Path to synced audio file
        """
        input_path = Path(input_path)

        if output_path is None:
            output_path = input_path.parent / f"{input_path.stem}_synced{input_path.suffix}"
        output_path = Path(output_path)

        print(f"\nApplying sync to audio: {input_path.name}")
        print(f"  Offset: {offset_seconds:.3f}s")
        print(f"  Speed factor: {speed_factor:.6f}")

        # Build ffmpeg filter
        filters = []

        # Apply speed adjustment if needed (allow 0.01% tolerance)
        if abs(speed_factor - 1.0) > 0.0001:
            # atempo has limits [0.5, 2.0], so chain multiple if needed
            if 0.5 <= speed_factor <= 2.0:
                filters.append(f'atempo={speed_factor:.6f}')
            else:
                # Chain multiple atempo filters
                remaining = speed_factor
                while remaining > 0:
                    if remaining > 2.0:
                        filters.append('atempo=2.0')
                        remaining /= 2.0
                    elif remaining < 0.5:
                        filters.append('atempo=0.5')
                        remaining /= 0.5
                    else:
                        filters.append(f'atempo={remaining:.6f}')
                        break

        # Apply offset (delay) if needed
        if abs(offset_seconds) > 0.001:
            # Use adelay for positive offset (delay audio)
            delay_ms = int(offset_seconds * 1000)
            if delay_ms > 0:
                filters.append(f'adelay={delay_ms}|{delay_ms}')
            else:
                # For negative offset, we trim from the start
                filters.append(f'atrim=start={abs(offset_seconds)}')

        filter_str = ','.join(filters) if filters else 'anull'

        cmd = [
            'ffmpeg', '-i', str(input_path),
            '-filter:a', filter_str,
            '-c:a', 'pcm_s24le',  # High quality PCM
            '-y',
            str(output_path)
        ]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            print(f"  ✓ Synced audio saved to: {output_path.name}")
            return str(output_path)
        except subprocess.CalledProcessError as e:
            print(f"  ✗ Error applying sync to {input_path}: {e}")
            print(f"stderr: {e.stderr}")
            raise

    def apply_sync_to_video(self, input_path: str, offset_seconds: float,
                           speed_factor: float, output_path: Optional[str] = None) -> str:
        """Apply offset and speed correction to video file.

        Args:
            input_path: Path to input video file
            offset_seconds: Time offset in seconds
            speed_factor: Speed adjustment factor
            output_path: Optional output path

        Returns:
            Path to synced video file
        """
        input_path = Path(input_path)

        if output_path is None:
            output_path = input_path.parent / f"{input_path.stem}_synced{input_path.suffix}"
        output_path = Path(output_path)

        print(f"\nApplying sync to video: {input_path.name}")
        print(f"  Offset: {offset_seconds:.3f}s")
        print(f"  Speed factor: {speed_factor:.6f}")

        # Build filters
        video_filters = []
        audio_filters = []

        # Apply speed adjustment
        if abs(speed_factor - 1.0) > 0.0001:
            # Video: use setpts to change speed
            video_filters.append(f'setpts=PTS/{speed_factor:.6f}')

            # Audio: use atempo (with chaining if needed)
            if 0.5 <= speed_factor <= 2.0:
                audio_filters.append(f'atempo={speed_factor:.6f}')
            else:
                remaining = speed_factor
                while remaining > 0:
                    if remaining > 2.0:
                        audio_filters.append('atempo=2.0')
                        remaining /= 2.0
                    elif remaining < 0.5:
                        audio_filters.append('atempo=0.5')
                        remaining /= 0.5
                    else:
                        audio_filters.append(f'atempo={remaining:.6f}')
                        break

        # Apply offset
        if abs(offset_seconds) > 0.001:
            if offset_seconds > 0:
                # Delay both video and audio
                video_filters.append(f'tpad=start_duration={offset_seconds}')
                delay_ms = int(offset_seconds * 1000)
                audio_filters.append(f'adelay={delay_ms}|{delay_ms}')
            else:
                # Trim from start
                trim_time = abs(offset_seconds)
                video_filters.append(f'trim=start={trim_time}')
                audio_filters.append(f'atrim=start={trim_time}')

        video_filter_str = ','.join(video_filters) if video_filters else 'null'
        audio_filter_str = ','.join(audio_filters) if audio_filters else 'anull'

        cmd = [
            'ffmpeg', '-i', str(input_path),
            '-filter:v', video_filter_str,
            '-filter:a', audio_filter_str,
            '-c:v', 'libx264',
            '-crf', '18',  # High quality
            '-preset', 'medium',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-y',
            str(output_path)
        ]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            print(f"  ✓ Synced video saved to: {output_path.name}")
            return str(output_path)
        except subprocess.CalledProcessError as e:
            print(f"  ✗ Error applying sync to {input_path}: {e}")
            print(f"stderr: {e.stderr}")
            raise

    def sync_file(self, master_path: str, source_path: str,
                 output_path: Optional[str] = None,
                 search_window: float = 30) -> Tuple[str, Dict]:
        """Complete sync workflow: analyze and apply corrections.

        Args:
            master_path: Path to master file
            source_path: Path to source file to sync
            output_path: Optional output path
            search_window: Seconds to search for alignment

        Returns:
            Tuple of (synced_file_path, sync_info_dict)
        """
        # Analyze sync
        analyzer = AudioSyncAnalyzer(self.config)
        sync_info = analyzer.analyze_sync(master_path, source_path, search_window)

        # Determine if source is video or audio
        source_path_obj = Path(source_path)
        video_extensions = {'.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.mpg', '.mpeg', '.m4v', '.webm'}
        is_video = source_path_obj.suffix.lower() in video_extensions

        # Apply sync
        if is_video:
            synced_path = self.apply_sync_to_video(
                source_path,
                sync_info['offset_seconds'],
                sync_info['speed_factor'],
                output_path
            )
        else:
            synced_path = self.apply_sync_to_audio(
                source_path,
                sync_info['offset_seconds'],
                sync_info['speed_factor'],
                output_path
            )

        return synced_path, sync_info
