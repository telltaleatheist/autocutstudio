# core/compound_generators/dc_gs_generator.py

import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional
import uuid
import datetime

from ..xml_utils import FCPXMLUtils
from ..audio_processor import AudioProcessor

class DCGSGenerator:
    """Generate dc gs (dual camera game share) compound clips with dual camera multi-view layout."""
    
    def __init__(self, config):
        self.config = config
        self.audio_processor = AudioProcessor(config)
        self.xml_utils = FCPXMLUtils()

    def generate_dc_gs_compound(self, compound_xml_path: str, audio_sources: Dict[str, str],
                            output_path: Optional[str] = None,
                            apply_audio_sync: bool = False, video_sources: Optional[Dict[str, str]] = None) -> str:
        """Generate dc gs compound clip from existing compound clip XML.

        Args:
            compound_xml_path: Path to existing compound XML file
            audio_sources: Dictionary mapping audio types to file paths
            output_path: Optional custom output path
            apply_audio_sync: Whether to apply 29.97fps sync correction
            video_sources: Optional dictionary of video source paths (e.g., {'game': '/path/to/game.mp4'})
        """
        video_sources = video_sources or {}
        
        # Load the original compound clip XML
        tree = self.xml_utils.parse_fcpxml(compound_xml_path)
        root = tree.getroot()
        
        # Get video settings from config
        video_settings = self.config.video_settings
        layout_config = self.config.get_layout_config('gs', 'dual')
        
        if not layout_config:
            raise ValueError("No layout config found for gs.dual")
        
        # Process audio sources - ALL audio types for DC GS
        processed_audio_sources = {}
        for audio_type, audio_path in audio_sources.items():
            if audio_path and audio_type in ['mic1', 'mic2', 'mic3', 'mic4', 'screen', 'game', 'sound_effects', 'bluetooth']:
                try:
                    processed_path, duration, sample_rate, channels = \
                        self.audio_processor.process_audio_source(audio_path, apply_audio_sync)
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
        
        # Create new dc gs compound clip
        dc_gs_compound_id = "dc_gs_compound"
        dc_gs_name = f"{original_name} - DC GS"
        
        # Start building new XML structure
        new_root = ET.Element('fcpxml')
        new_root.set('version', '1.11')
        
        resources = ET.SubElement(new_root, 'resources')
        
        # Create format elements
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
            'r1_dc_gs', 
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
            'r1_dc_gs',
            has_audio=True,
            has_video=True
        )
        resources.append(original_video_asset)

        # Check if optional game video source is provided
        game_asset_id = None
        game_name = None
        if 'game' in video_sources and video_sources['game']:
            game_path = video_sources['game']
            game_asset_id = "r_game_video"
            game_name = Path(game_path).stem
            pass  # 0
            game_asset = self.xml_utils.create_asset_element(
                game_asset_id, game_name, game_path, original_duration,
                'r1_dc_gs', has_audio=False, has_video=True
            )
            resources.append(game_asset)

        # Check if optional cam1 video source is provided
        cam1_asset_id = None
        cam1_name = None
        if 'cam1' in video_sources and video_sources['cam1']:
            cam1_path = video_sources['cam1']
            cam1_asset_id = "r_cam1_video"
            cam1_name = Path(cam1_path).stem
            pass  # 0
            cam1_asset = self.xml_utils.create_asset_element(
                cam1_asset_id, cam1_name, cam1_path, original_duration,
                'r1_dc_gs', has_audio=False, has_video=True
            )
            resources.append(cam1_asset)

        # Check if optional cam2 video source is provided
        cam2_asset_id = None
        cam2_name = None
        if 'cam2' in video_sources and video_sources['cam2']:
            cam2_path = video_sources['cam2']
            cam2_asset_id = "r_cam2_video"
            cam2_name = Path(cam2_path).stem
            pass  # 0
            cam2_asset = self.xml_utils.create_asset_element(
                cam2_asset_id, cam2_name, cam2_path, original_duration,
                'r1_dc_gs', has_audio=False, has_video=True
            )
            resources.append(cam2_asset)

        # Check if optional screen video source is provided
        screen_asset_id = None
        screen_name = None
        if 'screen' in video_sources and video_sources['screen']:
            screen_path = video_sources['screen']
            screen_asset_id = "r_screen_video"
            screen_name = Path(screen_path).stem
            pass  # 0
            screen_asset = self.xml_utils.create_asset_element(
                screen_asset_id, screen_name, screen_path, original_duration,
                'r1_dc_gs', has_audio=False, has_video=True
            )
            resources.append(screen_asset)

        # Create dc gs compound media element
        dc_gs_media = self.xml_utils.create_media_compound(
            dc_gs_compound_id,
            dc_gs_name, 
            original_duration,
            'r1_dc_gs',
            video_settings
        )
        
        # Build the compound sequence with gap structure
        sequence = dc_gs_media.find('sequence')
        spine = ET.SubElement(sequence, 'spine')
        
        # Create the gap element that spans full duration of compound clip
        gap = self.xml_utils.create_gap_element(
            "Gap",
            "0s",
            original_duration
        )
        
        # Add audio tracks based on available sources
        audio_config = layout_config.get('audio', {})
        current_audio_lane = -2  # Start at lane -2 for first audio track
        
        # Add mic audio tracks in order (mic1, mic2, mic3, mic4)
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
                    enabled=False  # DISABLED for GS
                )
                gap.append(mic_clip)
                pass  # 0
                current_audio_lane -= 1
        
        # Add screen audio if present
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
        
        # Add game audio if present
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
        
        # Add sound effects if present
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
                enabled=False  # DISABLED for GS
            )
            gap.append(sfx_clip)
            pass  # 0
            current_audio_lane -= 1
        
        # Add master audio clip (disabled, for reference)
        master_audio_clip = self.xml_utils.create_audio_only_clip(
            original_name,
            original_asset_id,
            "-1",
            "0s",
            original_duration,
            enabled=False
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
                    'r1_dc_gs',
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
                        'position': [-36.481, 19.722],  # -394 / 10.8, 213 / 10.8
                        'scale': 0.563  # 56.3%
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
                screen_transforms
            )
            gap.append(screen_clip)

            # Add screen border - use gs_dc.top_left directly
            screen_border_path = self.config.get_border_path('gs_dc.top_left')

            if screen_border_path and screen_border_path != '':
                print(f"Adding screen border: {screen_border_path}")

                # Create border asset
                border_asset_id = "r_gs_dc_top_left_screen"
                border_asset = self.xml_utils.create_asset_element(
                    border_asset_id,
                    "gs dc top left - Screen",
                    screen_border_path,
                    original_duration,
                    'r1_dc_gs',
                    has_audio=False,
                    has_video=True
                )
                resources.append(border_asset)

                # Add border clip (lane 7)
                border_clip = self.xml_utils.create_video_clip(
                    "gs dc top left - Screen",
                    border_asset_id,
                    "7",
                    "0s",
                    original_duration,
                    None
                )
                gap.append(border_clip)
            else:
                print(f"Warning: Screen border path not found for gs_dc.top_left")
        
        # Add camera 1 video (bottom left)
        camera_config = layout_config.get('camera', {})
        if camera_config:
            # Determine which asset and transforms to use
            if cam1_asset_id:
                # Use individual cam1 video - NO CROPPING, only position/scale
                camera1_asset = cam1_asset_id
                camera1_name_for_clip = cam1_name
                camera_transforms = {
                    'crop': None,
                    'crop_mode': None,
                    'transform': {
                        'position': [-53.148, -29.074],  # -574 / 10.8, -314 / 10.8
                        'scale': 0.38  # 38%
                    }
                }
                pass  # 0
            else:
                # Use master video - WITH CROPPING
                camera1_asset = original_asset_id
                camera1_name_for_clip = f"{original_name} - Camera 1"
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
                camera1_name_for_clip,
                camera1_asset,
                "4",
                "0s",
                original_duration,
                camera_transforms
            )
            gap.append(camera_clip)
            
            # Add camera 1 border - use gs_dc.bottom_left directly
            camera_border_path = self.config.get_border_path('gs_dc.bottom_left')
            
            if camera_border_path and camera_border_path != '':
                # Create border asset
                border_asset_id = "r_gs_dc_bottom_left_camera"
                border_asset = self.xml_utils.create_asset_element(
                    border_asset_id,
                    "gs dc bottom left - Camera 1",
                    camera_border_path,
                    original_duration,
                    'r1_dc_gs',
                    has_audio=False,
                    has_video=True
                )
                resources.append(border_asset)
                
                # Add border clip (lane 5)
                border_clip = self.xml_utils.create_video_clip(
                    "gs dc bottom left - Camera 1",
                    border_asset_id,
                    "5",
                    "0s",
                    original_duration,
                    None
                )
                gap.append(border_clip)
        
        # Add game video (bottom right) - cropped from master using exact template values
        game_config = layout_config.get('game', {})
        if game_config:
            # Determine which asset and transforms to use
            if game_asset_id:
                # Use individual game video - NO CROPPING
                game_video_asset = game_asset_id
                game_name_for_clip = game_name
                game_transforms = {
                    'crop': None,
                    'crop_mode': None,
                    'transform': {
                        'position': [34.537, -18.75],  # 373 / 10.8, -202.5 / 10.8
                        'scale': 0.5843  # 58.43%
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
                "2",
                "0s",
                original_duration,
                game_transforms
            )
            gap.append(game_clip)

            # Add game border - use gs_dc.bottom_right directly
            game_border_path = self.config.get_border_path('gs_dc.bottom_right')

            if game_border_path and game_border_path != '':
                # Create border asset
                border_asset_id = "r_gs_dc_bottom_right_game"
                border_asset = self.xml_utils.create_asset_element(
                    border_asset_id,
                    "gs dc bottom right - Game",
                    game_border_path,
                    original_duration,
                    'r1_dc_gs',
                    has_audio=False,
                    has_video=True
                )
                resources.append(border_asset)

                # Add border clip (lane 3)
                border_clip = self.xml_utils.create_video_clip(
                    "gs dc bottom right - Game",
                    border_asset_id,
                    "3",
                    "0s",
                    original_duration,
                    None
                )
                gap.append(border_clip)
        
        # Add camera 2 video (top right)
        cam2_config = layout_config.get('cam2', {})
        if cam2_config:
            # Determine which asset and transforms to use
            if cam2_asset_id:
                # Use individual cam2 video - NO CROPPING, only position/scale
                camera2_asset = cam2_asset_id
                camera2_name_for_clip = cam2_name
                cam2_transforms = {
                    'crop': None,
                    'crop_mode': None,
                    'transform': {
                        'position': [47.407, 30],  # 512 / 10.8, 324 / 10.8
                        'scale': 0.358  # 35.8%
                    }
                }
                pass  # 0
            else:
                # Use master video - WITH CROPPING
                camera2_asset = original_asset_id
                camera2_name_for_clip = f"{original_name} - Camera 2"
                cam2_transforms = {
                    'crop': [91.0021, 1.30642, 2.11625, 51.5982],
                    'crop_mode': 'trim',
                    'transform': {
                        'position': [13.8642, 11.07],
                        'scale': 0.755554
                    }
                }
                pass  # 0

            cam2_clip = self.xml_utils.create_video_clip(
                camera2_name_for_clip,
                camera2_asset,
                "8",
                "0s",
                original_duration,
                cam2_transforms
            )
            gap.append(cam2_clip)
            
            # Add camera 2 border - use gs_dc.top_right directly
            cam2_border_path = self.config.get_border_path('gs_dc.top_right')
            
            if cam2_border_path and cam2_border_path != '':
                # Create border asset
                border_asset_id = "r_gs_dc_top_right_cam2"
                border_asset = self.xml_utils.create_asset_element(
                    border_asset_id,
                    "gs dc top right - Camera 2",
                    cam2_border_path,
                    original_duration,
                    'r1_dc_gs',
                    has_audio=False,
                    has_video=True
                )
                resources.append(border_asset)
                
                # Add border clip (lane 9)
                border_clip = self.xml_utils.create_video_clip(
                    "gs dc top right - Camera 2",
                    border_asset_id,
                    "9",
                    "0s",
                    original_duration,
                    None
                )
                gap.append(border_clip)
        
        spine.append(gap)
        resources.append(dc_gs_media)
        
        # Create library and project structure
        library = ET.SubElement(new_root, 'library')
        event = ET.SubElement(library, 'event')
        event.set('name', 'Auto-Editor Media Group')
        
        project = ET.SubElement(event, 'project')
        project.set('name', f"{original_name} - DC GS Edit")
        
        # Create main timeline with the cut structure referencing the dc gs compound
        original_format_id = "r1"
        main_sequence = ET.SubElement(project, 'sequence')
        main_sequence.set('format', original_format_id)
        main_sequence.set('tcStart', '0s')
        main_sequence.set('tcFormat', video_settings.get('tcFormat', 'NDF'))
        main_sequence.set('audioLayout', video_settings.get('audioLayout', 'stereo'))
        main_sequence.set('audioRate', video_settings.get('audioRate', '48k'))
        
        main_spine = ET.SubElement(main_sequence, 'spine')
        
        # Add ref-clips for each cut, referencing the dc gs compound
        main_timeline_frame_duration = original_format.get('frameDuration', '1/30s') if original_format is not None else '1/30s'

        # Track expected offset to ensure continuity (no gaps/overlaps)
        expected_offset = "0s"

        for i, cut in enumerate(cuts):
            ref_clip = ET.SubElement(main_spine, 'ref-clip')
            ref_clip.set('ref', dc_gs_compound_id)
            ref_clip.set('name', dc_gs_name)

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
            output_path = input_path.parent / f"{input_path.stem}_DC_GS.fcpxml"
        
        new_tree = ET.ElementTree(new_root)
        self.xml_utils.save_fcpxml(new_tree, output_path)
        
        print(f"DC GS compound clip created: {output_path}")
        return str(output_path)
        
    @classmethod
    def handle_generate_dc_gs(cls, args, config):
        """Handle generate-dc-gs command from CLI."""
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

            # Create DC GS generator
            dc_gs_generator = cls(config)

            # Generate DC GS compound clip
            output_path = dc_gs_generator.generate_dc_gs_compound(
                str(compound_path),
                audio_sources,
                args.output,
                args.sync_audio
            )

            print(f"Success! DC GS compound clip generated: {output_path}")
            print("\nNext steps:")
            print("1. Import the XML file into Final Cut Pro X")
            print("2. The DC GS compound clip will be available in your event")
            print("3. Use the main timeline to switch between cuts")

            return 0

        except Exception as e:
            print(f"Error generating DC GS compound clip: {e}")
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