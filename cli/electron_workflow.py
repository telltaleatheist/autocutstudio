#!/usr/bin/env python3
"""
Electron Workflow Script
Processes video with auto-editor and generates compound clips.
Called by Electron app via subprocess.
"""

import sys
import json
import os
from pathlib import Path
import subprocess
import atexit
import signal

# Add parent directory to path to import core modules
BASE_DIR = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(BASE_DIR))

from core.config import AutoCutStudioConfig
from core.compound_generators.cam_generator import CamGenerator
from core.compound_generators.gs_generator import GSGenerator
from core.compound_generators.ssb_generator import SSBGenerator
from core.compound_generators.dc_cam_generator import DCCamGenerator
from core.compound_generators.dc_gs_generator import DCGSGenerator
from core.compound_generators.dc_ssb_generator import DCSSBGenerator
from core.compound_generators.hybrid_compound_generator import HybridCompoundGenerator
from core.compound_generators.master_project_generator import MasterProjectGenerator
from core.compound_generators.shorts_cam_generator import ShortsCamGenerator
from core.compound_generators.shorts_ssb_generator import ShortsSSBGenerator
from core.compound_generators.shorts_hybrid_generator import ShortsHybridGenerator
from core.compound_generators.shorts_master_project_generator import ShortsMasterProjectGenerator
from core.audio_processor import AudioProcessor
from core.editors.auto_editor import AutoEditor
from core.editors.smart_cut_filter import SmartCutFilter
from core.skip_logic import SkipDecisionEngine
import zipfile
import select

# DO NOT reopen stdin - causes character loss issues
# Keep the original stdin as-is for reliable reading

# Try to import audio sync - it's optional
AUDIO_SYNC_AVAILABLE = False
try:
    from core.audio_sync import MediaSyncProcessor, _DEPENDENCIES_AVAILABLE
    AUDIO_SYNC_AVAILABLE = _DEPENDENCIES_AVAILABLE
    if AUDIO_SYNC_AVAILABLE:
        print("✓ Advanced audio sync system loaded (cross-correlation enabled)", file=sys.stderr)
    else:
        print("⚠ Advanced sync not available (using basic sync)", file=sys.stderr)
        print(f"  Reason: Python {sys.version_info.major}.{sys.version_info.minor} - requires 3.10-3.13", file=sys.stderr)
        MediaSyncProcessor = None
except Exception as e:
    print(f"⚠ Audio sync not available: {e}", file=sys.stderr)
    print("  Falling back to basic framerate sync", file=sys.stderr)
    MediaSyncProcessor = None

# Cleanup removed - user will manage their own files

def signal_handler(signum, frame):
    """Handle termination signals (cancel button, Ctrl+C, etc)."""
    print(f"\n⚠️  Workflow cancelled (signal {signum})", file=sys.stderr)
    sys.exit(1)

# Global flags for skip signal
_skip_requested = False
_last_skipped_file = None  # Track the file being processed when skip was requested

def skip_signal_handler(signum, frame):
    """Handle skip signal (SIGUSR1)."""
    global _skip_requested
    print("\n⏩ Skip signal received via SIGUSR1", file=sys.stderr)
    _skip_requested = True

# Register signal handlers for cancel/interrupt
signal.signal(signal.SIGTERM, signal_handler)  # Kill/cancel
signal.signal(signal.SIGINT, signal_handler)   # Ctrl+C
signal.signal(signal.SIGUSR1, skip_signal_handler)  # Skip signal

def emit_progress(progress, message, sub_progress=None):
    """Emit progress update as JSON to stdout."""
    data = {
        'type': 'progress',
        'progress': progress,
        'message': message
    }
    if sub_progress is not None:
        data['sub_progress'] = sub_progress
    print(json.dumps(data), flush=True)

def emit_error(error_message):
    """Emit error as JSON to stdout."""
    print(json.dumps({
        'type': 'error',
        'error': error_message
    }), flush=True)

def emit_skip_capabilities(skip_decisions):
    """Emit information about which operations can be skipped."""
    print(json.dumps({
        'type': 'skip_capabilities',
        'decisions': skip_decisions
    }), flush=True)

def emit_operation_start(operation_name, can_skip=False):
    """Emit start of a skippable operation."""
    print(json.dumps({
        'type': 'operation_start',
        'operation': operation_name,
        'can_skip': can_skip
    }), flush=True)

def check_for_skip_signal():
    """Check if skip signal was received via SIGUSR1.

    This is much more reliable than reading from stdin which has character loss issues.
    The signal handler sets the global _skip_requested flag when SIGUSR1 is received.

    NOTE: Does NOT reset the flag - caller must handle that after cleanup.
    """
    global _skip_requested
    return _skip_requested

def clear_skip_signal():
    """Clear the skip signal flag after handling it."""
    global _skip_requested
    _skip_requested = False

def emit_success(result):
    """Emit success result as JSON to stdout."""
    print(json.dumps({
        'type': 'success',
        'result': result
    }), flush=True)

def detect_framerate(video_path):
    """Auto-detect framerate from video file."""
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

            if abs(fps - 29.97) < 0.01:
                return "29.97"
            elif abs(fps - 30.0) < 0.01:
                return "30"
            else:
                return "29.97"  # Default fallback
        else:
            return "29.97"
    except Exception as e:
        print(f"Warning: Could not detect framerate, defaulting to 29.97: {e}", file=sys.stderr)
        return "29.97"

def create_xml_zip(xml_files, output_dir, session_name):
    """Create a zip file containing all XML files."""
    clean_name = session_name.replace(' ', '_')
    zip_path = Path(output_dir) / f"{clean_name}_compounds.zip"

    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for xml_path in xml_files:
            if xml_path and Path(xml_path).exists():
                arcname = f"{clean_name}/{Path(xml_path).name}"
                zipf.write(xml_path, arcname)

    # Clean up XML files
    for xml_path in xml_files:
        if xml_path and Path(xml_path).exists():
            try:
                Path(xml_path).unlink()
            except Exception as e:
                print(f"Warning: Could not delete {xml_path}: {e}", file=sys.stderr)

    return str(zip_path)

