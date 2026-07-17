"""
GCC-PHAT audio alignment
========================

Precisely locates a raw source track inside a merged "master" mix and reports
the *signed* time offset at which the source sits within that master, so each
raw clip can be placed frame-accurately on a 29.97 fps (30000/1001) timeline.

A master recording is a MERGED mix of several audio sources (mic, screen/desktop
audio, camera audio, ...). We separately hold the individual raw source files
and video clips whose embedded audio ALSO appears inside that master mix. Plain
cross-correlation from t=0 (see ``core.audio_sync``) cannot see negative offsets
and produces weak, ambiguous peaks because the master is dominated by the OTHER
sources. GCC-PHAT (Generalized Cross-Correlation with PHase Transform) whitens
the cross-spectrum so only the *phase* (i.e. the delay) survives, which is robust
when the source of interest is a minority of the mix energy.

This module is the productionised form of the validated prototype at
``scratchpad_align/gcc_phat_prototype.py`` (which passes a synthetic accuracy
sweep to < 0.01 ms for both signs of the offset).

--------------------------------------------------------------------------------
SIGN CONVENTION  (validated by the prototype's run_synthetic_tests)
--------------------------------------------------------------------------------
We call ``gcc_phat(source, reference, fs, ...)`` and use the cross-spectrum

        R  = FFT(reference) * conj(FFT(source))
        cc = IFFT( R / |R| )

If the reference (master mix) contains a copy of ``source`` delayed by D seconds
-- i.e. ``reference(t)`` contains ``source(t - D)`` -- then FFT(source(t-D)) =
FFT(source) * exp(-j w D), so R/|R| = exp(-j w D) and the (fftshift-centered)
correlation peaks at lag = +D. We return ``tau_seconds = +D``.

    tau > 0  =>  the source's content appears tau seconds LATER than the
                 reference's t=0; place the raw source clip at t = +tau on the
                 master timeline.
    tau < 0  =>  the source's content appears BEFORE the reference start (the
                 raw file leads the master); shift the clip earlier.

--------------------------------------------------------------------------------
CONFIDENCE METRIC
--------------------------------------------------------------------------------
For a clean single delay the PHAT correlation is a sharp isolated spike; when the
source is buried or absent, energy spreads into several comparable peaks. We
report

        confidence = (peak - second_peak) / peak            in [0, 1]

where ``peak`` is the global maximum of |cc| and ``second_peak`` is the next
highest value OUTSIDE a +/- EXCLUDE_MS guard around the main peak. A clean,
unambiguous alignment -> confidence near 1.0; an ambiguous / noise-dominated
result -> confidence near 0.0. PHAT whitening already flattens the noise floor,
so the runner-up peak (peak prominence) -- not a peak/RMS ratio -- is the
quantity that tells us whether the answer is unique.

--------------------------------------------------------------------------------
RESOLUTION
--------------------------------------------------------------------------------
Native lag resolution is 1/fs (at fs=8000 -> 0.125 ms). One 30000/1001 fps frame
is ~33.367 ms (~267 samples at 8 kHz), so even the un-interpolated grid is ~267x
finer than a frame. Parabolic sub-sample refinement plus frequency-domain
zero-padding (``interp``) push accuracy well below 1/fs.
"""

from __future__ import annotations

import statistics
import subprocess
import sys
from pathlib import Path
from typing import List, Optional, Tuple

# ----------------------------------------------------------------------------
# Dependency guard  (mirrors core/audio_sync.py: fail with a helpful message
# rather than an opaque ImportError). numpy/scipy only -- NOT librosa.
# ----------------------------------------------------------------------------
_DEPENDENCIES_AVAILABLE = False
_DEPENDENCY_ERROR: Optional[str] = None

# CRITICAL: Python 3.14 with scipy can segfault - check version BEFORE importing.
if sys.version_info >= (3, 14):
    _DEPENDENCY_ERROR = (
        f"Python {sys.version_info.major}.{sys.version_info.minor} "
        "not supported (requires 3.10-3.13)"
    )
else:
    try:
        import numpy as np
        import scipy  # noqa: F401  capability check; the sync toolchain needs scipy
        _DEPENDENCIES_AVAILABLE = True
    except ImportError as ie:
        _DEPENDENCY_ERROR = str(ie)
    except Exception as e:  # pragma: no cover - defensive
        _DEPENDENCY_ERROR = f"Import error: {e}"


