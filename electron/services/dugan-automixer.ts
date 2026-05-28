// electron/services/dugan-automixer.ts
import { spawn, ChildProcess } from 'child_process';
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
 * Fully streaming — never loads an entire file into memory.
 * Handles files of any size (tested with multi-GiB WAV files).
 *
 *   Pass 1 — Stream-decode each track to mono, compute RMS on the fly
 *   Pass 2 — Stream-decode → apply gains → pipe to encoder
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

    // 1. Probe all tracks in parallel
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

    // ── PASS 1: Streaming RMS Analysis ────────────────────────────────
    // Stream-decode each track to mono f32le, compute RMS on the fly.
    // Only a small sliding window buffer is in memory at any time.
    log.info('  Pass 1: streaming RMS computation for each track...');

    const rmsArrays: Float32Array[] = [];
    const monoLengths: number[] = [];

    for (let i = 0; i < tracks.length; i++) {
      const { rms, totalSamples } = await this.streamComputeRms(
        tracks[i].filePath, probes[i], windowSamples, hopSamples
      );
      rmsArrays.push(rms);
      monoLengths.push(totalSamples);
      log.info(`  ${tracks[i].type}: ${totalSamples} samples (${(totalSamples / sampleRate).toFixed(1)}s), ${rms.length} RMS frames`);
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

    // ── PASS 2: Streaming gain application + encode ───────────────────
    // Stream-decode each track, apply gains on the fly, pipe to encoder.
    // Only one small chunk is in memory at a time.
    log.info('  Pass 2: streaming gain application and encoding...');

    const results: DuganResult[] = [];

    for (let i = 0; i < tracks.length; i++) {
      const ch = probes[i].channels;
      const trackGains = smoothedGains[i];

      log.info(`  Processing ${tracks[i].type}: ${ch}ch, ${numFrames} gain frames`);

      await this.streamApplyGains(
        tracks[i].filePath, probes[i], trackGains,
        numFrames, hopSamples, windowHalf, firstCenter, lastCenter
      );

      results.push({ type: tracks[i].type, filePath: tracks[i].filePath });
      log.info(`  Wrote ${tracks[i].type}: ${tracks[i].filePath}`);
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
        '-hide_banner', '-v', 'error',
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
            // Accept any codec (not just pcm_*)
            if (parts[0]) codec = parts[0];
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
   * Stream-decode a track to mono f32le and compute RMS frames on the fly.
   * Never loads the entire file into memory — only keeps a sliding window buffer.
   */
  private streamComputeRms(
    filePath: string,
    info: ProbeInfo,
    windowSamples: number,
    hopSamples: number
  ): Promise<{ rms: Float32Array; totalSamples: number }> {
    return new Promise((resolve, reject) => {
      const ffmpeg = this.binaryResolver.getFfmpegPath();
      const args = [
        '-i', filePath,
        '-f', 'f32le',
        '-acodec', 'pcm_f32le',
        '-ar', info.sampleRate.toString(),
        '-ac', '1',
        '-v', 'error',
        'pipe:1'
      ];

      const proc = spawn(ffmpeg, args);
      let stderr = '';

      // Accumulate RMS frames in a growable array
      const rmsChunks: number[] = [];

      // Sliding window state
      let totalSamples = 0;
      let leftoverBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

      // Running sum-of-squares for windowed RMS
      // We use a ring buffer approach: maintain sumSq over the current window,
      // and advance sample by sample.
      let windowBuf = new Float32Array(windowSamples);
      let windowPos = 0;          // Next write position in ring buffer
      let windowFilled = 0;       // How many samples are in the window
      let sumSq = 0;
      let samplesSinceLastFrame = 0;
      let firstWindowComplete = false;

      proc.stdout.on('data', (chunk: Buffer) => {
        // Prepend any leftover bytes from previous chunk
        let data: Buffer;
        if (leftoverBuf.length > 0) {
          data = Buffer.concat([leftoverBuf, chunk]);
          leftoverBuf = Buffer.alloc(0);
        } else {
          data = chunk;
        }

        // Handle partial float at end of chunk
        const usableBytes = Math.floor(data.length / 4) * 4;
        if (data.length > usableBytes) {
          leftoverBuf = data.subarray(usableBytes);
        }

        // Process samples
        for (let byteOff = 0; byteOff < usableBytes; byteOff += 4) {
          const sample = data.readFloatLE(byteOff);

          // Remove oldest sample from running sum if window is full
          if (windowFilled >= windowSamples) {
            const oldest = windowBuf[windowPos];
            sumSq -= oldest * oldest;
          }

          // Add new sample
          windowBuf[windowPos] = sample;
          sumSq += sample * sample;
          windowPos = (windowPos + 1) % windowSamples;
          if (windowFilled < windowSamples) windowFilled++;

          totalSamples++;
          samplesSinceLastFrame++;

          // Once we have a full window, start emitting RMS frames
          if (windowFilled >= windowSamples) {
            if (!firstWindowComplete) {
              // First complete window — emit first frame
              rmsChunks.push(Math.sqrt(Math.max(0, sumSq) / windowSamples));
              samplesSinceLastFrame = 0;
              firstWindowComplete = true;
            } else if (samplesSinceLastFrame >= hopSamples) {
              // Emit frame at each hop
              rmsChunks.push(Math.sqrt(Math.max(0, sumSq) / windowSamples));
              samplesSinceLastFrame = 0;
            }
          }
        }
      });

      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`ffmpeg RMS decode failed (${code}): ${stderr}`));
        }

        const rms = new Float32Array(rmsChunks);
        resolve({ rms, totalSamples });
      });

      proc.on('error', reject);
    });
  }

  /**
   * Stream-decode a track, apply Dugan gains on the fly, and pipe to encoder.
   * Overwrites the input file in-place.
   * Never loads the entire file into memory.
   */
  private streamApplyGains(
    filePath: string,
    info: ProbeInfo,
    trackGains: Float32Array,
    numFrames: number,
    hopSamples: number,
    windowHalf: number,
    firstCenter: number,
    lastCenter: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffmpeg = this.binaryResolver.getFfmpegPath();
      const ch = info.channels;
      const tmpPath = filePath + '.dugan_tmp.wav';

      // Spawn decoder: input file → f32le pipe
      const decoder = spawn(ffmpeg, [
        '-i', filePath,
        '-f', 'f32le',
        '-acodec', 'pcm_f32le',
        '-ar', info.sampleRate.toString(),
        '-ac', ch.toString(),
        '-v', 'error',
        'pipe:1'
      ]);

      // Spawn encoder: f32le pipe → output file
      const encoder = spawn(ffmpeg, [
        '-y',
        '-f', 'f32le',
        '-ar', info.sampleRate.toString(),
        '-ac', ch.toString(),
        '-i', 'pipe:0',
        '-c:a', info.codec,
        '-v', 'error',
        tmpPath
      ]);

      let decodeStderr = '';
      let encodeStderr = '';
      let decoderDone = false;
      let encoderDone = false;
      let hadError = false;

      decoder.stderr.on('data', (d: Buffer) => { decodeStderr += d.toString(); });
      encoder.stderr.on('data', (d: Buffer) => { encodeStderr += d.toString(); });

      const cleanup = (err?: Error) => {
        if (hadError) return;
        hadError = true;
        try { decoder.kill(); } catch {}
        try { encoder.kill(); } catch {}
        try { fs.unlinkSync(tmpPath); } catch {}
        reject(err || new Error('Unknown error in streamApplyGains'));
      };

      const tryFinalize = () => {
        if (!decoderDone || !encoderDone) return;

        // Rename temp file over original
        try {
          fs.renameSync(tmpPath, filePath);
          resolve();
        } catch (err) {
          try { fs.unlinkSync(tmpPath); } catch {}
          reject(err);
        }
      };

      // Gain application state
      let monoSampleIdx = 0;   // Current mono sample position
      let frameIdx = 0;        // Current gain frame index
      let leftoverBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

      decoder.stdout.on('data', (chunk: Buffer) => {
        // Prepend leftover bytes
        let data: Buffer;
        if (leftoverBuf.length > 0) {
          data = Buffer.concat([leftoverBuf, chunk]);
          leftoverBuf = Buffer.alloc(0);
        } else {
          data = chunk;
        }

        // Need complete multi-channel samples (ch floats = ch * 4 bytes)
        const bytesPerSample = ch * 4;
        const usableBytes = Math.floor(data.length / bytesPerSample) * bytesPerSample;
        if (data.length > usableBytes) {
          leftoverBuf = data.subarray(usableBytes);
        }

        // Process and modify samples in-place in the buffer
        // We can write directly to the Buffer since we own it
        for (let byteOff = 0; byteOff < usableBytes; byteOff += bytesPerSample) {
          const s = monoSampleIdx;
          let gain: number;

          if (s <= firstCenter) {
            gain = trackGains[0];
          } else if (s >= lastCenter || numFrames < 2) {
            gain = trackGains[numFrames - 1];
          } else {
            // Advance frame index
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

          // Apply gain to all channels
          for (let c = 0; c < ch; c++) {
            const off = byteOff + c * 4;
            const val = data.readFloatLE(off);
            data.writeFloatLE(val * gain, off);
          }

          monoSampleIdx++;
        }

        // Write the gain-adjusted chunk to encoder
        const outChunk = data.subarray(0, usableBytes);
        if (!encoder.stdin.destroyed) {
          const canContinue = encoder.stdin.write(outChunk);
          if (!canContinue) {
            // Backpressure from encoder — pause decoder until encoder drains
            decoder.stdout.pause();
            encoder.stdin.once('drain', () => {
              decoder.stdout.resume();
            });
          }
        }
      });

      decoder.on('close', (code) => {
        if (code !== 0 && !hadError) {
          return cleanup(new Error(`ffmpeg decode failed (${code}): ${decodeStderr}`));
        }

        // Flush any remaining leftover bytes
        if (leftoverBuf.length > 0) {
          log.warn(`  ${leftoverBuf.length} leftover bytes discarded (partial sample)`);
        }

        // Signal end of input to encoder
        if (!encoder.stdin.destroyed) {
          encoder.stdin.end();
        }
        decoderDone = true;
      });

      encoder.on('close', (code) => {
        if (code !== 0 && !hadError) {
          return cleanup(new Error(`ffmpeg encode failed (${code}): ${encodeStderr}`));
        }
        encoderDone = true;
        tryFinalize();
      });

      decoder.on('error', (err) => cleanup(err));
      encoder.on('error', (err) => cleanup(err));
      encoder.stdin.on('error', (err) => {
        // Ignore EPIPE — happens if encoder exits before all data is written
        if ((err as any).code !== 'EPIPE') cleanup(err);
      });
    });
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
