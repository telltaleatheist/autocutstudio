"""
FFmpeg Progress Tracking

Parses FFmpeg output to provide real-time progress updates during encoding.
"""

import subprocess
import re
import sys
import threading
from typing import Optional, Callable, Dict
from pathlib import Path


class FFmpegProgressTracker:
    """Track FFmpeg encoding progress in real-time."""

    def __init__(self, progress_callback: Optional[Callable[[Dict], None]] = None):
        """
        Initialize progress tracker.

        Args:
            progress_callback: Function to call with progress updates
                               Receives dict with keys: frame, fps, time, speed, progress_percent
        """
        self.progress_callback = progress_callback
        self.total_duration = None
        self.canceled = False
        self.process = None

    def get_video_duration(self, file_path: str) -> float:
        """Get duration of video file in seconds using ffprobe."""
        import json

        cmd = [
            'ffprobe', '-v', 'quiet', '-print_format', 'json',
            '-show_format', str(file_path)
        ]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            data = json.loads(result.stdout)
            duration = float(data['format']['duration'])
            return duration
        except Exception as e:
            print(f"Warning: Could not get duration for {file_path}: {e}")
            return 0.0

    def parse_time_to_seconds(self, time_str: str) -> float:
        """Convert FFmpeg time string (HH:MM:SS.ms) to seconds."""
        try:
            parts = time_str.split(':')
            if len(parts) == 3:
                hours = float(parts[0])
                minutes = float(parts[1])
                seconds = float(parts[2])
                return hours * 3600 + minutes * 60 + seconds
            return 0.0
        except:
            return 0.0

    def parse_progress_line(self, line: str) -> Optional[Dict]:
        """Parse FFmpeg progress output line."""
        # FFmpeg outputs progress like:
        # frame=  123 fps= 45 q=28.0 size=    1234kB time=00:00:05.12 bitrate=1234.5kbits/s speed=1.23x

        progress = {}

        # Extract frame number
        frame_match = re.search(r'frame=\s*(\d+)', line)
        if frame_match:
            progress['frame'] = int(frame_match.group(1))

        # Extract FPS
        fps_match = re.search(r'fps=\s*(\d+\.?\d*)', line)
        if fps_match:
            progress['fps'] = float(fps_match.group(1))

        # Extract time
        time_match = re.search(r'time=(\d+:\d+:\d+\.\d+)', line)
        if time_match:
            time_str = time_match.group(1)
            progress['time'] = time_str
            progress['time_seconds'] = self.parse_time_to_seconds(time_str)

        # Extract speed
        speed_match = re.search(r'speed=\s*(\d+\.?\d*)x', line)
        if speed_match:
            progress['speed'] = float(speed_match.group(1))

        # Calculate progress percentage if we know total duration
        if 'time_seconds' in progress and self.total_duration and self.total_duration > 0:
            progress['progress_percent'] = min(100, (progress['time_seconds'] / self.total_duration) * 100)

        return progress if progress else None

    def run_ffmpeg_with_progress(self, cmd: list, input_file: str,
                                 operation_name: str = "Encoding",
                                 skip_check_callback: Optional[Callable[[], bool]] = None) -> subprocess.CompletedProcess:
        """
        Run FFmpeg command with real-time progress tracking.

        Args:
            cmd: FFmpeg command as list
            input_file: Path to input file (for duration calculation)
            operation_name: Name of operation for progress messages
            skip_check_callback: Optional callback to check if skip was requested

        Returns:
            subprocess.CompletedProcess result
        """
        # Get total duration
        self.total_duration = self.get_video_duration(input_file)
        self.canceled = False

        print(f"\n{operation_name}: {Path(input_file).name}")
        if self.total_duration > 0:
            print(f"Duration: {self.total_duration:.1f} seconds")

        # Run FFmpeg with progress output
        self.process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            bufsize=1
        )

        # Track last progress update time to avoid spam
        import time
        last_callback_time = 0
        CALLBACK_INTERVAL = 0.5  # Only callback every 0.5 seconds

        # Read stderr in real-time (FFmpeg outputs progress to stderr)
        for line in self.process.stderr:
            # Check for skip signal
            if skip_check_callback and skip_check_callback():
                print("Skip signal detected - terminating FFmpeg", file=sys.stderr)
                self.process.terminate()
                self.process.wait(timeout=5)
                raise InterruptedError("Operation skipped by user")

            if self.canceled:
                self.process.terminate()
                self.process.wait(timeout=5)
                raise InterruptedError("FFmpeg operation canceled by user")

            # Parse progress
            progress = self.parse_progress_line(line)
            if progress and self.progress_callback:
                # Rate limit callbacks to avoid spam
                current_time = time.time()
                if current_time - last_callback_time >= CALLBACK_INTERVAL:
                    self.progress_callback(progress)
                    last_callback_time = current_time

        # Wait for completion
        stdout, stderr = self.process.communicate()

        if self.process.returncode != 0:
            raise subprocess.CalledProcessError(
                self.process.returncode,
                cmd,
                output=stdout,
                stderr=stderr
            )

        # Send 100% completion
        if self.progress_callback:
            self.progress_callback({
                'progress_percent': 100,
                'time': 'complete',
                'speed': 0
            })

        return subprocess.CompletedProcess(
            cmd,
            self.process.returncode,
            stdout,
            stderr
        )

    def cancel(self):
        """Cancel the current FFmpeg operation."""
        self.canceled = True
        if self.process:
            self.process.terminate()


def create_progress_callback(emit_func):
    """
    Create a progress callback function for workflow integration.

    Args:
        emit_func: Function to emit progress (e.g., emit_progress from electron_workflow)
    """
    def callback(progress: Dict):
        if 'progress_percent' in progress:
            message = f"Encoding: {progress['progress_percent']:.1f}%"
            if 'speed' in progress and progress['speed'] > 0:
                message += f" (speed: {progress['speed']:.1f}x)"
            emit_func(progress['progress_percent'], message)

    return callback
