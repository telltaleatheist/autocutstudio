"""Splice a companion capture that was recorded in several parts back into one file.

WHY THIS EXISTS
---------------
A screen (or game) capture is normally one continuous file covering the whole
session, and everything downstream -- the GCC-PHAT offset measurement, the drift
retime map, the compound generators, the editor manifest -- assumes exactly that:
ONE asset, ONE offset, ONE retime map. When a recording is stopped and restarted
mid-session (dropped frames, a crash, a settings change) that assumption breaks
in a way no single offset can express, because the second part starts at an
arbitrary point hours into the session.

Rather than teach a dozen generators about multi-part sources, this module
restores the invariant: it rebuilds the parts into a single continuous file whose
timeline matches what a single uninterrupted recording would have produced, with
BLACK VIDEO AND SILENCE filling the wall-clock gap where nothing was recorded.
Downstream code then sees an ordinary one-file capture and needs no changes at
all.

THE GAP
-------
The filler's length is not a guess. For each seam it is

    gap = (reference time where part N+1's content BEGINS)
        - (reference time where part N's content ENDS)

with both terms measured by GCC-PHAT against a continuous reference recording
(the master mix, or any track spanning the whole session), using analysis windows
placed LOCALLY at the seam. Measuring locally matters: it means accumulated clock
drift over the preceding hours never enters the gap, so the retime map applied
downstream stays the only place drift is corrected.

WHEN THE AUDIO CANNOT ANSWER
----------------------------
A capture whose audio feed was lost records a full-length track of digital
silence, and GCC-PHAT has nothing to correlate. A part whose audio and video
streams differ in length is a second problem: its picture end can no longer be
derived as "where its audio sits, plus how long its video runs". In both cases
the seam falls back to PICTURE alignment (``core.video_align``) against the
master cropped to this source's quadrant.

Picture alignment prefers SCENE CHANGES over correlation. Correlation averages
over a window, so a shared screen that sits still matches equally well at many
offsets; measured on the 2026-08-05 session it spread over 4 frames, while
matching cut timestamps agreed to 0.55 frames across 48 pairs and landed within
0.54 frames of the audio ground truth on a session where both could be checked.
Correlation remains as a fallback for material with too few cuts. Either way the
result records which method produced it, and a hand-supplied gap overrides both.

WHY NOT STREAM-COPY
-------------------
Parts recorded after a settings change routinely differ in frame rate or H.264
level. Feeding those to ffmpeg's concat demuxer with ``-c copy`` does NOT fail --
it writes the second part's frames using the FIRST part's frame timing, so the
picture silently plays at the wrong speed and the video track ends up longer than
the audio. (Measured: a 10s 29.97fps part plus a 10s 60fps part produced a 40.1s
video track alongside a 20.1s audio track, exit status 0.) Every part is
therefore normalized to the first part's parameters, re-encoding only the parts
that actually differ.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

# Parameters that must agree across parts for a stream copy to be safe. Frame
# rate and level are the ones that actually differ in practice; the rest are
# here because a mismatch means the parts are not the same kind of recording at
# all and silently normalizing them would hide a mis-selected file.
_VIDEO_MATCH_KEYS = ('codec_name', 'width', 'height', 'pix_fmt', 'frame_rate', 'level')
_AUDIO_MATCH_KEYS = ('codec_name', 'sample_rate', 'channels')

# Search half-width for locating a continuation part around its expected start.
# The expected start comes from container creation_time, which mp4 stores with
# whole-second resolution, so two truncations bound the seed error at ~2s. 30s
# leaves generous margin while keeping >=50% window overlap (see locate_source).
SEAM_SEARCH_RADIUS = 30.0

# Analysis window length for seam measurement. Longer than the 150s default used
# for whole-file measurement is unnecessary; shorter risks a weak peak during a
# quiet passage.
SEAM_WINDOW_SECONDS = 150.0

# A part's video and audio streams should describe the same span of wall clock.
# When they disagree by more than this the recording is damaged (a muxer that
# gave up mid-write, or frames dropped without timestamp gaps) and the part's
# true content span is ambiguous -- which end of the discrepancy is real changes
# where the seam goes. One frame of slack absorbs ordinary rounding.
AV_DURATION_TOLERANCE = 1001.0 / 30000.0

_MERGE_SIDECAR_VERSION = 1


class VideoPartsError(RuntimeError):
    """Any refusal to produce a merged capture. Always names the file at fault."""


# ---------------------------------------------------------------------------
# Probing
# ---------------------------------------------------------------------------
def _ffprobe() -> str:
    from .audio_processor import AudioProcessor
    probe = getattr(AudioProcessor({}), 'ffprobe_path', None)
    if not probe:
        raise VideoPartsError("ffprobe could not be resolved")
    return str(probe)


def _ffmpeg() -> str:
    from .gcc_phat_align import _make_processor, _resolve_ffmpeg
    return _resolve_ffmpeg(_make_processor())


def _run_json(cmd: Sequence[str]) -> dict:
    proc = subprocess.run(list(cmd), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise VideoPartsError(
            f"ffprobe failed: {' '.join(cmd)}\n"
            f"{proc.stderr.decode('utf-8', 'replace')}")
    return json.loads(proc.stdout.decode('utf-8', 'replace'))


def _parse_rate(value: Optional[str]) -> Optional[Fraction]:
    """Parse an ffprobe rational ('30000/1001', '60/1'). None on 0/0 or absent."""
    if not value:
        return None
    try:
        frac = Fraction(value)
    except (ValueError, ZeroDivisionError):
        return None
    return frac if frac > 0 else None


def probe_media_params(path: str) -> dict:
    """Collect the stream parameters that decide copy-vs-re-encode.

    Returns a dict with a ``video`` sub-dict, an ``audio`` sub-dict (None when
    the file has no audio stream), the container duration, and creation_time.
    Raises rather than returning partial data: an unprobeable part cannot be
    merged, and guessing its parameters would corrupt the output silently.
    """
    p = Path(path)
    if not p.exists():
        raise VideoPartsError(f"capture part does not exist: {path}")

    info = _run_json([
        _ffprobe(), '-v', 'error', '-print_format', 'json',
        '-show_format', '-show_streams', str(p),
    ])

    video = None
    audio = None
    for stream in info.get('streams', []):
        kind = stream.get('codec_type')
        if kind == 'video' and video is None:
            rate = _parse_rate(stream.get('r_frame_rate'))
            if rate is None:
                raise VideoPartsError(
                    f"{p.name}: video stream reports no usable frame rate "
                    f"(r_frame_rate={stream.get('r_frame_rate')!r})")
            video = {
                'codec_name': stream.get('codec_name'),
                'profile': stream.get('profile'),
                'level': stream.get('level'),
                'width': stream.get('width'),
                'height': stream.get('height'),
                'pix_fmt': stream.get('pix_fmt'),
                'frame_rate': f"{rate.numerator}/{rate.denominator}",
                # The mp4 track timescale. The concat demuxer takes the output
                # stream's time base from its FIRST input and reinterprets every
                # later segment's timestamps in it, so segments whose timescales
                # disagree are silently mistimed (measured: a 90000-timescale
                # segment appended to a 29970-timescale one stretched the result
                # by exactly 90000/29970). Every generated segment is therefore
                # pinned to part 1's timescale.
                'time_base': stream.get('time_base'),
                'duration': _opt_float(stream.get('duration')),
                'nb_frames': _opt_int(stream.get('nb_frames')),
                'bit_rate': _opt_int(stream.get('bit_rate')),
            }
        elif kind == 'audio' and audio is None:
            audio = {
                'codec_name': stream.get('codec_name'),
                'sample_rate': _opt_int(stream.get('sample_rate')),
                'channels': stream.get('channels'),
                'duration': _opt_float(stream.get('duration')),
                'bit_rate': _opt_int(stream.get('bit_rate')),
            }

    if video is None:
        raise VideoPartsError(f"{p.name}: no video stream — not a capture file")

    fmt = info.get('format', {})
    return {
        'path': str(p),
        'name': p.name,
        'video': video,
        'audio': audio,
        'duration': _opt_float(fmt.get('duration')),
        'creation_time': (fmt.get('tags') or {}).get('creation_time'),
        'size': p.stat().st_size,
        'mtime': p.stat().st_mtime,
    }


def _opt_float(value) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _opt_int(value) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_creation_time(value: Optional[str]) -> Optional[datetime]:
    """Parse an mp4 ``creation_time`` tag to an aware datetime.

    mp4 stores this as whole seconds since 1904, so the value is TRUNCATED --
    never treat a difference of two creation times as accurate to better than
    about a second. It is used only to seed the GCC-PHAT search, never as the
    answer.
    """
    if not value:
        return None
    text = value.strip().replace('Z', '+00:00')
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def av_skew(params: dict) -> float:
    """How far a part's audio stream over- (+) or under-runs (-) its video."""
    audio = params.get('audio')
    if not audio or audio.get('duration') is None:
        return 0.0
    if params['video']['duration'] is None:
        return 0.0
    return audio['duration'] - params['video']['duration']


