# Updated methods for core/audio_processor.py to avoid subprocess calls
# Note: This assumes you want to keep using subprocess for ffmpeg since Python 
# doesn't have a pure-Python FFmpeg implementation, but we structure it better

import subprocess
import json
from pathlib import Path
from typing import Optional, Tuple
import tempfile
import os

class AudioProcessor:
    """Handle audio extraction, format conversion, and sync adjustments."""
    
    def __init__(self, config):
        self.config = config
        self.temp_dir = Path(config.get('paths.temp_dir', './temp'))
        self.temp_dir.mkdir(parents=True, exist_ok=True)
    
    def apply_drift_correction(self, input_path: str, drift_frames: float, 
                              video_duration: float, fps: float = 29.97,
                              output_path: Optional[str] = None) -> str:
        """Apply clock drift correction to audio file.
        
        Args:
            input_path: Path to input audio file
            drift_frames: Number of frames of drift (negative = shrink audio, positive = expand audio)
            video_duration: Duration of the video in seconds
            fps: Frame rate of the video (default 29.97)
            output_path: Optional output path
            
        Returns:
            Path to the corrected audio file
        """
        input_path = Path(input_path)
        
        # Calculate correction factor
        # Positive drift = expand audio (slower/longer), Negative drift = shrink audio (faster/shorter)
        total_frames = video_duration * fps
        correction_factor = 1 + (drift_frames / total_frames)
        
        if output_path is None:
            # Generate output filename with drift information
            # Negative values shrink (speed up), positive values expand (slow down)
            if drift_frames < 0:
                drift_suffix = f"_drift_minus{abs(int(drift_frames))}f"
            else:
                drift_suffix = f"_drift_plus{int(drift_frames)}f"
            output_path = input_path.parent / f"{input_path.stem}{drift_suffix}{input_path.suffix}"
        
        output_path = Path(output_path)
        
        # Apply drift correction using ffmpeg atempo filter
        # Note: While this uses subprocess, it's encapsulated in the AudioProcessor
        # and could be replaced with a Python audio library like pydub or librosa
        # if you want pure Python processing
        cmd = [
            'ffmpeg', '-i', str(input_path),
            '-filter:a', f'atempo={correction_factor}',
            '-c:a', 'pcm_s24le',  # 24-bit PCM for high quality
            '-y',  # Overwrite output
            str(output_path)
        ]
        
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            print(f"Applied drift correction to {input_path.name}")
            print(f"  Drift: {drift_frames} frames over {video_duration:.1f} seconds")
            print(f"  Correction factor: {correction_factor:.6f}")
            print(f"  Output: {output_path.name}")
            return str(output_path)
        except subprocess.CalledProcessError as e:
            print(f"Error applying drift correction to {input_path}: {e}")
            print(f"stderr: {e.stderr}")
            raise
    
    def get_duration_seconds(self, file_path: str) -> float:
        """Get duration in seconds from a media file.
        
        This is a convenience method that parses the FCPX format
        returned by get_audio_info into plain seconds.
        
        Args:
            file_path: Path to the media file
            
        Returns:
            Duration in seconds as a float
        """
        duration_str, _, _ = self.get_audio_info(file_path)
        
        # Parse FCPX duration format "3600000/30000s" to seconds
        if '/' in duration_str:
            numerator, denominator = duration_str.rstrip('s').split('/')
            return float(numerator) / float(denominator)
        else:
            # Handle plain seconds format if any
            return float(duration_str.rstrip('s'))
    
    # Keep all existing methods as they are...
    def extract_audio_from_video(self, video_path: str, output_path: Optional[str] = None) -> str:
        """Extract audio from video file using ffmpeg."""
        video_path = Path(video_path)
        
        if output_path is None:
            output_path = self.temp_dir / f"{video_path.stem}_extracted.wav"
        
        output_path = Path(output_path)
        
        # Use ffmpeg to extract audio
        cmd = [
            'ffmpeg', '-i', str(video_path),
            '-vn',  # No video
            '-acodec', 'pcm_s16le',  # PCM 16-bit
            '-ar', str(self.config.get('audio.sample_rate', 48000)),  # Sample rate
            '-ac', '2',  # Stereo
            '-y',  # Overwrite output
            str(output_path)
        ]
        
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            print(f"Audio extracted from {video_path} to {output_path}")
            return str(output_path)
        except subprocess.CalledProcessError as e:
            print(f"Error extracting audio from {video_path}: {e}")
            print(f"stderr: {e.stderr}")
            raise
    
    def sync_audio_for_2997fps(self, input_path: str, output_path: Optional[str] = None) -> str:
        """Apply 29.97fps sync correction using atempo filter."""
        input_path = Path(input_path)
        
        if output_path is None:
            output_path = input_path.parent / f"{input_path.stem}_synced{input_path.suffix}"
        
        output_path = Path(output_path)
        sync_factor = self.config.get('audio.sync_correction', 1.001)
        
        cmd = [
            'ffmpeg', '-i', str(input_path),
            '-filter:a', f'atempo={sync_factor}',
            '-c:a', 'pcm_s16le',
            '-y',  # Overwrite output
            str(output_path)
        ]
        
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            print(f"Audio synced from {input_path} to {output_path}")
            return str(output_path)
        except subprocess.CalledProcessError as e:
            print(f"Error syncing audio {input_path}: {e}")
            print(f"stderr: {e.stderr}")
            raise
    
    def get_audio_info(self, file_path: str) -> Tuple[str, int, int]:
        """Get audio duration, sample rate, and channels using ffprobe."""
        try:
            # First check if file exists
            if not Path(file_path).exists():
                print(f"Warning: Audio file does not exist: {file_path}")
                # Return default values that allow processing to continue
                return "3600000/30000s", 48000, 2  # Default 2 minute duration
            
            result = subprocess.run([
                'ffprobe', '-v', 'quiet', '-print_format', 'json',
                '-show_format', '-show_streams', str(file_path)
            ], capture_output=True, text=True, check=True)
            
            data = json.loads(result.stdout)
            
            # Find audio stream
            audio_stream = None
            for stream in data['streams']:
                if stream['codec_type'] == 'audio':
                    audio_stream = stream
                    break
            
            if not audio_stream:
                # Try to handle as video file with audio
                for stream in data['streams']:
                    if stream['codec_type'] == 'video':
                        # Use video duration as fallback
                        duration_seconds = float(data['format'].get('duration', 120))
                        frame_rate_den = 30000
                        duration_fcpx = f"{int(duration_seconds * frame_rate_den)}/{frame_rate_den}s"
                        return duration_fcpx, 48000, 2
                
                print(f"Warning: No audio stream found in {file_path}, using defaults")
                return "3600000/30000s", 48000, 2
            
            duration_seconds = float(data['format'].get('duration', 120))
            sample_rate = int(audio_stream.get('sample_rate', 48000))
            channels = int(audio_stream.get('channels', 2))
            
            # Convert to FCPX time format
            frame_rate_den = 30000
            duration_fcpx = f"{int(duration_seconds * frame_rate_den)}/{frame_rate_den}s"
            
            return duration_fcpx, sample_rate, channels
            
        except (subprocess.CalledProcessError, json.JSONDecodeError, KeyError) as e:
            print(f"Warning: Error getting audio info from {file_path}: {e}")
            print(f"Using default values to continue processing")
            # Return reasonable defaults instead of raising
            return "3600000/30000s", 48000, 2  # Default 2 minute duration, 48kHz, stereo
    
    def convert_audio_format(self, input_path: str, output_format: str = 'wav',
                           output_path: Optional[str] = None) -> str:
        """Convert audio to specified format."""
        input_path = Path(input_path)
        
        if output_path is None:
            output_path = input_path.parent / f"{input_path.stem}.{output_format}"
        
        output_path = Path(output_path)
        
        cmd = [
            'ffmpeg', '-i', str(input_path),
            '-acodec', 'pcm_s16le' if output_format == 'wav' else 'aac',
            '-ar', str(self.config.get('audio.sample_rate', 48000)),
            '-ac', '2',
            '-y',
            str(output_path)
        ]
        
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            print(f"Audio converted from {input_path} to {output_path}")
            return str(output_path)
        except subprocess.CalledProcessError as e:
            print(f"Error converting audio {input_path}: {e}")
            print(f"stderr: {e.stderr}")
            raise
    
    def process_audio_source(self, source_path: str, apply_sync: bool = False,
                        output_dir: Optional[str] = None) -> Tuple[str, str, int, int]:
        """Process audio source: extract if video, sync if requested, return info."""
        source_path = Path(source_path)
        
        # Use the source file's directory as the output directory by default
        if output_dir is None:
            output_dir = source_path.parent  # Same directory as the source file
        output_dir = Path(output_dir)
        
        # Check if source is video or audio
        video_extensions = ['.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.mpg', '.mpeg', '.m4v', '.webm']
        audio_extensions = ['.wav', '.mp3', '.aac', '.flac', '.ogg', '.m4a']
        
        processed_audio_path = source_path
        
        # Extract audio if source is video
        if source_path.suffix.lower() in video_extensions:
            audio_path = output_dir / f"{source_path.stem}_extracted.wav"
            processed_audio_path = Path(self.extract_audio_from_video(str(source_path), str(audio_path)))
        
        # Apply sync correction if requested
        if apply_sync:
            synced_path = output_dir / f"{processed_audio_path.stem}_synced{processed_audio_path.suffix}"
            processed_audio_path = Path(self.sync_audio_for_2997fps(str(processed_audio_path), str(synced_path)))
        
        # Get audio info
        duration, sample_rate, channels = self.get_audio_info(str(processed_audio_path))
        
        return str(processed_audio_path), duration, sample_rate, channels
    
    def sync_video_for_2997fps(self, input_path: str, output_path: Optional[str] = None) -> str:
        """Speed up 30fps video to match 29.97fps timeline.

        This is needed when custom screen/game captures are recorded at 30fps
        but the master video is 29.97fps. We speed up by a factor of 1.001001
        to keep them in sync.

        Args:
            input_path: Path to input video file (30fps)
            output_path: Optional output path

        Returns:
            Path to the synced video file
        """
        input_path = Path(input_path)

        if output_path is None:
            output_path = input_path.parent / f"{input_path.stem}_synced{input_path.suffix}"

        output_path = Path(output_path)

        # Speed factor: 30 / 29.97 = 1.001001001 (30000/29970)
        # This makes the video slightly faster to match 29.97fps timeline
        speed_factor = 1.001001

        print(f"Syncing video framerate: {input_path.name}")
        print(f"  Speeding up by {speed_factor}x to sync 30fps -> 29.97fps")

        cmd = [
            'ffmpeg', '-i', str(input_path),
            '-filter:v', f'setpts=PTS/{speed_factor}',  # Speed up video
            '-filter:a', f'atempo={speed_factor}',      # Speed up audio too
            '-c:v', 'libx264',  # Re-encode video
            '-crf', '18',       # High quality
            '-preset', 'medium',
            '-c:a', 'aac',      # Re-encode audio
            '-b:a', '192k',
            '-y',  # Overwrite output
            str(output_path)
        ]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            print(f"Video synced: {output_path}")
            return str(output_path)
        except subprocess.CalledProcessError as e:
            print(f"Error syncing video {input_path}: {e}")
            print(f"stderr: {e.stderr}")
            raise

    def process_video_source(self, source_path: str, apply_sync: bool = True,
                            output_dir: Optional[str] = None) -> str:
        """Process video source with optional framerate sync.

        Args:
            source_path: Path to video file
            apply_sync: If True, speed up 30fps video to match 29.97fps
            output_dir: Optional output directory

        Returns:
            Path to processed video
        """
        source_path = Path(source_path)

        if output_dir is None:
            output_dir = source_path.parent
        output_dir = Path(output_dir)

        processed_video_path = source_path

        # Apply framerate sync if requested
        # This assumes the input is 30fps and needs to be synced to 29.97fps
        if apply_sync:
            synced_path = output_dir / f"{source_path.stem}_synced{source_path.suffix}"
            processed_video_path = Path(self.sync_video_for_2997fps(str(source_path), str(synced_path)))

        return str(processed_video_path)

    def cleanup_temp_files(self):
        """Remove temporary audio files."""
        if self.temp_dir.exists():
            for file in self.temp_dir.glob("*_extracted.*"):
                file.unlink()
            for file in self.temp_dir.glob("*_synced.*"):
                file.unlink()
            print(f"Cleaned up temporary files in {self.temp_dir}")