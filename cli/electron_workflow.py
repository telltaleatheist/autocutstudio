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
from core.naming import is_soundboard_filename
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

# Parent (Electron) PID captured at startup. Used while blocking on stdin for the
# Dugan automixer response so we can detect a dead parent instead of hanging forever.
_PARENT_PID = os.getppid()

def skip_signal_handler(signum, frame):
    """Handle skip signal (SIGUSR1)."""
    global _skip_requested
    print("\n⏩ Skip signal received via SIGUSR1", file=sys.stderr)
    _skip_requested = True

# Register signal handlers for cancel/interrupt
signal.signal(signal.SIGTERM, signal_handler)  # Kill/cancel
signal.signal(signal.SIGINT, signal_handler)   # Ctrl+C
if hasattr(signal, 'SIGUSR1'):
    signal.signal(signal.SIGUSR1, skip_signal_handler)  # Skip signal
else:
    # Windows has no SIGUSR1 - registering it crashes at import with AttributeError
    print("⚠ Skip signals unavailable on this platform (no SIGUSR1)", file=sys.stderr)

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

def _resolve_media_tool(name, audio_processor):
    """Resolve ffmpeg/ffprobe the same way the rest of the pipeline does.

    The Electron app puts its managed/bundled ffmpeg/ffprobe on PATH (see
    binary-resolver.getPythonEnv), and AudioProcessor already resolved ffprobe.
    Prefer those, then shutil.which, then common install dirs. Returns the bare
    name as a last resort (PATH lookup by the child)."""
    import shutil
    if name == 'ffprobe' and getattr(audio_processor, 'ffprobe_path', None):
        return audio_processor.ffprobe_path
    found = shutil.which(name)
    if found:
        return found
    for d in ('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'):
        p = Path(d) / name
        if p.exists():
            return str(p)
    return name


def denoise_mic_audio(audio_type, audio_path, voice_sep_env, audio_processor):
    """Isolate the speaker's voice on a mic track via core/voice_separation.py,
    returning the path to the cleaned track.

    FAIL LOUD: a missing env / interpreter / model / orchestrator, or any
    non-zero exit from voice_separation.py, aborts the whole run. We never fall
    back to the noisy original, because that would silently ship un-isolated
    audio the user explicitly asked to clean."""
    if not voice_sep_env:
        emit_error(f"Voice isolation requested for {audio_type} but the app provided "
                   "no voice-separator env path (voiceSeparatorEnv missing)")
        raise RuntimeError("voiceSeparatorEnv missing")

    env_dir = Path(voice_sep_env)
    # conda envs put the interpreter at python.exe on Windows, bin/python3 on unix.
    sep_python = env_dir / ('python.exe' if sys.platform == 'win32' else 'bin/python3')
    model_dir = env_dir / 'audio-separator-models'
    model = model_dir / 'vocals_mel_band_roformer.ckpt'
    orchestrator = BASE_DIR / 'core' / 'voice_separation.py'

    for label, p in (('voice-separator env', env_dir),
                     ('separator python', sep_python),
                     ('separator model', model),
                     ('voice_separation.py orchestrator', orchestrator)):
        if not p.exists():
            emit_error(f"Voice isolation for {audio_type} failed: {label} not found at {p}")
            raise FileNotFoundError(f"{label} not found: {p}")

    ffmpeg = _resolve_media_tool('ffmpeg', audio_processor)
    ffprobe = _resolve_media_tool('ffprobe', audio_processor)

    src = Path(audio_path)
    cleaned = src.parent / f"{src.stem}_voiceiso.wav"

    print(f"\n{'='*60}", file=sys.stderr)
    print(f"Voice isolation: {audio_type} ({src.name}) -> {cleaned.name}", file=sys.stderr)
    print(f"{'='*60}", file=sys.stderr)
    mic_label = audio_type.replace('mic', 'mic ')  # 'mic1' -> 'mic 1'
    # Register a named operation so the UI shows the dedicated operation row with
    # its own (sub-)progress bar for this long step (not skippable mid-run).
    emit_operation_start(f"Isolating voice on {mic_label}", can_skip=False)
    emit_progress(30, f"Isolating voice on {mic_label} — analyzing audio...", sub_progress=0)

    cmd = [str(sep_python), str(orchestrator),
           '--input', str(src), '--output', str(cleaned),
           '--sep-python', str(sep_python),
           '--model-dir', str(model_dir),
           '--ffmpeg', str(ffmpeg), '--ffprobe', str(ffprobe)]

    # Voice isolation is slow (~1 min per 6-min section), so give it a real,
    # advancing sub-progress bar with descriptive text instead of a frozen "30%".
    # We parse the orchestrator's PLAN / CHUNK lines and translate them into
    # emit_progress(sub_progress=...); every line is still mirrored to our stderr
    # for the detailed workflow log.
    import re
    total_sections = None
    total_min = None
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, text=True, bufsize=1)
    for raw in proc.stderr:
        line = raw.rstrip()
        if not line:
            continue
        print(line, file=sys.stderr)
        if line.startswith('PLAN'):
            mtot = re.search(r'->\s*(\d+)\s*chunks', line)
            mmin = re.search(r'([\d.]+)\s*min input', line)
            total_sections = int(mtot.group(1)) if mtot else None
            total_min = float(mmin.group(1)) if mmin else None
            if total_sections:
                emit_progress(30, f"Isolating voice on {mic_label} — 0 of {total_sections} "
                              f"sections ({total_min:.0f} min of audio)", sub_progress=0)
            continue
        mchunk = re.match(r'CHUNK\s+(\d+)/(\d+)\s+\(([\d.]+)-([\d.]+)\s*min\)(.*)', line)
        if mchunk:
            done, n = int(mchunk.group(1)), int(mchunk.group(2))
            upto_min = float(mchunk.group(4))
            silent = 'SILENT' in mchunk.group(5)
            pct = round(done / n * 100.0, 1)
            where = (f"{upto_min:.0f} of {total_min:.0f} min" if total_min
                     else f"{upto_min:.0f} min")
            note = " (silence — skipped)" if silent else ""
            emit_progress(30, f"Isolating voice on {mic_label} — section {done} of {n}, "
                          f"{where} done{note}", sub_progress=pct)
    proc.wait()
    if proc.returncode != 0 or not cleaned.exists():
        emit_error(f"Voice isolation failed for {audio_type} "
                   f"(voice_separation.py exit {proc.returncode}) — see log above")
        raise RuntimeError(
            f"voice_separation.py failed for {audio_type} (exit {proc.returncode})")

    emit_progress(30, f"Voice isolation complete on {mic_label}", sub_progress=100)
    print(f"✓ Voice isolation complete for {audio_type}: {cleaned.name}", file=sys.stderr)
    return str(cleaned)