def content_span(params: dict, strict: bool = False) -> float:
    """The wall-clock span a part's PICTURE covers, in seconds.

    Always the VIDEO stream's duration: the seam is a picture-continuity problem,
    and black filler stands in for frames that were never recorded, so where the
    picture stops is what matters. A longer audio stream does not make that
    ambiguous -- the merged file's audio is rebuilt to the picture's length
    anyway (see :func:`_build_audio_track`).

    ``strict`` is for the one place where a mismatch DOES threaten correctness.
    A measured seam works out where a part's picture ends by taking the position
    its AUDIO was found at and adding this span. That step assumes the part's
    picture and sound stay in step with each other. A part whose streams differ
    in length is evidence the recorder lost data, and if it lost frames in the
    MIDDLE (rather than simply stopping early) the picture runs ahead of the
    sound and the derived end position is wrong. So a measured seam refuses;
    a manually supplied gap, which does not depend on this reasoning, does not.
    """
    video_dur = params['video']['duration']
    if video_dur is None:
        raise VideoPartsError(
            f"{params['name']}: video stream has no duration; cannot place the seam")

    delta = av_skew(params)
    if strict and abs(delta) > AV_DURATION_TOLERANCE:
        raise VideoPartsError(
            f"{params['name']}: its video stream is {video_dur:.3f}s but its "
            f"audio stream is {params['audio']['duration']:.3f}s "
            f"({delta:+.3f}s, {delta / AV_DURATION_TOLERANCE:+.1f} frames). The "
            f"recorder lost data. The seam after this part is worked out from "
            f"where its AUDIO sits plus how long its VIDEO runs, which is only "
            f"valid if the two stayed in step — and a part that lost frames "
            f"mid-recording has a picture that runs ahead of its sound. Check "
            f"whether this part's picture drifts, then supply this seam's gap "
            f"manually."
        )
    return video_dur


# ---------------------------------------------------------------------------
# Parameter comparison
# ---------------------------------------------------------------------------
def compare_params(target: dict, other: dict) -> List[str]:
    """Human-readable list of the parameters in which ``other`` differs from ``target``."""
    diffs = []
    for key in _VIDEO_MATCH_KEYS:
        a, b = target['video'].get(key), other['video'].get(key)
        if a != b:
            diffs.append(f"video {key}: {a!r} -> {b!r}")

    ta, oa = target.get('audio'), other.get('audio')
    if (ta is None) != (oa is None):
        diffs.append(f"audio stream: {'present' if ta else 'absent'} -> "
                     f"{'present' if oa else 'absent'}")
    elif ta and oa:
        for key in _AUDIO_MATCH_KEYS:
            if ta.get(key) != oa.get(key):
                diffs.append(f"audio {key}: {ta.get(key)!r} -> {oa.get(key)!r}")
    return diffs


# ---------------------------------------------------------------------------
# Seam measurement
# ---------------------------------------------------------------------------
@dataclass
class SeamMeasurement:
    """One seam: where the previous part's picture ends and the next one starts.

    ``gap_seconds`` is the measured quantity, NOT rounded to frames. Quantization
    happens once, in :func:`build_merged`, against the frame counts the encoder
    actually produced -- see the cumulative-position scheme there for why doing it
    here instead lets a rounding error survive into the timeline.
    """
    index: int                      # seam i sits between part i and part i+1
    gap_seconds: float
    source: str                     # 'measured' | 'manual'
    prev_end_reference: Optional[float] = None
    next_start_reference: Optional[float] = None
    seed_reference: Optional[float] = None
    confidence: Optional[float] = None
    spread_seconds: Optional[float] = None
    note: str = ''


