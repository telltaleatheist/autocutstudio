#!/usr/bin/env python3
"""
Dugan-style automixer for N microphone tracks.

For each time window:
    gain_i = energy_i / (energy_1 + energy_2 + ... + energy_N)

The louder mic (direct speech) keeps most of its volume.
The quieter mics (bleed) get attenuated.
"""

import numpy as np
import scipy.io.wavfile as wav
import subprocess
import sys
import os

# --- Config ---
WINDOW_MS = 80       # RMS analysis window
HOP_MS = 20          # Gain recalculation interval
SMOOTH_MS = 60       # Smoothing to avoid clicks
FLOOR_GAIN = 0.05    # Never fully mute (preserves room tone)
EPSILON = 1e-10      # Prevent division by zero

mic_paths = sys.argv[1:]
if len(mic_paths) < 2:
    print("Usage: dugan_test.py mic1.wav mic2.wav [mic3.wav ...]")
    sys.exit(1)

out_dir = os.path.dirname(mic_paths[0])
num_mics = len(mic_paths)
print(f"Processing {num_mics} mics")

# Load all tracks
tracks = []
sample_rate = None
orig_dtype = None
for i, path in enumerate(mic_paths):
    print(f"Loading mic {i+1}: {os.path.basename(path)}")
    sr, data = wav.read(path)
    if sample_rate is None:
        sample_rate = sr
        orig_dtype = data.dtype
    else:
        assert sr == sample_rate, f"Sample rate mismatch on mic {i+1}: {sr} vs {sample_rate}"
    tracks.append(data)

# Convert to float64 [-1, 1]
def to_float(data):
    if data.dtype == np.int16:
        return data.astype(np.float64) / 32768.0
    elif data.dtype == np.int32:
        return data.astype(np.float64) / 2147483648.0
    elif data.dtype == np.float32:
        return data.astype(np.float64)
    return data.astype(np.float64)

def to_mono(d):
    return d.mean(axis=1) if d.ndim == 2 else d

tracks = [to_float(t) for t in tracks]
monos = [to_mono(t) for t in tracks]

# Match lengths
min_len = min(len(m) for m in monos)
monos = [m[:min_len] for m in monos]
tracks = [t[:min_len] for t in tracks]

print(f"Sample rate: {sample_rate} Hz | Duration: {min_len / sample_rate:.1f}s")

window_samples = int(sample_rate * WINDOW_MS / 1000)
hop_samples = int(sample_rate * HOP_MS / 1000)
num_frames = (min_len - window_samples) // hop_samples + 1

# Vectorized RMS computation
def compute_rms_frames(signal, window_samples, hop_samples, num_frames):
    frames = np.lib.stride_tricks.as_strided(
        signal,
        shape=(num_frames, window_samples),
        strides=(signal.strides[0] * hop_samples, signal.strides[0])
    )
    return np.sqrt(np.mean(frames ** 2, axis=1))

print(f"Computing RMS energy for {num_frames} frames across {num_mics} mics...")
rms = [compute_rms_frames(m, window_samples, hop_samples, num_frames) for m in monos]

# Dugan: gain_i = energy_i / sum(all energies)
total_energy = sum(rms) + EPSILON
gains = [np.clip(r / total_energy, FLOOR_GAIN, 1.0) for r in rms]

# Smooth gains
smooth_n = max(1, int(SMOOTH_MS / HOP_MS))
if smooth_n > 1:
    kernel = np.ones(smooth_n) / smooth_n
    gains = [np.convolve(g, kernel, mode='same') for g in gains]

# Interpolate to sample level
frame_centers = np.arange(num_frames) * hop_samples + window_samples // 2
sample_indices = np.arange(min_len)

print("Interpolating & applying gains...")
gains_sample = [np.interp(sample_indices, frame_centers, g) for g in gains]

outputs = []
for i in range(num_mics):
    if tracks[i].ndim == 2:
        out = tracks[i] * gains_sample[i][:, np.newaxis]
    else:
        out = tracks[i] * gains_sample[i]
    outputs.append(out)

# Convert back and write
def from_float(data, dtype):
    if dtype == np.int16:
        return np.clip(data * 32768.0, -32768, 32767).astype(np.int16)
    elif dtype == np.int32:
        return np.clip(data * 2147483648.0, -2147483648, 2147483647).astype(np.int32)
    return data.astype(np.float32)

def write_wav_fcpx(data, sr, out_path, source_path):
    """Pipe raw float64 PCM to ffmpeg, using source file as format reference."""
    # Probe source for codec and channel count
    result = subprocess.run(
        ["ffprobe", "-hide_banner", "-show_entries", "stream=codec_name,channels",
         "-select_streams", "a:0", "-of", "csv=p=0:s=,", source_path],
        capture_output=True, text=True
    )
    codec = "pcm_s24le"
    channels = 1
    for line in result.stdout.strip().split('\n'):
        parts = line.strip().split(',')
        if len(parts) >= 2:
            if parts[0].startswith('pcm_'):
                codec = parts[0]
            try:
                channels = int(parts[1])
            except ValueError:
                pass

    # Write raw f64 PCM and let ffmpeg handle all WAV formatting
    raw = data.astype(np.float64).tobytes()
    proc = subprocess.run([
        "ffmpeg", "-y",
        "-f", "f64le", "-ar", str(sr), "-ac", str(channels), "-i", "pipe:0",
        "-c:a", codec, "-ar", str(sr), out_path
    ], input=raw, capture_output=True)
    if proc.returncode != 0:
        print(f"  ffmpeg error: {proc.stderr.decode()[-200:]}")

for i in range(num_mics):
    basename = os.path.splitext(os.path.basename(mic_paths[i]))[0]
    out_path = os.path.join(out_dir, f"{basename}_DUGAN.wav")
    print(f"Writing: {os.path.basename(out_path)}")
    write_wav_fcpx(outputs[i], sample_rate, out_path, mic_paths[i])

# Stats
print(f"\n--- Stats ---")
for i in range(num_mics):
    dominant = np.sum(gains[i] > (1.0 / num_mics + 0.1)) / num_frames * 100
    print(f"Mic {i+1} dominant: {dominant:.1f}%")
print("Done!")
