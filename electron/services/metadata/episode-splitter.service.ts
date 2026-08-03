/**
 * Episode Splitter Service
 * Analyzes multiple sequential audio files (parts of one continuous livestream)
 * to find natural episode boundaries for splitting into ~1 hour episodes.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log';
import * as crypto from 'crypto';

import { WhisperService, SRTSegment } from './whisper.service';
import { AIManagerService, AIConfig } from './ai-manager.service';
import { buildSparseTimestampTranscript, sampleSegmentsToBudget, findPhraseTimestamp, TimeUtils } from './chapter-generator.service';
import { SYSTEM_PROMPTS } from './system-prompts';
import { queueTranscription } from '../queue-manager.service';
import { getRuntimePaths, FfprobeBridge } from './bridges';

/**
 * A suggested episode boundary
 */
/**
 * A profanity occurrence detected in a transcript
 */
export interface ProfanityMarker {
  word: string;                  // The matched word
  severity: 'severe' | 'mild';  // severe = hard profanity, mild = softer words
  timestampSeconds: number;      // Global timestamp in seconds
  timestamp: string;             // YouTube format: "1:23:45"
  localSeconds: number;          // Seconds into this episode
  localTimestamp: string;        // Time relative to episode start
  inOpening: boolean;            // Whether this is within the first 3 minutes
}

export interface EpisodeBoundary {
  episodeNumber: number;
  startTimestamp: string;       // YouTube format: "1:23:45"
  endTimestamp: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  title: string;                // Brief topic/title for this episode
  description: string;          // Summary of what this episode covers
  startPhrase: string;          // Original phrase used for timestamp mapping
  verbalCueDetected: boolean;   // Whether a verbal break cue was detected near this boundary
  exceedsMaxDuration: boolean;  // Warning flag if episode > 70 minutes
  profanityMarkers: ProfanityMarker[];  // All profanity occurrences in this episode
}

/**
 * How a portion of a source file maps to an episode
 */
export interface SourceFileSegment {
  episodeNumber: number;
  localStartTimestamp: string;   // Time within this source file
  localEndTimestamp: string;
  localStartSeconds: number;
  localEndSeconds: number;
  durationSeconds: number;
}

/**
 * Breakdown of how one source file is split across episodes
 */
export interface SourceFileBreakdown {
  fileIndex: number;
  fileName: string;
  filePath: string;
  fileDurationSeconds: number;
  fileDuration: string;
  globalStartSeconds: number;    // Where this file starts in the global timeline
  globalEndSeconds: number;
  segments: SourceFileSegment[];
}

/**
 * The episode split report
 */
export interface EpisodeSplitReport {
  audioFiles: Array<{ path: string; name: string; durationSeconds: number }>;
  totalDuration: string;
  totalDurationSeconds: number;
  analyzedAt: string;
  episodeCount: number;
  targetEpisodeDuration: number;  // in minutes
  maxEpisodeDuration: number;     // in minutes
  episodes: EpisodeBoundary[];
  sourceFileBreakdown: SourceFileBreakdown[];
}

/**
 * Result of episode split analysis
 */
export interface EpisodeSplitResult {
  success: boolean;
  report?: EpisodeSplitReport;
  reportPath?: string;
  error?: string;
}

/**
 * Parameters for episode split analysis
 */
export interface EpisodeSplitParams {
  audioPaths: string[];         // Sequential audio file paths (order matters)
  outputDirectory: string;
  aiProvider: string;
  aiModel: string;
  aiApiKey?: string;
  aiHost?: string;
  jobId?: string;
  progressCallback?: (phase: string, message: string, percent?: number) => void;
  cancelCallback?: () => boolean;
}

/**
 * AI response format for episode boundary detection
 */
interface AIEpisodeResponse {
  episodes: Array<{
    start_phrase: string;
    title: string;
    description: string;
    verbal_cue_nearby?: boolean;
  }>;
}

/**
 * One AI-detected chapter — a contiguous subject/topic segment. Chapters TILE the
 * whole transcript in order (chapter[i].endSeconds === chapter[i+1].startSeconds,
 * first starts at 0, last ends at duration). The user groups consecutive chapters
 * into output "stories" in the review UI.
 */
export interface TranscriptChapter {
  index: number;            // 1-based, chronological
  startSeconds: number;     // story-local, 0-based — where the subject begins
  endSeconds: number;       // where it ends (= next chapter's start, or duration)
  timestamp: string;        // H:MM:SS mirror of startSeconds
  label: string;            // short AI subject label
  verbalCue: boolean;       // explicit break cue detected nearby
}

export class EpisodeSplitterService {
  // Target and max episode duration in seconds
  private static readonly TARGET_EPISODE_SECONDS = 3600;    // 60 minutes
  private static readonly MAX_EPISODE_SECONDS = 4200;       // 70 minutes
  private static readonly BALANCE_RATIO = 0.70;             // shortest must be >= 70% of longest

