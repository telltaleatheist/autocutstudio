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
import time
import wave
import zipfile
from collections import deque
from pathlib import Path
import xml.etree.ElementTree as ET

import numpy as np

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
# Silence-gated VAD constants (drive compute_activity / build_compact_wav).
# Whisper.cpp hallucinates on silence, so each track is transcribed on a COMPACT
# wav made of only its active speech spans. All named, all module-level.
# ---------------------------------------------------------------------------
BIN_SEC = 0.1                 # RMS bin width for the activity map
ACTIVITY_RATIO = 0.06         # active if bin RMS > ratio * p95(RMS)
ACTIVITY_PERCENTILE = 95      # percentile used as the loudness reference
SILENCE_FLOOR = 1e-4          # p95 RMS below this (of full-scale) => silent track
MIN_SPAN_SEC = 0.3            # drop active runs shorter than this
MERGE_GAP_SEC = 0.6           # merge active spans separated by less than this
PAD_SEC = 0.3                 # extend each span both sides (clamped to [0, dur])
SEP_SEC = 0.3                 # silence separator between concatenated spans

_FULL_SCALE = 32768.0         # 16-bit signed PCM full scale


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


def _safe_remove(path):
    """Best-effort delete of a per-track temp file (the run's temp dir is torn down
    wholesale at the end; this just bounds peak disk use for multi-hour tracks)."""
    try:
        if path and os.path.isfile(path):
            os.remove(path)
    except OSError:
        pass


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
       NOTE: whisper now runs on the per-track COMPACT wav, so file_start/file_end here
       are COMPACT-wav seconds; map_words shifts them back to real file/timeline time.
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


# ---------------------------------------------------------------------------
# Voice-activity gating: build a per-track activity map, a COMPACT wav of only the
# active speech, and a time-map that maps compact-wav time back to source-file time.
# ---------------------------------------------------------------------------
def _merge_spans(spans, gap):
    """Merge (start, end) spans (seconds) whose separation is < gap. Returns sorted,
    disjoint spans. gap=0 (or tiny) merges only overlapping/touching spans."""
    if not spans:
        return []
    ordered = sorted(spans)
    merged = [list(ordered[0])]
    for s, e in ordered[1:]:
        if s - merged[-1][1] < gap:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return [(s, e) for s, e in merged]


def compute_activity(wav_path):
    """Stream a 16k mono s16 wav in BIN_SEC bins, compute per-bin RMS, and return the
    active speech spans as a sorted, disjoint list of (file_start_sec, file_end_sec).

    Active when a bin's RMS exceeds ACTIVITY_RATIO * p95(all bin RMS). If that p95 is
    below SILENCE_FLOOR of full scale the whole track is silent -> []. Runs shorter
    than MIN_SPAN_SEC are dropped, spans closer than MERGE_GAP_SEC merged, each span
    padded PAD_SEC on both sides (clamped to [0, duration]) and re-merged on overlap.
    Reads chunk-by-chunk so a multi-hour file never lands wholly in memory."""
    with wave.open(wav_path, 'rb') as wf:
        if wf.getnchannels() != 1 or wf.getsampwidth() != 2:
            raise TranscribeError(
                f"compute_activity expected 16k mono s16 wav, got "
                f"{wf.getnchannels()}ch/{wf.getsampwidth() * 8}-bit: {wav_path}")
        framerate = wf.getframerate()
        n_frames = wf.getnframes()
        bin_frames = max(1, int(round(BIN_SEC * framerate)))
        bin_dur = bin_frames / framerate
        duration = n_frames / framerate

        rms_bins = []
        while True:
            raw = wf.readframes(bin_frames)
            if not raw:
                break
            samples = np.frombuffer(raw, dtype='<i2').astype(np.float64)
            if samples.size == 0:
                break
            rms_bins.append(float(np.sqrt(np.mean(samples * samples))))

    if not rms_bins:
        return []
    rms_arr = np.asarray(rms_bins)
    p95 = float(np.percentile(rms_arr, ACTIVITY_PERCENTILE))
    if p95 < SILENCE_FLOOR * _FULL_SCALE:
        return []                                   # silent track
    threshold = ACTIVITY_RATIO * p95

    # Collapse consecutive active bins into runs -> spans (seconds).
    active = rms_arr > threshold
    runs = []
    start = None
    for i, a in enumerate(active):
        if a and start is None:
            start = i
        elif not a and start is not None:
            runs.append((start * bin_dur, i * bin_dur))
            start = None
    if start is not None:
        runs.append((start * bin_dur, len(active) * bin_dur))

    runs = [(s, min(e, duration)) for (s, e) in runs]
    runs = [(s, e) for (s, e) in runs if (e - s) >= MIN_SPAN_SEC]
    runs = _merge_spans(runs, MERGE_GAP_SEC)
    padded = [(max(0.0, s - PAD_SEC), min(duration, e + PAD_SEC)) for (s, e) in runs]
    return _merge_spans(padded, 1e-9)               # re-merge any now-overlapping spans


