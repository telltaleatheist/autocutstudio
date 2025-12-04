"""
Skip Logic for Re-rendering Operations

Determines which files can be skipped during re-rendering based on:
1. Whether source files are available in master video quadrants
2. Whether alternative non-SB audio files exist
3. User requirements for optional audio tracks
"""

from pathlib import Path
from typing import Dict, List, Optional


class SkipDecisionEngine:
    """Decides which re-rendering operations can be skipped."""

    def __init__(self, master_video: str, audio_sources: Dict[str, str], video_sources: Dict[str, str]):
        """
        Initialize skip decision engine.

        Args:
            master_video: Path to master video file
            audio_sources: Dict of audio type -> file path
            video_sources: Dict of video type -> file path
        """
        self.master_video = master_video
        self.audio_sources = audio_sources
        self.video_sources = video_sources

    def is_soundboard_file(self, file_path: str) -> bool:
        """Check if file is a soundboard recording (has 'sb' in name)."""
        if not file_path:
            return False
        name = Path(file_path).name.lower()
        return 'sb.' in name or name.endswith('sb.wav')

    def can_skip_video(self, video_type: str) -> Dict:
        """
        Determine if video re-rendering can be skipped.

        Video quadrants in master:
        - Top-left: Screen capture (cam2 in some setups)
        - Top-right: Camera 2
        - Bottom-left: Camera 1
        - Bottom-right: Game capture

        Args:
            video_type: One of 'screen', 'game', 'cam1', 'cam2'

        Returns:
            Dict with keys:
                - can_skip: bool
                - reason: str explaining decision
                - fallback_source: str (master quadrant name)
        """
        # All video sources can be skipped because they're in master quadrants
        quadrant_map = {
            'screen': 'top-left quadrant',
            'cam2': 'top-right quadrant',
            'cam1': 'bottom-left quadrant',
            'game': 'bottom-right quadrant'
        }

        if video_type in quadrant_map:
            return {
                'can_skip': True,
                'reason': f'Available in master video {quadrant_map[video_type]}',
                'fallback_source': f'master_{video_type}_quadrant',
                'skippable_type': 'always'
            }

        return {
            'can_skip': False,
            'reason': 'Unknown video type',
            'fallback_source': None,
            'skippable_type': 'never'
        }

    def can_skip_audio(self, audio_type: str, file_path: str) -> Dict:
        """
        Determine if audio re-rendering can be skipped.

        Rules:
        - mic1, screen: Required audio (UNSKIPPABLE if only SB version exists)
        - mic2, mic3, mic4, bluetooth: Optional (ALWAYS SKIPPABLE)
        - soundEffects: Can have SB version, same rules as mic1/screen

        Args:
            audio_type: One of 'mic1', 'mic2', 'mic3', 'mic4', 'screen', 'bluetooth', 'soundEffects'
                        Can also include 'Sb' suffix (e.g., 'mic1Sb', 'screenSb')
            file_path: Path to the audio file

        Returns:
            Dict with keys:
                - can_skip: bool
                - reason: str explaining decision
                - fallback_source: str or None (alternative file path)
                - skippable_type: 'always', 'never', 'conditional'
        """
        # Normalize type: remove 'Sb' suffix (mic1Sb -> mic1, screenSb -> screen)
        base_type = audio_type.replace('Sb', '') if audio_type.endswith('Sb') else audio_type
        is_sb = audio_type.endswith('Sb') or self.is_soundboard_file(file_path)

        # Always skippable (optional audio)
        always_optional = ['mic2', 'mic3', 'mic4', 'bluetooth']
        if base_type in always_optional:
            if is_sb:
                return {
                    'can_skip': True,
                    'reason': f'{base_type} is optional - can skip SB re-render',
                    'fallback_source': None,
                    'skippable_type': 'always'
                }
            else:
                return {
                    'can_skip': True,
                    'reason': f'{base_type} does not need re-rendering',
                    'fallback_source': None,
                    'skippable_type': 'always'
                }

        # Required audio (mic1, screen, soundEffects)
        if base_type in ['mic1', 'screen', 'soundEffects']:
            if not is_sb:
                # Non-SB version never needs re-rendering (recorded with master)
                return {
                    'can_skip': True,
                    'reason': f'{base_type} recorded with master - no re-render needed',
                    'fallback_source': None,
                    'skippable_type': 'never'  # Would be unskippable IF it needed re-render
                }
            else:
                # SB version - check if non-SB alternative exists
                non_sb_path = self._get_non_sb_alternative(base_type)
                if non_sb_path:
                    return {
                        'can_skip': True,
                        'reason': f'Non-SB version available: {Path(non_sb_path).name}',
                        'fallback_source': non_sb_path,
                        'skippable_type': 'conditional'
                    }
                else:
                    return {
                        'can_skip': False,
                        'reason': f'{base_type} SB is only source - required for workflow',
                        'fallback_source': None,
                        'skippable_type': 'conditional'
                    }

        # Unknown audio type
        return {
            'can_skip': False,
            'reason': 'Unknown audio type',
            'fallback_source': None,
            'skippable_type': 'never'
        }

    def _get_non_sb_alternative(self, audio_type: str) -> Optional[str]:
        """Check if a non-SB version of this audio exists."""
        # Look in audio_sources for the same type without SB
        for source_type, source_path in self.audio_sources.items():
            if source_type == audio_type and source_path:
                if not self.is_soundboard_file(source_path):
                    return source_path
        return None

    def get_all_skip_decisions(self) -> Dict:
        """
        Get skip decisions for all audio and video sources.

        Returns:
            Dict with keys 'audio' and 'video', each containing skip decisions
        """
        decisions = {
            'audio': {},
            'video': {}
        }

        # Audio skip decisions
        for audio_type, audio_path in self.audio_sources.items():
            if audio_path:
                decisions['audio'][audio_type] = self.can_skip_audio(audio_type, audio_path)

        # Video skip decisions
        for video_type, video_path in self.video_sources.items():
            if video_path:
                decisions['video'][video_type] = self.can_skip_video(video_type)

        return decisions

    def get_unskippable_operations(self) -> List[str]:
        """Get list of operations that cannot be skipped."""
        decisions = self.get_all_skip_decisions()
        unskippable = []

        for audio_type, decision in decisions['audio'].items():
            if not decision['can_skip']:
                unskippable.append(f'audio:{audio_type}')

        for video_type, decision in decisions['video'].items():
            if not decision['can_skip']:
                unskippable.append(f'video:{video_type}')

        return unskippable

    def generate_skip_summary(self) -> str:
        """Generate human-readable summary of skip decisions."""
        decisions = self.get_all_skip_decisions()
        lines = []

        lines.append("Skip Decisions Summary:")
        lines.append("=" * 60)

        # Audio
        lines.append("\nAudio Sources:")
        for audio_type, decision in decisions['audio'].items():
            status = "✓ SKIPPABLE" if decision['can_skip'] else "✗ REQUIRED"
            lines.append(f"  {status} - {audio_type}: {decision['reason']}")

        # Video
        lines.append("\nVideo Sources:")
        for video_type, decision in decisions['video'].items():
            status = "✓ SKIPPABLE" if decision['can_skip'] else "✗ REQUIRED"
            lines.append(f"  {status} - {video_type}: {decision['reason']}")

        lines.append("=" * 60)

        return "\n".join(lines)
