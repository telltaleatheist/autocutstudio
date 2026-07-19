// electron/services/alignment-audio-service.ts
import { spawn } from 'child_process';
import * as log from 'electron-log';
import { BinaryResolver } from './binary-resolver';

/**
 * Main-process audio service backing the manual-alignment wizard.
 *
 * Everything here streams through ffmpeg (decode to mono f32le) — adapted from the
 * dugan-automixer streaming pattern — and FAILS LOUD: a non-zero ffmpeg exit rejects
 * with the stderr tail; a silent/empty file rejects with a specific message. It never
 * returns a fabricated or zero-filled envelope as success (project doctrine).
 *
 * Two decode resolutions are used:
 *   - a coarse full-file pass (SCAN_SAMPLE_RATE) to locate first/last sustained audio,
 *   - fine per-window passes for the 10 s zoom peaks and for playback samples.
 */

// ── Sustained-audio detection constants ─────────────────────────────────────
// The coarse scan only needs an amplitude envelope, so it decodes at a very low
// sample rate (fast, tiny). "Sustained" = a run of consecutive above-threshold
// windows long enough to be real audio rather than a click/pop.
const SCAN_SAMPLE_RATE = 1000;          // Hz, mono — envelope only, no fidelity needed
const ACTIVITY_WINDOW_SEC = 0.05;       // 50 ms non-overlapping RMS windows (20 / second)
const SUSTAINED_MIN_SEC = 0.30;         // a run must last >= 300 ms to count as sustained audio
const ACTIVITY_THRESHOLD_RATIO = 0.05;  // a window is "active" if RMS >= 5% of the file's peak-window RMS

// Fine peak extraction resolution for the zoom windows. 8 kHz mono preserves the
// waveform envelope (transients) well while keeping the decoded segment small.
const PEAK_SAMPLE_RATE = 8000;          // Hz, mono

export interface PeakData {
  min: number[];
  max: number[];
  buckets: number;
}

export interface ActivityScan {
  durationSec: number;
  firstSustainedSec: number;
  lastSustainedSec: number;
}

export interface SegmentSamples {
  sampleRate: number;
  samples: Float32Array;
}

export class AlignmentAudioService {
  private binaryResolver = new BinaryResolver();

