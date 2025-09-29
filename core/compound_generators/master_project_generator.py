# core/compound_generators/master_project_generator.py

import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import uuid
import datetime
import subprocess
import json

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
                
                print(f"Detected framerate: {self.detected_framerate} fps")
                return self.detected_framerate
                
        except Exception as e:
            print(f"Could not detect framerate, defaulting to 29.97: {e}")
            self.detected_framerate = "29.97"
            return self.detected_framerate
    
    def generate_solo_master_project(self, cam_xml_path: str, gs_xml_path: str, 
                                   ssb_xml_path: str, original_name: str, 
                                   output_path: Optional[str] = None) -> str:
        """Generate SOLO master project combining CAM, GS, and SSB compounds."""
        return self._generate_master_project(
            cam_xml_path, gs_xml_path, ssb_xml_path, 
            original_name, "SOLO", output_path
        )
    
    def generate_dc_master_project(self, cam_xml_path: str, gs_xml_path: str, 
                                 ssb_xml_path: str, original_name: str, 
                                 output_path: Optional[str] = None) -> str:
        """Generate DC (Dual Camera) master project combining CAM, GS, and SSB compounds."""
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
        
        if self.detected_framerate == "29.97":
            # For 29.97fps, frame duration is 1001/30000s
            # Convert to seconds, round to nearest frame, convert back
            time_in_seconds = numerator / denominator
            frame_duration = 1001 / 30000  # 29.97fps frame duration
            
            # Round to nearest frame
            frame_number = round(time_in_seconds / frame_duration)
            
            # Convert back to fractional format
            aligned_numerator = frame_number * 1001
            aligned_denominator = 30000
            
            # Simplify the fraction
            from math import gcd
            divisor = gcd(aligned_numerator, aligned_denominator)
            aligned_numerator //= divisor
            aligned_denominator //= divisor
            
            return f"{aligned_numerator}/{aligned_denominator}s"
        
        elif self.detected_framerate == "30":
            # For 30fps, frame duration is 1/30s
            time_in_seconds = numerator / denominator
            frame_duration = 1 / 30
            
            # Round to nearest frame
            frame_number = round(time_in_seconds / frame_duration)
            
            # Convert back to fractional format
            return f"{frame_number}/30s"
        
        # For other framerates, return as-is
        return time_str
    
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
                                project_type: str, output_path: Optional[str] = None) -> str:
        """Generate master project by building a new timeline structure from scratch."""
        
        print(f"Generating {project_type} master project...")
        print(f"CAM: {cam_xml_path}")
        print(f"GS: {gs_xml_path}")
        print(f"SSB: {ssb_xml_path}")
        
        # Extract compound info from each XML
        cam_id, cam_media, cam_cuts = self._extract_compound_info(cam_xml_path)
        gs_id, gs_media, _ = self._extract_compound_info(gs_xml_path)
        ssb_id, ssb_media, _ = self._extract_compound_info(ssb_xml_path)
        
        print(f"Found compounds: CAM={cam_id}, GS={gs_id}, SSB={ssb_id}")
        print(f"Found {len(cam_cuts)} cuts in CAM timeline")
        
        # Extract all resources from all three XMLs
        all_resources = {}
        for xml_path in [cam_xml_path, gs_xml_path, ssb_xml_path]:
            resources = self._extract_all_resources(xml_path)
            all_resources.update(resources)
        
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
        cam_media_copy.set('uid', str(uuid.uuid4()).upper())
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
        ssb_media_copy.set('uid', str(uuid.uuid4()).upper())
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
        gs_media_copy.set('uid', str(uuid.uuid4()).upper())
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
        skip_ids = {cam_id, gs_id, ssb_id, 'r1', 'r2', 'r3', 'r6', 'r12'}
        
        for resource_id, resource in all_resources.items():
            if resource_id not in skip_ids and resource.tag != 'media':
                resources_elem.append(resource)
        
        # Create library structure
        library = ET.SubElement(root, 'library')
        library.set('location', f'file:///Volumes/Callisto/Movies/FCPX/{original_name}/{original_name}.fcpbundle/')
        
        event = ET.SubElement(library, 'event')
        event.set('name', 'Auto-Editor Media Group')
        event.set('uid', str(uuid.uuid4()).upper())
        
        project = ET.SubElement(event, 'project')
        project_name = f"{original_name} {project_type.lower()}"
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
        
        # Build timeline with multi-lane structure for each cut
        for ref_clip in cam_cuts:
            # Get timing from original cut
            offset = ref_clip.get('offset', '0s')
            duration = ref_clip.get('duration', '30/30s')
            start = ref_clip.get('start', '0s')
            
            # Convert time values based on detected framerate
            converted_offset = self._convert_time_format(offset)
            converted_duration = self._convert_time_format(duration)
            converted_start = self._convert_time_format(start)
            
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
            
            # Add conform-rate
            conform_rate = ET.SubElement(main_clip, 'conform-rate')
            conform_rate.set('srcFrameRate', self.detected_framerate if self.detected_framerate else '29.97')
            
            # Lane -2: SSB audio
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
            
            ssb_audio_conform = ET.SubElement(ssb_audio, 'conform-rate')
            ssb_audio_conform.set('srcFrameRate', self.detected_framerate if self.detected_framerate else '29.97')
            
            # Lane -1: CAM audio
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
            
            cam_audio_conform = ET.SubElement(cam_audio, 'conform-rate')
            cam_audio_conform.set('srcFrameRate', self.detected_framerate if self.detected_framerate else '29.97')
            
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
            
            gs_conform = ET.SubElement(gs_clip, 'conform-rate')
            gs_conform.set('srcFrameRate', self.detected_framerate if self.detected_framerate else '29.97')
            
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
            
            ssb_video_conform = ET.SubElement(ssb_video, 'conform-rate')
            ssb_video_conform.set('srcFrameRate', self.detected_framerate if self.detected_framerate else '29.97')
        
        print(f"Created timeline with {len(cam_cuts)} cuts")
        
        # Add smart collections
        self._add_smart_collections(library)
        
        # Save the master project XML
        if output_path is None:
            output_filename = f"{original_name}_{project_type}.fcpxml"
            output_path = Path(cam_xml_path).parent / output_filename
        
        tree = ET.ElementTree(root)
        self.xml_utils.save_fcpxml(tree, str(output_path))
        
        print(f"Master project saved: {output_path}")
        return str(output_path)
    
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