def _locate_by_picture(part: dict, reference_path: str, expected_start: float,
                       source_type: Optional[str], at_end: bool, log) -> dict:
    """Locate a part on the reference by PICTURE, shaped like locate_source's result.

    Used when audio cannot answer: either the part's audio is silent (a lost
    feed) or its streams disagree in length, which makes "where its audio sits
    plus how long its video runs" an unsafe way to find where its picture ends.

    The measurement itself lives in :func:`core.video_align.locate_by_picture`,
    which the normal per-session alignment path also uses. This wrapper only
    supplies what is specific to a SEAM: the part's picture duration (its
    container's duration can disagree, which is often the very reason we are
    here) and the wider seam span.
    """
    from .video_align import (locate_by_picture, SEAM_SPAN_SECONDS,
                              VideoAlignError)
    try:
        return locate_by_picture(
            part['path'], reference_path, expected_start=expected_start,
            source_type=source_type, at_end=at_end,
            search_radius_seconds=SEAM_SEARCH_RADIUS,
            span_seconds=SEAM_SPAN_SECONDS,
            source_duration=content_span(part), log=log)
    except VideoAlignError as err:
        raise VideoPartsError(
            f"could not locate {part['name']} by picture either: {err} "
            f"Check first that the master actually covers this part and that "
            f"'{source_type}' names the right quadrant — a hand-supplied gap is "
            f"a last resort, because getting one right means accounting for how "
            f"far the previous part's picture has drifted by the time it reaches "
            f"the seam, which this measurement does for you.") from err


def measure_seams(
    parts: Sequence[dict],
    reference_path: str,
    manual_gaps: Optional[Sequence[Optional[float]]] = None,
    source_type: Optional[str] = None,
    log=lambda msg: print(msg, file=sys.stderr),
) -> List[SeamMeasurement]:
    """Measure (or accept) the filler length for every seam between ``parts``.

    ``parts`` are probe dicts from :func:`probe_media_params`, in recording
    order. ``manual_gaps`` is an optional list, one entry per seam, where a
    number is used verbatim and ``None`` means "measure this one".

    Every measured seam is anchored LOCALLY: the previous part's end offset is
    measured with windows at the END of that part, and the next part's start
    offset with windows at its BEGINNING. Drift accumulated earlier in the
    session therefore never lands in the gap.
    """
    from .gcc_phat_align import (locate_source, CONFIDENCE_THRESHOLD,
                                 FRAME_SECONDS, SilentAudioError)

    if len(parts) < 2:
        return []

    seam_count = len(parts) - 1
    if manual_gaps is not None and len(manual_gaps) != seam_count:
        raise VideoPartsError(
            f"{len(parts)} parts have {seam_count} seam(s) but "
            f"{len(manual_gaps)} manual gap(s) were supplied")

    target_rate = Fraction(parts[0]['video']['frame_rate'])
    seams: List[SeamMeasurement] = []

    # Where part 0's content sits on the reference. Everything else is chained
    # from here, so it is measured with its own windows rather than assumed 0.
    prev_start_ref: Optional[float] = None

    for i in range(seam_count):
        prev, nxt = parts[i], parts[i + 1]
        manual = None if manual_gaps is None else manual_gaps[i]

        if manual is not None:
            gap_raw = float(manual)
            if gap_raw < 0:
                raise VideoPartsError(
                    f"manual gap for the seam after {prev['name']} is negative "
                    f"({gap_raw}s); parts cannot overlap in a spliced file")
            log(f"  seam {i + 1}: gap {gap_raw:.4f}s (manual, "
                f"~{gap_raw * float(target_rate):.1f} frames @ {target_rate})")
            seams.append(SeamMeasurement(
                index=i, gap_seconds=gap_raw, source='manual',
                note='supplied by the user; not measured'))
            prev_start_ref = None      # chain is broken; re-seed below
            continue

        # --- where the previous part's picture ends -------------------------
        prev_span = content_span(prev)
        prev_guess = prev_start_ref if prev_start_ref is not None else 0.0
        skew = av_skew(prev)
        if abs(skew) > AV_DURATION_TOLERANCE:
            # Its streams disagree, so the audio's position plus the video's
            # length is not a safe way to find where the picture stops. Ask the
            # picture directly, with the windows at this part's end.
            log(f"    {prev['name']}: audio runs {skew:+.3f}s against its video, "
                f"so the seam is measured from the picture instead")
            prev_fix = _locate_by_picture(prev, reference_path, prev_guess,
                                          source_type, at_end=True, log=log)
        else:
            try:
                prev_fix = locate_source(
                    prev['path'], reference_path, expected_start=prev_guess,
                    search_radius_seconds=SEAM_SEARCH_RADIUS,
                    window_seconds=SEAM_WINDOW_SECONDS,
                    # Windows at the END of the part: the seam is what we care
                    # about, so the offset is measured where the seam actually is.
                    probe_fractions=(0.80, 0.90, 0.97),
                )
            except SilentAudioError as err:
                log(f"    {prev['name']} has no audio to align with ({err}); "
                    f"falling back to picture alignment")
                prev_fix = _locate_by_picture(prev, reference_path, prev_guess,
                                              source_type, at_end=True, log=log)

        prev_end_ref = prev_span + prev_fix['start_seconds']

        # --- seed the next part's search from container creation times -------
        prev_created = parse_creation_time(prev.get('creation_time'))
        next_created = parse_creation_time(nxt.get('creation_time'))
        if prev_created is None or next_created is None:
            raise VideoPartsError(
                f"cannot seed the search for {nxt['name']}: "
                f"{'previous part' if prev_created is None else nxt['name']} has no "
                f"usable container creation_time, and without it there is no way to "
                f"guess where this part begins. Supply this seam's gap manually.")
        seed = prev_fix['start_seconds'] + (next_created - prev_created).total_seconds()

        by_picture = 'method' in prev_fix
        try:
            next_fix = locate_source(
                nxt['path'], reference_path,
                expected_start=seed,
                search_radius_seconds=SEAM_SEARCH_RADIUS,
                window_seconds=SEAM_WINDOW_SECONDS,
                probe_fractions=(0.03, 0.20, 0.40),
            )
        except SilentAudioError as err:
            # A capture whose audio feed was lost still records a full-length
            # empty track. Its picture is intact, so align on that instead.
            log(f"    {nxt['name']} has no audio to align with ({err}); "
                f"falling back to picture alignment")
            next_fix = _locate_by_picture(nxt, reference_path, seed, source_type,
                                          at_end=False, log=log)
            by_picture = True

        confidence = min(prev_fix['confidence'], next_fix['confidence'])
        spread = max(prev_fix['spread_seconds'], next_fix['spread_seconds'])

        # Picture alignment is quantized to whole frames and is inherently
        # noisier than GCC-PHAT, so it is held to its own thresholds rather than
        # the audio ones it would always fail.
        if by_picture:
            from .video_align import VIDEO_CONFIDENCE_THRESHOLD
            conf_floor, spread_ceiling = VIDEO_CONFIDENCE_THRESHOLD, 3 * FRAME_SECONDS
            method = 'picture'
        else:
            conf_floor, spread_ceiling = CONFIDENCE_THRESHOLD, FRAME_SECONDS
            method = 'audio'

        if confidence < conf_floor:
            raise VideoPartsError(
                f"seam after {prev['name']} measured at only {confidence:.2f} "
                f"confidence by {method} (threshold {conf_floor}). A wrong gap "
                f"desyncs everything after it, so this is not applied. Verify the "
                f"reference recording covers this seam, or supply the gap manually.")
        if spread > spread_ceiling:
            raise VideoPartsError(
                f"seam after {prev['name']} is inconsistent across {method} "
                f"analysis windows (spread {spread * 1000:.0f}ms > "
                f"{spread_ceiling * 1000:.0f}ms). Supply the gap manually after "
                f"checking where the parts actually sit.")

        gap_raw = next_fix['start_seconds'] - prev_end_ref
        if gap_raw < 0:
            raise VideoPartsError(
                f"{nxt['name']} appears to START {abs(gap_raw):.3f}s BEFORE "
                f"{prev['name']} ends. Parts cannot overlap in a spliced file — "
                f"check that the parts are listed in recording order.")

        log(f"  seam {i + 1}: {prev['name']} ends at {prev_end_ref:.4f}s, "
            f"{nxt['name']} starts at {next_fix['start_seconds']:.4f}s")
        log(f"            gap {gap_raw:.4f}s (~{gap_raw * float(target_rate):.1f} "
            f"frames @ {target_rate}, conf {confidence:.2f}, "
            f"spread {spread * 1000:.0f}ms, seed off by "
            f"{next_fix['start_seconds'] - seed:+.3f}s)")

        seams.append(SeamMeasurement(
            index=i, gap_seconds=gap_raw, source=f'measured ({method})',
            prev_end_reference=prev_end_ref,
            next_start_reference=next_fix['start_seconds'],
            seed_reference=seed, confidence=confidence, spread_seconds=spread))
        prev_start_ref = next_fix['start_seconds']

    return seams


