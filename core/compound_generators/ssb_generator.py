# core/compound_generators/ssb_generator.py

import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional
import uuid
import datetime

from ..xml_utils import FCPXMLUtils
from ..audio_processor import AudioProcessor

class SSBGenerator:
    """Generate ssb (screen share big) compound clips with full-screen video and screen audio."""
    
    def __init__(self, config):
        self.config = config
        self.audio_processor = AudioProcessor(config)
        self.xml_utils = FCPXMLUtils()
    
    def generate_ssb_compound(self, compound_xml_path: str, audio_sources: Dict[str, str],
                                mode: str = "solo", output_path: Optional[str] = None,
                                apply_audio_sync: bool = False, video_sources: Optional[Dict[str, str]] = None) -> str:
            """Generate ssb compound clip from existing compound clip XML.

            Args:
                compound_xml_path: Path to existing compound XML file
                audio_sources: Dictionary mapping audio types to file paths (e.g., {'screen': '/path/to/screen.mp3'})
                mode: Layout mode ('solo' or 'dual')
                output_path: Optional custom output path
                apply_audio_sync: Whether to apply 29.97fps sync correction
                video_sources: Optional dictionary of video source paths (e.g., {'cam1': '/path/to/cam.mp4', 'screen': '/path/to/screen.mp4'})
            """
            video_sources = video_sources or {}
            
            # Load the original compound clip XML
            tree = self.xml_utils.parse_fcpxml(compound_xml_path)
            root = tree.getroot()
            
            # Get video settings from config
            video_settings = self.config.video_settings
            layout_config = self.config.get_layout_config('ssb', mode)
            
            if not layout_config:
                raise ValueError(f"No layout config found for ssb.{mode}")
            
            # Process screen audio (SSB only uses screen audio)
            processed_audio_sources = {}
            audio_sources_config = layout_config.get('audio_sources', ['screen', 'game', 'bluetooth'])

            for audio_type in audio_sources_config:
                if audio_type in audio_sources and audio_sources[audio_type]:
                    try:
                        # Check if the file actually exists before processing
                        if not Path(audio_sources[audio_type]).exists():
                            print(f"Warning: {audio_type} audio file not found: {audio_sources[audio_type]}")
                            continue
                            
                        processed_path, duration, sample_rate, channels = \
                            self.audio_processor.process_audio_source(audio_sources[audio_type], apply_audio_sync)
                        processed_audio_sources[audio_type] = {
                            'path': processed_path,
                            'duration': duration,
                            'sample_rate': sample_rate,
                            'channels': channels
                        }
                        print(f"Processed {audio_type} audio: {processed_path}")
                    except Exception as e:
                        print(f"Warning: Failed to process {audio_type} audio ({audio_sources[audio_type]}): {e}")
                        # Continue without this audio source instead of failing
                        continue

            # Don't fail if no audio sources were processed - SSB can work without audio
            if not processed_audio_sources:
                print("Warning: No audio sources were successfully processed for SSB - continuing with video only")
                
            # Get original compound info
            original_compound = root.find('.//media[@id="compound1"]')
            original_asset = root.find('.//asset[@id="r_original"]')
            
            if original_compound is None or original_asset is None:
                raise ValueError("Could not find original compound clip or asset in XML")
            
            # Get timeline cuts from main sequence
            cuts = self.xml_utils.get_compound_timeline_cuts(tree)
            if not cuts:
                raise ValueError("No timeline cuts found in compound XML")
            
            # Get original asset info
            original_duration = original_asset.get('duration')
            original_name = original_asset.get('name')
            original_src = original_asset.find('media-rep').get('src')
            
            # Create new ssb compound clip
            ssb_compound_id = "ssb_compound"
            ssb_name = f"{original_name} - SSB"
            
            # Start building new XML structure
            new_root = ET.Element('fcpxml')
            new_root.set('version', '1.11')
            
            resources = ET.SubElement(new_root, 'resources')
            
            # Create format elements
            # Get original format from compound XML for timeline compatibility
            original_format = tree.find('.//format')
            if original_format is not None:
                # Copy the original format for timeline compatibility
                timeline_format = ET.SubElement(resources, 'format')
                timeline_format.set('id', 'r1')
                timeline_format.set('name', original_format.get('name', 'FFVideoFormatRateUndefined'))
                timeline_format.set('frameDuration', original_format.get('frameDuration', '1/30s'))
                timeline_format.set('width', original_format.get('width', str(video_settings.get('width', 1920))))
                timeline_format.set('height', original_format.get('height', str(video_settings.get('height', 1080))))
                timeline_format.set('colorSpace', original_format.get('colorSpace', '1-1-1 (Rec. 709)'))
            
            # Compound clip format (for internal compound structure)
            video_format = self.xml_utils.create_format_element(
                'r1_ssb', 
                video_settings.get('frame_duration', '1001/30000s'),
                video_settings.get('width', 1920),
                video_settings.get('height', 1080),
                video_settings.get('color_space', '1-1-1 (Rec. 709)')
            )
            resources.append(video_format)
            
            # Create audio format for processed audio files
            audio_format = ET.Element('format')
            audio_format.set('id', 'r_audio_format')
            audio_format.set('name', 'FFVideoFormatRateUndefined')
            resources.append(audio_format)
            
            # Create audio assets for each processed audio source
            audio_assets = {}
            for audio_type, audio_info in processed_audio_sources.items():
                if audio_info:
                    asset_id = f"r_{audio_type}_audio"
                    audio_asset = self.xml_utils.create_asset_element(
                        asset_id,
                        Path(audio_info['path']).stem,
                        audio_info['path'],
                        audio_info['duration'],
                        'r_audio_format',
                        has_audio=True,
                        has_video=False,
                        audio_channels=audio_info['channels']
                    )
                    resources.append(audio_asset)
                    audio_assets[audio_type] = asset_id
            
            # Create original video asset (for master video source)
            original_asset_id = "r_original_video"
            original_video_asset = self.xml_utils.create_asset_element(
                original_asset_id,
                original_name,
                original_src.replace('file://', ''),
                original_duration,
                'r1_ssb',
                has_audio=True,
                has_video=True
            )
            resources.append(original_video_asset)

            # Check if optional cam1 video source is provided
            cam1_asset_id = None
            cam1_name = None
            if 'cam1' in video_sources and video_sources['cam1']:
                cam1_path = video_sources['cam1']
                cam1_asset_id = "r_cam1_video"
                cam1_name = Path(cam1_path).stem

                print(f"SSB: Using individual camera video: {cam1_path}")

                # Create asset for the cam1 video
                cam1_asset = self.xml_utils.create_asset_element(
                    cam1_asset_id,
                    cam1_name,
                    cam1_path,
                    original_duration,
                    'r1_ssb',
                    has_audio=False,
                    has_video=True
                )
                resources.append(cam1_asset)

            # Check if optional screen video source is provided
            screen_asset_id = None
            screen_name = None
            if 'screen' in video_sources and video_sources['screen']:
                screen_path = video_sources['screen']
                screen_asset_id = "r_screen_video"
                screen_name = Path(screen_path).stem

                print(f"SSB: Using individual screen video: {screen_path}")

                # Create asset for the screen video
                screen_asset = self.xml_utils.create_asset_element(
                    screen_asset_id,
                    screen_name,
                    screen_path,
                    original_duration,
                    'r1_ssb',
                    has_audio=False,
                    has_video=True
                )
                resources.append(screen_asset)

            # Create ssb compound media element
            ssb_media = self.xml_utils.create_media_compound(
                ssb_compound_id,
                ssb_name, 
                original_duration,  # Use full original duration for compound
                'r1_ssb',
                video_settings
            )
            
            # Build the compound sequence with gap structure
            sequence = ssb_media.find('sequence')
            spine = ET.SubElement(sequence, 'spine')
            
            # Create the gap element that spans full duration of compound clip
            gap = self.xml_utils.create_gap_element(
                "Gap",
                "0s",  # Always start at beginning
                original_duration  # Span full duration of master clip
            )
            
            # Add audio tracks based on available sources
            current_audio_lane = -2  # Start at lane -2 for first audio track
            
            # Add audio sources in order based on configuration
            for audio_type in audio_sources_config:
                if audio_type in audio_assets:
                    audio_info = processed_audio_sources[audio_type]
                    audio_clip = self.xml_utils.create_clip_with_audio_effects(
                        Path(audio_info['path']).stem,
                        audio_assets[audio_type],
                        str(current_audio_lane),
                        "0s",
                        audio_info['duration'],
                        audio_type,  # Pass audio type for volume adjustment
                        resources    # Pass resources
                    )
                    gap.append(audio_clip)
                    print(f"Added {audio_type} audio to lane {current_audio_lane}")
                    current_audio_lane -= 1
            
            # Add master audio clip (disabled, for reference)
            audio_config = layout_config.get('audio', {})
            master_audio_clip = self.xml_utils.create_audio_only_clip(
                original_name,
                original_asset_id,
                str(audio_config.get('master_lane', -1)),
                "0s",
                original_duration,
                enabled=audio_config.get('master_enabled', False)
            )
            gap.append(master_audio_clip)
            
            # Add space background if specified (lane 1 - bottom layer)
            background_asset_key = layout_config.get('background')
            if background_asset_key:
                background_path = self.config.get_asset_path(f'backgrounds.{background_asset_key}')
                if background_path and background_path != '':
                    # Create background asset
                    background_asset_id = f"r_{background_asset_key}"
                    background_asset = self.xml_utils.create_asset_element(
                        background_asset_id,
                        background_asset_key,
                        background_path,
                        original_duration,
                        'r1_ssb',
                        has_audio=False,
                        has_video=True
                    )
                    resources.append(background_asset)
                    
                    # Add background clip (lane 1 - bottom layer)
                    background_clip = self.xml_utils.create_video_clip(
                        background_asset_key,
                        background_asset_id,
                        "1",  # Lane 1 - bottom video layer
                        "0s",
                        original_duration,
                        None  # No transforms for background
                    )
                    gap.append(background_clip)
            
            # Add camera video (top left, small)
            camera_config = layout_config.get('camera', {})
            if camera_config:
                # Determine which asset and transforms to use
                if cam1_asset_id:
                    # Use individual cam1 video - NO CROPPING, only position/scale
                    camera_asset = cam1_asset_id
                    camera_name_for_clip = cam1_name
                    camera_transforms = {
                        'crop': None,  # No crop for individual video
                        'crop_mode': None,
                        'transform': {
                            'position': [-36.481, 19.63],  # -394 / 10.8, 212 / 10.8
                            'scale': 0.565  # 56.5%
                        }
                    }
                    print(f"SSB: Using cam1 video with scale-only transform (no crop)")
                else:
                    # Use master video - WITH CROPPING
                    camera_asset = original_asset_id
                    camera_name_for_clip = f"{original_name} - Camera"
                    camera_transforms = {
                        'crop': [2.2772, 51.392, 91.1719, 1.49848],
                        'crop_mode': 'trim',
                        'transform': {
                            'position': [16.4529, 49.3529],
                            'scale': 1.1936
                        }
                    }
                    print(f"SSB: Using master video with crop and transform")

                camera_clip = self.xml_utils.create_video_clip(
                    camera_name_for_clip,
                    camera_asset,
                    "2",  # Lane 2 to match template
                    "0s",
                    original_duration,
                    camera_transforms
                )
                gap.append(camera_clip)
                
                # Add camera border if specified (lane 3 - immediately above camera)
                if 'border' in camera_config:
                    border_asset_key = camera_config['border']
                    border_path = self.config.get_border_path(border_asset_key)
                    
                    if border_path and border_path != '':
                        # Create border asset
                        border_asset_id = f"r_{border_asset_key.replace('.', '_')}_camera"
                        border_asset = self.xml_utils.create_asset_element(
                            border_asset_id,
                            f"{border_asset_key} - Camera",
                            border_path,
                            original_duration,
                            'r1_ssb',
                            has_audio=False,
                            has_video=True
                        )
                        resources.append(border_asset)
                        
                        # Add border clip (lane 3)
                        border_clip = self.xml_utils.create_video_clip(
                            f"{border_asset_key} - Camera",
                            border_asset_id,
                            "3",  # Lane 3 - right above camera (lane 2)
                            "0s",
                            original_duration,
                            None  # No transforms - border should be full-screen overlay
                        )
                        gap.append(border_clip)
            
            # Add screen video (bottom right, large)
            screen_config = layout_config.get('screen', {})
            if screen_config:
                # Determine which asset and transforms to use
                if screen_asset_id:
                    # Use individual screen video - NO CROPPING, only position/scale
                    screen_video_asset = screen_asset_id
                    screen_name_for_clip = screen_name
                    screen_transforms = {
                        'crop': None,  # No crop for individual video
                        'crop_mode': None,
                        'transform': {
                            'position': [34.63, -18.75],  # 374 / 10.8, -202.5 / 10.8
                            'scale': 0.5843  # 58.43%
                        }
                    }
                    print(f"SSB: Using screen video with scale-only transform (no crop)")
                else:
                    # Use master video - WITH CROPPING
                    screen_video_asset = original_asset_id
                    screen_name_for_clip = f"{original_name} - Screen"
                    screen_transforms = {
                        'crop': [3.92176, 2.55248, 91.5688, 51.0858],
                        'crop_mode': 'trim',
                        'transform': {
                            'position': [90.0328, -49.4777],
                            'scale': 1.26677
                        }
                    }
                    print(f"SSB: Using master video for screen with crop and transform")

                screen_clip = self.xml_utils.create_video_clip(
                    screen_name_for_clip,
                    screen_video_asset,
                    "4",  # Lane 4 to match template
                    "0s",
                    original_duration,
                    screen_transforms
                )
                gap.append(screen_clip)
                
                # Add screen border if specified (lane 5 - immediately above screen)
                if 'border' in screen_config:
                    border_asset_key = screen_config['border']
                    border_path = self.config.get_border_path(border_asset_key)
                    
                    if border_path and border_path != '':
                        # Create border asset
                        border_asset_id = f"r_{border_asset_key.replace('.', '_')}_screen"
                        border_asset = self.xml_utils.create_asset_element(
                            border_asset_id,
                            f"{border_asset_key} - Screen",
                            border_path,
                            original_duration,
                            'r1_ssb',
                            has_audio=False,
                            has_video=True
                        )
                        resources.append(border_asset)
                        
                        # Add border clip (lane 5)
                        border_clip = self.xml_utils.create_video_clip(
                            f"{border_asset_key} - Screen",
                            border_asset_id,
                            "5",  # Lane 5 - right above screen (lane 4)
                            "0s",
                            original_duration,
                            None  # No transforms - border should be full-screen overlay
                        )
                        gap.append(border_clip)
            
            spine.append(gap)
            resources.append(ssb_media)
            
            # Create library and project structure
            library = ET.SubElement(new_root, 'library')
            event = ET.SubElement(library, 'event')
            event.set('name', 'Auto-Editor Media Group')
            
            project = ET.SubElement(event, 'project')
            project.set('name', f"{original_name} - SSB Edit")
            
            # Create main timeline with the cut structure referencing the ssb compound
            original_format_id = "r1"  # Use the original auto-editor format for the main timeline
            main_sequence = ET.SubElement(project, 'sequence')
            main_sequence.set('format', original_format_id)  # Match original cuts format
            main_sequence.set('tcStart', '0s')
            main_sequence.set('tcFormat', video_settings.get('tcFormat', 'NDF'))
            main_sequence.set('audioLayout', video_settings.get('audioLayout', 'stereo'))
            main_sequence.set('audioRate', video_settings.get('audioRate', '48k'))
            
            main_spine = ET.SubElement(main_sequence, 'spine')
            
            # Add ref-clips for each cut, referencing the ssb compound
            main_timeline_frame_duration = original_format.get('frameDuration', '1/30s') if original_format is not None else '1/30s'

            # Track expected offset to ensure continuity (no gaps/overlaps)
            expected_offset = "0s"

            for i, cut in enumerate(cuts):
                ref_clip = ET.SubElement(main_spine, 'ref-clip')
                ref_clip.set('ref', ssb_compound_id)
                ref_clip.set('name', ssb_name)

                # Snap duration and start to frame boundaries
                snapped_duration = self._snap_to_frame_boundary(cut['duration'], main_timeline_frame_duration)
                snapped_start = self._snap_to_frame_boundary(cut['start'], main_timeline_frame_duration)

                # Use expected_offset to ensure continuity (no gaps between clips)
                if i == 0:
                    snapped_offset = self._snap_to_frame_boundary(cut['offset'], main_timeline_frame_duration)
                    expected_offset = snapped_offset
                else:
                    snapped_offset = expected_offset

                ref_clip.set('offset', snapped_offset)
                ref_clip.set('duration', snapped_duration)
                ref_clip.set('start', snapped_start)

                # Calculate next expected offset
                expected_offset = self._add_time_fractions(snapped_offset, snapped_duration)
            
            # Save the new XML
            if output_path is None:
                input_path = Path(compound_xml_path)
                output_path = input_path.parent / f"{input_path.stem}_SSB.fcpxml"
            
            new_tree = ET.ElementTree(new_root)
            self.xml_utils.save_fcpxml(new_tree, output_path)
            
            print(f"SSB compound clip created: {output_path}")
            return str(output_path)
    
    @classmethod
    def handle_generate_ssb(cls, args, config):
        """Handle generate-ssb command from CLI."""
        try:
            # Validate input files
            compound_path = Path(args.compound)
            
            if not compound_path.exists():
                print(f"Error: Compound XML file not found: {compound_path}")
                return 1
            
            # Build audio sources dictionary from explicit arguments
            audio_sources = {}
            
            if args.screen_audio:
                screen_path = Path(args.screen_audio)
                if screen_path.exists():
                    audio_sources['screen'] = str(screen_path)
                    print(f"Using screen audio: {screen_path}")
                else:
                    print(f"Error: Screen audio file not found: {screen_path}")
                    return 1

            if args.game_audio:
                game_path = Path(args.game_audio)
                if game_path.exists():
                    audio_sources['game'] = str(game_path)
                    print(f"Using game audio: {game_path}")
                else:
                    print(f"Warning: Game audio file not found: {game_path}")
            
            if not audio_sources:
                print("Error: At least one audio source is required for SSB compound (--screen-audio or --game-audio)")
                return 1
            
            print(f"Processing audio sources: {list(audio_sources.keys())}")
            
            # Create SSB generator
            ssb_generator = cls(config)
            
            # Generate SSB compound clip
            output_path = ssb_generator.generate_ssb_compound(
                str(compound_path),
                audio_sources,
                args.mode,
                args.output,
                args.sync_audio
            )
            
            print(f"Success! SSB compound clip generated: {output_path}")
            print("\nNext steps:")
            print("1. Import the XML file into Final Cut Pro X")
            print("2. The SSB compound clip will be available in your event")
            print("3. Use the main timeline to switch between cuts")
            
            return 0
            
        except Exception as e:
            print(f"Error generating SSB compound clip: {e}")
            return 1

    def _add_time_fractions(self, time_str1: str, time_str2: str) -> str:
        """Add two time values as fractions."""
        def parse_time(t):
            if t.endswith('s'):
                t = t[:-1]
            if '/' in t:
                num, den = t.split('/')
                return int(num), int(den)
            return int(t), 1

        num1, den1 = parse_time(time_str1)
        num2, den2 = parse_time(time_str2)

        if den1 == den2:
            result_num = num1 + num2
            result_den = den1
        else:
            result_num = num1 * den2 + num2 * den1
            result_den = den1 * den2

        return f"{result_num}/{result_den}s"

    def _snap_to_frame_boundary(self, time_str: str, frame_duration_str: str) -> str:
        """Snap a time value to the nearest frame boundary."""
        def parse_time(t):
            if t.endswith('s'):
                t = t[:-1]
            if '/' in t:
                num, den = t.split('/')
                return int(num), int(den)
            return int(t), 1

        time_num, time_den = parse_time(time_str)
        frame_num, frame_den = parse_time(frame_duration_str)

        # Calculate time in seconds and frame duration in seconds
        time_seconds = time_num / time_den
        frame_duration_seconds = frame_num / frame_den

        # Round to nearest frame
        frames = round(time_seconds / frame_duration_seconds)

        # Convert back to fractional format with fixed denominator (30000 for 29.97fps)
        # Keep denominator consistent to avoid rounding errors
        if frame_duration_str == '1001/30000s':
            # 29.97fps
            snapped_num = frames * 1001
            snapped_den = 30000
        elif frame_duration_str == '1/30s':
            # 30fps
            snapped_num = frames
            snapped_den = 30
        else:
            # Generic case - use original denominator
            snapped_num = frames * frame_num
            snapped_den = frame_den

        return f"{snapped_num}/{snapped_den}s"