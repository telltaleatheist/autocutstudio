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
from typing import Optional, Tuple, Dict, Callable
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


def get_processed_path(input_path: str, extension: str = None, output_dir: str = None) -> Path:
    """Get the _processed output path for a file, avoiding _processed_processed."""
    input_path = Path(input_path)
    stem = input_path.stem
    if stem.endswith('_processed'):
        stem = stem[:-10]
    ext = extension if extension else input_path.suffix
    out_dir = Path(output_dir) if output_dir else input_path.parent
    return out_dir / f"{stem}_processed{ext}"


class AudioSyncAnalyzer:
    """Analyzes audio files to find time offset and clock drift using cross-correlation."""

    def __init__(self, config=None):
        _check_dependencies()  # Raise error if dependencies not available
        self.config = config or {}
        self.sample_rate = self.config.get('audio.sample_rate', 48000)
        # Downsample to this rate for faster correlation (still accurate to ~20ms)
        self.analysis_sample_rate = 8000

    def _load_drift_config(self) -> dict:
        """Load drift correction configuration from config file."""
        from .drift_config import load_drift_config
        return load_drift_config()

    def merge_audio_files(self, file1: str, file2: Optional[str] = None) -> str:
        """Merge two audio files into a temporary combined file.

        If file2 is None or doesn't exist, returns file1 unchanged.
        If both exist, creates a temporary mixed file.

        Args:
            file1: Path to first audio file (required)
            file2: Path to second audio file (optional)

        Returns:
            Path to merged audio file (temporary if merged, original if not)
        """
        # If no second file, just return the first
        if not file2 or not Path(file2).exists():
            return file1

        # Create temporary file for merged audio
        temp_merged = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
        temp_merged.close()

        # Use ffmpeg to mix the two audio files
        # amix filter adds them together (like a mixer)
        cmd = [
            'ffmpeg',
            '-i', str(file1),
            '-i', str(file2),
            '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=longest',
            '-c:a', 'pcm_s16le',
            '-y',
            temp_merged.name
        ]

        try:
            subprocess.run(cmd, capture_output=True, text=True, check=True)
            return temp_merged.name
        except subprocess.CalledProcessError as e:
            Path(temp_merged.name).unlink(missing_ok=True)
            raise RuntimeError(
                f"Failed to merge audio files '{file1}' and '{file2}' for sync detection: "
                f"{e.stderr[-500:] if e.stderr else e}"
            ) from e

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

            if len(audio_data) == 0:
                raise RuntimeError(
                    f"Extracted audio segment from {file_path} is empty "
                    f"(start={start_seconds}s, duration={duration_seconds}s) — "
                    "the requested range may be past the end of the file"
                )

            # Normalize to [-1, 1]
            if audio_data.dtype == np.int16:
                audio_data = audio_data.astype(np.float32) / 32768.0
            elif audio_data.dtype == np.int32:
                audio_data = audio_data.astype(np.float32) / 2147483648.0

            return audio_data, sample_rate

        finally:
            Path(temp_wav.name).unlink(missing_ok=True)

    def find_offset_cross_correlation(self, master_path: str, source_path: str,
                                     search_window_seconds: float = 30,
                                     analysis_duration: float = 30) -> Tuple[float, float]:
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

        Note: both files are read from t=0 and the master window extends past the
        source window, so the detectable offset range is [0, search_window] — the
        source starting BEFORE the master (a negative offset) cannot be detected
        by this method and would peak at 0.
        """
        # Extract audio from both files
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

        # mode='valid' requires the master segment to be at least as long as the
        # source segment; if the master file is shorter than the analysis window,
        # scipy would silently correlate with swapped semantics and produce an
        # offset with the wrong meaning.
        if len(master_audio) < len(source_audio):
            raise RuntimeError(
                f"Master audio segment ({len(master_audio) / master_sr:.1f}s) is shorter than "
                f"the source analysis segment ({len(source_audio) / source_sr:.1f}s). "
                f"Master file '{master_path}' is too short for sync detection "
                f"(needs at least {search_window_seconds + analysis_duration:.0f}s)."
            )

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

    # NOTE: A detect_clock_drift() method used to live here. It was dead code
    # (no callers) and its end-of-file measurement was broken: it correlated two
    # equal-length segments with mode='valid', which yields a single-element
    # result, so the "offset at end" was always 0 and any nonzero start offset
    # would have been misread as drift. Drift correction is done via the
    # empirically measured device factors in drift_corrections.json instead.

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
        from .naming import is_soundboard_filename
        is_soundboard = is_soundboard_filename(source_path)

        # Find offset using cross-correlation
        offset_seconds, correlation_score = self.find_offset_cross_correlation(
            master_path, source_path,
            search_window_seconds=search_window
        )

        # Apply device-specific drift correction if this is a soundboard file
        speed_factor = 1.0
        drift_frames = 0.0

        if is_soundboard:
            # Load drift corrections config
            drift_config = self._load_drift_config()
            sb_config = drift_config.get('soundboard', {})

            if sb_config.get('enabled', True):
                speed_factor = sb_config.get('speed_factor', 1.0)
                # Calculate drift frames (assuming typical 4-hour recording at 29.97fps)
                # drift_frames represents how many frames of drift over the recording length
                # For a 4-hour recording: 4 * 3600 * 29.97 = 431,712 frames
                # drift = (speed_factor - 1.0) * total_frames
                # We'll use the master duration to estimate
                from .audio_processor import AudioProcessor
                processor = AudioProcessor(self.config if hasattr(self, 'config') else None)
                try:
                    master_duration = processor.get_duration_seconds(master_path)
                    drift_frames = (speed_factor - 1.0) * master_duration * 29.97
                    print(f"  🎚️  Soundboard device-specific drift correction: {speed_factor:.10f} ({drift_frames:.1f} frames over {master_duration/3600:.1f}h)", file=sys.stderr)
                except Exception as e:
                    # drift_frames is informational only (the speed factor is what
                    # gets applied), so a failed duration probe is logged, not fatal
                    print(f"  🎚️  Soundboard device-specific drift correction: {speed_factor:.10f} (duration probe failed: {e})", file=sys.stderr)

        result = {
            'offset_seconds': offset_seconds,
            'speed_factor': speed_factor,
            'correlation_score': correlation_score,
            'drift_frames': drift_frames,
            'is_soundboard': is_soundboard,
            'source_file': str(source_path),
            'master_file': str(master_path)
        }

        if speed_factor != 1.0:
            print(f"  ✓ Offset detected: {offset_seconds:.3f}s (with drift correction: {speed_factor:.10f})", file=sys.stderr)
        else:
            print(f"  ✓ Offset detected: {offset_seconds:.3f}s (no drift correction needed)", file=sys.stderr)

        return result


class MediaSyncProcessor:
    """Applies sync corrections to audio and video files."""

    def __init__(self, config=None, progress_callback: Optional[Callable] = None):
        # MediaSyncProcessor doesn't need numpy/scipy for applying sync (uses ffmpeg)
        # But it needs AudioSyncAnalyzer for the sync_file method
        self.config = config or {}
        self.progress_callback = progress_callback
        self.skip_check_callback = None  # Can be set by caller

    def _has_audio_stream(self, video_path: str) -> bool:
        """Check if video file has an audio stream.

        Args:
            video_path: Path to video file

        Returns:
            True if video has audio, False otherwise
        """
        try:
            cmd = [
                'ffprobe', '-v', 'error',
                '-select_streams', 'a:0',
                '-show_entries', 'stream=codec_type',
                '-of', 'json',
                str(video_path)
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            data = json.loads(result.stdout)
            return 'streams' in data and len(data['streams']) > 0
        except Exception as e:
            # A failed probe must not be treated as "no audio" — that would
            # silently reroute the file to framerate-only sync with no offset.
            raise RuntimeError(
                f"Could not determine whether {video_path} has an audio stream: {e}"
            ) from e

    def _apply_framerate_sync_only(self, video_path: str, output_path: Optional[str] = None) -> str:
        """Apply framerate sync only (no audio analysis).

        This is used when the video has no audio track and cross-correlation
        is not possible. Converts video to 29.97fps.

        Args:
            video_path: Path to input video
            output_path: Optional output path

        Returns:
            Path to synced video file
        """
        video_path = Path(video_path)

        if output_path is None:
            output_path = get_processed_path(video_path)
        output_path = Path(output_path)

        print(f"\nApplying framerate-only sync to: {video_path.name}")

        # Detect source framerate
        source_fps = self._get_video_framerate(str(video_path))
        target_fps = 29.97

        print(f"  Source framerate: {source_fps:.2f} fps")
        print(f"  Target framerate: {target_fps} fps")

        # Check if conversion is needed
        if abs(source_fps - target_fps) < 0.1:
            print(f"  ✓ Already at {target_fps}fps, copying file")
            import shutil
            shutil.copy2(str(video_path), str(output_path))
            return str(output_path)

        print(f"  Converting {source_fps:.2f}fps → {target_fps}fps")

        # Build ffmpeg command
        cmd = [
            'ffmpeg',
            '-progress', 'pipe:2',  # Enable progress output to stderr
            '-i', str(video_path),
            '-filter:v', 'fps=fps=29.97',
            '-c:v', 'libx264',
            '-crf', '23',
            '-preset', 'faster',
            '-y',
            str(output_path)
        ]

        try:
            # Use progress tracking if available
            if self.progress_callback:
                from core.ffmpeg_progress import FFmpegProgressTracker
                tracker = FFmpegProgressTracker(self.progress_callback)
                tracker.run_ffmpeg_with_progress(
                    cmd,
                    str(video_path),
                    f"Syncing {video_path.name}",
                    skip_check_callback=self.skip_check_callback
                )
            else:
                result = subprocess.run(cmd, capture_output=True, text=True, check=True)

            print(f"  ✓ Synced video saved to: {output_path.name}")
            return str(output_path)
        except subprocess.CalledProcessError as e:
            print(f"  ✗ Error syncing video: {e}")
            print(f"stderr: {e.stderr}")
            raise

    def _get_video_framerate(self, video_path: str) -> float:
        """Get framerate of video file.

        Args:
            video_path: Path to video file

        Returns:
            Framerate as float
        """
        try:
            cmd = [
                'ffprobe', '-v', 'error',
                '-select_streams', 'v:0',
                '-show_entries', 'stream=r_frame_rate',
                '-of', 'json',
                str(video_path)
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            data = json.loads(result.stdout)

            if 'streams' not in data or len(data['streams']) == 0:
                raise RuntimeError(f"No video stream found in {video_path}")
            r_frame_rate = data['streams'][0].get('r_frame_rate')
            if not r_frame_rate:
                raise RuntimeError(f"Video stream in {video_path} has no r_frame_rate")
            num, den = map(int, r_frame_rate.split('/'))
            if den == 0 or num == 0:
                raise RuntimeError(f"Invalid r_frame_rate '{r_frame_rate}' in {video_path}")
            return num / den
        except Exception as e:
            # Do not silently assume 29.97 — a wrong framerate here changes
            # whether (and how) the file gets converted.
            raise RuntimeError(f"Could not detect framerate of {video_path}: {e}") from e

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
            output_path = get_processed_path(input_path, '.wav')
        output_path = Path(output_path)

        # Check if this is a soundboard file (needs dual mono conversion)
        from .naming import is_soundboard_filename
        is_soundboard = is_soundboard_filename(str(input_path))

        # Build ffmpeg filter
        filters = []

        # Apply speed adjustment if needed (allow 0.0001% tolerance)
        # Even tiny drifts matter over long recordings (e.g., 12 frames over 4 hours = 0.003%)
        if abs(speed_factor - 1.0) > 0.000001:

            # atempo has limits [0.5, 2.0], so chain multiple if needed
            if 0.5 <= speed_factor <= 2.0:
                filters.append(f'atempo={speed_factor:.10f}')
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
                        filters.append(f'atempo={remaining:.10f}')
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

        # For soundboard files, convert to dual mono (same audio in both channels)
        if is_soundboard:
            filters.append('pan=stereo|c0=c0|c1=c0')

        filter_str = ','.join(filters) if filters else ('pan=stereo|c0=c0|c1=c0' if is_soundboard else 'anull')

        cmd = [
            'ffmpeg', '-i', str(input_path),
            '-filter:a', filter_str,
            '-c:a', 'pcm_s24le',  # High quality PCM
            '-ac', '2',  # Force 2 channels output
            '-y',
            str(output_path)
        ]

        try:
            # Use progress tracking if available (same as video sync)
            if self.progress_callback:
                from core.ffmpeg_progress import FFmpegProgressTracker
                tracker = FFmpegProgressTracker(self.progress_callback)
                tracker.run_ffmpeg_with_progress(
                    cmd,
                    str(input_path),
                    f"Syncing {input_path.name}",
                    skip_check_callback=self.skip_check_callback
                )
            else:
                # Fall back to simple subprocess if no progress callback
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
            output_path = get_processed_path(input_path)
        output_path = Path(output_path)

        print(f"\nApplying sync to video: {input_path.name}")
        print(f"  Offset: {offset_seconds:.3f}s")
        print(f"  Speed factor: {speed_factor:.6f}")

        # Build filters
        video_filters = []
        audio_filters = []

        # Apply speed adjustment
        if abs(speed_factor - 1.0) > 0.000001:
            # Video: use setpts to change speed
            video_filters.append(f'setpts=PTS/{speed_factor:.10f}')

            # Audio: use atempo (with chaining if needed)
            if 0.5 <= speed_factor <= 2.0:
                audio_filters.append(f'atempo={speed_factor:.10f}')
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
                        audio_filters.append(f'atempo={remaining:.10f}')
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
            # Use progress tracking if available (same as audio_processor)
            if self.progress_callback:
                from core.ffmpeg_progress import FFmpegProgressTracker
                tracker = FFmpegProgressTracker(self.progress_callback)
                tracker.run_ffmpeg_with_progress(
                    cmd,
                    str(input_path),
                    f"Syncing {input_path.name}",
                    skip_check_callback=self.skip_check_callback
                )
            else:
                # Fall back to simple subprocess if no progress callback
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
        # Check if source has audio (required for cross-correlation)
        source_path_obj = Path(source_path)
        video_extensions = {'.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.mpg', '.mpeg', '.m4v', '.webm'}
        is_video = source_path_obj.suffix.lower() in video_extensions

        if is_video:
            # Check if video has audio stream
            has_audio = self._has_audio_stream(source_path)
            if not has_audio:
                print(f"⚠️  Video has no audio track - using framerate-only sync", file=sys.stderr)
                # Fall back to basic framerate sync
                synced_path = self._apply_framerate_sync_only(source_path, output_path)
                # Return with minimal sync info
                return synced_path, {
                    'offset_seconds': 0.0,
                    'speed_factor': 1.0,
                    'correlation_score': 0.0,
                    'drift_frames': 0.0,
                    'is_soundboard': False,
                    'source_file': str(source_path),
                    'master_file': str(master_path),
                    'sync_method': 'framerate_only'
                }

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
