#!/usr/bin/env python3
# cli/transcribe.py
#
# Transcription phase (editor v3, phase 1 of the transcript stack). Runs local
# Whisper (whisper.cpp / whisper-cli) on each PER-SOURCE audio track of a processed
# session and writes a transcript sidecar whose words are mapped onto the EDITOR
# TIMELINE — the same original-timeline coordinate base the editor's cut list uses.
#
# KEY INSIGHT (drives the whole design): the master hybrid fcpxml's compounds encode,
# for every kept cut, each per-source audio leaf as {timelineStart, duration, file,
# sourceStart}. So a Whisper word at file-time w maps to the timeline by finding that
# file's leaf segment whose source range contains w:
#     timelineTime = timelineStart + (w - sourceStart)
# Words falling in no kept segment were cut by auto-editor (silence) and are DROPPED.
# A word straddling a segment boundary is assigned to the segment containing its
# MIDPOINT (and still dropped if that midpoint lands in a cut). No alignment sidecar,
# no offset/drift math — the fcpxml already encodes placement per cut.
#
# Invocation (all tool paths injected by Electron; every one validated, loud error
# naming the missing piece):
#     python cli/transcribe.py --zip /abs/<name>_compounds.zip \
#         --whisper-bin /abs/whisper-cli --whisper-model /abs/ggml-base.bin \
#         --ffmpeg /abs/ffmpeg [--language en] [--max-seconds N]
#
# Progress protocol on stdout (one JSON object per line, flushed; mirrors
# cli/electron_workflow.py):
#     {"type":"progress","progress":<0-100 int>,"message":"..."}
#     {"type":"success","result":{"transcriptPath":"/abs/...","wordCount":N,"tracks":M}}
#     {"type":"error","message":"..."}   (+ exit code 1)
# All diagnostics go to stderr. The sidecar is written ATOMICALLY (tmp + os.replace)
# only after ALL tracks finish, so a cancelled/failed run never leaves a partial file.
#
# DOCTRINE (CLAUDE.md + project practice): numbers are sacred, fail loud, no silent
# fallbacks. Every missing/ambiguous input raises with a message naming what was wrong.

import argparse
import json
import os
import re
import signal
import string
import subprocess
import sys
import tempfile
import zipfile
from collections import deque
from pathlib import Path
import xml.etree.ElementTree as ET

# Reuse the manifest flattener verbatim — do NOT reimplement the fcpxml traversal.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
from cli.editor_manifest import (  # noqa: E402
    ManifestBuilder,
    ManifestError,
    _find_master_hybrid_entry,
    _session_name,
)


class TranscribeError(Exception):
    """A loud, user-facing failure; its message is emitted verbatim in the error JSON."""


# ---------------------------------------------------------------------------
# Process/temp tracking for cancellation (SIGTERM) and cleanup.
# ---------------------------------------------------------------------------
_current_proc = None      # the child (ffmpeg or whisper) currently running
_temp_dir = None          # the run's temp dir, removed on exit/cancel


def _cleanup_temp():
    global _temp_dir
    if _temp_dir and os.path.isdir(_temp_dir):
        import shutil
        shutil.rmtree(_temp_dir, ignore_errors=True)
    _temp_dir = None


