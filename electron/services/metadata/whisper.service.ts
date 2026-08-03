/**
 * Whisper Service - Video Transcription using whisper.cpp
 *
 * High-level service that orchestrates transcription workflow:
 * 1. Extract audio from video using FFmpeg
 * 2. Transcribe audio using Whisper
 * 3. Parse and return SRT segments
 *
 * Uses bridge libraries for binary management.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as log from 'electron-log';

import {
  getRuntimePaths,
  getWhisperLibraryPath,
  getSelectedWhisperModel,
  verifyBinary,
  FfmpegBridge,
  FfprobeBridge,
  WhisperBridge,
  type WhisperProgress,
} from './bridges';

export interface TranscriptionProgress {
  jobId: string;
  videoPath: string;
  percent: number;
  message: string;
}

export interface SRTSegment {
  index: number;
  start: string;
  end: string;
  text: string;
  /** Speaker/track id this segment is attributed to (e.g. "mic", "screen").
   *  Set only for imported transcripts that carry source attribution; Whisper
   *  output leaves it undefined. */
  speaker?: string;
  /** Human-readable speaker label (e.g. "Mic", "Screen audio"). */
  speakerLabel?: string;
}

interface TranscriptionJob {
  id: string;
  videoPath: string;
  tempDir: string;
  audioPath: string | null;
  aborted: boolean;
}

export class WhisperService extends EventEmitter {
  private ffmpeg: FfmpegBridge;
  private ffprobe: FfprobeBridge;
  private whisper: WhisperBridge;
  private activeJobs = new Map<string, TranscriptionJob>();

  constructor() {
    super();

    log.info('[WhisperService] Initializing...');
    log.info('[WhisperService] Platform:', process.platform);
    log.info('[WhisperService] Architecture:', process.arch);

    // Get runtime paths
    const paths = getRuntimePaths();

    // Verify downloaded prerequisites before constructing process bridges.
    try {
      verifyBinary(paths.ffmpeg, 'FFmpeg');
      verifyBinary(paths.ffprobe, 'FFprobe');
      verifyBinary(paths.whisper, 'Whisper');
      const selectedModel = path.join(paths.whisperModelsDir, `ggml-${getSelectedWhisperModel()}.bin`);
      if (!fs.existsSync(selectedModel)) throw new Error(`Whisper model not found at: ${selectedModel}`);
    } catch (error) {
      throw new Error(`Transcription components are not installed. Open Settings → Transcription Downloads and install FFmpeg, the Whisper engine, and your selected model. ${error instanceof Error ? error.message : String(error)}`);
    }

    // Initialize bridges
    this.ffmpeg = new FfmpegBridge(paths.ffmpeg);
    this.ffprobe = new FfprobeBridge(paths.ffprobe);
    this.whisper = new WhisperBridge({
      binaryPath: paths.whisper,
      modelsDir: paths.whisperModelsDir,
      libraryPath: getWhisperLibraryPath(),
    });

    // Forward whisper progress events
    this.whisper.on('progress', (progress: WhisperProgress) => {
      const job = this.findJobByProcessId(progress.processId);
      if (job) {
        this.emit('progress', {
          jobId: job.id,
          videoPath: job.videoPath,
          percent: Math.round(15 + (progress.percent * 0.85)), // Scale 0-100 to 15-100
          message: progress.message,
        } as TranscriptionProgress);
      }
    });

    log.info('[WhisperService] Initialized successfully');
    log.info('[WhisperService] FFmpeg:', paths.ffmpeg);
    log.info('[WhisperService] Whisper:', paths.whisper);
    log.info('[WhisperService] Models:', paths.whisperModelsDir);
  }

  /**
   * Find job by whisper process ID
   */
  private findJobByProcessId(processId: string): TranscriptionJob | undefined {
    // The processId from whisper matches the jobId we pass
    return this.activeJobs.get(processId);
  }

