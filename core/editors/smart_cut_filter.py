# core/editors/smart_cut_filter.py

import sys
import xml.etree.ElementTree as ET
from typing import List, Tuple


class SmartCutFilter:
    """Cross-reference master and reference audio auto-editor outputs to preserve
    video-watching segments while still cutting true dead air.

    When recording reaction content, auto-editor removes ALL silences from the
    master track — including pauses where the creator is silently watching a video.
    This filter restores those cuts by checking if the reference audio (screen/game)
    was active during each silence gap.
    """

    @staticmethod
    def _time_str_to_seconds(time_str: str) -> float:
        """Convert FCPXML fractional time string to float seconds.

        Args:
            time_str: Time in FCPXML format, e.g. '30030/30000s' or '0s'

        Returns:
            Time in seconds as a float
        """
        if time_str.endswith('s'):
            time_str = time_str[:-1]
        if '/' in time_str:
            num, den = time_str.split('/')
            return int(num) / int(den)
        return float(time_str)

    def parse_kept_segments(self, xml_path: str) -> List[Tuple[float, float]]:
        """Parse auto-editor FCPXML and extract kept segments in source time.

        Each asset-clip in the spine represents a kept segment. The 'start'
        attribute is the source position and 'duration' is how long it plays.

        Args:
            xml_path: Path to auto-editor FCPXML output

        Returns:
            List of (source_start, source_end) tuples in seconds
        """
        tree = ET.parse(xml_path)
        root = tree.getroot()
        spine = root.find('.//spine')
        if spine is None:
            return []

        segments = []
        for clip in spine.findall('asset-clip'):
            start = self._time_str_to_seconds(clip.get('start', '0s'))
            duration = self._time_str_to_seconds(clip.get('duration', '0s'))
            segments.append((start, start + duration))

        return segments

    @staticmethod
    def _bridge_segments(segments: List[Tuple[float, float]],
                         max_gap: float = 4.0) -> List[Tuple[float, float]]:
        """Merge reference segments that have small gaps between them.

        When screen audio has brief dips (< max_gap seconds), the video is
        still playing — it's just a quiet moment, not a pause. This bridges
        those small gaps so the reference represents continuous viewing periods.

        Args:
            segments: Sorted list of (start, end) reference segments
            max_gap: Maximum gap in seconds to bridge (default 4s)

        Returns:
            Merged segment list with small gaps bridged
        """
        if not segments:
            return []

        merged = [segments[0]]
        for start, end in segments[1:]:
            prev_start, prev_end = merged[-1]
            if start - prev_end <= max_gap:
                merged[-1] = (prev_start, max(prev_end, end))
            else:
                merged.append((start, end))

        return merged

    def derive_gaps(self, segments: List[Tuple[float, float]]) -> List[Tuple[float, float]]:
        """Compute gaps (cut regions) between consecutive kept segments.

        Args:
            segments: Sorted list of (start, end) kept segments

        Returns:
            List of (gap_start, gap_end) tuples representing cut regions
        """
        gaps = []
        eps = 0.01  # Epsilon for float comparison noise

        for i in range(len(segments) - 1):
            gap_start = segments[i][1]
            gap_end = segments[i + 1][0]
            if gap_end - gap_start > eps:
                gaps.append((gap_start, gap_end))

        return gaps

    @staticmethod
    def _gap_contained_in(gap: Tuple[float, float],
                          segments: List[Tuple[float, float]],
                          tolerance: float = 0.05) -> bool:
        """Check if a gap is fully contained within any reference segment.

        Only restores gaps that are entirely within a screen-audio-active
        period. Gaps at the edges of reference segments (transitions between
        watching and talking) are kept as cuts.

        Args:
            gap: (start, end) of the gap to check
            segments: Sorted list of (start, end) reference kept segments
            tolerance: Small tolerance in seconds for edge alignment

        Returns:
            True if the gap is fully within a reference segment
        """
        gap_start, gap_end = gap
        for seg_start, seg_end in segments:
            if seg_start > gap_end:
                break
            if gap_start >= seg_start - tolerance and gap_end <= seg_end + tolerance:
                return True
        return False

    @staticmethod
    def _merge_segments(original_segments: List[Tuple[float, float]],
                        gaps_to_restore: List[Tuple[float, float]]) -> List[Tuple[float, float]]:
        """Merge original kept segments with restored gaps into a clean segment list.

        Combines both lists, sorts by start time, then performs standard interval
        merging so adjacent/overlapping intervals collapse into one.

        Args:
            original_segments: Original kept segments from master
            gaps_to_restore: Gap regions to restore (video was playing)

        Returns:
            Merged and sorted list of (start, end) segments
        """
        combined = sorted(original_segments + gaps_to_restore, key=lambda s: s[0])
        if not combined:
            return []

        merged = [combined[0]]
        for start, end in combined[1:]:
            prev_start, prev_end = merged[-1]
            # Merge if overlapping or adjacent (within epsilon)
            if start <= prev_end + 0.01:
                merged[-1] = (prev_start, max(prev_end, end))
            else:
                merged.append((start, end))

        return merged

    def _rewrite_xml(self, master_xml_path: str,
                     new_segments: List[Tuple[float, float]]) -> str:
        """Rewrite the master FCPXML spine with new segment list.

        Overwrites the master XML file in-place with updated asset-clip elements
        that reflect the filtered segments.

        Args:
            master_xml_path: Path to master auto-editor FCPXML
            new_segments: Filtered list of (source_start, source_end) segments

        Returns:
            The same master_xml_path (modified in-place)
        """
        tree = ET.parse(master_xml_path)
        root = tree.getroot()
        spine = root.find('.//spine')

        # Extract template attributes from existing clips
        template_clip = spine.find('asset-clip')
        clip_name = template_clip.get('name')
        clip_ref = template_clip.get('ref')
        clip_format = template_clip.get('format')
        clip_tcFormat = template_clip.get('tcFormat')

        # Detect time denominator from existing clip durations
        sample_duration = template_clip.get('duration', '1001/30000s')
        if sample_duration.endswith('s'):
            sample_duration = sample_duration[:-1]
        if '/' in sample_duration:
            _, denominator = sample_duration.split('/')
            denominator = int(denominator)
        else:
            denominator = 1

        # Clear spine and write new clips
        spine.clear()

        cumulative_offset = 0
        for seg_start, seg_end in new_segments:
            clip = ET.SubElement(spine, 'asset-clip')
            clip.set('name', clip_name)
            clip.set('ref', clip_ref)
            if clip_format:
                clip.set('format', clip_format)
            if clip_tcFormat:
                clip.set('tcFormat', clip_tcFormat)

            # Convert float seconds to FCPXML fractional time
            start_ticks = round(seg_start * denominator)
            duration_ticks = round((seg_end - seg_start) * denominator)

            clip.set('offset', f"{cumulative_offset}/{denominator}s")
            clip.set('duration', f"{duration_ticks}/{denominator}s")
            clip.set('start', f"{start_ticks}/{denominator}s")

            cumulative_offset += duration_ticks

        # Write back
        ET.indent(tree, space="    ", level=0)
        tree.write(master_xml_path, encoding='utf-8', xml_declaration=True)

        return master_xml_path

    def filter_cuts(self, master_xml: str, reference_xml: str) -> str:
        """Main entry point: filter master cuts using reference audio analysis.

        Restores master silence cuts where the reference audio (screen/game)
        was active, preserving video-watching segments. Gaps at the edges of
        reference segments (transitions between watching and talking) are kept
        as cuts to create clean transition breaks.

        Args:
            master_xml: Path to master auto-editor FCPXML
            reference_xml: Path to reference audio auto-editor FCPXML

        Returns:
            Path to modified master XML (same file, overwritten in-place)
        """
        # 1. Parse both XMLs into kept segment lists
        master_segments = self.parse_kept_segments(master_xml)
        reference_segments = self.parse_kept_segments(reference_xml)

        print(f"Smart cut filter: {len(master_segments)} master segments, "
              f"{len(reference_segments)} raw reference segments", file=sys.stderr)

        if not master_segments:
            print("Smart cut filter: no master segments found, skipping",
                  file=sys.stderr)
            return master_xml

        # 2. Bridge small gaps in reference segments (< 4s = still watching)
        reference_segments = self._bridge_segments(reference_segments, max_gap=4.0)
        print(f"Smart cut filter: {len(reference_segments)} reference segments "
              f"after bridging gaps < 4s", file=sys.stderr)

        # 3. Derive gaps from master segments
        master_gaps = self.derive_gaps(master_segments)
        print(f"Smart cut filter: {len(master_gaps)} gaps (cut regions) in master",
              file=sys.stderr)

        if not master_gaps:
            print("Smart cut filter: no gaps to analyze, skipping", file=sys.stderr)
            return master_xml

        # 4. For each gap, check if fully contained within a reference segment.
        #    Gaps at the edges of reference segments are transitions — keep those cuts.
        gaps_to_restore = []
        gaps_to_keep = []

        for gap in master_gaps:
            if self._gap_contained_in(gap, reference_segments):
                gaps_to_restore.append(gap)
            else:
                gaps_to_keep.append(gap)

        print(f"Smart cut filter: restoring {len(gaps_to_restore)} gaps "
              f"(video playing), keeping {len(gaps_to_keep)} cuts (dead air + transitions)",
              file=sys.stderr)

        if not gaps_to_restore:
            print("Smart cut filter: no gaps to restore, master XML unchanged",
                  file=sys.stderr)
            return master_xml

        # 5. Merge original segments with restored gaps
        filtered_segments = self._merge_segments(master_segments, gaps_to_restore)
        print(f"Smart cut filter: {len(master_segments)} segments -> "
              f"{len(filtered_segments)} segments after merge", file=sys.stderr)

        # 6. Rewrite master XML with filtered segments
        result = self._rewrite_xml(master_xml, filtered_segments)

        # 7. Log summary
        total_restored = sum(g[1] - g[0] for g in gaps_to_restore)
        total_kept_cut = sum(g[1] - g[0] for g in gaps_to_keep)
        print(f"Smart cut filter: restored {total_restored:.1f}s of viewing time, "
              f"kept {total_kept_cut:.1f}s of cuts (dead air + transitions)",
              file=sys.stderr)

        return result
