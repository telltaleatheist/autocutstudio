# core/compound_generators/hybrid_compound_generator.py

import xml.etree.ElementTree as ET
from pathlib import Path
from typing import List, Tuple
import sys
import copy

from ..xml_utils import FCPXMLUtils
from ..video_analysis import CameraDetector


class HybridCompoundGenerator:
    """Generate hybrid compounds that adapt internally based on camera detection."""

    def __init__(self, config):
        self.config = config
        self.xml_utils = FCPXMLUtils()

        # Only initialize camera detector if available (requires numpy)
        if CameraDetector is not None:
            self.camera_detector = CameraDetector(sample_interval=30)
        else:
            self.camera_detector = None
            print("Warning: Camera detection not available (numpy not installed)", file=sys.stderr)

    def generate_hybrid_compounds(self, dc_cam_path: str, dc_gs_path: str, dc_ssb_path: str,
                                   cut_master_video_path: str,
                                   output_dir: str) -> Tuple[str, str, str]:
        """
        Generate hybrid compound clips that adapt based on camera 2 activity.

        Creates 3 compounds (CAM, GS, SSB) where video layers change based on segments.

        Args:
            dc_cam_path: Path to DC CAM compound XML
            dc_gs_path: Path to DC GS compound XML
            dc_ssb_path: Path to DC SSB compound XML
            cut_master_video_path: Path to the cut master video (for detection)
            output_dir: Directory to save hybrid compounds

        Returns:
            Tuple of (hybrid_cam_path, hybrid_gs_path, hybrid_ssb_path)
        """
        print(f"\n=== Generating Hybrid Compounds ===", file=sys.stderr)

        # Check if camera detector is available
        if self.camera_detector is None:
            raise RuntimeError("Cannot generate hybrid compounds: Camera detection not available (numpy not installed)")

        # Step 1: Detect camera segments
        print(f"\n[1/4] Detecting camera activity...", file=sys.stderr)
        segments = self.camera_detector.detect_segments(cut_master_video_path, camera_region='top_right')

        # Step 2: Generate hybrid CAM compound
        print(f"\n[2/4] Generating hybrid CAM compound...", file=sys.stderr)
        hybrid_cam_path = self._generate_hybrid_cam(dc_cam_path, segments, output_dir)

        # Step 3: Generate hybrid GS compound
        print(f"\n[3/4] Generating hybrid GS compound...", file=sys.stderr)
        try:
            hybrid_gs_path = self._generate_hybrid_gs(dc_gs_path, segments, output_dir)
            print(f"[3/4] GS hybrid generated successfully: {hybrid_gs_path}", file=sys.stderr)
        except Exception as e:
            print(f"[3/4] ERROR generating GS hybrid: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            raise

        # Step 4: Generate hybrid SSB compound
        print(f"\n[4/4] Generating hybrid SSB compound...", file=sys.stderr)
        try:
            hybrid_ssb_path = self._generate_hybrid_ssb(dc_ssb_path, segments, output_dir)
            print(f"[4/4] SSB hybrid generated successfully: {hybrid_ssb_path}", file=sys.stderr)
        except Exception as e:
            print(f"[4/4] ERROR generating SSB hybrid: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            raise

        print(f"\n=== Hybrid Compounds Complete ===", file=sys.stderr)
        return hybrid_cam_path, hybrid_gs_path, hybrid_ssb_path

    def _generate_hybrid_cam(self, dc_cam_path: str, segments: List[Tuple[float, float, str]], output_dir: str) -> str:
        """
        Generate hybrid CAM compound by splitting and modifying video layers based on segments.

        For SOLO segments:
        - Disable cam2 video (lane 4)
        - Disable cam2 border (lane 5)
        - Disable cam1 border (lane 3)
        - Reset cam1 transform to position="0 0" scale="1.0 1.0" (lane 2)

        For DC segments:
        - Keep everything as-is from DC compound
        """
        tree = self.xml_utils.parse_fcpxml(dc_cam_path)
        root = tree.getroot()

        # Find the compound sequence
        compound = root.find('.//media[@id="dc_cam_compound"]')
        if compound is None:
            raise ValueError("Could not find dc_cam_compound in DC CAM XML")

        sequence = compound.find('sequence')
        spine = sequence.find('spine')
        gap = spine.find('gap')

        # Find video clips by lane
        video_clips_by_lane = {}
        for child in list(gap):  # Use list() to avoid modification during iteration
            if child.tag == 'video':
                lane = child.get('lane')
                if lane in ['2', '3', '4', '5']:  # cam1, cam1 border, cam2, cam2 border
                    video_clips_by_lane[lane] = child
                    gap.remove(child)  # Remove original clips

        # Add segmented clips for each lane
        for start_time, end_time, mode in segments:
            duration_seconds = end_time - start_time
            offset_str = self._seconds_to_time_str(start_time)
            duration_str = self._seconds_to_time_str(duration_seconds)

            # Process each video lane
            for lane in ['2', '3', '4', '5']:
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
                new_clip.set('start', offset_str)  # Start reading from this point in source

                # Apply segment-specific settings
                if mode == 'solo':
                    # SOLO mode
                    if lane == '2':
                        # cam1: enabled, reset transform
                        new_clip.set('enabled', '1')
                        transform = ET.SubElement(new_clip, 'adjust-transform')
                        transform.set('position', '0 0')
                        transform.set('scale', '1.0 1.0')
                    else:
                        # lanes 3, 4, 5: disabled
                        new_clip.set('enabled', '0')
                        # Copy original child elements
                        for child in original_clip:
                            new_clip.append(copy.deepcopy(child))
                else:
                    # DC mode - keep original
                    new_clip.set('enabled', '1')
                    # Copy original child elements (transforms, etc)
                    for child in original_clip:
                        new_clip.append(copy.deepcopy(child))

                gap.append(new_clip)

        # Update compound name
        compound.set('name', compound.get('name', '').replace('DC Cam', 'Hybrid Cam'))

        # Save hybrid compound
        output_path = Path(output_dir) / Path(dc_cam_path).name.replace('DC_CAM', 'HYBRID_CAM')
        self.xml_utils.save_fcpxml(tree, str(output_path))
        print(f"Saved: {output_path}", file=sys.stderr)

        return str(output_path)

    def _generate_hybrid_gs(self, dc_gs_path: str, segments: List[Tuple[float, float, str]], output_dir: str) -> str:
        """
        Generate hybrid GS compound.

        For SOLO segments: Disable cam2 and cam2 border
        For DC segments: Keep everything enabled
        """
        return self._generate_hybrid_simple(dc_gs_path, segments, output_dir, 'GS')

    def _generate_hybrid_ssb(self, dc_ssb_path: str, segments: List[Tuple[float, float, str]], output_dir: str) -> str:
        """
        Generate hybrid SSB compound.

        For SOLO segments: Disable cam2 and cam2 border
        For DC segments: Keep everything enabled
        """
        return self._generate_hybrid_simple(dc_ssb_path, segments, output_dir, 'SSB')

    def _generate_hybrid_simple(self, dc_path: str, segments: List[Tuple[float, float, str]],
                                 output_dir: str, compound_type: str) -> str:
        """
        Generate hybrid compound for GS/SSB.

        These just need to disable cam2 and its border during SOLO segments.
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

        # Find all video clips and sort by lane
        video_clips = []
        for child in list(gap):
            if child.tag == 'video':
                lane_num = int(child.get('lane', '0'))
                video_clips.append((lane_num, child))

        # Sort to find highest lanes (cam2 and border)
        video_clips.sort(key=lambda x: x[0], reverse=True)

        # Assume top 2 video lanes are cam2 border and cam2 video
        clips_to_segment = []
        if len(video_clips) >= 2:
            clips_to_segment.append(video_clips[0][1])  # cam2 border
            clips_to_segment.append(video_clips[1][1])  # cam2 video

        # Remove these clips from gap
        for clip in clips_to_segment:
            gap.remove(clip)

        # Add segmented clips
        for start_time, end_time, mode in segments:
            duration_seconds = end_time - start_time
            offset_str = self._seconds_to_time_str(start_time)
            duration_str = self._seconds_to_time_str(duration_seconds)

            for original_clip in clips_to_segment:
                new_clip = ET.Element('video')
                new_clip.set('ref', original_clip.get('ref'))
                new_clip.set('lane', original_clip.get('lane'))
                new_clip.set('offset', offset_str)
                new_clip.set('name', original_clip.get('name'))
                new_clip.set('duration', duration_str)
                new_clip.set('start', offset_str)

                # Enable for DC, disable for SOLO
                new_clip.set('enabled', '1' if mode == 'dc' else '0')

                # Copy child elements (transforms, etc)
                for child in original_clip:
                    new_clip.append(copy.deepcopy(child))

                gap.append(new_clip)

        # Update compound name
        compound.set('name', compound.get('name', '').replace(f'DC {compound_type}', f'Hybrid {compound_type}'))

        # Save hybrid compound
        output_path = Path(output_dir) / Path(dc_path).name.replace(f'DC_{compound_type}', f'HYBRID_{compound_type}')
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
