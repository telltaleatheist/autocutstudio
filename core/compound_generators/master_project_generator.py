# core/compound_generators/master_project_generator.py

import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import quote
import uuid
import datetime
import subprocess
import json
import sys

from ..xml_utils import FCPXMLUtils

class MasterProjectGenerator:
    """Generate master projects combining CAM, GS, and SSB compound clips."""
    
    def __init__(self, config):
        self.config = config
        self.xml_utils = FCPXMLUtils()
        self.detected_framerate = None  # Will be auto-detected
    
    def detect_framerate(self, video_path: str) -> str:
        """Detect framerate from video file using ffprobe."""
        try:
            cmd = [
                'ffprobe', '-v', 'error', '-select_streams', 'v:0',
                '-show_entries', 'stream=r_frame_rate',
                '-of', 'json', video_path
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            data = json.loads(result.stdout)
            
            if 'streams' in data and len(data['streams']) > 0:
                r_frame_rate = data['streams'][0].get('r_frame_rate', '30000/1001')
                num, den = map(int, r_frame_rate.split('/'))
                fps = num / den
                
                # Determine framerate type
                if abs(fps - 29.97) < 0.01:
                    self.detected_framerate = "29.97"
                elif abs(fps - 30.0) < 0.01:
                    self.detected_framerate = "30"
                elif abs(fps - 23.976) < 0.01:
                    self.detected_framerate = "23.976"
                elif abs(fps - 24.0) < 0.01:
                    self.detected_framerate = "24"
                elif abs(fps - 25.0) < 0.01:
                    self.detected_framerate = "25"
                elif abs(fps - 60.0) < 0.01:
                    self.detected_framerate = "60"
                elif abs(fps - 59.94) < 0.01:
                    self.detected_framerate = "59.94"
                else:
                    self.detected_framerate = "29.97"  # Default fallback
                
                print(f"Detected framerate: {self.detected_framerate} fps", file=sys.stderr)
                return self.detected_framerate

        except Exception as e:
            print(f"Could not detect framerate, defaulting to 29.97: {e}", file=sys.stderr)
            self.detected_framerate = "29.97"
            return self.detected_framerate
    
    def generate_solo_master_project(self, cam_xml_path: str, gs_xml_path: str,
                                   ssb_xml_path: str, original_name: str,
                                   output_path: Optional[str] = None) -> List[str]:
        """Generate SOLO master project combining CAM, GS, and SSB compounds.

        Returns:
            List of paths to generated project files (may be multiple if split into parts)
        """
        return self._generate_master_project(
            cam_xml_path, gs_xml_path, ssb_xml_path,
            original_name, "SOLO", output_path
        )

    def generate_dc_master_project(self, cam_xml_path: str, gs_xml_path: str,
                                 ssb_xml_path: str, original_name: str,
                                 output_path: Optional[str] = None) -> List[str]:
        """Generate DC (Dual Camera) master project combining CAM, GS, and SSB compounds.

        Returns:
            List of paths to generated project files (may be multiple if split into parts)
        """
        return self._generate_master_project(
            cam_xml_path, gs_xml_path, ssb_xml_path,
            original_name, "DC", output_path
        )
    
    def _extract_compound_info(self, xml_path: str) -> Tuple[str, ET.Element, List[ET.Element]]:
        """Extract compound media ID, media element, and timeline cuts from an XML file."""
        tree = self.xml_utils.parse_fcpxml(xml_path)
        
        # Find the compound media element (should have a sequence child)
        compound_media = None
        compound_id = None
        
        for media in tree.findall('.//media'):
            if media.find('sequence') is not None:
                compound_media = media
                compound_id = media.get('id')
                break
        
        if not compound_media or not compound_id:
            raise ValueError(f"Could not find compound media in {xml_path}")
        
        # Extract timeline cuts (ref-clips in the project spine)
        project = tree.find('.//project')
        if project is None:
            raise ValueError(f"Could not find project in {xml_path}")
        
        project_sequence = project.find('sequence')
        if project_sequence is None:
            raise ValueError(f"Could not find project sequence in {xml_path}")
        
        spine = project_sequence.find('spine')
        if spine is None:
            raise ValueError(f"Could not find spine in {xml_path}")
        
        ref_clips = spine.findall('ref-clip')
        
        return compound_id, compound_media, ref_clips
    
    def _extract_all_resources(self, xml_path: str) -> Dict[str, ET.Element]:
        """Extract all resource elements from an XML file."""
        tree = self.xml_utils.parse_fcpxml(xml_path)
        resources = {}
        
        resources_elem = tree.find('.//resources')
        if resources_elem:
            for element in resources_elem:
                element_id = element.get('id')
                if element_id:
                    resources[element_id] = element
        
        return resources
    
    def _align_to_frame_boundary(self, time_str: str) -> str:
        """Align time values to proper frame boundaries for the detected framerate."""
        if not time_str or time_str == '0s':
            return '0s'

        if '/' not in time_str:
            return time_str

        # Parse the time value
        parts = time_str.replace('s', '').split('/')
        if len(parts) != 2:
            return time_str

        numerator = int(parts[0])
        denominator = int(parts[1])

        # Convert to seconds first
        time_in_seconds = numerator / denominator

        if self.detected_framerate == "29.97":
            # For 29.97fps, frame duration is 1001/30000s
            frame_duration = 1001 / 30000  # 29.97fps frame duration

            # Round to nearest frame
            frame_number = round(time_in_seconds / frame_duration)

            # Convert back to fractional format - KEEP in 30000 denominator, don't simplify
            aligned_numerator = frame_number * 1001
            aligned_denominator = 30000

            return f"{aligned_numerator}/{aligned_denominator}s"

        elif self.detected_framerate == "30":
            # For 30fps, frame duration is 1/30s
            frame_duration = 1 / 30

            # Round to nearest frame
            frame_number = round(time_in_seconds / frame_duration)

            # Convert back to fractional format
            return f"{frame_number}/30s"

        elif self.detected_framerate == "23.976":
            # For 23.976fps, frame duration is 1001/24000s
            frame_duration = 1001 / 24000

            # Round to nearest frame
            frame_number = round(time_in_seconds / frame_duration)

            # Convert back to fractional format
            aligned_numerator = frame_number * 1001
            aligned_denominator = 24000

            return f"{aligned_numerator}/{aligned_denominator}s"

        elif self.detected_framerate == "24":
            # For 24fps, frame duration is 1/24s
            frame_duration = 1 / 24

            # Round to nearest frame
            frame_number = round(time_in_seconds / frame_duration)

            return f"{frame_number}/24s"

        # For other framerates, convert to 30000 denominator as fallback
        frame_duration = 1001 / 30000
        frame_number = round(time_in_seconds / frame_duration)
        aligned_numerator = frame_number * 1001
        aligned_denominator = 30000
        return f"{aligned_numerator}/{aligned_denominator}s"
    
    def _convert_time_format(self, time_str: str) -> str:
        """Convert and align time format based on detected framerate."""
        return self._align_to_frame_boundary(time_str)
    
    def _copy_element_with_conversion(self, source_elem: ET.Element, target_parent: ET.Element):
        """Copy element structure while converting time values to proper framerate format."""
        elem_copy = ET.SubElement(target_parent, source_elem.tag)
        
        # Copy all attributes, converting time values
        for attr, value in source_elem.attrib.items():
            if attr in ['duration', 'offset', 'start']:
                converted_value = self._convert_time_format(value)
                elem_copy.set(attr, converted_value)
            else:
                elem_copy.set(attr, value)
        
        # Copy text content
        if source_elem.text and source_elem.text.strip():
            elem_copy.text = source_elem.text
        if source_elem.tail and source_elem.tail.strip():
            elem_copy.tail = source_elem.tail
        
        # Recursively copy children
        for child in source_elem:
            self._copy_element_with_conversion(child, elem_copy)
        
        return elem_copy
    
    def _generate_master_project(self, cam_xml_path: str, gs_xml_path: str,
                                ssb_xml_path: str, original_name: str,
                                project_type: str, output_path: Optional[str] = None) -> List[str]:
        """Generate master project by building a new timeline structure from scratch.

        Projects are automatically split into ~1 hour segments to avoid large XML files.

        Returns:
            List of paths to generated project files (may be multiple if split into parts)
        """

        # Only print the essential first line - details go to stderr
        print(f"Generating {project_type} master project...", file=sys.stderr)

        # Extract compound info from each XML
        cam_id, cam_media, cam_cuts = self._extract_compound_info(cam_xml_path)
        gs_id, gs_media, _ = self._extract_compound_info(gs_xml_path)
        ssb_id, ssb_media, _ = self._extract_compound_info(ssb_xml_path)

        # Split cuts into segments (automatically determined by total duration)
        segments = self._split_clips_into_segments(cam_cuts)

        # Extract all resources from all three XMLs
        all_resources = {}
        for xml_path in [cam_xml_path, gs_xml_path, ssb_xml_path]:
            resources = self._extract_all_resources(xml_path)
            all_resources.update(resources)

        # Generate consistent UIDs for compounds and event that will be shared across all parts
        # This ensures that when multiple parts are imported into FCPX, they reference
        # the same compound clips and event instead of creating duplicates
        shared_uids = {
            'cam': str(uuid.uuid4()).upper(),
            'gs': str(uuid.uuid4()).upper(),
            'ssb': str(uuid.uuid4()).upper(),
            'event': str(uuid.uuid4()).upper()  # Shared event UID
        }

        # Generate combined project file (single file with multiple projects)
        # This ensures all projects share the same compound clips
        output_file = self._generate_combined_project(
            cam_media, gs_media, ssb_media,
            segments, all_resources,
            original_name, project_type,
            cam_xml_path, output_path, shared_uids
        )
        print(f"Master project saved: {output_file}", file=sys.stderr)

        return [output_file]

    def _generate_project_segment(self, cam_media: ET.Element, gs_media: ET.Element,
                                  ssb_media: ET.Element, cam_cuts: List[ET.Element],
                                  all_resources: Dict[str, ET.Element],
                                  original_name: str, project_type: str, part_suffix: str,
                                  cam_xml_path: str, output_path: Optional[str] = None,
                                  shared_uids: Optional[Dict[str, str]] = None) -> str:
        """Generate a single project segment with the given cuts.

        Args:
            shared_uids: Dict with 'cam', 'gs', 'ssb' keys containing UIDs to use for compounds.
                        If None, new UIDs will be generated.
        """
        
        # Build the master project XML
        root = ET.Element('fcpxml')
        root.set('version', '1.13')
        
        # Resources section
        resources_elem = ET.SubElement(root, 'resources')
        
        # Add timeline format based on detected framerate
        timeline_format = ET.SubElement(resources_elem, 'format')
        timeline_format.set('id', 'r1')
        
        if self.detected_framerate == "30":
            timeline_format.set('name', 'FFVideoFormat1080p30')
            timeline_format.set('frameDuration', '1/30s')
        else:  # Default to 29.97
            timeline_format.set('name', 'FFVideoFormat1080p2997')
            timeline_format.set('frameDuration', '1001/30000s')
        
        timeline_format.set('width', '1920')
        timeline_format.set('height', '1080')
        timeline_format.set('colorSpace', '1-1-1 (Rec. 709)')
        
        # Add compound format (matches timeline format)
        compound_format = ET.SubElement(resources_elem, 'format')
        compound_format.set('id', 'r3')
        
        if self.detected_framerate == "30":
            compound_format.set('name', 'FFVideoFormat1080p30')
            compound_format.set('frameDuration', '1/30s')
        else:  # Default to 29.97
            compound_format.set('name', 'FFVideoFormat1080p2997')
            compound_format.set('frameDuration', '1001/30000s')
        
        compound_format.set('width', '1920')
        compound_format.set('height', '1080')
        compound_format.set('colorSpace', '1-1-1 (Rec. 709)')
        
        # Add the three compound media elements with updated names
        cam_media_copy = ET.SubElement(resources_elem, 'media')
        cam_media_copy.set('id', 'r2')  # Use consistent IDs like template
        cam_name = f"{original_name} - CAM" if project_type == "SOLO" else f"{original_name} - DC CAM"
        cam_media_copy.set('name', cam_name)
        # Use shared UID if provided, otherwise generate new one
        cam_uid = shared_uids['cam'] if shared_uids else str(uuid.uuid4()).upper()
        cam_media_copy.set('uid', cam_uid)
        cam_media_copy.set('modDate', datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S -0400"))
        
        # Copy the sequence from the original CAM compound
        cam_sequence = cam_media.find('sequence')
        if cam_sequence is not None:
            cam_sequence_copy = ET.SubElement(cam_media_copy, 'sequence')
            for attr, value in cam_sequence.attrib.items():
                if attr == 'format':
                    cam_sequence_copy.set('format', 'r3')  # Use compound format
                elif attr == 'duration':
                    # Convert duration to proper framerate format
                    converted_duration = self._convert_time_format(value)
                    cam_sequence_copy.set(attr, converted_duration)
                else:
                    cam_sequence_copy.set(attr, value)
            
            # Copy the spine structure and convert any time values
            cam_spine = cam_sequence.find('spine')
            if cam_spine is not None:
                self._copy_element_with_conversion(cam_spine, cam_sequence_copy)
        
        # SSB compound
        ssb_media_copy = ET.SubElement(resources_elem, 'media')
        ssb_media_copy.set('id', 'r6')  # Use consistent IDs like template
        ssb_name = f"{original_name} - SSB" if project_type == "SOLO" else f"{original_name} - DC SSB"
        ssb_media_copy.set('name', ssb_name)
        # Use shared UID if provided, otherwise generate new one
        ssb_uid = shared_uids['ssb'] if shared_uids else str(uuid.uuid4()).upper()
        ssb_media_copy.set('uid', ssb_uid)
        ssb_media_copy.set('modDate', datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S -0400"))
        
        # Copy the sequence from the original SSB compound
        ssb_sequence = ssb_media.find('sequence')
        if ssb_sequence is not None:
            ssb_sequence_copy = ET.SubElement(ssb_media_copy, 'sequence')
            for attr, value in ssb_sequence.attrib.items():
                if attr == 'format':
                    ssb_sequence_copy.set('format', 'r3')  # Use compound format
                elif attr == 'duration':
                    # Convert duration to proper framerate format
                    converted_duration = self._convert_time_format(value)
                    ssb_sequence_copy.set(attr, converted_duration)
                else:
                    ssb_sequence_copy.set(attr, value)
            
            # Copy the spine structure and convert any time values
            ssb_spine = ssb_sequence.find('spine')
            if ssb_spine is not None:
                self._copy_element_with_conversion(ssb_spine, ssb_sequence_copy)
        
        # GS compound
        gs_media_copy = ET.SubElement(resources_elem, 'media')
        gs_media_copy.set('id', 'r12')  # Use consistent IDs like template
        gs_name = f"{original_name} - GS" if project_type == "SOLO" else f"{original_name} - DC GS"
        gs_media_copy.set('name', gs_name)
        # Use shared UID if provided, otherwise generate new one
        gs_uid = shared_uids['gs'] if shared_uids else str(uuid.uuid4()).upper()
        gs_media_copy.set('uid', gs_uid)
        gs_media_copy.set('modDate', datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S -0400"))
        
        # Copy the sequence from the original GS compound
        gs_sequence = gs_media.find('sequence')
        if gs_sequence is not None:
            gs_sequence_copy = ET.SubElement(gs_media_copy, 'sequence')
            for attr, value in gs_sequence.attrib.items():
                if attr == 'format':
                    gs_sequence_copy.set('format', 'r3')  # Use compound format
                elif attr == 'duration':
                    # Convert duration to proper framerate format
                    converted_duration = self._convert_time_format(value)
                    gs_sequence_copy.set(attr, converted_duration)
                else:
                    gs_sequence_copy.set(attr, value)
            
            # Copy the spine structure and convert any time values
            gs_spine = gs_sequence.find('spine')
            if gs_spine is not None:
                self._copy_element_with_conversion(gs_spine, gs_sequence_copy)
        
        # Add other necessary resources (assets, effects, etc.) from original files
        # Skip the compound media elements we already added
        skip_ids = {'r1', 'r2', 'r3', 'r6', 'r12'}

        for resource_id, resource in all_resources.items():
            if resource_id not in skip_ids and resource.tag != 'media':
                resources_elem.append(resource)

        # Create library structure
        # Derive library location from output path - use parent directory of output XML
        library = ET.SubElement(root, 'library')
        if output_path:
            output_parent = Path(output_path).parent.parent  # Go up from /files/ to date folder
            encoded_path = quote(f'{output_parent}/{original_name}.fcpbundle/', safe='/:')
            library_location = f'file://{encoded_path}'
        else:
            # Fallback: use input file's location
            cam_parent = Path(cam_xml_path).parent.parent
            encoded_path = quote(f'{cam_parent}/{original_name}.fcpbundle/', safe='/:')
            library_location = f'file://{encoded_path}'
        library.set('location', library_location)

        event = ET.SubElement(library, 'event')
        event.set('name', 'Auto-Editor Media Group')
        # Use shared event UID if provided, otherwise generate new one
        event_uid = shared_uids['event'] if shared_uids else str(uuid.uuid4()).upper()
        event.set('uid', event_uid)

        project = ET.SubElement(event, 'project')
        project_name = f"{original_name} {project_type.lower()}{part_suffix}"
        project.set('name', project_name)
        project.set('uid', str(uuid.uuid4()).upper())
        project.set('modDate', datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S -0400"))
        
        # Create the main timeline sequence
        # Calculate total duration from cam_cuts
        total_duration = self._calculate_total_duration(cam_cuts)
        
        sequence = ET.SubElement(project, 'sequence')
        sequence.set('format', 'r1')
        sequence.set('duration', total_duration)
        sequence.set('tcStart', '0s')
        sequence.set('tcFormat', 'NDF')
        sequence.set('audioLayout', 'stereo')
        sequence.set('audioRate', '48k')
        
        spine = ET.SubElement(sequence, 'spine')

        # Calculate the offset adjustment for this segment
        # (subtract the first clip's offset so the segment starts at 0s)
        segment_start_offset_str = '0s'
        if cam_cuts:
            segment_start_offset_str = cam_cuts[0].get('offset', '0s')

        # Build timeline with multi-lane structure for each cut
        # Track expected offset to ensure continuity
        expected_offset = "0s"

        for i, ref_clip in enumerate(cam_cuts):
            # Get timing from original cut
            offset = ref_clip.get('offset', '0s')
            duration = ref_clip.get('duration', '30/30s')
            start = ref_clip.get('start', '0s')

            # Convert duration and start to proper framerate
            converted_duration = self._convert_time_format(duration)
            converted_start = self._convert_time_format(start)

            # Use expected_offset for continuity (only convert first clip's offset)
            if i == 0:
                # First clip: adjust and convert offset
                adjusted_offset = self._subtract_time_fractions(offset, segment_start_offset_str)
                converted_offset = self._convert_time_format(adjusted_offset)
                expected_offset = converted_offset
            else:
                # Subsequent clips: use expected offset to maintain continuity
                converted_offset = expected_offset
            
            # Create main CAM ref-clip (video only)
            main_clip = ET.SubElement(spine, 'ref-clip')
            main_clip.set('ref', 'r2')  # CAM compound
            main_clip.set('offset', converted_offset)
            main_clip.set('name', cam_name)
            main_clip.set('duration', converted_duration)
            main_clip.set('srcEnable', 'video')  # Video only for main spine
            
            # Adjust start time if present
            if converted_start != '0s':
                main_clip.set('start', converted_start)

            # Lane -1: CAM audio (master audio - topmost audio lane)
            cam_audio = ET.SubElement(main_clip, 'ref-clip')
            cam_audio.set('ref', 'r2')  # CAM compound
            cam_audio.set('lane', '-1')
            # Nested clips offset matches start for proper frame alignment
            cam_audio.set('offset', converted_start)
            cam_audio.set('name', cam_name)
            cam_audio.set('duration', converted_duration)
            cam_audio.set('srcEnable', 'audio')  # Audio only
            if converted_start != '0s':
                cam_audio.set('start', converted_start)

            # Lane -2: SSB audio (below master audio)
            ssb_audio = ET.SubElement(main_clip, 'ref-clip')
            ssb_audio.set('ref', 'r6')  # SSB compound
            ssb_audio.set('lane', '-2')
            # Nested clips offset matches start for proper frame alignment
            ssb_audio.set('offset', converted_start)
            ssb_audio.set('name', ssb_name)
            ssb_audio.set('duration', converted_duration)
            ssb_audio.set('srcEnable', 'audio')  # Audio only
            if converted_start != '0s':
                ssb_audio.set('start', converted_start)

            # Lane 1: GS (muted)
            gs_clip = ET.SubElement(main_clip, 'ref-clip')
            gs_clip.set('ref', 'r12')  # GS compound
            gs_clip.set('lane', '1')
            # Nested clips offset matches start for proper frame alignment
            gs_clip.set('offset', converted_start)
            gs_clip.set('name', gs_name)
            gs_clip.set('duration', converted_duration)
            if converted_start != '0s':
                gs_clip.set('start', converted_start)

            # Mute GS audio
            gs_volume = ET.SubElement(gs_clip, 'adjust-volume')
            gs_volume.set('amount', '-96dB')

            # Lane 2: SSB video
            ssb_video = ET.SubElement(main_clip, 'ref-clip')
            ssb_video.set('ref', 'r6')  # SSB compound
            ssb_video.set('lane', '2')
            # Nested clips offset matches start for proper frame alignment
            ssb_video.set('offset', converted_start)
            ssb_video.set('name', ssb_name)
            ssb_video.set('duration', converted_duration)
            ssb_video.set('srcEnable', 'video')  # Video only
            if converted_start != '0s':
                ssb_video.set('start', converted_start)

            # Calculate next expected offset to maintain continuity
            expected_offset = self._add_time_fractions(converted_offset, converted_duration)
        
        # Add smart collections
        self._add_smart_collections(library)
        
        # Save the master project XML
        if output_path is None:
            if part_suffix:
                # Extract part number from suffix like " part 1"
                output_filename = f"{original_name}_{project_type}{part_suffix.replace(' ', '_')}.fcpxml"
            else:
                output_filename = f"{original_name}_{project_type}.fcpxml"
            output_path = Path(cam_xml_path).parent / output_filename
        else:
            # If output_path was provided, add part suffix to it
            if part_suffix:
                base_path = Path(output_path)
                output_path = base_path.parent / f"{base_path.stem}{part_suffix.replace(' ', '_')}{base_path.suffix}"

        tree = ET.ElementTree(root)
        self.xml_utils.save_fcpxml(tree, str(output_path))

        return str(output_path)
    
    def _parse_time_to_seconds(self, time_str: str) -> float:
        """Parse FCPXML time string to seconds."""
        if not time_str or time_str == '0s':
            return 0.0

        time_str = time_str.replace('s', '')
        if '/' in time_str:
            parts = time_str.split('/')
            if len(parts) == 2:
                return float(parts[0]) / float(parts[1])

        try:
            return float(time_str)
        except:
            return 0.0

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

    def _subtract_time_fractions(self, time_str1: str, time_str2: str) -> str:
        """Subtract two time values using fraction math to avoid rounding errors."""
        if not time_str1 or time_str1 == '0s':
            return '0s'
        if not time_str2 or time_str2 == '0s':
            return time_str1

        # Parse first time
        t1 = time_str1.replace('s', '')
        if '/' in t1:
            num1, den1 = map(int, t1.split('/'))
        else:
            num1, den1 = int(float(t1) * 30000), 30000

        # Parse second time
        t2 = time_str2.replace('s', '')
        if '/' in t2:
            num2, den2 = map(int, t2.split('/'))
        else:
            num2, den2 = int(float(t2) * 30000), 30000

        # Subtract: a/b - c/d = (a*d - c*b)/(b*d)
        # But normalize to common denominator 30000
        if den1 == den2 == 30000:
            result_num = num1 - num2
            result_den = 30000
        else:
            result_num = num1 * den2 - num2 * den1
            result_den = den1 * den2
            # Normalize to 30000
            result_num = int(result_num * 30000 / result_den)
            result_den = 30000

        if result_num == 0:
            return '0s'

        return f"{result_num}/{result_den}s"

    def _seconds_to_time_str(self, seconds: float) -> str:
        """Convert seconds to FCPXML time string format."""
        if seconds == 0:
            return '0s'

        # Use appropriate time base for framerate
        if self.detected_framerate == "29.97":
            # 29.97fps uses 30000 denominator - keep it consistent, don't simplify
            numerator = int(round(seconds * 30000))
            denominator = 30000
        elif self.detected_framerate == "30":
            numerator = int(round(seconds * 30))
            denominator = 30
        else:
            # Default to 29.97
            numerator = int(round(seconds * 30000))
            denominator = 30000

        # Do NOT simplify the fraction - keep consistent denominator
        return f"{numerator}/{denominator}s"

    def _calculate_total_duration(self, ref_clips: List[ET.Element]) -> str:
        """Calculate total duration from ref-clips."""
        if not ref_clips:
            return "0s"

        # Get the last ref-clip's offset and duration
        last_clip = ref_clips[-1]
        offset = last_clip.get('offset', '0s')
        duration = last_clip.get('duration', '0s')

        # Parse and add offset + duration for total timeline length
        def parse_time(time_str):
            if '/' in time_str:
                parts = time_str.replace('s', '').split('/')
                if len(parts) == 2:
                    return int(parts[0]), int(parts[1])
            return 0, 1

        offset_num, offset_den = parse_time(offset)
        duration_num, duration_den = parse_time(duration)

        # Add fractions: a/b + c/d = (a*d + c*b)/(b*d)
        if offset_den == duration_den:
            total_num = offset_num + duration_num
            total_den = offset_den
        else:
            total_num = (offset_num * duration_den) + (duration_num * offset_den)
            total_den = offset_den * duration_den

        # Simplify if possible
        from math import gcd
        divisor = gcd(total_num, total_den)
        total_num //= divisor
        total_den //= divisor

        # Convert to appropriate format based on detected framerate
        return self._convert_time_format(f"{total_num}/{total_den}s")

    def _find_nearest_cut_for_split(self, ref_clips: List[ET.Element], target_seconds: float) -> int:
        """Find the index of the cut nearest to the target time in seconds."""
        best_index = 0
        best_diff = float('inf')

        for i, clip in enumerate(ref_clips):
            offset = clip.get('offset', '0s')
            offset_seconds = self._parse_time_to_seconds(offset)

            diff = abs(offset_seconds - target_seconds)
            if diff < best_diff:
                best_diff = diff
                best_index = i

        return best_index

    def _split_clips_into_segments(self, ref_clips: List[ET.Element]) -> List[List[ET.Element]]:
        """Split ref_clips into roughly equal ~1 hour segments based on total duration.

        Logic:
        - Calculate total hours
        - Determine number of segments: round(total_hours) with minimum of 1
        - Split into that many equal segments at nearest cut points
        - Each segment will be approximately 1 hour (or total/segments if < 1 hour)

        Examples:
        - 1h45m → 2 segments of ~52m each (round(1.75) = 2)
        - 4h00m → 4 segments of ~60m each (round(4) = 4)
        - 2h30m → 3 segments of ~50m each (round(2.5) = 3)
        - 45m → 1 segment (round(0.75) = 1, under 1 hour, no split)
        - 90m → 2 segments of ~45m each (round(1.5) = 2)

        Args:
            ref_clips: List of ref-clip elements to split

        Returns:
            List of segment lists, each containing ref-clips for that segment
        """
        if not ref_clips:
            return []

        # Calculate total duration in seconds
        last_clip = ref_clips[-1]
        last_offset = self._parse_time_to_seconds(last_clip.get('offset', '0s'))
        last_duration = self._parse_time_to_seconds(last_clip.get('duration', '0s'))
        total_seconds = last_offset + last_duration
        total_hours = total_seconds / 3600  # 3600 seconds = 1 hour

        # Calculate number of segments based on total hours (rounded to nearest)
        num_segments = max(1, round(total_hours))

        # If less than 1 hour (rounds to 1), don't split
        if num_segments == 1:
            return [ref_clips]

        # Calculate segment duration (divide total by number of segments for equal parts)
        segment_seconds = total_seconds / num_segments

        segments = []
        current_segment_start = 0

        for segment_num in range(num_segments):
            # Calculate target end time for this segment
            target_time = (segment_num + 1) * segment_seconds

            # If this is the last segment, take all remaining clips
            if segment_num == num_segments - 1:
                segment_clips = ref_clips[current_segment_start:]
                segments.append(segment_clips)
                break

            # Find nearest cut point to target_time
            split_index = self._find_nearest_cut_for_split(ref_clips, target_time)

            # Make sure we're making progress (at least 1 clip per segment)
            if split_index <= current_segment_start:
                split_index = current_segment_start + 1

            # Add this segment
            segment_clips = ref_clips[current_segment_start:split_index]
            segments.append(segment_clips)

            current_segment_start = split_index

        return segments
    
    def _add_smart_collections(self, library: ET.Element):
        """Add standard smart collections to the library."""
        # Projects collection
        projects = ET.SubElement(library, 'smart-collection')
        projects.set('name', 'Projects')
        projects.set('match', 'all')
        match_clip = ET.SubElement(projects, 'match-clip')
        match_clip.set('rule', 'is')
        match_clip.set('type', 'project')
        
        # All Video collection
        all_video = ET.SubElement(library, 'smart-collection')
        all_video.set('name', 'All Video')
        all_video.set('match', 'any')
        match_media1 = ET.SubElement(all_video, 'match-media')
        match_media1.set('rule', 'is')
        match_media1.set('type', 'videoOnly')
        match_media2 = ET.SubElement(all_video, 'match-media')
        match_media2.set('rule', 'is')
        match_media2.set('type', 'videoWithAudio')
        
        # Audio Only collection
        audio_only = ET.SubElement(library, 'smart-collection')
        audio_only.set('name', 'Audio Only')
        audio_only.set('match', 'all')
        match_media = ET.SubElement(audio_only, 'match-media')
        match_media.set('rule', 'is')
        match_media.set('type', 'audioOnly')
        
        # Stills collection
        stills = ET.SubElement(library, 'smart-collection')
        stills.set('name', 'Stills')
        stills.set('match', 'all')
        match_media = ET.SubElement(stills, 'match-media')
        match_media.set('rule', 'is')
        match_media.set('type', 'stills')
        
        # Favorites collection
        favorites = ET.SubElement(library, 'smart-collection')
        favorites.set('name', 'Favorites')
        favorites.set('match', 'all')
        match_ratings = ET.SubElement(favorites, 'match-ratings')
        match_ratings.set('value', 'favorites')

    def _generate_combined_project(self, cam_media: ET.Element, gs_media: ET.Element,
                                  ssb_media: ET.Element, segments: List[List[ET.Element]],
                                  all_resources: Dict[str, ET.Element],
                                  original_name: str, project_type: str,
                                  cam_xml_path: str, output_path: Optional[str] = None,
                                  shared_uids: Optional[Dict[str, str]] = None) -> str:
        """Generate a single FCPXML file containing multiple projects (one per segment).

        This ensures all projects share the same compound clips since they're in the same file.

        Args:
            segments: List of segment cuts, where each segment is a list of ref-clips
            shared_uids: Dict with 'cam', 'gs', 'ssb', 'event' UIDs

        Returns:
            Path to the generated combined project file
        """
        # Build the master project XML
        root = ET.Element('fcpxml')
        root.set('version', '1.13')

        # Resources section (shared across all projects)
        resources_elem = ET.SubElement(root, 'resources')

        # Add timeline format based on detected framerate
        timeline_format = ET.SubElement(resources_elem, 'format')
        timeline_format.set('id', 'r1')

        if self.detected_framerate == "30":
            timeline_format.set('name', 'FFVideoFormat1080p30')
            timeline_format.set('frameDuration', '1/30s')
        else:  # Default to 29.97
            timeline_format.set('name', 'FFVideoFormat1080p2997')
            timeline_format.set('frameDuration', '1001/30000s')

        timeline_format.set('width', '1920')
        timeline_format.set('height', '1080')
        timeline_format.set('colorSpace', '1-1-1 (Rec. 709)')

        # Add compound format (matches timeline format)
        compound_format = ET.SubElement(resources_elem, 'format')
        compound_format.set('id', 'r3')

        if self.detected_framerate == "30":
            compound_format.set('name', 'FFVideoFormat1080p30')
            compound_format.set('frameDuration', '1/30s')
        else:  # Default to 29.97
            compound_format.set('name', 'FFVideoFormat1080p2997')
            compound_format.set('frameDuration', '1001/30000s')

        compound_format.set('width', '1920')
        compound_format.set('height', '1080')
        compound_format.set('colorSpace', '1-1-1 (Rec. 709)')

        # Add the three compound media elements (shared across all projects)
        cam_media_copy = ET.SubElement(resources_elem, 'media')
        cam_media_copy.set('id', 'r2')
        cam_name = f"{original_name} - CAM" if project_type == "SOLO" else f"{original_name} - DC CAM"
        cam_media_copy.set('name', cam_name)
        cam_uid = shared_uids['cam'] if shared_uids else str(uuid.uuid4()).upper()
        cam_media_copy.set('uid', cam_uid)
        cam_media_copy.set('modDate', datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S -0400"))

        # Copy CAM sequence
        cam_sequence = cam_media.find('sequence')
        if cam_sequence is not None:
            cam_sequence_copy = ET.SubElement(cam_media_copy, 'sequence')
            for attr, value in cam_sequence.attrib.items():
                if attr == 'format':
                    cam_sequence_copy.set('format', 'r3')
                elif attr == 'duration':
                    converted_duration = self._convert_time_format(value)
                    cam_sequence_copy.set(attr, converted_duration)
                else:
                    cam_sequence_copy.set(attr, value)

            cam_spine = cam_sequence.find('spine')
            if cam_spine is not None:
                self._copy_element_with_conversion(cam_spine, cam_sequence_copy)

        # SSB compound
        ssb_media_copy = ET.SubElement(resources_elem, 'media')
        ssb_media_copy.set('id', 'r6')
        ssb_name = f"{original_name} - SSB" if project_type == "SOLO" else f"{original_name} - DC SSB"
        ssb_media_copy.set('name', ssb_name)
        ssb_uid = shared_uids['ssb'] if shared_uids else str(uuid.uuid4()).upper()
        ssb_media_copy.set('uid', ssb_uid)
        ssb_media_copy.set('modDate', datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S -0400"))

        # Copy SSB sequence
        ssb_sequence = ssb_media.find('sequence')
        if ssb_sequence is not None:
            ssb_sequence_copy = ET.SubElement(ssb_media_copy, 'sequence')
            for attr, value in ssb_sequence.attrib.items():
                if attr == 'format':
                    ssb_sequence_copy.set('format', 'r3')
                elif attr == 'duration':
                    converted_duration = self._convert_time_format(value)
                    ssb_sequence_copy.set(attr, converted_duration)
                else:
                    ssb_sequence_copy.set(attr, value)

            ssb_spine = ssb_sequence.find('spine')
            if ssb_spine is not None:
                self._copy_element_with_conversion(ssb_spine, ssb_sequence_copy)

        # GS compound
        gs_media_copy = ET.SubElement(resources_elem, 'media')
        gs_media_copy.set('id', 'r12')
        gs_name = f"{original_name} - GS" if project_type == "SOLO" else f"{original_name} - DC GS"
        gs_media_copy.set('name', gs_name)
        gs_uid = shared_uids['gs'] if shared_uids else str(uuid.uuid4()).upper()
        gs_media_copy.set('uid', gs_uid)
        gs_media_copy.set('modDate', datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S -0400"))

        # Copy GS sequence
        gs_sequence = gs_media.find('sequence')
        if gs_sequence is not None:
            gs_sequence_copy = ET.SubElement(gs_media_copy, 'sequence')
            for attr, value in gs_sequence.attrib.items():
                if attr == 'format':
                    gs_sequence_copy.set('format', 'r3')
                elif attr == 'duration':
                    converted_duration = self._convert_time_format(value)
                    gs_sequence_copy.set(attr, converted_duration)
                else:
                    gs_sequence_copy.set(attr, value)

            gs_spine = gs_sequence.find('spine')
            if gs_spine is not None:
                self._copy_element_with_conversion(gs_spine, gs_sequence_copy)

        # Add other resources
        skip_ids = {'r1', 'r2', 'r3', 'r6', 'r12'}
        for resource_id, resource in all_resources.items():
            if resource_id not in skip_ids and resource.tag != 'media':
                resources_elem.append(resource)

        # Create library structure with ONE event
        # Derive library location from output path - use parent directory of output XML
        library = ET.SubElement(root, 'library')
        if output_path:
            output_parent = Path(output_path).parent.parent  # Go up from /files/ to date folder
            encoded_path = quote(f'{output_parent}/{original_name}.fcpbundle/', safe='/:')
            library_location = f'file://{encoded_path}'
        else:
            # Fallback: use input file's location
            cam_parent = Path(cam_xml_path).parent.parent
            encoded_path = quote(f'{cam_parent}/{original_name}.fcpbundle/', safe='/:')
            library_location = f'file://{encoded_path}'
        library.set('location', library_location)

        event = ET.SubElement(library, 'event')
        event.set('name', 'Auto-Editor Media Group')
        event_uid = shared_uids['event'] if shared_uids else str(uuid.uuid4()).upper()
        event.set('uid', event_uid)

        # Create a separate project for each segment
        for segment_idx, segment_cuts in enumerate(segments):
            part_num = segment_idx + 1
            part_suffix = f" part {part_num}"

            self._add_project_to_event(event, segment_cuts, original_name, project_type, part_suffix,
                                      cam_name, gs_name, ssb_name)

        # Add smart collections
        self._add_smart_collections(library)

        # Save the combined project XML
        if output_path is None:
            output_filename = f"{original_name}_{project_type}.fcpxml"
            output_path = Path(cam_xml_path).parent / output_filename

        tree = ET.ElementTree(root)
        self.xml_utils.save_fcpxml(tree, output_path)

        return str(output_path)

    def _add_project_to_event(self, event: ET.Element, cam_cuts: List[ET.Element],
                             original_name: str, project_type: str, part_suffix: str,
                             cam_name: str, gs_name: str, ssb_name: str):
        """Add a project element to an event for a specific segment."""
        project = ET.SubElement(event, 'project')
        project_name = f"{original_name} {project_type.lower()}{part_suffix}"
        project.set('name', project_name)
        project.set('uid', str(uuid.uuid4()).upper())
        project.set('modDate', datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S -0400"))

        # Calculate total duration from cam_cuts
        total_duration = self._calculate_total_duration(cam_cuts)

        sequence = ET.SubElement(project, 'sequence')
        sequence.set('format', 'r1')
        sequence.set('duration', total_duration)
        sequence.set('tcStart', '0s')
        sequence.set('tcFormat', 'NDF')
        sequence.set('audioLayout', 'stereo')
        sequence.set('audioRate', '48k')

        spine = ET.SubElement(sequence, 'spine')

        # Build timeline with multi-lane structure for each cut
        # Calculate the offset adjustment for this segment
        segment_start_offset_str = '0s'
        if cam_cuts:
            segment_start_offset_str = cam_cuts[0].get('offset', '0s')

        # Track expected offset to ensure continuity
        expected_offset = "0s"

        for i, ref_clip in enumerate(cam_cuts):
            # Get timing from original cut
            offset = ref_clip.get('offset', '0s')
            duration = ref_clip.get('duration', '30/30s')
            start = ref_clip.get('start', '0s')

            # Convert duration and start to proper framerate
            converted_duration = self._convert_time_format(duration)
            converted_start = self._convert_time_format(start)

            # Use expected_offset for continuity (only convert first clip's offset)
            if i == 0:
                # First clip: adjust and convert offset
                adjusted_offset = self._subtract_time_fractions(offset, segment_start_offset_str)
                converted_offset = self._convert_time_format(adjusted_offset)
                expected_offset = converted_offset
            else:
                # Subsequent clips: use expected offset to maintain continuity
                converted_offset = expected_offset

            # Create main CAM ref-clip (video only)
            main_clip = ET.SubElement(spine, 'ref-clip')
            main_clip.set('ref', 'r2')  # CAM compound
            main_clip.set('offset', converted_offset)
            main_clip.set('name', cam_name)
            main_clip.set('duration', converted_duration)
            main_clip.set('srcEnable', 'video')  # Video only for main spine

            # Adjust start time if present
            if converted_start != '0s':
                main_clip.set('start', converted_start)

            # Lane -1: CAM audio (master audio - topmost audio lane)
            cam_audio = ET.SubElement(main_clip, 'ref-clip')
            cam_audio.set('ref', 'r2')  # CAM compound
            cam_audio.set('lane', '-1')
            # Nested clips offset matches start for proper frame alignment
            cam_audio.set('offset', converted_start)
            cam_audio.set('name', cam_name)
            cam_audio.set('duration', converted_duration)
            cam_audio.set('srcEnable', 'audio')  # Audio only
            if converted_start != '0s':
                cam_audio.set('start', converted_start)

            # Lane -2: SSB audio (below master audio)
            ssb_audio = ET.SubElement(main_clip, 'ref-clip')
            ssb_audio.set('ref', 'r6')  # SSB compound
            ssb_audio.set('lane', '-2')
            # Nested clips offset matches start for proper frame alignment
            ssb_audio.set('offset', converted_start)
            ssb_audio.set('name', ssb_name)
            ssb_audio.set('duration', converted_duration)
            ssb_audio.set('srcEnable', 'audio')  # Audio only
            if converted_start != '0s':
                ssb_audio.set('start', converted_start)

            # Lane 1: GS (muted)
            gs_clip = ET.SubElement(main_clip, 'ref-clip')
            gs_clip.set('ref', 'r12')  # GS compound
            gs_clip.set('lane', '1')
            # Nested clips offset matches start for proper frame alignment
            gs_clip.set('offset', converted_start)
            gs_clip.set('name', gs_name)
            gs_clip.set('duration', converted_duration)
            if converted_start != '0s':
                gs_clip.set('start', converted_start)

            # Mute GS audio
            gs_volume = ET.SubElement(gs_clip, 'adjust-volume')
            gs_volume.set('amount', '-96dB')

            # Lane 2: SSB video
            ssb_video = ET.SubElement(main_clip, 'ref-clip')
            ssb_video.set('ref', 'r6')  # SSB compound
            ssb_video.set('lane', '2')
            # Nested clips offset matches start for proper frame alignment
            ssb_video.set('offset', converted_start)
            ssb_video.set('name', ssb_name)
            ssb_video.set('duration', converted_duration)
            ssb_video.set('srcEnable', 'video')  # Video only
            if converted_start != '0s':
                ssb_video.set('start', converted_start)

            # Calculate next expected offset to maintain continuity
            expected_offset = self._add_time_fractions(converted_offset, converted_duration)