# core/config.py

import yaml
import os
from pathlib import Path
from typing import Dict, Any, Optional

class AutoCutStudioConfig:
    """Configuration manager for AutoCutStudio."""
    
    def __init__(self, config_path: Optional[str] = None):
        if config_path is None:
            # Look for config in standard locations
            config_path = self._find_config_file()
        
        self.config_path = Path(config_path)
        self.config = self._load_config()
    
    def _find_config_file(self) -> str:
        """Find config file in standard locations."""
        possible_paths = [
            "config/autostudio_config.yaml",
            "autostudio_config.yaml",
            os.path.expanduser("~/.autostudio/config.yaml")
        ]
        
        for path in possible_paths:
            if os.path.exists(path):
                return path
        
        # Return default path if none found
        return "config/autostudio_config.yaml"
    
    def _load_config(self) -> Dict[str, Any]:
        """Load configuration from YAML file."""
        if not self.config_path.exists():
            raise FileNotFoundError(f"Config file not found: {self.config_path}")
        
        with open(self.config_path, 'r') as f:
            return yaml.safe_load(f)
    
    def save_config(self):
        """Save current configuration to file."""
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.config_path, 'w') as f:
            yaml.dump(self.config, f, default_flow_style=False, indent=2)
    
    def get(self, key_path: str, default: Any = None) -> Any:
        """Get config value using dot notation (e.g., 'app.editor')."""
        keys = key_path.split('.')
        value = self.config
        
        for key in keys:
            if isinstance(value, dict) and key in value:
                value = value[key]
            else:
                return default
        
        return value
    
    def set(self, key_path: str, value: Any):
        """Set config value using dot notation."""
        keys = key_path.split('.')
        config_section = self.config
        
        # Navigate to the parent section
        for key in keys[:-1]:
            if key not in config_section:
                config_section[key] = {}
            config_section = config_section[key]
        
        # Set the final value
        config_section[keys[-1]] = value
    
    # Convenience properties for commonly used values
    @property
    def default_threshold(self) -> str:
        return self.get('app.default_threshold', '-40dB')
    
    @property
    def current_layout(self) -> str:
        return self.get('current_layout', 'master_current')
    
    @property
    def video_settings(self) -> Dict[str, Any]:
        return self.get('video', {})

    @property
    def video_shorts_settings(self) -> Dict[str, Any]:
        return self.get('video_shorts', {
            'width': 1080,
            'height': 1920,
            'frame_duration': '1001/30000s',
            'color_space': '1-1-1 (Rec. 709)',
            'tcFormat': 'NDF',
            'audioLayout': 'stereo',
            'audioRate': '48k'
        })

    @property
    def audio_settings(self) -> Dict[str, Any]:
        return self.get('audio', {})
    
    def get_layout_config(self, compound_type: str, mode: str) -> Dict[str, Any]:
        """Get layout configuration for specific compound type and mode."""
        return self.get(f'layouts.{compound_type}.{mode}', {})
    
    def get_source_layout(self, layout_name: Optional[str] = None) -> Dict[str, Any]:
        """Get source layout configuration."""
        if layout_name is None:
            layout_name = self.current_layout
        return self.get(f'source_layouts.{layout_name}', {})
    
    def get_auto_editor_config(self) -> Dict[str, Any]:
        """Get auto-editor configuration."""
        return self.get('auto_editor', {})
    
    def expand_file_pattern(self, pattern_key: str, date: str) -> str:
        """Expand file pattern with date."""
        pattern = self.get(f'file_patterns.{pattern_key}', '{date} {pattern_key}')
        return pattern.format(date=date)
    
    def get_asset_path(self, asset_name: str) -> str:
        """Get path for a specific asset using dot notation (e.g., 'borders.cam_border')."""
        return self.get(f'paths.assets.{asset_name}', '')
    
    def get_border_path(self, border_reference: str) -> str:
        """Get border asset path from layout border reference.
        
        Args:
            border_reference: Border reference from layout (e.g., 'gs.bottom_left', 'cam_dc.top_left')
            
        Returns:
            Full path to border asset file, or empty string if not found
        """
        if not border_reference:
            return ''
            
        # Convert border reference to full asset path
        # e.g., 'gs.bottom_left' -> 'paths.assets.borders.gs.bottom_left'
        full_path = f'paths.assets.borders.{border_reference}'
        return self.get(full_path, '')