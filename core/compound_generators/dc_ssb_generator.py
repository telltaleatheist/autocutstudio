# core/compound-generators/dc-ssb-generator.py

import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional
import uuid
import datetime

from urllib.parse import unquote
from ..xml_utils import FCPXMLUtils
from ..audio_processor import AudioProcessor

class DCSSBGenerator:
    """Generate dc ssb (dual camera screen share big) compound clips with dual camera and large screen layout."""
    
    def __init__(self, config):
        self.config = config
        self.audio_processor = AudioProcessor(config)
        self.xml_utils = FCPXMLUtils()
    
    def generate_dc_ssb_compound(self, compound_xml_path: str, audio_sources: Dict[str, str],
                                output_path: Optional[str] = None,
                                apply_audio_sync: bool = False, video_sources: Optional[Dict[str, str]] = None,
                                use_downloaded_stream: bool = False,
                                video_offsets: Optional[Dict[str, float]] = None,
                                video_drift_factors: Optional[Dict[str, float]] = None) -> str:
        """Generate dc ssb compound clip from existing compound clip XML.

        Args:
            compound_xml_path: Path to existing compound XML file
            audio_sources: Dictionary mapping audio types to file paths (e.g., {'screen': '/path/to/screen.mp3'})
            output_path: Optional custom output path
            apply_audio_sync: Whether to apply 29.97fps sync correction
            video_sources: Optional dictionary of video source paths (e.g., {'cam1': '/path/to/cam.mp4', 'cam2': '/path/to/cam2.mp4', 'screen': '/path/to/screen.mp4'})
            use_downloaded_stream: Whether to use stream recovery transforms for downloaded stream masters
            video_offsets: Optional per-source video alignment delays (seconds) keyed by
                source type ('screen'/'cam1'). A POSITIVE tau delays that clip rightward
                on the timeline to align its drifted start with the master. Missing key
                or 0.0 => no shift (exact current behavior). cam2 is rebuilt by the hybrid
                generator, so its delay is injected there, not here.
            video_drift_factors: Optional per-source manual retime factors r keyed by
                source type ('screen'/'cam2'). When present for a source, r is used
                verbatim for that source's timeMap (bypassing the auto drift methods);
                missing key => existing auto drift/retime path (exact current behavior).
        """
        video_sources = video_sources or {}
        video_offsets = video_offsets or {}
        video_drift_factors = video_drift_factors or {}
        
        # Load the original compound clip XML
        tree = self.xml_utils.parse_fcpxml(compound_xml_path)
        root = tree.getroot()
        
        # Get video settings from config
        video_settings = self.config.video_settings
        layout_config = self.config.get_layout_config('ssb', 'dual')
        
        if not layout_config:
            raise ValueError("No layout config found for ssb.dual")
        
        # Process screen audio (DC SSB only uses screen audio)
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
                        self.audio_processor.process_audio_source(audio_sources[audio_type], apply_audio_sync, audio_type=audio_type)
                    processed_audio_sources[audio_type] = {
                        'path': processed_path,
                        'duration': duration,
                        'sample_rate': sample_rate,
                        'channels': channels
                    }
                    print(f"Processed {audio_type} audio: {processed_path}")
                except Exception as e:
                    print(f"Error: Failed to process {audio_type} audio ({audio_sources[audio_type]}): {e}")
                    raise

        # Don't fail if no audio sources were processed - DC SSB can work without audio
        if not processed_audio_sources:
            print("Warning: No audio sources were successfully processed for DC SSB - continuing with video only")
            
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

        # Calculate trim values for 2-second gap at start of compound
        frame_duration_str = video_settings.get('frame_duration', '1001/30000s')
        trim_duration = self.xml_utils.calculate_trim_duration(frame_duration_str)
        trimmed_content_duration = self.xml_utils.subtract_time(original_duration, trim_duration)

        # Create new dc ssb compound clip
        dc_ssb_compound_id = "dc_ssb_compound"
        dc_ssb_name = f"{original_name} - DC SSB"
        
        # Start building new XML structure
        new_root = ET.Element('fcpxml')
        new_root.set('version', '1.11')
        
        resources = ET.SubElement(new_root, 'resources')
        
        # Create format elements
        # Get original format from compound XML for timeline compatibility
        original_format = tree.find('.//format')
        if original_format is None:
            raise ValueError("input compound XML has no <format> element")
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
            'r1_dc_ssb', 
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
            unquote(original_src.replace('file://', '')),
            original_duration,
            'r1_dc_ssb',
            has_audio=True,
            has_video=True
        )
        resources.append(original_video_asset)

        # Check if optional video sources are provided
        cam1_asset_id = None
        cam1_name = None
        if 'cam1' in video_sources and video_sources['cam1']:
            cam1_path = video_sources['cam1']
            cam1_asset_id = "r_cam1_video"
            cam1_name = Path(cam1_path).stem
            pass  # 0
            cam1_asset = self.xml_utils.create_asset_element(
                cam1_asset_id, cam1_name, cam1_path, original_duration,
                'r1_dc_ssb', has_audio=False, has_video=True
            )
            resources.append(cam1_asset)

        cam2_asset_id = None
        cam2_name = None
        cam2_retime_map = None
        if 'cam2' in video_sources and video_sources['cam2']:
            cam2_path = video_sources['cam2']
            cam2_asset_id = "r_cam2_video"
            cam2_name = Path(cam2_path).stem

            # Only retime if this is a capture source (has "capture" in filename)
            # Output sources are already synced with master
            is_capture = 'capture' in Path(cam2_path).name.lower()
            cam2_drift = video_drift_factors.get('cam2')

            if is_capture or cam2_drift is not None:
                # Detect framerate and calculate retime map. A manual driftFactor override
                # forces a retime even for an output source (user is taking manual control);
                # otherwise only capture sources are retimed.
                cam2_fps = self.audio_processor.get_video_framerate(cam2_path)
                cam2_retime_map = self.xml_utils.calculate_retime_map(
                    original_duration, cam2_fps, 29.97, speed_factor=cam2_drift)
                if cam2_retime_map:
                    print(f"  cam2 video: {cam2_fps:.2f}fps → 29.97fps (will apply timeMap)")
                else:
                    print(f"  cam2 video: {cam2_fps:.2f}fps (no retiming needed)")
            else:
                # Output source - no retiming needed
                print(f"  cam2 video: output source, using native timing (no retiming)")

            cam2_asset = self.xml_utils.create_asset_element(
                cam2_asset_id, cam2_name, cam2_path, original_duration,
                'r1_dc_ssb', has_audio=False, has_video=True
            )
            resources.append(cam2_asset)

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

            # Calculate retime map using Method B (metadata) or Method C (framerate fallback).
            # A manual driftFactor override (if present) takes priority via speed_factor.
            screen_retime_map = self.xml_utils.calculate_retime_map(
                original_duration, screen_fps, 29.97,
                video_duration=screen_video_duration if screen_audio_duration else None,
                audio_duration=screen_audio_duration,
                speed_factor=video_drift_factors.get('screen')
            )

            screen_asset = self.xml_utils.create_asset_element(
                screen_asset_id, screen_name, screen_path, original_duration,
                'r1_dc_ssb', has_audio=False, has_video=True
            )
            resources.append(screen_asset)

        # Create dc ssb compound media element
        dc_ssb_media = self.xml_utils.create_media_compound(
            dc_ssb_compound_id,
            dc_ssb_name, 
            original_duration,  # Use full original duration for compound
            'r1_dc_ssb',
            video_settings
        )
        
        # Build the compound sequence with gap structure
        sequence = dc_ssb_media.find('sequence')
        spine = ET.SubElement(sequence, 'spine')
        
        # Create empty gap for 2-second trim padding at start
        empty_gap = self.xml_utils.create_gap_element("Gap", "0s", trim_duration)
        spine.append(empty_gap)

        # Create content gap with trim offset
        gap = self.xml_utils.create_gap_element(
            "Gap",
            trim_duration,
            trimmed_content_duration,
            start=trim_duration
        )
        
        # Add audio sources to gap structure (negative lanes starting at -2, descending)
        current_audio_lane = -2  # Start at lane -2 for first audio track
        for audio_type in audio_sources_config:
            if audio_type in audio_assets:
                audio_info = processed_audio_sources[audio_type]
                audio_clip = self.xml_utils.create_clip_with_audio_effects(
                    Path(audio_info['path']).stem,
                    audio_assets[audio_type],
                    str(current_audio_lane),
                    trim_duration,
                    trimmed_content_duration,
                    audio_type,  # Pass audio type for volume adjustment
                    resources,   # Pass resources
                    enabled=True,
                    channels=audio_info['channels'],
                    source_duration=audio_info['duration']
                )
                gap.append(audio_clip)
                current_audio_lane -= 1

        # Add master audio clip
        # Enable master audio if no external audio sources provided (master-only mode)
        enable_master_audio = len(audio_sources) == 0
        if enable_master_audio:
            print("  Master-only mode: enabling master audio in DC SSB compound")
        master_audio_clip = self.xml_utils.create_audio_only_clip(
            original_name,
            original_asset_id,
            "-1",  # Lane -1 for master audio
            trim_duration,
            trimmed_content_duration,
            enabled=enable_master_audio,  # Enable if no external audio sources
            source_duration=original_duration
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
                    'r1_dc_ssb',
                    has_audio=False,
                    has_video=True
                )
                resources.append(background_asset)
                
                # Add background clip (lane 1 - bottom layer)
                background_clip = self.xml_utils.create_video_clip(
                    background_asset_key,
                    background_asset_id,
                    "1",  # Lane 1 - bottom video layer
                    trim_duration,
                    trimmed_content_duration,
                    None  # No transforms for background
                )
                gap.append(background_clip)
        
        # Add camera 1 video (top left, small) - cropped from master using exact template values
        cam1_config = layout_config.get('cam1', {})
        if cam1_config:
            if cam1_asset_id:
                camera1_asset = cam1_asset_id
                camera1_name = cam1_name
                cam1_transforms = {'crop': None, 'crop_mode': None, 'transform': {'position': [-36.481, 19.63], 'scale': 0.565}}  # -394 / 10.8, 212 / 10.8
            elif use_downloaded_stream:
                # Stream recovery mode - extract camera 1 from downloaded stream layout
                camera1_asset = original_asset_id
                camera1_name = f"{original_name} - Camera 1"
                print("  Stream recovery mode: using stream layout transforms for DC SSB camera 1")
                cam1_transforms = {
                    'crop': [3.57584, 60.72, 108.935, 2.63889],
                    'crop_mode': 'trim',
                    'transform': {
                        'position': [44.3607, 64.1846],
                        'scale': 1.53493
                    }
                }
            else:
                camera1_asset = original_asset_id
                camera1_name = f"{original_name} - Camera 1"
                cam1_transforms = {'crop': [2.77778, 51.7584, 91.1816, 1.37531], 'crop_mode': 'trim', 'transform': {'position': [16.7616, 49.9968], 'scale': 1.2026}}

            # Delay the DEDICATED cam1 source rightward by its measured offset.
            # Never shift the master-crop fallback (cam1_asset_id is None).
            cam1_offset = self._offset_with_video_delay(
                trim_duration,
                video_offsets.get('cam1', 0.0) if cam1_asset_id else 0.0
            )
            cam1_clip = self.xml_utils.create_video_clip(camera1_name, camera1_asset, "2", cam1_offset, trimmed_content_duration, cam1_transforms)
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
                        'r1_dc_ssb',
                        has_audio=False,
                        has_video=True
                    )
                    resources.append(border_asset)
                    
                    # Add border clip (lane 3)
                    border_clip = self.xml_utils.create_video_clip(
                        f"{border_asset_key} - Camera 1",
                        border_asset_id,
                        "3",  # Lane 3 - right above camera 1 (lane 2)
                        trim_duration,
                        trimmed_content_duration,
                        None  # No transforms - border should be full-screen overlay
                    )
                    gap.append(border_clip)
        
        # Add screen video (bottom right, large)
        screen_config = layout_config.get('screen', {})
        if screen_config:
            if screen_asset_id:
                screen_video_asset = screen_asset_id
                screen_video_name = screen_name
                screen_transforms = {'crop': None, 'crop_mode': None, 'transform': {'position': [34.63, -18.75], 'scale': 0.5843}}  # 374 / 10.8, -202.5 / 10.8
            elif use_downloaded_stream:
                # Stream recovery mode - extract screen from downloaded stream layout
                screen_video_asset = original_asset_id
                screen_video_name = f"{original_name} - Screen"
                print("  Stream recovery mode: using stream layout transforms for DC SSB screen")
                screen_transforms = {
                    'crop': [2.95369, 2.76385, 76.5765, 42.0927],
                    'crop_mode': 'trim',
                    'transform': {
                        'position': [73.6078, -39.6511],
                        'scale': 1.06124
                    }
                }
            else:
                screen_video_asset = original_asset_id
                screen_video_name = f"{original_name} - Screen"
                screen_transforms = {'crop': [2.02365, 1.18815, 90.863, 51.1176], 'crop_mode': 'trim', 'transform': {'position': [89.3201, -49.442], 'scale': 1.23001}}

            # Delay the DEDICATED screen source rightward by its measured offset.
            # Never shift the master-crop fallback (screen_asset_id is None).
            screen_offset = self._offset_with_video_delay(
                trim_duration,
                video_offsets.get('screen', 0.0) if screen_asset_id else 0.0
            )
            screen_clip = self.xml_utils.create_video_clip(screen_video_name, screen_video_asset, "4", screen_offset, trimmed_content_duration, screen_transforms, retime_map=screen_retime_map if screen_asset_id else None)
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
                        'r1_dc_ssb',
                        has_audio=False,
                        has_video=True
                    )
                    resources.append(border_asset)
                    
                    # Add border clip (lane 5)
                    border_clip = self.xml_utils.create_video_clip(
                        f"{border_asset_key} - Screen",
                        border_asset_id,
                        "5",  # Lane 5 - right above screen (lane 4)
                        trim_duration,
                        trimmed_content_duration,
                        None  # No transforms - border should be full-screen overlay
                    )
                    gap.append(border_clip)
        
        # Add camera 2 video (bottom left)
        cam2_config = layout_config.get('cam2', {})
        if cam2_config:
            if cam2_asset_id:
                camera2_asset = cam2_asset_id
                camera2_name = cam2_name
                cam2_transforms = {'crop': None, 'crop_mode': None, 'transform': {'position': [-52.963, -29.074], 'scale': 0.38}}  # -572 / 10.8, -314 / 10.8
            elif use_downloaded_stream:
                # Stream recovery mode - extract camera 2 from downloaded stream layout
                camera2_asset = original_asset_id
                camera2_name = f"{original_name} - Camera 2"
                print("  Stream recovery mode: using stream layout transforms for DC SSB camera 2")
                cam2_transforms = {
                    'crop': [104.484, 2.08216, 9.52776, 62.2644],
                    'crop_mode': 'trim',
                    'transform': {
                        'position': [-103.228, -60.8952],
                        'scale': 1.05996
                    }
                }
            else:
                camera2_asset = original_asset_id
                camera2_name = f"{original_name} - Camera 2"
                cam2_transforms = {'crop': [91.3865, 1.12389, 2.04329, 51.3326], 'crop_mode': 'trim', 'transform': {'position': [-88.6903, -49.2458], 'scale': 0.801898}}

            cam2_clip = self.xml_utils.create_video_clip(camera2_name, camera2_asset, "6", trim_duration, trimmed_content_duration, cam2_transforms, retime_map=cam2_retime_map if cam2_asset_id else None)
            gap.append(cam2_clip)
            
            # Add camera 2 border if specified (lane 7 - immediately above camera 2)
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
                        'r1_dc_ssb',
                        has_audio=False,
                        has_video=True
                    )
                    resources.append(border_asset)
                    
                    # Add border clip (lane 7)
                    border_clip = self.xml_utils.create_video_clip(
                        f"{border_asset_key} - Camera 2",
                        border_asset_id,
                        "7",  # Lane 7 - right above camera 2 (lane 6)
                        trim_duration,
                        trimmed_content_duration,
                        None  # No transforms - border should be full-screen overlay
                    )
                    gap.append(border_clip)
        
        spine.append(gap)
        resources.append(dc_ssb_media)
        
        # Create library and project structure
        library = ET.SubElement(new_root, 'library')
        event = ET.SubElement(library, 'event')
        event.set('name', 'Auto-Editor Media Group')
        
        project = ET.SubElement(event, 'project')
        project.set('name', f"{original_name} - DC SSB Edit")
        
        # Create main timeline with the cut structure referencing the dc ssb compound
        original_format_id = "r1"  # Use the original auto-editor format for the main timeline
        main_sequence = ET.SubElement(project, 'sequence')
        main_sequence.set('format', original_format_id)  # Match original cuts format
        main_sequence.set('tcStart', '0s')
        main_sequence.set('tcFormat', video_settings.get('tcFormat', 'NDF'))
        main_sequence.set('audioLayout', video_settings.get('audioLayout', 'stereo'))
        main_sequence.set('audioRate', video_settings.get('audioRate', '48k'))
        
        main_spine = ET.SubElement(main_sequence, 'spine')
        
        # Add ref-clips for each cut, referencing the dc ssb compound
        main_timeline_frame_duration = original_format.get('frameDuration', '1/30s') if original_format is not None else '1/30s'

        # Track expected offset to ensure continuity (no gaps/overlaps)
        expected_offset = "0s"

        for i, cut in enumerate(cuts):
            ref_clip = ET.SubElement(main_spine, 'ref-clip')
            ref_clip.set('ref', dc_ssb_compound_id)
            ref_clip.set('name', dc_ssb_name)

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
            adjusted_start = self._add_time_fractions(snapped_start, trim_duration)
            ref_clip.set('start', adjusted_start)

            # Calculate next expected offset
            expected_offset = self._add_time_fractions(snapped_offset, snapped_duration)
        
        # Save the new XML
        if output_path is None:
            input_path = Path(compound_xml_path)
            output_path = input_path.parent / f"{input_path.stem}_DC_SSB.fcpxml"
        
        new_tree = ET.ElementTree(new_root)
        self.xml_utils.save_fcpxml(new_tree, output_path)
        
        print(f"DC SSB compound clip created: {output_path}")
        return str(output_path)
    
    @classmethod
    def handle_generate_dc_ssb(cls, args, config):
        """Handle generate-dc-ssb command from CLI."""
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
                    pass  # 0
                else:
                    print(f"Error: Screen audio file not found: {screen_path}")
                    return 1
            if args.game_audio:
                game_path = Path(args.game_audio)
                if game_path.exists():
                    audio_sources['game'] = str(game_path)
                    pass  # 0
                else:
                    print(f"Warning: Game audio file not found: {game_path}")
            
            if not audio_sources:
                print("Error: At least one audio source is required for DC SSB compound (--screen-audio or --game-audio)")
                return 1
            
            print(f"Processing audio sources: {list(audio_sources.keys())}")
            
            # Create DC SSB generator
            dc_ssb_generator = cls(config)
            
            # Generate DC SSB compound clip
            output_path = dc_ssb_generator.generate_dc_ssb_compound(
                str(compound_path),
                audio_sources,
                args.output,
                args.sync_audio
            )
            
            print(f"Success! DC SSB compound clip generated: {output_path}")
            print("\nNext steps:")
            print("1. Import the XML file into Final Cut Pro X")
            print("2. The DC SSB compound clip will be available in your event")
            print("3. Use the main timeline to switch between cuts")
            
            return 0
            
        except Exception as e:
            print(f"Error generating DC SSB compound clip: {e}")
            return 1

    def _offset_with_video_delay(self, base_offset: str, tau_seconds: float) -> str:
        """Delay a clip's timeline offset rightward by tau_seconds to align a
        drifted companion video source with the master.

        tau is frame-rounded to the 29.97fps grid (30000/1001) and ADDED to the
        offset (never to start), which avoids a negative source in-point. A
        POSITIVE tau delays the clip rightward.

        tau_seconds == 0.0 (the default when no per-source video offset was
        supplied) returns base_offset UNCHANGED, so existing outputs are
        bit-for-bit identical unless an offset is explicitly injected.
        """
        if not tau_seconds:
            return base_offset
        tau_frames = round(tau_seconds * 30000 / 1001)
        if tau_frames == 0:
            return base_offset
        tau_str = f"{tau_frames * 1001}/30000s"
        return self._add_time_fractions(base_offset, tau_str)

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