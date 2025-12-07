# core/compound_generators/shorts_cam_generator.py

import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional
import uuid
import datetime

from ..xml_utils import FCPXMLUtils
from ..audio_processor import AudioProcessor

class ShortsCamGenerator:
    """Generate shorts cam compound clips (vertical 9:16) with proper gap structure and audio integration."""

    def __init__(self, config):
        self.config = config
        self.audio_processor = AudioProcessor(config)
        self.xml_utils = FCPXMLUtils()

    def generate_shorts_cam_compound(self, compound_xml_path: str, audio_sources: Dict[str, str],
                            mode: str = "solo", output_path: Optional[str] = None,
                            apply_audio_sync: bool = False, video_sources: Optional[Dict[str, str]] = None,
                            use_downloaded_stream: bool = False) -> str:
        """Generate shorts cam compound clip (vertical 9:16) from existing compound clip XML.

        Args:
            compound_xml_path: Path to existing compound XML file
            audio_sources: Dictionary mapping audio types to file paths (e.g., {'mic1': '/path/to/mic.mp3', 'soundEffects': '/path/to/sfx.wav'})
            mode: Layout mode ('solo' or 'dual')
            output_path: Optional custom output path
            apply_audio_sync: Whether to apply 29.97fps sync correction
            video_sources: Optional dictionary of video source paths (e.g., {'cam1': '/path/to/cam.mp4'})
            use_downloaded_stream: Whether to use stream recovery transforms for downloaded stream masters
        """
        video_sources = video_sources or {}
        
        # Load the original compound clip XML
        tree = self.xml_utils.parse_fcpxml(compound_xml_path)
        root = tree.getroot()
        
        # Get video settings from config (vertical shorts format)
        video_settings = self.config.video_shorts_settings
        layout_config = self.config.get_layout_config('shorts_cam', mode)
        
        if not layout_config:
            raise ValueError(f"No layout config found for shorts_cam.{mode}")
        
        # Process audio sources - handle all mic types and sound effects
        processed_audio_sources = {}
        audio_sources_config = layout_config.get('audio_sources', ['mic1', 'mic2', 'mic3', 'mic4', 'soundEffects'])
        
        for audio_type in audio_sources_config:
            if audio_type in audio_sources and audio_sources[audio_type]:
                try:
                    processed_path, duration, sample_rate, channels = \
                        self.audio_processor.process_audio_source(audio_sources[audio_type], apply_audio_sync, audio_type=audio_type)
                    processed_audio_sources[audio_type] = {
                        'path': processed_path,
                        'duration': duration,
                        'sample_rate': sample_rate,
                        'channels': channels
                    }
                    print(f"Processed {audio_type} audio: {processed_path}")
                except Exception as e:
                    print(f"Warning: Failed to process {audio_type} audio ({audio_sources[audio_type]}): {e}")
                    processed_audio_sources[audio_type] = None
        
        if not processed_audio_sources:
            print("Warning: No audio sources were successfully processed")
        
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
        
        # Create new shorts cam compound clip
        # Use dc_ prefix for dual mode so hybrid generator can find it
        cam_compound_id = "dc_shorts_cam_compound" if mode == "dual" else "shorts_cam_compound"
        mode_label = "DC Shorts Cam" if mode == "dual" else "Shorts Cam"
        cam_name = f"{original_name} - {mode_label}"
        
        # Start building new XML structure
        new_root = ET.Element('fcpxml')
        new_root.set('version', '1.11')
        
        resources = ET.SubElement(new_root, 'resources')

        # Add effect resources for audio effects (Compressor and Noise Gate)
        # These must be added to resources BEFORE they're referenced in audio clips
        compressor_effect = ET.SubElement(resources, 'effect')
        compressor_effect.set('id', 'r4')
        compressor_effect.set('name', 'Compressor')
        compressor_effect.set('uid', 'AudioUnit: 0x617566780000009a454d4147')

        noise_gate_effect = ET.SubElement(resources, 'effect')
        noise_gate_effect.set('id', 'r5')
        noise_gate_effect.set('name', 'Noise Gate')
        noise_gate_effect.set('uid', 'AudioUnit: 0x61756678000000b3454d4147')

        pass  # 0

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
        
        # Compound clip format (for internal compound structure - vertical shorts)
        video_format = self.xml_utils.create_format_element(
            'r1_shorts_cam',
            video_settings.get('frame_duration', '1001/30000s'),
            video_settings.get('width', 1080),
            video_settings.get('height', 1920),
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
        
        # Create original video asset (for master audio and video reference)
        original_asset_id = "r_original_video"
        original_video_asset = self.xml_utils.create_asset_element(
            original_asset_id,
            original_name,
            original_src.replace('file://', ''),
            original_duration,
            'r1_shorts_cam',
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

            # cam1 is recorded with master, so NO retiming needed - it's already synced
            print(f"  cam1 video: using native timing (recorded with master, no retiming)")

            # Create asset for the cam1 video
            cam1_asset = self.xml_utils.create_asset_element(
                cam1_asset_id,
                cam1_name,
                cam1_path,
                original_duration,  # Use same duration as master
                'r1_shorts_cam',
                has_audio=False,  # Don't use audio from cam1 video
                has_video=True
            )
            resources.append(cam1_asset)

        # Create shorts cam compound media element
        cam_media = self.xml_utils.create_media_compound(
            cam_compound_id,
            cam_name,
            original_duration,  # Use full original duration for compound
            'r1_shorts_cam',
            video_settings
        )
        
        # Build the compound sequence with gap structure
        sequence = cam_media.find('sequence')
        spine = ET.SubElement(sequence, 'spine')
        
        # Create the gap element that spans full duration of compound clip
        gap_config = layout_config.get('gap', {})
        gap = self.xml_utils.create_gap_element(
            gap_config.get('name', 'Gap'),
            "0s",  # Always start at beginning
            original_duration  # Span full duration of master clip
        )
        
        # Add master audio clip FIRST at lane -1
        # Enable master audio if no external audio sources provided (master-only mode)
        enable_master_audio = len(audio_sources) == 0
        if enable_master_audio:
            print("  Master-only mode: enabling master audio in CAM compound")
        master_audio_clip = self.xml_utils.create_audio_only_clip(
            original_name,
            original_asset_id,
            "-1",  # Always lane -1
            "0s",  # Start at beginning of gap
            original_duration,
            enabled=enable_master_audio  # Enable if no external audio sources
        )
        gap.append(master_audio_clip)

        # Add audio sources to gap structure (negative lanes starting at -2)
        audio_lane = -2  # Start with lane -2 for first audio source (below master at -1)

        for audio_type in audio_sources_config:
            if audio_type in audio_assets:
                audio_info = processed_audio_sources[audio_type]
                audio_clip = self.xml_utils.create_clip_with_audio_effects(
                    Path(audio_info['path']).stem,
                    audio_assets[audio_type],
                    str(audio_lane),
                    "0s",
                    audio_info['duration'],
                    audio_type,
                    resources,
                    enabled=True,
                    channels=audio_info['channels']
                )
                gap.append(audio_clip)
                pass  # 0
                audio_lane -= 1  # Move to next audio lane
        
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
                    'r1_shorts_cam',
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
        
        # Add camera video with transforms - handle both solo and dual modes
        camera_config = layout_config.get('camera', {})  # Solo mode
        cam1_config = layout_config.get('cam1', {})  # Dual mode
        cam2_config = layout_config.get('cam2', {})  # Dual mode

        if camera_config:
            # SOLO MODE - single camera
            if cam1_asset_id:
                camera_asset = cam1_asset_id
                camera_name_for_clip = cam1_name
                transforms = None
            elif use_downloaded_stream:
                camera_asset = original_asset_id
                camera_name_for_clip = original_name
                print("  Stream recovery mode: using stream layout transforms for CAM")
                transforms = {
                    'crop': [2.59421, 60.72, 108.595, 2.63889],
                    'crop_mode': 'trim',
                    'transform': {
                        'position': [145.098, 79.4729],
                        'scale': 2.7345
                    }
                }
            else:
                camera_asset = original_asset_id
                camera_name_for_clip = original_name
                transforms = {
                    'crop': camera_config.get('crop', [0, 50.0412, 88.8889, 0]),
                    'crop_mode': 'trim',
                    'transform': {
                        'position': camera_config.get('position', [89.2019, 50.291]),
                        'scale': camera_config.get('scale', 6.3576)
                    }
                }

            video_lane = str(camera_config.get('lane', 1))
            camera_clip = self.xml_utils.create_video_clip(
                camera_name_for_clip,
                camera_asset,
                video_lane,
                "0s",
                original_duration,
                transforms,
                retime_map=None
            )
            gap.append(camera_clip)

        elif cam1_config:
            # DUAL MODE - three cameras: solo cam (lane 1) + DC cam1 (lane 2) + DC cam2 (lane 3)
            # This structure allows hybrid compounds to disable DC layers and show solo cam underneath

            # Get solo camera config for the base layer
            solo_layout = self.config.get_layout_config('shorts_cam', 'solo')
            solo_camera_config = solo_layout.get('camera', {})

            # LANE 1: Add solo cam video (full screen, always enabled but covered by DC layers when active)
            if use_downloaded_stream:
                solo_asset = original_asset_id
                solo_name_for_clip = f"{original_name} - Solo Cam"
                print("  Stream recovery mode: using stream layout transforms for SOLO CAM")
                solo_transforms = {
                    'crop': [2.59421, 60.72, 108.595, 2.63889],
                    'crop_mode': 'trim',
                    'transform': {
                        'position': [145.098, 79.4729],
                        'scale': 2.7345
                    }
                }
            else:
                solo_asset = original_asset_id
                solo_name_for_clip = f"{original_name} - Solo Cam"
                solo_transforms = {
                    'crop': solo_camera_config.get('crop', [0, 50.0412, 88.8889, 0]),
                    'crop_mode': 'trim',
                    'transform': {
                        'position': solo_camera_config.get('position', [89.2019, 50.291]),
                        'scale': solo_camera_config.get('scale', 6.3576)
                    }
                }

            solo_clip = self.xml_utils.create_video_clip(
                solo_name_for_clip,
                solo_asset,
                "1",  # Lane 1 - base layer
                "0s",
                original_duration,
                solo_transforms,
                retime_map=None
            )
            gap.append(solo_clip)

            # LANE 2: Add DC cam1 video
            if use_downloaded_stream:
                cam1_asset = original_asset_id
                cam1_name_for_clip = f"{original_name} - DC Cam1"
                print("  Stream recovery mode: using stream layout transforms for DC CAM1")
                cam1_transforms = {
                    'crop': [2.59421, 60.72, 108.595, 2.63889],
                    'crop_mode': 'trim',
                    'transform': {
                        'position': cam1_config.get('position', [46.1833, -0.103782]),
                        'scale': cam1_config.get('scale', 3.2)
                    }
                }
            else:
                cam1_asset = original_asset_id
                cam1_name_for_clip = f"{original_name} - DC Cam1"
                cam1_transforms = {
                    'crop': cam1_config.get('crop', [0, 50.0412, 88.8889, 0]),
                    'crop_mode': 'trim',
                    'transform': {
                        'position': cam1_config.get('position', [46.1833, -0.103782]),
                        'scale': cam1_config.get('scale', 3.2)
                    }
                }

            cam1_clip = self.xml_utils.create_video_clip(
                cam1_name_for_clip,
                cam1_asset,
                "2",  # Lane 2 - DC bottom cam
                "0s",
                original_duration,
                cam1_transforms,
                retime_map=None
            )
            gap.append(cam1_clip)

            # LANE 3: Add DC cam2 video
            if cam2_config:
                if use_downloaded_stream:
                    cam2_asset = original_asset_id
                    cam2_name_for_clip = f"{original_name} - DC Cam2"
                    print("  Stream recovery mode: using stream layout transforms for DC CAM2")
                    cam2_transforms = {
                        'crop': [88.8889, 0, 0, 50.0412],
                        'crop_mode': 'trim',
                        'transform': {
                            'position': cam2_config.get('position', [-43.1878, -0.498011]),
                            'scale': cam2_config.get('scale', 3.2)
                        }
                    }
                else:
                    cam2_asset = original_asset_id
                    cam2_name_for_clip = f"{original_name} - DC Cam2"
                    cam2_transforms = {
                        'crop': cam2_config.get('crop', [88.8889, 0, 0, 50.0412]),
                        'crop_mode': 'trim',
                        'transform': {
                            'position': cam2_config.get('position', [-43.1878, -0.498011]),
                            'scale': cam2_config.get('scale', 3.2)
                        }
                    }

                cam2_clip = self.xml_utils.create_video_clip(
                    cam2_name_for_clip,
                    cam2_asset,
                    "3",  # Lane 3 - DC top cam
                    "0s",
                    original_duration,
                    cam2_transforms,
                    retime_map=None
                )
                gap.append(cam2_clip)

        spine.append(gap)
        resources.append(cam_media)
        
        # Create library and project structure
        library = ET.SubElement(new_root, 'library')
        event = ET.SubElement(library, 'event')
        event.set('name', 'Auto-Editor Media Group')
        
        project = ET.SubElement(event, 'project')
        project.set('name', f"{original_name} - Shorts Cam Edit")
        
        # Create main timeline with the cut structure referencing the cam compound
        # Use the same format as the original cuts to maintain consistency
        original_format_id = "r1"  # Use the original auto-editor format for the main timeline
        main_sequence = ET.SubElement(project, 'sequence')
        main_sequence.set('format', original_format_id)  # Match original cuts format
        main_sequence.set('tcStart', '0s')
        main_sequence.set('tcFormat', video_settings.get('tcFormat', 'NDF'))
        main_sequence.set('audioLayout', video_settings.get('audioLayout', 'stereo'))
        main_sequence.set('audioRate', video_settings.get('audioRate', '48k'))
        
        main_spine = ET.SubElement(main_sequence, 'spine')
        
        # Add ref-clips for each cut, referencing the cam compound
        # Ensure all timecodes are snapped to frame boundaries like original program
        # Use the main timeline's frame duration, not the compound clip's
        main_timeline_frame_duration = original_format.get('frameDuration', '1/30s') if original_format is not None else '1/30s'

        # Track expected offset to ensure continuity (no gaps/overlaps)
        expected_offset = "0s"

        for i, cut in enumerate(cuts):
            ref_clip = ET.SubElement(main_spine, 'ref-clip')
            ref_clip.set('ref', cam_compound_id)
            ref_clip.set('name', cam_name)

            # Snap duration and start to frame boundaries
            snapped_duration = self._snap_to_frame_boundary(cut['duration'], main_timeline_frame_duration)
            snapped_start = self._snap_to_frame_boundary(cut['start'], main_timeline_frame_duration)

            # Use expected_offset to ensure continuity (no gaps between clips)
            # Only snap the first clip's offset; subsequent clips follow from previous end
            if i == 0:
                snapped_offset = self._snap_to_frame_boundary(cut['offset'], main_timeline_frame_duration)
                expected_offset = snapped_offset
            else:
                snapped_offset = expected_offset

            ref_clip.set('offset', snapped_offset)
            ref_clip.set('duration', snapped_duration)
            ref_clip.set('start', snapped_start)

            # Calculate next expected offset (current offset + duration)
            expected_offset = self._add_time_fractions(snapped_offset, snapped_duration)
        
        # Save the new XML
        if output_path is None:
            input_path = Path(compound_xml_path)
            suffix = "_DC_SHORTS_CAM.fcpxml" if mode == "dual" else "_SHORTS_CAM.fcpxml"
            output_path = input_path.parent / f"{input_path.stem}{suffix}"
        
        new_tree = ET.ElementTree(new_root)
        self.xml_utils.save_fcpxml(new_tree, output_path)

        print(f"Shorts Cam compound clip created: {output_path}")
        return str(output_path)

    @classmethod
    def handle_generate_shorts_cam(cls, args, config):
        """Handle generate-shorts-cam command from CLI."""
        try:
            # Validate compound path
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
            
            if args.soundEffects:
                sfx_path = Path(args.soundEffects)
                if sfx_path.exists():
                    audio_sources['soundEffects'] = str(sfx_path)
                    pass  # 0
                else:
                    print(f"Warning: Sound effects file not found: {sfx_path}")
            
            if not audio_sources:
                print("Error: At least one audio source is required")
                return 1
            
            print(f"Processing audio sources: {list(audio_sources.keys())}")

            # Create shorts cam generator
            cam_generator = cls(config)

            # Generate shorts cam compound clip
            output_path = cam_generator.generate_shorts_cam_compound(
                str(compound_path),
                audio_sources,
                args.mode,
                args.output,
                args.sync_audio
            )

            print(f"Success! Shorts Cam compound clip generated: {output_path}")
            print("\nNext steps:")
            print("1. Import the XML file into Final Cut Pro X")
            print("2. The shorts cam compound clip will be available in your event")
            print("3. Use the main timeline to switch between cuts")
            
            return 0


        except Exception as e:
            print(f"Error generating shorts cam compound clip: {e}")
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

        # Add fractions: a/b + c/d
        if den1 == den2:
            # Same denominator - easy
            result_num = num1 + num2
            result_den = den1
        else:
            # Different denominators - find common
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