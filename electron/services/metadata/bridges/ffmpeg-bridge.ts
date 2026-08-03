/**
 * FFmpeg Bridge - Process wrapper for FFmpeg binary
 * Supports multiple concurrent processes with individualized feedback
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as log from 'electron-log';

export interface FfmpegProgress {
  processId: string;
  percent: number;
  time: string;
  speed?: string;
  fps?: number;
  bitrate?: string;
  size?: string;
}

export interface FfmpegProcessInfo {
  id: string;
  process: ChildProcess;
  args: string[];
  startTime: number;
  duration?: number;
  aborted: boolean;
}

export interface FfmpegResult {
  processId: string;
  success: boolean;
  exitCode: number | null;
  duration: number;
  error?: string;
}

export class FfmpegBridge extends EventEmitter {
  private binaryPath: string;
  private activeProcesses = new Map<string, FfmpegProcessInfo>();

  constructor(ffmpegPath: string) {
    super();
    this.binaryPath = ffmpegPath;
    log.info(`[FfmpegBridge] Initialized with binary: ${ffmpegPath}`);
  }

  /**
   * Get the binary path
   */
  get path(): string {
    return this.binaryPath;
  }

  /**
   * Run FFmpeg with given arguments
   * Returns a process ID for tracking
   */
  run(
    args: string[],
    options?: {
      duration?: number;  // Total duration in seconds for progress calculation
      processId?: string; // Custom process ID, auto-generated if not provided
    }
  ): Promise<FfmpegResult> {
    const processId = options?.processId || crypto.randomBytes(8).toString('hex');

    return new Promise((resolve, reject) => {
      log.info(`[FfmpegBridge] [${processId}] Starting: ffmpeg ${args.join(' ')}`);

      const proc = spawn(this.binaryPath, args);
      const startTime = Date.now();

      const processInfo: FfmpegProcessInfo = {
        id: processId,
        process: proc,
        args,
        startTime,
        duration: options?.duration,
        aborted: false,
      };

      this.activeProcesses.set(processId, processInfo);

      // ffmpeg writes progress to stderr; nothing reads stdout. Drain it anyway so
      // a caller that directs output to stdout (pipe:1 / "-") can't fill the 64KB
      // OS pipe buffer and hang the process waiting for a reader.
      proc.stdout?.resume();

      let stderrBuffer = '';

      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderrBuffer += text;

        // Parse progress if we have duration info
        if (options?.duration) {
          const progress = this.parseProgress(text, processId, options.duration);
          if (progress) {
            this.emit('progress', progress);
          }
        }
      });

      proc.on('close', (code) => {
        const duration = Date.now() - startTime;
        this.activeProcesses.delete(processId);

        if (processInfo.aborted) {
          log.info(`[FfmpegBridge] [${processId}] Aborted after ${duration}ms`);
          resolve({
            processId,
            success: false,
            exitCode: code,
            duration,
            error: 'Process was aborted',
          });
          return;
        }

        if (code === 0) {
          log.info(`[FfmpegBridge] [${processId}] Completed successfully in ${duration}ms`);
          resolve({
            processId,
            success: true,
            exitCode: code,
            duration,
          });
        } else {
          log.error(`[FfmpegBridge] [${processId}] Failed with code ${code}`);
          log.error(`[FfmpegBridge] [${processId}] stderr: ${stderrBuffer.slice(-500)}`);
          resolve({
            processId,
            success: false,
            exitCode: code,
            duration,
            error: `FFmpeg exited with code ${code}`,
          });
        }
      });

      proc.on('error', (err) => {
        const duration = Date.now() - startTime;
        this.activeProcesses.delete(processId);

        log.error(`[FfmpegBridge] [${processId}] Spawn error: ${err.message}`);

        // Check for architecture mismatch
        if (err.message.includes('bad CPU type') || err.message.includes('ENOEXEC')) {
          reject(new Error(`FFmpeg binary has wrong architecture for this system (${process.arch})`));
        } else if (err.message.includes('ENOENT')) {
          reject(new Error(`FFmpeg binary not found at: ${this.binaryPath}`));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Extract audio from video file
   */
  async extractAudio(
    inputPath: string,
    outputPath: string,
    options?: {
      sampleRate?: number;
      channels?: number;
      format?: string;
      processId?: string;
      duration?: number;
    }
  ): Promise<FfmpegResult> {
    const args = [
      '-y',
      '-i', inputPath,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', String(options?.sampleRate || 16000),
      '-ac', String(options?.channels || 1),
      '-f', options?.format || 'wav',
      outputPath,
    ];

    return this.run(args, {
      processId: options?.processId,
      duration: options?.duration,
    });
  }

  /**
   * Abort a running process
   */
  abort(processId: string): boolean {
    const processInfo = this.activeProcesses.get(processId);
    if (!processInfo) {
      log.warn(`[FfmpegBridge] Cannot abort ${processId}: not found`);
      return false;
    }

    log.info(`[FfmpegBridge] [${processId}] Aborting process`);
    processInfo.aborted = true;

    if (process.platform === 'win32') {
      try {
        const { execSync } = require('child_process');
        execSync(`taskkill /pid ${processInfo.process.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        processInfo.process.kill('SIGKILL');
      }
    } else {
      processInfo.process.kill('SIGTERM');
    }

    return true;
  }

  /**
   * Abort all running processes
   */
  abortAll(): void {
    log.info(`[FfmpegBridge] Aborting all ${this.activeProcesses.size} processes`);
    for (const processId of this.activeProcesses.keys()) {
      this.abort(processId);
    }
  }

  /**
   * Get list of active process IDs
   */
  getActiveProcesses(): string[] {
    return Array.from(this.activeProcesses.keys());
  }

  /**
   * Check if a process is running
   */
  isRunning(processId: string): boolean {
    return this.activeProcesses.has(processId);
  }

  /**
   * Parse FFmpeg progress from stderr
   */
  private parseProgress(text: string, processId: string, totalDuration: number): FfmpegProgress | null {
    // FFmpeg outputs progress like: frame=  123 fps= 25 q=28.0 size=    1234kB time=00:00:05.12 bitrate= 1976.5kbits/s speed=1.02x
    const timeMatch = text.match(/time=(\d+:\d+:\d+\.\d+)/);
    if (!timeMatch) return null;

    const timeStr = timeMatch[1];
    const timeParts = timeStr.split(/[:.]/);
    if (timeParts.length < 4) return null;

    const hours = parseInt(timeParts[0]);
    const minutes = parseInt(timeParts[1]);
    const seconds = parseInt(timeParts[2]);
    const centiseconds = parseInt(timeParts[3]);

    const currentTime = hours * 3600 + minutes * 60 + seconds + (centiseconds / 100);
    const percent = Math.min(Math.round((currentTime / totalDuration) * 100), 100);

    const progress: FfmpegProgress = {
      processId,
      percent,
      time: timeStr,
    };

    // Parse optional fields
    const speedMatch = text.match(/speed=\s*(\d+\.?\d*)x/);
    if (speedMatch) progress.speed = speedMatch[1];

    const fpsMatch = text.match(/fps=\s*(\d+)/);
    if (fpsMatch) progress.fps = parseInt(fpsMatch[1]);

    const bitrateMatch = text.match(/bitrate=\s*([^\s]+)/);
    if (bitrateMatch) progress.bitrate = bitrateMatch[1];

    const sizeMatch = text.match(/size=\s*([^\s]+)/);
    if (sizeMatch) progress.size = sizeMatch[1];

    return progress;
  }
}