# ---------------------------------------------------------------------------
# Merge plan
# ---------------------------------------------------------------------------
@dataclass
class MergePlan:
    parts: List[dict]
    seams: List[SeamMeasurement]
    output_path: str
    target: dict
    reencode: List[bool]
    encoder: str
    encoder_args: List[str] = field(default_factory=list)

    @property
    def total_duration(self) -> float:
        return (sum(content_span(p) for p in self.parts)
                + sum(s.gap_seconds for s in self.seams))


def merged_output_path(primary: str) -> str:
    """Where the spliced file goes: alongside the parts, name derived from part 1.

    ``2026-08-05 screen capture 1.mp4`` -> ``2026-08-05 screen capture merged.mp4``.
    A trailing part number is stripped so the name describes the whole recording
    rather than its first piece.
    """
    p = Path(primary)
    stem = p.stem.rstrip()
    trimmed = stem
    while trimmed and trimmed[-1].isdigit():
        trimmed = trimmed[:-1]
    trimmed = trimmed.rstrip(' _-')
    if trimmed and trimmed != stem:
        stem = trimmed
    return str(p.with_name(f"{stem} merged{p.suffix}"))


# Headroom over a re-encoded part's own bitrate. This is a lossy-to-lossy
# transcode, so spending more bits than the source used keeps the re-encode from
# being the quality bottleneck -- screen captures are full of text, which is
# where generation loss shows first.
REENCODE_BITRATE_FACTOR = 2.0
_MIN_REENCODE_BITRATE = 12_000_000


