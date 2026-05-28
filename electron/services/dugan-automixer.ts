// electron/services/dugan-automixer.ts
import { spawn } from 'child_process';
import * as log from 'electron-log';
import * as path from 'path';
import * as fs from 'fs';
import { BinaryResolver } from './binary-resolver';

// --- Dugan Config ---
const WINDOW_MS = 80;       // RMS analysis window
const HOP_MS = 20;          // Gain recalculation interval
const SMOOTH_KERNEL = 3;    // Moving-average kernel size (frames)
const FLOOR_GAIN = 0.05;    // Never fully mute (preserves room tone)
const EPSILON = 1e-10;      // Prevent division by zero

export interface DuganTrack {
  type: string;       // e.g. 'mic1', 'mic2', 'screen'
  filePath: string;   // Absolute path to WAV file
}

export interface DuganResult {
  type: string;
  filePath: string;   // Path to the processed file (overwrites input)
}

interface ProbeInfo {
  codec: string;
  sampleRate: number;
  channels: number;
}

/**
 * Dugan-style automixer for N audio tracks.
 *
 * Uses a two-pass approach to keep memory usage low:
 *   Pass 1 — Decode each track to mono, compute RMS, free immediately
 *   Pass 2 — Decode each track (full channels), apply gains, encode
 *
 * Only one track's raw PCM is in memory at a time.
 *
 * For each time window:
 *   gain_i = rms_i / (sum(all rms) + epsilon)
 *
 * The loudest source keeps most of its volume.
 * Quieter sources (bleed/background) get attenuated.
 */
export class DuganAutomixer {
  private binaryResolver: BinaryResolver;

  constructor() {
    this.binaryResolver = new BinaryResolver();
  }

