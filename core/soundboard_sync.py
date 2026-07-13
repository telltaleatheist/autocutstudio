"""
Soundboard Audio Synchronization

This module provides sync specifically for soundboard-recorded audio files.
All soundboard files from the same recording session share the same:
- Time offset (when recording was started)
- Clock drift (soundboard clock vs computer clock)

Strategy:
1. Detect sync using the cleanest correlation (mic files)
2. Apply same sync to all other soundboard files
"""

from pathlib import Path
from typing import Dict, List, Optional, Tuple
import os
import sys

from core.audio_sync import AudioSyncAnalyzer, MediaSyncProcessor


def get_processed_path(input_path: str, extension: str = None, output_dir: str = None) -> Path:
    """Get the _processed output path for a file, avoiding _processed_processed."""
    input_path = Path(input_path)
    stem = input_path.stem
    if stem.endswith('_processed'):
        stem = stem[:-10]
    ext = extension if extension else input_path.suffix
    out_dir = Path(output_dir) if output_dir else input_path.parent
    return out_dir / f"{stem}_processed{ext}"


def sync_soundboard_files(
    soundboard_files: Dict[str, str],
    vmix_files: Dict[str, str],
    output_dir: Optional[str] = None
) -> Dict[str, Dict]:
    """
    Sync all soundboard files using unified offset and drift detection.

    Workflow:
    1. Merge mic 1 + mic 2 soundboard files
    2. Correlate merged soundboard vs VMix mic 1 audio (Output 2)
    3. Detect offset + clock drift
    4. Apply same parameters to ALL soundboard files

    Args:
        soundboard_files: Dict of soundboard files, e.g.:
            {
                'mic1': '/path/to/mic 1 audio sb.wav',
                'mic2': '/path/to/mic 2 audio sb.wav',
                'screen': '/path/to/screen audio sb.wav',
                'desktop': '/path/to/desktop audio sb.wav',
                ...
            }
        vmix_files: Dict of VMix output files, e.g.:
            {
                'mic1': '/path/to/mic 1 audio.wav',  # Output 2
                'screen': '/path/to/screen audio.wav',  # Output 3 (if exists)
                'master': '/path/to/master.mp4'  # Output 4
            }
        output_dir: Optional directory for synced files

    Returns:
        Dict of synced files and sync info:
        {
            'mic1': {
                'path': '/path/to/mic 1 audio sb_synced.wav',
                'offset_seconds': 0.327,
                'speed_factor': 1.000170,
                'drift_frames': 94.0
            },
            ...
        }
    """
    analyzer = AudioSyncAnalyzer()
    processor = MediaSyncProcessor()

    # Step 1: Find the best files for correlation
    # Prefer mic files since they correlate best
    mic1_sb = soundboard_files.get('mic1')
    mic2_sb = soundboard_files.get('mic2')
    mic1_vmix = vmix_files.get('mic1')

    if not mic1_sb or not mic1_vmix:
        raise ValueError("Need at least mic 1 soundboard and VMix files for sync detection")

    print("\n▶ SOUNDBOARD SYNC", file=sys.stderr)

    # Step 2: Merge mic 1 + mic 2 if both exist
    if mic2_sb and Path(mic2_sb).exists():
        merged_sb = analyzer.merge_audio_files(mic1_sb, mic2_sb)
        cleanup_merged = (merged_sb != mic1_sb)  # Clean up if temp file was created
    else:
        merged_sb = mic1_sb
        cleanup_merged = False

    try:
        sync_info = analyzer.analyze_sync(mic1_vmix, merged_sb, search_window=30)

        offset_seconds = sync_info['offset_seconds']
        speed_factor = sync_info['speed_factor']
        correlation = sync_info['correlation_score']

        print(f"  Offset: {offset_seconds * 29.97:.1f}f | Speed: {speed_factor:.10f} | Drift: {sync_info['drift_frames']:.1f}f", file=sys.stderr)

    finally:
        # Clean up merged file if it was temporary
        if cleanup_merged and Path(merged_sb).exists():
            os.unlink(merged_sb)

    # Step 4: Apply sync to ALL soundboard files
    results = {}

    for name, sb_file in soundboard_files.items():
        if not sb_file or not Path(sb_file).exists():
            continue

        # Determine output path - always use _processed.wav, avoid _processed_processed
        output_path = get_processed_path(sb_file, '.wav', output_dir)

        # Apply the sync corrections
        try:
            synced_path = processor.apply_sync_to_audio(
                str(sb_file),
                offset_seconds,
                speed_factor,
                str(output_path)
            )

            results[name] = {
                'path': synced_path,
                'offset_seconds': offset_seconds,
                'offset_frames': offset_seconds * 29.97,
                'speed_factor': speed_factor,
                'drift_frames': sync_info['drift_frames'],
                'correlation': correlation
            }

        except Exception as e:
            results[name] = {
                'error': str(e)
            }

    print(f"  Applied to {len([r for r in results.values() if 'path' in r])} files\n", file=sys.stderr)

    return results


def sync_soundboard_files_simple(
    mic1_sb: str,
    mic2_sb: Optional[str],
    mic1_vmix: str,
    all_soundboard_files: List[str],
    output_dir: Optional[str] = None
) -> Tuple[float, float, List[str]]:
    """
    Simplified interface for soundboard sync.

    Args:
        mic1_sb: Path to mic 1 soundboard file
        mic2_sb: Path to mic 2 soundboard file (or None)
        mic1_vmix: Path to VMix mic 1 audio (Output 2)
        all_soundboard_files: List of ALL soundboard files to sync
        output_dir: Optional output directory

    Returns:
        Tuple of (offset_seconds, speed_factor, list_of_synced_files)
    """
    # Build dicts for main function
    soundboard_dict = {}
    for i, file in enumerate(all_soundboard_files):
        soundboard_dict[f'file{i}'] = file

    # Add mics specifically
    soundboard_dict['mic1'] = mic1_sb
    if mic2_sb:
        soundboard_dict['mic2'] = mic2_sb

    vmix_dict = {
        'mic1': mic1_vmix
    }

    # Run sync
    results = sync_soundboard_files(soundboard_dict, vmix_dict, output_dir)

    # Extract results - never silently substitute offset 0.0 / speed 1.0
    mic1_result = results.get('mic1')
    if mic1_result is None:
        raise RuntimeError(
            "Soundboard sync produced no result for 'mic1'; cannot determine offset/speed"
        )
    if 'error' in mic1_result:
        raise RuntimeError(
            f"Soundboard sync failed for 'mic1': {mic1_result['error']}"
        )

    offset = mic1_result['offset_seconds']
    speed = mic1_result['speed_factor']
    synced_files = [r['path'] for r in results.values() if 'path' in r]

    return offset, speed, synced_files
