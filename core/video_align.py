"""Align a capture to the master by its PICTURE when its audio cannot be used.

GCC-PHAT (``core.gcc_phat_align``) is the primary alignment method and should be
preferred whenever the source has audio: it is cheaper and more precise. This
module exists for the case where it structurally cannot work -- a capture whose
audio feed was lost records a perfectly valid, perfectly silent track, and there
is then no signal to correlate.

WHAT IS CORRELATED
------------------
Not pixels. The master is a composited program feed: the screen share may be
scaled, cropped, letterboxed, overlaid with a camera inset, or colour-graded, so
its pixels never match the raw capture's. What DOES survive compositing is WHEN
things move. Each source is reduced to a one-dimensional motion signal

    m[i] = mean(|frame[i] - frame[i-1]|)

sampled at the timeline frame rate, and the two motion signals are cross-
correlated. A scene change, a scroll, a video cut -- anything that moves the
screen content -- spikes both signals at the same instant regardless of how the
picture was framed.

Because the signal is sampled per frame, the offset it returns is quantized to
whole frames. That is the natural precision here and it is what the timeline
needs; sub-frame precision would be meaningless for placing a video clip.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

_DEPENDENCIES_AVAILABLE = False
_DEPENDENCY_ERROR: Optional[str] = None
try:
    import numpy as np
    _DEPENDENCIES_AVAILABLE = True
except ImportError as ie:  # pragma: no cover - mirrors gcc_phat_align's guard
    _DEPENDENCY_ERROR = str(ie)


# Downscaled frame size for the motion signal. Small enough that decoding is
# dominated by H.264 decode rather than scaling, large enough that a change
# confined to part of the screen still registers.
PROBE_WIDTH = 64
PROBE_HEIGHT = 36

# Motion is a sparse, spiky signal; its confidence is measured the same way the
# audio path measures it (peak versus best runner-up), but a picture correlation
# is inherently noisier, so the bar is lower. Calibrated against the 2026-08-02
# session, where the audio ground truth is known.
VIDEO_CONFIDENCE_THRESHOLD = 0.35

# Guard band (frames) around the main peak when hunting for the runner-up.
_EXCLUDE_FRAMES = 3

# The master is a 2x2 composite of the session's four video sources. Correlating
# a capture against the WHOLE master frame pits its motion against three
# unrelated sources moving at once (two cameras and a game feed), which buries
# the peak -- measured on the 2026-08-05 session, only 3 of 18 analysis windows
# locked without a crop. Cropping the master to the quadrant that actually holds
# the source is what makes this method work.
#
# Positions mirror core/skip_logic.py's quadrant_map, which is the pipeline's
# existing statement of this layout; keep the two in step. Values are fractions
# of the master frame, so they hold at any master resolution.
MASTER_QUADRANTS = {
    'screen': (0.0, 0.0, 0.5, 0.5),   # top-left
    'cam2':   (0.5, 0.0, 0.5, 0.5),   # top-right
    'cam1':   (0.0, 0.5, 0.5, 0.5),   # bottom-left
    'game':   (0.5, 0.5, 0.5, 0.5),   # bottom-right
}


def quadrant_crop(source_type: str) -> Optional[Tuple[float, float, float, float]]:
    """The master-frame crop holding ``source_type``, or None if it has no quadrant."""
    return MASTER_QUADRANTS.get(source_type)


def _crop_filter(crop: Optional[Tuple[float, float, float, float]]) -> str:
    """An ffmpeg crop expression in terms of iw/ih, so it needs no probe."""
    if not crop:
        return ''
    x, y, w, h = crop
    return f'crop=iw*{w}:ih*{h}:iw*{x}:ih*{y},'


class VideoAlignError(RuntimeError):
    """Picture alignment could not produce a trustworthy answer."""


def _check_dependencies() -> None:
    if not _DEPENDENCIES_AVAILABLE:
        raise VideoAlignError(
            f"Picture alignment needs numpy, which is unavailable: "
            f"{_DEPENDENCY_ERROR}")


def _ffmpeg() -> str:
    from .gcc_phat_align import _make_processor, _resolve_ffmpeg
    return _resolve_ffmpeg(_make_processor())


def motion_signal(path: str, start: float, duration: float,
                  frame_rate: str = '30000/1001',
                  crop: Optional[Tuple[float, float, float, float]] = None
                  ) -> "np.ndarray":
    """Decode a window and reduce it to one motion value per frame.

    ``-ss`` before ``-i`` fast-seeks, which matters because these files run to
    tens of gigabytes. Frames are optionally cropped (to isolate one quadrant of
    a composited master), converted to 8-bit grey at PROBE_WIDTH x PROBE_HEIGHT
    and resampled to ``frame_rate`` so both sides of a comparison are sampled on
    the same grid even when the sources were recorded at different rates.

    Cropping happens BEFORE the downscale, so the quadrant fills the probe frame
    at the same framing as the raw capture does.
    """
    _check_dependencies()
    cmd = [
        _ffmpeg(), '-v', 'error', '-nostdin',
        '-ss', f'{start:.6f}', '-t', f'{duration:.6f}', '-i', str(path),
        '-map', 'v:0',
        '-vf', (f'{_crop_filter(crop)}fps={frame_rate},'
                f'scale={PROBE_WIDTH}:{PROBE_HEIGHT},format=gray'),
        '-f', 'rawvideo', 'pipe:1',
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise VideoAlignError(
            f"ffmpeg failed to decode video window "
            f"(start={start:.3f}s dur={duration:.3f}s) from {path!r}: "
            f"{proc.stderr.decode('utf-8', 'replace')[-2000:]}")

    frame_bytes = PROBE_WIDTH * PROBE_HEIGHT
    raw = np.frombuffer(proc.stdout, dtype=np.uint8)
    count = raw.size // frame_bytes
    if count < 2:
        raise VideoAlignError(
            f"decoded only {count} frame(s) from {path!r} at {start:.3f}s; "
            f"cannot build a motion signal")
    frames = raw[:count * frame_bytes].reshape(count, frame_bytes).astype(np.float32)
    return np.abs(np.diff(frames, axis=0)).mean(axis=1)


def _normalized_xcorr(source: "np.ndarray", reference: "np.ndarray",
                      max_lag: int) -> Tuple[int, float]:
    """Best integer lag of ``source`` within ``reference`` and its confidence.

    Returns the lag (in samples/frames) maximizing the zero-mean normalized
    correlation, plus a peak-to-runner-up confidence in [0, 1] defined exactly as
    in the audio path so the two are read the same way.
    """
    a = source - source.mean()
    b = reference - reference.mean()
    if not np.any(a) or not np.any(b):
        raise VideoAlignError(
            "a motion signal is completely flat (a still picture); there is "
            "nothing to correlate")

    n = a.size + b.size
    corr = np.fft.irfft(np.fft.rfft(b, n) * np.conj(np.fft.rfft(a, n)), n)
    corr = np.concatenate((corr[-(a.size - 1):], corr[:b.size]))
    lags = np.arange(-(a.size - 1), b.size)

    keep = np.abs(lags) <= max_lag
    corr, lags = corr[keep], lags[keep]
    if corr.size == 0:
        raise VideoAlignError(f"no lags within +/-{max_lag} frames to search")

    peak_idx = int(np.argmax(corr))
    peak = float(corr[peak_idx])
    if peak <= 0:
        return int(lags[peak_idx]), 0.0

    masked = corr.copy()
    lo = max(0, peak_idx - _EXCLUDE_FRAMES)
    hi = min(masked.size, peak_idx + _EXCLUDE_FRAMES + 1)
    masked[lo:hi] = -np.inf
    runner = float(masked.max()) if np.isfinite(masked).any() else 0.0
    confidence = max(0.0, (peak - max(runner, 0.0)) / peak)
    return int(lags[peak_idx]), float(confidence)


def measure_picture_offset(
    source_path: str,
    reference_path: str,
    expected_start: float,
    search_radius_seconds: float = 30.0,
    window_seconds: float = 120.0,
    # Generous by default: windows are cheap relative to being wrong, and a
    # composited master shows any given source only intermittently, so several
    # of these are expected to find nothing.
    probe_fractions: Sequence[float] = (0.03, 0.12, 0.22, 0.33, 0.45, 0.57,
                                        0.68, 0.79, 0.90),
    frame_rate: str = '30000/1001',
    reference_crop: Optional[Tuple[float, float, float, float]] = None,
    log=lambda msg: print(msg, file=sys.stderr),
) -> dict:
    """Locate ``source_path``'s first frame on ``reference_path``'s timeline.

    Mirrors :func:`core.gcc_phat_align.locate_source` in signature, meaning and
    return shape, so a caller can swap one for the other. ``start_seconds`` is
    the reference time at which the source's first frame sits.

    ``reference_crop`` should almost always be set when the reference is a
    composited master: pass :func:`quadrant_crop` for the source's type so the
    correlation sees only the region that actually holds it.
    """
    _check_dependencies()
    from .gcc_phat_align import _make_processor

    processor = _make_processor()
    ref_dur = float(processor.get_duration_seconds(str(reference_path)))
    src_dur = float(processor.get_duration_seconds(str(source_path)))
    rate = float(eval_fraction(frame_rate))
    max_lag = int(round(search_radius_seconds * rate))

    if window_seconds > src_dur:
        raise VideoAlignError(
            f"{source_path} is only {src_dur:.3f}s long, shorter than the "
            f"{window_seconds:.1f}s analysis window")

    per_window: List[dict] = []
    for frac in probe_fractions:
        s = min(max(0.0, frac * src_dur), src_dur - window_seconds)
        # The reference window is widened by the search radius on both sides so
        # a hit anywhere in the search range has the full source window to match
        # against, rather than running off the end.
        ref_start = expected_start + s - search_radius_seconds
        ref_len = window_seconds + 2 * search_radius_seconds
        # Near either end of the reference there is no room for the full padded
        # window. Clamping it (rather than failing) keeps the first and last
        # probe points usable -- the returned lag is still interpreted against
        # ref_start, so the arithmetic is unchanged; only the reachable search
        # range on that side shrinks. Refuse only when what remains is shorter
        # than the source window, at which point there is nothing to match.
        ref_start = max(0.0, ref_start)
        ref_len = min(ref_len, ref_dur - ref_start)
        if ref_len < window_seconds:
            raise VideoAlignError(
                f"search window for source-local {s:.1f}s leaves only "
                f"{ref_len:.1f}s of reference at {ref_start:.3f}s, less than the "
                f"{window_seconds:.1f}s source window; the reference does not "
                f"cover where this source is expected to be")

        # One unusable window (a passage where the picture is frozen, or a
        # stretch that will not decode) must not abort the sweep -- the whole
        # design is that most windows find nothing and a few carry the answer.
        # It is recorded with zero confidence so it can never become a lock.
        try:
            src = motion_signal(source_path, s, window_seconds, frame_rate)
            ref = motion_signal(reference_path, ref_start, ref_len, frame_rate,
                                crop=reference_crop)
            lag, conf = _normalized_xcorr(src, ref, max_lag=max_lag + int(rate))
        except VideoAlignError as err:
            per_window.append({
                'source_local': s, 'reference_start': ref_start,
                'lag_frames': None, 'start_seconds': None, 'confidence': 0.0,
                'error': str(err),
            })
            log(f"    picture window at source {s:8.1f}s -> unusable: {err}")
            continue

        # lag is where the source window sits inside the reference window.
        start = ref_start + lag / rate - s
        per_window.append({
            'source_local': s,
            'reference_start': ref_start,
            'lag_frames': lag,
            'start_seconds': start,
            'confidence': conf,
        })
        log(f"    picture window at source {s:8.1f}s -> start {start:10.4f}s "
            f"(lag {lag:+5d} fr, conf {conf:.3f})")

    # A composited master only shows a given source SOME of the time, so most
    # windows may have nothing to correlate and return noise. Averaging those in
    # would drag the answer anywhere; the ones that lock are the measurement, and
    # their agreement with each other is the evidence. (On the 2026-08-05
    # session, taking a median across all windows gave 11594.15s -- 20s wrong --
    # where the locked windows agreed on 11614.99s.)
    locked = [w for w in per_window if w['confidence'] >= VIDEO_CONFIDENCE_THRESHOLD]
    if len(locked) < 2:
        raise VideoAlignError(
            f"only {len(locked)} of {len(per_window)} picture windows locked onto "
            f"{source_path} (confidence >= {VIDEO_CONFIDENCE_THRESHOLD}). Two "
            f"independent windows must agree before this is trusted. The "
            f"reference may not be showing this source, or the expected position "
            f"({expected_start:.1f}s) may be wrong.")

    starts = [w['start_seconds'] for w in locked]
    spread = float(max(starts) - min(starts))
    median = float(np.median(starts))
    return {
        'start_seconds': median,
        'tau_seconds': median - expected_start,
        'confidence': float(min(w['confidence'] for w in locked)),
        'spread_seconds': spread,
        'locked_windows': len(locked),
        'total_windows': len(per_window),
        'per_window': per_window,
        'frame_rate': frame_rate,
        'reference_duration': ref_dur,
        'source_duration': src_dur,
        'expected_start': expected_start,
    }


def eval_fraction(text: str) -> float:
    from fractions import Fraction
    return float(Fraction(text))


# ============================================================================
# Frame-content alignment (higher precision than motion)
# ============================================================================
def frame_stack(path: str, start: float, duration: float,
                frame_rate: str = '30000/1001',
                crop: Optional[Tuple[float, float, float, float]] = None
                ) -> "np.ndarray":
    """Decode a window as one normalized feature vector per frame.

    Each frame is reduced to a small grey thumbnail, mean-centred and scaled to
    unit norm. Centring removes overall brightness differences and unit-norming
    removes contrast differences, so what remains is the frame's *structure* --
    which survives the master's rescaling of the source into its quadrant.

    Frames with no structure at all (a solid colour) are left as zeros; they
    contribute nothing to a correlation rather than contributing noise.
    """
    _check_dependencies()
    raw = motion_frames(path, start, duration, frame_rate, crop)
    centred = raw - raw.mean(axis=1, keepdims=True)
    norms = np.linalg.norm(centred, axis=1, keepdims=True)
    flat = norms[:, 0] < 1e-6
    norms[flat, 0] = 1.0
    stack = centred / norms
    stack[flat] = 0.0
    return stack


def motion_frames(path: str, start: float, duration: float,
                  frame_rate: str = '30000/1001',
                  crop: Optional[Tuple[float, float, float, float]] = None
                  ) -> "np.ndarray":
    """Decode a window as a (frames, pixels) float array of grey thumbnails."""
    _check_dependencies()
    cmd = [
        _ffmpeg(), '-v', 'error', '-nostdin',
        '-ss', f'{start:.6f}', '-t', f'{duration:.6f}', '-i', str(path),
        '-map', 'v:0',
        '-vf', (f'{_crop_filter(crop)}fps={frame_rate},'
                f'scale={PROBE_WIDTH}:{PROBE_HEIGHT},format=gray'),
        '-f', 'rawvideo', 'pipe:1',
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise VideoAlignError(
            f"ffmpeg failed to decode video window "
            f"(start={start:.3f}s dur={duration:.3f}s) from {path!r}: "
            f"{proc.stderr.decode('utf-8', 'replace')[-2000:]}")
    frame_bytes = PROBE_WIDTH * PROBE_HEIGHT
    raw = np.frombuffer(proc.stdout, dtype=np.uint8)
    count = raw.size // frame_bytes
    if count < 1:
        raise VideoAlignError(
            f"decoded no frames from {path!r} at {start:.3f}s")
    return raw[:count * frame_bytes].reshape(count, frame_bytes).astype(np.float32)


def _content_xcorr(source: "np.ndarray", reference: "np.ndarray",
                   max_lag: int) -> Tuple[int, float, "np.ndarray"]:
    """Best integer frame lag of a source frame-stack within a reference stack.

    Scores a lag by the mean cosine similarity of each source frame against the
    reference frame it would land on. Both stacks are already unit-normalized, so
    a perfect content match scores 1.0 and unrelated content scores near 0 --
    which makes the score directly interpretable, unlike a motion correlation
    whose scale depends on how much happened to be moving.

    Computed as a sum of per-pixel cross-correlations via FFT, so the cost does
    not grow with the search range.
    """
    n_src, dims = source.shape
    n_ref = reference.shape[0]
    if n_ref < n_src:
        raise VideoAlignError(
            f"reference window holds {n_ref} frames, fewer than the source's "
            f"{n_src}; nothing to slide")

    size = 1
    while size < n_ref + n_src:
        size *= 2
    # correlation[l] = sum_i sum_d source[i,d] * reference[i+l,d]
    fft_ref = np.fft.rfft(reference, n=size, axis=0)
    fft_src = np.fft.rfft(source[::-1], n=size, axis=0)
    corr = np.fft.irfft(fft_ref * fft_src, n=size, axis=0).sum(axis=1)
    corr = corr[n_src - 1:n_src - 1 + (n_ref - n_src + 1)]

    lags = np.arange(corr.size)
    keep = lags <= max_lag
    corr, lags = corr[keep], lags[keep]
    if corr.size == 0:
        raise VideoAlignError(f"no lags within {max_lag} frames to search")

    # Normalize to a mean-per-frame cosine similarity.
    scores = corr / float(n_src)
    peak_idx = int(np.argmax(scores))
    peak = float(scores[peak_idx])

    masked = scores.copy()
    lo = max(0, peak_idx - _EXCLUDE_FRAMES)
    hi = min(masked.size, peak_idx + _EXCLUDE_FRAMES + 1)
    masked[lo:hi] = -np.inf
    runner = float(masked.max()) if np.isfinite(masked).any() else 0.0

    # MARGIN, not peak, is what says the answer is unique. A screen that sat
    # still for the whole window matches PERFECTLY at every lag: peak 1.000,
    # runner-up 1.000. Two such windows in the 2026-08-02 calibration returned
    # confident-looking answers 299 and 272 frames out. A high peak with no
    # margin is an ambiguity, not a measurement.
    margin = peak - max(runner, 0.0)

    # Sub-frame refinement. The peak of a content correlation is a genuine
    # continuous maximum -- the picture between two frame times is a blend of
    # them -- so fitting the neighbours locates it below frame resolution.
    lag = float(lags[peak_idx])
    if 0 < peak_idx < scores.size - 1:
        ym1, y0, yp1 = scores[peak_idx - 1], scores[peak_idx], scores[peak_idx + 1]
        denom = ym1 - 2.0 * y0 + yp1
        if abs(denom) > 1e-12:
            delta = 0.5 * (ym1 - yp1) / denom
            if -1.0 < delta < 1.0:
                lag += delta
    return lag, peak, margin


# A content correlation scores near 1.0 wherever the picture matches, so the
# useful quantity is how far the best lag beats the next-best. Calibrated on the
# 2026-08-02 session: correct windows showed margins of 0.02-0.09, while windows
# that locked onto the wrong place (a static screen) showed 0.000-0.005.
CONTENT_MARGIN_THRESHOLD = 0.015


# ============================================================================
# Scene-change alignment  (the precise method)
# ============================================================================
# Every correlation method above is limited by the same thing: a shared screen
# sits STILL for long stretches, so an entire window of frames matches equally
# well at many offsets. Measured on the 2026-08-05 session, single-frame matching
# returned similarity 1.000 with a margin of 0.0000 at nine of ten probes, and
# window correlation could not do better than a few frames.
#
# A scene change has none of that ambiguity: it is a single-frame event with an
# exact timestamp, and the same cut appears in both the capture and the master's
# quadrant. Matching two lists of cut times located part 2 to 0.55 frames of
# scatter across 48 independently matched pairs, where correlation spread over
# 4 frames. This is the method to prefer whenever the material has any cuts.
SCENE_THRESHOLD = 0.35
# Two cuts count as the same event within this tolerance. Wide enough to absorb
# a frame of rate-conversion jitter, narrow enough that unrelated cuts do not
# accumulate in the same bin.
SCENE_MATCH_TOLERANCE = 1.5 * (1001.0 / 30000.0)
# Minimum matched pairs before an offset is believed. Coincidental agreement
# needs many independent cuts to line up at once, which is why this can be low
# and still be safe.
SCENE_MIN_PAIRS = 6


def scene_changes(path: str, start: float, duration: float,
                  crop: Optional[Tuple[float, float, float, float]] = None,
                  threshold: float = SCENE_THRESHOLD) -> "np.ndarray":
    """Absolute timestamps of scene changes in a window.

    ``-copyts`` keeps the source's real timestamps, so the returned times need no
    correction for where the seek happened to land. Detection runs on a
    downscaled frame, which does not affect which frames are cuts but makes the
    pass much cheaper.
    """
    _check_dependencies()
    import re
    vf = (f"{_crop_filter(crop)}scale=160:90,"
          f"select='gt(scene,{threshold})',showinfo")
    cmd = [_ffmpeg(), '-nostdin', '-copyts',
           '-ss', f'{start:.6f}', '-t', f'{duration:.6f}', '-i', str(path),
           '-map', 'v:0', '-vf', vf, '-vsync', '0', '-f', 'null', '-']
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True)
    if proc.returncode != 0:
        raise VideoAlignError(
            f"scene detection failed on {path!r} at {start:.3f}s: "
            f"{proc.stderr[-2000:]}")
    return np.array([float(m) for m in
                     re.findall(r'pts_time:([0-9.]+)', proc.stderr)])


def scene_change_offset(
    source_path: str,
    reference_path: str,
    expected_start: float,
    search_radius_seconds: float = 30.0,
    span_seconds: float = 2400.0,
    source_start: float = 0.0,
    reference_crop: Optional[Tuple[float, float, float, float]] = None,
    log=lambda msg: print(msg, file=sys.stderr),
) -> dict:
    """Locate a source on a reference by matching scene-change timestamps.

    Each (reference cut, source cut) pair implies one candidate offset. The true
    offset is the one that explains MANY pairs simultaneously -- an agreement no
    coincidence reproduces, since unrelated cuts scatter uniformly.

    Returns the same shape as the other locators, plus ``matched_pairs``. The
    reported ``start_seconds`` corresponds to source-local time ``source_start``,
    so a caller measuring near a part's beginning should pass 0.0.
    """
    _check_dependencies()

    ref_cuts = scene_changes(reference_path, expected_start + source_start,
                             span_seconds, crop=reference_crop)
    src_cuts = scene_changes(source_path, source_start, span_seconds)
    log(f"    scene changes: {len(ref_cuts)} in the reference, "
        f"{len(src_cuts)} in {Path(source_path).name}")
    if len(ref_cuts) < SCENE_MIN_PAIRS or len(src_cuts) < SCENE_MIN_PAIRS:
        raise VideoAlignError(
            f"too few scene changes to align on ({len(ref_cuts)} reference, "
            f"{len(src_cuts)} source; need {SCENE_MIN_PAIRS} of each). This "
            f"material is too static for cut matching.")

    implied = (ref_cuts[:, None] - src_cuts[None, :]).ravel()
    lo, hi = expected_start - search_radius_seconds, expected_start + search_radius_seconds
    implied = implied[(implied >= lo) & (implied <= hi)]
    if implied.size == 0:
        raise VideoAlignError(
            f"no pair of scene changes implies an offset within "
            f"+/-{search_radius_seconds:.0f}s of {expected_start:.1f}s")

    # Vote. Half-frame bins split a true cluster across neighbours, so the
    # winning bin is only used to seed the cluster, which is then collected by
    # tolerance and summarized by its median.
    frame = 1001.0 / 30000.0
    edges = np.arange(implied.min(), implied.max() + frame / 2, frame / 2)
    hist, _ = np.histogram(implied, bins=edges)
    top = int(np.argmax(hist))
    seed = (edges[top] + edges[top + 1]) / 2.0
    members = implied[np.abs(implied - seed) <= SCENE_MATCH_TOLERANCE]
    if members.size < SCENE_MIN_PAIRS:
        raise VideoAlignError(
            f"the best offset is supported by only {members.size} matched cut "
            f"pairs (need {SCENE_MIN_PAIRS}); not enough to be sure it is not "
            f"coincidence")

    start = float(np.median(members))
    return {
        'start_seconds': start,
        'tau_seconds': start - expected_start,
        'matched_pairs': int(members.size),
        'reference_cuts': int(len(ref_cuts)),
        'source_cuts': int(len(src_cuts)),
        'spread_seconds': float(members.std()),
        'confidence': float(min(1.0, members.size / (2.0 * SCENE_MIN_PAIRS))),
        'expected_start': expected_start,
        'source_start': source_start,
    }


def picture_drift_profile(
    source_path: str,
    reference_path: str,
    base_offset: float = 0.0,
    points: int = 5,
    window_seconds: float = 120.0,
    search_radius_seconds: float = 30.0,
    frame_rate: str = '30000/1001',
    reference_crop: Optional[Tuple[float, float, float, float]] = None,
    log=lambda msg: print(msg, file=sys.stderr),
) -> dict:
    """Measure a capture's picture offset at several points across its length.

    A capture that dropped frames WITHOUT leaving gaps in its timestamps has a
    picture that runs progressively further ahead of its own sound, and no single
    offset can place it. That shows up here as an offset that ramps across the
    file rather than staying put, which is the distinction this function exists
    to make. Returns the per-point offsets plus the total drift between the first
    and last point.
    """
    _check_dependencies()
    from .gcc_phat_align import _make_processor

    src_dur = float(_make_processor().get_duration_seconds(str(source_path)))
    fractions = [i / (points - 1) for i in range(points)] if points > 1 else [0.0]

    samples: List[dict] = []
    for frac in fractions:
        s = min(max(0.0, frac * src_dur), src_dur - window_seconds)
        result = measure_picture_offset(
            source_path, reference_path, expected_start=base_offset,
            search_radius_seconds=search_radius_seconds,
            window_seconds=window_seconds, probe_fractions=(s / src_dur,),
            frame_rate=frame_rate, reference_crop=reference_crop,
            log=lambda m: None)
        w = result['per_window'][0]
        samples.append({'source_local': s,
                        'offset_seconds': w['start_seconds'],
                        'confidence': w['confidence']})
        log(f"  local {s:9.1f}s  offset {w['start_seconds']:+9.4f}s  "
            f"({w['start_seconds'] / (1001 / 30000):+7.2f} fr)  "
            f"conf {w['confidence']:.3f}")

    trusted = [s for s in samples if s['confidence'] >= VIDEO_CONFIDENCE_THRESHOLD]
    if len(trusted) < 2:
        raise VideoAlignError(
            f"only {len(trusted)} of {len(samples)} picture probes cleared the "
            f"confidence threshold ({VIDEO_CONFIDENCE_THRESHOLD}); cannot say "
            f"whether this capture drifts")

    drift = trusted[-1]['offset_seconds'] - trusted[0]['offset_seconds']
    span = trusted[-1]['source_local'] - trusted[0]['source_local']
    return {
        'samples': samples,
        'trusted': trusted,
        'drift_seconds': drift,
        'span_seconds': span,
        'drift_per_hour': (drift / span * 3600.0) if span else 0.0,
    }