def _check_dependencies() -> None:
    """Raise a helpful error if numpy/scipy are not available."""
    if not _DEPENDENCIES_AVAILABLE:
        msg = (
            "GCC-PHAT alignment dependencies (numpy, scipy) are not available.\n"
            f"Python version: {sys.version_info.major}.{sys.version_info.minor}\n"
        )
        if _DEPENDENCY_ERROR:
            msg += f"Import error: {_DEPENDENCY_ERROR}\n"
        if sys.version_info[:2] >= (3, 14):
            msg += (
                "\nPython 3.14+ is not yet supported by the sync stack.\n"
                "Use the bundled interpreter or the conda env with Python 3.10-3.13:\n"
                "  conda activate autocutstudio\n"
            )
        else:
            msg += (
                "\nTo install dependencies:\n"
                "  conda activate autocutstudio\n"
                "  conda install numpy scipy\n"
            )
        raise RuntimeError(msg)


# ----------------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------------
# Target timeline frame duration (29.97 fps = 30000/1001) -- for callers that
# want to convert tau to frames.
FRAME_SECONDS = 1001.0 / 30000.0            # ~= 0.0333667 s (33.367 ms)

# Neighborhood (each side of the main peak) excluded when hunting for the
# runner-up peak used by the confidence metric.
EXCLUDE_MS = 5.0

# Minimum confidence for a measured offset to be trusted for automatic
# placement. Empirical basis (from the prototype's calibration cases):
#   * accepts a broadband source buried at -20 dB in the mix   -> conf ~= 0.81
#   * rejects a tonal (narrowband) source that PHAT mis-places -> conf ~= 0.67
# 0.80 sits between these, so buried-but-correct alignments pass while
# ambiguous / mis-placed ones are flagged for manual review.
CONFIDENCE_THRESHOLD = 0.80

_EPS = 1e-12


# ============================================================================
# Core: GCC-PHAT
# ============================================================================
def gcc_phat(
    source: "np.ndarray",
    reference: "np.ndarray",
    fs: int,
    max_tau_seconds: Optional[float] = None,
    interp: int = 4,
    subsample: bool = True,
) -> Tuple[float, float]:
    """
    Estimate the signed delay of ``source`` inside ``reference`` via GCC-PHAT.

    Parameters
    ----------
    source, reference : 1-D numpy array
        Real mono signals sampled at ``fs``. ``reference`` is the master mix;
        ``source`` is the raw individual track we are locating within it.
    fs : int
        Sample rate (Hz) of both signals.
    max_tau_seconds : float or None, optional
        If given, restrict the search to ``|tau| <= max_tau_seconds``. This both
        speeds things up and rejects spurious far-away peaks.
    interp : int, optional
        Frequency-domain zero-pad factor for a finer lag grid (>= 1). The IFFT
        length becomes ``n*interp``, giving lag resolution ``1/(fs*interp)``.
        Defaults to 4 (the validated setting).
    subsample : bool, optional
        If True (default), refine the integer peak with a 3-point parabolic fit
        for sub-sample accuracy.

    Returns
    -------
    tau_seconds : float
        Signed delay. ``tau > 0`` => the source's content appears ``tau``
        seconds LATER than reference t=0 (place the raw source clip at
        ``t = +tau`` on the master timeline). ``tau < 0`` => the source leads
        the master. See the module docstring's SIGN CONVENTION.
    confidence : float
        Peak-to-second-peak sharpness in [0, 1] (see CONFIDENCE METRIC). Values
        at/above :data:`CONFIDENCE_THRESHOLD` are trustworthy for automatic
        placement.
    """
    _check_dependencies()

    source = np.asarray(source, dtype=np.float64)
    reference = np.asarray(reference, dtype=np.float64)

    # Remove DC so the correlation is not dominated by a bias term.
    source = source - np.mean(source)
    reference = reference - np.mean(reference)

    # Linear (non-circular) correlation needs zero-padding to len(a)+len(b).
    n = source.shape[0] + reference.shape[0]

    SRC = np.fft.rfft(source, n=n)
    REF = np.fft.rfft(reference, n=n)

    # Cross-spectrum exactly as specified: R = FFT(reference) * conj(FFT(source)).
    R = REF * np.conj(SRC)

    # PHAT weighting: divide out the magnitude, keep only phase.
    mag = np.abs(R)
    mag[mag < _EPS] = _EPS
    R_phat = R / mag

    # irfft with a larger length performs frequency-domain zero padding, which
    # is exact sinc interpolation of the correlation on a finer time grid.
    n_interp = int(n * interp)
    cc = np.fft.irfft(R_phat, n=n_interp)

    # Center lag 0. After fftshift, index ``center`` is lag 0 and the lag (in
    # interpolated samples) of index i is (i - center).
    cc = np.fft.fftshift(cc)
    center = n_interp // 2
    lags_i = np.arange(n_interp) - center           # interpolated-sample lags

    # Optional search-window restriction on |tau|.
    if max_tau_seconds is not None:
        max_shift = int(round(interp * fs * max_tau_seconds))
        max_shift = min(max_shift, center)
        lo, hi = center - max_shift, center + max_shift + 1
    else:
        lo, hi = 0, n_interp

    cc_win = cc[lo:hi]
    lag_win = lags_i[lo:hi]
    env = np.abs(cc_win)

    peak_idx = int(np.argmax(env))
    peak_val = float(env[peak_idx])

    # --- sub-sample parabolic refinement around the integer peak ------------
    peak_lag_i = float(lag_win[peak_idx])
    if subsample and 0 < peak_idx < len(env) - 1:
        ym1, y0, yp1 = env[peak_idx - 1], env[peak_idx], env[peak_idx + 1]
        denom = (ym1 - 2.0 * y0 + yp1)
        if abs(denom) > _EPS:
            delta = 0.5 * (ym1 - yp1) / denom       # in interpolated samples
            # Guard against blow-ups on flat/degenerate neighborhoods.
            if -1.0 < delta < 1.0:
                peak_lag_i += delta

    # Convert interpolated-sample lag -> seconds.
    tau_seconds = (peak_lag_i / interp) / fs

    # --- confidence: peak vs best runner-up outside an exclusion window -----
    exclude = max(1, int(round(EXCLUDE_MS * 1e-3 * fs * interp)))
    masked = env.copy()
    a = max(0, peak_idx - exclude)
    b = min(len(masked), peak_idx + exclude + 1)
    masked[a:b] = 0.0
    second_val = float(masked.max()) if masked.size else 0.0

    if peak_val < _EPS:
        confidence = 0.0
    else:
        confidence = (peak_val - second_val) / peak_val
    confidence = float(np.clip(confidence, 0.0, 1.0))

    return tau_seconds, confidence