  /**
   * Run the Dugan automixer on an array of audio tracks.
   * Overwrites each input file in-place with the gain-adjusted version.
   */
  async process(tracks: DuganTrack[]): Promise<DuganResult[]> {
    if (tracks.length < 2) {
      log.info('DuganAutomixer: fewer than 2 tracks, nothing to do');
      return tracks.map(t => ({ type: t.type, filePath: t.filePath }));
    }

    log.info(`DuganAutomixer: processing ${tracks.length} tracks`);

    // 1. Probe all tracks in parallel (tiny data)
    const probes: ProbeInfo[] = await Promise.all(
      tracks.map(track => this.probeTrack(track.filePath))
    );
    for (let i = 0; i < tracks.length; i++) {
      log.info(`  ${tracks[i].type}: codec=${probes[i].codec} rate=${probes[i].sampleRate} ch=${probes[i].channels}`);
    }

    // Verify all tracks have the same sample rate
    const sampleRate = probes[0].sampleRate;
    for (let i = 1; i < probes.length; i++) {
      if (probes[i].sampleRate !== sampleRate) {
        throw new Error(
          `Sample rate mismatch: ${tracks[0].type}=${sampleRate} vs ${tracks[i].type}=${probes[i].sampleRate}`
        );
      }
    }

    const windowSamples = Math.floor(sampleRate * WINDOW_MS / 1000);
    const hopSamples = Math.floor(sampleRate * HOP_MS / 1000);

    // ── PASS 1: Analysis ──────────────────────────────────────────────
    // Decode each track to MONO f32le, compute RMS, then free.
    // Only one track's mono PCM is in memory at a time.
    // After this pass, only the tiny RMS arrays remain (~2.5MB each).
    log.info('  Pass 1: computing RMS for each track...');

    const rmsArrays: Float32Array[] = [];
    const monoLengths: number[] = [];

    for (let i = 0; i < tracks.length; i++) {
      const mono = await this.decodeToF32(tracks[i].filePath, probes[i], true);
      monoLengths.push(mono.length);
      log.info(`  Decoded mono ${tracks[i].type}: ${mono.length} samples (${(mono.length / sampleRate).toFixed(1)}s)`);

      const analysisLen = mono.length;  // Will use shortest for gain calc below
      const numFrames = Math.floor((analysisLen - windowSamples) / hopSamples) + 1;
      const rms = this.computeRmsFrames(mono, windowSamples, hopSamples, numFrames);
      rmsArrays.push(rms);
      // mono goes out of scope here — GC can reclaim ~2.5GB
    }

    // Use shortest track for gain analysis
    const analysisLen = Math.min(...monoLengths);
    const numFrames = Math.floor((analysisLen - windowSamples) / hopSamples) + 1;

    // Trim RMS arrays to common frame count
    for (let i = 0; i < rmsArrays.length; i++) {
      if (rmsArrays[i].length > numFrames) {
        rmsArrays[i] = rmsArrays[i].subarray(0, numFrames);
      }
    }

    log.info(`  RMS: ${numFrames} frames, window=${windowSamples} hop=${hopSamples}`);
    log.info(`  Analysis region: ${(analysisLen / sampleRate).toFixed(1)}s`);

    // ── Compute Dugan gains ───────────────────────────────────────────
    const totalEnergy = new Float32Array(numFrames);
    for (let f = 0; f < numFrames; f++) {
      let sum = EPSILON;
      for (const rms of rmsArrays) {
        sum += rms[f];
      }
      totalEnergy[f] = sum;
    }

    const smoothedGains: Float32Array[] = rmsArrays.map(rms => {
      const g = new Float32Array(numFrames);
      for (let f = 0; f < numFrames; f++) {
        g[f] = Math.max(FLOOR_GAIN, Math.min(1.0, rms[f] / totalEnergy[f]));
      }
      return this.smoothGains(g, SMOOTH_KERNEL);
    });

    // Frame center positions for interpolation
    const windowHalf = Math.floor(windowSamples / 2);
    const firstCenter = windowHalf;
    const lastCenter = (numFrames - 1) * hopSamples + windowHalf;

    // Log detailed gain statistics per track
    for (let i = 0; i < tracks.length; i++) {
      let minGain = Infinity, maxGain = -Infinity, sumGain = 0;
      let minRms = Infinity, maxRms = -Infinity, sumRms = 0;
      const threshold = 1.0 / tracks.length + 0.1;
      let dominant = 0;

      for (let f = 0; f < numFrames; f++) {
        const g = smoothedGains[i][f];
        const r = rmsArrays[i][f];
        if (g < minGain) minGain = g;
        if (g > maxGain) maxGain = g;
        sumGain += g;
        if (r < minRms) minRms = r;
        if (r > maxRms) maxRms = r;
        sumRms += r;
        if (g > threshold) dominant++;
      }
      const avgGain = sumGain / numFrames;
      const avgRms = sumRms / numFrames;
      const pct = (dominant / numFrames * 100).toFixed(1);

      log.info(`  ${tracks[i].type}: gain min=${minGain.toFixed(4)} max=${maxGain.toFixed(4)} avg=${avgGain.toFixed(4)} | rms avg=${avgRms.toFixed(6)} peak=${maxRms.toFixed(6)} | dominant=${pct}%`);
    }

    // ── PASS 2: Apply gains + encode ──────────────────────────────────
    // Decode each track at full channel count, apply gains, encode back.
    // One track at a time to keep memory in check.
    log.info('  Pass 2: applying gains and encoding...');

    const results: DuganResult[] = [];

    for (let i = 0; i < tracks.length; i++) {
      const ch = probes[i].channels;
      const trackGains = smoothedGains[i];

      // Decode full-channel PCM
      const raw = await this.decodeToF32(tracks[i].filePath, probes[i], false);
      const totalSamples = raw.length;
      const monoSamples = Math.floor(totalSamples / ch);

      log.info(`  Applying gains to ${tracks[i].type}: ${monoSamples} samples, ${ch}ch`);

      // Apply gains in-place to avoid allocating a second large buffer
      let frameIdx = 0;
      for (let s = 0; s < monoSamples; s++) {
        let gain: number;

        if (s <= firstCenter) {
          gain = trackGains[0];
        } else if (s >= lastCenter) {
          gain = trackGains[numFrames - 1];
        } else {
          // Linear walk — advance frame as samples progress
          while (frameIdx < numFrames - 2) {
            const nextCenter = (frameIdx + 1) * hopSamples + windowHalf;
            if (s < nextCenter) break;
            frameIdx++;
          }
          const center0 = frameIdx * hopSamples + windowHalf;
          const center1 = (frameIdx + 1) * hopSamples + windowHalf;
          const t = (s - center0) / (center1 - center0);
          gain = trackGains[frameIdx] + t * (trackGains[frameIdx + 1] - trackGains[frameIdx]);
        }

        const base = s * ch;
        for (let c = 0; c < ch; c++) {
          raw[base + c] *= gain;
        }
      }

      // Reset frame index for next track
      frameIdx = 0;

      // Encode back to original codec, overwriting input
      await this.encodeFromF32(raw, tracks[i].filePath, probes[i]);
      results.push({ type: tracks[i].type, filePath: tracks[i].filePath });
      log.info(`  Wrote ${tracks[i].type}: ${tracks[i].filePath} (${(monoSamples / sampleRate).toFixed(1)}s)`);
      // raw goes out of scope — GC reclaims ~5GB
    }

    log.info(`DuganAutomixer: DONE — ${results.length} tracks processed and overwritten in-place`);
    return results;
  }