def _emit(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


def _handle_sigterm(_signum, _frame):
    """Cancel: terminate the running child, clean temp, emit error, exit 1. A cancelled
    job must never leave a partial sidecar (the sidecar is only written atomically at the
    very end, so at cancel time it does not exist yet)."""
    global _current_proc
    proc = _current_proc
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    _cleanup_temp()
    _emit({'type': 'error', 'message': 'transcription cancelled'})
    os._exit(1)


# ---------------------------------------------------------------------------
# Tool-path validation (loud, names the missing piece).
# ---------------------------------------------------------------------------
def _validate_tool(path, what, need_exec):
    if not path:
        raise TranscribeError(f"{what} path was not provided")
    p = Path(path)
    if not p.exists():
        raise TranscribeError(f"{what} not found: {path}")
    if not p.is_file():
        raise TranscribeError(f"{what} is not a file: {path}")
    if need_exec and not os.access(path, os.X_OK):
        raise TranscribeError(f"{what} is not executable: {path}")
    if not need_exec and not os.access(path, os.R_OK):
        raise TranscribeError(f"{what} is not readable: {path}")


# ---------------------------------------------------------------------------
# Track discovery: flatten the master hybrid, collect distinct NON-master audio files.
# ---------------------------------------------------------------------------
def _model_name(model_path):
    stem = Path(model_path).stem      # ggml-base -> base
    if stem.startswith('ggml-'):
        stem = stem[len('ggml-'):]
    return stem


def discover_tracks(zip_path):
    """Return (session, frame_seconds, tracks) where tracks is an ordered list of dicts:
       {id, label, file, segments}. segments is that file's audio leaf segments sorted
       (timeline order) with their group index. Master recording excluded. Loud errors
       for: no non-master audio, missing files."""
    zp = Path(zip_path)
    if not zp.is_file():
        raise TranscribeError(f"zip not found: {zip_path}")
    if not zipfile.is_zipfile(zp):
        raise TranscribeError(f"not a valid zip file: {zip_path}")

    with zipfile.ZipFile(zp, 'r') as zf:
        entry = _find_master_hybrid_entry(zf, zip_path)
        print(f"[transcribe] master hybrid entry: {entry}", file=sys.stderr)
        with zf.open(entry) as fh:
            try:
                tree = ET.parse(fh)
            except ET.ParseError as e:
                raise TranscribeError(f"{entry}: XML parse error: {e}")

    builder = ManifestBuilder(tree, entry)
    _total_declared, frame_seconds = builder.flatten()
    master_file = builder._identify_master_file()

    # Distinct non-master audio files in first-appearance (discovery) order.
    order = []
    seen = set()
    for leaf in builder.leaves:
        if leaf['kind'] != 'audio':
            continue
        f = leaf['file']
        if f == master_file:
            continue
        if f not in seen:
            seen.add(f)
            order.append(f)

    if not order:
        raise TranscribeError(
            "no non-master audio tracks to transcribe: every flattened audio leaf "
            f"references the master recording {master_file}. The per-source tracks "
            "(mic/screen audio) are the point of transcription.")

    missing = [f for f in order if not Path(f).exists()]
    if missing:
        raise TranscribeError(
            "audio track file(s) not found on disk:\n  " + "\n  ".join(sorted(missing)))

    session = _session_name(zip_path)
    prefix = f"{session} "
    tracks = []
    for idx, f in enumerate(order):
        segs = [l for l in builder.leaves if l['kind'] == 'audio' and l['file'] == f]
        # group index == timeline-clip order for this file (stable, unique per segment).
        segs.sort(key=lambda l: (l['timeline_start'], l['timeline_end'], l['source_start']))
        segments = []
        for g, l in enumerate(segs):
            segments.append({
                'group': g,
                'source_start': float(l['source_start']),
                'source_end': float(l['source_start'] + (l['timeline_end'] - l['timeline_start'])),
                'timeline_start': float(l['timeline_start']),
            })
        stem = Path(f).stem
        label = stem[len(prefix):] if stem.startswith(prefix) else stem
        tracks.append({'id': f"t{idx}", 'label': label, 'file': f, 'segments': segments})

    return session, float(frame_seconds), tracks


# ---------------------------------------------------------------------------
# Word extraction from whisper's JSON + noise filtering.
# ---------------------------------------------------------------------------
_PROGRESS_RE = re.compile(r'progress\s*=\s*(\d+)\s*%')


def _is_punct_noise(text):
    """Empty or pure punctuation/whitespace tokens are dropped."""
    if not text:
        return True
    if all(ch in string.punctuation or ch.isspace() for ch in text):
        return True
    return False


def parse_whisper_json(json_path):
    """Parse whisper-cli's full JSON (-ojf) into a list of raw words:
       [{text, file_start(s), file_end(s), prob(optional)}]. Offsets are MILLISECONDS.
       With -ml 1 -sow each transcription entry is one word; per-token 'p' values (from
       -ojf) are averaged for the word probability, omitted when no tokens are present.

       Non-speech annotations ([BLANK_AUDIO], [MUSIC], (upbeat music), ...) are dropped.
       Because -sow splits on words, whisper emits a multi-word annotation as SEPARATE
       tokens ("(upbeat", "music)"), so a per-token "starts-with-( ends-with-)" test
       misses the interior/split pieces. We instead track bracket depth ACROSS tokens:
       once a '(' or '[' opens, every token is suppressed until the matching close —
       correctly dropping "(clears", "throat", "loudly)" as one unit. Real spoken words
       never carry literal ()[] so this cannot swallow genuine speech."""
    with open(json_path, 'r') as fh:
        data = json.load(fh)
    transcription = data.get('transcription')
    if transcription is None:
        raise TranscribeError(f"whisper JSON {json_path} has no 'transcription' array")

    words = []
    bracket_depth = 0
    for entry in transcription:
        text = (entry.get('text') or '').strip()
        opens = text.count('(') + text.count('[')
        closes = text.count(')') + text.count(']')
        was_inside = bracket_depth > 0
        bracket_depth = max(0, bracket_depth + opens - closes)
        # Skip this token if it is inside an open annotation or itself opens one
        # (covers single-token [MUSIC] as well as split "(upbeat" / "music)").
        if was_inside or opens > 0:
            continue
        if _is_punct_noise(text):
            continue
        offsets = entry.get('offsets') or {}
        if 'from' not in offsets or 'to' not in offsets:
            raise TranscribeError(
                f"whisper JSON entry missing offsets: {entry!r}")
        fs = offsets['from'] / 1000.0
        fe = offsets['to'] / 1000.0
        word = {'text': text, 'file_start': fs, 'file_end': fe}
        tokens = entry.get('tokens')
        if tokens:
            ps = [t['p'] for t in tokens if 'p' in t]
            if ps:
                word['prob'] = sum(ps) / len(ps)
        words.append(word)
    return words


def _segment_for_midpoint(segments, mid):
    """The kept segment whose source range contains the word midpoint, else None
    (midpoint fell in a cut / silence -> word dropped)."""
    for seg in segments:
        if seg['source_start'] <= mid < seg['source_end']:
            return seg
    return None


def map_words(track, raw_words):
    """Map raw file-time words onto the timeline for one track. Drops words whose
    midpoint lies in a cut. Returns the sidecar word dicts (unsorted)."""
    segments = track['segments']
    out = []
    for w in raw_words:
        fs = w['file_start']
        fe = w['file_end']
        mid = (fs + fe) / 2.0
        seg = _segment_for_midpoint(segments, mid)
        if seg is None:
            continue   # cut by auto-editor
        delta = seg['timeline_start'] - seg['source_start']
        word = {
            'track': track['id'],
            'text': w['text'],
            'timelineStart': fs + delta,
            'timelineEnd': fe + delta,
            'fileStart': fs,
            'fileEnd': fe,
            'group': seg['group'],
        }
        if 'prob' in w:
            word['prob'] = w['prob']
        out.append(word)
    return out


# ---------------------------------------------------------------------------
# ffmpeg extraction + whisper run (per track).
# ---------------------------------------------------------------------------
def _run_child(cmd, what):
    """Run a child process, tracking it for SIGTERM cancellation, streaming nothing.
    Returns (returncode, stderr_tail_str)."""
    global _current_proc
    tail = deque(maxlen=60)
    proc = subprocess.Popen(
        cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        text=True, bufsize=1)
    _current_proc = proc
    try:
        for line in proc.stderr:
            tail.append(line.rstrip('\n'))
        proc.wait()
    finally:
        _current_proc = None
    return proc.returncode, '\n'.join(tail)


def extract_wav(ffmpeg, src_file, dst_wav, max_seconds):
    cmd = [ffmpeg, '-y', '-nostdin', '-i', src_file]
    if max_seconds is not None:
        cmd += ['-t', str(max_seconds)]
    cmd += ['-ac', '1', '-ar', '16000', '-f', 'wav', dst_wav]
    rc, tail = _run_child(cmd, 'ffmpeg')
    if rc != 0:
        raise TranscribeError(
            f"ffmpeg failed extracting {src_file} (exit {rc}):\n{tail[-2000:]}")
    if not (os.path.isfile(dst_wav) and os.path.getsize(dst_wav) > 0):
        raise TranscribeError(f"ffmpeg produced no wav for {src_file}")


def run_whisper(whisper_bin, model, wav, out_prefix, language, on_progress):
    """Run whisper-cli producing <out_prefix>.json. Streams stderr, calling
    on_progress(pct) as whisper reports 'progress = NN%'. Returns the JSON path."""
    global _current_proc
    # -ojf (full JSON) INSTEAD of -oj: same <out_prefix>.json output plus per-word token
    # 'p' probabilities. Exact Metal-binary arg string, probed once (see module header).
    cmd = [whisper_bin, '-m', model, '-f', wav, '-ml', '1', '-sow',
           '-ojf', '-of', out_prefix, '-np', '-l', language, '-pp']
    tail = deque(maxlen=60)
    proc = subprocess.Popen(
        cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        text=True, bufsize=1)
    _current_proc = proc
    try:
        for line in proc.stderr:
            line = line.rstrip('\n')
            tail.append(line)
            m = _PROGRESS_RE.search(line)
            if m:
                on_progress(int(m.group(1)))
        proc.wait()
    finally:
        _current_proc = None
    if proc.returncode != 0:
        raise TranscribeError(
            f"whisper-cli failed on {wav} (exit {proc.returncode}):\n"
            f"{chr(10).join(tail)[-2000:]}")
    json_path = out_prefix + '.json'
    if not os.path.isfile(json_path):
        raise TranscribeError(
            f"whisper-cli produced no JSON output at {json_path}")
    return json_path


# ---------------------------------------------------------------------------
# Orchestration.
# ---------------------------------------------------------------------------
def transcribe(zip_path, whisper_bin, whisper_model, ffmpeg, language, max_seconds):
    global _temp_dir

    _validate_tool(whisper_bin, 'whisper binary', need_exec=True)
    _validate_tool(whisper_model, 'whisper model', need_exec=False)
    _validate_tool(ffmpeg, 'ffmpeg binary', need_exec=True)

    session, frame_seconds, tracks = discover_tracks(zip_path)
    n = len(tracks)

    _temp_dir = tempfile.mkdtemp(prefix='transcribe_')
    all_words = []
    try:
        for i, track in enumerate(tracks):
            band_lo = i / n * 100.0
            band_w = 100.0 / n
            label = track['label']

            _emit({'type': 'progress', 'progress': int(band_lo),
                   'message': f"Extracting {label} ({i + 1}/{n})..."})

            wav = os.path.join(_temp_dir, f"track{i}.wav")
            extract_wav(ffmpeg, track['file'], wav, max_seconds)

            # Extraction owns the first 10% of the band.
            extract_end = band_lo + 0.10 * band_w
            _emit({'type': 'progress', 'progress': int(extract_end),
                   'message': f"Transcribing {label} ({i + 1}/{n})..."})

            def on_progress(pct, _lo=extract_end, _w=band_w, _label=label, _i=i):
                overall = _lo + (pct / 100.0) * (0.90 * _w)
                _emit({'type': 'progress', 'progress': int(overall),
                       'message': f"Transcribing {_label} ({_i + 1}/{n})..."})

            out_prefix = os.path.join(_temp_dir, f"track{i}")
            json_path = run_whisper(whisper_bin, whisper_model, wav, out_prefix,
                                    language, on_progress)
            raw = parse_whisper_json(json_path)
            mapped = map_words(track, raw)
            if not mapped:
                print(f"[transcribe] track {track['id']} ({label}) contributed 0 words",
                      file=sys.stderr)
            all_words.extend(mapped)

        # words sorted by (track, fileStart). Track order = discovery order (t0, t1, ...).
        track_order = {t['id']: i for i, t in enumerate(tracks)}
        all_words.sort(key=lambda w: (track_order[w['track']], w['fileStart']))

        sidecar = {
            'schemaVersion': 1,
            'session': session,
            'model': _model_name(whisper_model),
            'calibration': 'none',
            'frameSeconds': frame_seconds,
            'tracks': [{'id': t['id'], 'label': t['label'], 'file': t['file']}
                       for t in tracks],
            'words': all_words,
        }

        out_path = str(Path(zip_path).parent / f"{session}_transcript.json")
        _atomic_write_json(out_path, sidecar)
        _emit({'type': 'progress', 'progress': 100,
               'message': 'Transcription complete'})
        _emit({'type': 'success', 'result': {
            'transcriptPath': out_path, 'wordCount': len(all_words), 'tracks': n}})
        return 0
    finally:
        _cleanup_temp()


def _atomic_write_json(out_path, obj):
    """tmp file in the SAME directory + os.replace, so a reader never sees a partial
    sidecar and a crash mid-write cannot corrupt an existing one. Overwrite allowed
    (derived artifact); note it on stderr."""
    d = os.path.dirname(out_path)
    if os.path.exists(out_path):
        print(f"[transcribe] overwriting existing sidecar {out_path}", file=sys.stderr)
    fd, tmp = tempfile.mkstemp(prefix='.transcript_', suffix='.tmp', dir=d)
    try:
        with os.fdopen(fd, 'w') as fh:
            json.dump(obj, fh)
        os.replace(tmp, out_path)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Transcribe a session's per-source audio tracks and write a "
                    "timeline-mapped transcript sidecar next to the compounds zip.")
    parser.add_argument('--zip', dest='zip_path', required=True,
                        help='Absolute path to the <name>_compounds.zip')
    parser.add_argument('--whisper-bin', required=True,
                        help='Absolute path to the whisper-cli binary (Metal build)')
    parser.add_argument('--whisper-model', required=True,
                        help='Absolute path to the ggml whisper model')
    parser.add_argument('--ffmpeg', required=True,
                        help='Absolute path to the ffmpeg binary')
    parser.add_argument('--language', default='en',
                        help="Spoken language passed to whisper (default 'en')")
    parser.add_argument('--max-seconds', type=float, default=None,
                        help='Optional: transcribe only the first N seconds of each '
                             'track (ffmpeg -t). For fast smoke tests; default is the '
                             'whole track.')
    args = parser.parse_args(argv)

    signal.signal(signal.SIGTERM, _handle_sigterm)

    try:
        return transcribe(args.zip_path, args.whisper_bin, args.whisper_model,
                          args.ffmpeg, args.language, args.max_seconds)
    except (TranscribeError, ManifestError) as e:
        _cleanup_temp()
        _emit({'type': 'error', 'message': str(e)})
        return 1
    except Exception as e:  # unexpected — still fail loud, never leave a partial sidecar
        _cleanup_temp()
        _emit({'type': 'error', 'message': f"{type(e).__name__}: {e}"})
        return 1


if __name__ == '__main__':
    sys.exit(main())
