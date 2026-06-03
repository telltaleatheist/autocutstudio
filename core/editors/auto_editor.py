# core/editors/auto_editor.py

import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote, unquote
import json
import datetime
from typing import Tuple, Optional, Callable

from .base_editor import BaseEditor
from ..xml_utils import FCPXMLUtils

class AutoEditor(BaseEditor):
    """Auto-editor implementation for cutting silence/pauses."""

    def __init__(self, config, progress_callback: Optional[Callable] = None):
        self.config = config
        self.xml_utils = FCPXMLUtils()
        self.progress_callback = progress_callback
        self.skip_check_callback = None  # Can be set by caller
    
    def cut_silence(self, input_file: str, threshold: str = None,
                   output_format: str = "final-cut-pro", auto_fix_errors: bool = True,
                   margin: str = None, output_file: str = None) -> str:
        """Run auto-editor on input file and return path to XML output.

        Args:
            input_file: Path to video file
            threshold: Audio threshold (e.g. '-40dB')
            output_format: Export format (default: 'final-cut-pro')
            auto_fix_errors: If True, attempt to fix corrupted video files
            margin: Margin around loud sections (e.g. '2s')
            output_file: Custom output file path (overrides default _ALTERED suffix)
        """
        input_path = Path(input_file)

        if threshold is None:
            threshold = self.config.default_threshold

        print(f"Running auto-editor on: {input_path}")

        try:
            cmd = [
                'auto-editor',
                str(input_path),
                '--edit', f'audio:{threshold}',
                '--export', output_format,
                '--no-open'
            ]
            if margin:
                cmd.extend(['--margin', margin])
            if output_file:
                cmd.extend(['-o', output_file])

            print(f"auto-editor command: {' '.join(cmd)}", file=sys.stderr)
            result = subprocess.run(cmd, capture_output=True, text=True, check=False)
            if result.returncode != 0:
                print(f"auto-editor stderr: {result.stderr}", file=sys.stderr)
                print(f"auto-editor stdout: {result.stdout[-500:] if result.stdout else '(empty)'}", file=sys.stderr)
                raise subprocess.CalledProcessError(
                    result.returncode, cmd, result.stdout, result.stderr)

            # Use custom output path or default _ALTERED suffix
            if output_file:
                xml_output = Path(output_file)
            else:
                xml_output = input_path.with_name(f"{input_path.stem}_ALTERED.fcpxml")

            if not xml_output.exists():
                raise FileNotFoundError(f"Expected auto-editor output not found: {xml_output}")

            print(f"Auto-editor completed: {xml_output}")
            return str(xml_output)

        except subprocess.CalledProcessError as e:
            print(f"Error running auto-editor on {input_file}: {e}")

            # Check if it's a corrupted video error
            if 'Invalid data found when processing input' in e.stderr or \
               'InvalidDataError' in e.stderr or \
               'bv.error' in e.stderr:
                print("\nDetected corrupted video file. This usually happens when:")
                print("  - Video encoding was interrupted")
                print("  - File contains damaged frames")
                print("  - Codec errors during recording")

                if auto_fix_errors:
                    print("\nAttempting to fix by re-encoding video...")
                    fixed_file = self._reencode_video(input_file)
                    if fixed_file:
                        print(f"Re-encoded video saved to: {fixed_file}")
                        print("Retrying auto-editor with fixed video...")
                        # Retry with fixed file
                        return self.cut_silence(fixed_file, threshold, output_format,
                                               auto_fix_errors=False, margin=margin,
                                               output_file=output_file)
                else:
                    print("\nTo fix this issue, try re-encoding the video:")
                    print(f"  ffmpeg -i \"{input_file}\" -c:v libx264 -crf 23 -c:a aac -b:a 192k \"fixed_{Path(input_file).name}\"")
            else:
                print(f"stderr: {e.stderr}")

            raise
        except FileNotFoundError:
            print("Error: auto-editor not found. Please install auto-editor first.")
            raise

    def _reencode_video(self, input_file: str) -> str:
        """Re-encode video to fix corruption issues.

        Args:
            input_file: Path to corrupted video file

        Returns:
            Path to re-encoded video file, or None if re-encoding failed
        """
        input_path = Path(input_file)
        output_path = input_path.with_name(f"{input_path.stem}_fixed{input_path.suffix}")

        print(f"Re-encoding video with error correction...")
        print(f"  Input: {input_file}")
        print(f"  Output: {output_path}")

        try:
            # Use ffmpeg with error concealment to fix corrupted frames
            cmd = [
                'ffmpeg',
                '-progress', 'pipe:2',  # Enable progress output
                '-err_detect', 'ignore_err',  # Ignore decoding errors
                '-i', str(input_path),
                '-c:v', 'libx264',  # Re-encode video
                '-crf', '23',  # Quality level (lower = better quality)
                '-preset', 'medium',  # Encoding speed
                '-c:a', 'aac',  # Re-encode audio
                '-b:a', '192k',  # Audio bitrate
                '-y',  # Overwrite output
                str(output_path)
            ]

            # Use progress tracking if available
            if self.progress_callback:
                from core.ffmpeg_progress import FFmpegProgressTracker
                tracker = FFmpegProgressTracker(self.progress_callback)
                tracker.run_ffmpeg_with_progress(
                    cmd,
                    str(input_path),
                    f"Re-encoding {input_path.name}",
                    skip_check_callback=self.skip_check_callback
                )
            else:
                result = subprocess.run(cmd, capture_output=True, text=True)

            if output_path.exists():
                print("Re-encoding completed successfully")
                return str(output_path)
            else:
                print("Re-encoding failed: output file not created")
                if not self.progress_callback:
                    print(f"ffmpeg stderr: {result.stderr}")
                return None

        except Exception as e:
            print(f"Error during re-encoding: {e}")
            return None
    
    def get_video_info(self, file_path: str) -> Tuple[str, str, int, int]:
        """Get video duration, frame duration, width, height using ffprobe."""
        try:
            result = subprocess.run([
                'ffprobe', '-v', 'quiet', '-print_format', 'json',
                '-show_format', '-show_streams', str(file_path)
            ], capture_output=True, text=True, check=True)
            
            data = json.loads(result.stdout)
            duration_seconds = float(data['format']['duration'])
            
            # Get the video stream to determine actual framerate and dimensions
            video_stream = None
            for stream in data['streams']:
                if stream['codec_type'] == 'video':
                    video_stream = stream
                    break
            
            if not video_stream:
                raise ValueError(f"No video stream found in {file_path}")
            
            # Parse framerate (could be "24/1" or "23.976")
            fps_str = video_stream.get('r_frame_rate', '24/1')
            if '/' in fps_str:
                num, den = fps_str.split('/')
                fps = float(num) / float(den)
            else:
                fps = float(fps_str)
            
            # Get dimensions
            width = int(video_stream.get('width', 1920))
            height = int(video_stream.get('height', 1080))
            
            # Calculate total frames and create FCPX duration format
            total_frames = int(duration_seconds * fps)
            
            # Convert to FCPX format based on actual framerate
            if abs(fps - 23.976) < 0.1:  # 23.976 fps (24000/1001)
                frame_duration = "1001/24000s"
                duration = f"{total_frames * 1001}/24000s"
            elif abs(fps - 29.97) < 0.1:  # 29.97 fps (30000/1001)
                frame_duration = "1001/30000s"
                duration = f"{total_frames * 1001}/30000s"
            elif abs(fps - 24.0) < 0.1:  # 24 fps
                frame_duration = "1/24s"
                duration = f"{total_frames}/24s"
            elif abs(fps - 30.0) < 0.1:  # 30 fps
                frame_duration = "1/30s"
                duration = f"{total_frames}/30s"
            else:
                # Fallback - use the 479 denominator from your example
                frame_duration = "20/479s"
                duration = f"{int(total_frames * 20)}/479s"
            
            return duration, frame_duration, width, height
            
        except (subprocess.CalledProcessError, json.JSONDecodeError, KeyError) as e:
            print(f"Error getting video info: {e}")
            raise
    
    def convert_to_compound(self, xml_path: str, original_file_path: str) -> str:
        """Convert auto-editor XML to compound clip structure."""
        print(f"Converting XML to compound clip: {xml_path}")
        
        # Get original video info
        duration, frame_duration, width, height = self.get_video_info(original_file_path)
        
        try:
            tree = ET.parse(xml_path)
            root = tree.getroot()
            
            # Find the required elements
            project = root.find('.//project')
            sequence = root.find('.//sequence')
            spine = root.find('.//spine')
            resources = root.find('resources')
            
            if project is None or sequence is None or spine is None or resources is None:
                print(f"Error: Could not find required XML elements in {xml_path}")
                return None
            
            # Get all the clips
            clips = spine.findall('asset-clip')
            if not clips:
                print(f"No clips found in {xml_path}")
                return None
            
            print(f"Converting {len(clips)} individual clips to compound clip structure")
            
            # Get project and sequence attributes
            project_name = project.get('name', 'Auto-Edit')
            compound_name = f"{project_name} - Compound"
            
            seq_format = sequence.get('format')
            seq_tcStart = sequence.get('tcStart', '0s')
            seq_tcFormat = sequence.get('tcFormat', 'NDF')
            seq_audioLayout = sequence.get('audioLayout', 'stereo')
            seq_audioRate = sequence.get('audioRate', '48k')
            
            # Calculate total timeline duration from last clip
            last_clip = clips[-1]
            last_offset = last_clip.get('offset', '0s')
            last_duration = last_clip.get('duration', '0s')
            
            def parse_time(time_str):
                if time_str.endswith('s'):
                    time_str = time_str[:-1]
                if '/' in time_str:
                    num, den = time_str.split('/')
                    return int(num), int(den)
                return int(time_str), 1
            
            last_offset_num, last_offset_den = parse_time(last_offset)
            last_duration_num, last_duration_den = parse_time(last_duration)
            total_duration = f"{last_offset_num + last_duration_num}/{last_offset_den}s"
            
            # Get the original asset info
            first_clip = clips[0]
            original_asset_ref = first_clip.get('ref')
            original_asset_name = first_clip.get('name')
            
            # Find the existing format
            original_format = resources.find(f".//*[@id='{seq_format}']")
            if original_format is None:
                print(f"Error: Could not find format {seq_format}")
                return None
            
            # Remove the old auto-editor modified asset
            old_asset = resources.find(f".//*[@id='{original_asset_ref}']")
            if old_asset is not None:
                resources.remove(old_asset)
            
            # Create new format
            new_format_id = f"r1_original"
            new_format = ET.SubElement(resources, 'format')
            new_format.set('id', new_format_id)
            new_format.set('name', 'FFVideoFormatRateUndefined')
            new_format.set('frameDuration', frame_duration)
            new_format.set('width', str(width))
            new_format.set('height', str(height))
            new_format.set('colorSpace', '1-1-1 (Rec. 709)')
            
            # Create new asset that references the original file with full duration
            new_asset_id = "r_original"
            new_asset = ET.SubElement(resources, 'asset')
            new_asset.set('id', new_asset_id)
            new_asset.set('name', original_asset_name)
            new_asset.set('start', '0s')
            new_asset.set('hasVideo', '1')
            new_asset.set('format', new_format_id)
            new_asset.set('hasAudio', '1')
            new_asset.set('audioSources', '1')
            new_asset.set('audioChannels', '2')
            new_asset.set('duration', duration)  # Full original duration
            
            # Create media-rep pointing to the original file (URL-encoded)
            media_rep = ET.SubElement(new_asset, 'media-rep')
            media_rep.set('kind', 'original-media')
            encoded_path = quote(str(Path(original_file_path).resolve()), safe='/:')
            media_rep.set('src', f"file://{encoded_path}")
            
            print(f"Created new asset with full duration: {duration}")
            
            # Create compound clip as media element
            compound_media = ET.SubElement(resources, 'media')
            compound_media.set('id', 'compound1')
            compound_media.set('name', compound_name)
            compound_media.set('uid', 'AUTOEDITOR-COMPOUND-UID')
            
            # Add current timestamp
            now = datetime.datetime.now()
            mod_date = now.strftime("%Y-%m-%d %H:%M:%S -0400")
            compound_media.set('modDate', mod_date)
            
            # Create sequence within the media element
            compound_sequence = ET.SubElement(compound_media, 'sequence')
            compound_sequence.set('format', new_format_id)
            compound_sequence.set('duration', duration)  # Full original duration
            compound_sequence.set('tcStart', seq_tcStart)
            compound_sequence.set('tcFormat', seq_tcFormat)
            compound_sequence.set('audioLayout', seq_audioLayout)
            compound_sequence.set('audioRate', seq_audioRate)
            
            # Create spine with ONE full-length clip (no cuts)
            compound_spine = ET.SubElement(compound_sequence, 'spine')
            full_clip = ET.SubElement(compound_spine, 'asset-clip')
            full_clip.set('name', original_asset_name)
            full_clip.set('ref', new_asset_id)
            full_clip.set('offset', '0s')
            full_clip.set('duration', duration)  # Full original duration
            full_clip.set('start', '0s')
            full_clip.set('tcFormat', seq_tcFormat)
            
            # Replace main timeline with ref-clips that reference the compound
            spine.clear()

            # Extract the correct denominator from frame_duration
            # e.g., "1001/30000s" -> 30000
            frame_dur_num, frame_dur_den = parse_time(frame_duration)
            correct_denominator = frame_dur_den

            print(f"Using correct time denominator: /{correct_denominator}s (from frame duration: {frame_duration})")

            # Helper function to convert time values to correct denominator
            def normalize_time(time_str, target_den):
                """Convert time string to use target denominator."""
                if time_str.endswith('s'):
                    time_str = time_str[:-1]
                if time_str == '0':
                    return '0s'
                if '/' in time_str:
                    num, den = time_str.split('/')
                    num, den = int(num), int(den)
                    # Convert to target denominator: (num/den) * target_den
                    new_num = int((num * target_den) / den)
                    return f"{new_num}/{target_den}s"
                else:
                    # Simple number - multiply by target denominator
                    return f"{int(time_str) * target_den}/{target_den}s"

            # Convert each original cut to a ref-clip
            cumulative_offset = 0

            for i, clip in enumerate(clips):
                ref_clip = ET.SubElement(spine, 'ref-clip')
                ref_clip.set('ref', 'compound1')
                ref_clip.set('name', compound_name)

                # Get duration and start from auto-editor's XML
                clip_duration = clip.get('duration')
                start = clip.get('start', '0s')

                # Normalize to correct denominator
                normalized_duration = normalize_time(clip_duration, correct_denominator)
                normalized_start = normalize_time(start, correct_denominator)

                # Parse normalized duration to get numerator for offset calculation
                dur_num, _ = parse_time(normalized_duration)
                offset = f"{cumulative_offset}/{correct_denominator}s"

                # Debug logging for first 3 clips
                if i < 3:
                    print(f"Clip {i}: Original duration={clip_duration}, start={start}")
                    print(f"Clip {i}: Normalized duration={normalized_duration}, start={normalized_start}, offset={offset}")

                ref_clip.set('offset', offset)  # Timeline position
                ref_clip.set('duration', normalized_duration)  # Duration of this segment
                ref_clip.set('start', normalized_start)  # Which part of the compound to show

                # Update cumulative offset for next clip
                cumulative_offset += dur_num
            
            # Update project name and format
            project.set('name', f"{project_name} - Compound Edit")
            sequence.set('format', new_format_id)
            
            # Write the modified XML
            output_path = str(Path(xml_path).with_name(f"{Path(xml_path).stem}_COMPOUND.fcpxml"))
            ET.indent(tree, space="    ", level=0)
            tree.write(output_path, encoding='utf-8', xml_declaration=True)
            
            print(f"Compound clip XML created: {output_path}")
            return output_path
            
        except ET.ParseError as e:
            print(f"XML parsing error in {xml_path}: {e}")
            return None
        except Exception as e:
            print(f"Error converting {xml_path}: {e}")
            return None
    
    def get_supported_formats(self):
        """Return list of supported formats."""
        return self.config.get_auto_editor_config().get('supported_formats', ['.mp4', '.mov'])