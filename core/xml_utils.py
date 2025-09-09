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
        return gap
    
    @staticmethod
    def create_effect_element(effect_id: str, name: str, uid: str) -> ET.Element:
        """Create an effect element for the resources section."""
        effect = ET.Element('effect')
        effect.set('id', effect_id)
        effect.set('name', name)
        effect.set('uid', uid)
        return effect
    
    @staticmethod
    def create_compressor_filter(effect_ref: str, ratio: str, aux_value: str) -> ET.Element:
        """Create a compressor filter-audio element with exact template data."""
        filter_audio = ET.Element('filter-audio')
        filter_audio.set('ref', effect_ref)
        filter_audio.set('name', 'Compressor')
        
        # Use exact effect state data from template
        data = ET.SubElement(filter_audio, 'data')
        data.set('key', 'effectState')
        data.text = 'YnBsaXN0MDDUAQIDBAUGBwpYJHZlcnNpb25ZJGFyY2hpdmVyVCR0b3BYJG9iamVjdHMSAAGGoF8QD05TS2V5ZWRBcmNoaXZlctEICVtlZmZlY3RTdGF0ZYABrxAPCwwfICEiIyQlJicoKSorVSRudWxs0w0ODxAXHldOUy5rZXlzWk5TLm9iamVjdHNWJGNsYXNzphESExQVFoACgAOABIAFgAaAB6YYGRobHB2ACIAJgAqAC4AMgA2ADlR0eXBlXG1hbnVmYWN0dXJlclRkYXRhVG5hbWVXc3VidHlwZVd2ZXJzaW9uEmF1ZngSRU1BR08QlJQAAAABAAAAHwAAAEdBTUVUU1BQmgAAAAAAAAAAAKDBAAAAQAAAAAAAAHpEAAAAAAAAgD8AAAAAAACAPwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3EUAAIA/AAAAAAAAAAAAAAAAAACAPwAAAAAAAMhCAAAAAAAAAAAAAAAAAAAAAAAAAABYVW50aXRsZWQQmhAA0iwtLi9aJGNsYXNzbmFtZVgkY2xhc3Nlc1xOU0RpY3Rpb25hcnmiLjBYTlNPYmplY3QACAARABoAJAApADIANwBJAEwAWABaAGwAcgB5AIEAjACTAJoAnACeAKAAogCkAKYArQCvALEAswC1ALcAuQC7AMAAzQDSANcA3wDnAOwA8QGIAZEBkwGVAZoBpQGuAbsBvgAAAAAAAAIBAAAAAAAAADEAAAAAAAAAAAAAAAAAAAHH'
        
        # Add parameter
        param = ET.SubElement(filter_audio, 'param')
        param.set('name', 'Ratio')
        param.set('key', '2')
        param.set('value', ratio)
        param.set('auxValue', aux_value)
        
        return filter_audio
    
    @staticmethod
    def create_noise_gate_filter(effect_ref: str, threshold: str = '-50') -> ET.Element:
        """Create a noise gate filter-audio element with exact template data."""
        filter_audio = ET.Element('filter-audio')
        filter_audio.set('ref', effect_ref)
        filter_audio.set('name', 'Noise Gate')
        
        # Use exact effect state data from template
        data = ET.SubElement(filter_audio, 'data')
        data.set('key', 'effectState')
        data.text = 'YnBsaXN0MDDUAQIDBAUGBwpYJHZlcnNpb25ZJGFyY2hpdmVyVCR0b3BYJG9iamVjdHMSAAGGoF8QD05TS2V5ZWRBcmNoaXZlctEICVtlZmZlY3RTdGF0ZYABrxAPCwwfICEiIyQlJicoKSorVSRudWxs0w0ODxAXHldOUy5rZXlzWk5TLm9iamVjdHNWJGNsYXNzphESExQVFoACgAOABIAFgAaAB6YYGRobHB2ACIAJgAqAC4AMgA2ADldzdWJ0eXBlXG1hbnVmYWN0dXJlclRkYXRhVHR5cGVUbmFtZVd2ZXJzaW9uELMSRU1BR08QWFgAAAACAAAAEAAAAEdBTUVUU1BQswAAAAAAAAAAAKDBAABAwAAAyMIAAIA/AAAAAP//P0AAQJxGAACgQQAAAAAAAAAAAACAPwAAAAAAAAAAAAAAAAAAoMESYXVmeFhVbnRpdGxlZBAA0iwtLi9aJGNsYXNzbmFtZVgkY2xhc3Nlc1xOU0RpY3Rpb25hcnmiLjBYTlNPYmplY3QACAARABoAJAApADIANwBJAEwAWABaAGwAcgB5AIEAjACTAJoAnACeAKAAogCkAKYArQCvALEAswC1ALcAuQC7AMMA0ADVANoA3wDnAOkA7gFJAU4BVwFZAV4BaQFyAX8BggAAAAAAAAIBAAAAAAAAADEAAAAAAAAAAAAAAAAAAAGL'
        
        # Add parameter
        param = ET.SubElement(filter_audio, 'param')
        param.set('name', 'Threshold [dB]')
        param.set('key', '1')
        param.set('value', threshold)
        param.set('auxValue', str(abs(int(threshold))))
        
        return filter_audio
    
    @staticmethod
    def create_voice_isolation_element(amount: str) -> ET.Element:
        """Create an audio-channel-source element with voice isolation."""
        audio_channel = ET.Element('audio-channel-source')
        audio_channel.set('srcCh', '1, 2')
        audio_channel.set('role', 'dialogue.dialogue-1')
        
        voice_isolation = ET.SubElement(audio_channel, 'adjust-voiceIsolation')
        voice_isolation.set('amount', amount)
        
        return audio_channel
    
    @staticmethod
    def create_volume_adjustment(amount: str) -> ET.Element:
        """Create an adjust-volume element."""
        volume_adjust = ET.Element('adjust-volume')
        volume_adjust.set('amount', amount)
        return volume_adjust
    
    @staticmethod
    def ensure_audio_effects_in_resources(resources: ET.Element) -> Tuple[str, str]:
        """Ensure compressor and noise gate effects exist in resources, return their IDs."""
        compressor_effect_id = 'r_compressor_effect'
        noise_gate_effect_id = 'r_noise_gate_effect'
        
        # Check if effects already exist in resources
        if resources.find(f'.//effect[@id="{compressor_effect_id}"]') is None:
            compressor_effect = FCPXMLUtils.create_effect_element(
                compressor_effect_id,
                'Compressor',
                'AudioUnit: 0x617566780000009a454d4147'
            )
            resources.append(compressor_effect)
        
        if resources.find(f'.//effect[@id="{noise_gate_effect_id}"]') is None:
            noise_gate_effect = FCPXMLUtils.create_effect_element(
                noise_gate_effect_id,
                'Noise Gate',
                'AudioUnit: 0x61756678000000b3454d4147'
            )
            resources.append(noise_gate_effect)
        
        return compressor_effect_id, noise_gate_effect_id
    
    def create_audio_clip(name: str, ref: str, lane: str, offset: str, 
                        duration: str, audio_type: Optional[str] = None,
                        resources: Optional[ET.Element] = None) -> ET.Element:
        """Create an audio element for audio clips with basic volume adjustment only."""
        audio = ET.Element('audio')
        audio.set('ref', ref)
        audio.set('lane', lane)
        audio.set('offset', offset)
        audio.set('name', name)
        audio.set('duration', duration)
        audio.set('role', 'dialogue.dialogue-1')
        audio.set('srcCh', '1, 2')
        
        # Only apply volume adjustment to the audio element itself
        if audio_type:
            if audio_type in ['mic1', 'mic2', 'mic3', 'mic4']:
                volume = ET.SubElement(audio, 'adjust-volume')
                volume.set('amount', '0.0471005dB')
            elif audio_type in ['screen', 'game', 'bluetooth']:
                volume = ET.SubElement(audio, 'adjust-volume')
                volume.set('amount', '-10dB')
            elif audio_type == 'sound_effects':
                volume = ET.SubElement(audio, 'adjust-volume')
                volume.set('amount', '-15dB')
        else:
            volume = ET.SubElement(audio, 'adjust-volume')
            volume.set('amount', '-96dB')
        
        return audio

    @staticmethod
    def create_clip_with_audio_effects(name: str, ref: str, lane: str, offset: str, 
                                    duration: str, audio_type: Optional[str] = None,
                                    resources: Optional[ET.Element] = None) -> ET.Element:
        """Create an audio element with proper volume adjustment."""
        # Changed from creating a clip to creating a direct audio element
        audio = ET.Element('audio')
        audio.set('ref', ref)
        audio.set('lane', lane)
        audio.set('offset', offset)
        audio.set('name', name)
        audio.set('duration', duration)
        audio.set('role', 'dialogue.dialogue-1')
        audio.set('srcCh', '1, 2')
        
        # Add volume adjustment based on audio type
        if audio_type:
            volume = ET.SubElement(audio, 'adjust-volume')
            if audio_type in ['mic1', 'mic2', 'mic3', 'mic4']:
                volume.set('amount', '0.0471005dB')
            elif audio_type in ['screen', 'game', 'bluetooth']:
                volume.set('amount', '-6dB')
            elif audio_type == 'sound_effects':
                volume.set('amount', '-10dB')
        
        return audio

    @staticmethod
    def create_asset_clip(name: str, ref: str, lane: str, offset: str, 
                        duration: str, format_id: Optional[str] = None,
                        audio_role: Optional[str] = None, audio_type: Optional[str] = None,
                        resources: Optional[ET.Element] = None,
                        crop_settings: Optional[Dict] = None,
                        transform_settings: Optional[Dict] = None) -> ET.Element:
        """Create an asset-clip element for audio clips with proper DTD element order."""
        clip = ET.Element('asset-clip')
        clip.set('ref', ref)
        clip.set('lane', lane)
        clip.set('offset', offset)
        clip.set('name', name)
        clip.set('duration', duration)
        
        if format_id:
            clip.set('format', format_id)
            clip.set('tcFormat', 'NDF')
        if audio_role:
            clip.set('audioRole', audio_role)
        
        # CORRECT DTD ORDER per error message:
        # 1. note? - not used
        # 2. (conform-rate? , timeMap?) - not used
        # 3. All the adjust- elements in specific order
        # 4. Content elements (audio | video | clip...)
        
        # Step 3a: Add crop settings if provided
        if crop_settings:
            crop = ET.SubElement(clip, 'adjust-crop')
            crop.set('mode', 'trim')
            trim_rect = ET.SubElement(crop, 'trim-rect')
            trim_rect.set('left', str(crop_settings.get('left', 0)))
            trim_rect.set('top', str(crop_settings.get('top', 0)))
            trim_rect.set('right', str(crop_settings.get('right', 0)))
            trim_rect.set('bottom', str(crop_settings.get('bottom', 0)))
        
        # Step 3b: Add transform settings if provided
        if transform_settings:
            transform = ET.SubElement(clip, 'adjust-transform')
            position = transform_settings.get('position', [0, 0])
            scale = transform_settings.get('scale', 1.0)
            transform.set('position', f"{position[0]} {position[1]}")
            transform.set('scale', f"{scale} {scale}")
        
        # Step 3c: Add volume adjustment - this must come before adjust-panner
        if audio_type:
            if audio_type in ['mic1', 'mic2', 'mic3', 'mic4']:
                volume = ET.SubElement(clip, 'adjust-volume')
                volume.set('amount', '0.0471005dB')
            elif audio_type in ['screen', 'game', 'bluetooth']:
                volume = ET.SubElement(clip, 'adjust-volume')
                volume.set('amount', '-6dB')
            elif audio_type == 'sound_effects':
                volume = ET.SubElement(clip, 'adjust-volume')
                volume.set('amount', '-15dB')
        else:
            # Mute if no audio type specified
            volume = ET.SubElement(clip, 'adjust-volume')
            volume.set('amount', '-96dB')
        
        # Step 3d: Add adjust-panner if needed (DTD expects this after adjust-volume)
        # We don't currently use panning, but the DTD order requires this position
        
        # Step 4: Content elements - gap with audio
        gap = ET.SubElement(clip, 'gap')
        gap.set('name', 'Gap')
        gap.set('offset', '0s')
        gap.set('duration', duration)
        
        audio = ET.SubElement(gap, 'audio')
        audio.set('ref', ref)
        audio.set('lane', '-1')
        audio.set('offset', '0s')
        audio.set('duration', duration)
        audio.set('role', 'dialogue.dialogue-1')
        audio.set('srcCh', '1, 2')
        
        return clip
    
    @staticmethod
    def create_video_clip(name: str, ref: str, lane: str, offset: str, 
                        duration: str, transforms: Optional[Dict] = None,
                        keywords: Optional[List[Dict]] = None) -> ET.Element:
        """Create a video element with proper transform handling."""
        video = ET.Element('video')
        video.set('ref', ref)
        video.set('lane', lane)
        video.set('offset', offset)
        video.set('name', name)
        video.set('duration', duration)
        
        # Add transform elements if provided
        if transforms:
            # Add crop adjustment if specified
            if 'crop' in transforms:
                crop_values = transforms['crop']  # [left, top, right, bottom]
                crop = ET.SubElement(video, 'adjust-crop')
                crop.set('mode', transforms.get('crop_mode', 'trim'))
                trim_rect = ET.SubElement(crop, 'trim-rect')
                trim_rect.set('left', str(crop_values[0]))
                trim_rect.set('top', str(crop_values[1]))
                trim_rect.set('right', str(crop_values[2]))
                trim_rect.set('bottom', str(crop_values[3]))
            
            # Add transform adjustment if specified
            if 'transform' in transforms:
                transform_data = transforms['transform']
                transform = ET.SubElement(video, 'adjust-transform')
                
                if 'position' in transform_data:
                    pos = transform_data['position']
                    transform.set('position', f"{pos[0]} {pos[1]}")
                
                if 'scale' in transform_data:
                    scale = transform_data['scale']
                    transform.set('scale', f"{scale} {scale}")
        
        # Add keywords if provided
        if keywords:
            for keyword in keywords:
                kw = ET.SubElement(video, 'keyword')
                kw.set('start', keyword.get('start', offset))
                kw.set('duration', keyword.get('duration', '10s'))
                kw.set('value', keyword.get('value', 'white boxes'))
        
        return video

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

    @staticmethod
    def create_audio_only_clip(name: str, ref: str, lane: str, offset: str, 
                            duration: str, role: str = "dialogue.dialogue-1",
                            channels: str = "1, 2", enabled: bool = True) -> ET.Element:
        """Create a clip element with audio only (for disabled master audio)."""
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