def build_compact_wav(src_16k_wav, spans, dst_wav):
    """Write a compact 16k mono s16 wav holding only `spans` from the source (in order),
    with SEP_SEC of silence between them. Returns a time_map: sorted list of
    {concat_start, concat_end, file_start} (seconds), where concat_* is a span's
    position in the compact wav and file_start its start in the source file. Copies in
    ~1s chunks so memory stays bounded."""
    time_map = []
    with wave.open(src_16k_wav, 'rb') as sf:
        framerate = sf.getframerate()
        sampwidth = sf.getsampwidth()
        n_channels = sf.getnchannels()
        n_frames = sf.getnframes()
        sep_frames = int(round(SEP_SEC * framerate))
        silence = b'\x00' * (sep_frames * sampwidth * n_channels)
        chunk_frames = framerate                    # 1 second per copy

        with wave.open(dst_wav, 'wb') as df:
            df.setnchannels(n_channels)
            df.setsampwidth(sampwidth)
            df.setframerate(framerate)

            concat_frames = 0
            for idx, (fs, fe) in enumerate(spans):
                if idx > 0:
                    df.writeframes(silence)
                    concat_frames += sep_frames
                start_frame = max(0, min(int(round(fs * framerate)), n_frames))
                end_frame = max(start_frame, min(int(round(fe * framerate)), n_frames))
                sf.setpos(start_frame)
                concat_start = concat_frames / framerate
                remaining = end_frame - start_frame
                while remaining > 0:
                    data = sf.readframes(min(chunk_frames, remaining))
                    got = len(data) // (sampwidth * n_channels)
                    if got == 0:
                        break
                    df.writeframes(data)
                    concat_frames += got
                    remaining -= got
                time_map.append({
                    'concat_start': concat_start,
                    'concat_end': concat_frames / framerate,
                    'file_start': start_frame / framerate,
                })
    return time_map


def _find_span(time_map, tc):
    """Binary search for the span whose [concat_start, concat_end) contains tc, else
    None (tc landed in a silence separator between spans)."""
    lo, hi = 0, len(time_map) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        span = time_map[mid]
        if tc < span['concat_start']:
            hi = mid - 1
        elif tc >= span['concat_end']:
            lo = mid + 1
        else:
            return span
    return None


def map_compact_time(time_map, tc):
    """Compact-wav time -> source-file time, or None if tc is in a separator gap."""
    span = _find_span(time_map, tc)
    if span is None:
        return None
    return span['file_start'] + (tc - span['concat_start'])