  /**
   * Probe a WAV file for codec, sample rate, and channel count.
   */
  private probeTrack(filePath: string): Promise<ProbeInfo> {
    return new Promise((resolve, reject) => {
      const ffprobe = this.binaryResolver.getFfprobePath();
      const args = [
        '-hide_banner',
        '-show_entries', 'stream=codec_name,sample_rate,channels',
        '-select_streams', 'a:0',
        '-of', 'csv=p=0:s=,',
        filePath
      ];

      const proc = spawn(ffprobe, args);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`ffprobe failed (${code}): ${stderr}`));
        }

        // Parse CSV output: codec_name,sample_rate,channels
        let codec = 'pcm_s24le';
        let sampleRate = 48000;
        let channels = 1;

        for (const line of stdout.trim().split('\n')) {
          const parts = line.trim().split(',');
          if (parts.length >= 3) {
            if (parts[0].startsWith('pcm_')) codec = parts[0];
            const sr = parseInt(parts[1], 10);
            if (!isNaN(sr)) sampleRate = sr;
            const ch = parseInt(parts[2], 10);
            if (!isNaN(ch)) channels = ch;
          }
        }

        resolve({ codec, sampleRate, channels });
      });

      proc.on('error', reject);
    });
  }

  /**
   * Decode a WAV file to raw f32le PCM using ffmpeg.
   * If mono=true, downmixes to 1 channel (for RMS analysis pass).
   * Writes decoded PCM to a temp file on disk, then reads it back
   * into a single Float32Array — avoids double-memory from buffering
   * chunks in RAM alongside the final ArrayBuffer.
   */
  private decodeToF32(filePath: string, info: ProbeInfo, mono: boolean): Promise<Float32Array> {
    return new Promise((resolve, reject) => {
      const ffmpeg = this.binaryResolver.getFfmpegPath();
      const tmpPcm = filePath + `.dugan_pcm_${mono ? 'mono' : 'full'}.raw`;
      const args = [
        '-y',
        '-i', filePath,
        '-f', 'f32le',
        '-acodec', 'pcm_f32le',
        '-ar', info.sampleRate.toString(),
        '-ac', mono ? '1' : info.channels.toString(),
        '-v', 'error',
        tmpPcm
      ];

      const proc = spawn(ffmpeg, args);
      let stderr = '';

      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          try { fs.unlinkSync(tmpPcm); } catch {}
          return reject(new Error(`ffmpeg decode failed (${code}): ${stderr}`));
        }

        try {
          // Read the temp file directly into a Float32Array — single allocation
          const buf = fs.readFileSync(tmpPcm);
          fs.unlinkSync(tmpPcm);

          const numSamples = Math.floor(buf.byteLength / 4);
          const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + numSamples * 4);
          resolve(new Float32Array(ab));
        } catch (err) {
          try { fs.unlinkSync(tmpPcm); } catch {}
          reject(err);
        }
      });

      proc.on('error', (err) => {
        try { fs.unlinkSync(tmpPcm); } catch {}
        reject(err);
      });
    });
  }

  /**
   * Encode raw f32le PCM back to the original codec via ffmpeg, overwriting the file.
   */
  private encodeFromF32(samples: Float32Array, filePath: string, info: ProbeInfo): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffmpeg = this.binaryResolver.getFfmpegPath();
      // Write to a temp file first, then rename to avoid corruption
      const tmpPath = filePath + '.dugan_tmp.wav';
      const args = [
        '-y',
        '-f', 'f32le',
        '-ar', info.sampleRate.toString(),
        '-ac', info.channels.toString(),
        '-i', 'pipe:0',
        '-c:a', info.codec,
        '-ar', info.sampleRate.toString(),
        tmpPath
      ];

      const proc = spawn(ffmpeg, args);
      let stderr = '';

      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          // Clean up temp file on error
          try { fs.unlinkSync(tmpPath); } catch {}
          return reject(new Error(`ffmpeg encode failed (${code}): ${stderr}`));
        }

        // Rename temp file over original
        try {
          fs.renameSync(tmpPath, filePath);
          resolve();
        } catch (err) {
          // Clean up temp file on rename error
          try { fs.unlinkSync(tmpPath); } catch {}
          reject(err);
        }
      });

      proc.on('error', (err) => {
        try { fs.unlinkSync(tmpPath); } catch {}
        reject(err);
      });

      // Write raw PCM data to ffmpeg stdin in chunks to avoid backpressure issues
      const totalBytes = samples.byteLength;
      const CHUNK_SIZE = 1024 * 1024; // 1MB chunks
      let offset = 0;

      const writeNextChunk = () => {
        while (offset < totalBytes) {
          const end = Math.min(offset + CHUNK_SIZE, totalBytes);
          const chunk = Buffer.from(
            samples.buffer.slice(samples.byteOffset + offset, samples.byteOffset + end)
          );
          offset = end;

          if (offset >= totalBytes) {
            // Last chunk — end stdin after it's written
            proc.stdin.write(chunk, () => { proc.stdin.end(); });
            return;
          }

          const canContinue = proc.stdin.write(chunk);
          if (!canContinue) {
            // Backpressure — wait for drain before writing more
            proc.stdin.once('drain', writeNextChunk);
            return;
          }
        }
        // Should not reach here, but just in case
        proc.stdin.end();
      };

      writeNextChunk();
    });
  }

  /**
   * Compute RMS energy over sliding windows.
   */
  private computeRmsFrames(
    signal: Float32Array,
    windowSamples: number,
    hopSamples: number,
    numFrames: number
  ): Float32Array {
    const rms = new Float32Array(numFrames);
    for (let f = 0; f < numFrames; f++) {
      const start = f * hopSamples;
      let sumSq = 0;
      for (let s = start; s < start + windowSamples && s < signal.length; s++) {
        sumSq += signal[s] * signal[s];
      }
      rms[f] = Math.sqrt(sumSq / windowSamples);
    }
    return rms;
  }

  /**
   * Smooth gains with a moving average kernel.
   */
  private smoothGains(gains: Float32Array, kernelSize: number): Float32Array {
    if (kernelSize <= 1) return gains;
    const smoothed = new Float32Array(gains.length);
    const half = Math.floor(kernelSize / 2);
    for (let i = 0; i < gains.length; i++) {
      let sum = 0;
      let count = 0;
      for (let k = -half; k <= half; k++) {
        const idx = i + k;
        if (idx >= 0 && idx < gains.length) {
          sum += gains[idx];
          count++;
        }
      }
      smoothed[i] = sum / count;
    }
    return smoothed;
  }
}
