# core/compound_generators/gs_generator.py

import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional
import uuid
import datetime
import shutil
import sys

from ..xml_utils import FCPXMLUtils
from ..audio_processor import AudioProcessor

class GSGenerator:
    """Generate gs (game share) compound clips with multi-view layout."""
    
    def __init__(self, config):
        self.config = config
        self.audio_processor = AudioProcessor(config)
        self.xml_utils = FCPXMLUtils()
    
    def generate_gs_compound(self, compound_xml_path: str, audio_sources: Dict[str, str],
                            output_path: Optional[str] = None,
                            apply_audio_sync: bool = False, video_sources: Optional[Dict[str, str]] = None,
                            auto_duck: bool = False) -> str:
        """Generate gs compound clip from existing compound clip XML.

        Args:
            compound_xml_path: Path to existing compound XML file
            audio_sources: Dictionary mapping audio types to file paths
            output_path: Optional custom output path
            apply_audio_sync: Whether to apply 29.97fps sync correction
            video_sources: Optional dictionary of video source paths (e.g., {'game': '/path/to/game.mp4'})
            auto_duck: Whether to apply universal auto ducking
        """
        video_sources = video_sources or {}
        
        # Load the original compound clip XML
        tree = self.xml_utils.parse_fcpxml(compound_xml_path)
        root = tree.getroot()
        
        # Get video settings from config
        video_settings = self.config.video_settings
        layout_config = self.config.get_layout_config('gs', 'solo')
        
        if not layout_config:
            raise ValueError("No layout config found for gs.solo")
        
        # Process audio sources - ALL audio types for GS
        processed_audio_sources = {}
        for audio_type, audio_path in audio_sources.items():
            if audio_path and audio_type in ['mic1', 'mic2', 'mic3', 'mic4', 'screen', 'game', 'sound_effects', 'bluetooth']:
                try:
                    processed_path, duration, sample_rate, channels = \
                        self.audio_processor.process_audio_source(audio_path, apply_audio_sync, audio_type=audio_type)
                    processed_audio_sources[audio_type] = {
                        'path': processed_path,
                        'duration': duration,
                        'sample_rate': sample_rate,
                        'channels': channels
                    }
                    print(f"Processed {audio_type} audio: {processed_path}")
                except Exception as e:
                    print(f"Warning: Failed to process {audio_type} audio ({audio_path}): {e}")
                    processed_audio_sources[audio_type] = None

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
        
        # Create new gs compound clip
        gs_compound_id = "gs_compound"
        gs_name = f"{original_name} - GS"
        
        # Start building new XML structure
        new_root = ET.Element('fcpxml')
        new_root.set('version', '1.11')
        
        resources = ET.SubElement(new_root, 'resources')
        
        # Create format elements
        original_format = tree.find('.//format')
        if original_format is not None:
            timeline_format = ET.SubElement(resources, 'format')
            timeline_format.set('id', 'r1')
            timeline_format.set('name', original_format.get('name', 'FFVideoFormatRateUndefined'))
            timeline_format.set('frameDuration', original_format.get('frameDuration', '1/30s'))
            timeline_format.set('width', original_format.get('width', str(video_settings.get('width', 1920))))
            timeline_format.set('height', original_format.get('height', str(video_settings.get('height', 1080))))
            timeline_format.set('colorSpace', original_format.get('colorSpace', '1-1-1 (Rec. 709)'))
        
        # Compound clip format
        video_format = self.xml_utils.create_format_element(
            'r1_gs', 
            video_settings.get('frame_duration', '1001/30000s'),
            video_settings.get('width', 1920),
            video_settings.get('height', 1080),
            video_settings.get('color_space', '1-1-1 (Rec. 709)')
        )
        resources.append(video_format)
        
        # Create audio format
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
        
        # Create original video asset
        original_asset_id = "r_original_video"
        original_video_asset = self.xml_utils.create_asset_element(
            original_asset_id,
            original_name,
            original_src.replace('file://', ''),
            original_duration,
            'r1_gs',
            has_audio=True,
            has_video=True
        )
        resources.append(original_video_asset)

        # Check if optional cam1 video source is provided
        cam1_asset_id = None
        cam1_name = None
        cam1_retime_map = None
        if 'cam1' in video_sources and video_sources['cam1']:
            cam1_path = video_sources['cam1']
            cam1_asset_id = "r_cam1_video"
            cam1_name = Path(cam1_path).stem

            # Detect framerate (no retiming applied - duration-based sync)
            cam1_fps = self.audio_processor.get_video_framerate(cam1_path)
            cam1_retime_map = self.xml_utils.calculate_retime_map(original_duration, cam1_fps, 29.97)
            print(f"  cam1 video: {cam1_fps:.2f}fps (synced by duration, not framerate)", file=sys.stderr)

            cam1_asset = self.xml_utils.create_asset_element(
                cam1_asset_id, cam1_name, cam1_path, original_duration,
                'r1_gs', has_audio=False, has_video=True
            )
            resources.append(cam1_asset)

        # Check if optional game video source is provided
        game_asset_id = None
        game_name = None
        game_retime_map = None
        if 'game' in video_sources and video_sources['game']:
            game_path = video_sources['game']
            game_asset_id = "r_game_video"
            game_name = Path(game_path).stem

            # Detect framerate
            game_fps = self.audio_processor.get_video_framerate(game_path)

            # METHOD B: Metadata-based drift correction
            # Get video duration and corresponding audio duration (if available)
            game_video_duration = self.audio_processor.get_video_duration_seconds(game_path)
            game_audio_duration = None

            # Try to get audio duration from the game audio source
            if 'game' in processed_audio_sources and processed_audio_sources['game']:
                game_audio_path = processed_audio_sources['game']['path']
                game_audio_duration = self.audio_processor.get_duration_seconds(game_audio_path)
                print(f"  game: video={game_video_duration:.2f}s, audio={game_audio_duration:.2f}s", file=sys.stderr)

            # Calculate retime map using Method B (metadata) or Method C (framerate fallback)
            game_retime_map = self.xml_utils.calculate_retime_map(
                original_duration, game_fps, 29.97,
                video_duration=game_video_duration if game_audio_duration else None,
                audio_duration=game_audio_duration
            )

            game_asset = self.xml_utils.create_asset_element(
                game_asset_id, game_name, game_path, original_duration,
                'r1_gs', has_audio=False, has_video=True
            )
            resources.append(game_asset)

        # Check if optional screen video source is provided
        screen_asset_id = None
        screen_name = None
        screen_retime_map = None
        if 'screen' in video_sources and video_sources['screen']:
            screen_path = video_sources['screen']
            screen_asset_id = "r_screen_video"
            screen_name = Path(screen_path).stem

            # Detect framerate
            screen_fps = self.audio_processor.get_video_framerate(screen_path)

            # METHOD B: Metadata-based drift correction
            # Get video duration and corresponding audio duration (if available)
            screen_video_duration = self.audio_processor.get_video_duration_seconds(screen_path)
            screen_audio_duration = None

            # Try to get audio duration from the screen audio source
            if 'screen' in processed_audio_sources and processed_audio_sources['screen']:
                screen_audio_path = processed_audio_sources['screen']['path']
                screen_audio_duration = self.audio_processor.get_duration_seconds(screen_audio_path)
                print(f"  screen: video={screen_video_duration:.2f}s, audio={screen_audio_duration:.2f}s", file=sys.stderr)

            # Calculate retime map using Method B (metadata) or Method C (framerate fallback)
            screen_retime_map = self.xml_utils.calculate_retime_map(
                original_duration, screen_fps, 29.97,
                video_duration=screen_video_duration if screen_audio_duration else None,
                audio_duration=screen_audio_duration
            )

            screen_asset = self.xml_utils.create_asset_element(
                screen_asset_id, screen_name, screen_path, original_duration,
                'r1_gs', has_audio=False, has_video=True
            )
            resources.append(screen_asset)

        # Create gs compound media element
        gs_media = self.xml_utils.create_media_compound(
            gs_compound_id,
            gs_name, 
            original_duration,
            'r1_gs',
            video_settings
        )
        
        # Build the compound sequence with gap structure
        sequence = gs_media.find('sequence')
        spine = ET.SubElement(sequence, 'spine')
        
        # Create the gap element
        gap = self.xml_utils.create_gap_element(
            "Gap",
            "0s",
            original_duration
        )
        
        # Add audio tracks based on available sources
        # NOTE: For GS compound, ALL audio tracks are DISABLED by default
        audio_config = layout_config.get('audio', {})

        # Add master audio clip FIRST at lane -1 (disabled)
        master_audio_clip = self.xml_utils.create_audio_only_clip(
            original_name,
            original_asset_id,
            "-1",  # Always lane -1
            "0s",
            original_duration,
            enabled=False  # Disabled for GS
        )
        gap.append(master_audio_clip)
        pass  # 0

        # Start mic audio tracks at lane -2 (below master at -1)
        current_audio_lane = -2

        # Add mic audio tracks in order (mic1, mic2, mic3, mic4) - all DISABLED
        for mic_num in range(1, 5):
            mic_key = f'mic{mic_num}'
            if mic_key in audio_assets:
                audio_info = processed_audio_sources[mic_key]
                mic_clip = self.xml_utils.create_clip_with_audio_effects(
                    Path(audio_info['path']).stem,
                    audio_assets[mic_key],
                    str(current_audio_lane),
                    "0s",
                    audio_info['duration'],
                    mic_key,     # Pass audio type for effects
                    resources,   # Pass resources for effect creation
                    enabled=False,  # DISABLED for GS
                    channels=audio_info['channels']
                )
                gap.append(mic_clip)
                pass  # 0
                current_audio_lane -= 1

        # Add screen audio if present - DISABLED
        if 'screen' in audio_assets:
            audio_info = processed_audio_sources['screen']
            screen_clip = self.xml_utils.create_clip_with_audio_effects(
                Path(audio_info['path']).stem,
                audio_assets['screen'],
                str(current_audio_lane),
                "0s",
                audio_info['duration'],
                'screen',    # Pass audio type for effects
                resources,   # Pass resources for effect creation
                enabled=False  # DISABLED for GS
            )
            gap.append(screen_clip)
            pass  # 0
            current_audio_lane -= 1

        # Add game audio if present - DISABLED
        if 'game' in audio_assets:
            audio_info = processed_audio_sources['game']
            game_clip = self.xml_utils.create_clip_with_audio_effects(
                Path(audio_info['path']).stem,
                audio_assets['game'],
                str(current_audio_lane),
                "0s",
                audio_info['duration'],
                'game',      # Pass audio type for effects
                resources,   # Pass resources for effect creation
                enabled=False  # DISABLED for GS
            )
            gap.append(game_clip)
            pass  # 0
            current_audio_lane -= 1

        # Add sound effects if present - DISABLED
        if 'sound_effects' in audio_assets:
            audio_info = processed_audio_sources['sound_effects']
            sfx_clip = self.xml_utils.create_clip_with_audio_effects(
                Path(audio_info['path']).stem,
                audio_assets['sound_effects'],
                str(current_audio_lane),
                "0s",
                audio_info['duration'],
                'sound_effects',  # Pass audio type for effects
                resources,        # Pass resources for effect creation
                enabled=False     # DISABLED for GS
            )
            gap.append(sfx_clip)
            pass  # 0
            current_audio_lane -= 1
        
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
                    'r1_gs',
                    has_audio=False,
                    has_video=True
                )
                resources.append(background_asset)
                
                # Add background clip (lane 1 - bottom layer)
                background_clip = self.xml_utils.create_video_clip(
                    background_asset_key,
                    background_asset_id,
                    "1",
                    "0s",
                    original_duration,
                    None
                )
                gap.append(background_clip)
        
        # Add camera video (bottom left)
        camera_config = layout_config.get('camera', {})
        if camera_config:
            # Determine which asset and transforms to use
            if cam1_asset_id:
                # Use individual cam1 video - NO CROPPING, only position/scale
                camera_asset = cam1_asset_id
                camera_name_for_clip = cam1_name
                camera_transforms = {
                    'crop': None,
                    'crop_mode': None,
                    'transform': {
                        'position': [-25, -25],  # Bottom-left quadrant
                        'scale': 0.5  # 50% - perfect quadrant
                    }
                }
                pass  # 0
            else:
                # Use master video - WITH CROPPING
                camera_asset = original_asset_id
                camera_name_for_clip = f"{original_name} - Camera"
                camera_transforms = {
                    'crop': [2.45, 51.7584, 91.1816, 1.37531],
                    'crop_mode': 'trim',
                    'transform': {
                        'position': [-17.5288, -8.90442],
                        'scale': 0.800813
                    }
                }
                pass  # 0

            camera_clip = self.xml_utils.create_video_clip(
                camera_name_for_clip,
                camera_asset,
                "2",
                "0s",
                original_duration,
                camera_transforms,
                retime_map=cam1_retime_map if cam1_asset_id else None
            )
            gap.append(camera_clip)
            
            # Add camera border if specified
            camera_border_path = self.config.get_border_path('gs.bottom_left')
            if camera_border_path and camera_border_path != '':
                # Create border asset
                border_asset_id = "r_gs_bottom_left_camera"
                border_asset = self.xml_utils.create_asset_element(
                    border_asset_id,
                    "gs bottom left - Camera",
                    camera_border_path,
                    original_duration,
                    'r1_gs',
                    has_audio=False,
                    has_video=True
                )
                resources.append(border_asset)
                
                # Add border clip
                border_clip = self.xml_utils.create_video_clip(
                    "gs bottom left - Camera",
                    border_asset_id,
                    "3",
                    "0s",
                    original_duration,
                    None
                )
                gap.append(border_clip)
        
        # Add game video (bottom right)
        game_config = layout_config.get('game', {})
        if game_config:
            # Determine which asset and transforms to use
            if game_asset_id:
                # Use individual game video - NO CROPPING, only position/scale
                game_video_asset = game_asset_id
                game_name_for_clip = game_name
                game_transforms = {
                    'crop': None,
                    'crop_mode': None,
                    'transform': {
                        'position': [25, -25],  # Bottom-right quadrant
                        'scale': 0.5  # 50% - perfect quadrant
                    }
                }
                pass  # 0
            else:
                # Use master video - WITH CROPPING
                game_video_asset = original_asset_id
                game_name_for_clip = f"{original_name} - Game"
                game_transforms = {
                    'crop': [91.1158, 51.1409, 1.77082, 1.1649],
                    'crop_mode': 'trim',
                    'transform': {
                        'position': [-20.324, 12.126],
                        'scale': 1.23
                    }
                }
                pass  # 0

            game_clip = self.xml_utils.create_video_clip(
                game_name_for_clip,
                game_video_asset,
                "4",
                "0s",
                original_duration,
                game_transforms,
                retime_map=game_retime_map if game_asset_id else None
            )
            gap.append(game_clip)
            
            # Add game border if specified
            game_border_path = self.config.get_border_path('gs.bottom_right')
            if game_border_path and game_border_path != '':
                # Create border asset
                border_asset_id = "r_gs_bottom_right_game"
                border_asset = self.xml_utils.create_asset_element(
                    border_asset_id,
                    "gs bottom right - Game",
                    game_border_path,
                    original_duration,
                    'r1_gs',
                    has_audio=False,
                    has_video=True
                )
                resources.append(border_asset)
                
                # Add border clip
                border_clip = self.xml_utils.create_video_clip(
                    "gs bottom right - Game",
                    border_asset_id,
                    "5",
                    "0s",
                    original_duration,
                    None
                )
                gap.append(border_clip)
        
        # Add screen video (top left)
        screen_config = layout_config.get('screen', {})
        if screen_config:
            # Determine which asset and transforms to use
            if screen_asset_id:
                # Use individual screen video - NO CROPPING, only position/scale
                screen_video_asset = screen_asset_id
                screen_name_for_clip = screen_name
                screen_transforms = {
                    'crop': None,
                    'crop_mode': None,
                    'transform': {
                        'position': [-25, 25],  # Top-left quadrant
                        'scale': 0.5  # 50% - perfect quadrant
                    }
                }
                pass  # 0
            else:
                # Use master video - WITH CROPPING
                screen_video_asset = original_asset_id
                screen_name_for_clip = f"{original_name} - Screen"
                screen_transforms = {
                    'crop': [2.02365, 1.18815, 90.863, 51.1176],
                    'crop_mode': 'trim',
                    'transform': {
                        'position': [15.8684, -9.95576],
                        'scale': 1.17903
                    }
                }
                pass  # 0

            screen_clip = self.xml_utils.create_video_clip(
                screen_name_for_clip,
                screen_video_asset,
                "6",
                "0s",
                original_duration,
                screen_transforms,
                retime_map=screen_retime_map if screen_asset_id else None
            )
            gap.append(screen_clip)
            
            # Add screen border if specified
            screen_border_path = self.config.get_border_path('gs.top_left')
            if screen_border_path and screen_border_path != '':
                # Create border asset
                border_asset_id = "r_gs_top_left_screen"
                border_asset = self.xml_utils.create_asset_element(
                    border_asset_id,
                    "gs top left - Screen",
                    screen_border_path,
                    original_duration,
                    'r1_gs',
                    has_audio=False,
                    has_video=True
                )
                resources.append(border_asset)
                
                # Add border clip
                border_clip = self.xml_utils.create_video_clip(
                    "gs top left - Screen",
                    border_asset_id,
                    "7",
                    "0s",
                    original_duration,
                    None
                )
                gap.append(border_clip)
        
        spine.append(gap)
        resources.append(gs_media)
        
        # Create library and project structure
        library = ET.SubElement(new_root, 'library')
        event = ET.SubElement(library, 'event')
        event.set('name', 'Auto-Editor Media Group')
        
        project = ET.SubElement(event, 'project')
        project.set('name', f"{original_name} - GS Edit")
        
        # Create main timeline with the cut structure referencing the gs compound
        original_format_id = "r1"
        main_sequence = ET.SubElement(project, 'sequence')
        main_sequence.set('format', original_format_id)
        main_sequence.set('tcStart', '0s')
        main_sequence.set('tcFormat', video_settings.get('tcFormat', 'NDF'))
        main_sequence.set('audioLayout', video_settings.get('audioLayout', 'stereo'))
        main_sequence.set('audioRate', video_settings.get('audioRate', '48k'))
        
        main_spine = ET.SubElement(main_sequence, 'spine')
        
        # Add ref-clips for each cut, referencing the gs compound
        main_timeline_frame_duration = original_format.get('frameDuration', '1/30s') if original_format is not None else '1/30s'

        # Track expected offset to ensure continuity (no gaps/overlaps)
        expected_offset = "0s"

        for i, cut in enumerate(cuts):
            ref_clip = ET.SubElement(main_spine, 'ref-clip')
            ref_clip.set('ref', gs_compound_id)
            ref_clip.set('name', gs_name)

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
            output_path = input_path.parent / f"{input_path.stem}_GS.fcpxml"
        
        new_tree = ET.ElementTree(new_root)
        self.xml_utils.save_fcpxml(new_tree, output_path)
        
        print(f"GS compound clip created: {output_path}")
        return str(output_path)
    
    @classmethod
    def handle_generate_gs(cls, args, config):
        """Handle generate-gs command from CLI."""
        try:
            # Validate input files
            compound_path = Path(args.compound)
            
            if not compound_path.exists():
                print(f"Error: Compound XML file not found: {compound_path}")
                return 1
            
            # Build audio sources dictionary from explicit arguments
            audio_sources = {}
            
            if args.mic_audio:
                mic_path = Path(args.mic_audio)
                if mic_path.exists():
                    audio_sources['mic1'] = str(mic_path)
                    pass  # 0
                else:
                    print(f"Error: Mic1 audio file not found: {mic_path}")
                    return 1
            
            if args.mic2_audio:
                mic2_path = Path(args.mic2_audio)
                if mic2_path.exists():
                    audio_sources['mic2'] = str(mic2_path)
                    pass  # 0
                else:
                    print(f"Warning: Mic2 audio file not found: {mic2_path}")
            
            if args.mic3_audio:
                mic3_path = Path(args.mic3_audio)
                if mic3_path.exists():
                    audio_sources['mic3'] = str(mic3_path)
                    pass  # 0
                else:
                    print(f"Warning: Mic3 audio file not found: {mic3_path}")
            
            if args.mic4_audio:
                mic4_path = Path(args.mic4_audio)
                if mic4_path.exists():
                    audio_sources['mic4'] = str(mic4_path)
                    pass  # 0
                else:
                    print(f"Warning: Mic4 audio file not found: {mic4_path}")
            
            if args.screen_audio:
                screen_path = Path(args.screen_audio)
                if screen_path.exists():
                    audio_sources['screen'] = str(screen_path)
                    pass  # 0
                else:
                    print(f"Warning: Screen audio file not found: {screen_path}")
            
            if args.game_audio:
                game_path = Path(args.game_audio)
                if game_path.exists():
                    audio_sources['game'] = str(game_path)
                    pass  # 0
                else:
                    print(f"Warning: Game audio file not found: {game_path}")
            
            if args.sound_effects:
                sfx_path = Path(args.sound_effects)
                if sfx_path.exists():
                    audio_sources['sound_effects'] = str(sfx_path)
                    pass  # 0
                else:
                    print(f"Warning: Sound effects file not found: {sfx_path}")
            
            if not audio_sources:
                print("Error: At least one audio source is required")
                return 1
            
            print(f"Processing audio sources: {list(audio_sources.keys())}")
            
            # Create GS generator
            gs_generator = cls(config)
            
            # Generate GS compound clip
            output_path = gs_generator.generate_gs_compound(
                str(compound_path),
                audio_sources,
                args.output,
                args.sync_audio
            )
            
            print(f"Success! GS compound clip generated: {output_path}")
            print("\nNext steps:")
            print("1. Import the XML file into Final Cut Pro X")
            print("2. The GS compound clip will be available in your event")
            print("3. Use the main timeline to switch between cuts")
            
            return 0
            
        except Exception as e:
            print(f"Error generating GS compound clip: {e}")
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

    def _apply_auto_ducking(self, processed_audio_sources: Dict[str, Optional[Dict]]) -> None:
        """Apply universal auto ducking to audio sources.

        Rules:
        1. If NO sb files: duck mic1 and screen, favoring screen (max settings)
        2. If sb files exist:
           - Duck mic1_sb and mic2_sb, favoring mic1_sb
           - Duck mic1_sb and screen_sb, favoring screen_sb

        Args:
            processed_audio_sources: Dictionary of processed audio sources (modified in place)
        """
        from cli.audio_ducking import AudioDucker

        # Check if we have any soundboard files by looking at the is_soundboard flag
        def is_soundboard_file(audio_info):
            """Check if this audio source is from soundboard"""
            if not audio_info:
                return False
            return audio_info.get('sync_info', {}).get('is_soundboard', False)

        has_sb_files = any(is_soundboard_file(info) for info in processed_audio_sources.values() if info)

        # DEBUG: Log what we detected
        print(f"\n🎚️  Auto Ducking Analysis:", file=sys.stderr)
        print(f"  Soundboard files detected: {has_sb_files}", file=sys.stderr)
        if has_sb_files:
            sb_files = [key for key, info in processed_audio_sources.items() if is_soundboard_file(info)]
            print(f"  Soundboard sources: {', '.join(sb_files)}", file=sys.stderr)
        print(file=sys.stderr)

        # Max ducking settings
        threshold = -40  # dB
        ratio = 20  # 20:1 (maximum)
        attack = 10  # ms
        release = 100  # ms

        ducker = AudioDucker()

        if not has_sb_files:
            # Case 1: No soundboard files - duck mic1 and screen, favoring screen
            print("No soundboard files detected - applying standard ducking", file=sys.stderr)

            mic1_info = processed_audio_sources.get('mic1')
            screen_info = processed_audio_sources.get('screen')

            if mic1_info and screen_info:
                print(f"Ducking mic1 when screen is loud (favoring screen)", file=sys.stderr)

                # Duck mic1 when screen is loud - overwrite the processed file
                original_path = mic1_info['path']
                temp_ducked_path = str(Path(original_path).parent / f"{Path(original_path).stem}_temp_ducked.wav")

                ducker.duck_audio(
                    audio_to_duck=original_path,
                    trigger_audio=screen_info['path'],
                    output_path=temp_ducked_path,
                    threshold=threshold,
                    ratio=ratio,
                    attack=attack,
                    release=release
                )

                # Replace original processed file with ducked version
                shutil.move(temp_ducked_path, original_path)
                print(f"✓ Replaced {Path(original_path).name} with ducked version", file=sys.stderr)
            else:
                if not mic1_info:
                    print("⚠ mic1 audio not found - skipping ducking", file=sys.stderr)
                if not screen_info:
                    print("⚠ screen audio not found - skipping ducking", file=sys.stderr)
        else:
            # Case 2: Soundboard files exist
            # Note: Soundboard files are stored with normalized keys (mic1, mic2, screen)
            # but have is_soundboard=True in sync_info
            print("Soundboard files detected - applying soundboard ducking", file=sys.stderr)

            # Get soundboard file info (they're stored as mic1, mic2, screen with is_soundboard flag)
            mic1_info = processed_audio_sources.get('mic1') if is_soundboard_file(processed_audio_sources.get('mic1')) else None
            mic2_info = processed_audio_sources.get('mic2') if is_soundboard_file(processed_audio_sources.get('mic2')) else None
            screen_info = processed_audio_sources.get('screen') if is_soundboard_file(processed_audio_sources.get('screen')) else None

            # Step 1: Duck mic2 when mic1 is loud (favor mic1)
            if mic1_info and mic2_info:
                print(f"Ducking mic2 (soundboard) when mic1 (soundboard) is loud (favoring mic1)", file=sys.stderr)

                original_path = mic2_info['path']
                temp_ducked_path = str(Path(original_path).parent / f"{Path(original_path).stem}_temp_ducked.wav")

                ducker.duck_audio(
                    audio_to_duck=original_path,
                    trigger_audio=mic1_info['path'],
                    output_path=temp_ducked_path,
                    threshold=threshold,
                    ratio=ratio,
                    attack=attack,
                    release=release
                )

                # Replace original processed file with ducked version
                shutil.move(temp_ducked_path, original_path)
                print(f"✓ Replaced {Path(original_path).name} with ducked version", file=sys.stderr)
            else:
                if not mic1_info:
                    print("⚠ mic1 (soundboard) audio not found - skipping mic1/mic2 ducking", file=sys.stderr)
                if not mic2_info:
                    print("⚠ mic2 (soundboard) audio not found - skipping mic1/mic2 ducking", file=sys.stderr)

            # Step 2: Duck mic1 when screen is loud (favor screen)
            if mic1_info and screen_info:
                print(f"Ducking mic1 (soundboard) when screen (soundboard) is loud (favoring screen)", file=sys.stderr)

                original_path = mic1_info['path']
                temp_ducked_path = str(Path(original_path).parent / f"{Path(original_path).stem}_temp_ducked.wav")

                ducker.duck_audio(
                    audio_to_duck=original_path,
                    trigger_audio=screen_info['path'],
                    output_path=temp_ducked_path,
                    threshold=threshold,
                    ratio=ratio,
                    attack=attack,
                    release=release
                )

                # Replace original processed file with ducked version
                shutil.move(temp_ducked_path, original_path)
                print(f"✓ Replaced {Path(original_path).name} with ducked version", file=sys.stderr)
            else:
                if not mic1_info:
                    print("⚠ mic1 (soundboard) audio not found - skipping mic1/screen ducking", file=sys.stderr)
                if not screen_info:
                    print("⚠ screen (soundboard) audio not found - skipping mic1/screen ducking", file=sys.stderr)