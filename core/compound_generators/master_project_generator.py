# core/compound_generators/master_project_generator.py

import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional
import uuid
import datetime
import copy

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
    
    def _generate_master_project(self, cam_xml_path: str, gs_xml_path: str, 
                            ssb_xml_path: str, original_name: str, 
                            project_type: str, output_path: Optional[str] = None) -> str:
        """Generate master project by copying timeline structure from CAM and referencing all compounds."""
        
        print(f"Loading XML files...")
        print(f"CAM: {cam_xml_path}")
        print(f"GS: {gs_xml_path}")
        print(f"SSB: {ssb_xml_path}")
        
        # Load all three compound XML files
        cam_tree = self.xml_utils.parse_fcpxml(cam_xml_path)
        gs_tree = self.xml_utils.parse_fcpxml(gs_xml_path)
        ssb_tree = self.xml_utils.parse_fcpxml(ssb_xml_path)
        
        # Extract compound media IDs and timeline structure from CAM
        cam_resources = cam_tree.find('.//resources')
        cam_project = cam_tree.find('.//project')
        cam_sequence = cam_project.find('sequence')
        cam_spine = cam_sequence.find('spine')
        
        if cam_spine is None:
            raise ValueError("Could not find timeline structure in CAM XML")
        
        # Get compound media IDs from each project
        cam_media = None
        gs_media = None
        ssb_media = None
        
        # Find the compound media elements (not the original video assets)
        for media in cam_tree.findall('.//media'):
            if 'compound' in media.get('id', '').lower():
                cam_media = media
                break
        
        for media in gs_tree.findall('.//media'):
            if 'compound' in media.get('id', '').lower():
                gs_media = media
                break
                
        for media in ssb_tree.findall('.//media'):
            if 'compound' in media.get('id', '').lower():
                ssb_media = media
                break
        
        if not all([cam_media, gs_media, ssb_media]):
            raise ValueError("Could not find compound media elements in source XMLs")
        
        cam_media_id = cam_media.get('id')
        gs_media_id = gs_media.get('id')
        ssb_media_id = ssb_media.get('id')
        
        print(f"Compound media IDs: CAM={cam_media_id}, GS={gs_media_id}, SSB={ssb_media_id}")
        
        # Start building master project XML
        master_root = ET.Element('fcpxml')
        master_root.set('version', '1.12')
        
        resources = ET.SubElement(master_root, 'resources')
        
        # Copy timeline format from CAM project
        original_format = cam_tree.find('.//format[@id="r1"]')
        if original_format is not None:
            timeline_format = ET.SubElement(resources, 'format')
            timeline_format.set('id', 'r1')
            for attr_name, attr_value in original_format.attrib.items():
                if attr_name != 'id':
                    timeline_format.set(attr_name, attr_value)
        
        # Copy ALL resources from all three XMLs, avoiding duplicates
        all_resources = {}
        resource_count = 0
        
        for tree, compound_type in [(cam_tree, 'CAM'), (gs_tree, 'GS'), (ssb_tree, 'SSB')]:
            resources_elem = tree.find('.//resources')
            if resources_elem:
                for element in resources_elem:
                    if element.tag in ['asset', 'effect', 'format', 'media']:
                        element_id = element.get('id')
                        # Skip r1 format (we already copied it) and avoid duplicates
                        if element_id and element_id != 'r1' and element_id not in all_resources:
                            all_resources[element_id] = copy.deepcopy(element)
                            resource_count += 1
        
        print(f"Copied {resource_count} resources from source XMLs")
        
        # Add all resources to master
        for resource_elem in all_resources.values():
            resources.append(resource_elem)
        
        # Create library and project structure
        library = ET.SubElement(master_root, 'library')
        library.set('location', f"file:///Volumes/Callisto/Movies/FCPX/{original_name}/{original_name}.fcpbundle/")
        
        event = ET.SubElement(library, 'event')
        event.set('name', '1 - raw footage')
        event.set('uid', str(uuid.uuid4()).upper())
        
        project = ET.SubElement(event, 'project')
        project.set('name', f"{original_name} {project_type.lower()}")
        project.set('uid', str(uuid.uuid4()).upper())
        project.set('modDate', datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S -0400"))
        
        # Copy the main timeline sequence structure from CAM
        main_sequence = ET.SubElement(project, 'sequence')
        # Copy all attributes from CAM sequence
        for attr_name, attr_value in cam_sequence.attrib.items():
            main_sequence.set(attr_name, attr_value)
        
        main_spine = ET.SubElement(main_sequence, 'spine')
        
        # Copy each ref-clip from CAM timeline and modify to include all compound types
        print(f"Processing timeline cuts...")
        ref_clips = cam_spine.findall('ref-clip')
        
        for ref_clip in ref_clips:
            # Get the timing values from the original ref-clip
            parent_offset = ref_clip.get('offset')
            parent_duration = ref_clip.get('duration')
            parent_start = ref_clip.get('start')
            
            # Create main ref-clip for CAM compound (video only)
            cam_ref_clip = ET.SubElement(main_spine, 'ref-clip')
            cam_ref_clip.set('ref', cam_media_id)
            cam_ref_clip.set('name', f"{original_name} - CAM" if project_type == "SOLO" else f"{original_name} - DC CAM")
            cam_ref_clip.set('srcEnable', 'video')  # Video only for main spine
            
            # Copy timing attributes from original ref-clip
            cam_ref_clip.set('offset', parent_offset)
            cam_ref_clip.set('duration', parent_duration)
            cam_ref_clip.set('start', parent_start)
            
            # Add nested ref-clip for SSB audio (lane -2)
            # KEY FIX: Nested ref-clips need the SAME timing as parent to align properly
            ssb_audio_ref = ET.SubElement(cam_ref_clip, 'ref-clip')
            ssb_audio_ref.set('ref', ssb_media_id)
            ssb_audio_ref.set('lane', '-2')
            ssb_audio_ref.set('name', f"{original_name} - SSB" if project_type == "SOLO" else f"{original_name} - DC SSB")
            ssb_audio_ref.set('srcEnable', 'audio')  # Audio only
            ssb_audio_ref.set('offset', parent_offset)  # Same as parent
            ssb_audio_ref.set('duration', parent_duration)  # Same as parent
            ssb_audio_ref.set('start', parent_start)  # Same as parent
            
            # Add nested ref-clip for CAM audio (lane -1)
            cam_audio_ref = ET.SubElement(cam_ref_clip, 'ref-clip')
            cam_audio_ref.set('ref', cam_media_id)
            cam_audio_ref.set('lane', '-1')
            cam_audio_ref.set('name', f"{original_name} - CAM" if project_type == "SOLO" else f"{original_name} - DC CAM")
            cam_audio_ref.set('srcEnable', 'audio')  # Audio only
            cam_audio_ref.set('offset', parent_offset)  # Same as parent
            cam_audio_ref.set('duration', parent_duration)  # Same as parent
            cam_audio_ref.set('start', parent_start)  # Same as parent
            
            # Add nested ref-clip for GS compound (lane 1, muted)
            gs_ref_clip = ET.SubElement(cam_ref_clip, 'ref-clip')
            gs_ref_clip.set('ref', gs_media_id)
            gs_ref_clip.set('lane', '1')
            gs_ref_clip.set('name', f"{original_name} - GS" if project_type == "SOLO" else f"{original_name} - DC GS")
            gs_ref_clip.set('offset', parent_offset)  # Same as parent
            gs_ref_clip.set('duration', parent_duration)  # Same as parent
            gs_ref_clip.set('start', parent_start)  # Same as parent
            
            # Mute GS audio
            gs_volume = ET.SubElement(gs_ref_clip, 'adjust-volume')
            gs_volume.set('amount', '-96dB')
            
            # Add nested ref-clip for SSB compound (lane 2, video only)
            ssb_video_ref = ET.SubElement(cam_ref_clip, 'ref-clip')
            ssb_video_ref.set('ref', ssb_media_id)
            ssb_video_ref.set('lane', '2')
            ssb_video_ref.set('name', f"{original_name} - SSB" if project_type == "SOLO" else f"{original_name} - DC SSB")
            ssb_video_ref.set('srcEnable', 'video')  # Video only
            ssb_video_ref.set('offset', parent_offset)  # Same as parent
            ssb_video_ref.set('duration', parent_duration)  # Same as parent
            ssb_video_ref.set('start', parent_start)  # Same as parent
                    
        print(f"Added {len(ref_clips)} cuts to master timeline")
        
        # Add smart collections (same as original)
        projects_collection = ET.SubElement(library, 'smart-collection')
        projects_collection.set('name', 'Projects')
        projects_collection.set('match', 'all')
        match_clip = ET.SubElement(projects_collection, 'match-clip')
        match_clip.set('rule', 'is')
        match_clip.set('type', 'project')
        
        all_video_collection = ET.SubElement(library, 'smart-collection')
        all_video_collection.set('name', 'All Video')
        all_video_collection.set('match', 'any')
        match_media1 = ET.SubElement(all_video_collection, 'match-media')
        match_media1.set('rule', 'is')
        match_media1.set('type', 'videoOnly')
        match_media2 = ET.SubElement(all_video_collection, 'match-media')
        match_media2.set('rule', 'is')
        match_media2.set('type', 'videoWithAudio')
        
        audio_only_collection = ET.SubElement(library, 'smart-collection')
        audio_only_collection.set('name', 'Audio Only')
        audio_only_collection.set('match', 'all')
        match_media = ET.SubElement(audio_only_collection, 'match-media')
        match_media.set('rule', 'is')
        match_media.set('type', 'audioOnly')
        
        stills_collection = ET.SubElement(library, 'smart-collection')
        stills_collection.set('name', 'Stills')
        stills_collection.set('match', 'all')
        match_media = ET.SubElement(stills_collection, 'match-media')
        match_media.set('rule', 'is')
        match_media.set('type', 'stills')
        
        favorites_collection = ET.SubElement(library, 'smart-collection')
        favorites_collection.set('name', 'Favorites')
        favorites_collection.set('match', 'all')
        match_ratings = ET.SubElement(favorites_collection, 'match-ratings')
        match_ratings.set('value', 'favorites')
        
        # Save the master project XML
        if output_path is None:
            output_filename = f"{original_name}_{project_type}.fcpxml"
            output_path = Path(cam_xml_path).parent / output_filename
        
        master_tree = ET.ElementTree(master_root)
        self.xml_utils.save_fcpxml(master_tree, str(output_path))
        
        print(f"Master project saved: {output_path}")
        return str(output_path)