def map_words(track, raw_words, time_map):
    """Map gated words (times in COMPACT-wav coordinates) onto the timeline for one
    track. Each word is first shifted compact->file through the span containing its
    midpoint (drop if the midpoint fell in a silence separator), then file->timeline
    via the existing leaf mapping (drop if the file midpoint fell in a cut). Sidecar
    fileStart/fileEnd are the real source-file seconds. Returns dicts (unsorted)."""
    segments = track['segments']
    out = []
    for w in raw_words:
        cs = w['file_start']            # compact-wav coordinates
        ce = w['file_end']
        mid_c = (cs + ce) / 2.0
        span = _find_span(time_map, mid_c)
        if span is None:
            continue                    # midpoint fell in a silence separator -> gated out
        # Shift start/end/midpoint through the SAME span as the midpoint.
        base = span['file_start'] - span['concat_start']
        file_start_word = base + cs
        file_end_word = base + ce
        ft_mid = base + mid_c
        seg = _segment_for_midpoint(segments, ft_mid)
        if seg is None:
            continue                    # cut by auto-editor
        delta = seg['timeline_start'] - seg['source_start']
        word = {
            'track': track['id'],
            'text': w['text'],
            'timelineStart': file_start_word + delta,
            'timelineEnd': file_end_word + delta,
            'fileStart': file_start_word,
            'fileEnd': file_end_word,
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
    # 16k MONO SIGNED-16 PCM so Python's stdlib `wave` can read the frames for VAD.
    cmd += ['-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', dst_wav]
    rc, tail = _run_child(cmd, 'ffmpeg')
    if rc != 0:
        raise TranscribeError(
            f"ffmpeg failed extracting {src_file} (exit {rc}):\n{tail[-2000:]}")
    if not (os.path.isfile(dst_wav) and os.path.getsize(dst_wav) > 0):
        raise TranscribeError(f"ffmpeg produced no wav for {src_file}")


def _warn_repetition_loops(track_id, label, words, min_reps=10):
    """Post-transcription tripwire: scan a track's mapped words for a phrase (2..15 words)
    repeated >= min_reps times CONSECUTIVELY — the signature of a whisper hallucination
    loop. Real speech repeats a few times; ten identical consecutive phrases is decoding
    pathology. WARNS loudly on stderr (never silently ships a poisoned transcript); it is
    not an error because chants/song choruses can legitimately trip it."""
    texts = [w['text'].strip().lower() for w in words]
    for n in range(2, 16):
        i = 0
        while i + 2 * n <= len(texts):
            reps = 1
            while i + (reps + 1) * n <= len(texts) and texts[i:i + n] == texts[i + reps * n:i + (reps + 1) * n]:
                reps += 1
            if reps >= min_reps:
                phrase = ' '.join(texts[i:i + n])
                at = words[i]['fileStart']
                print(f"[transcribe] WARNING: track {track_id} ({label}) repeats "
                      f"{phrase!r} {reps}x consecutively starting at file {at:.1f}s — "
                      f"possible whisper hallucination loop; review this region",
                      file=sys.stderr)
                i += reps * n
            else:
                i += 1


def run_whisper(whisper_bin, model, wav, out_prefix, language, on_progress):
    """Run whisper-cli producing <out_prefix>.json. Streams stderr, calling
    on_progress(pct) as whisper reports 'progress = NN%'. Returns the JSON path."""
    global _current_proc
    # -ojf (full JSON) INSTEAD of -oj: same <out_prefix>.json output plus per-word token
    # 'p' probabilities. Exact Metal-binary arg string, probed once (see module header).
    # -mc 0 (--max-context 0): do NOT condition each 30s window on the previous window's
    # text. Conditioning is whisper's repetition-loop vector: one real utterance ("and
    # we're seeing the same thing in the UK") seeded a self-reinforcing loop that repeated
    # 600+ times across ~25 minutes of the screen track, steamrolling real speech.
    # Verified on the exact production compact wav: 678 loop phrases -> 2 (the real
    # utterance), while NET real words INCREASED (the loop had been replacing dialogue).
    cmd = [whisper_bin, '-m', model, '-f', wav, '-ml', '1', '-sow',
           '-ojf', '-of', out_prefix, '-np', '-l', language, '-pp', '-mc', '0']
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

    # ETA is MEASURED, not guessed: whisper throughput is ~constant, so the remaining
    # time is (elapsed) * (work left / work done) using the real overall progress
    # fraction. Withheld until progress >= 2% (before that the ratio is too noisy to be
    # honest — the UI shows "estimating" instead). The tracks are equal-duration and the
    # per-track bands split the work evenly, so overall progress tracks real work well.
    start_mono = time.monotonic()

    def emit_progress(pct, message):
        obj = {'type': 'progress', 'progress': int(pct), 'message': message}
        if pct >= 2:
            elapsed = time.monotonic() - start_mono
            obj['etaSeconds'] = int(round(elapsed * (100.0 - pct) / pct))
        _emit(obj)

    _temp_dir = tempfile.mkdtemp(prefix='transcribe_')
    all_words = []
    try:
        for i, track in enumerate(tracks):
            band_lo = i / n * 100.0
            band_w = 100.0 / n
            label = track['label']

            emit_progress(band_lo, f"Extracting {label} ({i + 1}/{n})...")

            wav = os.path.join(_temp_dir, f"track{i}.wav")
            compact = os.path.join(_temp_dir, f"track{i}_compact.wav")
            try:
                extract_wav(ffmpeg, track['file'], wav, max_seconds)

                # Extraction (+ VAD gating) owns the first 10% of the band.
                extract_end = band_lo + 0.10 * band_w
                emit_progress(extract_end, f"Transcribing {label} ({i + 1}/{n})...")

                # Voice-activity gate: transcribe ONLY the active speech spans.
                spans = compute_activity(wav)
                if not spans:
                    print(f"[transcribe] track {track['id']} ({label}) is silent "
                          f"(0 active spans) -> 0 words", file=sys.stderr)
                    continue

                time_map = build_compact_wav(wav, spans, compact)
                if not time_map or not (os.path.isfile(compact)
                                        and os.path.getsize(compact) > 0):
                    print(f"[transcribe] track {track['id']} ({label}) produced an "
                          f"empty compact wav -> 0 words", file=sys.stderr)
                    continue

                def on_progress(pct, _lo=extract_end, _w=band_w, _label=label, _i=i):
                    overall = _lo + (pct / 100.0) * (0.90 * _w)
                    emit_progress(overall, f"Transcribing {_label} ({_i + 1}/{n})...")

                out_prefix = os.path.join(_temp_dir, f"track{i}")
                json_path = run_whisper(whisper_bin, whisper_model, compact, out_prefix,
                                        language, on_progress)
                raw = parse_whisper_json(json_path)
                mapped = map_words(track, raw, time_map)
                if not mapped:
                    print(f"[transcribe] track {track['id']} ({label}) contributed 0 words",
                          file=sys.stderr)
                _warn_repetition_loops(track['id'], label, mapped)
                all_words.extend(mapped)
            finally:
                _safe_remove(wav)
                _safe_remove(compact)

        # words sorted by (track, fileStart). Track order = discovery order (t0, t1, ...).
        track_order = {t['id']: i for i, t in enumerate(tracks)}
        all_words.sort(key=lambda w: (track_order[w['track']], w['fileStart']))

        # (final 100% progress emitted after the atomic write below)
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
        emit_progress(100, 'Transcription complete')
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