# ============================================================================
# ffmpeg resolution + decode (reuses core/audio_processor.py conventions)
# ============================================================================
def _make_processor():
    """Construct an AudioProcessor for ffprobe/duration probing.

    AudioProcessor.__init__ only needs a mapping with ``.get()`` and resolves
    ffprobe via its own ``_find_ffprobe`` (shutil.which + homebrew fallbacks),
    exactly as the rest of the pipeline does.
    """
    from .audio_processor import AudioProcessor
    return AudioProcessor({})


def _resolve_ffmpeg(processor) -> str:
    """Resolve the ffmpeg binary, reusing AudioProcessor's ffprobe resolution.

    Prefers the ffmpeg that sits alongside the resolved ffprobe (the bundled
    ``binaries/mac-arm64`` pair), then falls back to the same discovery strategy
    AudioProcessor uses for ffprobe. Raises rather than assuming "ffmpeg".
    """
    import shutil

    ffprobe = getattr(processor, "ffprobe_path", None)
    if ffprobe:
        sibling = Path(ffprobe).with_name("ffmpeg")
        if sibling.exists():
            return str(sibling)

    found = shutil.which("ffmpeg")
    if found:
        return found

    for candidate in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"):
        if Path(candidate).exists():
            return candidate

    raise RuntimeError(
        "ffmpeg not found. Install ffmpeg or ensure it is on PATH / alongside "
        "the bundled ffprobe (needed to decode audio for GCC-PHAT alignment)."
    )


def _decode_mono_window(ffmpeg: str, path: str, fs: int,
                        start: float, dur: float) -> "np.ndarray":
    """Decode a mono float32 window from ``path`` at ``fs`` Hz via ffmpeg.

    ``-ss`` is placed BEFORE ``-i`` so ffmpeg fast-seeks (essential for the
    multi-GB master/cam files) and streams f32le to a pipe.
    """
    cmd = [
        ffmpeg, "-v", "error", "-nostdin",
        "-ss", f"{start:.6f}",
        "-t", f"{dur:.6f}",
        "-i", str(path),
        "-map", "a:0",
        "-ac", "1",
        "-ar", str(int(fs)),
        "-f", "f32le",
        "pipe:1",
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg failed to decode window "
            f"(start={start:.3f}s dur={dur:.3f}s) from {path!r}: "
            f"{proc.stderr.decode('utf-8', 'replace')}"
        )
    samples = np.frombuffer(proc.stdout, dtype=np.float32).astype(np.float64)
    if samples.size == 0:
        raise RuntimeError(
            f"ffmpeg returned no audio for window "
            f"(start={start:.3f}s dur={dur:.3f}s) from {path!r}"
        )
    return samples


