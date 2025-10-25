# core/video_analysis/camera_detector.py

import subprocess
import json
import sys
from typing import List, Tuple
from pathlib import Path
import numpy as np
from PIL import Image
import io


class CameraDetector:
    """Detect when a second camera is active/inactive in a video."""

    def __init__(self, sample_interval: int = 30):
        """
        Initialize camera detector.

        Args:
            sample_interval: Sample every N seconds (default: 30)
        """
        self.sample_interval = sample_interval

    def detect_segments(self, video_path: str, camera_region: str = 'top_right') -> List[Tuple[float, float, str]]:
        """
        Detect when camera 2 is active vs inactive using recursive refinement:
        1. Level 1: Scan every 60 minutes (3600s) - coarse overview
        2. Level 2: Scan every 15 minutes (900s) - 4x faster
        3. Level 3: Scan every 1 minute (60s) - 15x faster
        4. Level 4: Scan every 10 seconds (10s) - 6x faster
        5. Level 5: Scan every 1 second (1s) - 10x faster (precise)

        Args:
            video_path: Path to the cut master video
            camera_region: Which region to check ('top_right', 'bottom_right', etc.)

        Returns:
            List of (start_time, end_time, mode) tuples where mode is 'solo' or 'dc'
        """
        print(f"[CameraDetector] Analyzing video: {video_path}", file=sys.stderr)
        print(f"[CameraDetector] Using 5-level recursive refinement detection", file=sys.stderr)

        # Get video duration
        duration = self._get_video_duration(video_path)
        print(f"[CameraDetector] Video duration: {duration:.2f}s ({duration/60:.1f} minutes)", file=sys.stderr)

        # Recursive refinement - start with 60min intervals for very coarse overview
        all_samples = []
        self._recursive_scan(video_path, camera_region, 0, duration, 3600, all_samples)  # Start with 60min intervals

        # Sort all samples by timestamp
        all_samples = sorted(set(all_samples), key=lambda x: x[0])

        # Build segments from all samples
        segments = self._build_segments(all_samples, duration)

        print(f"[CameraDetector] Detected {len(segments)} segments:", file=sys.stderr)
        for start, end, mode in segments:
            print(f"  {start:.1f}s - {end:.1f}s: {mode}", file=sys.stderr)

        return segments

    def _recursive_scan(self, video_path: str, camera_region: str, start_time: float, end_time: float,
                        interval: float, samples: List[Tuple[float, str]], depth: int = 0):
        """
        Recursively scan a time region, refining when changes are detected.

        Args:
            video_path: Path to video
            camera_region: Region to analyze
            start_time: Start of region to scan (seconds)
            end_time: End of region to scan (seconds)
            interval: Current sampling interval (seconds)
            samples: List to append samples to
            depth: Current recursion depth (for logging)
        """
        indent = "  " * depth
        print(f"{indent}[CameraDetector] Scanning {start_time:.0f}s-{end_time:.0f}s at {interval}s intervals", file=sys.stderr)

        # Sample at current interval
        region_samples = []
        for timestamp in range(int(start_time), int(end_time) + 1, int(interval)):
            if timestamp <= end_time:
                is_active = self._is_camera_active(video_path, timestamp, camera_region)
                state = 'dc' if is_active else 'solo'
                region_samples.append((timestamp, state))
                samples.append((timestamp, state))

        # Check for changes in this region
        changes_detected = []
        for i in range(len(region_samples) - 1):
            if region_samples[i][1] != region_samples[i+1][1]:
                # State changed - mark this region for refinement
                change_start = region_samples[i][0]
                change_end = region_samples[i+1][0]
                changes_detected.append((change_start, change_end))
                print(f"{indent}[CameraDetector] Change detected: {change_start}s -> {change_end}s", file=sys.stderr)

        # Determine next refinement level
        next_interval = None
        if interval == 3600:  # 60 minutes (new coarse level)
            next_interval = 900  # Refine to 15 minutes (4x faster)
        elif interval == 900:  # 15 minutes
            next_interval = 60  # Refine to 1 minute (15x faster)
        elif interval == 60:  # 1 minute
            next_interval = 10  # Refine to 10 seconds (6x faster)
        elif interval == 10:  # 10 seconds
            next_interval = 1  # Refine to 1 second (10x faster)
        # If interval is 1 second, we're done refining

        # Recursively refine regions where changes were detected
        if next_interval and changes_detected:
            for change_start, change_end in changes_detected:
                # Expand the region slightly to catch edge cases
                refine_start = max(start_time, change_start - interval)
                refine_end = min(end_time, change_end + interval)
                self._recursive_scan(video_path, camera_region, refine_start, refine_end,
                                    next_interval, samples, depth + 1)

    def _get_video_duration(self, video_path: str) -> float:
        """Get video duration in seconds using ffprobe."""
        try:
            cmd = [
                'ffprobe', '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'json', video_path
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            data = json.loads(result.stdout)
            return float(data['format']['duration'])
        except Exception as e:
            print(f"[CameraDetector] Error getting video duration: {e}", file=sys.stderr)
            return 0.0

    def _is_camera_active(self, video_path: str, timestamp: float, region: str) -> bool:
        """
        Check if camera is active at a specific timestamp.

        Detects if the region contains:
        - Black screen (inactive)
        - Solid blue screen (inactive)
        - Active video content (active)
        """
        try:
            # Extract frame at timestamp
            frame_data = self._extract_frame(video_path, timestamp, region)
            if frame_data is None:
                return False

            # Load as image
            img = Image.open(io.BytesIO(frame_data))
            pixels = np.array(img)

            # Calculate statistics
            mean_color = pixels.mean(axis=(0, 1))  # Average RGB
            std_dev = pixels.std()  # Standard deviation (variance)

            # Debug output
            print(f"[CameraDetector] {timestamp}s - mean_color: {mean_color}, std_dev: {std_dev:.2f}", file=sys.stderr)

            # Detection logic:
            # 1. Check if mostly black (all RGB values < 20)
            if np.all(mean_color < 20):
                print(f"[CameraDetector] {timestamp}s - BLACK screen detected", file=sys.stderr)
                return False  # Black screen = inactive

            # 2. Check if solid color (low variance)
            if std_dev < 15:  # Low variance = solid color (increased threshold)
                print(f"[CameraDetector] {timestamp}s - SOLID COLOR detected", file=sys.stderr)
                return False  # Solid color (blue/black) = inactive

            # 3. Otherwise, assume active content
            print(f"[CameraDetector] {timestamp}s - ACTIVE content detected", file=sys.stderr)
            return True

        except Exception as e:
            print(f"[CameraDetector] Error checking frame at {timestamp}s: {e}", file=sys.stderr)
            return False

    def _extract_frame(self, video_path: str, timestamp: float, region: str) -> bytes:
        """
        Extract a frame from a specific region at a timestamp.

        Args:
            video_path: Path to video
            timestamp: Time in seconds
            region: Region to extract (top_right, bottom_right, etc.)

        Returns:
            PNG image data as bytes
        """
        # Define crop filters for different regions
        # For 1920x1080 video:
        # top_right: cam2 in top-right quadrant
        # bottom_right: cam2 in bottom-right quadrant

        if region == 'top_right':
            # Extract top-right quarter (960x540 from position 960,0)
            crop_filter = 'crop=960:540:960:0'
        elif region == 'bottom_right':
            # Extract bottom-right quarter (960x540 from position 960,540)
            crop_filter = 'crop=960:540:960:540'
        else:
            # Default to top-right
            crop_filter = 'crop=960:540:960:0'

        try:
            cmd = [
                'ffmpeg',
                '-ss', str(timestamp),  # Seek to timestamp
                '-i', video_path,
                '-vf', crop_filter,  # Crop to region
                '-vframes', '1',  # Extract 1 frame
                '-f', 'image2pipe',  # Output to pipe
                '-vcodec', 'png',  # PNG format
                '-'
            ]

            result = subprocess.run(cmd, capture_output=True, check=True)
            return result.stdout

        except Exception as e:
            print(f"[CameraDetector] Error extracting frame: {e}", file=sys.stderr)
            return None

    def _build_segments(self, states: List[Tuple[float, str]], duration: float) -> List[Tuple[float, float, str]]:
        """
        Build continuous segments from sampled states.

        Args:
            states: List of (timestamp, state) tuples
            duration: Total video duration

        Returns:
            List of (start, end, mode) segments
        """
        if not states:
            return [(0, duration, 'solo')]  # Default to solo if no detections

        segments = []
        current_start = 0
        current_state = states[0][1]

        for i, (timestamp, state) in enumerate(states):
            # State changed
            if state != current_state:
                # Close current segment
                segments.append((current_start, timestamp, current_state))
                current_start = timestamp
                current_state = state

        # Close final segment
        segments.append((current_start, duration, current_state))

        return segments
