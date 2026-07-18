#!/usr/bin/env python
"""Chunked, memory-safe voice isolation via mel-band roformer (audio-separator).

Why chunked + separate processes: running the separator on a whole multi-hour
file balloons the physical (MPS/unified) footprint to ~30 GB and never frees it
within one process. Splitting the input at SILENCES into short pieces and running
each piece in its OWN separator subprocess that EXITS between pieces caps the peak
footprint at one piece's worth (~4 GB for a 6-min piece) and reclaims all of it
between pieces. Seams fall in silence, so concatenating the vocal stems is
click-free (no crossfade / phase issues).

Fails loud: any missing tool/model, any separator non-zero exit, or any empty
stem aborts the whole run with a clear message — no silent fallback.

  python separate_voice.py --input in.wav --output voice.wav \
      --sep-python <env>/bin/python --launcher run_audio_separator.py \
      --model-dir <dir> --model vocals_mel_band_roformer.ckpt \
      [--target-min 6] [--max-min 8] [--target-sr 48000] [--noise-db -40] [--keep-temp]
"""
import argparse
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def ffprobe_duration(ffprobe, path):
    r = run([ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nk=1:nw=1", str(path)])
    if r.returncode != 0 or not r.stdout.strip():
        sys.exit(f"ERROR: could not probe duration of {path}: {r.stderr.strip()}")
    return float(r.stdout.strip())


def detect_silences(ffmpeg, path, noise_db, min_sil_s):
    """Return list of (start, end) silent intervals via ffmpeg silencedetect
    (streaming, low memory)."""
    r = run([ffmpeg, "-nostdin", "-i", str(path),
             "-af", f"silencedetect=noise={noise_db}dB:d={min_sil_s}",
             "-f", "null", "-"])
    starts = [float(m) for m in re.findall(r"silence_start:\s*([0-9.]+)", r.stderr)]
    ends = [float(m) for m in re.findall(r"silence_end:\s*([0-9.]+)", r.stderr)]
    return list(zip(starts, ends))  # ends may be one shorter if file ends in silence


def plan_cuts(duration, silences, target_s, max_s):
    """Greedy cut points at silence midpoints: aim for target_s, never exceed
    max_s. If no silence is available before max_s, force a hard cut at max_s
    (logged) rather than letting a chunk grow unbounded."""
    mids = [ (s + e) / 2.0 for s, e in silences if e > s ]
    cuts, last = [], 0.0
    i = 0
    while duration - last > max_s:
        # first silence midpoint at/after target from last
        window = [m for m in mids if last + target_s <= m <= last + max_s]
        if window:
            cut = window[0]
        else:
            cut = last + max_s
            print(f"FORCED_CUT no silence between {last:.1f}s and {last+max_s:.1f}s; "
                  f"hard cut at {cut:.1f}s", file=sys.stderr)
        cuts.append(cut)
        last = cut
    bounds = [0.0] + cuts + [duration]
    return list(zip(bounds[:-1], bounds[1:]))


def is_silent(ffmpeg, wav, thresh_db=-60.0):
    """True if the chunk has no audio above thresh_db (a muted/zero stretch).
    Such chunks crash the separator ('empty or not valid'); we pass them through
    as silence instead — silence in = silence out, and it saves GPU time."""
    r = run([ffmpeg, "-nostdin", "-i", str(wav), "-af", "volumedetect", "-f", "null", "-"])
    m = re.search(r"max_volume:\s*(-?[0-9.]+|-inf)", r.stderr)
    if not m:
        return False  # can't determine -> process it (don't silently skip real audio)
    v = m.group(1)
    return v == "-inf" or float(v) <= thresh_db


def to_16bit_silence(ffmpeg, src, out):
    """Re-encode an (all-silent) chunk to 16-bit to match the separator's stem
    format, so it concatenates cleanly with real stems. Exact same length as src."""
    r = run([ffmpeg, "-nostdin", "-v", "error", "-i", str(src),
             "-c:a", "pcm_s16le", "-y", str(out)])
    if r.returncode != 0:
        sys.exit(f"ERROR: could not build silent passthrough stem: {r.stderr[-400:]}")


def extract_chunk(ffmpeg, path, t0, t1, out):
    r = run([ffmpeg, "-nostdin", "-v", "error", "-ss", f"{t0:.6f}", "-to", f"{t1:.6f}",
             "-i", str(path), "-ac", "2", "-ar", "44100", "-c:a", "pcm_s24le",
             "-y", str(out)])
    if r.returncode != 0:
        sys.exit(f"ERROR: ffmpeg failed extracting chunk {t0:.1f}-{t1:.1f}s: {r.stderr[-500:]}")


def separate_chunk(sep_python, launcher, chunk_wav, out_dir, model_dir, model, ffmpeg_dir):
    """Run the separator in its OWN process; return the vocal stem path. The
    process exits here, reclaiming its footprint. audio-separator shells out to
    ffmpeg internally, so its directory must be on PATH."""
    out_dir = Path(out_dir); out_dir.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env.update({"KMP_DUPLICATE_LIB_OK": "TRUE", "PYTHONUNBUFFERED": "1",
                "PYTHONIOENCODING": "utf-8"})
    # audio-separator + torch need their env's binary/DLL dirs on PATH. On
    # Windows those live under the env root (Library/bin etc.), not just next to
    # python.exe, and PATH is ';'-separated — hence os.pathsep and the extra dirs.
    _p = Path(sep_python).parent
    if os.name == 'nt':
        path_dirs = [str(_p), str(_p / 'Library' / 'bin'),
                     str(_p / 'Library' / 'mingw-w64' / 'bin'),
                     str(_p / 'Library' / 'usr' / 'bin'),
                     str(_p / 'Scripts'), str(ffmpeg_dir)]
    else:
        path_dirs = [str(_p), str(ffmpeg_dir)]
    env["PATH"] = os.pathsep.join(path_dirs) + os.pathsep + env.get("PATH", "")
    r = subprocess.run(
        [str(sep_python), str(launcher), str(chunk_wav),
         "--model_filename", model, "--output_dir", str(out_dir),
         "--output_format", "WAV", "--model_file_dir", str(model_dir),
         "--single_stem", "Vocals"],
        capture_output=True, text=True, env=env)
    if r.returncode != 0:
        sys.exit(f"ERROR: separator failed on {chunk_wav.name} (exit {r.returncode}):\n"
                 f"{r.stderr[-800:]}")
    stems = list(out_dir.glob("*.wav"))
    if not stems:
        sys.exit(f"ERROR: separator produced no stem for {chunk_wav.name} "
                 f"(env/model problem) — refusing to continue")
    return max(stems, key=lambda p: p.stat().st_size)


def concat_resample(ffmpeg, stems, output, target_sr):
    listf = Path(output).with_suffix(".concat.txt")
    # as_posix() keeps forward slashes — the ffmpeg concat demuxer chokes on
    # Windows backslash paths.
    listf.write_text("".join(f"file '{s.resolve().as_posix()}'\n" for s in stems))
    r = run([ffmpeg, "-nostdin", "-v", "error", "-f", "concat", "-safe", "0",
             "-i", str(listf), "-ar", str(target_sr), "-c:a", "pcm_s24le",
             "-y", str(output)])
    listf.unlink(missing_ok=True)
    if r.returncode != 0:
        sys.exit(f"ERROR: concat/resample failed: {r.stderr[-500:]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--sep-python", required=True)
    ap.add_argument("--launcher",
                    default=str(Path(__file__).resolve().parent / "run_audio_separator.py"))
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--model", default="vocals_mel_band_roformer.ckpt")
    ap.add_argument("--target-min", type=float, default=6.0)
    ap.add_argument("--max-min", type=float, default=8.0)
    ap.add_argument("--target-sr", type=int, default=48000)
    ap.add_argument("--noise-db", type=float, default=-40.0)
    ap.add_argument("--min-sil", type=float, default=0.3)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--ffprobe", default="ffprobe")
    ap.add_argument("--keep-temp", action="store_true")
    a = ap.parse_args()

    for tool, p in (("sep-python", a.sep_python), ("launcher", a.launcher)):
        if not Path(p).exists():
            sys.exit(f"ERROR: --{tool} not found: {p}")
    if not (Path(a.model_dir) / a.model).exists():
        sys.exit(f"ERROR: model not found: {Path(a.model_dir)/a.model}")

    dur = ffprobe_duration(a.ffprobe, a.input)
    sil = detect_silences(a.ffmpeg, a.input, a.noise_db, a.min_sil)
    chunks = plan_cuts(dur, sil, a.target_min * 60, a.max_min * 60)
    print(f"PLAN: {dur/60:.1f} min input, {len(sil)} silences -> {len(chunks)} chunks", file=sys.stderr)

    tmp = Path(tempfile.mkdtemp(prefix="voicesep_"))
    stems = []
    try:
        for i, (t0, t1) in enumerate(chunks):
            cw = tmp / f"chunk_{i:04d}.wav"
            extract_chunk(a.ffmpeg, a.input, t0, t1, cw)
            if is_silent(a.ffmpeg, cw):
                # Muted/zero stretch — don't feed the separator (it errors); emit
                # matching-length silence directly.
                stem = tmp / f"sil_{i:04d}.wav"
                to_16bit_silence(a.ffmpeg, cw, stem)
                stems.append(stem)
                cw.unlink(missing_ok=True)
                print(f"CHUNK {i+1}/{len(chunks)} ({t0/60:.1f}-{t1/60:.1f}min) SILENT -> passthrough", file=sys.stderr)
                continue
            stem = separate_chunk(a.sep_python, a.launcher, cw, tmp / f"out_{i:04d}",
                                  a.model_dir, a.model, str(Path(a.ffmpeg).resolve().parent))
            stems.append(stem)
            cw.unlink(missing_ok=True)  # free chunk input immediately
            print(f"CHUNK {i+1}/{len(chunks)} ({t0/60:.1f}-{t1/60:.1f}min) -> {stem.name}", file=sys.stderr)
        concat_resample(a.ffmpeg, stems, a.output, a.target_sr)
        print(f"DONE {a.output} ({len(chunks)} chunks, {a.target_sr}Hz)", file=sys.stderr)
    finally:
        if not a.keep_temp:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
