# core/editors/base_editor.py

from abc import ABC, abstractmethod
from typing import List

class BaseEditor(ABC):
    """Abstract base class for video editors that can cut silence/pauses."""
    
    @abstractmethod
    def cut_silence(self, input_file: str, threshold: str, output_format: str = "final-cut-pro") -> str:
        """
        Cut silence from input file and return path to output.
        
        Args:
            input_file: Path to input video/audio file
            threshold: Audio threshold for cutting (e.g., "-40dB")
            output_format: Output format ("final-cut-pro", etc.)
            
        Returns:
            Path to generated cut file
        """
        pass
    
    @abstractmethod
    def get_supported_formats(self) -> List[str]:
        """Return list of supported file formats."""
        pass