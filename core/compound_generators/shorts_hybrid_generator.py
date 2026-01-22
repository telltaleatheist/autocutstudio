# core/compound_generators/shorts_hybrid_generator.py

import xml.etree.ElementTree as ET
from pathlib import Path
from typing import List, Tuple, Optional
import sys
import copy

from ..xml_utils import FCPXMLUtils
from ..video_analysis import CameraDetector


class ShortsHybridGenerator:
    """Generate shorts hybrid compounds that adapt internally based on camera detection."""

    def __init__(self, config):
        self.config = config
        self.xml_utils = FCPXMLUtils()

        # Only initialize camera detector if available (requires numpy)
        if CameraDetector is not None:
            self.camera_detector = CameraDetector(sample_interval=30)
        else:
            self.camera_detector = None
            print("Warning: Camera detection not available (numpy not installed)", file=sys.stderr)

    def generate_shorts_hybrid_compounds(self, dc_cam_path: str, dc_ssb_path: str,
                                   cut_master_video_path: str,
                                   output_dir: str,
                                   use_downloaded_stream: bool = False,
                                   segments: Optional[List[Tuple[float, float, str]]] = None) -> Tuple[str, str]:
        """
        Generate shorts hybrid compound clips that adapt based on camera 2 activity.

        Creates 2 compounds (CAM, SSB) where video layers change based on segments.
        Note: Shorts do not include GS (Game Share) layouts.

        Args:
            dc_cam_path: Path to DC Shorts CAM compound XML
            dc_ssb_path: Path to DC Shorts SSB compound XML
            cut_master_video_path: Path to the cut master video (for detection)
            output_dir: Directory to save shorts hybrid compounds
            use_downloaded_stream: Whether to use stream-specific cam2 detection region
            segments: Optional pre-computed segments from horizontal hybrid generation (to avoid re-scanning)

        Returns:
            Tuple of (hybrid_cam_path, hybrid_ssb_path)
        """
        print(f"\n=== Generating Shorts Hybrid Compounds ===", file=sys.stderr)

        # Step 1: Detect or use provided camera segments
        if segments is not None:
            print(f"\n[1/3] Using pre-computed camera segments (skipping detection)...", file=sys.stderr)
        else:
            # Check if camera detector is available
            if self.camera_detector is None:
                raise RuntimeError("Cannot generate shorts hybrid compounds: Camera detection not available (numpy not installed)")

            # Detect camera segments
            camera_region = 'stream_cam2' if use_downloaded_stream else 'top_right'
            print(f"\n[1/3] Detecting camera activity (region: {camera_region})...", file=sys.stderr)
            segments = self.camera_detector.detect_segments(cut_master_video_path, camera_region=camera_region)

        # Step 2: Generate hybrid CAM compound
        print(f"\n[2/3] Generating hybrid CAM compound...", file=sys.stderr)
        hybrid_cam_path = self._generate_shorts_hybrid_cam(dc_cam_path, segments, output_dir)

        # Step 3: Generate hybrid SSB compound
        print(f"\n[3/3] Generating hybrid SSB compound...", file=sys.stderr)
        try:
            hybrid_ssb_path = self._generate_shorts_hybrid_ssb(dc_ssb_path, segments, output_dir)
            print(f"[3/3] SSB hybrid generated successfully: {hybrid_ssb_path}", file=sys.stderr)
        except Exception as e:
            print(f"[3/3] ERROR generating SSB hybrid: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            raise

        print(f"\n=== Shorts Hybrid Compounds Complete ===", file=sys.stderr)
        return hybrid_cam_path, hybrid_ssb_path

    def _generate_shorts_hybrid_cam(self, dc_cam_path: str, segments: List[Tuple[float, float, str]], output_dir: str) -> str:
        """
        Generate hybrid CAM compound by splitting and modifying video layers based on segments.

        Layer structure:
        - Lane 1: Solo cam (full screen) - always enabled
        - Lane 2: DC cam1 (bottom) - enabled in DC mode, disabled in SOLO mode
        - Lane 3: DC cam2 (top) - enabled in DC mode, disabled in SOLO mode

        For SOLO segments:
        - Disable DC layers (lanes 2, 3)
        - Solo cam (lane 1) shows through

        For DC segments:
        - Enable DC layers (lanes 2, 3)
        - DC layers cover solo cam (lane 1)
        """
        tree = self.xml_utils.parse_fcpxml(dc_cam_path)
        root = tree.getroot()

        # Find the compound sequence
        compound = root.find('.//media[@id="dc_shorts_cam_compound"]')
        if compound is None:
            raise ValueError("Could not find dc_shorts_cam_compound in DC Shorts CAM XML")

        sequence = compound.find('sequence')
        spine = sequence.find('spine')
        gap = spine.find('gap')

        # Find video clips by lane
        video_clips_by_lane = {}
        for child in list(gap):  # Use list() to avoid modification during iteration
            if child.tag == 'video':
                lane = child.get('lane')
                if lane in ['1', '2', '3']:  # solo cam, DC cam1, DC cam2
                    video_clips_by_lane[lane] = child
                    gap.remove(child)  # Remove original clips

        # Add segmented clips for each lane
        for start_time, end_time, mode in segments:
            duration_seconds = end_time - start_time
            offset_str = self._seconds_to_time_str(start_time)
            duration_str = self._seconds_to_time_str(duration_seconds)

            # Process each video lane
            for lane in ['1', '2', '3']:
                original_clip = video_clips_by_lane.get(lane)
                if original_clip is None:
                    continue

                # Create new clip for this segment
                new_clip = ET.Element('video')
                new_clip.set('ref', original_clip.get('ref'))
                new_clip.set('lane', lane)
                new_clip.set('offset', offset_str)
                new_clip.set('name', original_clip.get('name'))
                new_clip.set('duration', duration_str)

                # Apply segment-specific settings
                if mode == 'solo':
                    # SOLO mode
                    if lane == '1':
                        # Solo cam: enabled with original transforms
                        new_clip.set('enabled', '1')
                        # Copy original child elements (transforms, crop)
                        for child in original_clip:
                            new_clip.append(copy.deepcopy(child))
                    else:
                        # Lanes 2, 3 (DC layers): disabled
                        new_clip.set('enabled', '0')
                        # Copy original child elements
                        for child in original_clip:
                            new_clip.append(copy.deepcopy(child))
                else:
                    # DC mode - all lanes enabled
                    new_clip.set('enabled', '1')
                    # Copy original child elements (transforms, etc)
                    for child in original_clip:
                        new_clip.append(copy.deepcopy(child))

                gap.append(new_clip)

        # Update compound name
        compound.set('name', compound.get('name', '').replace('DC Shorts Cam', 'Shorts Hybrid Cam'))

        # Save shorts hybrid compound
        output_path = Path(output_dir) / Path(dc_cam_path).name.replace('DC_SHORTS_CAM', 'SHORTS_HYBRID_CAM')
        self.xml_utils.save_fcpxml(tree, str(output_path))
        print(f"Saved: {output_path}", file=sys.stderr)

        return str(output_path)

    def _generate_shorts_hybrid_ssb(self, dc_ssb_path: str, segments: List[Tuple[float, float, str]], output_dir: str) -> str:
        """
        Generate hybrid SSB compound.

        For SOLO segments: Disable cam2 and cam2 border
        For DC segments: Keep everything enabled
        """
        return self._generate_shorts_hybrid_simple(dc_ssb_path, segments, output_dir, 'SSB')

    def _generate_shorts_hybrid_simple(self, dc_path: str, segments: List[Tuple[float, float, str]],
                                 output_dir: str, compound_type: str) -> str:
        """
        Generate shorts hybrid compound for SSB.

        Layer structure (7 lanes):
        - Lane 1: screen (always enabled)
        - Lanes 2-3: SOLO cam1 + border (enabled in SOLO mode)
        - Lanes 4-5: DC cam1 + border (enabled in DC mode)
        - Lanes 6-7: DC cam2 + border (enabled in DC mode)

        For SOLO segments: enable lanes 1-3, disable lanes 4-7
        For DC segments: enable lanes 1, 4-7, disable lanes 2-3
        """
        tree = self.xml_utils.parse_fcpxml(dc_path)
        root = tree.getroot()

        # Find the compound - search for media elements with 'dc' in the id
        compound = None
        for media in root.findall('.//media'):
            media_id = media.get('id', '')
            if 'dc' in media_id.lower():
                compound = media
                break

        if compound is None:
            raise ValueError(f"Could not find DC {compound_type} compound in XML")

        sequence = compound.find('sequence')
        spine = sequence.find('spine')
        gap = spine.find('gap')

        # Find video clips by lane (lanes 2-7, skip lane 1 which is screen)
        video_clips_by_lane = {}
        for child in list(gap):
            if child.tag == 'video':
                lane = child.get('lane')
                if lane in ['2', '3', '4', '5', '6', '7']:  # All cam layers (solo and DC)
                    video_clips_by_lane[lane] = child
                    gap.remove(child)  # Remove original clips

        # Add segmented clips for each lane
        for start_time, end_time, mode in segments:
            duration_seconds = end_time - start_time
            offset_str = self._seconds_to_time_str(start_time)
            duration_str = self._seconds_to_time_str(duration_seconds)

            # Process each video lane
            for lane in ['2', '3', '4', '5', '6', '7']:
                original_clip = video_clips_by_lane.get(lane)
                if original_clip is None:
                    continue

                # Create new clip for this segment
                new_clip = ET.Element('video')
                new_clip.set('ref', original_clip.get('ref'))
                new_clip.set('lane', lane)
                new_clip.set('offset', offset_str)
                new_clip.set('name', original_clip.get('name'))
                new_clip.set('duration', duration_str)

                # Set enabled based on mode and lane
                if mode == 'solo':
                    # SOLO mode: enable lanes 2-3 (solo cam + border), disable lanes 4-7 (DC layers)
                    new_clip.set('enabled', '1' if lane in ['2', '3'] else '0')
                else:
                    # DC mode: disable lanes 2-3 (solo layers), enable lanes 4-7 (DC layers)
                    new_clip.set('enabled', '0' if lane in ['2', '3'] else '1')

                # Copy child elements (transforms, etc)
                for child in original_clip:
                    new_clip.append(copy.deepcopy(child))

                gap.append(new_clip)

        # Update compound name
        compound.set('name', compound.get('name', '').replace(f'DC Shorts {compound_type}', f'Shorts Hybrid {compound_type}'))

        # Save shorts hybrid compound
        output_path = Path(output_dir) / Path(dc_path).name.replace(f'DC_SHORTS_{compound_type}', f'SHORTS_HYBRID_{compound_type}')
        self.xml_utils.save_fcpxml(tree, str(output_path))
        print(f"Saved: {output_path}", file=sys.stderr)

        return str(output_path)

    def _time_str_to_seconds(self, time_str: str) -> float:
        """Convert FCP XML time string to seconds."""
        if not time_str or time_str == '0s':
            return 0.0

        time_str = time_str.replace('s', '')
        if '/' in time_str:
            num, den = time_str.split('/')
            return float(num) / float(den)

        return float(time_str)

    def _seconds_to_time_str(self, seconds: float) -> str:
        """Convert seconds to FCP XML time string (29.97fps format)."""
        if seconds == 0:
            return '0s'

        # Use 30000 denominator for 29.97fps
        # Calculate exact frame count and multiply by frame duration
        # Frame duration = 1001/30000s, so frames = seconds / (1001/30000) = seconds * 30000/1001
        frame_count = round(seconds * 30000 / 1001)
        # Convert back to time: frames * (1001/30000s)
        numerator = frame_count * 1001
        return f"{numerator}/30000s"