def _parse_overrides(raw, kind):
    """Validate and normalize an alignment-override sub-map ('audio' or 'video').

    `raw` is the corresponding sub-object of alignmentOverrides (or None). Returns
    ``{ source_id: {'offsetSeconds': float, 'driftFactor': float | None} }``.

    driftFactor ABSENT (None) and driftFactor EXPLICITLY 1.0 mean different things and
    must stay distinguishable: absent = "no drift opinion, keep the auto drift path";
    explicit 1.0 = "user VERIFIED there is no drift — identity, bypass auto drift".
    Collapsing them would let the auto device-drift stretch silently un-align a track
    the user just confirmed at both ends.

    FAIL LOUD on any malformed entry — a bad override must never be silently ignored
    (project doctrine: unparseable override => fail naming what's wrong).
    """
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError(
            f"alignmentOverrides.{kind} must be an object, got {type(raw).__name__}")
    parsed = {}
    for src, spec in raw.items():
        if not isinstance(spec, dict):
            raise ValueError(
                f"alignmentOverrides.{kind}.{src} must be an object with 'offsetSeconds'")
        if 'offsetSeconds' not in spec:
            raise ValueError(
                f"alignmentOverrides.{kind}.{src} is missing required 'offsetSeconds'")
        try:
            offset = float(spec['offsetSeconds'])
        except (TypeError, ValueError):
            raise ValueError(
                f"alignmentOverrides.{kind}.{src}.offsetSeconds is not a number: "
                f"{spec['offsetSeconds']!r}")
        drift = None
        if 'driftFactor' in spec:
            try:
                drift = float(spec['driftFactor'])
            except (TypeError, ValueError):
                raise ValueError(
                    f"alignmentOverrides.{kind}.{src}.driftFactor is not a number: "
                    f"{spec['driftFactor']!r}")
        parsed[src] = {'offsetSeconds': offset, 'driftFactor': drift}
    return parsed


def _run_measure_only(master_video, audio_sources_input, video_sources):
    """MEASURE-ONLY MODE: locate the same sources a normal run would, measure each
    source's signed offset against the master via GCC-PHAT, emit a single
    machine-readable JSON result to stdout, and return WITHOUT generating anything.

    The manual-alignment UI uses this to pre-seed its per-source offsets. The emitted
    payload is:

        {'type': 'measure_result',
         'sources': {'audio': { <normalized_type>: {offsetSeconds, confidence, trusted}, ... },
                     'video': { <screen|game|cam1|cam2>: {offsetSeconds, confidence, trusted}, ... }}}

    FAIL LOUD if the sync stack is unavailable or a source is missing — never emit a
    fabricated / zero result.
    """
    if not AUDIO_SYNC_AVAILABLE:
        emit_error("Measure-only requested but the advanced sync stack (numpy/scipy) "
                   "is unavailable")
        raise RuntimeError("measure-only requires the advanced sync dependencies")
    if not master_video or not Path(master_video).exists():
        emit_error(f"Measure-only: master video not found: {master_video}")
        raise FileNotFoundError(f"master video not found: {master_video}")

    from core.gcc_phat_align import measure_offset, CONFIDENCE_THRESHOLD, FRAME_SECONDS

    def _measure(path):
        # Trust gating mirrors core/audio_sync.py analyze_sync exactly.
        result = measure_offset(path, master_video)
        tau = result['tau_seconds']
        conf = result['confidence']
        spread = result['spread_seconds']
        windows_ok = [w for w in result['per_window']
                      if w['confidence'] >= CONFIDENCE_THRESHOLD]
        trusted = (conf >= CONFIDENCE_THRESHOLD
                   or (len(windows_ok) >= 2 and spread <= FRAME_SECONDS))
        return {'offsetSeconds': tau, 'confidence': conf, 'trusted': bool(trusted)}

    print("\n▶ Measure-only mode: measuring per-source alignment offsets", file=sys.stderr)

    audio_results = {}
    for audio_type, audio_path in audio_sources_input.items():
        if not audio_path:
            continue
        # First source of a given normalized type wins — mirrors the sync loop's keying.
        normalized_type = audio_type.replace('Sb', '')
        if normalized_type in audio_results:
            continue
        if not Path(audio_path).exists():
            emit_error(f"Measure-only: audio source {audio_type} not found: {audio_path}")
            raise FileNotFoundError(f"audio source {audio_type} not found: {audio_path}")
        print(f"  measuring audio {normalized_type} ({Path(audio_path).name})", file=sys.stderr)
        audio_results[normalized_type] = _measure(audio_path)

    video_results = {}
    for v_type in ['screen', 'game', 'cam1', 'cam2']:
        v_path = (video_sources or {}).get(v_type)
        if not v_path:
            continue
        if not Path(v_path).exists():
            emit_error(f"Measure-only: video source {v_type} not found: {v_path}")
            raise FileNotFoundError(f"video source {v_type} not found: {v_path}")
        print(f"  measuring video {v_type} ({Path(v_path).name})", file=sys.stderr)
        video_results[v_type] = _measure(v_path)

    print(json.dumps({
        'type': 'measure_result',
        'sources': {'audio': audio_results, 'video': video_results},
    }), flush=True)