def choose_encoder() -> Tuple[str, List[str]]:
    """Pick the H.264 encoder used for parts that must be re-encoded.

    Prefers Apple's hardware encoder because a continuation part can be an hour
    of 1080p and software encoding would dominate the run's wall clock; falls
    back to libx264 at a visually-lossless CRF. The choice is returned (and
    logged, and recorded in the sidecar) rather than made silently, because it
    changes the output.

    Note the returned args carry no bitrate: VideoToolbox is a bitrate-targeted
    encoder and the right target depends on the PART being encoded, not on part
    1 (see :func:`_bitrate_args`).
    """
    encoders = subprocess.run([_ffmpeg(), '-v', 'error', '-encoders'],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    available = encoders.stdout.decode('utf-8', 'replace')
    if 'h264_videotoolbox' in available:
        return 'h264_videotoolbox', ['-profile:v', 'high']
    return 'libx264', ['-crf', '18', '-preset', 'veryfast', '-profile:v', 'high']


def _bitrate_args(plan: "MergePlan", part: Optional[dict]) -> List[str]:
    """Bitrate target for a VideoToolbox encode, scaled off the part's own rate.

    Deriving it from part 1 instead would re-encode a modest continuation part at
    part 1's (possibly much higher) rate and inflate the result several-fold.
    CRF-based encoders need no target at all.
    """
    if plan.encoder != 'h264_videotoolbox':
        return []
    source_rate = (part or {}).get('video', {}).get('bit_rate') or 0
    target = (int(source_rate * REENCODE_BITRATE_FACTOR) if source_rate
              else _MIN_REENCODE_BITRATE)
    return ['-b:v', str(max(target, _MIN_REENCODE_BITRATE))]


def plan_merge(
    part_paths: Sequence[str],
    reference_path: str,
    manual_gaps: Optional[Sequence[Optional[float]]] = None,
    output_path: Optional[str] = None,
    source_type: Optional[str] = None,
    log=lambda msg: print(msg, file=sys.stderr),
) -> MergePlan:
    """Probe every part, measure every seam, and decide what has to be re-encoded."""
    if len(part_paths) < 2:
        raise VideoPartsError(
            f"a merge needs at least two parts, got {len(part_paths)}")

    log(f"\n▶ Splicing {len(part_paths)} capture parts into one continuous file")
    parts = [probe_media_params(p) for p in part_paths]
    for idx, p in enumerate(parts, 1):
        v = p['video']
        a = p['audio']
        log(f"  part {idx}: {p['name']}")
        log(f"           {v['width']}x{v['height']} {v['codec_name']} "
            f"{v['frame_rate']}fps level {v['level']} — video {v['duration']:.3f}s"
            + (f", audio {a['duration']:.3f}s ({a['codec_name']} "
               f"{a['sample_rate']}Hz x{a['channels']})" if a else ", no audio stream"))

    target = parts[0]
    reencode = [False]
    for part in parts[1:]:
        diffs = compare_params(target, part)
        if diffs:
            log(f"  {part['name']} differs from {target['name']}: "
                + "; ".join(diffs))
            if (part['video']['width'] != target['video']['width']
                    or part['video']['height'] != target['video']['height']):
                raise VideoPartsError(
                    f"{part['name']} is {part['video']['width']}x"
                    f"{part['video']['height']} but {target['name']} is "
                    f"{target['video']['width']}x{target['video']['height']}. "
                    f"Rescaling a capture changes what the picture looks like; "
                    f"that is not a decision this step will make for you.")
            log(f"    -> will be re-encoded to match part 1")
        reencode.append(bool(diffs))

    seams = measure_seams(parts, reference_path, manual_gaps=manual_gaps,
                          source_type=source_type, log=log)
    encoder, encoder_args = choose_encoder()
    if any(reencode):
        log(f"  re-encoding {sum(reencode)} part(s) with {encoder} "
            f"{' '.join(encoder_args)}")

    return MergePlan(
        parts=parts, seams=seams,
        output_path=output_path or merged_output_path(parts[0]['path']),
        target=target, reencode=reencode,
        encoder=encoder, encoder_args=encoder_args)


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------
def _sidecar_path(output_path: str) -> Path:
    return Path(output_path).with_suffix(Path(output_path).suffix + '.merge.json')


def _cache_key(plan: MergePlan) -> dict:
    return {
        'version': _MERGE_SIDECAR_VERSION,
        'parts': [{'path': p['path'], 'size': p['size'], 'mtime': p['mtime']}
                  for p in plan.parts],
        'gaps': [s.gap_seconds for s in plan.seams],
        'encoder': plan.encoder,
        'encoder_args': plan.encoder_args,
    }


# How close two gaps must be to count as the same splice. A thousandth of a
# frame cannot change a single output frame -- the gap is quantized to whole
# frames at build time -- but it is enormous next to floating-point noise. A
# MEASURED gap is re-derived on every run, and comparing it bit-for-bit meant one
# last-place difference silently triggered a 19-minute, 30 GB rebuild.
_GAP_CACHE_TOLERANCE_FRAMES = 0.001


def cached_merge(plan: MergePlan) -> Optional[str]:
    """Return the existing merged file when it was built from this same plan.

    A spliced capture runs to tens of gigabytes, so rebuilding it on every run
    would dominate the session. The sidecar records the inputs' sizes and mtimes
    along with the gaps that were applied; any real difference rebuilds.
    """
    out = Path(plan.output_path)
    sidecar = _sidecar_path(plan.output_path)
    if not out.exists() or not sidecar.exists():
        return None
    try:
        stored = json.loads(sidecar.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    stored_key = stored.get('key')
    if not isinstance(stored_key, dict):
        return None
    key = _cache_key(plan)

    # Everything except the gaps has to match exactly.
    if {k: v for k, v in stored_key.items() if k != 'gaps'} != \
            {k: v for k, v in key.items() if k != 'gaps'}:
        return None

    stored_gaps = stored_key.get('gaps')
    if not isinstance(stored_gaps, list) or len(stored_gaps) != len(key['gaps']):
        return None
    tolerance = _GAP_CACHE_TOLERANCE_FRAMES / float(
        Fraction(plan.target['video']['frame_rate']))
    for stored_gap, gap in zip(stored_gaps, key['gaps']):
        try:
            if abs(float(stored_gap) - float(gap)) > tolerance:
                return None
        except (TypeError, ValueError):
            return None

    if stored.get('output_size') != out.stat().st_size:
        return None
    return str(out)


def _write_sidecar(plan: MergePlan, output_path: str, notes: List[str],
                   part_frames: List[int], gap_frames: List[int]) -> None:
    """Record how the spliced file was actually built.

    Keeps both the measured seconds and the frame counts that were realized, so a
    later question about where a seam ended up can be answered from the file
    rather than by re-measuring.
    """
    seams = []
    for seam, frames in zip(plan.seams, gap_frames):
        entry = asdict(seam)
        entry['realized_frames'] = frames
        seams.append(entry)
    payload = {
        'key': _cache_key(plan),
        'output_size': Path(output_path).stat().st_size,
        'built_at': datetime.now(timezone.utc).isoformat(),
        'seams': seams,
        'part_frames': part_frames,
        'target': plan.target['video'],
        'notes': notes,
    }
    _sidecar_path(output_path).write_text(json.dumps(payload, indent=2))


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
def _run_ffmpeg(cmd: Sequence[str], what: str,
                total_seconds: Optional[float] = None,
                progress=None, log=lambda m: None) -> None:
    """Run ffmpeg, streaming -progress output to ``progress(fraction, what)``."""
    full = list(cmd)
    if total_seconds and progress:
        full = full[:1] + ['-progress', 'pipe:1', '-nostats'] + full[1:]

    proc = subprocess.Popen(full, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, bufsize=1)
    if total_seconds and progress:
        for line in proc.stdout:
            if line.startswith('out_time_ms='):
                try:
                    done = int(line.split('=', 1)[1]) / 1_000_000.0
                except ValueError:
                    continue
                progress(min(1.0, done / total_seconds), what)
    stderr = proc.communicate()[1]
    if proc.returncode != 0:
        raise VideoPartsError(
            f"{what} failed (ffmpeg exit {proc.returncode}):\n{stderr[-4000:]}")


def _segment_streams(plan: MergePlan, part: dict,
                     out_path: Path, progress, log) -> None:
    """Re-encode one part to the target video parameters, keeping all its content.

    The output length is deliberately NOT constrained here. Neither ``-t`` (which
    the fps filter and the muxer round independently -- it put a seam 1.5 frames
    late) nor ``-frames:v`` (a ceiling, not a guarantee -- it yielded 899 frames
    where 900 were requested) can pin it reliably, so the caller probes what was
    actually produced and sizes the following filler to match.

    The segment's audio is discarded during the final mux (see
    :func:`_build_audio_track`); it exists only so every segment presents the
    same stream layout to the concat demuxer, which requires that.
    """
    target_v = plan.target['video']
    target_a = plan.target['audio']
    cmd = [_ffmpeg(), '-v', 'error', '-nostdin', '-y', '-i', part['path']]

    maps = ['-map', '0:v:0']
    if target_a:
        if part.get('audio'):
            maps += ['-map', '0:a:0']
        else:
            cmd += ['-f', 'lavfi', '-i',
                    f"anullsrc=channel_layout={_layout(target_a['channels'])}:"
                    f"sample_rate={target_a['sample_rate']}"]
            maps += ['-map', '1:a:0']
            log(f"    {part['name']} has no audio stream — filling with silence")

    cmd += maps
    cmd += ['-vf', f"fps={target_v['frame_rate']}"]
    cmd += ['-c:v', plan.encoder] + plan.encoder_args + _bitrate_args(plan, part)
    cmd += ['-pix_fmt', target_v['pix_fmt']]
    if target_a:
        cmd += ['-c:a', 'aac', '-ar', str(target_a['sample_rate']),
                '-ac', str(target_a['channels']), '-b:a', '192k']
    cmd += ['-video_track_timescale', str(target_timescale(plan.target)),
            str(out_path)]

    _run_ffmpeg(cmd, f"re-encode {part['name']}",
                total_seconds=part['video']['duration'],
                progress=progress, log=log)


def _segment_filler(plan: MergePlan, frames: int, out_path: Path,
                    progress, log) -> None:
    """Render exactly ``frames`` frames of black video at the target parameters."""
    target_v = plan.target['video']
    target_a = plan.target['audio']
    cmd = [_ffmpeg(), '-v', 'error', '-nostdin', '-y',
           '-f', 'lavfi', '-i',
           f"color=c=black:s={target_v['width']}x{target_v['height']}:"
           f"r={target_v['frame_rate']}"]
    if target_a:
        cmd += ['-f', 'lavfi', '-i',
                f"anullsrc=channel_layout={_layout(target_a['channels'])}:"
                f"sample_rate={target_a['sample_rate']}"]
    cmd += ['-c:v', plan.encoder] + plan.encoder_args + _bitrate_args(plan, None)
    cmd += ['-pix_fmt', target_v['pix_fmt']]
    if target_a:
        cmd += ['-c:a', 'aac', '-ar', str(target_a['sample_rate']),
                '-ac', str(target_a['channels']), '-b:a', '192k']
    cmd += ['-frames:v', str(frames),
            '-video_track_timescale', str(target_timescale(plan.target)),
            str(out_path)]
    _run_ffmpeg(cmd, f"render {frames} frames of black filler", log=log)


def _build_audio_track(plan: MergePlan, pieces: List[int], out_path: Path,
                       progress, log) -> None:
    """Render the spliced capture's audio as ONE continuous encode.

    Concatenating pre-encoded AAC segments cannot be made sample-exact -- every
    segment carries encoder priming and its own padding, and the error lands at
    each seam as picture/sound desync. Building the whole track in a single
    filtergraph instead makes each piece's length an exact sample count derived
    from the same frame counts the video uses, so the audio cannot drift away
    from the picture no matter how many parts there are.
    """
    target_a = plan.target['audio']
    if not target_a:
        return
    rate = Fraction(plan.target['video']['frame_rate'])
    sr = int(target_a['sample_rate'])
    layout = _layout(target_a['channels'])

    def samples_for(frames: int) -> int:
        return int(round(frames * sr / rate))

    cmd = [_ffmpeg(), '-v', 'error', '-nostdin', '-y']
    graph: List[str] = []
    labels: List[str] = []
    input_index = 0

    # `pieces` interleaves parts and fillers: part 0, gap 0, part 1, gap 1, ...
    # so even positions are parts and odd positions are silence.
    for position, frames in enumerate(pieces):
        want = samples_for(frames)
        label = f"p{position}"
        part = plan.parts[position // 2] if position % 2 == 0 else None

        if part is not None and part.get('audio'):
            cmd += ['-i', part['path']]
            # apad guarantees there is at least `want` of it; atrim cuts to
            # exactly `want`. A part whose audio ran short (a muxer that gave up)
            # is completed with silence rather than pulling the next part early.
            graph.append(
                f"[{input_index}:a]aresample={sr},aformat=channel_layouts={layout},"
                f"apad,atrim=end_sample={want},asetpts=N/SR/TB[{label}]")
            input_index += 1
        else:
            graph.append(
                f"anullsrc=r={sr}:cl={layout},atrim=end_sample={want},"
                f"asetpts=N/SR/TB[{label}]")
        labels.append(label)

    graph.append(''.join(f"[{l}]" for l in labels)
                 + f"concat=n={len(labels)}:v=0:a=1[aout]")
    cmd += ['-filter_complex', ';'.join(graph), '-map', '[aout]',
            '-c:a', 'aac', '-ar', str(sr), '-ac', str(target_a['channels']),
            '-b:a', '192k', str(out_path)]

    _run_ffmpeg(cmd, 'render spliced audio track',
                total_seconds=sum(pieces) / float(rate),
                progress=progress, log=log)


def _layout(channels: Optional[int]) -> str:
    return {1: 'mono', 2: 'stereo', 6: '5.1'}.get(channels or 2, 'stereo')


def target_timescale(target: dict) -> int:
    """The mp4 video timescale every generated segment must use.

    It is part 1's, because part 1 is normally stream-copied and so keeps
    whatever timescale it already had, and the concat demuxer imposes the first
    segment's time base on all the others. A timescale that cannot express the
    target frame duration as a whole number of ticks would put every frame on a
    rounded timestamp, so that case raises rather than accumulating error.
    """
    time_base = target['video'].get('time_base')
    if not time_base:
        raise VideoPartsError(
            f"{target['name']}: video stream reports no time_base, so generated "
            f"segments cannot be matched to it")
    try:
        scale = Fraction(time_base)
    except (ValueError, ZeroDivisionError) as err:
        raise VideoPartsError(
            f"{target['name']}: unparseable video time_base {time_base!r}") from err
    if scale.numerator != 1:
        raise VideoPartsError(
            f"{target['name']}: unexpected video time_base {time_base!r} "
            f"(expected 1/N)")
    ticks = scale.denominator
    frame_ticks = Fraction(ticks, 1) / Fraction(target['video']['frame_rate'])
    if frame_ticks.denominator != 1:
        raise VideoPartsError(
            f"{target['name']}: a frame at {target['video']['frame_rate']}fps is "
            f"{float(frame_ticks):.4f} ticks in its own 1/{ticks} timescale, which "
            f"is not a whole number. Every spliced frame would sit on a rounded "
            f"timestamp; refusing to build on that basis.")
    return ticks


def _verify_seam_continuity(plan: MergePlan, part_frames: List[int],
                            gap_frames: List[int], rate: Fraction,
                            work: Path, log) -> None:
    """Check that each seam's frames are ONE frame apart in the output.

    The total-length check catches a hole that changes the overall duration. This
    catches one that does not -- a segment that lost time where another gained
    it -- by looking at the only place a splice can go wrong: the boundary. Reads
    a couple of seconds of packet headers per seam, so it costs nothing even on a
    30 GB file.
    """
    frame = 1.0 / float(rate)
    window = 4.0
    position = 0
    for i in range(len(plan.seams)):
        position += part_frames[i]
        boundary = position * frame            # where the filler should start
        lo, hi = max(0.0, boundary - window), boundary + window
        # An ABSOLUTE end, not `%+duration`: ffprobe applies a duration from
        # wherever its seek actually landed (the preceding keyframe, which on a
        # short file is the very start), so `%+8` can return a window that never
        # reaches the seam at all.
        cmd = [_ffprobe(), '-v', 'error', '-select_streams', 'v:0',
               '-show_entries', 'packet=pts_time', '-of', 'csv=p=0',
               '-read_intervals', f'{lo:.6f}%{hi:.6f}', plan.output_path]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if proc.returncode != 0:
            raise VideoPartsError(
                f"could not read packet timestamps around seam {i + 1}: "
                f"{proc.stderr.decode('utf-8', 'replace')[-2000:]}")
        times = sorted(float(t) for t in
                       proc.stdout.decode('utf-8', 'replace').split()
                       if t.strip())
        if len(times) < 2:
            raise VideoPartsError(
                f"seam {i + 1} near {boundary:.4f}s returned {len(times)} frame "
                f"timestamp(s); the splice cannot be verified")

        # Look for the largest step between consecutive frames rather than
        # checking a specific frame index. The output's first frame does not
        # necessarily sit at t=0 (an edit list can offset the whole track), so
        # "frame N is at N/rate" is not safe to assume -- but "no two adjacent
        # frames are more than one frame apart" holds regardless of any offset.
        worst, at = 0.0, times[0]
        for a, b in zip(times, times[1:]):
            if b - a > worst:
                worst, at = b - a, a
        if worst > 1.5 * frame:
            raise VideoPartsError(
                f"seam {i + 1}: frames either side of {at:.6f}s are "
                f"{worst:.6f}s apart, where one frame ({frame:.6f}s) belongs — "
                f"{(worst - frame) * float(rate):+.1f} frames of dead timeline "
                f"sit at this seam, displacing everything after it. Segments are "
                f"left in {work} for inspection.")
        log(f"  ✓ seam {i + 1} continuous near {boundary:.4f}s "
            f"(largest step {worst * float(rate):.2f} frames across "
            f"{len(times)} frames)")
        position += gap_frames[i]


def build_merged(
    plan: MergePlan,
    reuse_cache: bool = True,
    progress=None,
    log=lambda msg: print(msg, file=sys.stderr),
) -> str:
    """Render the spliced capture described by ``plan`` and return its path.

    Every part is first brought to the target parameters and to a length equal to
    its own picture duration; black filler is rendered for each seam; the pieces
    are concatenated. The result's duration is then checked against the plan and
    a mismatch raises -- a spliced file that came out the wrong length has
    everything after the seam in the wrong place, which is exactly the failure
    this module exists to prevent.
    """
    if reuse_cache:
        hit = cached_merge(plan)
        if hit:
            log(f"  ✓ reusing existing spliced capture: {Path(hit).name}")
            return hit

    notes: List[str] = []
    spans: List[float] = []
    for part in plan.parts:
        spans.append(content_span(part))
        skew = av_skew(part)
        if abs(skew) > AV_DURATION_TOLERANCE:
            # Not fatal here: the picture's length is unambiguous and the audio
            # is rebuilt to match it. But it means the recorder lost data, which
            # is worth knowing about, so it is logged and kept in the sidecar.
            note = (f"{part['name']}: audio stream runs {skew:+.3f}s "
                    f"({skew / AV_DURATION_TOLERANCE:+.1f} frames) against its "
                    f"video; the recorder lost data. Spliced to the picture's "
                    f"length ({spans[-1]:.3f}s) with the audio rebuilt to match.")
            log(f"  ⚠️  {note}")
            notes.append(note)

    rate = Fraction(plan.target['video']['frame_rate'])
    work = Path(plan.output_path).with_suffix('.parts')
    work.mkdir(parents=True, exist_ok=True)
    audio_track = work / 'audio.m4a'
    segments: List[Path] = []

    try:
        # --- 1. materialize each part and learn how many frames it REALLY has --
        # A rate conversion does not produce a predictable frame count: 30.014s of
        # 60fps content becomes 899 frames at 29.97, not the 900 that rounding
        # the duration suggests, and -frames:v is a ceiling rather than a
        # guarantee. So the parts are built first and then measured.
        part_segments: List[Path] = []
        part_frames: List[int] = []
        for i, part in enumerate(plan.parts):
            if not plan.reencode[i] and part['video']['nb_frames']:
                # A copied part contributes its own frames verbatim, so its frame
                # count and its declared duration have to agree -- they are the
                # two halves of where the next part starts.
                declared = part['video']['nb_frames'] / float(rate)
                if abs(declared - spans[i]) > AV_DURATION_TOLERANCE:
                    raise VideoPartsError(
                        f"{part['name']} declares {spans[i]:.4f}s of video but "
                        f"holds {part['video']['nb_frames']} frames "
                        f"({declared:.4f}s at {rate}fps). Its container is "
                        f"inconsistent, so the seam after it cannot be placed.")
                log(f"  part {i + 1} ({part['name']}): copied as-is "
                    f"({part['video']['nb_frames']} frames)")
                part_segments.append(Path(part['path']))
                part_frames.append(int(part['video']['nb_frames']))
                continue
            seg = work / f"part{i + 1:02d}.mp4"
            log(f"  part {i + 1} ({part['name']}): normalizing -> {seg.name}")
            _segment_streams(plan, part, seg, progress, log)
            built = probe_media_params(str(seg))
            if not built['video']['nb_frames']:
                raise VideoPartsError(
                    f"{seg} reports no frame count after re-encoding; cannot place "
                    f"the seam that follows it")
            part_segments.append(seg)
            part_frames.append(int(built['video']['nb_frames']))
            log(f"           -> {part_frames[-1]} frames "
                f"({part_frames[-1] / float(rate):.3f}s)")

        # --- 2. turn measured seconds into frame counts, ONCE ------------------
        # Each part's target start is fixed by the measured geometry, quantized
        # from the cumulative position rather than by rounding each gap on its
        # own. The filler then absorbs whatever the encoder actually produced, so
        # a part that came out a frame short cannot shift everything after it.
        starts: List[int] = [0]
        cumulative = 0.0
        for i, seam in enumerate(plan.seams):
            cumulative += spans[i] + seam.gap_seconds
            starts.append(int(round(cumulative * float(rate))))

        gap_frames: List[int] = []
        for i, seam in enumerate(plan.seams):
            frames = starts[i + 1] - starts[i] - part_frames[i]
            if frames < 0:
                raise VideoPartsError(
                    f"seam {i + 1} needs {frames} frames of filler: "
                    f"{plan.parts[i]['name']} produced {part_frames[i]} frames, "
                    f"which already overruns where {plan.parts[i + 1]['name']} was "
                    f"measured to start ({seam.gap_seconds:.4f}s gap). The parts "
                    f"overlap; check they are in recording order and that the gap "
                    f"is right.")
            gap_frames.append(frames)

        # --- 3. render the fillers and interleave ------------------------------
        pieces: List[int] = []
        for i, seg in enumerate(part_segments):
            segments.append(seg)
            pieces.append(part_frames[i])
            if i < len(plan.seams):
                filler = work / f"gap{i + 1:02d}.mp4"
                log(f"  seam {i + 1}: rendering {gap_frames[i]} black frames "
                    f"({gap_frames[i] / float(rate):.4f}s, measured "
                    f"{plan.seams[i].gap_seconds:.4f}s) -> {filler.name}")
                _segment_filler(plan, gap_frames[i], filler, progress, log)
                built = probe_media_params(str(filler))
                if int(built['video']['nb_frames'] or 0) != gap_frames[i]:
                    raise VideoPartsError(
                        f"black filler for seam {i + 1} came out "
                        f"{built['video']['nb_frames']} frames, not {gap_frames[i]}")
                segments.append(filler)
                pieces.append(gap_frames[i])

        total_frames = sum(pieces)
        expected = total_frames / float(rate)

        if plan.target['audio']:
            log(f"  rendering the spliced audio track in one pass")
            _build_audio_track(plan, pieces, audio_track, progress, log)

        # Every entry carries an explicit `duration`, taken from the frame count
        # that segment actually holds.
        #
        # WITHOUT it, the concat demuxer advances the output timeline by each
        # input's CONTAINER duration -- and a container's duration is its LONGEST
        # stream. A part whose audio outran its video (a recorder that lost
        # picture data) therefore pushes everything after it later by exactly that
        # overhang, opening a hole in the video timeline at the seam. Measured on
        # the 2026-08-05 session: part 1's audio ran 2.5353s past its picture, and
        # the first black filler frame landed at 11597.9306s instead of
        # 11595.3954s -- 76 frames of silent, invisible desync for the whole rest
        # of the capture. Every frame was present and correct; only their
        # timestamps were wrong, which is why the frame-count check below passed.
        listing = work / 'concat.txt'
        listing.write_text(''.join(
            "file '{}'\nduration {:.6f}\n".format(
                str(s.resolve()).replace("'", "'\\''"),
                frames / float(rate))
            for s, frames in zip(segments, pieces)))

        log(f"  concatenating {len(segments)} segments -> "
            f"{Path(plan.output_path).name}")
        # Picture comes from the concatenated segments; sound comes from the
        # single continuous encode. The segments' own audio is discarded -- it
        # exists only to keep their stream layouts identical for the demuxer.
        cmd = [_ffmpeg(), '-v', 'error', '-nostdin', '-y',
               '-f', 'concat', '-safe', '0', '-i', str(listing)]
        if plan.target['audio']:
            cmd += ['-i', str(audio_track), '-map', '0:v:0', '-map', '1:a:0']
        else:
            cmd += ['-map', '0:v:0']
        cmd += ['-c', 'copy', '-movflags', '+faststart', plan.output_path]
        _run_ffmpeg(cmd, 'concatenate spliced capture', total_seconds=expected,
                    progress=progress, log=log)

        result = probe_media_params(plan.output_path)
        actual_v = result['video']['duration']
        actual_frames = result['video']['nb_frames']
        if actual_frames != total_frames:
            raise VideoPartsError(
                f"spliced capture has {actual_frames} frames but the plan says "
                f"{total_frames}. Everything after the first seam would be in the "
                f"wrong place, so the result is not usable. Segments are left in "
                f"{work} for inspection.")
        # Counting frames is NOT enough. A concat can deliver every frame and
        # still space them wrongly -- which is exactly what happened before the
        # `duration` directives above were added, and it is invisible to a count.
        # The video's declared length must agree with the frames it holds.
        if abs(actual_v - expected) > AV_DURATION_TOLERANCE:
            raise VideoPartsError(
                f"spliced capture holds the right {actual_frames} frames but its "
                f"video runs {actual_v:.4f}s, where {actual_frames} frames at "
                f"{rate}fps are {expected:.4f}s "
                f"({(actual_v - expected) / float(AV_DURATION_TOLERANCE):+.1f} "
                f"frames of slack). The frames are spaced wrongly, so everything "
                f"after a seam is displaced even though nothing is missing. "
                f"Segments are left in {work} for inspection.")
        _verify_seam_continuity(plan, part_frames, gap_frames, rate, work, log)
        if result.get('audio') and result['audio'].get('duration') is not None:
            skew = result['audio']['duration'] - expected
            if abs(skew) > AV_DURATION_TOLERANCE:
                raise VideoPartsError(
                    f"spliced capture's audio is {skew:+.4f}s off its picture "
                    f"({skew / AV_DURATION_TOLERANCE:+.2f} frames), which would "
                    f"desync the whole capture once it is aligned by that audio. "
                    f"Segments are left in {work} for inspection.")

        log(f"  ✓ spliced capture: {Path(plan.output_path).name} "
            f"({actual_v:.3f}s, {actual_frames} frames, "
            f"{result['size'] / 1e9:.1f} GB)")
        _write_sidecar(plan, plan.output_path, notes, part_frames, gap_frames)
        return plan.output_path

    finally:
        # Intermediates are large; drop them once the concat has been verified.
        # They are deliberately kept when the verification above raised.
        if Path(plan.output_path).exists() and _sidecar_path(plan.output_path).exists():
            for seg in segments:
                if seg.parent == work and seg.exists():
                    seg.unlink()
            for extra in (work / 'concat.txt', audio_track):
                if extra.exists():
                    extra.unlink()
            if work.exists() and not any(work.iterdir()):
                work.rmdir()
