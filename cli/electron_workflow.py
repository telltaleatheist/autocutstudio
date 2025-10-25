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
from core.audio_processor import AudioProcessor
from core.editors.auto_editor import AutoEditor
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

def should_generate(xml_type, xml_options):
    """Check if we should generate a specific XML type."""
    if not xml_options:
        return True
    return xml_type in xml_options

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
        print("=" * 80, file=sys.stderr)
        print("🔥 HYBRID MODE PYTHON CODE VERSION 2.0 - CHANGES ACTIVE! 🔥", file=sys.stderr)
        print("=" * 80, file=sys.stderr)

        # Read input from stdin (passed as JSON from Electron)
        # Only read first line so stdin remains open for skip signals
        input_line = sys.stdin.readline()
        data = json.loads(input_line.strip())

        # Load configuration
        config_path = BASE_DIR / 'config' / 'autostudio_config.yaml'
        config = AutoCutStudioConfig(str(config_path))

        # Extract parameters
        master_video = data['masterVideo']
        audio_sources_input = data.get('audioSources', {})
        audio_sync_settings = data.get('audioSyncSettings', {})
        threshold = data.get('threshold', config.default_threshold)
        xml_options = data.get('xmlOptions')
        video_sources = data.get('videoSources', {})

        # Step 0.5: Analyze skip capabilities and emit to frontend
        emit_progress(3, 'Analyzing which operations can be skipped...')
        skip_engine = SkipDecisionEngine(master_video, audio_sources_input, video_sources)
        skip_decisions = skip_engine.get_all_skip_decisions()
        emit_skip_capabilities(skip_decisions)

        # Print skip summary to stderr for debugging
        print(skip_engine.generate_skip_summary(), file=sys.stderr)

        emit_progress(5, 'Detecting framerate...')
        detected_framerate = detect_framerate(master_video)

        emit_progress(10, 'Running auto-editor to identify cuts...')

        # Step 1: Run auto-editor
        editor = AutoEditor(config)
        altered_xml = editor.cut_silence(str(master_video), threshold or config.default_threshold)

        all_xml_files = [altered_xml]

        emit_progress(20, 'Converting to compound clip structure...')

        # Step 2: Convert to compound clip
        compound_xml = editor.convert_to_compound(altered_xml, str(master_video))
        if not compound_xml:
            raise Exception("Failed to create compound clip")

        all_xml_files.append(compound_xml)

        emit_progress(30, 'Processing audio sources...')

        # Step 3: Process audio files with optional advanced sync
        # Create progress callback for FFmpeg operations (emits sub-progress)
        def ffmpeg_progress_callback(progress_info: dict):
            """Callback for FFmpeg progress updates.

            Args:
                progress_info: Dict with keys: frame, fps, time, speed, progress_percent
            """
            # Get current overall progress from the step we're on
            current_overall = 35  # We're in the video processing step
            percent = progress_info.get('progress_percent', 0)
            emit_progress(current_overall, 'Processing media sources...', sub_progress=percent)

        audio_processor = AudioProcessor(config, progress_callback=ffmpeg_progress_callback)
        # Attach skip check callback so FFmpeg can check for skip signals
        audio_processor.skip_check_callback = check_for_skip_signal
        processed_audio = {}

        # Check if advanced sync is available
        if AUDIO_SYNC_AVAILABLE and MediaSyncProcessor:
            print("Using advanced audio sync (cross-correlation)", file=sys.stderr)
            sync_processor = MediaSyncProcessor(config)
            use_advanced_sync = True
        else:
            print("Using basic audio sync (framerate correction only)", file=sys.stderr)
            sync_processor = None
            use_advanced_sync = False

        for audio_type, audio_path in audio_sources_input.items():
            if audio_path:
                synced_path = None  # Track synced file for cleanup if needed
                skip_was_requested = False  # Track if skip happened during this operation

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

                        processed_audio[audio_type] = {
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

                        processed_audio[audio_type] = {
                            'path': synced_path,
                            'duration': duration,
                            'sample_rate': sample_rate,
                            'channels': channels
                        }
                        sync_status = "with framerate sync" if apply_sync else "without sync"
                        print(f"Processed {audio_type} audio ({sync_status})", file=sys.stderr)

                except InterruptedError:
                    # Skip was requested - delete the synced file if it was created
                    print("=" * 80, file=sys.stderr)
                    print(f"⏩ SKIP CONFIRMED - {audio_type} audio will be omitted", file=sys.stderr)
                    print("=" * 80, file=sys.stderr)

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
                        processed_audio[audio_type] = {
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

        # Process screen and game captures
        for video_type in ['screen', 'game']:
            if video_type in video_sources and video_sources[video_type]:
                synced_path = None  # Track synced file for cleanup if needed
                original_path = video_sources[video_type]
                skip_was_requested = False  # Track if skip happened during this operation

                try:
                    # Clear any previous skip signal
                    clear_skip_signal()

                    # Emit operation start - these are skippable (can use master quadrant)
                    emit_operation_start(f"Syncing {video_type} video", can_skip=True)

                    # NOTE: Skip checking happens during FFmpeg encoding via skip_check_callback
                    # Don't check immediately - give user time to see the button and click it

                    if use_advanced_sync:
                        # Advanced sync using cross-correlation
                        emit_progress(35, f'Syncing {video_type} video with master...')
                        print(f"\n{'='*60}", file=sys.stderr)
                        print(f"Processing {video_type}: {Path(video_sources[video_type]).name}", file=sys.stderr)

                        try:
                            synced_path, sync_info = sync_processor.sync_file(
                                master_path=master_video,
                                source_path=video_sources[video_type],
                                search_window=30
                            )
                        except InterruptedError:
                            skip_was_requested = True
                            raise  # Re-raise to be caught by outer handler

                        # Check if skip was requested during processing (even if FFmpeg completed)
                        if check_for_skip_signal():
                            skip_was_requested = True
                            raise InterruptedError("Skip requested after processing completed")

                        processed_video_sources[video_type] = synced_path

                        print(f"✓ {video_type} video synced successfully:", file=sys.stderr)
                        print(f"  Offset: {sync_info['offset_seconds']:.3f}s", file=sys.stderr)
                        print(f"  Speed correction: {sync_info['speed_factor']:.6f}", file=sys.stderr)
                        print(f"  Drift: {sync_info['drift_frames']:.1f} frames", file=sys.stderr)
                        print(f"{'='*60}\n", file=sys.stderr)

                    else:
                        # Basic framerate sync (30fps -> 29.97fps)
                        print(f"Processing {video_type} video for framerate sync...", file=sys.stderr)
                        try:
                            synced_path = audio_processor.process_video_source(
                                original_path,
                                apply_sync=True
                            )
                        except InterruptedError:
                            skip_was_requested = True
                            raise  # Re-raise to be caught by outer handler

                        # Check if skip was requested during processing (even if FFmpeg completed)
                        if check_for_skip_signal():
                            skip_was_requested = True
                            raise InterruptedError("Skip requested after processing completed")

                        processed_video_sources[video_type] = synced_path
                        print(f"Synced {video_type} video: {synced_path}", file=sys.stderr)

                except InterruptedError as e:
                    # Skip was requested - delete the synced file if it was created
                    print("=" * 80, file=sys.stderr)
                    print(f"⏩ SKIP CONFIRMED - {video_type} video will use master quadrant", file=sys.stderr)
                    print("=" * 80, file=sys.stderr)

                    # Delete the synced file if it exists
                    if synced_path and synced_path != original_path:
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

                    # Don't add to processed_video_sources - will use master quadrant
                    continue
                except Exception as e:
                    print(f"Warning: Failed to sync {video_type} video: {e}", file=sys.stderr)
                    import traceback
                    traceback.print_exc(file=sys.stderr)
                    print(f"Using original video without sync", file=sys.stderr)
                    processed_video_sources[video_type] = video_sources[video_type]

        # Copy cam1 and cam2 without processing (they're from master video, already aligned)
        for cam_type in ['cam1', 'cam2']:
            if cam_type in video_sources and video_sources[cam_type]:
                processed_video_sources[cam_type] = video_sources[cam_type]

        # Use processed video sources for the rest of the workflow
        video_sources = processed_video_sources if processed_video_sources else video_sources

        # Step 4: Generate compound clips
        generated_clips = []
        progress_per_clip = 50 / 6
        current_progress = 40

        # Build CAM audio sources (mic1-4, sound_effects)
        cam_audio_sources = {}
        for audio_type in ['mic1', 'mic2', 'mic3', 'mic4', 'soundEffects']:
            # Map soundEffects to sound_effects for core modules
            core_audio_type = 'sound_effects' if audio_type == 'soundEffects' else audio_type
            if core_audio_type in processed_audio:
                cam_audio_sources[core_audio_type] = processed_audio[core_audio_type]['path']

        # Store paths for master project generation
        cam_solo_path = None
        cam_dual_path = None
        gs_solo_path = None
        gs_dual_path = None
        ssb_solo_path = None
        ssb_dual_path = None

        # Generate CAM Solo
        if should_generate('camSolo', xml_options) or should_generate('masterSolo', xml_options):
            emit_progress(current_progress, 'Generating CAM Solo compound clip...')
            if cam_audio_sources:
                try:
                    cam_generator = CamGenerator(config)
                    cam_solo_path = cam_generator.generate_cam_compound(
                        compound_xml, cam_audio_sources, 'solo', None, False, video_sources
                    )
                    all_xml_files.append(cam_solo_path)
                    if should_generate('camSolo', xml_options):
                        generated_clips.append({
                            'type': 'cam_solo',
                            'name': 'CAM - Solo Camera',
                            'path': cam_solo_path
                        })
                except Exception as e:
                    print(f"Error generating CAM Solo: {e}", file=sys.stderr)
        current_progress += progress_per_clip

        # Generate CAM Dual
        if should_generate('camDual', xml_options) or should_generate('masterDc', xml_options):
            emit_progress(current_progress, 'Generating CAM Dual Camera compound clip...')
            if cam_audio_sources:
                try:
                    dc_cam_generator = DCCamGenerator(config)
                    cam_dual_path = dc_cam_generator.generate_dc_cam_compound(
                        compound_xml, cam_audio_sources, None, False, video_sources
                    )
                    all_xml_files.append(cam_dual_path)
                    if should_generate('camDual', xml_options):
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
        for audio_type in ['mic1', 'mic2', 'mic3', 'mic4', 'screen', 'game', 'soundEffects', 'bluetooth']:
            core_audio_type = 'sound_effects' if audio_type == 'soundEffects' else audio_type
            if core_audio_type in processed_audio:
                gs_audio_sources[core_audio_type] = processed_audio[core_audio_type]['path']

        # Generate GS Solo
        if should_generate('gsSolo', xml_options) or should_generate('masterSolo', xml_options):
            emit_progress(current_progress, 'Generating GS Solo compound clip...')
            if gs_audio_sources:
                try:
                    gs_generator = GSGenerator(config)
                    gs_solo_path = gs_generator.generate_gs_compound(
                        compound_xml, gs_audio_sources, None, False, video_sources
                    )
                    all_xml_files.append(gs_solo_path)
                    if should_generate('gsSolo', xml_options):
                        generated_clips.append({
                            'type': 'gs_solo',
                            'name': 'GS - Solo Game Share',
                            'path': gs_solo_path
                        })
                except Exception as e:
                    print(f"Error generating GS Solo: {e}", file=sys.stderr)
        current_progress += progress_per_clip

        # Generate GS Dual
        if should_generate('gsDual', xml_options) or should_generate('masterDc', xml_options):
            emit_progress(current_progress, 'Generating GS Dual Camera compound clip...')
            if gs_audio_sources:
                try:
                    dc_gs_generator = DCGSGenerator(config)
                    gs_dual_path = dc_gs_generator.generate_dc_gs_compound(
                        compound_xml, gs_audio_sources, None, False, video_sources
                    )
                    all_xml_files.append(gs_dual_path)
                    if should_generate('gsDual', xml_options):
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
        if should_generate('ssbSolo', xml_options) or should_generate('masterSolo', xml_options):
            emit_progress(current_progress, 'Generating SSB Solo compound clip...')
            if ssb_audio_sources:
                try:
                    ssb_generator = SSBGenerator(config)
                    ssb_solo_path = ssb_generator.generate_ssb_compound(
                        compound_xml, ssb_audio_sources, 'solo', None, False, video_sources
                    )
                    all_xml_files.append(ssb_solo_path)
                    if should_generate('ssbSolo', xml_options):
                        generated_clips.append({
                            'type': 'ssb_solo',
                            'name': 'SSB - Solo Screen Share Beside',
                            'path': ssb_solo_path
                        })
                except Exception as e:
                    print(f"Error generating SSB Solo: {e}", file=sys.stderr)
        current_progress += progress_per_clip

        # Generate SSB Dual
        if should_generate('ssbDual', xml_options) or should_generate('masterDc', xml_options):
            emit_progress(current_progress, 'Generating SSB Dual Camera compound clip...')
            if ssb_audio_sources:
                try:
                    dc_ssb_generator = DCSSBGenerator(config)
                    ssb_dual_path = dc_ssb_generator.generate_dc_ssb_compound(
                        compound_xml, ssb_audio_sources, None, False, video_sources
                    )
                    all_xml_files.append(ssb_dual_path)
                    if should_generate('ssbDual', xml_options):
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
        if cam_dual_path and gs_dual_path and ssb_dual_path:
            try:
                emit_progress(88, 'Generating adaptive hybrid compounds...')
                print(f"\nGenerating hybrid compounds from DC compounds", file=sys.stderr)
                hybrid_gen = HybridCompoundGenerator(config)
                # Use the same output directory as the DC compounds
                output_dir = str(Path(cam_dual_path).parent)
                hybrid_cam_path, hybrid_gs_path, hybrid_ssb_path = hybrid_gen.generate_hybrid_compounds(
                    cam_dual_path,
                    gs_dual_path,
                    ssb_dual_path,
                    str(master_video),  # Original master video for detection
                    output_dir
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

        # Generate master projects if requested
        if should_generate('masterSolo', xml_options):
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

        if should_generate('masterDc', xml_options):
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

        # Create ZIP file
        emit_progress(95, 'Creating compound clips ZIP file...')
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
