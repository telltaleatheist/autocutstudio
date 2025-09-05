# core/compound_generators/dc_cam_generator.py

import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional
import uuid
import datetime

from ..xml_utils import FCPXMLUtils
from ..audio_processor import AudioProcessor

class DCCamGenerator:
    """Generate dc cam (dual camera) compound clips with dual camera layout."""
    
    def __init__(self, config):
        self.config = config
        self.audio_processor = AudioProcessor(config)
        self.xml_utils = FCPXMLUtils()
    
    def generate_dc_cam_compound(self, compound_xml_path: str, audio_sources: Dict[str, str],
                                output_path: Optional[str] = None,
                                apply_audio_sync: bool = False) -> str:
        """Generate dc cam compound clip from existing compound clip XML.
        
        Args:
            compound_xml_path: Path to existing compound XML file
            audio_sources: Dictionary mapping audio types to file paths (e.g., {'mic1': '/path/to/mic.mp3'})
            output_path: Optional custom output path
            apply_audio_sync: Whether to apply 29.97fps sync correction
        """
        
        # Load the original compound clip XML
        tree = self.xml_utils.parse_fcpxml(compound_xml_path)
        root = tree.getroot()
        
        # Get video settings from config
        video_settings = self.config.video_settings
        layout_config = self.config.get_layout_config('cam', 'dual')
        
        if not layout_config:
            raise ValueError("No layout config found for cam.dual")
        
        # Process audio sources
        processed_audio_sources = {}
        for audio_type, audio_path in audio_sources.items():
            if audio_path and audio_type in ['mic1', 'mic2', 'mic3', 'mic4', 'sound_effects']:
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
        
        # Create new dc cam compound clip
        dc_cam_compound_id = "dc_cam_compound"
        dc_cam_name = f"{original_name} - DC Cam"
        
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
            'r1_dc_cam', 
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
        
        # Create original video asset (for master audio and video reference)
        original_asset_id = "r_original_video"
        original_video_asset = self.xml_utils.create_asset_element(
            original_asset_id,
            original_name,
            original_src.replace('file://', ''),
            original_duration,
            'r1_dc_cam',
            has_audio=True,
            has_video=True
        )
        resources.append(original_video_asset)
        
        # Create dc cam compound media element
        dc_cam_media = self.xml_utils.create_media_compound(
            dc_cam_compound_id,
            dc_cam_name, 
            original_duration,  # Use full original duration for compound
            'r1_dc_cam',
            video_settings
        )
        
        # Build the compound sequence with gap structure
        sequence = dc_cam_media.find('sequence')
        spine = ET.SubElement(sequence, 'spine')
        
        # Create the gap element that spans full duration of compound clip
        gap = self.xml_utils.create_gap_element(
            "Gap",
            "0s",  # Always start at beginning
            original_duration  # Span full duration of master clip
        )
        
        # Add audio tracks based on available sources
        audio_config = layout_config.get('audio', {})
        current_audio_lane = -2  # Start at lane -2 for first audio track
        
        # Add mic audio tracks in order (mic1, mic2, mic3, mic4)
        for mic_num in range(1, 5):
            mic_key = f'mic{mic_num}'
            if mic_key in audio_assets:
                audio_info = processed_audio_sources[mic_key]
                mic_clip = self.xml_utils.create_asset_clip(
                    Path(audio_info['path']).stem,
                    audio_assets[mic_key],
                    str(current_audio_lane),
                    "0s",
                    audio_info['duration'],
                    'r_audio_format',
                    'dialogue'
                )
                gap.append(mic_clip)
                print(f"Added {mic_key} to lane {current_audio_lane}")
                current_audio_lane -= 1  # Move to next lane down
        
        # Add sound effects if present
        if 'sound_effects' in audio_assets:
            audio_info = processed_audio_sources['sound_effects']
            sfx_clip = self.xml_utils.create_asset_clip(
                Path(audio_info['path']).stem,
                audio_assets['sound_effects'],
                str(current_audio_lane),
                "0s",
                audio_info['duration'],
                'r_audio_format',
                'effects'
            )
            gap.append(sfx_clip)
            print(f"Added sound_effects to lane {current_audio_lane}")
            current_audio_lane -= 1
        
        # Add master audio clip (disabled, for reference)
        master_audio_clip = self.xml_utils.create_audio_only_clip(
            original_name,
            original_asset_id,
            str(audio_config.get('master_lane', -1)),
            "0s",  # Start at beginning of gap
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
                    'r1_dc_cam',
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
        
        # Add camera 1 video (top left) - cropped from master using exact template values
        cam1_config = layout_config.get('cam1', {})
        if cam1_config:
            # Use exact transforms from dc cam template (lane 2)
            cam1_transforms = {
                'crop': [2.50097, 51.3552, 91.2482, 1.46395],
                'crop_mode': 'trim',
                'transform': {
                    'position': [20.3319, 49.6649],
                    'scale': 1.23811
                }
            }
            
            cam1_clip = self.xml_utils.create_video_clip(
                f"{original_name} - Camera 1",
                original_asset_id,
                "2",  # Lane 2 to match template
                "0s",
                original_duration,
                cam1_transforms
            )
            gap.append(cam1_clip)
            
            # Add camera 1 border if specified (lane 3 - immediately above camera 1)
            if 'border' in cam1_config:
                border_asset_key = cam1_config['border']
                border_path = self.config.get_border_path(border_asset_key)
                
                if border_path and border_path != '':
                    # Create border asset
                    border_asset_id = f"r_{border_asset_key.replace('.', '_')}_cam1"
                    border_asset = self.xml_utils.create_asset_element(
                        border_asset_id,
                        f"{border_asset_key} - Camera 1",
                        border_path,
                        original_duration,
                        'r1_dc_cam',
                        has_audio=False,
                        has_video=True
                    )
                    resources.append(border_asset)
                    
                    # Add border clip (lane 3)
                    border_clip = self.xml_utils.create_video_clip(
                        f"{border_asset_key} - Camera 1",
                        border_asset_id,
                        "3",  # Lane 3 - right above camera 1 (lane 2)
                        "0s",
                        original_duration,
                        None  # No transforms - border should be full-screen overlay
                    )
                    gap.append(border_clip)
        
        # Add camera 2 video (bottom right) - cropped from master using exact template values
        cam2_config = layout_config.get('cam2', {})
        if cam2_config:
            # Use exact transforms from dc cam template (lane 4)
            cam2_transforms = {
                'crop': [91.1111, 1.48148, 2.59259, 51.4815],
                'crop_mode': 'trim',
                'transform': {
                    'position': [-20.3584, -49.8879],
                    'scale': 1.243
                }
            }
            
            cam2_clip = self.xml_utils.create_video_clip(
                f"{original_name} - Camera 2",
                original_asset_id,
                "4",  # Lane 4 to match template
                "0s",
                original_duration,
                cam2_transforms
            )
            gap.append(cam2_clip)
            
            # Add camera 2 border if specified (lane 5 - immediately above camera 2)
            if 'border' in cam2_config:
                border_asset_key = cam2_config['border']
                border_path = self.config.get_border_path(border_asset_key)
                
                if border_path and border_path != '':
                    # Create border asset
                    border_asset_id = f"r_{border_asset_key.replace('.', '_')}_cam2"
                    border_asset = self.xml_utils.create_asset_element(
                        border_asset_id,
                        f"{border_asset_key} - Camera 2",
                        border_path,
                        original_duration,
                        'r1_dc_cam',
                        has_audio=False,
                        has_video=True
                    )
                    resources.append(border_asset)
                    
                    # Add border clip (lane 5)
                    border_clip = self.xml_utils.create_video_clip(
                        f"{border_asset_key} - Camera 2",
                        border_asset_id,
                        "5",  # Lane 5 - right above camera 2 (lane 4)
                        "0s",
                        original_duration,
                        None  # No transforms - border should be full-screen overlay
                    )
                    gap.append(border_clip)
        
        spine.append(gap)
        resources.append(dc_cam_media)
        
        # Create library and project structure
        library = ET.SubElement(new_root, 'library')
        event = ET.SubElement(library, 'event')
        event.set('name', 'Auto-Editor Media Group')
        
        project = ET.SubElement(event, 'project')
        project.set('name', f"{original_name} - DC Cam Edit")
        
        # Create main timeline with the cut structure referencing the dc cam compound
        original_format_id = "r1"  # Use the original auto-editor format for the main timeline
        main_sequence = ET.SubElement(project, 'sequence')
        main_sequence.set('format', original_format_id)  # Match original cuts format
        main_sequence.set('tcStart', '0s')
        main_sequence.set('tcFormat', video_settings.get('tcFormat', 'NDF'))
        main_sequence.set('audioLayout', video_settings.get('audioLayout', 'stereo'))
        main_sequence.set('audioRate', video_settings.get('audioRate', '48k'))
        
        main_spine = ET.SubElement(main_sequence, 'spine')
        
        # Add ref-clips for each cut, referencing the dc cam compound
        main_timeline_frame_duration = original_format.get('frameDuration', '1/30s') if original_format is not None else '1/30s'
        
        for cut in cuts:
            ref_clip = ET.SubElement(main_spine, 'ref-clip')
            ref_clip.set('ref', dc_cam_compound_id)
            ref_clip.set('name', dc_cam_name)
            
            # Snap all timecodes to frame boundaries using main timeline frame duration
            snapped_offset = self._snap_to_frame_boundary(cut['offset'], main_timeline_frame_duration)
            snapped_duration = self._snap_to_frame_boundary(cut['duration'], main_timeline_frame_duration)  
            snapped_start = self._snap_to_frame_boundary(cut['start'], main_timeline_frame_duration)
            
            ref_clip.set('offset', snapped_offset)
            ref_clip.set('duration', snapped_duration)
            ref_clip.set('start', snapped_start)
        
        # Save the new XML
        if output_path is None:
            input_path = Path(compound_xml_path)
            output_path = input_path.parent / f"{input_path.stem}_DC_CAM.fcpxml"
        
        new_tree = ET.ElementTree(new_root)
        self.xml_utils.save_fcpxml(new_tree, output_path)
        
        print(f"DC Cam compound clip created: {output_path}")
        return str(output_path)
    
    @classmethod
    def handle_generate_dc_cam(cls, args, config):
        """Handle generate-dc-cam command from CLI."""
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
                    print(f"Using mic1 audio: {mic_path}")
                else:
                    print(f"Error: Mic1 audio file not found: {mic_path}")
                    return 1
            
            if args.mic2_audio:
                mic2_path = Path(args.mic2_audio)
                if mic2_path.exists():
                    audio_sources['mic2'] = str(mic2_path)
                    print(f"Using mic2 audio: {mic2_path}")
                else:
                    print(f"Warning: Mic2 audio file not found: {mic2_path}")
            
            if args.mic3_audio:
                mic3_path = Path(args.mic3_audio)
                if mic3_path.exists():
                    audio_sources['mic3'] = str(mic3_path)
                    print(f"Using mic3 audio: {mic3_path}")
                else:
                    print(f"Warning: Mic3 audio file not found: {mic3_path}")
            
            if args.mic4_audio:
                mic4_path = Path(args.mic4_audio)
                if mic4_path.exists():
                    audio_sources['mic4'] = str(mic4_path)
                    print(f"Using mic4 audio: {mic4_path}")
                else:
                    print(f"Warning: Mic4 audio file not found: {mic4_path}")
            
            if args.sound_effects:
                sfx_path = Path(args.sound_effects)
                if sfx_path.exists():
                    audio_sources['sound_effects'] = str(sfx_path)
                    print(f"Using sound effects: {sfx_path}")
                else:
                    print(f"Warning: Sound effects file not found: {sfx_path}")
            
            if not audio_sources:
                print("Error: At least one audio source is required")
                return 1
            
            print(f"Processing audio sources: {list(audio_sources.keys())}")
            
            # Create DC Cam generator
            dc_cam_generator = cls(config)
            
            # Generate DC Cam compound clip
            output_path = dc_cam_generator.generate_dc_cam_compound(
                str(compound_path),
                audio_sources,
                args.output,
                args.sync_audio
            )
            
            print(f"Success! DC Cam compound clip generated: {output_path}")
            print("\nNext steps:")
            print("1. Import the XML file into Final Cut Pro X")
            print("2. The DC Cam compound clip will be available in your event")
            print("3. Use the main timeline to switch between cuts")
            
            return 0
            
        except Exception as e:
            print(f"Error generating DC Cam compound clip: {e}")
            return 1
                        
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
        
        # Convert both to common denominator
        if time_den != frame_den:
            # Find LCM or use larger denominator
            common_den = max(time_den, frame_den)
            time_num = time_num * common_den // time_den
            frame_num = frame_num * common_den // frame_den
            time_den = common_den
            frame_den = common_den
        
        # Round to nearest frame
        frames = round(time_num / frame_num)
        snapped_time = frames * frame_num
        
        return f"{snapped_time}/{time_den}s"