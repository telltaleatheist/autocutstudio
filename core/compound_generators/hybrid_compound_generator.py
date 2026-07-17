# core/compound_generators/hybrid_compound_generator.py

import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional, Tuple
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
                                   output_dir: str,
                                   use_downloaded_stream: bool = False,
                                   video_offsets: Optional[Dict[str, float]] = None) -> Tuple[str, str, str, List[Tuple[float, float, str]]]:
        """
        Generate hybrid compound clips that adapt based on camera 2 activity.

        Creates 3 compounds (CAM, GS, SSB) where video layers change based on segments.

        Args:
            dc_cam_path: Path to DC CAM compound XML
            dc_gs_path: Path to DC GS compound XML
            dc_ssb_path: Path to DC SSB compound XML
            cut_master_video_path: Path to the cut master video (for detection)
            output_dir: Directory to save hybrid compounds
            use_downloaded_stream: Whether to use stream-specific cam2 detection region
            video_offsets: Optional per-source video alignment delays (seconds) keyed by
                source type ('cam1'/'cam2'). The hybrid generator REBUILDS the cam1/cam2
                video lanes (which the DC generators leave for it), so their rightward
                delay is injected here rather than in the DC generators. Missing key or
                0.0 => no shift (exact current behavior).

        Returns:
            Tuple of (hybrid_cam_path, hybrid_gs_path, hybrid_ssb_path, segments)
            segments: List of (start_time, end_time, mode) tuples for reuse in shorts generation
        """
        video_offsets = video_offsets or {}
        print(f"\n=== Generating Hybrid Compounds ===", file=sys.stderr)

        # Check if camera detector is available
        if self.camera_detector is None:
            raise RuntimeError("Cannot generate hybrid compounds: Camera detection not available (numpy not installed)")

        # Step 1: Detect camera segments
        # Use stream-specific region if in stream recovery mode
        camera_region = 'stream_cam2' if use_downloaded_stream else 'top_right'
        print(f"\n[1/4] Detecting camera activity (region: {camera_region})...", file=sys.stderr)
        segments = self.camera_detector.detect_segments(cut_master_video_path, camera_region=camera_region)

        # Step 2: Generate hybrid CAM compound
        print(f"\n[2/4] Generating hybrid CAM compound...", file=sys.stderr)
        hybrid_cam_path = self._generate_hybrid_cam(dc_cam_path, segments, output_dir, video_offsets)

        # Step 3: Generate hybrid GS compound
        print(f"\n[3/4] Generating hybrid GS compound...", file=sys.stderr)
        try:
            hybrid_gs_path = self._generate_hybrid_gs(dc_gs_path, segments, output_dir, video_offsets)
            print(f"[3/4] GS hybrid generated successfully: {hybrid_gs_path}", file=sys.stderr)
        except Exception as e:
            print(f"[3/4] ERROR generating GS hybrid: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            raise

        # Step 4: Generate hybrid SSB compound
        print(f"\n[4/4] Generating hybrid SSB compound...", file=sys.stderr)
        try:
            hybrid_ssb_path = self._generate_hybrid_ssb(dc_ssb_path, segments, output_dir, video_offsets)
            print(f"[4/4] SSB hybrid generated successfully: {hybrid_ssb_path}", file=sys.stderr)
        except Exception as e:
            print(f"[4/4] ERROR generating SSB hybrid: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            raise

        print(f"\n=== Hybrid Compounds Complete ===", file=sys.stderr)
        return hybrid_cam_path, hybrid_gs_path, hybrid_ssb_path, segments

    def _generate_hybrid_cam(self, dc_cam_path: str, segments: List[Tuple[float, float, str]], output_dir: str,
                             video_offsets: Optional[Dict[str, float]] = None) -> str:
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
        video_offsets = video_offsets or {}
        tree = self.xml_utils.parse_fcpxml(dc_cam_path)
        root = tree.getroot()

        # Find the compound sequence
        compound = root.find('.//media[@id="dc_cam_compound"]')
        if compound is None:
            raise ValueError("Could not find dc_cam_compound in DC CAM XML")

        sequence = compound.find('sequence')
        spine = sequence.find('spine')
        gaps = spine.findall('gap')
        gap = gaps[-1]  # Content gap is the last one (first is empty trim gap)

        # Find video clips by lane
        video_clips_by_lane = {}
        for child in list(gap):  # Use list() to avoid modification during iteration
            if child.tag == 'video':
                lane = child.get('lane')
                if lane in ['2', '3', '4', '5']:  # cam1, cam1 border, cam2, cam2 border
                    video_clips_by_lane[lane] = child
                    gap.remove(child)  # Remove original clips

        # Get content gap's coordinate offset for segment alignment
        gap_start_seconds = self._time_str_to_seconds(gap.get('start', '0s'))

        # Per-camera rightward delay, applied ONLY when that camera uses its
        # dedicated source (r_cam1_video / r_cam2_video), never a master crop.
        # A camera's border lane shares its camera's delay so the border and the
        # camera it frames move together on the timeline (matching the GS/SSB
        # hybrid path); otherwise the border would sit a few frames off the
        # camera at the segment edges. Lanes: 2=cam1, 3=cam1 border, 4=cam2,
        # 5=cam2 border. Empty video_offsets => all tau 0 => exact no-op.
        cam1_clip = video_clips_by_lane.get('2')
        cam2_clip = video_clips_by_lane.get('4')
        cam1_tau = (video_offsets.get('cam1', 0.0)
                    if cam1_clip is not None and cam1_clip.get('ref') == 'r_cam1_video'
                    else 0.0)
        cam2_tau = (video_offsets.get('cam2', 0.0)
                    if cam2_clip is not None and cam2_clip.get('ref') == 'r_cam2_video'
                    else 0.0)
        lane_tau = {'2': cam1_tau, '3': cam1_tau, '4': cam2_tau, '5': cam2_tau}

        # Add segmented clips for each lane
        for start_time, end_time, mode in segments:
            # The camera detector only emits 'solo' or 'dc'; anything else is a bug.
            if mode not in ('solo', 'dc'):
                raise ValueError(f"Unknown segment mode {mode!r} (expected 'solo' or 'dc')")
            duration_seconds = end_time - start_time
            start_str = self._seconds_to_time_str(start_time)
            duration_str = self._seconds_to_time_str(duration_seconds)

            # Process each video lane
            for lane in ['2', '3', '4', '5']:
                original_clip = video_clips_by_lane.get(lane)
                if original_clip is None:
                    continue

                # Delay this lane by its camera's measured offset (see lane_tau
                # above): cam1 and its border share cam1's delay; cam2 and its
                # border share cam2's delay. tau folds into the timeline offset
                # ONLY — start/duration are left unchanged.
                ref = original_clip.get('ref')
                tau = lane_tau.get(lane, 0.0)
                offset_str = self._delayed_segment_offset(start_time + gap_start_seconds, tau)

                # Create new clip for this segment
                new_clip = ET.Element('video')
                new_clip.set('ref', ref)
                new_clip.set('lane', lane)
                new_clip.set('offset', offset_str)
                new_clip.set('name', original_clip.get('name'))
                new_clip.set('start', start_str)  # In-point in source media (no gap offset)
                new_clip.set('duration', duration_str)

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

    def _generate_hybrid_gs(self, dc_gs_path: str, segments: List[Tuple[float, float, str]], output_dir: str,
                            video_offsets: Optional[Dict[str, float]] = None) -> str:
        """
        Generate hybrid GS compound.

        For SOLO segments: Disable cam2 and cam2 border
        For DC segments: Keep everything enabled
        """
        return self._generate_hybrid_simple(dc_gs_path, segments, output_dir, 'GS', video_offsets)

    def _generate_hybrid_ssb(self, dc_ssb_path: str, segments: List[Tuple[float, float, str]], output_dir: str,
                             video_offsets: Optional[Dict[str, float]] = None) -> str:
        """
        Generate hybrid SSB compound.

        For SOLO segments: Disable cam2 and cam2 border
        For DC segments: Keep everything enabled
        """
        return self._generate_hybrid_simple(dc_ssb_path, segments, output_dir, 'SSB', video_offsets)

    def _generate_hybrid_simple(self, dc_path: str, segments: List[Tuple[float, float, str]],
                                 output_dir: str, compound_type: str,
                                 video_offsets: Optional[Dict[str, float]] = None) -> str:
        """
        Generate hybrid compound for GS/SSB.

        These just need to disable cam2 and its border during SOLO segments.
        """
        video_offsets = video_offsets or {}
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
        gaps = spine.findall('gap')
        gap = gaps[-1]  # Content gap is the last one (first is empty trim gap)

        # Identify the cam2 video and cam2 border clips by the explicit lane numbers
        # that each DC generator assigns them (verified against dc_gs_generator.py and
        # dc_ssb_generator.py). The previous "top two lanes" heuristic mis-selected a
        # different layer whenever the cam2 border was not emitted.
        CAM2_LANES = {
            'GS': {'video': '8', 'border': '9'},    # dc_gs_generator.py
            'SSB': {'video': '6', 'border': '7'},   # dc_ssb_generator.py
        }
        if compound_type not in CAM2_LANES:
            raise ValueError(
                f"Unknown compound_type {compound_type!r} for hybrid simple "
                f"(expected one of {sorted(CAM2_LANES)})"
            )
        cam2_video_lane = CAM2_LANES[compound_type]['video']
        cam2_border_lane = CAM2_LANES[compound_type]['border']

        # Locate the cam2 video and cam2 border clips by their explicit lanes
        cam2_video_clip = None
        cam2_border_clip = None
        for child in list(gap):
            if child.tag == 'video':
                lane = child.get('lane')
                if lane == cam2_video_lane:
                    cam2_video_clip = child
                elif lane == cam2_border_lane:
                    cam2_border_clip = child

        if cam2_video_clip is None:
            raise ValueError(
                f"DC {compound_type} hybrid: cam2 video clip not found on lane {cam2_video_lane}"
            )

        # The border is optional — the DC generators only emit it when a border
        # asset is configured. Segment just the video in that case (previously the
        # top-two-lanes heuristic would grab an unrelated layer instead).
        if cam2_border_clip is None:
            print(
                f"  DC {compound_type} hybrid: no cam2 border on lane {cam2_border_lane} "
                "(none configured) — segmenting cam2 video only",
                file=sys.stderr
            )
            clips_to_segment = [cam2_video_clip]
        else:
            # Segment the border first, then the video (preserves original order)
            clips_to_segment = [cam2_border_clip, cam2_video_clip]

        # Remove these clips from gap
        for clip in clips_to_segment:
            gap.remove(clip)

        # Get content gap's coordinate offset for segment alignment
        gap_start_seconds = self._time_str_to_seconds(gap.get('start', '0s'))

        # Delay the DEDICATED cam2 source rightward by its measured offset, gated
        # STRICTLY on the cam2 VIDEO clip's ref: shift only when it uses its dedicated
        # source (r_cam2_video), never the master crop (r_original_video). The cam2
        # border SHARES the cam2 video's offset so the two stay locked together on the
        # timeline. tau folds into the timeline offset ONLY — start/duration unchanged.
        # video_offsets empty => tau 0 => exact no-op.
        if cam2_video_clip.get('ref') == 'r_cam2_video':
            cam2_tau = video_offsets.get('cam2', 0.0)
        else:
            cam2_tau = 0.0

        # Add segmented clips
        for start_time, end_time, mode in segments:
            # The camera detector only emits 'solo' or 'dc'; anything else is a bug.
            if mode not in ('solo', 'dc'):
                raise ValueError(f"Unknown segment mode {mode!r} (expected 'solo' or 'dc')")
            duration_seconds = end_time - start_time
            offset_str = self._delayed_segment_offset(start_time + gap_start_seconds, cam2_tau)
            start_str = self._seconds_to_time_str(start_time)
            duration_str = self._seconds_to_time_str(duration_seconds)

            for original_clip in clips_to_segment:
                new_clip = ET.Element('video')
                new_clip.set('ref', original_clip.get('ref'))
                new_clip.set('lane', original_clip.get('lane'))
                new_clip.set('offset', offset_str)
                new_clip.set('name', original_clip.get('name'))
                new_clip.set('start', start_str)  # In-point in source media (no gap offset)
                new_clip.set('duration', duration_str)

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

    def _delayed_segment_offset(self, timeline_seconds: float, tau_seconds: float) -> str:
        """Frame-aligned timeline offset delayed rightward by tau_seconds.

        The base timeline position and the delay are each rounded to whole
        29.97fps frames SEPARATELY and then added, so the applied delay is
        exactly round(tau) frames regardless of where the base falls between
        frames. This matches the DC generators' _add_time_fractions(base,
        round(tau)) path, keeping the SAME source aligned identically whether it
        is placed by a DC generator (GS/SSB) or rebuilt here (CAM/cam2). Folding
        tau into the seconds before a single round() would instead let the base's
        sub-frame remainder swallow or add a frame. tau_seconds == 0 => exactly
        the un-delayed base offset (no-op).
        """
        base_frames = round(timeline_seconds * 30000 / 1001)
        tau_frames = round(tau_seconds * 30000 / 1001) if tau_seconds else 0
        return f"{(base_frames + tau_frames) * 1001}/30000s"

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
