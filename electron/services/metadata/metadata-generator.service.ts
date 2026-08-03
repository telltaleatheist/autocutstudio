/**
 * Metadata Generator Service
 * Main orchestrator for metadata generation workflow
 * Replaces the Python metadata_generator.py
 */

import { AIManagerService, AIConfig, MetadataResult } from './ai-manager.service';
import { WhisperService } from './whisper.service';
import { InputHandlerService, ContentItem } from './input-handler.service';
import { Chapter } from './chapter-generator.service';
import { ChapterPipelineService, ChapterStage, ChapterPipelineResult } from './chapter-pipeline.service';
import { OutputHandlerService } from './output-handler.service';
import { queueAITask } from '../queue-manager.service';
import * as log from 'electron-log';
import * as fs from 'fs';
import * as path from 'path';

export interface GenerationParams {
  inputs: string[];
  mode?: 'individual' | 'compilation';
  aiProvider: 'ollama' | 'openai' | 'claude';
  aiModel?: string; // Legacy single model (backward compatibility)
  summarizationModel?: string; // Model for fast summarization
  metadataModel?: string; // Model for final metadata generation
  aiApiKey?: string;
  aiHost?: string;
  outputPath?: string;
  promptSet?: string;
  promptSetsDir?: string;
  jobId?: string;
  jobName?: string;
  // Pre-resolved "CHANNEL PERFORMANCE DATA" block from the analytics feedback
  // loop (appended to the metadata prompt); undefined = omit (expected state).
  insightsBlock?: string;
  chapterFlags?: { [key: string]: boolean };
  /**
   * Local Ollama model that runs the chapter pipeline (no provider prefix — the
   * pipeline is Ollama-only by design; see CHAPTERING.md). Chapters are generated
   * BEFORE the metadata call and their subjects condition every other field, so this
   * model choice shapes the titles and description too, not just the chapter bar.
   */
  chapterModel?: string;
  /** Optional per-stage overrides, e.g. running stages 2/4/5 on a different rater. */
  chapterStageModels?: Partial<Record<ChapterStage, string>>;
  /** Chapter-pipeline context window. One value for the whole run (Ollama reloads on change). */
  chapterNumCtx?: number;
  /**
   * Chapters already produced for these sources (keyed by source label), so a run
   * doesn't repeat the pipeline. This is what makes "Show prompt" honest: that flow
   * has to run the chapters to assemble the real prompt, and "Send to AI" then reuses
   * the SAME chapters rather than re-deriving a possibly different set.
   */
  preComputedChapters?: { [sourceLabel: string]: ChapterPipelineResult };
  inputNotes?: { [key: string]: string };
  preTranscribedContent?: ContentItem[]; // Pre-transcribed content from pipeline (skips transcription phase)
  inputWarnings?: string[]; // Input-stage failures from the pipeline (surfaced in result.warnings)
  showPrompt?: boolean; // "Show prompt" flow: assemble the prompt(s) and STOP — no metadata AI call, job, or output
  progressCallback?: (phase: string, message: string, percent?: number, filename?: string, itemIndex?: number) => void;
  cancelCallback?: () => boolean; // Returns true if job should be cancelled
}

export interface GenerationResult {
  success: boolean;
  metadata?: MetadataResult[];
  output_files?: string[];
  txt_files?: string[];
  json_file?: string;
  job_id?: string;
  processing_time?: number;
  error?: string;
  warnings?: string[]; // Per-item / partial-failure messages surfaced to the user
  prompts?: string[]; // "Show prompt" flow: the assembled prompt(s), one per item (compilation = single)
  /** "Show prompt" flow: chapters computed while assembling, to be handed back on send. */
  computedChapters?: { [sourceLabel: string]: ChapterPipelineResult };
}

