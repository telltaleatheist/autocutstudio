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
import zipfile

def emit_progress(progress, message):
    """Emit progress update as JSON to stdout."""
    print(json.dumps({
        'type': 'progress',
        'progress': progress,
        'message': message
    }), flush=True)

def emit_error(error_message):
    """Emit error as JSON to stdout."""
    print(json.dumps({
        'type': 'error',
        'error': error_message
    }), flush=True)

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
        input_data = sys.stdin.read()
        data = json.loads(input_data)

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

        # Step 3: Process audio files
        audio_processor = AudioProcessor(config)
        processed_audio = {}

        for audio_type, audio_path in audio_sources_input.items():
            if audio_path:
                try:
                    apply_sync = audio_sync_settings.get(audio_type, False)
                    processed_path, duration, sample_rate, channels = \
                        audio_processor.process_audio_source(audio_path, apply_sync)
                    processed_audio[audio_type] = {
                        'path': processed_path,
                        'duration': duration,
                        'sample_rate': sample_rate,
                        'channels': channels
                    }
                    sync_status = "with sync" if apply_sync else "without sync"
                    print(f"Processed {audio_type} audio ({sync_status})", file=sys.stderr)
                except Exception as e:
                    print(f"Warning: Failed to process {audio_type} audio: {e}", file=sys.stderr)

        # Step 3.5: Process video sources (sync 30fps to 29.97fps)
        emit_progress(35, 'Processing custom video sources...')
        processed_video_sources = {}

        # Process screen and game captures if provided
        for video_type in ['screen', 'game']:
            if video_type in video_sources and video_sources[video_type]:
                try:
                    print(f"Processing {video_type} video for framerate sync...", file=sys.stderr)
                    synced_path = audio_processor.process_video_source(
                        video_sources[video_type],
                        apply_sync=True  # Always sync custom screen/game captures
                    )
                    processed_video_sources[video_type] = synced_path
                    print(f"Synced {video_type} video: {synced_path}", file=sys.stderr)
                except Exception as e:
                    print(f"Warning: Failed to sync {video_type} video: {e}", file=sys.stderr)
                    print(f"Using original video without sync", file=sys.stderr)
                    processed_video_sources[video_type] = video_sources[video_type]

        # Copy cam1 and cam2 without processing (they're from master video)
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