def main():
    """Main workflow execution."""
    try:
        # DEBUG: Print to verify this version is running
        print("\n🔥 Hybrid Mode v2.0 - Active", file=sys.stderr)

        # Read input from stdin (passed as JSON from Electron)
        # Only read first line so stdin remains open for skip signals
        input_line = sys.stdin.readline()
        data = json.loads(input_line.strip())

        # Load configuration from user config directory
        # On macOS: ~/Library/Application Support/AutoCutStudio/config/
        config_path = Path.home() / 'Library' / 'Application Support' / 'AutoCutStudio' / 'config' / 'autostudio_config.yaml'

        if not config_path.exists():
            raise FileNotFoundError(
                "No configuration found. Go to Settings > Relink Assets to set up your asset paths."
            )

        print(f"Using config: {config_path}", file=sys.stderr)
        config = AutoCutStudioConfig(str(config_path))

        # Extract parameters
        master_video = data['masterVideo']
        audio_sources_input = data.get('audioSources', {})
        audio_sync_settings = data.get('audioSyncSettings', {})
        threshold = data.get('threshold', config.default_threshold)
        video_sources = data.get('videoSources', {})
        auto_duck = data.get('autoDuck', False)
        use_downloaded_stream = data.get('useDownloadedStream', False)

        # Step 0.5: Analyze skip capabilities and emit to frontend
        emit_progress(3, 'Analyzing which operations can be skipped...')
        skip_engine = SkipDecisionEngine(master_video, audio_sources_input, video_sources)
        skip_decisions = skip_engine.get_all_skip_decisions()
        emit_skip_capabilities(skip_decisions)

        # Print skip summary to stderr for debugging
        print(skip_engine.generate_skip_summary(), file=sys.stderr)

        emit_progress(5, 'Detecting framerate...')
        detected_framerate = detect_framerate(master_video)

        # Create progress callback for FFmpeg operations (emits sub-progress)
        # This needs to be defined early since auto-editor may use it
        def ffmpeg_progress_callback(progress_info: dict):
            """Callback for FFmpeg progress updates.

            Args:
                progress_info: Dict with keys: frame, fps, time, speed, progress_percent
            """
            if 'progress_percent' in progress_info:
                percent = progress_info['progress_percent']
                speed = progress_info.get('speed', 0)

                # Build message with speed info if available
                if speed > 0:
                    message = f"Processing: {percent:.1f}% (speed: {speed:.1f}x)"
                else:
                    message = f"Processing: {percent:.1f}%"

                # Emit as sub-progress so it doesn't interfere with main workflow progress
                emit_progress(35, "Processing custom video sources...", sub_progress=percent)

        emit_progress(10, 'Running auto-editor to identify cuts...')

        # Step 1: Run auto-editor
        editor = AutoEditor(config, progress_callback=ffmpeg_progress_callback)
        editor.skip_check_callback = check_for_skip_signal
        altered_xml = editor.cut_silence(str(master_video), threshold or config.default_threshold)

        # Step 1.5: Smart cut filter — preserve video-watching segments
        # Uses screen audio to detect when the video is playing. Cuts are only
        # applied during sections where the screen audio is silent for 4+ seconds
        # (i.e. the video is paused and the creator is reacting).
        # Stream recovery mode is built solely on the downloaded master stream —
        # there are no individual audio tracks. Any screen-audio reference would
        # be from a different recording with a mismatched timeline, so cross-
        # referencing it scrambles the kept segments. Skip the smart cut filter.
        screen_audio = audio_sources_input.get('screen') or audio_sources_input.get('screenSb')

        if use_downloaded_stream:
            print("Stream recovery mode: skipping smart cut filter "
                  "(no individual audio tracks to reference)", file=sys.stderr)
        elif screen_audio and Path(screen_audio).exists():
            try:
                emit_progress(15, 'Analyzing screen audio for smart cuts...')
                ref_output = str(Path(screen_audio).parent /
                                f"{Path(screen_audio).stem}_SCREEN_ALTERED.fcpxml")
                # -55dB threshold for screen audio (quieter than mic audio).
                # No margin here — SmartCutFilter bridges gaps < 4s itself,
                # so reference boundaries stay precise at transitions.
                ref_altered_xml = editor.cut_silence(
                    str(screen_audio), '-55dB',
                    output_file=ref_output)
                smart_filter = SmartCutFilter()
                altered_xml = smart_filter.filter_cuts(altered_xml, ref_altered_xml)
                # Clean up reference XML
                try:
                    Path(ref_altered_xml).unlink()
                except Exception:
                    pass
            except Exception as e:
                print(f"WARNING: Smart cut filter failed: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)

        all_xml_files = [altered_xml]

        emit_progress(20, 'Converting to compound clip structure...')

        # Step 2: Convert to compound clip
        compound_xml = editor.convert_to_compound(altered_xml, str(master_video))
        if not compound_xml:
            raise Exception("Failed to create compound clip")

        all_xml_files.append(compound_xml)

        emit_progress(30, 'Processing audio sources...')

        # Step 3: Process audio files with optional advanced sync
        audio_processor = AudioProcessor(config, progress_callback=ffmpeg_progress_callback)
        # Attach skip check callback so FFmpeg can check for skip signals
        audio_processor.skip_check_callback = check_for_skip_signal
        processed_audio = {}

        # Check if advanced sync is available
        if AUDIO_SYNC_AVAILABLE and MediaSyncProcessor:
            print("Using advanced audio sync (cross-correlation)", file=sys.stderr)
            sync_processor = MediaSyncProcessor(config, progress_callback=ffmpeg_progress_callback)
            # Attach skip check callback so FFmpeg can check for skip signals
            sync_processor.skip_check_callback = check_for_skip_signal
            use_advanced_sync = True
        else:
            print("Using basic audio sync (framerate correction only)", file=sys.stderr)
            sync_processor = None
            use_advanced_sync = False

        # SOUNDBOARD SYNC: Detect and sync all soundboard files together
        # Soundboard files share the same offset and clock drift since they're
        # from the same device/recording session
        soundboard_files = {}
        vmix_files = {}
        soundboard_sync_params = None  # Will store offset + speed for all SB files

        # Identify soundboard files (type ends with 'Sb' or filename contains 'sb')
        for audio_type, audio_path in audio_sources_input.items():
            if audio_path and Path(audio_path).exists():
                # Check if this is a soundboard file by:
                # 1. Type name ends with 'Sb' (e.g., mic1Sb, screenSb) - camelCase
                # 2. Or filename contains 'sb' (backwards compatibility)
                is_soundboard = (audio_type.endswith('Sb') or
                                'sb' in Path(audio_path).name.lower())

                if is_soundboard:
                    soundboard_files[audio_type] = audio_path
                else:
                    vmix_files[audio_type] = audio_path

        # If we have soundboard files and advanced sync, sync them all at once
        if soundboard_files and use_advanced_sync:
            try:
                from core.soundboard_sync import sync_soundboard_files

                print("\n▶ Soundboard files detected - using unified sync", file=sys.stderr)
                print(f"  Found {len(soundboard_files)} soundboard files:", file=sys.stderr)
                for sb_type, sb_path in soundboard_files.items():
                    print(f"  - {sb_type}: {Path(sb_path).name}", file=sys.stderr)
                print(file=sys.stderr)

                # Add master to VMix files
                vmix_files['master'] = master_video

                # Normalize soundboard keys for the sync function
                # The sync function expects keys like 'mic1', 'mic2', 'screen', etc.
                # Remove 'Sb' suffix: mic1Sb -> mic1, screenSb -> screen
                normalized_sb_files = {}
                for sb_type, sb_path in soundboard_files.items():
                    # Remove the 'Sb' suffix to get the base type
                    base_type = sb_type.replace('Sb', '')
                    normalized_sb_files[base_type] = sb_path

                # Run unified soundboard sync
                emit_progress(30, 'Syncing soundboard files (unified detection)...')
                sb_results = sync_soundboard_files(normalized_sb_files, vmix_files)

                # Store synced files in processed_audio
                # sb_results has normalized keys ('mic1', 'screen', etc.)
                # We need to map these to the final audio types for compound generators
                for sb_type, sb_info in sb_results.items():
                    if 'path' in sb_info:
                        duration, sample_rate, channels = audio_processor.get_audio_info(sb_info['path'])

                        # Use the normalized type directly (mic1, screen, soundEffects, etc.)
                        final_type = sb_type

                        processed_audio[final_type] = {
                            'path': sb_info['path'],
                            'duration': duration,
                            'sample_rate': sample_rate,
                            'channels': channels,
                            'sync_info': {
                                'offset_seconds': sb_info['offset_seconds'],
                                'speed_factor': sb_info['speed_factor'],
                                'drift_frames': sb_info['drift_frames'],
                                'correlation_score': sb_info['correlation'],
                                'is_soundboard': True
                            }
                        }
                        print(f"✓ Soundboard {sb_type} synced via unified detection", file=sys.stderr)

                # Save sync params for reference
                if sb_results:
                    first_result = next(iter(sb_results.values()))
                    if 'offset_seconds' in first_result:
                        soundboard_sync_params = {
                            'offset': first_result['offset_seconds'],
                            'speed': first_result['speed_factor'],
                            'drift': first_result['drift_frames']
                        }

                print(f"\n✓ Soundboard unified sync complete!", file=sys.stderr)
                print(f"  Offset: {soundboard_sync_params['offset']:.3f}s", file=sys.stderr)
                print(f"  Speed: {soundboard_sync_params['speed']:.6f}", file=sys.stderr)
                print(f"  Drift: {soundboard_sync_params['drift']:.1f} frames\n", file=sys.stderr)

            except Exception as e:
                print(f"⚠ Warning: Soundboard unified sync failed: {e}", file=sys.stderr)
                print(f"  Falling back to individual sync for each file", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)
                # Don't add to processed_audio - let them be processed individually

        for audio_type, audio_path in audio_sources_input.items():
            if audio_path:
                # Normalize type: remove 'Sb' suffix (mic1Sb -> mic1)
                normalized_type = audio_type.replace('Sb', '')

                # Skip if already processed by soundboard unified sync
                # OR if we have a soundboard version and this is a VMix version
                if normalized_type in processed_audio:
                    existing_is_sb = processed_audio[normalized_type].get('sync_info', {}).get('is_soundboard', False)
                    current_is_sb = audio_type.endswith('Sb')

                    if existing_is_sb:
                        # Already have soundboard version - skip this (don't overwrite with VMix)
                        print(f"⊷ Skipping {audio_type} - already have soundboard version for {normalized_type}", file=sys.stderr)
                        continue
                    elif current_is_sb:
                        # This is soundboard but we have VMix - replace it
                        print(f"⚠ Replacing VMix {normalized_type} with soundboard version", file=sys.stderr)
                    else:
                        # Both are same type (both VMix or both SB) - skip duplicate
                        print(f"⊷ Skipping {audio_type} - already processed {normalized_type}", file=sys.stderr)
                        continue

                synced_path = None  # Track synced file for cleanup if needed
                skip_was_requested = False  # Track if skip happened during this operation

                # Check if this is an output file (not soundboard, not capture)
                # Output files are already synced with master and should be used as-is
                filename = Path(audio_path).name.lower()
                type_is_soundboard = audio_type.endswith('Sb')
                is_output_file = not type_is_soundboard and 'sb' not in filename and 'capture' not in filename

                if is_output_file:
                    # Output file - use as-is without any sync processing
                    print(f"\n{'='*60}", file=sys.stderr)
                    print(f"Processing {audio_type}: {Path(audio_path).name}", file=sys.stderr)
                    print(f"  Output file detected - using as-is (no sync needed)", file=sys.stderr)
                    print(f"{'='*60}\n", file=sys.stderr)

                    try:
                        duration, sample_rate, channels = audio_processor.get_audio_info(audio_path)
                        # Store with normalized type for compound generators
                        processed_audio[normalized_type] = {
                            'path': audio_path,
                            'duration': duration,
                            'sample_rate': sample_rate,
                            'channels': channels,
                            'sync_info': {
                                'is_output_file': True
                            }
                        }
                    except Exception as e:
                        print(f"Error getting audio info: {e}", file=sys.stderr)
                    continue

                try:
                    # Check if this audio can be skipped
                    audio_decision = skip_decisions['audio'].get(audio_type, {})
                    can_skip = audio_decision.get('can_skip', False)

                    # Clear any previous skip signal
                    clear_skip_signal()

                    # Emit operation start (frontend will enable skip button)
                    emit_operation_start(f"Syncing {audio_type} audio", can_skip=can_skip)

                    # NOTE: Skip checking happens during FFmpeg encoding via skip_check_callback
                    # Don't check immediately - give user time to see the button and click it

                    if use_advanced_sync:
                        # Advanced sync using cross-correlation
                        emit_progress(30, f'Syncing {audio_type} audio with master...')
                        print(f"\n{'='*60}", file=sys.stderr)
                        print(f"Processing {audio_type}: {Path(audio_path).name}", file=sys.stderr)

                        try:
                            synced_path, sync_info = sync_processor.sync_file(
                                master_path=master_video,
                                source_path=audio_path,
                                search_window=30
                            )
                        except InterruptedError:
                            skip_was_requested = True
                            raise  # Re-raise to be caught by outer handler

                        # Check if skip was requested during processing (even if FFmpeg completed)
                        if check_for_skip_signal():
                            skip_was_requested = True
                            raise InterruptedError("Skip requested after processing completed")

                        duration, sample_rate, channels = audio_processor.get_audio_info(synced_path)

                        # Store with normalized type for compound generators
                        processed_audio[normalized_type] = {
                            'path': synced_path,
                            'duration': duration,
                            'sample_rate': sample_rate,
                            'channels': channels,
                            'sync_info': sync_info
                        }

                        print(f"✓ {audio_type} synced successfully:", file=sys.stderr)
                        print(f"  Offset: {sync_info['offset_seconds']:.3f}s", file=sys.stderr)
                        print(f"  Speed correction: {sync_info['speed_factor']:.6f}", file=sys.stderr)
                        print(f"  Drift: {sync_info['drift_frames']:.1f} frames", file=sys.stderr)
                        if sync_info['is_soundboard']:
                            print(f"  🎚️  Soundboard file detected - applied clock correction", file=sys.stderr)
                        print(f"{'='*60}\n", file=sys.stderr)

                    else:
                        # Basic processing - just extract/sync if requested
                        apply_sync = audio_sync_settings.get(audio_type, False)
                        try:
                            synced_path, duration, sample_rate, channels = \
                                audio_processor.process_audio_source(audio_path, apply_sync)
                        except InterruptedError:
                            skip_was_requested = True
                            raise  # Re-raise to be caught by outer handler

                        # Check if skip was requested during processing (even if FFmpeg completed)
                        if check_for_skip_signal():
                            skip_was_requested = True
                            raise InterruptedError("Skip requested after processing completed")

                        # Store with normalized type for compound generators
                        processed_audio[normalized_type] = {
                            'path': synced_path,
                            'duration': duration,
                            'sample_rate': sample_rate,
                            'channels': channels
                        }
                        sync_status = "with framerate sync" if apply_sync else "without sync"
                        print(f"Processed {audio_type} audio ({sync_status})", file=sys.stderr)

                except InterruptedError:
                    # Skip was requested - delete the synced file if it was created
                    print(f"\n⏩ SKIP CONFIRMED - {audio_type} audio will be omitted\n", file=sys.stderr)

                    # Delete the synced file if it exists
                    if synced_path and synced_path != audio_path:
                        if Path(synced_path).exists():
                            print(f"🗑️  Deleting skipped file: {Path(synced_path).name}", file=sys.stderr)
                            try:
                                Path(synced_path).unlink()
                                print(f"✓ Successfully deleted: {Path(synced_path).name}", file=sys.stderr)
                            except Exception as del_err:
                                print(f"⚠️  Could not delete {synced_path}: {del_err}", file=sys.stderr)
                        else:
                            print(f"ℹ️  No synced file to delete (processing was interrupted early)", file=sys.stderr)

                    # Clear the skip signal for next operation
                    clear_skip_signal()

                    # Don't add to processed_audio - will be omitted from output
                    continue
                except Exception as e:
                    print(f"Warning: Failed to process {audio_type} audio: {e}", file=sys.stderr)
                    import traceback
                    traceback.print_exc(file=sys.stderr)
                    print(f"Using original file without sync", file=sys.stderr)
                    # Fallback to original file
                    try:
                        duration, sample_rate, channels = audio_processor.get_audio_info(audio_path)
                        # Store with normalized type for compound generators
                        processed_audio[normalized_type] = {
                            'path': audio_path,
                            'duration': duration,
                            'sample_rate': sample_rate,
                            'channels': channels
                        }
                    except Exception as e2:
                        print(f"Error getting audio info: {e2}", file=sys.stderr)

        # Step 3.5: Process video sources with optional advanced sync
        emit_progress(35, 'Processing custom video sources...')
        processed_video_sources = {}

        # DEBUG: Show what video sources we received
        print(f"\n▶ Processing video sources", file=sys.stderr)
        print(f"  Received video_sources: {video_sources}", file=sys.stderr)
        print(f"  Looking for: screen, game", file=sys.stderr)

        # Check for empty strings or None values
        for vtype in ['screen', 'game', 'cam1', 'cam2']:
            if vtype in video_sources:
                vpath = video_sources[vtype]
                if not vpath or vpath == '':
                    print(f"  ⚠️  {vtype} is empty string", file=sys.stderr)
                elif not Path(vpath).exists():
                    print(f"  ⚠️  {vtype} file does not exist: {vpath}", file=sys.stderr)

        # Process screen and game captures
        # NOTE: We do NOT re-render these with ffmpeg. Instead, we pass the original files
        # to the compound generators which will apply XML retiming (timeMap) to sync them.
        # This is much faster and avoids quality loss from re-encoding.
        for video_type in ['screen', 'game']:
            if video_type in video_sources and video_sources[video_type]:
                print(f"\n  Found {video_type} video: {Path(video_sources[video_type]).name}", file=sys.stderr)
                original_path = video_sources[video_type]

                try:
                    # Clear any previous skip signal
                    clear_skip_signal()

                    # Emit operation start - these are skippable (can use master quadrant)
                    emit_operation_start(f"Preparing {video_type} video", can_skip=True)

                    # Check if skip was requested
                    if check_for_skip_signal():
                        raise InterruptedError("Skip requested - will use master quadrant")

                    # Just use the original file - no retiming needed!
                    # Screen/game captures recorded simultaneously with master have matching
                    # durations despite different framerates. FCPX will handle the playback.
                    processed_video_sources[video_type] = original_path

                    # Detect framerate for logging
                    video_fps = audio_processor.get_video_framerate(original_path)
                    print(f"✓ {video_type} video prepared (no re-encoding):", file=sys.stderr)
                    print(f"  Source framerate: {video_fps:.2f}fps", file=sys.stderr)
                    print(f"  Duration matches master - FCPX will handle playback", file=sys.stderr)

                except InterruptedError as e:
                    # Skip was requested - will use master quadrant
                    print(f"\n⏩ SKIP CONFIRMED - {video_type} video will use master quadrant\n", file=sys.stderr)

                    # Clear the skip signal for next operation
                    clear_skip_signal()

                    # Don't add to processed_video_sources - will use master quadrant
                    continue
                except Exception as e:
                    print(f"Warning: Failed to prepare {video_type} video: {e}", file=sys.stderr)
                    import traceback
                    traceback.print_exc(file=sys.stderr)
                    print(f"Using original video", file=sys.stderr)
                    processed_video_sources[video_type] = video_sources[video_type]

        # Copy cam1 and cam2 without processing (they're from master video, already aligned)
        for cam_type in ['cam1', 'cam2']:
            if cam_type in video_sources and video_sources[cam_type]:
                processed_video_sources[cam_type] = video_sources[cam_type]
                print(f"  Copied {cam_type} video without processing", file=sys.stderr)

        # Use processed video sources for the rest of the workflow
        video_sources = processed_video_sources if processed_video_sources else video_sources

        # DEBUG: Show final video sources being used
        print(f"\n✓ Final video sources for compound generation:", file=sys.stderr)
        for vtype, vpath in video_sources.items():
            if vpath:
                print(f"  {vtype}: {Path(vpath).name}", file=sys.stderr)

        # Step 3.5: Apply Dugan automixer if enabled (BEFORE generating any compounds)
        if auto_duck:
            emit_progress(38, 'Applying Dugan automixer...')
            print("\n=== Dugan Automixer Enabled ===", file=sys.stderr)

            # Build track list for Dugan - include all processed audio tracks
            dugan_tracks = []
            print(f"\nProcessed audio sources available for Dugan:", file=sys.stderr)
            for audio_type, audio_info in processed_audio.items():
                if audio_info and audio_info.get('path'):
                    is_sb = audio_info.get('sync_info', {}).get('is_soundboard', False)
                    sb_tag = " [SOUNDBOARD]" if is_sb else " [VMIX/REGULAR]"
                    print(f"  {audio_type}: {Path(audio_info['path']).name}{sb_tag}", file=sys.stderr)
                    dugan_tracks.append({
                        'type': audio_type,
                        'path': audio_info['path']
                    })
            print(file=sys.stderr)

            if len(dugan_tracks) >= 2:
                # Send ducking request to Electron (TypeScript Dugan automixer)
                emit_progress(38, f'Sending {len(dugan_tracks)} tracks to Dugan automixer...')
                print(json.dumps({
                    'type': 'ducking_request',
                    'tracks': dugan_tracks
                }), flush=True)

                # Wait for ducking_complete response on stdin
                print("Waiting for Dugan automixer response from Electron...", file=sys.stderr)
                response_line = sys.stdin.readline()
                if response_line:
                    response = json.loads(response_line.strip())
                    if response.get('type') == 'ducking_complete':
                        if response.get('error'):
                            print(f"⚠ Dugan automixer error: {response['error']}", file=sys.stderr)
                            emit_progress(39, f'Dugan automixer FAILED: {response["error"]}')
                        else:
                            # Update processed_audio paths with ducked versions
                            ducked_tracks = response.get('tracks', [])
                            for track in ducked_tracks:
                                t_type = track['type']
                                t_path = track['path']
                                if t_type in processed_audio:
                                    processed_audio[t_type]['path'] = t_path
                                    print(f"✓ Updated {t_type} with Dugan-processed file", file=sys.stderr)
                            print(f"✓ Dugan automixer applied to {len(ducked_tracks)} tracks", file=sys.stderr)
                            emit_progress(39, f'Dugan automixer applied to {len(ducked_tracks)} tracks')
                    else:
                        print(f"⚠ Unexpected response type: {response.get('type')}", file=sys.stderr)
                        emit_progress(39, f'Dugan: unexpected response type: {response.get("type")}')
                else:
                    print("⚠ No response received from Electron for Dugan automixer", file=sys.stderr)
                    emit_progress(39, 'Dugan: no response received from Electron')
            else:
                print(f"⚠ Only {len(dugan_tracks)} track(s) available - need at least 2 for Dugan", file=sys.stderr)
                emit_progress(39, f'Dugan skipped: only {len(dugan_tracks)} track(s), need 2+')

            print("=== Dugan Automixer Complete ===\n", file=sys.stderr)

        # Step 4: Generate compound clips
        generated_clips = []
        progress_per_clip = 50 / 6
        current_progress = 40

        # Build CAM audio sources (mic1-4, soundEffects)
        cam_audio_sources = {}
        for audio_type in ['mic1', 'mic2', 'mic3', 'mic4', 'soundEffects']:
            # Check if this audio type was processed (could be from soundboard or VMix)
            if audio_type in processed_audio:
                cam_audio_sources[audio_type] = processed_audio[audio_type]['path']
                # Check if it was a soundboard file by looking at sync_info
                if 'sync_info' in processed_audio[audio_type] and processed_audio[audio_type].get('sync_info', {}).get('is_soundboard'):
                    print(f"✓ Using soundboard file for {audio_type}", file=sys.stderr)
                else:
                    print(f"Using VMix/regular file for {audio_type}", file=sys.stderr)

        # Store paths for master project generation
        cam_solo_path = None
        cam_dual_path = None
        gs_solo_path = None
        gs_dual_path = None
        ssb_solo_path = None
        ssb_dual_path = None

        # Generate CAM Solo
        emit_progress(current_progress, 'Generating CAM Solo compound clip...')
        try:
            cam_generator = CamGenerator(config)
            cam_solo_path = cam_generator.generate_cam_compound(
                compound_xml, cam_audio_sources, 'solo', None, False, video_sources,
                use_downloaded_stream=use_downloaded_stream
            )
            all_xml_files.append(cam_solo_path)
            generated_clips.append({
                'type': 'cam_solo',
                'name': 'CAM - Solo Camera',
                'path': cam_solo_path
            })
        except Exception as e:
            print(f"Error generating CAM Solo: {e}", file=sys.stderr)
        current_progress += progress_per_clip

        # Generate CAM Dual
        emit_progress(current_progress, 'Generating CAM Dual Camera compound clip...')
        try:
            dc_cam_generator = DCCamGenerator(config)
            cam_dual_path = dc_cam_generator.generate_dc_cam_compound(
                compound_xml, cam_audio_sources, None, False, video_sources,
                use_downloaded_stream=use_downloaded_stream
            )
            all_xml_files.append(cam_dual_path)
            generated_clips.append({
                'type': 'cam_dual',
                'name': 'CAM - Dual Camera',
                'path': cam_dual_path
            })
        except Exception as e:
            print(f"Error generating CAM Dual: {e}", file=sys.stderr)
        current_progress += progress_per_clip

        # Build GS audio sources (all audio types)
        gs_audio_sources = {}
        for audio_type in ['mic1', 'mic2', 'mic3', 'mic4', 'screen', 'game', 'soundEffects', 'bluetooth', 'desktop']:
            # Check if this audio type was processed (could be from soundboard or VMix)
            if audio_type in processed_audio:
                gs_audio_sources[audio_type] = processed_audio[audio_type]['path']
                # Check if it was a soundboard file by looking at sync_info
                if 'sync_info' in processed_audio[audio_type] and processed_audio[audio_type].get('sync_info', {}).get('is_soundboard'):
                    print(f"✓ Using soundboard file for {audio_type}", file=sys.stderr)
                else:
                    print(f"Using VMix/regular file for {audio_type}", file=sys.stderr)

        # Generate GS Solo
        emit_progress(current_progress, 'Generating GS Solo compound clip...')
        try:
            gs_generator = GSGenerator(config)
            gs_solo_path = gs_generator.generate_gs_compound(
                compound_xml, gs_audio_sources, None, False, video_sources, auto_duck,
                use_downloaded_stream=use_downloaded_stream
            )
            all_xml_files.append(gs_solo_path)
            generated_clips.append({
                'type': 'gs_solo',
                'name': 'GS - Solo Game Share',
                'path': gs_solo_path
            })
        except Exception as e:
            print(f"Error generating GS Solo: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
        current_progress += progress_per_clip

        # Generate GS Dual
        emit_progress(current_progress, 'Generating GS Dual Camera compound clip...')
        try:
            dc_gs_generator = DCGSGenerator(config)
            gs_dual_path = dc_gs_generator.generate_dc_gs_compound(
                compound_xml, gs_audio_sources, None, False, video_sources, auto_duck,
                use_downloaded_stream=use_downloaded_stream
            )
            all_xml_files.append(gs_dual_path)
            generated_clips.append({
                'type': 'gs_dual',
                'name': 'GS - Dual Camera',
                'path': gs_dual_path
            })
        except Exception as e:
            print(f"Error generating GS Dual: {e}", file=sys.stderr)
        current_progress += progress_per_clip

        # Build SSB audio sources (same as GS)
        ssb_audio_sources = gs_audio_sources.copy()

        # Generate SSB Solo
        emit_progress(current_progress, 'Generating SSB Solo compound clip...')
        try:
            ssb_generator = SSBGenerator(config)
            ssb_solo_path = ssb_generator.generate_ssb_compound(
                compound_xml, ssb_audio_sources, 'solo', None, False, video_sources,
                use_downloaded_stream=use_downloaded_stream
            )
            all_xml_files.append(ssb_solo_path)
            generated_clips.append({
                'type': 'ssb_solo',
                'name': 'SSB - Solo Screen Share Beside',
                'path': ssb_solo_path
            })
        except Exception as e:
            print(f"Error generating SSB Solo: {e}", file=sys.stderr)
        current_progress += progress_per_clip

        # Generate SSB Dual
        emit_progress(current_progress, 'Generating SSB Dual Camera compound clip...')
        try:
            dc_ssb_generator = DCSSBGenerator(config)
            ssb_dual_path = dc_ssb_generator.generate_dc_ssb_compound(
                compound_xml, ssb_audio_sources, None, False, video_sources,
                use_downloaded_stream=use_downloaded_stream
            )
            all_xml_files.append(ssb_dual_path)
            generated_clips.append({
                'type': 'ssb_dual',
                'name': 'SSB - Dual Camera',
                'path': ssb_dual_path
            })
        except Exception as e:
            print(f"Error generating SSB Dual: {e}", file=sys.stderr)
        current_progress += progress_per_clip

        # Get original name from master video path
        original_name = Path(master_video).stem.replace(' master', '')

        # Generate hybrid compounds if DC compounds exist
        hybrid_cam_path = None
        hybrid_gs_path = None
        hybrid_ssb_path = None
        camera_segments = None  # Will be populated by hybrid generation for reuse in shorts
        if cam_dual_path and gs_dual_path and ssb_dual_path:
            try:
                emit_progress(88, 'Generating adaptive hybrid compounds...')
                print(f"\nGenerating hybrid compounds from DC compounds", file=sys.stderr)
                hybrid_gen = HybridCompoundGenerator(config)
                # Use the same output directory as the DC compounds
                output_dir = str(Path(cam_dual_path).parent)
                hybrid_cam_path, hybrid_gs_path, hybrid_ssb_path, camera_segments = hybrid_gen.generate_hybrid_compounds(
                    cam_dual_path,
                    gs_dual_path,
                    ssb_dual_path,
                    str(master_video),  # Original master video for detection
                    output_dir,
                    use_downloaded_stream=use_downloaded_stream
                )
                all_xml_files.extend([hybrid_cam_path, hybrid_gs_path, hybrid_ssb_path])
                generated_clips.append({
                    'type': 'hybrid',
                    'name': 'Hybrid Compounds',
                    'path': hybrid_cam_path
                })
                print(f"Successfully generated hybrid compounds", file=sys.stderr)
            except Exception as e:
                print(f"Error generating hybrid compounds: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)
                camera_segments = None  # Set to None if hybrid generation failed

        # Generate master projects
        emit_progress(90, 'Generating Master SOLO project...')
        print(f"Master SOLO check - cam_solo_path: {cam_solo_path}, gs_solo_path: {gs_solo_path}, ssb_solo_path: {ssb_solo_path}", file=sys.stderr)
        if cam_solo_path and gs_solo_path and ssb_solo_path:
            try:
                master_gen = MasterProjectGenerator(config)
                master_solo_paths = master_gen.generate_solo_master_project(
                    cam_solo_path, gs_solo_path, ssb_solo_path, original_name
                )
                # Add all generated parts to XML files list
                all_xml_files.extend(master_solo_paths)
                generated_clips.append({
                    'type': 'master_solo',
                    'name': 'Master SOLO Project',
                    'path': master_solo_paths[0] if master_solo_paths else None
                })
                print(f"Successfully generated Master SOLO: {master_solo_paths}", file=sys.stderr)
            except Exception as e:
                print(f"Error generating Master SOLO: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)
        else:
            print(f"Cannot generate Master SOLO - missing required compounds", file=sys.stderr)

        emit_progress(92, 'Generating Master DC project...')
        print(f"Master DC check - cam_dual_path: {cam_dual_path}, gs_dual_path: {gs_dual_path}, ssb_dual_path: {ssb_dual_path}", file=sys.stderr)
        if cam_dual_path and gs_dual_path and ssb_dual_path:
            try:
                master_gen = MasterProjectGenerator(config)
                master_dc_paths = master_gen.generate_dc_master_project(
                    cam_dual_path, gs_dual_path, ssb_dual_path, original_name
                )
                # Add all generated parts to XML files list
                all_xml_files.extend(master_dc_paths)
                generated_clips.append({
                    'type': 'master_dc',
                    'name': 'Master DC Project',
                    'path': master_dc_paths[0] if master_dc_paths else None
                })
                print(f"Successfully generated Master DC: {master_dc_paths}", file=sys.stderr)
            except Exception as e:
                print(f"Error generating Master DC: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)
        else:
            print(f"Cannot generate Master DC - missing required compounds", file=sys.stderr)

        # Generate Master Hybrid project if hybrid compounds exist
        if hybrid_cam_path and hybrid_gs_path and hybrid_ssb_path:
            try:
                emit_progress(94, 'Generating Master Hybrid project...')
                print(f"Generating Master Hybrid project", file=sys.stderr)
                master_gen = MasterProjectGenerator(config)
                # Use the DC method but with hybrid compounds - the compounds themselves handle the adaptation
                master_hybrid_paths = master_gen.generate_dc_master_project(
                    hybrid_cam_path, hybrid_gs_path, hybrid_ssb_path, original_name
                )
                # Rename from DC to Hybrid in the generated files
                for path in master_hybrid_paths:
                    if Path(path).exists():
                        new_path = Path(path).parent / Path(path).name.replace('_DC', '_HYBRID')
                        Path(path).rename(new_path)
                        all_xml_files.append(str(new_path))

                generated_clips.append({
                    'type': 'master_hybrid',
                    'name': 'Master Hybrid Project',
                    'path': str(new_path) if master_hybrid_paths else None
                })
                print(f"Successfully generated Master Hybrid: {new_path}", file=sys.stderr)
            except Exception as e:
                print(f"Error generating Master Hybrid: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)

        # Generate Shorts compounds and master project
        print(f"\n\n🔴🔴🔴 SHORTS SECTION STARTING 🔴🔴🔴", file=sys.stderr)
        print(f"Variables available: compound_xml={compound_xml is not None}, cam_audio_sources={len(cam_audio_sources) if cam_audio_sources else 0} sources, video_sources={len(video_sources) if video_sources else 0} sources", file=sys.stderr)
        sys.stderr.flush()
        shorts_cam_solo_path = None
        shorts_ssb_solo_path = None
        shorts_cam_dual_path = None
        shorts_ssb_dual_path = None
        shorts_hybrid_cam_path = None
        shorts_hybrid_ssb_path = None

        try:
            emit_progress(94, 'Generating Shorts CAM Solo compound...')
            print(f"\nGenerating Shorts CAM Solo compound", file=sys.stderr)
            shorts_cam_gen = ShortsCamGenerator(config)
            output_dir = str(Path(cam_solo_path).parent) if cam_solo_path else str(Path(master_video).parent)
            shorts_cam_solo_path = shorts_cam_gen.generate_shorts_cam_compound(
                compound_xml, cam_audio_sources, 'solo', None, False, video_sources,
                use_downloaded_stream=use_downloaded_stream
            )
            all_xml_files.append(shorts_cam_solo_path)
            print(f"Successfully generated Shorts CAM Solo: {shorts_cam_solo_path}", file=sys.stderr)
        except Exception as e:
            print(f"Error generating Shorts CAM Solo: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)

        try:
            emit_progress(94.5, 'Generating Shorts SSB Solo compound...')
            print(f"\nGenerating Shorts SSB Solo compound", file=sys.stderr)
            shorts_ssb_gen = ShortsSSBGenerator(config)
            shorts_ssb_solo_path = shorts_ssb_gen.generate_shorts_ssb_compound(
                compound_xml, ssb_audio_sources, 'solo', None, False, video_sources,
                use_downloaded_stream=use_downloaded_stream
            )
            all_xml_files.append(shorts_ssb_solo_path)
            print(f"Successfully generated Shorts SSB Solo: {shorts_ssb_solo_path}", file=sys.stderr)
        except Exception as e:
            print(f"Error generating Shorts SSB Solo: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)

        try:
            emit_progress(95, 'Generating Shorts CAM Dual compound...')
            print(f"\nGenerating Shorts CAM Dual compound", file=sys.stderr)
            shorts_cam_dual_path = shorts_cam_gen.generate_shorts_cam_compound(
                compound_xml, cam_audio_sources, 'dual', None, False, video_sources,
                use_downloaded_stream=use_downloaded_stream
            )
            all_xml_files.append(shorts_cam_dual_path)
            print(f"Successfully generated Shorts CAM Dual: {shorts_cam_dual_path}", file=sys.stderr)
        except Exception as e:
            print(f"Error generating Shorts CAM Dual: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)

        try:
            emit_progress(95.5, 'Generating Shorts SSB Dual compound...')
            print(f"\nGenerating Shorts SSB Dual compound", file=sys.stderr)
            shorts_ssb_dual_path = shorts_ssb_gen.generate_shorts_ssb_compound(
                compound_xml, ssb_audio_sources, 'dual', None, False, video_sources,
                use_downloaded_stream=use_downloaded_stream
            )
            all_xml_files.append(shorts_ssb_dual_path)
            print(f"Successfully generated Shorts SSB Dual: {shorts_ssb_dual_path}", file=sys.stderr)
        except Exception as e:
            print(f"Error generating Shorts SSB Dual: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)

        # Generate Shorts Hybrid compounds if both CAM and SSB DC exist
        if shorts_cam_dual_path and shorts_ssb_dual_path:
            try:
                emit_progress(96, 'Generating Shorts Hybrid compounds...')
                print(f"\nGenerating Shorts Hybrid compounds", file=sys.stderr)
                shorts_hybrid_gen = ShortsHybridGenerator(config)
                output_dir = str(Path(shorts_cam_dual_path).parent)
                shorts_hybrid_cam_path, shorts_hybrid_ssb_path = shorts_hybrid_gen.generate_shorts_hybrid_compounds(
                    shorts_cam_dual_path,
                    shorts_ssb_dual_path,
                    str(master_video),
                    output_dir,
                    use_downloaded_stream=use_downloaded_stream,
                    segments=camera_segments  # Reuse segments from horizontal hybrid generation
                )
                all_xml_files.extend([shorts_hybrid_cam_path, shorts_hybrid_ssb_path])
                print(f"Successfully generated Shorts Hybrid compounds", file=sys.stderr)
            except Exception as e:
                print(f"Error generating Shorts Hybrid compounds: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)

        # Generate Shorts Master Project if hybrid compounds exist
        if shorts_hybrid_cam_path and shorts_hybrid_ssb_path:
            try:
                emit_progress(97, 'Generating Master Shorts project...')
                print(f"\nGenerating Master Shorts project", file=sys.stderr)
                shorts_master_gen = ShortsMasterProjectGenerator(config)
                master_shorts_paths = shorts_master_gen.generate_shorts_master_project(
                    shorts_hybrid_cam_path, shorts_hybrid_ssb_path, original_name
                )
                all_xml_files.extend(master_shorts_paths)
                generated_clips.append({
                    'type': 'master_shorts',
                    'name': 'Master Shorts Project',
                    'path': master_shorts_paths[0] if master_shorts_paths else None
                })
                print(f"Successfully generated Master Shorts: {master_shorts_paths}", file=sys.stderr)
            except Exception as e:
                print(f"Error generating Master Shorts: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)

        # Create ZIP file
        emit_progress(98, 'Creating compound clips ZIP file...')
        session_name = Path(master_video).stem.replace(' master', '')
        output_dir = Path(master_video).parent
        zip_path = create_xml_zip(all_xml_files, output_dir, session_name)

        emit_progress(100, 'Processing complete!')

        # Emit success
        emit_success({
            'zipPath': zip_path,
            'clips': generated_clips,
            'session': session_name
        })

    except Exception as e:
        emit_error(str(e))
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
