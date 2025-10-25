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

from core.audio_sync import AudioSyncAnalyzer, MediaSyncProcessor


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

    print("="*70)
    print("SOUNDBOARD SYNC - Unified Offset & Drift Detection")
    print("="*70)
    print()

    # Step 2: Merge mic 1 + mic 2 if both exist
    print("Step 1: Preparing soundboard audio for correlation")
    print("-"*70)

    if mic2_sb and Path(mic2_sb).exists():
        print(f"Merging: Mic 1 + Mic 2 soundboard files")
        merged_sb = analyzer.merge_audio_files(mic1_sb, mic2_sb)
        cleanup_merged = (merged_sb != mic1_sb)  # Clean up if temp file was created
    else:
        print(f"Using: Mic 1 soundboard only (Mic 2 not available)")
        merged_sb = mic1_sb
        cleanup_merged = False

    print()

    # Step 3: Correlate merged soundboard vs VMix mic 1
    print("Step 2: Detecting sync parameters")
    print("-"*70)
    print(f"Correlating: Soundboard Mics vs VMix Mic 1 Audio")
    print(f"  Soundboard: {Path(merged_sb).name}")
    print(f"  VMix:       {Path(mic1_vmix).name}")
    print()

    try:
        sync_info = analyzer.analyze_sync(mic1_vmix, merged_sb, search_window=30)

        offset_seconds = sync_info['offset_seconds']
        speed_factor = sync_info['speed_factor']
        correlation = sync_info['correlation_score']

        print()
        print("DETECTED SYNC PARAMETERS:")
        print("="*70)
        print(f"Offset:       {offset_seconds:.3f}s ({offset_seconds * 29.97:.1f} frames)")
        print(f"Speed:        {speed_factor:.10f}")
        print(f"Drift:        {sync_info['drift_frames']:.1f} frames over {sync_info.get('master_duration', 0)/3600:.2f}h")
        print(f"Correlation:  {correlation:.3f}")
        print()

        if correlation < 0.3:
            print("⚠ WARNING: Low correlation score - sync may not be accurate")
            print("  Consider checking:")
            print("  - Files are from the same recording session")
            print("  - Audio levels are adequate")
            print("  - No excessive noise or distortion")
            print()

    finally:
        # Clean up merged file if it was temporary
        if cleanup_merged and Path(merged_sb).exists():
            os.unlink(merged_sb)

    # Step 4: Apply sync to ALL soundboard files
    print("Step 3: Applying sync to all soundboard files")
    print("-"*70)

    results = {}

    for name, sb_file in soundboard_files.items():
        if not sb_file or not Path(sb_file).exists():
            print(f"⊘ Skipping {name}: File not found")
            continue

        print(f"\nSyncing: {name}")
        print(f"  File: {Path(sb_file).name}")

        # Determine output path
        sb_path = Path(sb_file)
        if output_dir:
            output_path = Path(output_dir) / f"{sb_path.stem}_synced{sb_path.suffix}"
        else:
            output_path = sb_path.parent / f"{sb_path.stem}_synced{sb_path.suffix}"

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

            print(f"  ✓ Synced: {Path(synced_path).name}")

        except Exception as e:
            print(f"  ✗ Error: {e}")
            results[name] = {
                'error': str(e)
            }

    print()
    print("="*70)
    print(f"COMPLETE: Synced {len([r for r in results.values() if 'path' in r])}/{len(soundboard_files)} soundboard files")
    print("="*70)

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

    # Extract results
    offset = results.get('mic1', {}).get('offset_seconds', 0.0)
    speed = results.get('mic1', {}).get('speed_factor', 1.0)
    synced_files = [r['path'] for r in results.values() if 'path' in r]

    return offset, speed, synced_files
