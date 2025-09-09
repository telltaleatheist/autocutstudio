# core/audio_processor.py

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
    
    def cleanup_temp_files(self):
        """Remove temporary audio files."""
        if self.temp_dir.exists():
            for file in self.temp_dir.glob("*_extracted.*"):
                file.unlink()
            for file in self.temp_dir.glob("*_synced.*"):
                file.unlink()
            print(f"Cleaned up temporary files in {self.temp_dir}")