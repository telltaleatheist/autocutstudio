# core/xml_utils.py

import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import datetime
import uuid

class FCPXMLUtils:
    """Utilities for working with Final Cut Pro XML files."""
    
    @staticmethod
    def parse_fcpxml(file_path: str) -> ET.ElementTree:
        """Parse FCPXML file and return ElementTree."""
        tree = ET.parse(file_path)
        return tree
    
    @staticmethod
    def save_fcpxml(tree: ET.ElementTree, output_path: str):
        """Save ElementTree as properly formatted FCPXML."""
        ET.indent(tree, space="    ", level=0)
        tree.write(output_path, encoding='utf-8', xml_declaration=True)
    
    @staticmethod
    def parse_time(time_str: str) -> Tuple[int, int]:
        """Parse FCPX time format (e.g., '1699698/30000s') into numerator, denominator."""
        if time_str.endswith('s'):
            time_str = time_str[:-1]
        if '/' in time_str:
            num, den = time_str.split('/')
            return int(num), int(den)
        return int(time_str), 1
    
    @staticmethod
    def format_time(numerator: int, denominator: int) -> str:
        """Format time as FCPX time string."""
        return f"{numerator}/{denominator}s"
    
    @staticmethod
    def create_asset_element(asset_id: str, name: str, file_path: str, 
                           duration: str, format_id: str, has_audio: bool = True,
                           has_video: bool = True, audio_channels: int = 2) -> ET.Element:
        """Create an asset element for the resources section."""
        asset = ET.Element('asset')
        asset.set('id', asset_id)
        asset.set('name', name)
        asset.set('start', '0s')
        asset.set('duration', duration)
        asset.set('format', format_id)
        
        if has_video:
            asset.set('hasVideo', '1')
        if has_audio:
            asset.set('hasAudio', '1')
            asset.set('audioSources', '1')
            asset.set('audioChannels', str(audio_channels))
        
        # Create media-rep element
        media_rep = ET.SubElement(asset, 'media-rep')
        media_rep.set('kind', 'original-media')
        media_rep.set('src', f"file://{file_path}")
        
        return asset
    
    @staticmethod
    def create_format_element(format_id: str, frame_duration: str, 
                            width: int, height: int, color_space: str) -> ET.Element:
        """Create a format element for the resources section."""
        format_elem = ET.Element('format')
        format_elem.set('id', format_id)
        format_elem.set('name', 'FFVideoFormatRateUndefined')
        format_elem.set('frameDuration', frame_duration)
        format_elem.set('width', str(width))
        format_elem.set('height', str(height))
        format_elem.set('colorSpace', color_space)
        return format_elem
    
    @staticmethod
    def create_media_compound(compound_id: str, name: str, duration: str, 
                            format_id: str, video_settings: Dict) -> ET.Element:
        """Create a compound clip media element."""
        media = ET.Element('media')
        media.set('id', compound_id)
        media.set('name', name)
        media.set('uid', str(uuid.uuid4()).upper())
        
        # Add current timestamp
        now = datetime.datetime.now()
        mod_date = now.strftime("%Y-%m-%d %H:%M:%S -0400")
        media.set('modDate', mod_date)
        
        # Create sequence
        sequence = ET.SubElement(media, 'sequence')
        sequence.set('format', format_id)
        sequence.set('duration', duration)
        sequence.set('tcStart', '0s')
        sequence.set('tcFormat', video_settings.get('tcFormat', 'NDF'))
        sequence.set('audioLayout', video_settings.get('audioLayout', 'stereo'))
        sequence.set('audioRate', video_settings.get('audioRate', '48k'))
        
        return media
    
    @staticmethod
    def create_gap_element(name: str, offset: str, duration: str) -> ET.Element:
        """Create a gap element for compound clip structure."""
        gap = ET.Element('gap')
        gap.set('name', name)
        gap.set('offset', offset)
        gap.set('duration', duration)
        # Remove the hardcoded start time - let it be calculated dynamically
        return gap
    
    @staticmethod
    def create_asset_clip(name: str, ref: str, lane: str, offset: str, 
                         duration: str, format_id: Optional[str] = None,
                         audio_role: Optional[str] = None) -> ET.Element:
        """Create an asset-clip element for audio clips."""
        clip = ET.Element('asset-clip')
        clip.set('ref', ref)
        clip.set('lane', lane)
        clip.set('offset', offset)
        clip.set('name', name)
        clip.set('duration', duration)
        
        if format_id:
            clip.set('format', format_id)
        if audio_role:
            clip.set('audioRole', audio_role)
        
        return clip
    
    @staticmethod
    def create_video_clip(name: str, ref: str, lane: str, offset: str, 
                         duration: str, transforms: Optional[Dict] = None,
                         enabled: bool = True) -> ET.Element:
        """Create a clip element for video with optional transforms."""
        clip = ET.Element('clip')
        clip.set('lane', lane)
        clip.set('offset', offset)
        clip.set('name', name)
        clip.set('duration', duration)
        clip.set('tcFormat', 'NDF')
        
        if not enabled:
            clip.set('enabled', '0')
        
        # Add transforms if provided
        if transforms:
            if 'crop' in transforms:
                crop = ET.SubElement(clip, 'adjust-crop')
                crop.set('mode', transforms.get('crop_mode', 'trim'))
                trim_rect = ET.SubElement(crop, 'trim-rect')
                crop_values = transforms['crop']
                trim_rect.set('left', str(crop_values[0]))
                trim_rect.set('top', str(crop_values[1]))
                trim_rect.set('right', str(crop_values[2]))
                trim_rect.set('bottom', str(crop_values[3]))
            
            if 'transform' in transforms:
                transform = ET.SubElement(clip, 'adjust-transform')
                trans_values = transforms['transform']
                transform.set('position', f"{trans_values['position'][0]} {trans_values['position'][1]}")
                transform.set('scale', f"{trans_values['scale']} {trans_values['scale']}")
        
        # Add video reference
        video = ET.SubElement(clip, 'video')
        video.set('ref', ref)
        video.set('offset', '0s')
        video.set('duration', duration)
        
        return clip
    
    @staticmethod
    def create_audio_only_clip(name: str, ref: str, lane: str, offset: str, 
                              duration: str, role: str = "dialogue.dialogue-1",
                              channels: str = "1, 2", enabled: bool = True) -> ET.Element:
        """Create a clip element with audio only."""
        clip = ET.Element('clip')
        clip.set('lane', lane)
        clip.set('offset', offset)
        clip.set('name', name)
        clip.set('duration', duration)
        
        if not enabled:
            clip.set('enabled', '0')
        
        # Create gap for audio
        gap = ET.SubElement(clip, 'gap')
        gap.set('name', 'Gap')
        gap.set('offset', '0s')
        gap.set('duration', duration)
        
        # Add audio reference
        audio = ET.SubElement(gap, 'audio')
        audio.set('ref', ref)
        audio.set('lane', '-1')
        audio.set('offset', '0s')
        audio.set('duration', duration)
        audio.set('role', role)
        audio.set('srcCh', channels)
        
        return clip
    
    @staticmethod
    def get_compound_timeline_cuts(tree: ET.ElementTree) -> List[Dict]:
        """Extract cut information from compound clip XML."""
        cuts = []
        spine = tree.find('.//project/sequence/spine')
        
        if spine is not None:
            for ref_clip in spine.findall('ref-clip'):
                cut_info = {
                    'offset': ref_clip.get('offset', '0s'),
                    'duration': ref_clip.get('duration', '0s'),
                    'start': ref_clip.get('start', '0s')
                }
                cuts.append(cut_info)
        
        return cuts