def main():
    """Main workflow execution."""
    try:
        # DEBUG: Print to verify this version is running
        print("\n🔥 Hybrid Mode v2.0 - Active", file=sys.stderr)

        # Read input from stdin (passed as JSON from Electron)
        # Only read first line so stdin remains open for skip signals
        input_line = sys.stdin.readline()
        data = json.loads(input_line.strip())

        # Load configuration from the user config directory.
        # Electron sets AUTOCUT_CONFIG_DIR to the exact directory the Settings UI
        # writes to; honour it so the CLI and the app never disagree on where
        # config lives. Otherwise fall back to the platform's app-data dir that
        # matches Electron's userData location.
        config_dir_env = os.environ.get('AUTOCUT_CONFIG_DIR')
        if config_dir_env:
            config_path = Path(config_dir_env) / 'autostudio_config.yaml'
        elif sys.platform == 'darwin':
            config_path = (Path.home() / 'Library' / 'Application Support' /
                           'AutoCutStudio' / 'config' / 'autostudio_config.yaml')
        elif sys.platform == 'win32':
            appdata = os.environ.get('APPDATA') or str(Path.home())
            config_path = (Path(appdata) / 'AutoCutStudio' / 'config' /
                           'autostudio_config.yaml')
        else:
            xdg = os.environ.get('XDG_CONFIG_HOME') or str(Path.home() / '.config')
            config_path = (Path(xdg) / 'AutoCutStudio' / 'config' /
                           'autostudio_config.yaml')

        if not config_path.exists():
            raise FileNotFoundError(
                f"No configuration found at {config_path}. "
                "Go to Settings > Relink Assets to set up your asset paths."
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
        # Voice isolation (audio-separator): remove background from mic1/mic2 BEFORE
        # alignment. denoise_mics comes from the workflow checkbox; voice_sep_env is
        # the absolute path to the managed separator env (or None when not installed),
        # injected by the Electron IPC handler.
        denoise_mics = data.get('denoiseMics', False)
        voice_sep_env = data.get('voiceSeparatorEnv')

        # Manual alignment overrides (Phase 1). Optional per-source structure that, when
        # present for a source, SKIPS GCC-PHAT measurement and uses offsetSeconds verbatim
        # (negative/leftward allowed — the auto-only "unusual leftward" guard is bypassed).
        # Split into 'audio' / 'video' sub-maps mirroring the existing audioSources /
        # videoSources payload split, because the raw 'screen' key is otherwise ambiguous
        # (it names both a desktop-audio source and a screen-recording video). Keys are the
        # exact identifiers the sync/measurement decisions already use: audio keys are the
        # normalized audio types (mic1/mic2/screen/game/soundEffects/bluetooth), video keys
        # are screen/game/cam1/cam2. Absent => zero behavior change.
        alignment_overrides = data.get('alignmentOverrides') or {}
        audio_overrides = _parse_overrides(alignment_overrides.get('audio'), 'audio')
        video_overrides = _parse_overrides(alignment_overrides.get('video'), 'video')

        # MEASURE-ONLY MODE: measure each source's offset and emit one JSON result, then
        # exit without generating anything (used to pre-seed the manual-alignment UI).
        if bool(data.get('measureOnly', False)):
            _run_measure_only(master_video, audio_sources_input, video_sources)
            return

        # Validate audio overrides name sources actually present in this session (fail
        # loud, never a warning). Presence is checked against the normalized source types
        # (mic1Sb -> mic1) exactly as the sync loop keys them. Video overrides are
        # validated later, once the final (post-skip) video sources are known.
        if audio_overrides:
            present_audio_types = {
                atype.replace('Sb', '')
                for atype, apath in audio_sources_input.items()
                if apath and Path(apath).exists()
            }
            for src in audio_overrides:
                if src not in present_audio_types:
                    raise ValueError(
                        f"alignmentOverrides.audio names '{src}' but no such audio source is "
                        f"present in this session (present: {sorted(present_audio_types)})")

        # Stage tracking: ffmpeg tick callbacks report sub-progress against
        # whatever main-flow stage is currently active. set_stage records the
        # active stage AND emits it; ffmpeg_progress_callback reads it back.
        _current_stage = {'progress': 0, 'message': ''}

        def set_stage(progress, message):
            _current_stage.update({'progress': progress, 'message': message})
            emit_progress(progress, message)

        # Step 0.5: Analyze skip capabilities and emit to frontend
        set_stage(3, 'Analyzing which operations can be skipped...')
        skip_engine = SkipDecisionEngine(master_video, audio_sources_input, video_sources)
        skip_decisions = skip_engine.get_all_skip_decisions()
        emit_skip_capabilities(skip_decisions)

        # Print skip summary to stderr for debugging
        print(skip_engine.generate_skip_summary(), file=sys.stderr)

        set_stage(5, 'Detecting framerate...')
        detected_framerate = detect_framerate(master_video)

        # Create progress callback for FFmpeg operations (emits sub-progress)
        # This needs to be defined early since auto-editor may use it
        def ffmpeg_progress_callback(progress_info: dict):
            """Callback for FFmpeg progress updates.

            Args:
                progress_info: Dict with keys: frame, fps, time, speed, progress_percent

            Emits the *current* workflow stage (tracked in _current_stage via
            set_stage) with the ffmpeg completion percentage as sub_progress, so
            per-tick ffmpeg updates no longer clobber whichever stage is actually
            running with a hardcoded "Processing custom video sources..." message.
            """
            if 'progress_percent' in progress_info:
                percent = progress_info['progress_percent']
                emit_progress(_current_stage['progress'],
                              _current_stage['message'],
                              sub_progress=percent)

        set_stage(10, 'Running auto-editor to identify cuts...')

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
                set_stage(15, 'Analyzing screen audio for smart cuts...')
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
                # Continuing with unfiltered cuts would cut away exactly the
                # video-watching segments this filter exists to protect. Fail loud.
                emit_error(f"Smart cut filter failed: {e}")
                import traceback
                traceback.print_exc(file=sys.stderr)
                raise

        all_xml_files = [altered_xml]

        set_stage(20, 'Converting to compound clip structure...')

        # Step 2: Convert to compound clip
        compound_xml = editor.convert_to_compound(altered_xml, str(master_video))
        if not compound_xml:
            raise Exception("Failed to create compound clip")

        all_xml_files.append(compound_xml)

        set_stage(30, 'Processing audio sources...')

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
                                is_soundboard_filename(audio_path))

                if is_soundboard:
                    soundboard_files[audio_type] = audio_path
                else:
                    vmix_files[audio_type] = audio_path

        # If we have soundboard files and advanced sync, sync them all at once
        if soundboard_files and use_advanced_sync:
            sync_errors = {}  # per-track sync failures, checked below and in except
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
                set_stage(30, 'Syncing soundboard files (unified detection)...')
                sb_results = sync_soundboard_files(normalized_sb_files, vmix_files)

                # A soundboard track that failed to sync must not silently vanish
                # from the timeline. If any result carries an 'error', surface all
                # of them and abort the whole run.
                sync_errors = {
                    name: info['error']
                    for name, info in sb_results.items()
                    if isinstance(info, dict) and 'error' in info
                }
                if sync_errors:
                    detail = "; ".join(f"{name}: {err}" for name, err in sync_errors.items())
                    emit_error(f"Soundboard sync failed for: {detail}")
                    raise RuntimeError(f"Soundboard sync failed for: {detail}")

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

                # soundboard_sync_params stays None if sb_results was empty or the
                # first entry lacked offset_seconds; guard the summary to avoid a
                # None deref that would fall through into the except.
                if soundboard_sync_params:
                    print(f"\n✓ Soundboard unified sync complete!", file=sys.stderr)
                    print(f"  Offset: {soundboard_sync_params['offset']:.3f}s", file=sys.stderr)
                    print(f"  Speed: {soundboard_sync_params['speed']:.6f}", file=sys.stderr)
                    print(f"  Drift: {soundboard_sync_params['drift']:.1f} frames\n", file=sys.stderr)

            except Exception as e:
                # The unified path applies different corrections than per-file sync;
                # silently falling back masks the failure and produces a subtly wrong
                # timeline. Fail loud. (If a per-track error was already surfaced
                # above, don't double-report it.)
                if not sync_errors:
                    emit_error(f"Soundboard unified sync failed: {e}")
                import traceback
                traceback.print_exc(file=sys.stderr)
                raise

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
                        # A manual override cannot be honored here: this type was already
                        # synced by the unified soundboard path (a different code path that
                        # measures all SB tracks together). Fail loud rather than silently
                        # ignore the user's offset.
                        if normalized_type in audio_overrides:
                            emit_error(
                                f"alignment override given for {normalized_type}, but it was "
                                f"synced via the unified soundboard path — manual override is "
                                f"not supported for soundboard sources in Phase 1")
                            raise RuntimeError(
                                f"alignment override unsupported for soundboard source {normalized_type}")
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

                # Voice isolation (BEFORE the output-file short-circuit and BEFORE
                # sync): isolate the speaker's voice on mic1/mic2 so GCC-PHAT aligns
                # the cleaned track. Only real mic tracks — never soundboard
                # (mic1Sb/mic2Sb) or non-mic types. Rebinding audio_path makes ALL
                # downstream steps (sync, get_audio_info, compound) use the cleaned
                # track. FAIL LOUD on any problem (denoise_mic_audio raises).
                if (denoise_mics
                        and normalized_type in ('mic1', 'mic2')
                        and not audio_type.endswith('Sb')):
                    audio_path = denoise_mic_audio(
                        audio_type, audio_path, voice_sep_env, audio_processor
                    )

                synced_path = None  # Track synced file for cleanup if needed
                skip_was_requested = False  # Track if skip happened during this operation

                # Check if this is an output file (not soundboard, not capture)
                # Output files are already synced with master and should be used as-is
                filename = Path(audio_path).name.lower()
                type_is_soundboard = audio_type.endswith('Sb')
                # Raw companion tracks (mic 1-4, desktop/screen audio, game audio,
                # sound effects, bluetooth) are NOT pre-synced — they drift a few
                # frames from the master and MUST go through cross-correlation sync.
                # The old heuristic ("no 'capture' in the name => already synced")
                # wrongly treated `mic audio.wav` / `screen audio.wav` as output
                # files and applied ZERO correction, which is exactly the misalign
                # the user was fixing by hand. GCC-PHAT safely handles a genuinely
                # pre-synced file too (it measures ~0 and shifts nothing).
                RAW_SOURCE_TYPES = {'mic1', 'mic2', 'mic3', 'mic4',
                                    'screen', 'game', 'soundEffects', 'bluetooth'}
                is_raw_source = normalized_type in RAW_SOURCE_TYPES
                is_output_file = (not type_is_soundboard
                                  and not is_soundboard_filename(filename)
                                  and 'capture' not in filename
                                  and not is_raw_source)

                if is_output_file:
                    # An override cannot apply here: output files are used verbatim with
                    # NO sync step to inject an offset into. Fail loud rather than ignore it.
                    if normalized_type in audio_overrides:
                        emit_error(
                            f"alignment override given for {normalized_type}, but it is treated "
                            f"as a pre-synced output file (no sync applied) — override not "
                            f"supported on this path")
                        raise RuntimeError(
                            f"alignment override unsupported for output-file source {normalized_type}")
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
                        # get_audio_info now raises only on real problems; silently
                        # dropping the track would remove a required output file.
                        emit_error(f"Failed to read audio info for {audio_type} ({audio_path}): {e}")
                        import traceback
                        traceback.print_exc(file=sys.stderr)
                        raise
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
                        set_stage(30, f'Syncing {audio_type} audio with master...')
                        print(f"\n{'='*60}", file=sys.stderr)
                        print(f"Processing {audio_type}: {Path(audio_path).name}", file=sys.stderr)

                        # Manual alignment override: skip GCC-PHAT and use offsetSeconds
                        # verbatim. Audio drift correction is not yet implemented, so a
                        # non-1.0 driftFactor must abort loudly (never silently ignored).
                        # An EXPLICIT 1.0 is fine: it means "verified no drift", and the
                        # override path already applies no stretch (speed_factor=1.0).
                        override = audio_overrides.get(normalized_type)
                        offset_override = None
                        if override is not None:
                            if override['driftFactor'] is not None and override['driftFactor'] != 1.0:
                                msg = (f"audio drift correction not yet implemented — got "
                                       f"driftFactor {override['driftFactor']} for {normalized_type}")
                                emit_error(msg)
                                raise RuntimeError(msg)
                            offset_override = override['offsetSeconds']
                            print(f"  ↳ Using manual alignment override: "
                                  f"offset={offset_override:.3f}s (GCC-PHAT skipped)", file=sys.stderr)

                        try:
                            synced_path, sync_info = sync_processor.sync_file(
                                master_path=master_video,
                                source_path=audio_path,
                                search_window=30,
                                offset_override=offset_override
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
                        # Basic (framerate-only) processing has no offset-injection step,
                        # so a manual offset override cannot be honored here. Fail loud.
                        if normalized_type in audio_overrides:
                            msg = (f"alignment override given for {normalized_type}, but the "
                                   f"advanced sync stack is unavailable — basic framerate sync "
                                   f"cannot apply a manual offset")
                            emit_error(msg)
                            raise RuntimeError(msg)
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
                    # "Using the original file without sync" silently substitutes an
                    # unsynced track that will drift against the timeline. Fail loud.
                    emit_error(f"Failed to sync {audio_type} audio: {e}")
                    import traceback
                    traceback.print_exc(file=sys.stderr)
                    raise

        # Step 3.5: Process video sources with optional advanced sync
        set_stage(35, 'Processing custom video sources...')
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

                    # Detect framerate for logging ONLY. get_video_framerate now raises
                    # on probe failure; isolate it so a failed *log* probe cannot
                    # discard the video source we just assigned above.
                    try:
                        video_fps = audio_processor.get_video_framerate(original_path)
                        print(f"✓ {video_type} video prepared (no re-encoding):", file=sys.stderr)
                        print(f"  Source framerate: {video_fps:.2f}fps", file=sys.stderr)
                        print(f"  Duration matches master - FCPX will handle playback", file=sys.stderr)
                    except Exception as probe_err:
                        print(f"⚠️  Could not probe {video_type} framerate (logging only): {probe_err}", file=sys.stderr)

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

        # Use processed video sources for the rest of the workflow.
        # NOTE: assign directly — the old `... if processed_video_sources else video_sources`
        # fallback silently un-skipped videos the user chose to skip (an empty dict
        # meant "use master quadrant for everything", not "fall back to originals").
        video_sources = processed_video_sources

        # DEBUG: Show final video sources being used
        print(f"\n✓ Final video sources for compound generation:", file=sys.stderr)
        for vtype, vpath in video_sources.items():
            if vpath:
                print(f"  {vtype}: {Path(vpath).name}", file=sys.stderr)

        # Step 3.6: Measure per-source VIDEO alignment offsets.
        # Companion video sources (screen, game, cam1, cam2) are separate files whose
        # start time drifts a few frames from the master. We measure each dedicated
        # source's EMBEDDED AUDIO against the master mix via GCC-PHAT and record a
        # POSITIVE tau (seconds) that DELAYS the clip rightward on the timeline to align
        # it. The generators ADD tau to the clip's timeline offset (never to start), so a
        # missing / zero entry is an exact no-op (existing outputs unchanged).
        video_offsets = {}
        # Per-source manual retime factors (r) for video, threaded into the generators'
        # calculate_retime_map. Only EXPLICIT driftFactors land here (including an
        # explicit 1.0 = identity, which overrides the auto device-drift stretch); a
        # missing key leaves that source on its existing auto drift/retime path.
        video_drift_factors = {}

        # Apply manual VIDEO overrides first — independent of the sync stack, since they
        # skip measurement. Validate presence against the FINAL (post-skip) video sources,
        # use offsetSeconds verbatim (negative allowed, no leftward guard), and collect
        # EXPLICIT driftFactors: absent (None) = keep the auto drift path; explicit 1.0 =
        # user verified NO drift — identity retime, bypassing the auto device-drift
        # stretch (which would otherwise silently un-align a user-confirmed end point).
        # A non-1.0 driftFactor on cam1 is refused loudly: cam1 is recorded with the
        # master and is never retimed, so a stretch has nowhere to apply (explicit 1.0
        # on cam1 is allowed — "no drift" is already cam1's permanent state).
        for src, spec in video_overrides.items():
            if not video_sources.get(src):
                present = sorted(k for k, v in video_sources.items() if v)
                raise ValueError(
                    f"alignmentOverrides.video names '{src}' but no such video source is "
                    f"present in this session (present: {present})")
            video_offsets[src] = spec['offsetSeconds']
            print(f"  ✓ {src} video offset (manual override): "
                  f"{spec['offsetSeconds']:.3f}s — GCC-PHAT skipped", file=sys.stderr)
            if spec['driftFactor'] is not None:
                if src == 'cam1':
                    if spec['driftFactor'] != 1.0:
                        raise ValueError(
                            f"driftFactor {spec['driftFactor']} given for cam1, but cam1 is "
                            f"recorded with the master and is never retimed — cannot apply a "
                            f"drift stretch to it")
                    # explicit 1.0 on cam1: nothing to record, cam1 is never retimed anyway
                else:
                    video_drift_factors[src] = spec['driftFactor']

        if AUDIO_SYNC_AVAILABLE:
            measure_offset = None
            try:
                from core.gcc_phat_align import (
                    measure_offset, CONFIDENCE_THRESHOLD, FRAME_SECONDS
                )
            except Exception as imp_err:
                measure_offset = None
                print(f"⚠️  Video offset measurement unavailable (import failed): {imp_err}",
                      file=sys.stderr)
            if measure_offset is not None:
                print("\n▶ Measuring per-source video alignment offsets", file=sys.stderr)
                for v_type in ['screen', 'game', 'cam1', 'cam2']:
                    v_path = video_sources.get(v_type)
                    if not v_path:
                        continue
                    # A manual override already set this source's offset above — never
                    # measure over it.
                    if v_type in video_overrides:
                        continue
                    try:
                        # video's embedded audio vs master mix
                        result = measure_offset(v_path, master_video)
                        tau = result['tau_seconds']
                        conf = result['confidence']
                        spread = result['spread_seconds']
                        # Trust/gating mirrors core/audio_sync.py analyze_sync: trust when
                        # the worst-window confidence clears the gate OR at least two
                        # windows clear it AND all windows agree to within one frame.
                        windows_ok = [w for w in result['per_window']
                                      if w['confidence'] >= CONFIDENCE_THRESHOLD]
                        agree = spread <= FRAME_SECONDS
                        trusted = (conf >= CONFIDENCE_THRESHOLD
                                   or (len(windows_ok) >= 2 and agree))
                        if not trusted:
                            # Fail LOUD but keep the best-effort tau (do not silently drop).
                            print(
                                f"  ⚠️  LOW-CONFIDENCE video offset for {v_type} "
                                f"({Path(v_path).name}): tau={tau:.3f}s "
                                f"({tau / FRAME_SECONDS:+.1f} fr), min_conf={conf:.2f}, "
                                f"spread={spread * 1000:.0f}ms across "
                                f"{len(result['per_window'])} windows. Stored best-effort "
                                f"— VERIFY THIS VIDEO MANUALLY.",
                                file=sys.stderr
                            )
                        elif tau < -FRAME_SECONDS:
                            # Sources normally LAG the master; a leftward lead is unusual.
                            print(
                                f"  ⚠️  Unusual LEFTWARD video offset for {v_type} "
                                f"({Path(v_path).name}): tau={tau:.3f}s "
                                f"({tau / FRAME_SECONDS:+.1f} fr) — sources normally lag the "
                                f"master. Confidence {conf:.2f}; applied as measured.",
                                file=sys.stderr
                            )
                        video_offsets[v_type] = tau
                        print(
                            f"  ✓ {v_type} video offset: {tau:.3f}s "
                            f"({tau / FRAME_SECONDS:+.1f} fr, conf {conf:.2f})",
                            file=sys.stderr
                        )
                    except Exception as meas_err:
                        # A measurement failure must not abort the whole render, but it
                        # must be visible; treat this source as no shift (0.0).
                        print(
                            f"  ⚠️  Failed to measure video offset for {v_type} "
                            f"({Path(v_path).name}): {meas_err} — using 0.0 (no shift)",
                            file=sys.stderr
                        )
                        video_offsets[v_type] = 0.0
        else:
            print("⚠ Video offset measurement skipped (advanced sync deps unavailable)",
                  file=sys.stderr)

        # Step 3.5: Apply Dugan automixer if enabled (BEFORE generating any compounds)
        if auto_duck:
            set_stage(38, 'Applying Dugan automixer...')
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
                set_stage(38, f'Sending {len(dugan_tracks)} tracks to Dugan automixer...')
                print(json.dumps({
                    'type': 'ducking_request',
                    'tracks': dugan_tracks
                }), flush=True)

                # Wait for the ducking_complete response on stdin. On POSIX we poll
                # with select so a crashed Electron parent is noticed instead of
                # blocking forever; there is deliberately NO overall timeout because
                # legitimate ducking work can run long.
                print("Waiting for Dugan automixer response from Electron...", file=sys.stderr)
                if sys.platform == 'win32':
                    response_line = sys.stdin.readline()
                else:
                    response_line = None
                    while True:
                        ready, _, _ = select.select([sys.stdin], [], [], 5.0)
                        if ready:
                            response_line = sys.stdin.readline()
                            break
                        # Timed out with no data: is our parent still alive?
                        current_ppid = os.getppid()
                        if current_ppid == 1 or current_ppid != _PARENT_PID:
                            raise RuntimeError("Electron exited while waiting for Dugan automixer response")

                # EOF: stdin closed with no response. Continuing with unducked tracks
                # would silently ship the wrong mix, so fail loud.
                if not response_line:
                    raise RuntimeError("Electron closed stdin without a Dugan automixer response")

                try:
                    response = json.loads(response_line.strip())
                except Exception as parse_err:
                    raise RuntimeError(
                        f"Invalid Dugan automixer response (not JSON): {parse_err}: {response_line!r}")

                if response.get('type') == 'ducking_complete':
                    if response.get('error'):
                        # Previously logged and continued with unducked tracks.
                        emit_error(f"Dugan automixer failed: {response['error']}")
                        raise RuntimeError(f"Dugan automixer failed: {response['error']}")
                    # Update processed_audio paths with ducked versions
                    ducked_tracks = response.get('tracks', [])
                    for track in ducked_tracks:
                        t_type = track['type']
                        t_path = track['path']
                        if t_type in processed_audio:
                            processed_audio[t_type]['path'] = t_path
                            print(f"✓ Updated {t_type} with Dugan-processed file", file=sys.stderr)
                    print(f"✓ Dugan automixer applied to {len(ducked_tracks)} tracks", file=sys.stderr)
                    set_stage(39, f'Dugan automixer applied to {len(ducked_tracks)} tracks')
                else:
                    raise RuntimeError(
                        f"Unexpected response type from Electron during Dugan wait: {response.get('type')}")
            else:
                print(f"⚠ Only {len(dugan_tracks)} track(s) available - need at least 2 for Dugan", file=sys.stderr)
                set_stage(39, f'Dugan skipped: only {len(dugan_tracks)} track(s), need 2+')

            print("=== Dugan Automixer Complete ===\n", file=sys.stderr)

        # Step 4: Generate compound clips
        generated_clips = []
        # Collect per-step failures. Individual generation steps stay non-fatal so a
        # partial run still zips its successful outputs, but any failure is recorded
        # and surfaced (emit_error + non-zero exit) after the ZIP is built.
        step_failures = []
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
        set_stage(current_progress, 'Generating CAM Solo compound clip...')
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
            step_failures.append(f"CAM Solo: {e}")
        current_progress += progress_per_clip

        # Generate CAM Dual
        set_stage(current_progress, 'Generating CAM Dual Camera compound clip...')
        try:
            dc_cam_generator = DCCamGenerator(config)
            cam_dual_path = dc_cam_generator.generate_dc_cam_compound(
                compound_xml, cam_audio_sources, None, False, video_sources,
                use_downloaded_stream=use_downloaded_stream,
                video_offsets=video_offsets,
                video_drift_factors=video_drift_factors
            )
            all_xml_files.append(cam_dual_path)
            generated_clips.append({
                'type': 'cam_dual',
                'name': 'CAM - Dual Camera',
                'path': cam_dual_path
            })
        except Exception as e:
            print(f"Error generating CAM Dual: {e}", file=sys.stderr)
            step_failures.append(f"CAM Dual: {e}")
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
        set_stage(current_progress, 'Generating GS Solo compound clip...')
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
            step_failures.append(f"GS Solo: {e}")
        current_progress += progress_per_clip

        # Generate GS Dual
        set_stage(current_progress, 'Generating GS Dual Camera compound clip...')
        try:
            dc_gs_generator = DCGSGenerator(config)
            gs_dual_path = dc_gs_generator.generate_dc_gs_compound(
                compound_xml, gs_audio_sources, None, False, video_sources, auto_duck,
                use_downloaded_stream=use_downloaded_stream,
                video_offsets=video_offsets,
                video_drift_factors=video_drift_factors
            )
            all_xml_files.append(gs_dual_path)
            generated_clips.append({
                'type': 'gs_dual',
                'name': 'GS - Dual Camera',
                'path': gs_dual_path
            })
        except Exception as e:
            print(f"Error generating GS Dual: {e}", file=sys.stderr)
            step_failures.append(f"GS Dual: {e}")
        current_progress += progress_per_clip

        # Build SSB audio sources (same as GS)
        ssb_audio_sources = gs_audio_sources.copy()

        # Generate SSB Solo
        set_stage(current_progress, 'Generating SSB Solo compound clip...')
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
            step_failures.append(f"SSB Solo: {e}")
        current_progress += progress_per_clip

        # Generate SSB Dual
        set_stage(current_progress, 'Generating SSB Dual Camera compound clip...')
        try:
            dc_ssb_generator = DCSSBGenerator(config)
            ssb_dual_path = dc_ssb_generator.generate_dc_ssb_compound(
                compound_xml, ssb_audio_sources, None, False, video_sources,
                use_downloaded_stream=use_downloaded_stream,
                video_offsets=video_offsets,
                video_drift_factors=video_drift_factors
            )
            all_xml_files.append(ssb_dual_path)
            generated_clips.append({
                'type': 'ssb_dual',
                'name': 'SSB - Dual Camera',
                'path': ssb_dual_path
            })
        except Exception as e:
            print(f"Error generating SSB Dual: {e}", file=sys.stderr)
            step_failures.append(f"SSB Dual: {e}")
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
                set_stage(88, 'Generating adaptive hybrid compounds...')
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
                    use_downloaded_stream=use_downloaded_stream,
                    video_offsets=video_offsets
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
                step_failures.append(f"Hybrid Compounds: {e}")

        # Generate master projects
        set_stage(90, 'Generating Master SOLO project...')
        print(f"Master SOLO check - cam_solo_path: {cam_solo_path}, gs_solo_path: {gs_solo_path}, ssb_solo_path: {ssb_solo_path}", file=sys.stderr)
        if cam_solo_path and gs_solo_path and ssb_solo_path:
            try:
                master_gen = MasterProjectGenerator(config)
                master_gen.detect_framerate(str(master_video))
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
                step_failures.append(f"Master SOLO: {e}")
        else:
            print(f"Cannot generate Master SOLO - missing required compounds", file=sys.stderr)
            step_failures.append("Master SOLO: missing required compounds (CAM/GS/SSB Solo)")

        set_stage(92, 'Generating Master DC project...')
        print(f"Master DC check - cam_dual_path: {cam_dual_path}, gs_dual_path: {gs_dual_path}, ssb_dual_path: {ssb_dual_path}", file=sys.stderr)
        if cam_dual_path and gs_dual_path and ssb_dual_path:
            try:
                master_gen = MasterProjectGenerator(config)
                master_gen.detect_framerate(str(master_video))
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
                step_failures.append(f"Master DC: {e}")
        else:
            print(f"Cannot generate Master DC - missing required compounds", file=sys.stderr)
            step_failures.append("Master DC: missing required compounds (CAM/GS/SSB Dual)")

        # Generate Master Hybrid project if hybrid compounds exist
        if hybrid_cam_path and hybrid_gs_path and hybrid_ssb_path:
            try:
                set_stage(94, 'Generating Master Hybrid project...')
                print(f"Generating Master Hybrid project", file=sys.stderr)
                master_gen = MasterProjectGenerator(config)
                master_gen.detect_framerate(str(master_video))
                # Use the DC method but with hybrid compounds - the compounds themselves handle the adaptation
                master_hybrid_paths = master_gen.generate_dc_master_project(
                    hybrid_cam_path, hybrid_gs_path, hybrid_ssb_path, original_name
                )
                # Rename from DC to Hybrid in the generated files. Collect every
                # rename: new_path previously leaked out of this loop, so an empty
                # loop crashed with NameError and multiple renames pointed the clip
                # path at the wrong (last) file.
                renamed_paths = []
                for path in master_hybrid_paths:
                    if Path(path).exists():
                        new_path = Path(path).parent / Path(path).name.replace('_DC', '_HYBRID')
                        Path(path).rename(new_path)
                        all_xml_files.append(str(new_path))
                        renamed_paths.append(str(new_path))

                generated_clips.append({
                    'type': 'master_hybrid',
                    'name': 'Master Hybrid Project',
                    'path': renamed_paths[0] if renamed_paths else None
                })
                if master_hybrid_paths and not renamed_paths:
                    step_failures.append(
                        "Master Hybrid: generator returned paths but none could be renamed to _HYBRID")
                print(f"Successfully generated Master Hybrid: {renamed_paths[0] if renamed_paths else None}", file=sys.stderr)
            except Exception as e:
                print(f"Error generating Master Hybrid: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)
                step_failures.append(f"Master Hybrid: {e}")

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

        # Construct the shorts generators ONCE, up front. They used to be created
        # inside the solo try blocks and reused in the dual blocks — if a solo block
        # failed before its assignment, the dual block died with NameError.
        shorts_cam_gen = ShortsCamGenerator(config)
        shorts_ssb_gen = ShortsSSBGenerator(config)

        try:
            set_stage(94, 'Generating Shorts CAM Solo compound...')
            print(f"\nGenerating Shorts CAM Solo compound", file=sys.stderr)
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
            step_failures.append(f"Shorts CAM Solo: {e}")

        try:
            set_stage(94.5, 'Generating Shorts SSB Solo compound...')
            print(f"\nGenerating Shorts SSB Solo compound", file=sys.stderr)
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
            step_failures.append(f"Shorts SSB Solo: {e}")

        try:
            set_stage(95, 'Generating Shorts CAM Dual compound...')
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
            step_failures.append(f"Shorts CAM Dual: {e}")

        try:
            set_stage(95.5, 'Generating Shorts SSB Dual compound...')
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
            step_failures.append(f"Shorts SSB Dual: {e}")

        # Generate Shorts Hybrid compounds if both CAM and SSB DC exist
        if shorts_cam_dual_path and shorts_ssb_dual_path:
            try:
                set_stage(96, 'Generating Shorts Hybrid compounds...')
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
                step_failures.append(f"Shorts Hybrid compounds: {e}")

        # Generate Shorts Master Project if hybrid compounds exist
        if shorts_hybrid_cam_path and shorts_hybrid_ssb_path:
            try:
                set_stage(97, 'Generating Master Shorts project...')
                print(f"\nGenerating Master Shorts project", file=sys.stderr)
                shorts_master_gen = ShortsMasterProjectGenerator(config)
                shorts_master_gen.detect_framerate(str(master_video))
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
                step_failures.append(f"Master Shorts: {e}")

        # Create ZIP file
        set_stage(98, 'Creating compound clips ZIP file...')
        session_name = Path(master_video).stem.replace(' master', '')
        output_dir = Path(master_video).parent

        # create_xml_zip zips these XMLs then DELETES them, so the on-disk paths in
        # generated_clips would point at files that no longer exist. Rewrite each clip
        # path to its zip-internal entry name (matching create_xml_zip's arcname
        # exactly, including the session_name.replace(' ', '_') cleaning) while the
        # files still exist on disk. A file "made it into the zip" iff it is non-None
        # and exists — the same condition create_xml_zip uses to decide what to write —
        # so entries whose path is None or already missing honestly get path None.
        clean_name = session_name.replace(' ', '_')
        for clip in generated_clips:
            clip_path = clip.get('path')
            if clip_path and Path(clip_path).exists():
                clip['path'] = f"{clean_name}/{Path(clip_path).name}"
            else:
                clip['path'] = None

        zip_path = create_xml_zip(all_xml_files, output_dir, session_name)

        set_stage(100, 'Processing complete!')

        # Individual generation steps are non-fatal so a partial run still zips its
        # successful outputs — but a failed step must not masquerade as success.
        if step_failures:
            emit_error(
                "Workflow finished with failed steps: "
                + "; ".join(step_failures)
                + f" — successful outputs were zipped to {zip_path}"
            )
            sys.exit(1)

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