  /**
   * Transcribe a video file to SRT format
   * Returns job ID for tracking progress
   */
  async transcribeVideo(
    videoPath: string,
    modelName?: string
  ): Promise<{ jobId: string; srtPath: string; segments: SRTSegment[] }> {
    // Generate unique job ID
    const jobId = crypto.randomBytes(8).toString('hex');

    // Create temporary directory
    const tempDir = path.join(os.tmpdir(), `whisper-${jobId}`);
    fs.mkdirSync(tempDir, { recursive: true });

    // Initialize job tracking
    const job: TranscriptionJob = {
      id: jobId,
      videoPath,
      tempDir,
      audioPath: null,
      aborted: false,
    };
    this.activeJobs.set(jobId, job);

    log.info(`[WhisperService] [${jobId}] Starting transcription for: ${videoPath}`);

    try {
      // Validate input file
      if (!fs.existsSync(videoPath)) {
        throw new Error(`Video file not found: ${videoPath}`);
      }

      // Get video duration for progress tracking
      let duration: number | undefined;
      try {
        duration = await this.ffprobe.getDuration(videoPath);
        log.info(`[WhisperService] [${jobId}] Video duration: ${duration}s`);
      } catch (err) {
        log.warn(`[WhisperService] [${jobId}] Could not get duration: ${err}`);
      }

      // Extract audio
      this.emitProgress(jobId, 5, 'Extracting audio...');
      const audioPath = path.join(tempDir, 'audio.wav');

      const extractResult = await this.ffmpeg.extractAudio(videoPath, audioPath, {
        processId: `${jobId}-extract`,
        duration,
      });

      if (!extractResult.success) {
        throw new Error(`Audio extraction failed: ${extractResult.error}`);
      }

      job.audioPath = audioPath;
      log.info(`[WhisperService] [${jobId}] Audio extracted to: ${audioPath}`);

      // Transcribe with whisper
      this.emitProgress(jobId, 15, 'Starting transcription...');

      // Time-based progress estimation (whisper stderr is buffered by OS, so real progress is delayed)
      // Estimate ~10x realtime processing for base model on Apple Silicon
      const estimatedDuration = duration ? duration / 10 : 120;
      const transcribeStart = Date.now();

      const progressTimer = setInterval(() => {
        const job = this.activeJobs.get(jobId);
        if (!job || job.aborted) {
          clearInterval(progressTimer);
          return;
        }
        const elapsed = (Date.now() - transcribeStart) / 1000;
        // Scale from 15% to 90% based on estimated time
        const estimatedPercent = Math.min(90, Math.round(15 + (elapsed / estimatedDuration) * 75));
        this.emitProgress(jobId, estimatedPercent, 'Transcribing audio...');
      }, 3000); // Update every 3 seconds

      const whisperResult = await this.whisper.transcribe(audioPath, tempDir, {
        model: modelName || getSelectedWhisperModel(),
        processId: jobId, // Use jobId so we can correlate progress events
      });

      clearInterval(progressTimer);

      if (!whisperResult.success || !whisperResult.srtPath) {
        throw new Error(`Transcription failed: ${whisperResult.error}`);
      }

      // Parse SRT file
      const srtContent = fs.readFileSync(whisperResult.srtPath, 'utf-8');
      const segments = this.parseSRT(srtContent);

      // A whisper exit of 0 with an empty / segment-less SRT is NOT a success: it
      // means silent, music-only, or failed-extraction audio. Returning empty
      // content here would let the AI generation stage fabricate metadata from
      // nothing, so surface a clear error for the caller to report per-item.
      if (segments.length === 0) {
        throw new Error(`Transcription produced no speech segments for ${videoPath}`);
      }

      log.info(`[WhisperService] [${jobId}] Transcription complete: ${segments.length} segments`);
      this.emitProgress(jobId, 100, 'Transcription complete');

      // Segments are parsed in memory, so clean up the whole job temp dir (audio.wav
      // AND the whisper-<jobId> dir with its .srt) instead of leaking it on success.
      // srtPath is still returned for backward compatibility with existing callers'
      // type contracts, but the file no longer exists — consumers should use segments.
      this.cleanupJob(job);

      // Remove from active jobs
      this.activeJobs.delete(jobId);

      return { jobId, srtPath: whisperResult.srtPath, segments };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`[WhisperService] [${jobId}] Transcription failed: ${errorMessage}`);

      // Clean up on error
      this.cleanupJob(job);
      this.activeJobs.delete(jobId);

      throw error;
    }
  }

  /**
   * Emit progress event
   */
  private emitProgress(jobId: string, percent: number, message: string): void {
    const job = this.activeJobs.get(jobId);
    if (!job) return;

    this.emit('progress', {
      jobId,
      videoPath: job.videoPath,
      percent,
      message,
    } as TranscriptionProgress);
  }

  /**
   * Parse SRT file into segments
   */
  private parseSRT(srtContent: string): SRTSegment[] {
    const segments: SRTSegment[] = [];
    // Tolerate CRLF line endings (Windows): split blocks on blank lines that may use
    // \r\n, and strip any trailing \r from individual lines so timestamps parse.
    const blocks = srtContent.trim().split(/\r?\n\r?\n+/);

    for (const block of blocks) {
      const lines = block.trim().split('\n').map((line) => line.replace(/\r$/, ''));
      if (lines.length < 3) continue;

      const index = parseInt(lines[0], 10);
      const timeParts = lines[1].split(' --> ');
      if (timeParts.length !== 2) continue;

      const [start, end] = timeParts;
      const text = lines.slice(2).join('\n');

      segments.push({ index, start, end, text });
    }

    return segments;
  }

  /**
   * Clean up audio file from job
   */
  private cleanupAudio(job: TranscriptionJob): void {
    if (job.audioPath && fs.existsSync(job.audioPath)) {
      try {
        fs.unlinkSync(job.audioPath);
      } catch (err) {
        log.warn(`[WhisperService] [${job.id}] Failed to clean up audio: ${err}`);
      }
    }
  }

  /**
   * Clean up all job files
   */
  private cleanupJob(job: TranscriptionJob): void {
    this.cleanupAudio(job);

    if (job.tempDir && fs.existsSync(job.tempDir)) {
      try {
        fs.rmSync(job.tempDir, { recursive: true, force: true });
      } catch (err) {
        log.warn(`[WhisperService] [${job.id}] Failed to clean up temp directory: ${err}`);
      }
    }
  }

  /**
   * Cancel ongoing transcription(s)
   * @param jobId Optional specific job to cancel. If not provided, cancels all jobs.
   */
  cancel(jobId?: string): void {
    if (jobId) {
      const job = this.activeJobs.get(jobId);
      if (job) {
        log.info(`[WhisperService] [${jobId}] Cancelling transcription`);
        job.aborted = true;
        this.whisper.abort(jobId);
        this.ffmpeg.abort(`${jobId}-extract`);
      }
    } else {
      log.info('[WhisperService] Cancelling all transcriptions');
      this.whisper.abortAll();
      this.ffmpeg.abortAll();
      for (const job of this.activeJobs.values()) {
        job.aborted = true;
      }
    }
  }

  /**
   * Get list of available models
   */
  getAvailableModels(): string[] {
    return this.whisper.getAvailableModels();
  }
}
