# core/compound_generators/shorts_ssb_generator.py

import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional
import uuid
import datetime

from ..xml_utils import FCPXMLUtils
from ..audio_processor import AudioProcessor

class ShortsSSBGenerator:
    """Generate Shorts SSB (screen share big) compound clips with full-screen video and screen audio."""
    
    def __init__(self, config):
        self.config = config
        self.audio_processor = AudioProcessor(config)
        self.xml_utils = FCPXMLUtils()
    
    def generate_shorts_ssb_compound(self, compound_xml_path: str, audio_sources: Dict[str, str],
                                mode: str = "solo", output_path: Optional[str] = None,
                                apply_audio_sync: bool = False, video_sources: Optional[Dict[str, str]] = None,
                                use_downloaded_stream: bool = False) -> str:
            """Generate Shorts SSB compound clip from existing compound clip XML.

            Args:
                compound_xml_path: Path to existing compound XML file
                audio_sources: Dictionary mapping audio types to file paths (e.g., {'screen': '/path/to/screen.mp3'})
                mode: Layout mode ('solo' or 'dual')
                output_path: Optional custom output path
                apply_audio_sync: Whether to apply 29.97fps sync correction
                video_sources: Optional dictionary of video source paths (e.g., {'cam1': '/path/to/cam.mp4', 'screen': '/path/to/screen.mp4'})
                use_downloaded_stream: Whether to use stream recovery transforms for downloaded stream masters
            """
            video_sources = video_sources or {}
            
            # Load the original compound clip XML
            tree = self.xml_utils.parse_fcpxml(compound_xml_path)
            root = tree.getroot()
            
            # Get video settings from config
            video_shorts_settings = self.config.video_shorts_settings
            layout_config = self.config.get_layout_config('shorts_ssb', mode)
            
            if not layout_config:
                raise ValueError(f"No layout config found for shorts_ssb.{mode}")
            
            # Process screen audio (SSB only uses screen audio)
            processed_audio_sources = {}
            audio_sources_config = layout_config.get('audio_sources', ['screen', 'game', 'bluetooth'])

            print(f"DEBUG Shorts SSB ({mode}): audio_sources_config = {audio_sources_config}", file=sys.stderr)
            print(f"DEBUG Shorts SSB ({mode}): audio_sources keys = {list(audio_sources.keys())}", file=sys.stderr)

            # Warn about missing expected audio sources
            missing_audio = [at for at in audio_sources_config if at not in audio_sources]
            if missing_audio:
                print(f"⚠️  WARNING: Missing audio sources for Shorts SSB: {missing_audio}", file=sys.stderr)
                print(f"   Expected: {audio_sources_config}", file=sys.stderr)
                print(f"   Provided: {list(audio_sources.keys())}", file=sys.stderr)

            for audio_type in audio_sources_config:
                if audio_type in audio_sources and audio_sources[audio_type]:
                    try:
                        # Check if the file actually exists before processing
                        if not Path(audio_sources[audio_type]).exists():
                            print(f"⚠️  Warning: {audio_type} audio file not found: {audio_sources[audio_type]}", file=sys.stderr)
                            continue

                        processed_path, duration, sample_rate, channels = \
                            self.audio_processor.process_audio_source(audio_sources[audio_type], apply_audio_sync, audio_type=audio_type)
                        processed_audio_sources[audio_type] = {
                            'path': processed_path,
                            'duration': duration,
                            'sample_rate': sample_rate,
                            'channels': channels
                        }
                        print(f"✓ Processed {audio_type} audio for Shorts SSB: {processed_path}", file=sys.stderr)
                    except Exception as e:
                        print(f"⚠️  Warning: Failed to process {audio_type} audio ({audio_sources[audio_type]}): {e}", file=sys.stderr)
                        # Continue without this audio source instead of failing
                        continue
                else:
                    print(f"⊷ Skipping {audio_type} - not in provided audio sources", file=sys.stderr)

            # Don't fail if no audio sources were processed - Shorts SSB can work without audio
            if not processed_audio_sources:
                print("⚠️  Warning: No audio sources were successfully processed for Shorts SSB - continuing with video only", file=sys.stderr)
            else:
                print(f"✓ Shorts SSB ({mode}) will include audio: {list(processed_audio_sources.keys())}", file=sys.stderr)
                
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
            # Use dc_ prefix for dual mode so hybrid generator can find it
            ssb_compound_id = "dc_shorts_ssb_compound" if mode == "dual" else "shorts_ssb_compound"
            mode_label = "DC Shorts SSB" if mode == "dual" else "Shorts SSB"
            ssb_name = f"{original_name} - {mode_label}"
            
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
                timeline_format.set('width', original_format.get('width', str(video_shorts_settings.get('width', 1920))))
                timeline_format.set('height', original_format.get('height', str(video_shorts_settings.get('height', 1080))))
                timeline_format.set('colorSpace', original_format.get('colorSpace', '1-1-1 (Rec. 709)'))
            
            # Compound clip format (for internal compound structure)
            video_format = self.xml_utils.create_format_element(
                'r1_shorts_ssb', 
                video_shorts_settings.get('frame_duration', '1001/30000s'),
                video_shorts_settings.get('width', 1920),
                video_shorts_settings.get('height', 1080),
                video_shorts_settings.get('color_space', '1-1-1 (Rec. 709)')
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
                'r1_shorts_ssb',
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

                pass  # 0

                # Create asset for the cam1 video
                cam1_asset = self.xml_utils.create_asset_element(
                    cam1_asset_id,
                    cam1_name,
                    cam1_path,
                    original_duration,
                    'r1_shorts_ssb',
                    has_audio=False,
                    has_video=True
                )
                resources.append(cam1_asset)

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

                # Create asset for the screen video
                screen_asset = self.xml_utils.create_asset_element(
                    screen_asset_id,
                    screen_name,
                    screen_path,
                    original_duration,
                    'r1_shorts_ssb',
                    has_audio=False,
                    has_video=True
                )
                resources.append(screen_asset)

            # Create ssb compound media element
            ssb_media = self.xml_utils.create_media_compound(
                ssb_compound_id,
                ssb_name, 
                original_duration,  # Use full original duration for compound
                'r1_shorts_ssb',
                video_shorts_settings
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
                        resources,   # Pass resources
                        enabled=True,
                        channels=audio_info['channels']
                    )
                    gap.append(audio_clip)
                    pass  # 0
                    current_audio_lane -= 1
            
            # Add master audio clip
            # Enable master audio if no external audio sources provided (master-only mode)
            audio_config = layout_config.get('audio', {})
            enable_master_audio = len(audio_sources) == 0
            if enable_master_audio:
                print("  Master-only mode: enabling master audio in Shorts SSB compound")
            master_audio_clip = self.xml_utils.create_audio_only_clip(
                original_name,
                original_asset_id,
                str(audio_config.get('master_lane', -1)),
                "0s",
                original_duration,
                enabled=enable_master_audio or audio_config.get('master_enabled', False)
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
                        'r1_shorts_ssb',
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
            
            # Add camera video(s) - handle both solo and dual modes
            camera_config = layout_config.get('camera', {})  # Solo mode
            cam1_config = layout_config.get('cam1', {})  # Dual mode
            cam2_config = layout_config.get('cam2', {})  # Dual mode

            if camera_config:
                # SOLO MODE - single camera
                if cam1_asset_id:
                    camera_asset = cam1_asset_id
                    camera_name_for_clip = cam1_name
                    camera_transforms = {
                        'crop': None,
                        'crop_mode': None,
                        'transform': {
                            'position': [-25, 25],
                            'scale': 0.5
                        }
                    }
                elif use_downloaded_stream:
                    camera_asset = original_asset_id
                    camera_name_for_clip = f"{original_name} - Camera"
                    print("  Stream recovery mode: using stream layout transforms for SSB camera")
                    camera_transforms = {
                        'crop': [3.57584, 60.72, 108.935, 2.63889],
                        'crop_mode': 'trim',
                        'transform': {
                            'position': [44.3607, 64.1846],
                            'scale': 1.53493
                        }
                    }
                else:
                    camera_asset = original_asset_id
                    camera_name_for_clip = f"{original_name} - Camera"
                    camera_transforms = {
                        'crop': camera_config.get('crop', [0, 50.0412, 88.8889, 0]),
                        'crop_mode': 'trim',
                        'transform': {
                            'position': camera_config.get('position', [24.4792, -18.2292]),
                            'scale': camera_config.get('scale', 1.75)
                        }
                    }

                camera_lane = str(camera_config.get('lane', 2))
                camera_clip = self.xml_utils.create_video_clip(
                    camera_name_for_clip,
                    camera_asset,
                    camera_lane,
                    "0s",
                    original_duration,
                    camera_transforms
                )
                gap.append(camera_clip)

                # Add camera border if specified
                if 'border' in camera_config:
                    border_asset_key = camera_config['border']
                    border_path = self.config.get_border_path(border_asset_key)
                    if border_path and border_path != '':
                        border_asset_id = f"r_{border_asset_key.replace('.', '_')}_camera"
                        border_asset = self.xml_utils.create_asset_element(
                            border_asset_id, f"{border_asset_key} - Camera", border_path,
                            original_duration, 'r1_shorts_ssb', has_audio=False, has_video=True
                        )
                        resources.append(border_asset)
                        # Use border position/scale from config
                        border_position = camera_config.get('border_position', [0, 4.42708])
                        border_scale = camera_config.get('border_scale', 1.4)
                        border_transforms = {
                            'crop': None,
                            'crop_mode': None,
                            'transform': {
                                'position': border_position,
                                'scale': border_scale
                            }
                        }
                        border_lane = str(int(camera_lane) + 1)
                        border_clip = self.xml_utils.create_video_clip(
                            f"{border_asset_key} - Camera", border_asset_id, border_lane,
                            "0s", original_duration, border_transforms
                        )
                        gap.append(border_clip)

            elif cam1_config:
                # DUAL MODE - multi-layer structure for adaptive hybrid compounds
                # Layer structure:
                #   Lane 1: screen (always enabled)
                #   Lanes 2-3: SOLO cam1 + border (enabled when cam2 inactive)
                #   Lanes 4-5: DC cam1 + border (enabled when cam2 active)
                #   Lanes 6-7: DC cam2 + border (enabled when cam2 active)

                # Get solo camera config for SOLO layers
                solo_layout = self.config.get_layout_config('shorts_ssb', 'solo')
                solo_camera_config = solo_layout.get('camera', {})

                # LANES 2-3: Add SOLO cam1 + border (enabled when cam2 inactive)
                solo_cam1_asset = original_asset_id
                solo_cam1_name = f"{original_name} - Solo Cam1"
                solo_cam1_transforms = {
                    'crop': solo_camera_config.get('crop', [0, 50.0412, 88.8889, 0]),
                    'crop_mode': 'trim',
                    'transform': {
                        'position': solo_camera_config.get('position', [24.4792, -18.2292]),
                        'scale': solo_camera_config.get('scale', 1.75)
                    }
                }

                solo_cam1_clip = self.xml_utils.create_video_clip(
                    solo_cam1_name, solo_cam1_asset, "2",
                    "0s", original_duration, solo_cam1_transforms
                )
                gap.append(solo_cam1_clip)

                # Add solo cam1 border
                if 'border' in solo_camera_config:
                    border_asset_key = solo_camera_config['border']
                    border_path = self.config.get_border_path(border_asset_key)
                    if border_path and border_path != '':
                        border_asset_id = f"r_{border_asset_key.replace('.', '_')}_solo_cam1"
                        border_asset = self.xml_utils.create_asset_element(
                            border_asset_id, f"{border_asset_key} - Solo Cam1", border_path,
                            original_duration, 'r1_shorts_ssb', has_audio=False, has_video=True
                        )
                        resources.append(border_asset)
                        # Use border position/scale from solo config
                        border_position = solo_camera_config.get('border_position', [0, 4.42708])
                        border_scale = solo_camera_config.get('border_scale', 1.4)
                        border_transforms = {
                            'crop': None,
                            'crop_mode': None,
                            'transform': {
                                'position': border_position,
                                'scale': border_scale
                            }
                        }
                        border_clip = self.xml_utils.create_video_clip(
                            f"{border_asset_key} - Solo Cam1", border_asset_id, "3",
                            "0s", original_duration, border_transforms
                        )
                        gap.append(border_clip)

                # LANES 4-5: Add DC cam1 + border (enabled when cam2 active)
                dc_cam1_asset = original_asset_id
                dc_cam1_name = f"{original_name} - DC Cam1"
                dc_cam1_transforms = {
                    'crop': cam1_config.get('crop', [0, 50.0412, 88.8889, 0]),
                    'crop_mode': 'trim',
                    'transform': {
                        'position': cam1_config.get('position', [5.52029, -17.6981]),
                        'scale': cam1_config.get('scale', 1.15)
                    }
                }

                dc_cam1_clip = self.xml_utils.create_video_clip(
                    dc_cam1_name, dc_cam1_asset, "4",
                    "0s", original_duration, dc_cam1_transforms
                )
                gap.append(dc_cam1_clip)

                # Add DC cam1 border
                if 'border' in cam1_config:
                    border_asset_key = cam1_config['border']
                    border_path = self.config.get_border_path(border_asset_key)
                    if border_path and border_path != '':
                        border_asset_id = f"r_{border_asset_key.replace('.', '_')}_dc_cam1"
                        border_asset = self.xml_utils.create_asset_element(
                            border_asset_id, f"{border_asset_key} - DC Cam1", border_path,
                            original_duration, 'r1_shorts_ssb', has_audio=False, has_video=True
                        )
                        resources.append(border_asset)
                        # Use border position/scale from DC config
                        border_position = cam1_config.get('border_position', [-10.6878, -2.73181])
                        border_scale = cam1_config.get('border_scale', 0.92)
                        border_transforms = {
                            'crop': None,
                            'crop_mode': None,
                            'transform': {
                                'position': border_position,
                                'scale': border_scale
                            }
                        }
                        border_clip = self.xml_utils.create_video_clip(
                            f"{border_asset_key} - DC Cam1", border_asset_id, "5",
                            "0s", original_duration, border_transforms
                        )
                        gap.append(border_clip)

                # LANES 6-7: Add DC cam2 + border (enabled when cam2 active)
                if cam2_config:
                    dc_cam2_asset = original_asset_id
                    dc_cam2_name = f"{original_name} - DC Cam2"
                    dc_cam2_transforms = {
                        'crop': cam2_config.get('crop', [88.8889, 0, 0, 50.0412]),
                        'crop_mode': 'trim',
                        'transform': {
                            'position': cam2_config.get('position', [-5.74915, -48.3457]),
                            'scale': cam2_config.get('scale', 1.15)
                        }
                    }

                    dc_cam2_clip = self.xml_utils.create_video_clip(
                        dc_cam2_name, dc_cam2_asset, "6",
                        "0s", original_duration, dc_cam2_transforms
                    )
                    gap.append(dc_cam2_clip)

                    # Add DC cam2 border
                    if 'border' in cam2_config:
                        border_asset_key = cam2_config['border']
                        border_path = self.config.get_border_path(border_asset_key)
                        if border_path and border_path != '':
                            border_asset_id = f"r_{border_asset_key.replace('.', '_')}_dc_cam2"
                            border_asset = self.xml_utils.create_asset_element(
                                border_asset_id, f"{border_asset_key} - DC Cam2", border_path,
                                original_duration, 'r1_shorts_ssb', has_audio=False, has_video=True
                            )
                            resources.append(border_asset)
                            # Use border position/scale from DC config
                            border_position = cam2_config.get('border_position', [10.3731, -15.2241])
                            border_scale = cam2_config.get('border_scale', 0.92)
                            border_transforms = {
                                'crop': None,
                                'crop_mode': None,
                                'transform': {
                                    'position': border_position,
                                    'scale': border_scale
                                }
                            }
                            border_clip = self.xml_utils.create_video_clip(
                                f"{border_asset_key} - DC Cam2", border_asset_id, "7",
                                "0s", original_duration, border_transforms
                            )
                            gap.append(border_clip)
            
            # Add screen video - use transforms from config
            screen_config = layout_config.get('screen', {})
            if screen_config:
                screen_video_asset = original_asset_id
                screen_name_for_clip = f"{original_name} - Screen"
                screen_transforms = {
                    'crop': screen_config.get('crop', [0, 0, 88.8889, 50.0412]),
                    'crop_mode': 'trim',
                    'transform': {
                        'position': screen_config.get('position', [89.3698, -50.4281]),
                        'scale': screen_config.get('scale', 6.3619)
                    }
                }

                screen_lane = str(screen_config.get('lane', 1))
                screen_clip = self.xml_utils.create_video_clip(
                    screen_name_for_clip,
                    screen_video_asset,
                    screen_lane,
                    "0s",
                    original_duration,
                    screen_transforms,
                    retime_map=None
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
                            'r1_shorts_ssb',
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
            project.set('name', f"{original_name} - Shorts SSB Edit")
            
            # Create main timeline with the cut structure referencing the ssb compound
            original_format_id = "r1"  # Use the original auto-editor format for the main timeline
            main_sequence = ET.SubElement(project, 'sequence')
            main_sequence.set('format', original_format_id)  # Match original cuts format
            main_sequence.set('tcStart', '0s')
            main_sequence.set('tcFormat', video_shorts_settings.get('tcFormat', 'NDF'))
            main_sequence.set('audioLayout', video_shorts_settings.get('audioLayout', 'stereo'))
            main_sequence.set('audioRate', video_shorts_settings.get('audioRate', '48k'))
            
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
                suffix = "_DC_SHORTS_SSB.fcpxml" if mode == "dual" else "_SHORTS_SSB.fcpxml"
                output_path = input_path.parent / f"{input_path.stem}{suffix}"
            
            new_tree = ET.ElementTree(new_root)
            self.xml_utils.save_fcpxml(new_tree, output_path)
            
            print(f"Shorts SSB compound clip created: {output_path}")
            return str(output_path)
    
    @classmethod
    def handle_generate_shorts_ssb(cls, args, config):
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
                print("Error: At least one audio source is required for Shorts SSB compound (--screen-audio or --game-audio)")
                return 1
            
            print(f"Processing audio sources: {list(audio_sources.keys())}")
            
            # Create SSB generator
            ssb_generator = cls(config)
            
            # Generate Shorts SSB compound clip
            output_path = ssb_generator.generate_shorts_ssb_compound(
                str(compound_path),
                audio_sources,
                args.mode,
                args.output,
                args.sync_audio
            )
            
            print(f"Success! Shorts SSB compound clip generated: {output_path}")
            print("\nNext steps:")
            print("1. Import the XML file into Final Cut Pro X")
            print("2. The Shorts SSB compound clip will be available in your event")
            print("3. Use the main timeline to switch between cuts")
            
            return 0
            
        except Exception as e:
            print(f"Error generating Shorts SSB compound clip: {e}")
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