  /**
   * Analyze sequential audio files to find episode boundaries
   */
  static async analyze(params: EpisodeSplitParams): Promise<EpisodeSplitResult> {
    const {
      audioPaths,
      outputDirectory,
      aiProvider,
      aiModel,
      aiApiKey,
      aiHost,
      progressCallback,
      cancelCallback,
    } = params;

    log.info(`[EpisodeSplitter] Starting analysis of ${audioPaths.length} audio files`);

    const sendProgress = (phase: string, message: string, percent?: number) => {
      log.info(`[EpisodeSplitter] Progress: ${phase} - ${message} (${percent}%)`);
      if (progressCallback) {
        progressCallback(phase, message, percent);
      }
    };

    const isCancelled = () => {
      return cancelCallback ? cancelCallback() : false;
    };

    try {
      // Validate input files
      for (const audioPath of audioPaths) {
        if (!fs.existsSync(audioPath)) {
          return { success: false, error: `Audio file not found: ${audioPath}` };
        }
      }

      if (audioPaths.length === 0) {
        return { success: false, error: 'No audio files provided' };
      }

      // Phase 1: Transcribe all audio files (0-50%)
      sendProgress('transcribing', 'Starting transcription of audio files...', 2);

      if (isCancelled()) {
        return { success: false, error: 'Cancelled by user' };
      }

      const allSegments: SRTSegment[] = [];
      const fileInfos: Array<{ path: string; name: string; durationSeconds: number }> = [];
      let globalTimeOffset = 0;

      // Real audio durations come from ffprobe (not the last transcribed segment,
      // which undercounts by any trailing silence/music).
      const ffprobe = new FfprobeBridge(getRuntimePaths().ffprobe);

      for (let fileIndex = 0; fileIndex < audioPaths.length; fileIndex++) {
        const audioPath = audioPaths[fileIndex];
        const fileName = path.basename(audioPath, path.extname(audioPath));

        sendProgress(
          'transcribing',
          `Transcribing file ${fileIndex + 1}/${audioPaths.length}: ${path.basename(audioPath)}`,
          Math.round(2 + (fileIndex / audioPaths.length) * 45)
        );

        if (isCancelled()) {
          return { success: false, error: 'Cancelled by user' };
        }

        const transcriptionTaskId = `transcribe-ep-${crypto.randomBytes(4).toString('hex')}`;
        const whisperService = new WhisperService();

        // Forward transcription progress
        whisperService.on('progress', (progress) => {
          const filePercent = (fileIndex + progress.percent / 100) / audioPaths.length;
          const scaledPercent = Math.round(2 + filePercent * 45);
          sendProgress('transcribing', `File ${fileIndex + 1}/${audioPaths.length}: ${progress.message}`, scaledPercent);
        });

        const transcriptionResult = await queueTranscription<{ jobId: string; srtPath: string; segments: SRTSegment[] }>(
          transcriptionTaskId,
          `Transcribe: ${fileName}`,
          () => whisperService.transcribeVideo(audioPath),
          (percent, message) => {
            const filePercent = (fileIndex + percent / 100) / audioPaths.length;
            sendProgress('transcribing', `File ${fileIndex + 1}/${audioPaths.length}: ${message}`, Math.round(2 + filePercent * 45));
          }
        );

        const { segments: srtSegments } = transcriptionResult;

        // A file yielding zero segments is a hard error. Silently skipping it would
        // exclude it from BOTH fileInfos and the timeline, shifting every later file
        // (and its cut points) by an entire file's duration.
        if (!srtSegments || srtSegments.length === 0) {
          return { success: false, error: `Transcription produced no segments for ${path.basename(audioPath)} — cannot compute reliable episode boundaries` };
        }

        // Use the REAL audio duration for the timeline. The last transcribed
        // segment's end undercounts by any trailing silence/music, and that error
        // compounds through globalTimeOffset into wrong cut points in later files.
        const realDuration = await ffprobe.getDuration(audioPath);
        if (realDuration === undefined || realDuration === null || Number.isNaN(realDuration) || realDuration <= 0) {
          return { success: false, error: `Could not determine audio duration for ${path.basename(audioPath)} (ffprobe returned ${realDuration}) — cannot compute reliable episode boundaries` };
        }

        // Sanity check: the transcript should never extend past the real audio.
        const lastSegmentEnd = TimeUtils.srtTimeToSeconds(srtSegments[srtSegments.length - 1].end);
        if (realDuration < lastSegmentEnd) {
          log.warn(`[EpisodeSplitter] File ${fileIndex + 1}: real duration ${TimeUtils.secondsToYoutubeTime(realDuration)} < last segment end ${TimeUtils.secondsToYoutubeTime(lastSegmentEnd)} — transcript extends past reported audio duration`);
        }

        const fileDuration = realDuration;

        fileInfos.push({
          path: audioPath,
          name: path.basename(audioPath),
          durationSeconds: fileDuration
        });

        // Offset all segments by globalTimeOffset to create continuous timeline
        for (const segment of srtSegments) {
          const startSeconds = TimeUtils.srtTimeToSeconds(segment.start) + globalTimeOffset;
          const endSeconds = TimeUtils.srtTimeToSeconds(segment.end) + globalTimeOffset;

          allSegments.push({
            index: allSegments.length + 1,
            start: this.secondsToSrtTime(startSeconds),
            end: this.secondsToSrtTime(endSeconds),
            text: segment.text,
          });
        }

        log.info(`[EpisodeSplitter] File ${fileIndex + 1}: ${srtSegments.length} segments, duration: ${TimeUtils.secondsToYoutubeTime(fileDuration)}, offset: ${TimeUtils.secondsToYoutubeTime(globalTimeOffset)}`);

        // Next file starts where this one ends
        globalTimeOffset += fileDuration;
      }

      if (allSegments.length === 0) {
        return { success: false, error: 'Transcription produced no segments from any file' };
      }

      const totalDurationSeconds = globalTimeOffset;
      const totalDuration = TimeUtils.secondsToYoutubeTime(totalDurationSeconds);

      log.info(`[EpisodeSplitter] Total: ${allSegments.length} segments, duration: ${totalDuration}`);

      if (isCancelled()) {
        return { success: false, error: 'Cancelled by user' };
      }

      // Phase 2: AI episode boundary detection (50-90%)
      sendProgress('analyzing', 'Building combined transcript...', 52);

      // Sample segments to a provider-aware char budget BEFORE building the
      // transcript. ai-manager silently truncates Ollama prompts, so a multi-hour
      // stream would otherwise lose its tail and episodes would stop partway.
      // Sampling keeps whole segments verbatim, so quoted start_phrases still match
      // against the FULL allSegments list below.
      const EPISODE_TRANSCRIPT_BUDGET_CHARS = aiProvider === 'ollama' ? 90000 : 300000;
      const budgetedSegments = sampleSegmentsToBudget(allSegments, EPISODE_TRANSCRIPT_BUDGET_CHARS);

      // Sparse [H:MM:SS] markers every 5 minutes give the model real temporal
      // context so it can hit the ~60-minute targets and spread boundaries across
      // the entire runtime. Exact timestamps are still recovered via phrase matching.
      const transcript = buildSparseTimestampTranscript(budgetedSegments, 5);

      sendProgress('analyzing', 'Analyzing transcript for episode boundaries...', 55);

      // Initialize AI service
      const aiConfig: AIConfig = {
        provider: aiProvider as 'ollama' | 'openai' | 'claude',
        metadataModel: aiModel,
        summarizationModel: aiModel,
        apiKey: aiApiKey,
        host: aiHost,
      };

      const aiService = new AIManagerService(aiConfig);
      const initialized = await aiService.initialize();

      if (!initialized) {
        return {
          success: false,
          error: aiService.lastInitError
            ? `Failed to initialize AI service: ${aiService.lastInitError}`
            : 'Failed to initialize AI service',
        };
      }

      // Detect episode boundaries
      const episodes = await this.detectEpisodeBoundaries(
        aiService,
        transcript,
        allSegments,
        totalDurationSeconds,
        (percent) => sendProgress('analyzing', 'Detecting episode boundaries...', percent)
      );

      if (isCancelled()) {
        return { success: false, error: 'Cancelled by user' };
      }

      if (episodes.length === 0) {
        return { success: false, error: 'No episode boundaries detected' };
      }

      log.info(`[EpisodeSplitter] Detected ${episodes.length} episodes`);

      // Scan all episodes for profanity (flags opening 3 min for monetization)
      sendProgress('analyzing', 'Scanning episodes for profanity...', 91);
      this.scanProfanity(episodes, allSegments);

      // Phase 3: Generate report (92-100%)
      sendProgress('generating', 'Generating episode split report...', 92);

      // Compute per-source-file breakdown
      const sourceFileBreakdown = this.computeSourceFileBreakdown(fileInfos, episodes);

      const report: EpisodeSplitReport = {
        audioFiles: fileInfos,
        totalDuration,
        totalDurationSeconds,
        analyzedAt: new Date().toISOString(),
        episodeCount: episodes.length,
        targetEpisodeDuration: 60,
        maxEpisodeDuration: 70,
        episodes,
        sourceFileBreakdown,
      };

      // Save report
      const reportPath = await this.saveReport(report, outputDirectory);

      sendProgress('complete', 'Episode split analysis complete!', 100);

      // Cleanup
      aiService.cleanup();

      return {
        success: true,
        report,
        reportPath,
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`[EpisodeSplitter] Analysis failed: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Transcript-based chapter detection (the "Split episode" feature).
   *
   * Takes already-timestamped SRT segments (e.g. from an imported AutoCutStudio
   * transcript — no Whisper, no ffprobe) and asks the AI to segment the WHOLE
   * transcript into consecutive subject "chapters" that tile 0..duration. The
   * review UI then lets the user group consecutive chapters into output stories.
   */
  static async detectChapters(params: {
    srtSegments: SRTSegment[];
    totalDurationSeconds: number;
    aiService: AIManagerService;
    provider?: string;
  }): Promise<TranscriptChapter[]> {
    const { srtSegments, totalDurationSeconds, aiService } = params;
    const provider = params.provider ?? 'claude';

    if (!srtSegments || srtSegments.length === 0) {
      throw new Error('Transcript has no segments to analyze.');
    }

    // Same char-budget sampling as the audio path so Ollama prompts aren't
    // silently truncated. Whole segments are kept verbatim so quoted
    // start_phrases still map against the full segment list.
    const budgetChars = provider === 'ollama' ? 90000 : 300000;
    const budgetedSegments = sampleSegmentsToBudget(srtSegments, budgetChars);
    const transcript = buildSparseTimestampTranscript(budgetedSegments, 5);

    const prompt = this.buildChaptersPrompt(totalDurationSeconds)
      .replace('{transcript}', () => transcript); // function replacer: transcript may contain $-patterns

    const response = await this.makeAIRequest(aiService, prompt);
    if (!response) {
      log.error('[TranscriptSplit] No response from AI');
      return [];
    }

    const aiItems = this.parseAIResponse(response);
    log.info(`[TranscriptSplit] AI proposed ${aiItems.length} chapters`);

    // Map each start_phrase to a real timestamp, enforcing chronological order
    // and a minimum spacing so near-duplicate starts collapse.
    const MIN_GAP_SECONDS = 45;
    const starts: Array<{ startSeconds: number; label: string; verbalCue: boolean }> = [];
    let minTimestamp = 0;

    for (const item of aiItems) {
      const phrase = item.start_phrase || '';
      const label = item.title?.trim() || 'Subject';
      const ts = findPhraseTimestamp(phrase, srtSegments, 0.5, minTimestamp);
      if (ts === null) {
        log.warn(`[TranscriptSplit] Could not map chapter phrase: "${phrase.substring(0, 40)}"`);
        continue;
      }
      if (ts > totalDurationSeconds - MIN_GAP_SECONDS) continue;
      if (starts.length && ts - starts[starts.length - 1].startSeconds < MIN_GAP_SECONDS) continue;
      minTimestamp = ts + 1;
      starts.push({ startSeconds: ts, label, verbalCue: !!item.verbal_cue_nearby });
    }

    if (starts.length === 0) {
      // Fall back to a single chapter spanning the whole transcript.
      return [{
        index: 1, startSeconds: 0, endSeconds: totalDurationSeconds,
        timestamp: TimeUtils.secondsToYoutubeTime(0), label: 'Full transcript', verbalCue: false,
      }];
    }

    // The first chapter always starts at 0 (force it, whatever the AI quoted).
    starts[0].startSeconds = 0;

    // Build tiling chapters: each ends where the next begins; last ends at duration.
    const chapters: TranscriptChapter[] = starts.map((s, i) => ({
      index: i + 1,
      startSeconds: s.startSeconds,
      endSeconds: i < starts.length - 1 ? starts[i + 1].startSeconds : totalDurationSeconds,
      timestamp: TimeUtils.secondsToYoutubeTime(s.startSeconds),
      label: s.label,
      verbalCue: s.verbalCue,
    }));

    log.info(`[TranscriptSplit] ${chapters.length} chapters after mapping/dedup`);
    return chapters;
  }

  /**
   * Prompt for segmenting the WHOLE transcript into consecutive subject chapters.
   * Keeps a `description` field so parseAIResponse's malformed-JSON recovery
   * regex still works. {transcript} is filled by the caller.
   */
  private static buildChaptersPrompt(totalDurationSeconds: number): string {
    const hours = Math.floor(totalDurationSeconds / 3600);
    const minutes = Math.floor((totalDurationSeconds % 3600) / 60);
    const durationStr = hours > 0
      ? `${hours} hour${hours > 1 ? 's' : ''} ${minutes} minutes`
      : `${minutes} minutes`;

    return `You are analyzing a transcript from a long recording (total duration: ${durationStr}).
Time markers in the form [H:MM:SS] (for example [1:35:00]) are inserted throughout the text every few minutes — each marks how far into the recording that point occurs. Use these markers to gauge where each moment falls.

Your task: segment the ENTIRE transcript into consecutive CHAPTERS — one chapter per distinct subject, story, or topic — in chronological order covering the whole runtime from start to finish. Each chapter begins where the speaker clearly moves to a new subject. In this kind of content a genuine shift typically occurs every ~10-25 minutes. Do NOT invent breaks inside a single continuous subject — only start a new chapter at a real subject change.

The FIRST chapter starts at the very beginning of the recording. Every following chapter starts at a real subject change. Together the chapters must span the whole runtime with no gaps.

For each chapter provide:
1. start_phrase: an exact quote (5-10 words) of the SPOKEN words at the moment the chapter begins (for the first chapter, the very first words spoken)
2. title: a short label for the chapter's subject
3. description: 1 sentence on what the chapter covers
4. verbal_cue_nearby: true if there is an explicit break cue at its start (sign-off, "moving on...", an intro to a new segment), else false

Return ONLY valid JSON:
{
  "episodes": [
    {
      "start_phrase": "exact quote from transcript",
      "title": "Chapter Subject",
      "description": "What the chapter covers...",
      "verbal_cue_nearby": false
    }
  ]
}

CRITICAL RULES:
- start_phrase MUST be verbatim spoken text copied from the transcript (5-10 consecutive words)
- NEVER quote a [H:MM:SS] time marker as a start_phrase — those are inserted markers, not spoken words. Quote the actual words spoken at that point instead.
- The transcript may be an evenly-sampled excerpt (some sentences omitted between lines) — quote start_phrase EXACTLY as it appears in the text provided, never bridge or paraphrase across gaps
- The first chapter's start_phrase is the very first words of the transcript
- DO NOT paraphrase or modify the text — copy EXACTLY as written
- List chapters in chronological order across the whole runtime, not bunched early
- Output valid JSON only, no markdown or extra text

Transcript:
{transcript}`;
  }

  /**
   * Convert seconds to SRT time format (hh:mm:ss,ms)
   */
  private static secondsToSrtTime(totalSeconds: number): string {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const ms = Math.round((totalSeconds % 1) * 1000);

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
  }

  /**
   * Detect episode boundaries using AI
   */
  private static async detectEpisodeBoundaries(
    aiService: AIManagerService,
    transcript: string,
    srtSegments: SRTSegment[],
    totalDurationSeconds: number,
    progressCallback?: (percent: number) => void,
    bounds?: { targetSeconds: number; maxSeconds: number; balanceRatio: number },
    promptTemplate?: string
  ): Promise<EpisodeBoundary[]> {
    // Length bounds default to the static audio-path constants; the transcript
    // split feature passes user-configured values instead.
    const targetSeconds = bounds?.targetSeconds ?? this.TARGET_EPISODE_SECONDS;
    const maxSeconds = bounds?.maxSeconds ?? this.MAX_EPISODE_SECONDS;
    const balanceRatio = bounds?.balanceRatio ?? this.BALANCE_RATIO;

    // Calculate expected number of episodes
    const targetEpisodeCount = Math.max(1, Math.round(totalDurationSeconds / targetSeconds));

    // Format duration info for AI
    const hours = Math.floor(totalDurationSeconds / 3600);
    const minutes = Math.floor((totalDurationSeconds % 3600) / 60);
    const durationStr = hours > 0
      ? `${hours} hour${hours > 1 ? 's' : ''} ${minutes} minutes`
      : `${minutes} minutes`;

    // Build the prompt
    let prompt = promptTemplate ?? SYSTEM_PROMPTS.EPISODE_SPLIT_PROMPT;
    prompt = prompt.replace('{transcript}', () => transcript); // function replacer: transcript may contain $-patterns
    prompt = prompt.replace('{duration}', durationStr);
    prompt = prompt.replace('{episodeCount}', String(targetEpisodeCount));

    if (progressCallback) progressCallback(60);

    log.info(`[EpisodeSplitter] Requesting AI analysis for ~${targetEpisodeCount} episodes from ${durationStr} stream`);
    log.info(`[EpisodeSplitter] Transcript length: ${transcript.length} chars`);

    const response = await this.makeAIRequest(aiService, prompt);

    if (progressCallback) progressCallback(75);

    if (!response) {
      log.error('[EpisodeSplitter] No response from AI');
      return [];
    }

    log.info('[EpisodeSplitter] Raw AI response:', response.substring(0, 1000));

    // Parse AI response
    const aiEpisodes = this.parseAIResponse(response);

    if (progressCallback) progressCallback(80);

    log.info(`[EpisodeSplitter] Parsed ${aiEpisodes.length} episodes from AI`);
    for (const ep of aiEpisodes) {
      log.info(`  - "${ep.title}" start_phrase: "${ep.start_phrase?.substring(0, 50)}..."`);
    }

    // Map episodes to timestamps
    let mappedEpisodes = this.mapEpisodesToTimestamps(
      aiEpisodes,
      srtSegments,
      totalDurationSeconds
    );

    if (progressCallback) progressCallback(82);

    // PASS 2: Re-split any episodes that exceed the max duration or are
    // disproportionately long compared to the average.
    // Threshold: any episode longer than 150% of the average gets re-split.
    const PROPORTION_THRESHOLD = 1.5;
    const avgDuration = mappedEpisodes.length > 0
      ? mappedEpisodes.reduce((sum, ep) => sum + ep.durationSeconds, 0) / mappedEpisodes.length
      : targetSeconds;
    const splitThreshold = Math.min(maxSeconds, avgDuration * PROPORTION_THRESHOLD);

    const longEpisodes = mappedEpisodes.filter(ep => ep.durationSeconds > splitThreshold);

    if (longEpisodes.length > 0) {
      log.info(`[EpisodeSplitter] Pass 2: Found ${longEpisodes.length} episode(s) exceeding threshold (${Math.round(splitThreshold / 60)} min). Avg episode: ${Math.round(avgDuration / 60)} min`);

      for (const longEp of longEpisodes) {
        const durationMinutes = Math.round(longEp.durationSeconds / 60);
        const numSplits = Math.ceil(longEp.durationSeconds / targetSeconds);

        if (numSplits < 2) continue; // Not worth splitting

        log.info(`[EpisodeSplitter] Splitting episode "${longEp.title}" (${durationMinutes} min) into ~${numSplits} parts`);

        // Extract transcript for this episode's time range
        let episodeTranscript = this.extractTranscriptRange(
          srtSegments,
          longEp.startSeconds,
          longEp.endSeconds
        );

        // Truncate if needed to avoid token limits
        const MAX_TRANSCRIPT_CHARS = 100000;
        if (episodeTranscript.length > MAX_TRANSCRIPT_CHARS) {
          log.warn(`[EpisodeSplitter] Truncating transcript from ${episodeTranscript.length} to ${MAX_TRANSCRIPT_CHARS} chars`);
          episodeTranscript = episodeTranscript.substring(0, MAX_TRANSCRIPT_CHARS) + '\n[TRANSCRIPT TRUNCATED]';
        }

        const subEpisodes = await this.splitLongEpisode(
          aiService,
          longEp,
          episodeTranscript,
          srtSegments,
          numSplits
        );

        if (subEpisodes.length > 1) {
          // Replace the original long episode with sub-episodes
          mappedEpisodes = mappedEpisodes.filter(ep => ep !== longEp);
          mappedEpisodes.push(...subEpisodes);
        }
      }

      // Re-sort and recalculate
      mappedEpisodes.sort((a, b) => a.startSeconds - b.startSeconds);

      for (let i = 0; i < mappedEpisodes.length; i++) {
        if (i < mappedEpisodes.length - 1) {
          mappedEpisodes[i].endSeconds = mappedEpisodes[i + 1].startSeconds;
        } else {
          mappedEpisodes[i].endSeconds = totalDurationSeconds;
        }
        mappedEpisodes[i].endTimestamp = TimeUtils.secondsToYoutubeTime(mappedEpisodes[i].endSeconds);
        mappedEpisodes[i].durationSeconds = mappedEpisodes[i].endSeconds - mappedEpisodes[i].startSeconds;
        mappedEpisodes[i].exceedsMaxDuration = mappedEpisodes[i].durationSeconds > maxSeconds;
        mappedEpisodes[i].episodeNumber = i + 1;
      }

      log.info(`[EpisodeSplitter] After Pass 2: ${mappedEpisodes.length} episodes`);
      for (const ep of mappedEpisodes) {
        const durMin = Math.round(ep.durationSeconds / 60);
        log.info(`  Episode ${ep.episodeNumber}: "${ep.title}" ${ep.startTimestamp} - ${ep.endTimestamp} (${durMin} min)`);
      }
    }

    // Balance episode durations so shortest >= 70% of longest
    mappedEpisodes = this.balanceEpisodeDurations(mappedEpisodes, totalDurationSeconds, { maxSeconds, balanceRatio });

    if (progressCallback) progressCallback(90);

    return mappedEpisodes;
  }

  /**
   * Ensure episodes are roughly equal in duration.
   * Shortest episode must be >= BALANCE_RATIO (70%) of the longest.
   *
   * Strategy: iteratively shift the boundary between the shortest episode
   * and its longer neighbour to equalize the pair. This minimises movement
   * from the AI-suggested boundaries. If 20 iterations aren't enough, keep the
   * AI boundaries as-is — an honest imbalance beats fabricated even splits whose
   * titles/descriptions no longer describe their time ranges.
   */
  private static balanceEpisodeDurations(
    episodes: EpisodeBoundary[],
    totalDurationSeconds: number,
    bounds?: { maxSeconds: number; balanceRatio: number }
  ): EpisodeBoundary[] {
    if (episodes.length <= 1) return episodes;

    const maxSeconds = bounds?.maxSeconds ?? this.MAX_EPISODE_SECONDS;
    const balanceRatio = bounds?.balanceRatio ?? this.BALANCE_RATIO;

    const ratio = () => {
      const durations = episodes.map(ep => ep.durationSeconds);
      return Math.min(...durations) / Math.max(...durations);
    };

    const currentRatio = ratio();
    if (currentRatio >= balanceRatio) {
      log.info(`[EpisodeSplitter] Episodes already balanced (ratio ${currentRatio.toFixed(2)})`);
      return episodes;
    }

    log.info(`[EpisodeSplitter] Balancing episodes (ratio ${currentRatio.toFixed(2)}, target >= ${balanceRatio})`);

    // Phase 1 — iterative pairwise equalization (preserves AI boundaries as much as possible)
    const MAX_ITER = 20;
    for (let iter = 0; iter < MAX_ITER; iter++) {
      if (ratio() >= balanceRatio) break;

      // Find the shortest episode
      let shortIdx = 0;
      for (let i = 1; i < episodes.length; i++) {
        if (episodes[i].durationSeconds < episodes[shortIdx].durationSeconds) shortIdx = i;
      }

      // Pick its longer neighbour (prefer whichever is longer)
      const prevDur = shortIdx > 0 ? episodes[shortIdx - 1].durationSeconds : -1;
      const nextDur = shortIdx < episodes.length - 1 ? episodes[shortIdx + 1].durationSeconds : -1;
      const donorIdx = prevDur >= nextDur ? shortIdx - 1 : shortIdx + 1;

      const totalPair = episodes[shortIdx].durationSeconds + episodes[donorIdx].durationSeconds;
      const targetEach = totalPair / 2;
      const transfer = targetEach - episodes[shortIdx].durationSeconds;
      if (transfer <= 1) break; // nothing meaningful to move

      // Shift the shared boundary
      if (donorIdx < shortIdx) {
        // donor is before → move boundary earlier (short's start moves back)
        const newBoundary = episodes[shortIdx].startSeconds - transfer;
        episodes[donorIdx].endSeconds = newBoundary;
        episodes[shortIdx].startSeconds = newBoundary;
      } else {
        // donor is after → move boundary later (short's end moves forward)
        const newBoundary = episodes[shortIdx].endSeconds + transfer;
        episodes[shortIdx].endSeconds = newBoundary;
        episodes[donorIdx].startSeconds = newBoundary;
      }

      // Recalculate the two touched episodes
      for (const idx of [shortIdx, donorIdx]) {
        episodes[idx].durationSeconds = episodes[idx].endSeconds - episodes[idx].startSeconds;
        episodes[idx].startTimestamp = TimeUtils.secondsToYoutubeTime(episodes[idx].startSeconds);
        episodes[idx].endTimestamp = TimeUtils.secondsToYoutubeTime(episodes[idx].endSeconds);
      }
    }

    // If pairwise balancing couldn't reach the target ratio, keep the AI's
    // boundaries. Redistributing evenly would leave each episode's title,
    // description and startPhrase attached to time ranges they no longer
    // describe — an honest imbalance is the lesser evil. Now that the model sees
    // [H:MM:SS] markers it should already spread boundaries across the runtime.
    if (ratio() < balanceRatio) {
      log.warn(`[EpisodeSplitter] Pairwise balancing insufficient (ratio ${ratio().toFixed(2)} < ${balanceRatio}); keeping AI boundaries rather than fabricating even splits`);
    }

    // Final cleanup
    for (let i = 0; i < episodes.length; i++) {
      episodes[i].exceedsMaxDuration = episodes[i].durationSeconds > maxSeconds;
      episodes[i].episodeNumber = i + 1;
    }

    log.info(`[EpisodeSplitter] After balancing (ratio ${ratio().toFixed(2)}):`);
    for (const ep of episodes) {
      const durMin = Math.round(ep.durationSeconds / 60);
      log.info(`  Episode ${ep.episodeNumber}: "${ep.title}" ${ep.startTimestamp} - ${ep.endTimestamp} (${durMin} min)`);
    }

    return episodes;
  }

  /**
   * Extract plain transcript text for a specific time range
   */
  private static extractTranscriptRange(
    srtSegments: SRTSegment[],
    startSeconds: number,
    endSeconds: number
  ): string {
    const lines: string[] = [];

    for (const segment of srtSegments) {
      const segStart = TimeUtils.srtTimeToSeconds(segment.start);

      if (segStart >= startSeconds && segStart < endSeconds) {
        const text = segment.text.trim();
        if (text.length > 0) {
          lines.push(text);
        }
      }
    }

    return lines.join(' ').trim();
  }

  /**
   * Ask AI to split a long episode into smaller pieces (Pass 2)
   */
  private static async splitLongEpisode(
    aiService: AIManagerService,
    originalEpisode: EpisodeBoundary,
    episodeTranscript: string,
    srtSegments: SRTSegment[],
    numSplits: number
  ): Promise<EpisodeBoundary[]> {
    const durationMinutes = Math.round(originalEpisode.durationSeconds / 60);
    const targetMinutes = Math.round(durationMinutes / numSplits);

    log.info(`[EpisodeSplitter] Pass 2 transcript: ${episodeTranscript.length} chars for "${originalEpisode.title}"`);

    const prompt = `This ${durationMinutes}-minute section of a livestream needs to be split into ${numSplits} episodes of roughly ${targetMinutes} minutes each.

Find ${numSplits - 1} natural break points: topic changes, verbal break cues ("tell me what you think in the comments", sign-off/intro patterns), new subjects being discussed, or natural pauses.

CRITICAL: Each start_phrase MUST be copied EXACTLY from the transcript — copy-paste 5-8 consecutive words.

Return ONLY valid JSON:
{"episodes":[
{"start_phrase":"EXACT 5-8 words from transcript","title":"Topic Name","description":"1-2 sentences about this part","verbal_cue_nearby":false},
{"start_phrase":"EXACT 5-8 words from transcript","title":"Another Topic","description":"1-2 sentences about this part","verbal_cue_nearby":false}
]}

Rules:
- start_phrase for episode 1: copy the first 5-8 words of the transcript
- start_phrase for episodes 2-${numSplits}: copy 5-8 words from where each episode should begin
- DO NOT paraphrase — copy EXACTLY as written
- title: The subject or topic, NO "Part 1:", "Part 2:" prefixes
- Output valid JSON only, no markdown

Transcript:
${episodeTranscript}`;

    const response = await this.makeAIRequest(aiService, prompt);

    if (!response) {
      log.warn('[EpisodeSplitter] No response for Pass 2 split, keeping original episode');
      return [originalEpisode];
    }

    log.info(`[EpisodeSplitter] Pass 2 response: ${response.substring(0, 500)}...`);

    const aiEpisodes = this.parseAIResponse(response);

    if (aiEpisodes.length < 2) {
      log.warn('[EpisodeSplitter] Not enough breakpoints in Pass 2, keeping original episode');
      return [originalEpisode];
    }

    // Map the sub-episodes to timestamps
    const subEpisodes: EpisodeBoundary[] = [];

    // Constrain phrase matching to this episode's own time range. Without a lower
    // bound, a phrase that also occurs in an earlier episode maps before this
    // episode's start; without an upper bound it maps past its end. Either
    // corrupts every boundary after the global re-sort/recalc. Advance the lower
    // bound past each match, mirroring mapEpisodesToTimestamps.
    let minTimestamp = originalEpisode.startSeconds;

    for (let i = 0; i < aiEpisodes.length; i++) {
      const ep = aiEpisodes[i];
      const startPhrase = ep.start_phrase || '';
      const title = ep.title?.trim() || `Part ${i + 1}`;
      const description = ep.description?.trim() || '';

      let startSeconds = findPhraseTimestamp(startPhrase, srtSegments, 0.5, minTimestamp);

      // Reject matches at or past this episode's end — treat as unmatched
      if (startSeconds !== null && startSeconds >= originalEpisode.endSeconds) {
        startSeconds = null;
      }

      // First sub-episode starts at the original episode's start
      if (i === 0 && (startSeconds === null || startSeconds < originalEpisode.startSeconds)) {
        startSeconds = originalEpisode.startSeconds;
      }

      if (startSeconds === null) {
        log.warn(`[EpisodeSplitter] Pass 2: Could not match phrase for part ${i + 1}: "${startPhrase}"`);
        continue;
      }

      // Advance the lower bound so the next phrase matches later in the episode
      minTimestamp = startSeconds + 1;

      log.info(`[EpisodeSplitter] Pass 2 matched: "${startPhrase.substring(0, 40)}..." → ${TimeUtils.secondsToYoutubeTime(startSeconds)}`);

      subEpisodes.push({
        episodeNumber: i + 1, // Will be renumbered later
        startTimestamp: TimeUtils.secondsToYoutubeTime(startSeconds),
        endTimestamp: TimeUtils.secondsToYoutubeTime(originalEpisode.endSeconds),
        startSeconds,
        endSeconds: originalEpisode.endSeconds,
        durationSeconds: 0, // Recalculated after sorting
        title,
        description,
        startPhrase,
        verbalCueDetected: ep.verbal_cue_nearby || false,
        exceedsMaxDuration: false,
        profanityMarkers: [],
      });
    }

    if (subEpisodes.length < 2) {
      log.warn('[EpisodeSplitter] Not enough valid sub-episodes, keeping original');
      return [originalEpisode];
    }

    // Sort and recalculate end times within the sub-episodes
    subEpisodes.sort((a, b) => a.startSeconds - b.startSeconds);

    for (let i = 0; i < subEpisodes.length; i++) {
      if (i < subEpisodes.length - 1) {
        subEpisodes[i].endSeconds = subEpisodes[i + 1].startSeconds;
      } else {
        subEpisodes[i].endSeconds = originalEpisode.endSeconds;
      }
      subEpisodes[i].endTimestamp = TimeUtils.secondsToYoutubeTime(subEpisodes[i].endSeconds);
      subEpisodes[i].durationSeconds = subEpisodes[i].endSeconds - subEpisodes[i].startSeconds;
    }

    log.info(`[EpisodeSplitter] Split "${originalEpisode.title}" into ${subEpisodes.length} sub-episodes`);
    return subEpisodes;
  }

  /**
   * Make AI request. Queueing lives inside aiManager.makeRequest, so wrapping this
   * in queueAITask would nest queue tasks and deadlock the 1-slot AI pool.
   */
  private static async makeAIRequest(
    aiService: AIManagerService,
    prompt: string
  ): Promise<string | null> {
    try {
      const service = aiService as any;
      const model = service.metadataModel;

      log.info(`[EpisodeSplitter] Requesting AI analysis with model: ${model}`);

      const response = await service.makeRequest(prompt, model, 600);

      return response;
    } catch (error) {
      log.error('[EpisodeSplitter] AI request failed:', error);
      return null;
    }
  }

  /**
   * Parse AI response to extract episode boundaries
   */
  private static parseAIResponse(response: string): AIEpisodeResponse['episodes'] {
    try {
      let cleaned = response.trim();

      // Remove text before JSON
      const jsonStart = cleaned.indexOf('{');
      if (jsonStart > 0) {
        cleaned = cleaned.substring(jsonStart);
      }

      // Remove markdown code fences
      cleaned = cleaned.replace(/^```json\s*/gim, '');
      cleaned = cleaned.replace(/^```\s*/gim, '');
      cleaned = cleaned.replace(/\s*```\s*$/gim, '');

      // Extract JSON object
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        log.error('[EpisodeSplitter] No JSON found in AI response');
        return [];
      }

      const jsonStr = jsonMatch[0];

      try {
        const parsed = JSON.parse(jsonStr) as AIEpisodeResponse;
        if (!parsed.episodes || !Array.isArray(parsed.episodes)) {
          log.error('[EpisodeSplitter] Invalid episodes array in AI response');
          return [];
        }
        return parsed.episodes;
      } catch (parseError) {
        // Try to recover individual episode objects
        log.warn('[EpisodeSplitter] Initial parse failed, attempting recovery...');

        const episodes: AIEpisodeResponse['episodes'] = [];
        const phraseRegex = /\{\s*"start_phrase"\s*:\s*"([^"]*(?:\\.[^"]*)*)"\s*,\s*"title"\s*:\s*"([^"]*(?:\\.[^"]*)*)"\s*,\s*"description"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/g;
        let match;
        while ((match = phraseRegex.exec(jsonStr)) !== null) {
          episodes.push({
            start_phrase: match[1].replace(/\\"/g, '"'),
            title: match[2].replace(/\\"/g, '"'),
            description: match[3].replace(/\\"/g, '"'),
          });
        }

        if (episodes.length > 0) {
          log.info(`[EpisodeSplitter] Recovered ${episodes.length} episodes from malformed JSON`);
          return episodes;
        }

        throw parseError;
      }
    } catch (error) {
      log.error('[EpisodeSplitter] Failed to parse AI response:', error);
      log.error('[EpisodeSplitter] Response preview:', response.substring(0, 1000));
      return [];
    }
  }

  /**
   * Map AI-detected episodes to timestamps using phrase matching
   */
  private static mapEpisodesToTimestamps(
    aiEpisodes: AIEpisodeResponse['episodes'],
    srtSegments: SRTSegment[],
    totalDurationSeconds: number
  ): EpisodeBoundary[] {
    const mappedEpisodes: EpisodeBoundary[] = [];
    let lastTimestamp = 0;

    for (let i = 0; i < aiEpisodes.length; i++) {
      const episode = aiEpisodes[i];
      const title = episode.title?.trim();
      const description = episode.description?.trim();
      const startPhrase = episode.start_phrase || '';

      if (!title) {
        log.warn(`[EpisodeSplitter] Skipping episode ${i}: missing title`);
        continue;
      }

      // Find timestamp using phrase matching with chronological enforcement
      let startSeconds = findPhraseTimestamp(startPhrase, srtSegments, 0.5, lastTimestamp);
      log.info(`[EpisodeSplitter] Phrase matching (minTime=${TimeUtils.secondsToYoutubeTime(lastTimestamp)}): "${startPhrase.substring(0, 50)}..." → ${startSeconds !== null ? TimeUtils.secondsToYoutubeTime(startSeconds) : 'NOT FOUND'}`);

      // First episode defaults to 0:00
      if (startSeconds === null && i === 0) {
        log.info('[EpisodeSplitter] First episode defaulting to 0:00');
        startSeconds = 0;
      }

      if (startSeconds === null) {
        log.warn(`[EpisodeSplitter] Could not find timestamp for episode ${i + 1}: "${title}"`);
        continue;
      }

      lastTimestamp = startSeconds + 1;

      mappedEpisodes.push({
        episodeNumber: i + 1,
        startTimestamp: TimeUtils.secondsToYoutubeTime(startSeconds),
        endTimestamp: '',
        startSeconds,
        endSeconds: totalDurationSeconds,
        durationSeconds: 0,
        title,
        description: description || '',
        startPhrase,
        verbalCueDetected: episode.verbal_cue_nearby || false,
        exceedsMaxDuration: false,
        profanityMarkers: [],
      });
    }

    // Ensure first episode starts at 0:00
    if (mappedEpisodes.length > 0 && mappedEpisodes[0].startSeconds > 0) {
      mappedEpisodes[0].startSeconds = 0;
      mappedEpisodes[0].startTimestamp = '0:00';
    }

    // Calculate end times and durations
    for (let i = 0; i < mappedEpisodes.length; i++) {
      if (i < mappedEpisodes.length - 1) {
        mappedEpisodes[i].endSeconds = mappedEpisodes[i + 1].startSeconds;
      } else {
        mappedEpisodes[i].endSeconds = totalDurationSeconds;
      }
      mappedEpisodes[i].endTimestamp = TimeUtils.secondsToYoutubeTime(mappedEpisodes[i].endSeconds);
      mappedEpisodes[i].durationSeconds = mappedEpisodes[i].endSeconds - mappedEpisodes[i].startSeconds;
      mappedEpisodes[i].exceedsMaxDuration = mappedEpisodes[i].durationSeconds > this.MAX_EPISODE_SECONDS;

      // Update episode numbers after potential skips
      mappedEpisodes[i].episodeNumber = i + 1;
    }

    // Log mapped episodes
    log.info('[EpisodeSplitter] Mapped episodes:');
    for (const ep of mappedEpisodes) {
      const durationMin = Math.round(ep.durationSeconds / 60);
      log.info(`  Episode ${ep.episodeNumber}: "${ep.title}" ${ep.startTimestamp} - ${ep.endTimestamp} (${durationMin} min)${ep.exceedsMaxDuration ? ' ⚠️ EXCEEDS MAX' : ''}${ep.verbalCueDetected ? ' 🎤 VERBAL CUE' : ''}`);
    }

    return mappedEpisodes;
  }

  /**
   * Words/phrases that YouTube may flag for demonetization.
   */
  private static readonly PROFANITY_SEVERE: string[] = [
    'fuck', 'fucking', 'fucked', 'fucker', 'motherfucker', 'motherfucking',
    'shit', 'shitting', 'shitty', 'bullshit',
    'cunt',
    'cock', 'cocks',
    'pussy',
    'whore',
    'slut',
  ];

  private static readonly PROFANITY_MILD: string[] = [
    'ass', 'asshole', 'dumbass', 'badass', 'jackass',
    'bitch', 'bitches', 'bitching',
    'damn', 'dammit', 'goddamn', 'goddammit',
    'hell',
    'crap', 'crappy',
    'dick', 'dicks',
    'bastard', 'bastards',
    'piss', 'pissed', 'pissing',
  ];

  private static readonly PROFANITY_LIST: string[] = [
    ...EpisodeSplitterService.PROFANITY_SEVERE,
    ...EpisodeSplitterService.PROFANITY_MILD,
  ];

  /** First 3 minutes of each episode are flagged for monetization */
  private static readonly OPENING_WINDOW_SECONDS = 180;

  /**
   * Scan every SRT segment within each episode for profanity.
   * Each match gets a ProfanityMarker with its timestamp and whether
   * it falls within the opening 3-minute monetization window.
   */
  private static scanProfanity(
    episodes: EpisodeBoundary[],
    srtSegments: SRTSegment[]
  ): void {
    // Build a single regex that matches any profanity word
    const pattern = new RegExp(
      `\\b(${this.PROFANITY_LIST.join('|')})\\b`,
      'gi'
    );

    // Build a set for O(1) severity lookup
    const severeSet = new Set(this.PROFANITY_SEVERE.map(w => w.toLowerCase()));

    for (const episode of episodes) {
      const markers: ProfanityMarker[] = [];

      for (const seg of srtSegments) {
        const segStart = TimeUtils.srtTimeToSeconds(seg.start);

        // Only process segments within this episode
        if (segStart < episode.startSeconds) continue;
        if (segStart >= episode.endSeconds) break;

        const localSeconds = segStart - episode.startSeconds;
        const text = seg.text;

        // Find all profanity matches in this segment
        let match: RegExpExecArray | null;
        pattern.lastIndex = 0;
        while ((match = pattern.exec(text)) !== null) {
          const word = match[1].toLowerCase();
          markers.push({
            word,
            severity: severeSet.has(word) ? 'severe' : 'mild',
            timestampSeconds: segStart,
            timestamp: TimeUtils.secondsToYoutubeTime(segStart),
            localSeconds,
            localTimestamp: TimeUtils.secondsToYoutubeTime(localSeconds),
            inOpening: localSeconds < this.OPENING_WINDOW_SECONDS,
          });
        }
      }

      episode.profanityMarkers = markers;

      if (markers.length > 0) {
        const openingCount = markers.filter(m => m.inOpening).length;
        log.info(`[EpisodeSplitter] Episode ${episode.episodeNumber}: ${markers.length} profanity hit(s) (${openingCount} in opening 3 min)`);
      }
    }
  }

  /**
   * Compute how each source file maps to episodes.
   * For each file, determines which episodes overlap with it and the local time ranges.
   */
  private static computeSourceFileBreakdown(
    fileInfos: Array<{ path: string; name: string; durationSeconds: number }>,
    episodes: EpisodeBoundary[]
  ): SourceFileBreakdown[] {
    const breakdowns: SourceFileBreakdown[] = [];
    let globalOffset = 0;

    for (let fi = 0; fi < fileInfos.length; fi++) {
      const file = fileInfos[fi];
      const fileGlobalStart = globalOffset;
      const fileGlobalEnd = globalOffset + file.durationSeconds;
      const segments: SourceFileSegment[] = [];

      for (const episode of episodes) {
        // Check if this episode overlaps with this file's global range
        const overlapStart = Math.max(episode.startSeconds, fileGlobalStart);
        const overlapEnd = Math.min(episode.endSeconds, fileGlobalEnd);

        if (overlapStart < overlapEnd) {
          // Convert to local time within this file
          const localStart = overlapStart - fileGlobalStart;
          const localEnd = overlapEnd - fileGlobalStart;

          segments.push({
            episodeNumber: episode.episodeNumber,
            localStartTimestamp: TimeUtils.secondsToYoutubeTime(localStart),
            localEndTimestamp: TimeUtils.secondsToYoutubeTime(localEnd),
            localStartSeconds: localStart,
            localEndSeconds: localEnd,
            durationSeconds: localEnd - localStart,
          });
        }
      }

      breakdowns.push({
        fileIndex: fi + 1,
        fileName: file.name,
        filePath: file.path,
        fileDurationSeconds: file.durationSeconds,
        fileDuration: TimeUtils.secondsToYoutubeTime(file.durationSeconds),
        globalStartSeconds: fileGlobalStart,
        globalEndSeconds: fileGlobalEnd,
        segments,
      });

      globalOffset = fileGlobalEnd;
    }

    // Log breakdown
    log.info('[EpisodeSplitter] Source file breakdown:');
    for (const bd of breakdowns) {
      log.info(`  File ${bd.fileIndex}: ${bd.fileName} (${bd.fileDuration})`);
      for (const seg of bd.segments) {
        const durMin = Math.round(seg.durationSeconds / 60);
        log.info(`    → Episode ${seg.episodeNumber}: ${seg.localStartTimestamp} - ${seg.localEndTimestamp} (${durMin} min)`);
      }
    }

    return breakdowns;
  }

  /**
   * Save episode split report to file
   */
  private static async saveReport(
    report: EpisodeSplitReport,
    outputDirectory: string
  ): Promise<string> {
    const reportsDir = path.join(outputDirectory, '.contentstudio', 'episode-reports');

    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `episode-${timestamp}.json`;
    const reportPath = path.join(reportsDir, filename);

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

    log.info(`[EpisodeSplitter] Report saved to: ${reportPath}`);

    return reportPath;
  }

  /**
   * Load an episode report from file
   */
  static loadReport(reportPath: string): EpisodeSplitReport | null {
    try {
      if (!fs.existsSync(reportPath)) {
        return null;
      }

      const content = fs.readFileSync(reportPath, 'utf-8');
      return JSON.parse(content) as EpisodeSplitReport;
    } catch (error) {
      log.error(`[EpisodeSplitter] Failed to load report: ${error}`);
      return null;
    }
  }

  /**
   * List all episode reports in output directory
   */
  static listReports(outputDirectory: string): Array<{ path: string; report: EpisodeSplitReport }> {
    const reportsDir = path.join(outputDirectory, '.contentstudio', 'episode-reports');

    if (!fs.existsSync(reportsDir)) {
      return [];
    }

    const reports: Array<{ path: string; report: EpisodeSplitReport }> = [];

    const files = fs.readdirSync(reportsDir);
    for (const file of files) {
      if (file.startsWith('episode-') && file.endsWith('.json')) {
        const reportPath = path.join(reportsDir, file);
        const report = this.loadReport(reportPath);
        if (report) {
          reports.push({ path: reportPath, report });
        }
      }
    }

    // Sort by analysis date (newest first)
    reports.sort((a, b) => {
      return new Date(b.report.analyzedAt).getTime() - new Date(a.report.analyzedAt).getTime();
    });

    return reports;
  }
}
