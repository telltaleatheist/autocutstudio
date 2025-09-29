# core/compound_generators/master_project_generator.py

import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import uuid
import datetime

from ..xml_utils import FCPXMLUtils

class MasterProjectGenerator:
    """Generate master projects combining CAM, GS, and SSB compound clips."""
    
    def __init__(self, config):
        self.config = config
        self.xml_utils = FCPXMLUtils()
    
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
    
    def _convert_to_2997_time(self, time_str: str) -> str:
        """Convert 30fps time to 29.97fps fractional time."""
        if not time_str or time_str == '0s' or time_str == '0/30s':
            return '0s'
        
        # Parse the time string (e.g., "1595/30s" or "531531/10000s")
        if '/' in time_str:
            parts = time_str.replace('s', '').split('/')
            if len(parts) == 2:
                numerator = int(parts[0])
                denominator = int(parts[1])
                
                # If it's already in a high precision format, keep it
                if denominator >= 10000:
                    return time_str
                
                # Convert 30fps to 29.97fps (multiply by 1001/1000)
                # For 30fps: multiply numerator by 1001, denominator by 1000
                if denominator == 30:
                    new_numerator = numerator * 1001
                    new_denominator = 30000
                    # Simplify if possible
                    if new_numerator % 10 == 0:
                        return f"{new_numerator // 10}/{new_denominator // 10}s"
                    return f"{new_numerator}/{new_denominator}s"
        
        return time_str
    
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
        
        # Add timeline format (1080p 29.97fps to match source)
        timeline_format = ET.SubElement(resources_elem, 'format')
        timeline_format.set('id', 'r1')
        timeline_format.set('name', 'FFVideoFormat1080p2997')
        timeline_format.set('frameDuration', '1001/30000s')
        timeline_format.set('width', '1920')
        timeline_format.set('height', '1080')
        timeline_format.set('colorSpace', '1-1-1 (Rec. 709)')
        
        # Add compound format (29.97 fps for compounds)
        compound_format = ET.SubElement(resources_elem, 'format')
        compound_format.set('id', 'r3')
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
                if attr != 'format':
                    cam_sequence_copy.set(attr, value)
            cam_sequence_copy.set('format', 'r3')  # Use compound format
            
            # Copy the spine structure
            cam_spine = cam_sequence.find('spine')
            if cam_spine is not None:
                spine_copy = ET.SubElement(cam_sequence_copy, 'spine')
                for child in cam_spine:
                    spine_copy.append(child)
        
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
                if attr != 'format':
                    ssb_sequence_copy.set(attr, value)
            ssb_sequence_copy.set('format', 'r3')  # Use compound format
            
            # Copy the spine structure
            ssb_spine = ssb_sequence.find('spine')
            if ssb_spine is not None:
                spine_copy = ET.SubElement(ssb_sequence_copy, 'spine')
                for child in ssb_spine:
                    spine_copy.append(child)
        
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
                if attr != 'format':
                    gs_sequence_copy.set(attr, value)
            gs_sequence_copy.set('format', 'r3')  # Use compound format
            
            # Copy the spine structure
            gs_spine = gs_sequence.find('spine')
            if gs_spine is not None:
                spine_copy = ET.SubElement(gs_sequence_copy, 'spine')
                for child in gs_spine:
                    spine_copy.append(child)
        
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
            
            # Convert all time values to 29.97fps format
            converted_offset = self._convert_to_2997_time(offset)
            converted_duration = self._convert_to_2997_time(duration)
            converted_start = self._convert_to_2997_time(start)
            
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
            conform_rate.set('srcFrameRate', '29.97')
            
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
            ssb_audio_conform.set('srcFrameRate', '29.97')
            
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
            cam_audio_conform.set('srcFrameRate', '29.97')
            
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
            gs_conform.set('srcFrameRate', '29.97')
            
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
            ssb_video_conform.set('srcFrameRate', '29.97')
        
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
        
        # Convert to 29.97fps format
        return self._convert_to_2997_time(f"{total_num}/{total_den}s")
    
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