# ============================================================================
# High-level: measure the signed offset of a source within a reference
# ============================================================================
def measure_offset(
    source_path: str,
    reference_path: str,
    fs: int = 8000,
    max_tau_seconds: float = 5.0,
    windows: Optional[List[Tuple[float, float]]] = None,
) -> dict:
    """
    Measure the signed offset of ``source_path`` within ``reference_path``.

    Decodes mono audio windows from both files via ffmpeg (fast-seeked f32le
    pipes) and runs :func:`gcc_phat` over one or several ``(start, duration)``
    windows. Multiple windows give a robustness summary and a linear drift
    estimate so callers can distinguish a constant offset from clock drift.

    Parameters
    ----------
    source_path : str
        Raw individual track (audio or video) to locate within the reference.
    reference_path : str
        The master mix.
    fs : int, optional
        Analysis sample rate (Hz). Default 8000.
    max_tau_seconds : float, optional
        Restrict the per-window search to ``|tau| <= max_tau_seconds``.
        Default 5.0.
    windows : list[tuple[float, float]] or None, optional
        Explicit ``(start_seconds, duration_seconds)`` analysis windows. If None
        (default), three windows are placed at 10%, 50% and 85% of the reference
        duration, each ``min(150 s, 30% of the reference duration)`` long. Window
        starts are clamped so each full-length window fits inside the shorter of
        the two files (positions move; window length is never shrunk).

    Returns
    -------
    dict
        ``tau_seconds``       : median tau across windows (seconds; see SIGN
                                CONVENTION -- source content sits at +tau on the
                                reference timeline).
        ``confidence``        : minimum confidence across windows (worst case).
        ``per_window``        : list of dicts, one per window, each with
                                ``start``, ``duration``, ``center``,
                                ``tau_seconds`` and ``confidence``.
        ``drift_seconds_est`` : linear drift over the full reference duration
                                (slope of tau vs window-center-time * duration);
                                0.0 when fewer than two windows.
        ``spread_seconds``    : max-minus-min tau across windows (robustness).
        ``fs``                : analysis sample rate used.
        ``reference_duration``/``source_duration`` : probed durations (seconds).

    Raises
    ------
    RuntimeError
        If either file is too short to hold even one full analysis window
        (names the offending file and its duration -- never silently shrinks to
        a degenerate window or returns 0).
    """
    _check_dependencies()

    processor = _make_processor()
    ffmpeg = _resolve_ffmpeg(processor)

    ref_dur = float(processor.get_duration_seconds(str(reference_path)))
    src_dur = float(processor.get_duration_seconds(str(source_path)))
    effective_dur = min(ref_dur, src_dur)

    # Build the default window plan from the reference duration.
    if windows is None:
        wlen = min(150.0, 0.30 * ref_dur)
        windows = [(frac * ref_dur, wlen) for frac in (0.10, 0.50, 0.85)]

    if not windows:
        raise RuntimeError("measure_offset requires at least one analysis window")

    # Validate + position each window. Fail loud if a full-length window cannot
    # fit inside the shorter file.
    planned: List[Tuple[float, float]] = []
    for start, wdur in windows:
        if wdur <= 0:
            raise RuntimeError(f"Invalid analysis window duration {wdur!r}s")
        if wdur > effective_dur:
            shorter_path, shorter_dur = (
                (reference_path, ref_dur) if ref_dur <= src_dur
                else (source_path, src_dur)
            )
            raise RuntimeError(
                f"File too short for even one {wdur:.1f}s analysis window: "
                f"{shorter_path} is only {shorter_dur:.3f}s long "
                f"(reference={ref_dur:.3f}s, source={src_dur:.3f}s). "
                "Refusing to shrink to a degenerate window."
            )
        # Clamp the start so the full-length window fits in the shorter file.
        start = min(max(0.0, float(start)), effective_dur - wdur)
        planned.append((start, wdur))

    per_window = []
    for start, wdur in planned:
        ref_win = _decode_mono_window(ffmpeg, reference_path, fs, start, wdur)
        src_win = _decode_mono_window(ffmpeg, source_path, fs, start, wdur)
        tau, conf = gcc_phat(src_win, ref_win, fs,
                             max_tau_seconds=max_tau_seconds, interp=4)
        per_window.append({
            "start": start,
            "duration": wdur,
            "center": start + wdur / 2.0,
            "tau_seconds": tau,
            "confidence": conf,
        })

    taus = [w["tau_seconds"] for w in per_window]
    confs = [w["confidence"] for w in per_window]
    centers = [w["center"] for w in per_window]

    tau_median = float(statistics.median(taus))
    confidence_min = float(min(confs))
    spread = float(max(taus) - min(taus))

    # Linear drift estimate: slope of tau vs window center time, extrapolated
    # across the full reference duration. Needs >= 2 windows.
    if len(per_window) >= 2:
        slope = float(np.polyfit(np.asarray(centers), np.asarray(taus), 1)[0])
        drift_seconds_est = slope * ref_dur
    else:
        drift_seconds_est = 0.0

    return {
        "tau_seconds": tau_median,
        "confidence": confidence_min,
        "per_window": per_window,
        "drift_seconds_est": drift_seconds_est,
        "spread_seconds": spread,
        "fs": fs,
        "reference_duration": ref_dur,
        "source_duration": src_dur,
    }