  /**
   * Decode part (or all) of a file to mono f32le at `sampleRate` and return the
   * raw Float32 samples. When start/duration are null the whole file is decoded.
   * `-ss`/`-t` are placed before `-i` for fast input seeking.
   */
  private decode(filePath: string, startSec: number | null, durationSec: number | null,
                 sampleRate: number): Promise<Float32Array> {
    return new Promise((resolve, reject) => {
      const ffmpeg = this.binaryResolver.getFfmpegPath();
      const args: string[] = [];
      if (startSec !== null && startSec > 0) args.push('-ss', startSec.toFixed(6));
      if (durationSec !== null) args.push('-t', durationSec.toFixed(6));
      args.push(
        '-i', filePath,
        '-f', 'f32le',
        '-acodec', 'pcm_f32le',
        '-ar', String(sampleRate),
        '-ac', '1',
        '-v', 'error',
        'pipe:1'
      );

      const proc = spawn(ffmpeg, args);
      const chunks: Buffer[] = [];
      let stderr = '';

      proc.stdout.on('data', (c: Buffer) => chunks.push(c));
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        proc.stdout.removeAllListeners();
        proc.stderr.removeAllListeners();
        proc.removeAllListeners();
        if (code !== 0) {
          return reject(new Error(
            `ffmpeg decode failed (${code}) for ${filePath}: ${stderr.trim().slice(-500)}`));
        }
        const buf = Buffer.concat(chunks);
        const usable = Math.floor(buf.length / 4);
        const out = new Float32Array(usable);
        for (let i = 0; i < usable; i++) out[i] = buf.readFloatLE(i * 4);
        resolve(out);
      });

      proc.on('error', (err) => {
        proc.stdout.removeAllListeners();
        proc.stderr.removeAllListeners();
        proc.removeAllListeners();
        reject(err);
      });
    });
  }

  /**
   * Coarse full-file scan → duration + first/last sustained-audio times (seconds).
   * FAILS LOUD when the file decodes to silence (no sustained region found).
   */
  async scanActivity(filePath: string): Promise<ActivityScan> {
    const samples = await this.decode(filePath, null, null, SCAN_SAMPLE_RATE);
    const durationSec = samples.length / SCAN_SAMPLE_RATE;

    const win = Math.max(1, Math.round(ACTIVITY_WINDOW_SEC * SCAN_SAMPLE_RATE));
    const nWindows = Math.floor(samples.length / win);
    if (nWindows === 0) {
      throw new Error(`Audio file too short to analyse: ${filePath}`);
    }

    const rms = new Float32Array(nWindows);
    let peak = 0;
    for (let w = 0; w < nWindows; w++) {
      let sumSq = 0;
      const base = w * win;
      for (let i = 0; i < win; i++) {
        const s = samples[base + i];
        sumSq += s * s;
      }
      const r = Math.sqrt(sumSq / win);
      rms[w] = r;
      if (r > peak) peak = r;
    }

    if (peak <= 0) {
      throw new Error(`No audio energy detected (silent file): ${filePath}`);
    }

    const threshold = peak * ACTIVITY_THRESHOLD_RATIO;
    const minRun = Math.max(1, Math.ceil(SUSTAINED_MIN_SEC / ACTIVITY_WINDOW_SEC));

    // First sustained run.
    let firstSustained = -1;
    let run = 0;
    for (let w = 0; w < nWindows; w++) {
      if (rms[w] >= threshold) {
        run++;
        if (run >= minRun) { firstSustained = (w - minRun + 1) * ACTIVITY_WINDOW_SEC; break; }
      } else {
        run = 0;
      }
    }

    // Last sustained run (scan from the end).
    let lastSustained = -1;
    run = 0;
    for (let w = nWindows - 1; w >= 0; w--) {
      if (rms[w] >= threshold) {
        run++;
        if (run >= minRun) { lastSustained = (w + minRun) * ACTIVITY_WINDOW_SEC; break; }
      } else {
        run = 0;
      }
    }

    if (firstSustained < 0 || lastSustained < 0) {
      throw new Error(`No sustained audio found in ${filePath} (all below ${(ACTIVITY_THRESHOLD_RATIO * 100).toFixed(0)}% of peak)`);
    }

    return {
      durationSec,
      firstSustainedSec: firstSustained,
      lastSustainedSec: Math.min(lastSustained, durationSec),
    };
  }

  /** Duration in seconds via ffprobe. */
  getDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const ffprobe = this.binaryResolver.getFfprobePath();
      const proc = spawn(ffprobe, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=nokey=1:noprint_wrappers=1',
        filePath
      ]);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        proc.removeAllListeners();
        const dur = parseFloat(stdout.trim());
        if (code !== 0 || !isFinite(dur)) {
          return reject(new Error(`ffprobe duration failed for ${filePath}: ${stderr.trim().slice(-300)}`));
        }
        resolve(dur);
      });
      proc.on('error', reject);
    });
  }

  /**
   * Fine min/max peak envelope for a zoom window. Decodes [startSec, startSec+durationSec]
   * to mono f32le at PEAK_SAMPLE_RATE and buckets the samples into `buckets` min/max pairs.
   */
  async extractPeaks(filePath: string, startSec: number, durationSec: number,
                     buckets: number): Promise<PeakData> {
    const samples = await this.decode(filePath, Math.max(0, startSec), durationSec, PEAK_SAMPLE_RATE);
    const n = Math.max(1, Math.floor(buckets));
    const min = new Array<number>(n).fill(0);
    const max = new Array<number>(n).fill(0);
    // Bucket against the EXPECTED sample count for the requested duration, not the
    // number actually returned. A window that runs past end-of-file decodes to fewer
    // samples; bucketing against expected keeps time-to-x mapping honest (the tail
    // reads as trailing silence) instead of stretching partial content across the width.
    const expected = Math.max(1, Math.round(durationSec * PEAK_SAMPLE_RATE));
    if (samples.length === 0) {
      return { min, max, buckets: n };
    }
    const per = expected / n;
    for (let b = 0; b < n; b++) {
      const s0 = Math.floor(b * per);
      const s1 = Math.min(samples.length, Math.floor((b + 1) * per));
      let lo = 0, hi = 0;
      for (let i = s0; i < s1; i++) {
        const v = samples[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[b] = lo;
      max[b] = hi;
    }
    return { min, max, buckets: n };
  }

  /**
   * Decode a small segment to mono f32le at `sampleRate` for WebAudio playback.
   * Returns the raw Float32 samples the renderer turns into an AudioBuffer.
   */
  async extractSamples(filePath: string, startSec: number, durationSec: number,
                       sampleRate: number): Promise<SegmentSamples> {
    const samples = await this.decode(filePath, Math.max(0, startSec), durationSec, sampleRate);
    return { sampleRate, samples };
  }
}