export class MetadataGeneratorService {
  /**
   * Generate metadata for inputs
   */
  static async generate(params: GenerationParams): Promise<GenerationResult> {
    const startTime = Date.now();

    console.log('[MetadataGenerator] Starting generation...');
    console.log('[MetadataGenerator] Inputs:', params.inputs.length);
    console.log('[MetadataGenerator] AI Provider:', params.aiProvider);
    console.log('[MetadataGenerator] Prompt Set:', params.promptSet || 'default');

    try {
      // Initialize services
      log.info('[MetadataGenerator] Initializing services...');
      log.info('[MetadataGenerator] Creating WhisperService...');
      const whisperService = new WhisperService();
      log.info('[MetadataGenerator] WhisperService created successfully');

      // Pass progress callback to inputHandler so it can send 'preparing' events
      const inputHandler = new InputHandlerService(whisperService, params.progressCallback);

      // Initialize AI Manager
      const aiConfig: AIConfig = {
        provider: params.aiProvider,
        model: params.aiModel, // Legacy support
        summarizationModel: params.summarizationModel,
        metadataModel: params.metadataModel,
        apiKey: params.aiApiKey,
        host: params.aiHost,
        promptSet: params.promptSet,
        promptSetsDir: params.promptSetsDir,
        insightsBlock: params.insightsBlock,
      };

      log.info('[MetadataGenerator] Creating AIManagerService...');
      const aiManager = new AIManagerService(aiConfig);
      log.info('[MetadataGenerator] Initializing AI manager...');
      const initialized = await aiManager.initialize();

      if (!initialized) {
        log.error('[MetadataGenerator] AI manager initialization failed');
        return {
          success: false,
          error: aiManager.lastInitError
            ? `Failed to initialize AI manager: ${aiManager.lastInitError}`
            : 'Failed to initialize AI manager',
        };
      }
      log.info('[MetadataGenerator] AI manager initialized successfully');

      // Process inputs - normalize input format
      // Inputs can be either strings or objects with {path: string}
      const normalizedInputs = params.inputs.map((input: any) => {
        if (typeof input === 'string') {
          return input;
        } else if (input && typeof input === 'object' && input.path) {
          return input.path;
        }
        return String(input);
      });
      log.info(`[MetadataGenerator] Normalized ${normalizedInputs.length} inputs`);

      // Set up progress forwarding from WhisperService
      // Progress events now include jobId and videoPath for multi-transcription support
      whisperService.on('progress', (progress: any) => {
        console.log(`[MetadataGenerator] Whisper progress [${progress.jobId}]:`, progress.percent, progress.message);
        if (params.progressCallback && progress.videoPath) {
          // Extract filename from videoPath
          const filename = progress.videoPath.split('/').pop() || progress.videoPath;

          // Find itemIndex by matching videoPath against normalized inputs
          let itemIndex: number | undefined = undefined;
          for (let i = 0; i < normalizedInputs.length; i++) {
            if (normalizedInputs[i] === progress.videoPath) {
              itemIndex = i;
              break;
            }
          }

          console.log(`[MetadataGenerator] Sending transcription progress: ${progress.percent}% for ${filename} (item ${itemIndex})`);
          params.progressCallback('transcription', progress.message, progress.percent, filename, itemIndex);
        }
      });

      // Input-stage failures (skipped items) — carried into result.warnings so
      // items can't silently vanish from the job.
      const inputFailures: string[] = [...(params.inputWarnings || [])];

      let contentItems: ContentItem[];
      if (params.preTranscribedContent && params.preTranscribedContent.length > 0) {
        contentItems = params.preTranscribedContent;
        log.info(`[MetadataGenerator] Using ${contentItems.length} pre-transcribed content items`);
      } else {
        const customNotesMap = new Map(Object.entries(params.inputNotes || {}));
        log.info('[MetadataGenerator] Processing inputs...');
        contentItems = await inputHandler.processMultipleInputs(normalizedInputs, customNotesMap, inputFailures);
      }

      // Check for cancellation after input processing
      if (params.cancelCallback && params.cancelCallback()) {
        log.info('[MetadataGenerator] Job cancelled after input processing');
        return {
          success: false,
          error: 'Job cancelled by user',
        };
      }

      if (contentItems.length === 0) {
        log.error('[MetadataGenerator] No content items processed from inputs');
        return {
          success: false,
          error: inputFailures.length > 0
            ? `No content could be processed: ${inputFailures.join('; ')}`
            : 'No content could be processed',
        };
      }

      log.info(`[MetadataGenerator] Processed ${contentItems.length} content items`);
      contentItems.forEach((item, idx) => {
        log.info(`[MetadataGenerator]   Item ${idx + 1}: type=${item.contentType}, content=${item.content.substring(0, 100)}...`);
      });

      // Initialize job and output handler
      const outputPath = params.outputPath || this.getDefaultOutputPath();
      const outputHandler = new OutputHandlerService(outputPath);
      const jobName = params.jobName || this.generateJobName(contentItems);

      // Partial failures / dropped-content notices, seeded with input-stage skips.
      // Declared here rather than after job init because the show-prompt flow below
      // runs the chapter stage too and can raise the same warnings.
      const warnings: string[] = [...inputFailures];
      // Chapters produced this run, keyed by source label — handed back to the caller
      // in show-prompt mode so "Send to AI" reuses them.
      const computedChapters: { [sourceLabel: string]: ChapterPipelineResult } = {};

      // "Show prompt" flow: assemble the exact prompt(s) that would be sent to the AI
      // and return them WITHOUT initializing a job, making the metadata call, or
      // writing any output. The IPC layer holds the transcript so "Send to AI" can
      // later run the real generation via preTranscribedContent.
      //
      // Chapters ARE generated here, unlike before. They now feed the metadata prompt,
      // so skipping them would make this flow display a prompt that is not the prompt
      // that gets sent — which is the one thing this flow exists to rule out. The
      // chapters come back with the prompts and are reused on send.
      if (params.showPrompt) {
        const mode = params.mode || 'individual';
        console.log(`[MetadataGenerator] Show-prompt mode: assembling prompt(s) only (${mode})`);
        const prompts: string[] = [];

        if (mode === 'compilation') {
          // Mirror the compilation path's per-item summarize + join so the assembled
          // prompt matches EXACTLY what a real compilation generation would send.
          const contentTypes = contentItems.map(item => item.contentType);
          const uniqueContentTypes = Array.from(new Set(contentTypes));

          params.progressCallback?.('generating', 'Assembling prompt...', 50);
          const itemSummaries: string[] = [];
          for (let i = 0; i < contentItems.length; i++) {
            if (params.cancelCallback && params.cancelCallback()) {
              console.log(`[MetadataGenerator] Job cancelled while assembling compilation prompt (item ${i + 1}/${contentItems.length})`);
              return { success: false, error: 'Job cancelled by user' };
            }
            const item = contentItems[i];
            const sourceLabel = item.source || `Item ${i + 1}`;
            const itemSummary = await aiManager.summarizeTranscript(item.content, sourceLabel, { forceCondense: true });
            itemSummaries.push(`ITEM ${i + 1} (${sourceLabel}):\n${itemSummary}`);
          }
          const summary = itemSummaries.join('\n\n');

          prompts.push(aiManager.buildMetadataPrompt(summary, jobName, {
            sourceCount: contentItems.length,
            contentTypes: uniqueContentTypes,
          }));
        } else {
          // Individual mode: one prompt per item, mirroring the normal per-item summarize.
          for (let i = 0; i < contentItems.length; i++) {
            if (params.cancelCallback && params.cancelCallback()) {
              console.log(`[MetadataGenerator] Job cancelled while assembling prompt (item ${i + 1}/${contentItems.length})`);
              return { success: false, error: 'Job cancelled by user' };
            }
            const item = contentItems[i];
            const sourceLabel = item.source || `item_${i + 1}`;

            const { subjects } = await this.resolveChapters(
              item,
              params,
              i,
              contentItems.length,
              params.chapterFlags?.[item.source || ''] || false,
              warnings,
              computedChapters
            );

            params.progressCallback?.('generating', 'Assembling prompt...', 80, undefined, i);
            const summary = await aiManager.summarizeTranscript(item.content, sourceLabel);
            prompts.push(aiManager.buildMetadataPrompt(summary, sourceLabel, undefined, subjects));
          }
        }

        // Cleanup — no job was initialized and no output was written.
        aiManager.cleanup();
        console.log(`[MetadataGenerator] Show-prompt: assembled ${prompts.length} prompt(s)`);
        return {
          success: true,
          prompts,
          job_id: params.jobId,
          computedChapters,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }

      // Initialize the job (creates job metadata file with empty items)
      const jobInfo = outputHandler.initializeJob(
        jobName,
        params.promptSet || 'sample-youtube',
        params.jobId
      );

      // Store original inputs and content types for history filtering
      outputHandler.updateJobData(jobInfo.jobId, {
        original_inputs: normalizedInputs,
        input_types: contentItems.map(item => item.contentType),
      });

      console.log(`[MetadataGenerator] Job initialized: ${jobInfo.jobId}`);

      // Generate metadata based on mode (`warnings` was seeded above, before the
      // show-prompt branch, because that branch raises the same chapter warnings)
      const metadataItems: MetadataResult[] = [];
      const mode = params.mode || 'individual';
      console.log(`[MetadataGenerator] Processing mode: ${mode}`);

      if (mode === 'compilation') {
        // COMPILATION MODE: Combine all content and generate single metadata
        console.log('[MetadataGenerator] Compilation mode: combining all content');

        // Determine content types for compilation context
        const contentTypes = contentItems.map(item => item.contentType);
        const uniqueContentTypes = Array.from(new Set(contentTypes));

        // Summarize each item SEPARATELY to preserve distinct subjects
        // (Combining first then summarizing loses the ITEM structure during chunking)
        params.progressCallback?.('generating', 'Analyzing combined content...', 0);
        const itemSummaries: string[] = [];
        for (let i = 0; i < contentItems.length; i++) {
          // Check for cancellation before each (potentially long) summarization
          if (params.cancelCallback && params.cancelCallback()) {
            console.log(`[MetadataGenerator] Job cancelled while summarizing item ${i + 1}/${contentItems.length}`);
            outputHandler.updateJobStatus(jobInfo.jobId, 'cancelled');
            return {
              success: false,
              error: 'Job cancelled by user',
            };
          }

          const item = contentItems[i];
          const sourceLabel = item.source || `Item ${i + 1}`;
          console.log(`[MetadataGenerator] Summarizing compilation item ${i + 1}/${contentItems.length}: ${sourceLabel}`);
          // Always condense compilation items — their outputs get joined into one prompt
          const itemSummary = await aiManager.summarizeTranscript(item.content, sourceLabel, { forceCondense: true });
          itemSummaries.push(`ITEM ${i + 1} (${sourceLabel}):\n${itemSummary}`);
        }

        // Recombine summaries with ITEM labels intact
        const summary = itemSummaries.join('\n\n');

        // Check for cancellation before the final (long) metadata generation
        if (params.cancelCallback && params.cancelCallback()) {
          console.log('[MetadataGenerator] Job cancelled before compilation metadata generation');
          outputHandler.updateJobStatus(jobInfo.jobId, 'cancelled');
          return {
            success: false,
            error: 'Job cancelled by user',
          };
        }

        // Generate single metadata for compilation with hardcoded compilation instructions
        params.progressCallback?.('generating', 'Generating metadata for compilation...', 50);
        const metadata = await aiManager.generateMetadata(
          summary,
          jobName,
          {
            sourceCount: contentItems.length,
            contentTypes: uniqueContentTypes
          }
        );

        // Add compilation info
        (metadata as any)._title = jobName;
        (metadata as any)._prompt_set = params.promptSet;
        (metadata as any)._is_compilation = true;
        (metadata as any)._source_count = contentItems.length;

        // Save compilation result
        const saveResult = await outputHandler.addItemToJob(jobInfo.jobId, metadata);
        console.log(`[MetadataGenerator] Saved compilation to: ${saveResult.txtPath}`);

        params.progressCallback?.('generating', 'Compilation complete', 100);
        metadataItems.push(metadata);

      } else {
        // INDIVIDUAL MODE: Process each item separately
        console.log('[MetadataGenerator] Individual mode: processing items separately');

        for (let i = 0; i < contentItems.length; i++) {
        // Check for cancellation before each item
        if (params.cancelCallback && params.cancelCallback()) {
          console.log(`[MetadataGenerator] Job cancelled at item ${i + 1}/${contentItems.length}`);
          outputHandler.updateJobStatus(jobInfo.jobId, 'cancelled');
          return {
            success: false,
            error: 'Job cancelled by user',
          };
        }

        const item = contentItems[i];
        console.log(`[MetadataGenerator] Generating metadata ${i + 1}/${contentItems.length}`);

        try {
          const sourceLabel = item.source || `item_${i + 1}`;
          const shouldGenerateChapters = params.chapterFlags?.[item.source || ''] || false;

          // ---- Chapters FIRST -------------------------------------------------
          // Chapters are not a trailing decoration any more. Their subject list is
          // what the title, description and tag stages condition on, so it has to
          // exist before the metadata call is assembled (see CHAPTERING.md).
          const { chapters, subjects: chapterSubjects } = await this.resolveChapters(
            item,
            params,
            i,
            contentItems.length,
            shouldGenerateChapters,
            warnings,
            computedChapters
          );

          // ---- Everything else, conditioned on those chapters -----------------
          console.log(`[MetadataGenerator] Sending generating phase: Analyzing content for item ${i}`);
          params.progressCallback?.('generating', `Analyzing content ${i + 1}/${contentItems.length}...`, 60, undefined, i);
          const summary = await aiManager.summarizeTranscript(item.content, sourceLabel);

          console.log(`[MetadataGenerator] Sending generating phase: Generating metadata for item ${i}`);
          params.progressCallback?.('generating', `Generating metadata ${i + 1}/${contentItems.length}...`, 80, undefined, i);

          const metadata = await aiManager.generateMetadata(summary, sourceLabel, undefined, chapterSubjects);

          // Add title and source info
          (metadata as any)._title = this.getCleanTitle(item);
          (metadata as any)._prompt_set = params.promptSet;

          if (chapters) {
            metadata.chapters = chapters;
          }

          // Save this item to the job immediately
          const saveResult = await outputHandler.addItemToJob(jobInfo.jobId, metadata);
          console.log(`[MetadataGenerator] Saved metadata to: ${saveResult.txtPath}`);

          // Mark this item as complete
          console.log(`[MetadataGenerator] Sending generating phase: Completed for item ${i}`);
          params.progressCallback?.('generating', `Completed ${i + 1}/${contentItems.length}`, 100, undefined, i);
          metadataItems.push(metadata);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          const sourceLabel = item.source || `item_${i + 1}`;
          log.error(`[MetadataGenerator] Failed to generate metadata for item ${i + 1}:`, error);
          console.error(`[MetadataGenerator] Failed to generate metadata for item ${i + 1}:`, error);
          // Record the partial failure so the caller can surface it instead of
          // silently returning success with a missing item.
          warnings.push(`${sourceLabel}: ${errMsg}`);
          // Continue with other items
        }
      }
      } // End of individual mode else block

      if (metadataItems.length === 0) {
        // Update job status to failed
        outputHandler.updateJobStatus(jobInfo.jobId, 'failed');
        return {
          success: false,
          error: 'Failed to generate metadata for any items',
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }

      // Mark job as completed
      outputHandler.updateJobStatus(jobInfo.jobId, 'completed');
      console.log(`[MetadataGenerator] Job completed: ${jobInfo.jobId}`);

      // Cleanup
      aiManager.cleanup();

      const processingTime = (Date.now() - startTime) / 1000;
      console.log(`[MetadataGenerator] Generation complete in ${processingTime.toFixed(2)}s`);

      // Collect all TXT files from the job folder
      const fs = require('fs');
      let txtFiles: string[] = [];

      try {
        // Check if folder exists before trying to read it
        if (fs.existsSync(jobInfo.txtFolder)) {
          txtFiles = fs.readdirSync(jobInfo.txtFolder)
            .filter((file: string) => file.endsWith('.txt'))
            .map((file: string) => require('path').join(jobInfo.txtFolder, file));
        } else {
          console.error(`[MetadataGenerator] TXT folder does not exist: ${jobInfo.txtFolder}`);
        }
      } catch (error) {
        console.error(`[MetadataGenerator] Failed to read TXT folder:`, error);
        console.error(`[MetadataGenerator] Folder path was: ${jobInfo.txtFolder}`);
      }

      return {
        success: true,
        metadata: metadataItems,
        output_files: [jobInfo.txtFolder],
        txt_files: txtFiles,
        json_file: jobInfo.jsonPath,
        job_id: jobInfo.jobId,
        processing_time: processingTime,
        // Partial failures (skipped items, dropped chapters) — success is still true
        // as long as at least one item succeeded, but the caller can surface these.
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      log.error('[MetadataGenerator] Generation failed:', errorMessage);
      if (errorStack) {
        log.error('[MetadataGenerator] Stack trace:', errorStack);
      }

      console.error('[MetadataGenerator] Generation failed:', error);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * The chapter step, as both the real run and the "Show prompt" assembly see it.
   *
   * Chapters that could not be produced are reported as warnings rather than failing
   * the item — but the warning always says the rest of the metadata was written
   * WITHOUT the chapter subjects, because that is a materially different generation
   * and the user has to know which one they got.
   *
   * Results are recorded in `sink` so "Show prompt" can hand the SAME chapters to
   * "Send to AI" instead of paying for the pipeline twice and possibly getting a
   * different answer the second time.
   */
  private static async resolveChapters(
    item: ContentItem,
    params: GenerationParams,
    itemIndex: number,
    itemCount: number,
    requested: boolean,
    warnings: string[],
    sink?: { [sourceLabel: string]: ChapterPipelineResult }
  ): Promise<{ chapters?: Chapter[]; subjects?: string[] }> {
    const sourceLabel = item.source || `item_${itemIndex + 1}`;
    if (!requested) {
      return {};
    }

    const reuse = params.preComputedChapters?.[sourceLabel];
    if (reuse) {
      console.log(`[MetadataGenerator] Reusing ${reuse.chapters.length} already-computed chapters for ${sourceLabel}`);
      return { chapters: reuse.chapters, subjects: reuse.subjects };
    }

    if (!item.srtSegments || item.srtSegments.length === 0) {
      // Chapters need a timestamped transcript (SRT segments); a subject or plain
      // transcript file has none, so report why they were skipped.
      const msg = `${sourceLabel}: chapters were requested but no timestamped transcript was available to generate them, so the rest of the metadata was generated WITHOUT chapter subjects`;
      console.warn(`[MetadataGenerator] ${msg}`);
      warnings.push(msg);
      return {};
    }

    console.log(`[MetadataGenerator] Generating chapters for item ${itemIndex} (before metadata)...`);
    params.progressCallback?.('generating', `Finding chapters ${itemIndex + 1}/${itemCount}...`, 0, undefined, itemIndex);

    try {
      const result = await this.generateChapters(item, params, itemIndex, itemCount);

      if (result.chapters.length < 3) {
        // <3 chapters are dropped (YouTube requires at least 3). Don't let that vanish
        // silently when the user explicitly asked for chapters.
        const msg = `${sourceLabel}: chapters were requested but only ${result.chapters.length} chapter(s) were found (YouTube requires at least 3), so none were added and the rest of the metadata was generated WITHOUT chapter subjects`;
        console.warn(`[MetadataGenerator] ${msg}`);
        warnings.push(msg);
        return {};
      }

      console.log(`[MetadataGenerator] Generated ${result.chapters.length} chapters in ${result.stats.calls} model calls`);
      if (sink) sink[sourceLabel] = result;
      return { chapters: result.chapters, subjects: result.subjects };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const msg = `${sourceLabel}: chapter generation failed, so the rest of the metadata was generated WITHOUT chapter subjects: ${errMsg}`;
      console.error(`[MetadataGenerator] ${msg}`);
      warnings.push(msg);
      return {};
    }
  }

  /**
   * Generate chapters with the sealed 14B pipeline (CHAPTERING.md).
   *
   * This replaced a single "here is the whole video, give me the chapters" call. That
   * shape cannot work on a 14B: asked to pick K boundaries out of N candidates it
   * returns the first few and stops, which produces mega-chapters and lost stories.
   * The pipeline asks one local question at a time and does the selection in code.
   *
   * The WHOLE run holds the single AI queue slot rather than queueing each of its
   * hundreds of calls separately: the method requires one model resident at a time,
   * and that is exactly what the 1-slot AI pool exists to guarantee.
   */
  private static async generateChapters(
    item: ContentItem,
    params: GenerationParams,
    itemIndex: number,
    itemCount: number
  ) {
    if (!item.srtSegments || item.srtSegments.length === 0) {
      throw new Error('Chapter generation needs a timestamped transcript');
    }

    const model = params.chapterModel;
    if (!model) {
      throw new Error('No chapter model configured (expected a local Ollama model such as cogito:14b)');
    }

    const host = params.aiHost || 'http://localhost:11434';
    const label = item.source || `item_${itemIndex + 1}`;

    // Chapter work is 0-60% of this item's "generating" phase; the metadata call that
    // follows takes it from there. Weighted by the real call counts: labelling and
    // rating are ~2 x (duration/45s) calls, the rest are ~3 x chapter_count.
    const stageWeights: Record<ChapterStage, [number, number]> = {
      label: [0, 22],
      rate: [22, 44],
      place: [44, 50],
      summarize: [50, 55],
      consolidate: [55, 60],
    };

    const pipeline = new ChapterPipelineService({
      host,
      model,
      stageModels: params.chapterStageModels,
      numCtx: params.chapterNumCtx,
      cancelCallback: params.cancelCallback,
      onProgress: (stage, done, total) => {
        const [from, to] = stageWeights[stage];
        const percent = Math.round(from + ((to - from) * done) / Math.max(1, total));
        params.progressCallback?.(
          'generating',
          `Chapters (${stage} ${done}/${total}) ${itemIndex + 1}/${itemCount}...`,
          percent,
          undefined,
          itemIndex
        );
      },
    });

    log.info(`[MetadataGenerator] Chapter pipeline starting for ${label} on ${model} @ ${host}`);

    // The AI pool's default 30-minute watchdog is sized for ONE stalled request. This
    // task is hundreds of short requests in a row: CHAPTERING.md clocks a 2h10m
    // livestream at ~390 calls / ~25 minutes on a 24GB-class GPU, so the default would
    // force-fail legitimate long-form runs on anything slower. 4 hours still backstops
    // a genuinely wedged run.
    const CHAPTER_TASK_TIMEOUT_MS = 4 * 60 * 60 * 1000;

    return queueAITask(
      `chapters-${params.jobId || 'job'}-${itemIndex}`,
      `Chapters: ${label}`,
      () => pipeline.generate(item.srtSegments!),
      undefined,
      CHAPTER_TASK_TIMEOUT_MS
    );
  }

  /**
   * Get clean title from content item
   */
  private static getCleanTitle(item: ContentItem): string {
    // Prefer an explicit title (e.g. an imported story title) over the filename.
    if (item.title && item.title.trim()) {
      return item.title.trim();
    }

    if (item.source) {
      // Extract filename without extension - handle both Windows and Unix paths
      const basename = item.source.split(/[/\\]/).pop() || item.source;
      return basename.replace(/\.[^/.]+$/, ''); // Remove extension
    }

    // For subjects, use first 50 chars
    return item.content.slice(0, 50).replace(/\s+/g, ' ').trim();
  }

  /**
   * Generate job name from content items
   */
  private static generateJobName(items: ContentItem[]): string {
    if (items.length === 0) {
      return 'Untitled Job';
    }

    if (items.length === 1) {
      return this.getCleanTitle(items[0]);
    }

    const firstName = this.getCleanTitle(items[0]);
    return `${firstName} + ${items.length - 1} more`;
  }

  /**
   * Get default output path
   */
  private static getDefaultOutputPath(): string {
    const os = require('os');
    return path.join(os.homedir(), 'Documents', 'AutoCutStudio Output');
  }
}
